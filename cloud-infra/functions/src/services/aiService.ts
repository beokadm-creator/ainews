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
const DEFAULT_RELEVANCE_PROMPT = `You are a professional analyst for M&A, private equity, venture capital, and strategic investment news.

Determine whether the article is relevant to the configured investment monitoring workflow.

Relevant examples:
- mergers and acquisitions
- stake sales, divestitures, carve-outs, spin-offs
- private equity deals and fund activity
- venture capital funding
- strategic investments, IPO-linked deal activity
- capital raise, refinancing, restructuring, management buyout

Output format:
RELEVANT: YES or NO
CONFIDENCE: number between 0.0 and 1.0
REASON: short reason`;

const DEFAULT_ANALYSIS_PROMPT = `You are an analyst that extracts structured investment intelligence from news articles.

Return valid JSON only with this shape:
{
  "companies": {
    "acquiror": "string or null",
    "target": "string or null",
    "financialSponsor": "string or null"
  },
  "deal": {
    "type": "string",
    "amount": "string",
    "stake": "string or null"
  },
  "summary": ["sentence 1", "sentence 2", "sentence 3"],
  "category": "string",
  "insights": "string or null",
  "tags": ["tag1", "tag2", "tag3"]
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
  // 1. company Firestore key first
  if (companyId) {
    const companyKey = await getApiKeyForCompany(companyId, aiConfig.provider);
    if (companyKey) return companyKey;
  }
  // 2. env var fallback
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
  stage: 'relevance-check' | 'deep-analysis' | 'daily-briefing' | 'dedup-check' | 'custom-output',
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
      extraGuidelines += `\nThe article IS MORE LIKELY RELEVANT if it contains any of these keywords: ${include.join(', ')}.`;
    }
    if (exclude.length > 0) {
      extraGuidelines += `\nThe article IS HIGHLY IRRELEVANT if it focuses primarily on: ${exclude.join(', ')}.`;
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
    console.error('Error calling AI API for relevance check:', error);
    return { isRelevant: false, confidence: 0, reason: `API error: ${error instanceof Error ? error.message : 'Unknown error'}` };
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

[CRITICAL INSTRUCTION]
All outputs (summary, categories, implications, company names) MUST be translated into perfectly natural Korean (한국어). 
Do NOT output English sentences.

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
}) {
  const db = admin.firestore();
  const baseBatchSize = options?.aiConfig.maxPendingBatch || 20;

  let queryRef: FirebaseFirestore.Query = db.collection('articles').where('status', '==', 'pending');
  if (options?.companyId) queryRef = queryRef.where('companyId', '==', options.companyId);
  if (options?.pipelineRunId) queryRef = queryRef.where('pipelineRunId', '==', options.pipelineRunId);

  // We need the filters to do keyword matching
  const filters = options?.filters;

  const pendingArticlesSnapshot = await queryRef.limit(getDynamicBatchSize(baseBatchSize)).get();
  if (pendingArticlesSnapshot.empty) return { success: true, processed: 0, passed: 0 };

  let processed = 0;
  let passed = 0;
  const batch = db.batch();

  for (const doc of pendingArticlesSnapshot.docs) {
    const article = doc.data() as any;
    try {
      // ── 사전 필터링 (mustIncludeKeywords AND 조건) ──
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

      // ── 사전 필터링 (excludeKeywords 조건) ──
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
        result = await checkRelevance(
          { title: article.title, content: article.content, source: article.source },
          options!.aiConfig,
          { companyId: article.companyId || options?.companyId, pipelineRunId: article.pipelineRunId || options?.pipelineRunId },
          filters
        );
      }
      
      batch.update(doc.ref, {
        status: result.isRelevant ? 'filtered' : 'rejected',
        filteredAt: admin.firestore.FieldValue.serverTimestamp(),
        relevanceScore: result.confidence,
        relevanceReason: result.reason,
      });
      processed++;
      if (result.isRelevant) passed++;
      await new Promise(resolve => setTimeout(resolve, getRateLimitDelay(0)));
    } catch (error) {
      console.error(`Failed to filter article ${doc.id}:`, error);
      recordError();
    }
  }

  if (processed > 0) await batch.commit();
  return { success: true, processed, passed };
}

// ─────────────────────────────────────────
// Batch: Deep Analysis
// ─────────────────────────────────────────
export async function processDeepAnalysis(options?: {
  companyId?: string;
  pipelineRunId?: string;
  aiConfig: RuntimeAiConfig;
}) {
  const db = admin.firestore();
  const baseBatchSize = options?.aiConfig.maxAnalysisBatch || 10;

  let queryRef: FirebaseFirestore.Query = db.collection('articles').where('status', '==', 'filtered');
  if (options?.companyId) queryRef = queryRef.where('companyId', '==', options.companyId);
  if (options?.pipelineRunId) queryRef = queryRef.where('pipelineRunId', '==', options.pipelineRunId);

  const filteredArticlesSnapshot = await queryRef.limit(getDynamicBatchSize(baseBatchSize)).get();
  if (filteredArticlesSnapshot.empty) return { success: true, processed: 0 };

  let processed = 0;
  const batch = db.batch();

  for (const doc of filteredArticlesSnapshot.docs) {
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
      await new Promise(resolve => setTimeout(resolve, getRateLimitDelay(0)));
    } catch (error) {
      console.error(`Failed to analyze article ${doc.id}:`, error);
      recordError();
    }
  }

  if (processed > 0) await batch.commit();
  return { success: true, processed };
}
