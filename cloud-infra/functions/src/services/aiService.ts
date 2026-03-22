import axios from 'axios';
import * as admin from 'firebase-admin';
import { GLM_API_URL, OPENAI_API_URL, ANTHROPIC_API_URL } from '../config/constants';
import { retryWithBackoff } from '../utils/errorHandling';
import { getApiKeyByEnvKey, getApiKeyForCompany, validateApiKey } from '../utils/secretManager';
import { RuntimeAiConfig, AiProvider } from '../types/runtime';

const GLM_COST_PER_1K_TOKENS = { input: 0.01, output: 0.01 };
const OPENAI_COST_PER_1K_TOKENS = { input: 0.005, output: 0.015 };
const GEMINI_COST_PER_1K_TOKENS = { input: 0.00035, output: 0.00105 };
const CLAUDE_COST_PER_1K_TOKENS = { input: 0.003, output: 0.015 };

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface RelevanceResult {
  isRelevant: boolean;
  confidence: number;
  reason: string;
}

interface PromptExecutionContext {
  companyId?: string;
  pipelineRunId?: string;
  prompt?: string;
  promptVersion?: string;
}

interface ApiCallResult {
  content: string;
  usage: TokenUsage;
}

// ─────────────────────────────────────────
// Default Prompts
// ─────────────────────────────────────────
const DEFAULT_RELEVANCE_PROMPT = `당신은 M&A, 사모펀드(PEF), 벤처캐피털, 전략적 투자 분야의 전문 애널리스트입니다.

아래 기사가 투자 모니터링 워크플로우에 관련된 기사인지 판단하세요.

관련 있는 기사 예시:
- 인수합병(M&A), 경영권 인수, 공개매수
- 지분 매각, 사업부 분리매각(carve-out), 분할
- 사모펀드(PEF) 딜, 바이아웃, 펀드 결성/청산
- 벤처캐피털 투자유치, 시리즈 투자
- 전략적 투자자(SI), 재무적 투자자(FI) 참여
- IPO, 상장, 블록딜
- 인수금융, 리파이낸싱, 구조조정, MBO

출력 형식 (반드시 아래 형식 그대로 출력):
RELEVANT: YES or NO
CONFIDENCE: 0.0~1.0 사이의 숫자
REASON: 한 문장으로 판단 근거 (한국어로 작성)`;

const DEFAULT_ANALYSIS_PROMPT = `당신은 뉴스 기사에서 투자 정보를 구조화하여 추출하는 전문 애널리스트입니다.

모든 출력값(summary, category, insights, tags)은 반드시 자연스러운 한국어로 작성하세요.
기업명·펀드명 등 고유명사는 한국어 표기를 우선하되, 필요 시 영문을 괄호로 병기하세요. (예: 카카오(Kakao))

아래 JSON 형식만 반환하세요 (다른 텍스트 없이):
{
  "companies": {
    "acquiror": "인수자 (없으면 null)",
    "target": "피인수 대상 (없으면 null)",
    "financialSponsor": "재무적 투자자/PE (없으면 null)"
  },
  "deal": {
    "type": "딜 유형 (예: 인수합병, 지분투자, IPO 등)",
    "amount": "거래 금액 (예: 3,000억원, 미공개)",
    "stake": "지분율 (없으면 null)"
  },
  "summary": ["핵심 내용 1", "핵심 내용 2", "핵심 내용 3"],
  "category": "카테고리 (예: M&A, 사모펀드, 벤처투자, IPO 등)",
  "insights": "투자자 관점에서의 시사점 및 분석 (없으면 null)",
  "tags": ["태그1", "태그2", "태그3"]
}`;

// ─────────────────────────────────────────
// Token usage extraction per provider
// ─────────────────────────────────────────
function extractTokenUsage(responseData: any, provider: AiProvider): TokenUsage {
  switch (provider) {
    case 'glm':
    case 'openai':
      return {
        promptTokens: responseData.usage?.prompt_tokens || 0,
        completionTokens: responseData.usage?.completion_tokens || 0,
        totalTokens: responseData.usage?.total_tokens || 0,
      };
    case 'gemini':
      return {
        promptTokens: responseData.usageMetadata?.promptTokenCount || 0,
        completionTokens: responseData.usageMetadata?.candidatesTokenCount || 0,
        totalTokens: responseData.usageMetadata?.totalTokenCount || 0,
      };
    case 'claude':
      return {
        promptTokens: responseData.usage?.input_tokens || 0,
        completionTokens: responseData.usage?.output_tokens || 0,
        totalTokens: (responseData.usage?.input_tokens || 0) + (responseData.usage?.output_tokens || 0),
      };
    default:
      return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
}

function getCostPerKTokens(provider: AiProvider) {
  switch (provider) {
    case 'openai': return OPENAI_COST_PER_1K_TOKENS;
    case 'gemini': return GEMINI_COST_PER_1K_TOKENS;
    case 'claude': return CLAUDE_COST_PER_1K_TOKENS;
    default: return GLM_COST_PER_1K_TOKENS;
  }
}

// ─────────────────────────────────────────
// AI Cost Tracking
// ─────────────────────────────────────────
async function trackAiCost(
  stage: string,
  usage: TokenUsage,
  model: string,
  provider: AiProvider,
  companyId?: string,
  pipelineRunId?: string
): Promise<void> {
  try {
    const db = admin.firestore();
    const costs = getCostPerKTokens(provider);
    const inputCost = (usage.promptTokens / 1000) * costs.input;
    const outputCost = (usage.completionTokens / 1000) * costs.output;
    await db.collection('aiCostTracking').add({
      date: new Date().toISOString().split('T')[0],
      stage,
      provider,
      model,
      companyId: companyId || null,
      pipelineRunId: pipelineRunId || null,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      inputCostUSD: inputCost,
      outputCostUSD: outputCost,
      totalCostUSD: inputCost + outputCost,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch {
    // non-critical
  }
}

// ─────────────────────────────────────────
// Rate-limit / error tracking
// ─────────────────────────────────────────
let recentErrorCount = 0;
let lastErrorReset = Date.now();
const ERROR_WINDOW_MS = 5 * 60 * 1000;
const MAX_ERROR_RATE = 0.3;

function getDynamicBatchSize(baseSize: number): number {
  const now = Date.now();
  if (now - lastErrorReset > ERROR_WINDOW_MS) { recentErrorCount = 0; lastErrorReset = now; }
  const errorRate = recentErrorCount / Math.max(baseSize, 1);
  return errorRate > MAX_ERROR_RATE ? Math.max(3, Math.floor(baseSize * 0.5)) : baseSize;
}

function recordError(): void { recentErrorCount++; }

function getRateLimitDelay(attempt: number): number {
  return Math.min(5000, 500 * Math.pow(2, attempt));
}

// ─────────────────────────────────────────
// Provider-specific API callers
// ─────────────────────────────────────────
async function resolveApiKey(aiConfig: RuntimeAiConfig, companyId?: string): Promise<string> {
  const db = admin.firestore();

  // 1차: systemSettings/aiConfig.apiKeys.{provider}
  // Note: saveAiApiKey stores the key as a literal dot-notation field name ("apiKeys.glm"),
  // so we must check both the nested path and the literal field name.
  try {
    const sysDoc = await db.collection('systemSettings').doc('aiConfig').get();
    const sysData = sysDoc.data() || {};
    const sysKey = sysData?.apiKeys?.[aiConfig.provider] || sysData?.[`apiKeys.${aiConfig.provider}`];
    if (sysKey) return sysKey;
  } catch (err) {
    console.warn('resolveApiKey: systemSettings load failed:', err);
  }

  // 2차: companySettings fallback (companyId 지정 또는 첫 활성 회사)
  try {
    let targetId = companyId;
    if (!targetId) {
      const snap = await db.collection('companies').where('active', '==', true).limit(1).get();
      targetId = snap.empty ? undefined : snap.docs[0].id;
    }
    if (targetId) {
      const compDoc = await db.collection('companySettings').doc(targetId).get();
      const compKey = compDoc.data()?.apiKeys?.[aiConfig.provider];
      if (compKey) {
        // systemSettings에 동기화 (다음 호출 최적화)
        db.collection('systemSettings').doc('aiConfig').set(
          { [`apiKeys.${aiConfig.provider}`]: compKey }, { merge: true }
        ).catch(() => {});
        return compKey;
      }
    }
  } catch (err) {
    console.warn('resolveApiKey: companySettings fallback failed:', err);
  }

  return getApiKeyByEnvKey(aiConfig.apiKeyEnvKey);
}

async function callGlmApi(prompt: string, apiKey: string, aiConfig: RuntimeAiConfig, options?: { temperature?: number; maxTokens?: number }): Promise<ApiCallResult> {
  return retryWithBackoff(async () => {
    // ★ Use custom baseUrl if provided (e.g. https://z.ai/api/v1/chat/completions)
    let url = aiConfig.baseUrl || GLM_API_URL;
    if (url.endsWith('/')) url = url.slice(0, -1);
    if (!url.endsWith('/chat/completions')) {
      url += '/chat/completions';
    }
    console.log(`[AI-START] Calling ${aiConfig.provider} (${aiConfig.model}) at ${url}...`);
    const response = await axios.post(
      url,
      {
        model: aiConfig.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: options?.temperature ?? 0.2,
        ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
      },
      { 
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 240000 // 4분 타임아웃
      }
    );
    const rawContent = response.data.choices?.[0]?.message?.content;
    if (rawContent == null) {
      const finishReason = response.data.choices?.[0]?.finish_reason;
      console.error('GLM empty content. finish_reason:', finishReason, 'full response:', JSON.stringify(response.data).substring(0, 500));
      throw new Error(`Model returned empty content. finish_reason: ${finishReason || 'unknown'}. Check model name "${aiConfig.model}" and endpoint.`);
    }
    return {
      content: rawContent.trim(),
      usage: extractTokenUsage(response.data, 'glm'),
    };
  });
}

async function callOpenAiApi(prompt: string, apiKey: string, aiConfig: RuntimeAiConfig, options?: { temperature?: number; maxTokens?: number }): Promise<ApiCallResult> {
  return retryWithBackoff(async () => {
    const url = aiConfig.baseUrl || OPENAI_API_URL;
    const response = await axios.post(
      url,
      {
        model: aiConfig.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: options?.temperature ?? 0.2,
        ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
      },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
    );
    return {
      content: response.data.choices[0].message.content.trim(),
      usage: extractTokenUsage(response.data, 'openai'),
    };
  });
}

async function callGeminiApi(prompt: string, apiKey: string, aiConfig: RuntimeAiConfig, options?: { temperature?: number; maxTokens?: number }): Promise<ApiCallResult> {
  return retryWithBackoff(async () => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${aiConfig.model}:generateContent?key=${apiKey}`;
    const response = await axios.post(
      url,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: options?.temperature ?? 0.2,
          ...(options?.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
        },
      },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const content = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return {
      content: content.trim(),
      usage: extractTokenUsage(response.data, 'gemini'),
    };
  });
}

async function callClaudeApi(prompt: string, apiKey: string, aiConfig: RuntimeAiConfig, options?: { temperature?: number; maxTokens?: number }): Promise<ApiCallResult> {
  return retryWithBackoff(async () => {
    const response = await axios.post(
      ANTHROPIC_API_URL,
      {
        model: aiConfig.model,
        max_tokens: options?.maxTokens || 1024,
        messages: [{ role: 'user', content: prompt }],
        temperature: options?.temperature ?? 0.2,
      },
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
      }
    );
    const content = response.data.content?.[0]?.text || '';
    return {
      content: content.trim(),
      usage: extractTokenUsage(response.data, 'claude'),
    };
  });
}

// ─────────────────────────────────────────
// Unified API caller (routes by provider)
// ─────────────────────────────────────────
export async function callAiProvider(
  prompt: string,
  aiConfig: RuntimeAiConfig,
  options?: { temperature?: number; maxTokens?: number },
  companyId?: string
): Promise<ApiCallResult> {
  const apiKey = await resolveApiKey(aiConfig, companyId);
  validateApiKey(apiKey, aiConfig.provider);

  switch (aiConfig.provider) {
    case 'openai':
      return callOpenAiApi(prompt, apiKey, aiConfig, options);
    case 'gemini':
      return callGeminiApi(prompt, apiKey, aiConfig, options);
    case 'claude':
      return callClaudeApi(prompt, apiKey, aiConfig, options);
    case 'glm':
    default:
      return callGlmApi(prompt, apiKey, aiConfig, options);
  }
}

// ─────────────────────────────────────────
// Test AI connection (for Settings UI)
// ─────────────────────────────────────────
export async function testAiProviderConnection(
  aiConfig: RuntimeAiConfig,
  companyId?: string
): Promise<{ success: boolean; message: string; model: string; provider: string; latencyMs?: number }> {
  const startMs = Date.now();
  try {
    const result = await callAiProvider(
      'Reply with exactly: OK',
      aiConfig,
      { temperature: 0.0, maxTokens: 10 },
      companyId
    );
    const latencyMs = Date.now() - startMs;
    return {
      success: true,
      message: `Connection successful (${latencyMs}ms)${result.content ? ` — "${result.content.substring(0, 40)}"` : ''}`,
      model: aiConfig.model,
      provider: aiConfig.provider,
      latencyMs,
    };
  } catch (error: any) {
    const url = aiConfig.baseUrl || (aiConfig.provider === 'glm' ? GLM_API_URL : '');
    const errorMsg = error?.response?.data?.error?.message || error?.response?.data?.message || error.message || 'Connection failed';
    return {
      success: false,
      message: `${errorMsg} (Endpoint: ${url}, Model: ${aiConfig.model})`,
      model: aiConfig.model,
      provider: aiConfig.provider,
    };
  }
}

// ─────────────────────────────────────────
// JSON cleanup
// ─────────────────────────────────────────
function cleanupJsonResponse(content: string): string {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) return jsonMatch[0];
  let cleaned = content.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.substring(7);
  else if (cleaned.startsWith('```')) cleaned = cleaned.substring(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.substring(0, cleaned.length - 3);
  return cleaned.trim();
}

// ─────────────────────────────────────────
// Prompt Logging
// ─────────────────────────────────────────
export async function logPromptExecution(
  stage: 'relevance-check' | 'deep-analysis' | 'daily-briefing' | 'dedup-check' | 'custom-output' | 'article-list-summary',
  input: Record<string, any>,
  output: string,
  model: string,
  context?: PromptExecutionContext
): Promise<void> {
  const db = admin.firestore();
  try {
    await db.collection('promptLogs').add({
      stage,
      companyId: context?.companyId || null,
      pipelineRunId: context?.pipelineRunId || null,
      promptVersion: context?.promptVersion || 'runtime',
      prompt: context?.prompt?.substring(0, 10000) || null,
      input: JSON.stringify(input).substring(0, 5000),
      output: output.substring(0, 10000),
      model,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch {
    // non-critical
  }
}

// ─────────────────────────────────────────
// Relevance Check
// ─────────────────────────────────────────
export async function checkRelevance(
  article: { title: string; content: string; source: string },
  aiConfig: RuntimeAiConfig,
  context?: PromptExecutionContext,
  filters?: any // RuntimeFilters
): Promise<RelevanceResult> {
  let extraGuidelines = '';
  if (filters) {
    const include = filters.includeKeywords || [];
    const exclude = filters.excludeKeywords || [];
    if (include.length > 0) {
      extraGuidelines += `\n다음 키워드 중 하나라도 포함되어 있으면 관련 기사로 판단하세요: ${include.join(', ')}.`;
    }
    if (exclude.length > 0) {
      extraGuidelines += `\n다음 주제에 주로 해당하는 기사는 관련 없음으로 판단하세요: ${exclude.join(', ')}.`;
    }
  }

  const prompt = `${aiConfig.relevancePrompt || DEFAULT_RELEVANCE_PROMPT}

${extraGuidelines}

Title: ${article.title}
Content: ${article.content.substring(0, 2000)}
Source: ${article.source}

Decision:`;

  try {
    const result = await callAiProvider(prompt, aiConfig, { temperature: 0.1, maxTokens: 1000 }, context?.companyId);

    const relevantMatch = result.content.match(/RELEVANT:\s*(YES|NO)/i);
    const confidenceMatch = result.content.match(/CONFIDENCE:\s*(\d+\.?\d*)/i);
    const reasonMatch = result.content.match(/REASON:\s*(.+)/i);

    const isRelevant = relevantMatch ? relevantMatch[1].toUpperCase() === 'YES' : false;
    const confidence = confidenceMatch ? parseFloat(confidenceMatch[1]) : (isRelevant ? 0.5 : 0);
    const reason = reasonMatch ? reasonMatch[1].trim() : (isRelevant ? 'Relevant' : 'Not relevant');
    const normalizedConfidence = Math.min(1, Math.max(0, confidence));

    await logPromptExecution('relevance-check', { title: article.title, source: article.source }, result.content, aiConfig.model, { ...context, prompt });
    trackAiCost('relevance-check', result.usage, aiConfig.model, aiConfig.provider, context?.companyId, context?.pipelineRunId).catch(() => {});

    return { isRelevant, confidence: normalizedConfidence, reason };
  } catch (error) {
    // API 오류는 re-throw — "관련 없음"으로 처리하면 안 됨 (기사가 wrongly rejected됨)
    console.error('Error calling AI API for relevance check:', error);
    throw error;
  }
}

// ─────────────────────────────────────────
// Article Analysis
// ─────────────────────────────────────────
export async function analyzeArticle(
  article: { title: string; content: string; source: string; url: string; publishedAt: string },
  aiConfig: RuntimeAiConfig,
  context?: PromptExecutionContext
) {
  const prompt = `${aiConfig.analysisPrompt || DEFAULT_ANALYSIS_PROMPT}

[필수 지시사항]
모든 출력(summary, category, insights, tags)은 반드시 자연스러운 한국어로 작성하세요.
영어 문장은 절대 출력하지 마세요. 고유명사(기업명, 펀드명)는 한국어 표기 후 필요 시 영문 병기.

Article title: ${article.title}
Source: ${article.source}
Published at: ${article.publishedAt}
URL: ${article.url}
Article body:
${article.content}`;

  const result = await callAiProvider(prompt, aiConfig, { temperature: 0.3 }, context?.companyId);
  const content = cleanupJsonResponse(result.content);

  await logPromptExecution('deep-analysis', { title: article.title, source: article.source, url: article.url }, content, aiConfig.model, { ...context, prompt });
  trackAiCost('deep-analysis', result.usage, aiConfig.model, aiConfig.provider, context?.companyId, context?.pipelineRunId).catch(() => {});

  return JSON.parse(content);
}

// ─────────────────────────────────────────
// Batch: Relevance Filtering
// ─────────────────────────────────────────
export async function processRelevanceFiltering(options?: {
  companyId?: string;
  pipelineRunId?: string;
  aiConfig: RuntimeAiConfig;
  filters?: any; // RuntimeFilters
  abortChecker?: () => Promise<boolean>;
}) {
  const db = admin.firestore();
  const baseBatchSize = 500;

  let queryRef: FirebaseFirestore.Query = db.collection('articles').where('status', '==', 'pending');
  if (options?.pipelineRunId) queryRef = queryRef.where('pipelineRunId', '==', options.pipelineRunId);

  const filters = options?.filters;

  const pendingArticlesSnapshot = await queryRef.limit(baseBatchSize).get();
  if (pendingArticlesSnapshot.empty) {
    console.log('[RelevanceFilter] No pending articles found.');
    return { success: true, processed: 0, passed: 0 };
  }
  console.log(`[RelevanceFilter] Found ${pendingArticlesSnapshot.size} pending articles to process.`);

  let processed = 0;
  let passed = 0;

  // ── 병렬 처리: 10개씩 동시 AI 호출 (안정성 우선) ──
  const parallelLimit = 10;
  const articles = pendingArticlesSnapshot.docs;

  for (let i = 0; i < articles.length; i += parallelLimit) {
    // ── 중단 체크 (배치 사이) ──
    if (options?.abortChecker && await options.abortChecker()) {
      console.log(`[RelevanceFilter] Abort requested at batch ${i}/${articles.length}. Returning partial results.`);
      break;
    }
    const chunk = articles.slice(i, i + parallelLimit);
    const promises = chunk.map(async (doc) => {
      const article = doc.data() as any;
      try {
        // 사전 필터링
        let fastRejectReason: string | null = null;
        const mustKeywords = filters?.mustIncludeKeywords || [];
        if (mustKeywords.length > 0) {
          const textToSearch = `${article.title || ''} ${article.content || ''}`.toLowerCase();
          for (const kw of mustKeywords) {
            if (kw.trim() && !textToSearch.includes(kw.trim().toLowerCase())) {
              fastRejectReason = `Missing required keyword: ${kw}`;
              break;
            }
          }
        }

        const excludeKeywords = filters?.excludeKeywords || [];
        if (!fastRejectReason && excludeKeywords.length > 0) {
          const textToSearch = `${article.title || ''} ${article.content || ''}`.toLowerCase();
          for (const kw of excludeKeywords) {
            if (kw.trim() && textToSearch.includes(kw.trim().toLowerCase())) {
              fastRejectReason = `Contains excluded keyword: ${kw}`;
              break;
            }
          }
        }

        let result: RelevanceResult;
        if (fastRejectReason) {
          result = { isRelevant: false, confidence: 0, reason: fastRejectReason };
        } else {
          try {
            const resolvedCompanyId = article.companyId || options?.companyId;
            result = await checkRelevance(
              { title: article.title, content: article.content || article.title, source: article.source },
              options!.aiConfig,
              { companyId: resolvedCompanyId, pipelineRunId: article.pipelineRunId || options?.pipelineRunId },
              filters
            );
          } catch (aiError: any) {
            console.error(`[RelevanceFilter] AI call failed for article ${doc.id}:`, {
              title: article.title?.substring(0, 50),
              provider: options?.aiConfig.provider,
              model: options?.aiConfig.model,
              error: aiError.message,
              status: aiError.response?.status,
              responseData: aiError.response?.data ? JSON.stringify(aiError.response.data).substring(0, 300) : undefined,
            });
            throw aiError;
          }
        }

        return { doc, result, error: null };
      } catch (error: any) {
        console.error(`Failed to filter article ${doc.id}:`, error.message);
        recordError();
        return { doc, result: null, error };
      }
    });

    const results = await Promise.all(promises);

    // 결과를 일괄 업데이트
    const batch = db.batch();
    for (const { doc, result, error } of results) {
      if (result) {
        batch.update(doc.ref, {
          status: result.isRelevant ? 'filtered' : 'rejected',
          filteredAt: admin.firestore.FieldValue.serverTimestamp(),
          relevanceScore: result.confidence,
          relevanceReason: result.reason,
        });
        processed++;
        if (result.isRelevant) passed++;
      }
    }
    if (results.some(r => r.result)) {
      await batch.commit();
    }

    // 배치 간 딜레이 (API 레이트 리미팅)
    if (i + parallelLimit < articles.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  return { success: true, processed, passed };
}

// ─────────────────────────────────────────
// Batch: Deep Analysis
// ─────────────────────────────────────────
export async function processDeepAnalysis(options?: {
  companyId?: string;
  pipelineRunId?: string;
  aiConfig: RuntimeAiConfig;
  abortChecker?: () => Promise<boolean>;
}) {
  const db = admin.firestore();
  const baseBatchSize = 300;

  let queryRef: FirebaseFirestore.Query = db.collection('articles').where('status', '==', 'filtered');
  if (options?.pipelineRunId) queryRef = queryRef.where('pipelineRunId', '==', options.pipelineRunId);

  const filteredArticlesSnapshot = await queryRef.limit(baseBatchSize).get();
  if (filteredArticlesSnapshot.empty) {
    console.log('[DeepAnalysis] No filtered articles found.');
    return { success: true, processed: 0 };
  }
  console.log(`[DeepAnalysis] Found ${filteredArticlesSnapshot.size} filtered articles to analyze.`);

  let processed = 0;

  // ── 병렬 처리: 5개씩 동시 분석 (안정성 우선) ──
  const parallelLimit = 5;
  const articles = filteredArticlesSnapshot.docs;

  for (let i = 0; i < articles.length; i += parallelLimit) {
    // ── 중단 체크 (배치 사이) ──
    if (options?.abortChecker && await options.abortChecker()) {
      console.log(`[DeepAnalysis] Abort requested at batch ${i}/${articles.length}. Returning partial results.`);
      break;
    }
    const chunk = articles.slice(i, i + parallelLimit);
    const promises = chunk.map(async (doc) => {
      const article = doc.data() as any;
      try {
        const publishedAtStr = article.publishedAt
          ? (article.publishedAt.toDate ? article.publishedAt.toDate().toISOString() : new Date(article.publishedAt).toISOString())
          : new Date().toISOString();

        const analysisResult = await analyzeArticle(
          { title: article.title, content: article.content, source: article.source, url: article.url, publishedAt: publishedAtStr },
          options!.aiConfig,
          { companyId: article.companyId || options?.companyId, pipelineRunId: article.pipelineRunId || options?.pipelineRunId }
        );

        return {
          doc,
          analysisResult,
          error: null,
        };
      } catch (error) {
        console.error(`Failed to analyze article ${doc.id}:`, error);
        recordError();
        return { doc, analysisResult: null, error };
      }
    });

    const results = await Promise.all(promises);

    // 결과 일괄 업데이트
    const batch = db.batch();
    for (const { doc, analysisResult } of results) {
      if (analysisResult) {
        batch.update(doc.ref, {
          status: 'analyzed',
          analyzedAt: admin.firestore.FieldValue.serverTimestamp(),
          summary: analysisResult.summary || [],
          category: analysisResult.category || 'other',
          companies: analysisResult.companies || { acquiror: null, target: null, financialSponsor: null },
          deal: analysisResult.deal || { type: 'other', amount: 'undisclosed', stake: null },
          insights: analysisResult.insights || null,
          tags: analysisResult.tags || [],
        });
        processed++;
      }
    }
    if (results.some(r => r.analysisResult)) {
      await batch.commit();
    }

    // 배치 간 딜레이
    if (i + parallelLimit < articles.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  return { success: true, processed };
}
