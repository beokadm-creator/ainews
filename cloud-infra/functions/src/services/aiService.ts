import axios from 'axios';
import * as admin from 'firebase-admin';
import { randomBytes } from 'crypto';
import { GLM_API_URL, OPENAI_API_URL, ANTHROPIC_API_URL } from '../config/constants';
import { retryWithBackoff } from '../utils/errorHandling';
import { getApiKeyByEnvKey, getApiKeyForCompany, validateApiKey } from '../utils/secretManager';
import { RuntimeAiConfig, AiProvider, PROVIDER_DEFAULTS } from '../types/runtime';
import { syncArticlesToDedup } from './articleDedupService';
import { recordMetric } from './metricsService';
import { hasSportsContext } from './globalKeywordService';
import { DEFAULT_TRACKED_COMPANIES } from './trackedCompanyConfig';

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

type RelevanceBasis =
  | 'keyword_reject'
  | 'ai'
  | 'priority_source_override'
  | 'priority_source_fallback';

interface PromptExecutionContext {
  companyId?: string;
  pipelineRunId?: string;
  prompt?: string;
  promptVersion?: string;
}

interface ApiCallResult {
  content: string;
  usage: TokenUsage;
  provider: AiProvider;
  model: string;
}

interface SourcePriorityDecision {
  isPriority: boolean;
  priority: number;
  reason: string | null;
  sourceMeta: Record<string, any> | null;
}

interface CallProviderTelemetry {
  throttleWaitMs: number;
  fallbackUsed: boolean;
}

interface NormalizedAnalysisResult {
  summary: string[];
  category: string;
  companies: {
    acquiror: string | null;
    target: string | null;
    financialSponsor: string | null;
  };
  deal: {
    type: string;
    amount: string | null;
    stake: string | null;
  };
  insights: string | null;
  tags: string[];
}

const PRIORITY_SOURCE_NAME_PATTERNS = [
  '더벨',
  'thebell',
  'the bell',
  '마켓인사이트',
  'marketinsight',
  'market insight',
];

const sourceMetaCache = new Map<string, Record<string, any> | null>();

// ?????????????????????????????????????????
// Default Prompts
// ?????????????????????????????????????????
const DEFAULT_RELEVANCE_PROMPT = `You are a market intelligence analyst covering M&A, private equity, venture capital, strategic investments, IPO, block trades, restructuring, and major corporate transactions.

Decide whether the article is relevant to the investment monitoring pipeline.

Relevant examples:
- mergers and acquisitions, sale processes, stake sales, tender offers
- private equity buyouts, exits, fundraising, portfolio actions
- venture capital fundraises and strategic investments
- IPO, listing, delisting, block trades
- recapitalization, refinancing, restructuring, carve-out, MBO

Output format:
RELEVANT: YES or NO
CONFIDENCE: number from 0.0 to 1.0
REASON: one short sentence in Korean`;

const DEFAULT_ANALYSIS_PROMPT = `You are an analyst extracting structured deal intelligence from news articles.

Rules:
- Return only valid JSON.
- Write summary, category, insights, and tags in Korean.
- Company names and proper nouns may stay in their original language when appropriate.
- If a field is unknown, return null.

Return this JSON shape exactly:
{
  "companies": {
    "acquiror": "acquirer or null",
    "target": "target or null",
    "financialSponsor": "private equity sponsor or null"
  },
  "deal": {
    "type": "deal type",
    "amount": "deal value or null",
    "stake": "stake or null"
  },
  "summary": ["bullet 1", "bullet 2", "bullet 3"],
  "category": "category",
  "insights": "investment implication in Korean or null",
  "tags": ["tag1", "tag2", "tag3"]
}`;

const CORRUPTED_PROMPT_MARKERS = [
  '?꾩닔',
  '紐⑤뱺',
  '諛섎뱶',
  '?쒓뎅',
  '怨좎쑀',
  '蹂묎린',
  '留덉꽭',
  '湲곗뾽',
  '吏€',
];

// ?????????????????????????????????????????
// Token usage extraction per provider
// ?????????????????????????????????????????
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

// ?????????????????????????????????????????
// AI Cost Tracking
// ?????????????????????????????????????????
export async function trackAiCost(
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

// ?????????????????????????????????????????
// Rate-limit / error tracking
// ?????????????????????????????????????????
let recentErrorCount = 0;
let lastErrorReset = Date.now();

// 429 쿨다운: 메모리(빠른 접근) + Firestore(인스턴스 간 공유)
// Cloud Function은 5분마다 새 인스턴스 → 메모리만 쓰면 쿨다운이 리셋됨
const aiThrottleUntilByProvider: Partial<Record<AiProvider, number>> = {};
let throttleCacheLoadedAt = 0;
const THROTTLE_CACHE_TTL_MS = 8_000;
const THROTTLE_DOC_PATH = 'systemRuntime/aiThrottle';

async function loadThrottleFromFirestore(): Promise<void> {
  if (Date.now() - throttleCacheLoadedAt < THROTTLE_CACHE_TTL_MS) return;
  try {
    const doc = await admin.firestore().doc(THROTTLE_DOC_PATH).get();
    const data = doc.data() || {};
    const now = Date.now();
    for (const [provider, until] of Object.entries(data)) {
      if (typeof until === 'number' && until > now) {
        aiThrottleUntilByProvider[provider as AiProvider] = until;
      }
    }
    throttleCacheLoadedAt = now;
  } catch {
    // Firestore 읽기 실패 시 메모리 값 사용
  }
}

function persistThrottleToFirestore(provider: AiProvider, until: number): void {
  admin.firestore().doc(THROTTLE_DOC_PATH).set(
    { [provider]: until, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  ).then(() => { throttleCacheLoadedAt = Date.now(); }).catch(() => {});
}

const ERROR_WINDOW_MS = 5 * 60 * 1000;
const MAX_ERROR_RATE = 0.3;
// 아티클 레벨 리스: 관련도 필터 ~60s, 심층분석 ~180s → 4분이면 충분
// 10분에서 단축: 스케줄 5분 주기 내에 재시도 가능하도록
const WORKER_LEASE_MS = 4 * 60 * 1000;
const MAX_RETRY_BACKOFF_MS = 60 * 60 * 1000;
const STALE_STAGE_RECOVERY_LIMIT = 10;

function getDynamicBatchSize(baseSize: number): number {
  const now = Date.now();
  if (now - lastErrorReset > ERROR_WINDOW_MS) { recentErrorCount = 0; lastErrorReset = now; }
  const errorRate = recentErrorCount / Math.max(baseSize, 1);
  return errorRate > MAX_ERROR_RATE ? Math.max(3, Math.floor(baseSize * 0.5)) : baseSize;
}

function recordError(): void { recentErrorCount++; }

function sanitizePromptOverride(prompt?: string | null): string | undefined {
  if (!prompt || typeof prompt !== 'string') return undefined;

  const lines = prompt
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => {
      if (!line.trim()) return true;
      if (line.includes('\uFFFD')) return false;
      return !CORRUPTED_PROMPT_MARKERS.some((marker) => line.includes(marker));
    });

  const sanitized = lines.join('\n').trim();
  return sanitized || undefined;
}

function normalizeNullableText(value: unknown, maxLength = 500): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function normalizeTextArray(value: unknown, limit: number, maxLength = 240): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeNullableText(item, maxLength))
    .filter((item): item is string => Boolean(item))
    .slice(0, limit);
}

function normalizeAnalysisResult(raw: any): NormalizedAnalysisResult {
  return {
    summary: normalizeTextArray(raw?.summary, 5, 320),
    category: normalizeNullableText(raw?.category, 120) || 'other',
    companies: {
      acquiror: normalizeNullableText(raw?.companies?.acquiror, 200),
      target: normalizeNullableText(raw?.companies?.target, 200),
      financialSponsor: normalizeNullableText(raw?.companies?.financialSponsor, 200),
    },
    deal: {
      type: normalizeNullableText(raw?.deal?.type, 120) || 'other',
      amount: normalizeNullableText(raw?.deal?.amount, 120),
      stake: normalizeNullableText(raw?.deal?.stake, 120),
    },
    insights: normalizeNullableText(raw?.insights, 2000),
    tags: normalizeTextArray(raw?.tags, 8, 80),
  };
}

function getRateLimitDelay(attempt: number): number {
  return Math.min(5000, 500 * Math.pow(2, attempt));
}

async function waitForAiThrottleWindow(provider: AiProvider): Promise<void> {
  // 새 Function 인스턴스 시작 시 Firestore에서 쿨다운 상태 복원
  await loadThrottleFromFirestore();
  const waitMs = (aiThrottleUntilByProvider[provider] || 0) - Date.now();
  if (waitMs > 0) {
    console.warn(`[AI-THROTTLE] ${provider} 쿨다운 ${Math.round(waitMs / 1000)}초 대기 (Firestore 동기화됨)`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

async function waitForAiThrottleWindowWithTelemetry(provider: AiProvider): Promise<number> {
  await loadThrottleFromFirestore();
  const waitMs = Math.max(0, (aiThrottleUntilByProvider[provider] || 0) - Date.now());
  if (waitMs > 0) {
    console.warn(`[AI-THROTTLE] ${provider} 쿨다운 ${Math.round(waitMs / 1000)}초 대기 (Firestore 동기화됨)`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return waitMs;
}

function registerAiRateLimit(error: any, provider?: AiProvider): void {
  if (!axios.isAxiosError(error) || error.response?.status !== 429) return;
  if (!provider) return;

  const retryAfterHeader = error.response?.headers?.['retry-after'];
  const retryAfterSeconds = Number(Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader);
  // 기본 60초 (이전 15초는 너무 짧아 새 인스턴스에서 즉시 재시도됨)
  const cooldownMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? retryAfterSeconds * 1000
    : 60_000;

  const newUntil = Math.max(aiThrottleUntilByProvider[provider] || 0, Date.now() + cooldownMs);
  aiThrottleUntilByProvider[provider] = newUntil;
  // Firestore에 비동기 저장 → 다음 인스턴스도 이 쿨다운을 인식
  persistThrottleToFirestore(provider, newUntil);
}

function getRetryDelayMs(attemptCount: number): number {
  const safeAttempt = Math.max(1, attemptCount);
  return Math.min(MAX_RETRY_BACKOFF_MS, 60_000 * Math.pow(2, safeAttempt - 1));
}

export function resolveAiConfigForStage(
  aiConfig: RuntimeAiConfig,
  stage: 'filtering' | 'analysis',
): RuntimeAiConfig {
  if (stage === 'filtering' && aiConfig.filteringModel) {
    return {
      ...aiConfig,
      model: aiConfig.filteringModel,
    };
  }

  return {
    ...aiConfig,
  };
}

function isReadyForRetry(article: any, now: Date): boolean {
  const rawValue = article?.nextAiAttemptAt;
  if (!rawValue) return true;

  const retryAt = rawValue?.toDate
    ? rawValue.toDate()
    : new Date(rawValue);

  if (Number.isNaN(retryAt.getTime())) return true;
  return retryAt.getTime() <= now.getTime();
}

async function claimArticlesForStage(
  docs: FirebaseFirestore.QueryDocumentSnapshot[],
  stage: 'filtering' | 'analyzing',
) {
  const db = admin.firestore();
  const now = Date.now();
  const leaseUntil = admin.firestore.Timestamp.fromMillis(now + WORKER_LEASE_MS);
  const allowedStatuses = stage === 'filtering'
    ? ['pending', 'ai_error']
    : ['filtered', 'analysis_error'];

  // Pre-filter using existing snapshot data to avoid unnecessary batch writes
  const claimableArticles = docs.filter((doc) => {
    const data = doc.data() as any;
    const currentStatus = data?.status;

    // Check status and retry readiness using existing snapshot data
    if (!allowedStatuses.includes(currentStatus)) return false;
    if (!isReadyForRetry(data, new Date(now))) return false;

    // Check existing lease using snapshot data
    const existingLease = data?.workerLeaseUntil?.toDate
      ? data.workerLeaseUntil.toDate()
      : (data?.workerLeaseUntil ? new Date(data.workerLeaseUntil) : null);

    if (existingLease && !Number.isNaN(existingLease.getTime()) && existingLease.getTime() > now) {
      return false;
    }

    return true;
  });

  if (claimableArticles.length === 0) {
    return [];
  }

  // Use batch operation for claiming (optimized for single-function pipeline)
  // Race condition risk is low due to:
  // 1. Single Cloud Function instance architecture
  // 2. Small batch sizes (10-60 articles)
  // 3. Pre-filtering reduces conflicts
  try {
    const batch = db.batch();

    claimableArticles.forEach((doc) => {
      batch.update(doc.ref, {
        status: stage,
        workerStage: stage,
        workerLeaseUntil: leaseUntil,
        workerStartedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    await batch.commit();

    console.log(`[AI-${stage}] Successfully claimed ${claimableArticles.length} articles using batch operation`);
    return claimableArticles;
  } catch (error) {
    console.warn(`[AI-${stage}] Batch claim failed, falling back to individual transactions:`, error);

    // Fallback to individual transactions on batch failure
    const claimed: FirebaseFirestore.QueryDocumentSnapshot[] = [];

    for (const doc of claimableArticles.slice(0, 5)) { // Limit fallback to prevent excessive reads
      try {
        const wasClaimed = await db.runTransaction(async (tx) => {
          const snap = await tx.get(doc.ref);
          if (!snap.exists) return false;

          const data = snap.data() as any;
          const currentStatus = data?.status;

          if (!allowedStatuses.includes(currentStatus)) return false;
          if (!isReadyForRetry(data, new Date(now))) return false;

          const existingLease = data?.workerLeaseUntil?.toDate
            ? data.workerLeaseUntil.toDate()
            : (data?.workerLeaseUntil ? new Date(data.workerLeaseUntil) : null);

          if (existingLease && !Number.isNaN(existingLease.getTime()) && existingLease.getTime() > now) {
            return false;
          }

          tx.update(doc.ref, {
            status: stage,
            workerStage: stage,
            workerLeaseUntil: leaseUntil,
            workerStartedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          return true;
        });

        if (wasClaimed) {
          claimed.push(doc);
        }
      } catch (txError) {
        console.warn(`[AI-${stage}] Failed to claim article ${doc.id} in fallback:`, txError);
      }
    }

    return claimed;
  }
}

async function recoverStaleArticlesForStage(stage: 'filtering' | 'analyzing') {
  const db = admin.firestore();
  const now = Date.now();
  const recoveryStatus = stage === 'filtering' ? 'pending' : 'filtered';

  const snapshot = await db.collection('articles')
    .where('status', '==', stage)
    .limit(STALE_STAGE_RECOVERY_LIMIT)
    .get();

  if (snapshot.empty) {
    return 0;
  }

  let recovered = 0;
  const batch = db.batch();

  for (const doc of snapshot.docs) {
    const data = doc.data() as any;
    const existingLease = data?.workerLeaseUntil?.toDate
      ? data.workerLeaseUntil.toDate()
      : (data?.workerLeaseUntil ? new Date(data.workerLeaseUntil) : null);

    const leaseExpired = !existingLease || Number.isNaN(existingLease.getTime()) || existingLease.getTime() <= now;
    if (!leaseExpired) {
      continue;
    }

    batch.set(doc.ref, {
      status: recoveryStatus,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...clearWorkerFields(),
    }, { merge: true });
    recovered += 1;
  }

  if (recovered > 0) {
    await batch.commit();
    console.warn(`[AI-${stage}] Recovered ${recovered} stale articles back to ${recoveryStatus}.`);
  }

  return recovered;
}

function clearWorkerFields() {
  return {
    nextAiAttemptAt: admin.firestore.FieldValue.delete(),
    workerStage: admin.firestore.FieldValue.delete(),
    workerLeaseUntil: admin.firestore.FieldValue.delete(),
  };
}

const MAX_AI_RETRIES = 5;

function buildRetryUpdate(
  status: 'ai_error' | 'analysis_error',
  stage: 'relevance' | 'analysis',
  attemptCount: number,
  errorMessage: string,
) {
  if (attemptCount >= MAX_AI_RETRIES) {
    // Permanently reject the article to prevent infinite read loops in the pipeline
    return {
      status: 'rejected',
      relevanceBasis: `permanent_${status}`,
      relevanceReason: `Exceeded max retries (${MAX_AI_RETRIES}). Last error: ${errorMessage}`,
      lastAiErrorStage: stage,
      lastAiError: errorMessage,
      lastAiErrorAt: admin.firestore.FieldValue.serverTimestamp(),
      workerStage: admin.firestore.FieldValue.delete(),
      workerLeaseUntil: admin.firestore.FieldValue.delete(),
      nextAiAttemptAt: admin.firestore.FieldValue.delete(),
      ...(stage === 'relevance'
        ? { relevanceAttemptCount: attemptCount }
        : { analysisAttemptCount: attemptCount }),
    };
  }

  return {
    status,
    ...(stage === 'relevance'
      ? { relevanceAttemptCount: attemptCount }
      : { analysisAttemptCount: attemptCount }),
    lastAiErrorStage: stage,
    lastAiError: errorMessage,
    lastAiErrorAt: admin.firestore.FieldValue.serverTimestamp(),
    nextAiAttemptAt: admin.firestore.Timestamp.fromMillis(Date.now() + getRetryDelayMs(attemptCount)),
    workerStage: admin.firestore.FieldValue.delete(),
    workerLeaseUntil: admin.firestore.FieldValue.delete(),
  };
}

async function loadClaimableArticlesForStage(
  queryRef: FirebaseFirestore.Query,
  stage: 'filtering' | 'analyzing',
  baseBatchSize: number,
  emptyLog: string,
  unclaimableLog: string,
) {
  const snapshot = await queryRef.limit(Math.max(baseBatchSize * 3, baseBatchSize)).get();
  if (snapshot.empty) {
    console.log(emptyLog);
    return [];
  }

  const claimCandidates = snapshot.docs
    .filter((doc) => isReadyForRetry(doc.data(), new Date()))
    .slice(0, baseBatchSize);

  const claimed = await claimArticlesForStage(claimCandidates, stage);
  if (claimed.length === 0) {
    console.log(unclaimableLog);
  }

  return claimed;
}

function normalizeSourceName(name?: string): string {
  return (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function loadSourceMetadata(article: any): Promise<Record<string, any> | null> {
  const db = admin.firestore();
  const sourceId = article?.globalSourceId || article?.sourceId;
  if (sourceId) {
    const cacheKey = `id:${sourceId}`;
    if (sourceMetaCache.has(cacheKey)) {
      return sourceMetaCache.get(cacheKey) || null;
    }

    const doc = await db.collection('globalSources').doc(sourceId).get();
    let data = doc.exists ? { id: doc.id, ...doc.data() } : null;
    if (!data) {
      const fallbackSnap = await db.collection('globalSources')
        .where('localScraperId', '==', sourceId)
        .limit(1)
        .get();
      data = fallbackSnap.empty ? null : { id: fallbackSnap.docs[0].id, ...fallbackSnap.docs[0].data() };
    }
    sourceMetaCache.set(cacheKey, data);
    return data;
  }

  const sourceName = normalizeSourceName(article?.source);
  if (!sourceName) return null;

  const cacheKey = `name:${sourceName}`;
  if (sourceMetaCache.has(cacheKey)) {
    return sourceMetaCache.get(cacheKey) || null;
  }

  const snap = await db.collection('globalSources')
    .where('name', '==', article.source)
    .limit(1)
    .get();
  const data = snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
  sourceMetaCache.set(cacheKey, data);
  return data;
}

async function getSourcePriorityDecision(article: any): Promise<SourcePriorityDecision> {
  const sourceMeta = await loadSourceMetadata(article);
  const sourceName = normalizeSourceName(article?.source || sourceMeta?.name);
  const pricingTier = sourceMeta?.pricingTier || article?.sourcePricingTier || null;

  if (pricingTier === 'paid' || pricingTier === 'requires_subscription') {
    return {
      isPriority: true,
      priority: pricingTier === 'paid' ? 120 : 110,
      reason: `priority pricing tier: ${pricingTier}`,
      sourceMeta,
    };
  }

  if (PRIORITY_SOURCE_NAME_PATTERNS.some((pattern) => sourceName.includes(pattern))) {
    return {
      isPriority: true,
      priority: 100,
      reason: 'priority source name match',
      sourceMeta,
    };
  }

  const matchedKeyword = `${article?.keywordMatched || ''}`.trim();
  if (matchedKeyword && DEFAULT_TRACKED_COMPANIES.includes(matchedKeyword)) {
    return {
      isPriority: true,
      priority: 100,
      reason: `tracked company match: ${matchedKeyword}`,
      sourceMeta,
    };
  }

  return {
    isPriority: Boolean(article?.priorityAnalysis),
    priority: Number(article?.analysisPriority || 0),
    reason: article?.priorityAnalysisReason || null,
    sourceMeta,
  };
}

// ?????????????????????????????????????????
// Provider-specific API callers
// ?????????????????????????????????????????
async function resolveApiKey(aiConfig: RuntimeAiConfig, companyId?: string): Promise<string> {
  const db = admin.firestore();

  // 1李? systemSettings/aiConfig.apiKeys.{provider}
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

  // 2李? companySettings fallback (companyId 吏???먮뒗 泥??쒖꽦 ?뚯궗)
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
        // systemSettings???숆린??(?ㅼ쓬 ?몄텧 理쒖쟻??
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

function isRetryableForFallback(error: any): boolean {
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status;
  return status === 429 || (status !== undefined && status >= 500) || status === undefined;
}

export function resolveFallbackAiConfig(aiConfig: RuntimeAiConfig): RuntimeAiConfig | null {
  if (!aiConfig.fallbackProvider || aiConfig.fallbackProvider === aiConfig.provider) {
    return null;
  }

  const defaults = PROVIDER_DEFAULTS[aiConfig.fallbackProvider];
  return {
    ...aiConfig,
    provider: aiConfig.fallbackProvider,
    model: aiConfig.fallbackModel || defaults.model,
    baseUrl: undefined,
    apiKeyEnvKey: defaults.apiKeyEnvKey,
  };
}

export type AiTaskProfile =
  | 'connection'
  | 'relevance'
  | 'analysis'
  | 'dedup'
  | 'article-list-summary'
  | 'daily-briefing'
  | 'custom-report';

type ApiCallOptions = {
  temperature?: number;
  maxTokens?: number;
  maxRetries?: number;
  requestTimeoutMs?: number;
  topP?: number;
  doSample?: boolean;
  structuredJson?: boolean;
  thinkingType?: 'enabled' | 'disabled';
  clearThinking?: boolean;
  taskProfile?: AiTaskProfile;
};

export function resolveAiCallOptions(
  provider: AiProvider,
  taskProfile: AiTaskProfile,
  overrides?: Omit<ApiCallOptions, 'taskProfile'>,
): ApiCallOptions {
  const base: ApiCallOptions = { ...(overrides || {}), taskProfile };

  if (provider !== 'glm') {
    return base;
  }

  const glmDefaults: Record<AiTaskProfile, ApiCallOptions> = {
    connection: {
      temperature: 0,
      maxTokens: 10,
      doSample: false,
      thinkingType: 'disabled',
      clearThinking: true,
    },
    relevance: {
      temperature: 0,
      maxTokens: 120,
      doSample: false,
      thinkingType: 'disabled',
      clearThinking: true,
      structuredJson: true,
    },
    analysis: {
      temperature: 0,
      // glm-4.7 thinking 모드 시 reasoning ~200-500 토큰 소모 → 출력 여유 확보
      maxTokens: 3000,
      doSample: false,
      thinkingType: 'disabled',
      clearThinking: true,
      structuredJson: true,
    },
    dedup: {
      temperature: 0,
      maxTokens: 40,
      doSample: false,
      thinkingType: 'disabled',
      clearThinking: true,
      structuredJson: true,
    },
    'article-list-summary': {
      temperature: 0.2,
      maxTokens: 1200,
      doSample: false,
      thinkingType: 'disabled',
      clearThinking: true,
      structuredJson: true,
    },
    'daily-briefing': {
      temperature: 0.2,
      maxTokens: 6000,
      maxRetries: 8,
      requestTimeoutMs: 480000,
      doSample: false,
      thinkingType: 'enabled',
      clearThinking: true,
      structuredJson: true,
    },
    'custom-report': {
      temperature: 0.2,
      // thinking 모드를 비활성화하여 max_tokens를 온전히 출력에 사용
      // thinking 활성 시 reasoning 토큰이 max_tokens 예산을 소비해 38개 기사 중 ~17개에서 중단됨
      maxTokens: 32000,
      maxRetries: 8,
      requestTimeoutMs: 480000,
      thinkingType: 'disabled',
      clearThinking: true,
    },
  };

  return {
    ...glmDefaults[taskProfile],
    ...base,
  };
}

function requireNonEmptyAiContent(content: unknown, provider: AiProvider, model: string): string {
  const normalized = typeof content === 'string' ? content.trim() : '';
  if (!normalized) {
    throw new Error(`Provider ${provider} model ${model} returned empty content.`);
  }
  return normalized;
}

async function callGlmApi(prompt: string, apiKey: string, aiConfig: RuntimeAiConfig, options?: ApiCallOptions): Promise<ApiCallResult> {
  return retryWithBackoff(async () => {
    let url = aiConfig.baseUrl || GLM_API_URL;
    if (url.endsWith('/')) url = url.slice(0, -1);
    if (!url.endsWith('/chat/completions')) url += '/chat/completions';
    console.log(`[AI-START] Calling ${aiConfig.provider} (${aiConfig.model}) at ${url}...`);
    const requestBody: Record<string, any> = {
      model: aiConfig.model,
      request_id: randomBytes(8).toString('hex'),
      messages: [{ role: 'user', content: prompt }],
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : { temperature: 0.2 }),
      ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
      ...(options?.topP !== undefined ? { top_p: options.topP } : {}),
      ...(options?.doSample !== undefined ? { do_sample: options.doSample } : {}),
      // thinking 파라미터: disabled 포함 항상 전송
      // Z.AI /coding/paas/v4 엔드포인트의 glm-4.7은 기본적으로 thinking 모드 동작
      // 'disabled' 파라미터가 reasoning_tokens를 억제해 출력 토큰을 확보함
      ...(options?.thinkingType
        ? {
            thinking: {
              type: options.thinkingType,
              clear_thinking: options.clearThinking ?? true,
            },
          }
        : {}),
      ...(options?.structuredJson ? { response_format: { type: 'json_object' } } : {}),
    };
    const response = await axios.post(
      url,
      requestBody,
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: options?.requestTimeoutMs ?? 240000,
      }
    );
    const rawContent = response.data.choices?.[0]?.message?.content;
    if (rawContent == null) {
      const finishReason = response.data.choices?.[0]?.finish_reason;
      console.error('GLM empty content. finish_reason:', finishReason, 'full response:', JSON.stringify(response.data).substring(0, 500));
      throw new Error(`Model returned empty content. finish_reason: ${finishReason || 'unknown'}. Check model name "${aiConfig.model}" and endpoint.`);
    }
    return {
      content: requireNonEmptyAiContent(rawContent, 'glm', aiConfig.model),
      usage: extractTokenUsage(response.data, 'glm'),
      provider: 'glm',
      model: aiConfig.model,
    };
  }, options?.maxRetries);
}

async function callOpenAiApi(prompt: string, apiKey: string, aiConfig: RuntimeAiConfig, options?: ApiCallOptions): Promise<ApiCallResult> {
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
      content: requireNonEmptyAiContent(response.data.choices?.[0]?.message?.content, 'openai', aiConfig.model),
      usage: extractTokenUsage(response.data, 'openai'),
      provider: 'openai',
      model: aiConfig.model,
    };
  }, options?.maxRetries);
}

async function callGeminiApi(prompt: string, apiKey: string, aiConfig: RuntimeAiConfig, options?: ApiCallOptions): Promise<ApiCallResult> {
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
    const content = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
    return {
      content: requireNonEmptyAiContent(content, 'gemini', aiConfig.model),
      usage: extractTokenUsage(response.data, 'gemini'),
      provider: 'gemini',
      model: aiConfig.model,
    };
  }, options?.maxRetries);
}

async function callClaudeApi(prompt: string, apiKey: string, aiConfig: RuntimeAiConfig, options?: ApiCallOptions): Promise<ApiCallResult> {
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
    const content = response.data.content?.[0]?.text;
    return {
      content: requireNonEmptyAiContent(content, 'claude', aiConfig.model),
      usage: extractTokenUsage(response.data, 'claude'),
      provider: 'claude',
      model: aiConfig.model,
    };
  }, options?.maxRetries);
}

function routeToProvider(provider: string, prompt: string, apiKey: string, config: RuntimeAiConfig, opts?: ApiCallOptions): Promise<ApiCallResult> {
  switch (provider) {
    case 'gemini': return callGeminiApi(prompt, apiKey, config, opts);
    case 'openai': return callOpenAiApi(prompt, apiKey, config, opts);
    case 'claude': return callClaudeApi(prompt, apiKey, config, opts);
    default:       return callGlmApi(prompt, apiKey, config, opts);
  }
}

// ?????????????????????????????????????????
// Unified API caller (routes by provider + fallback)
// ?????????????????????????????????????????
export async function callAiProvider(
  prompt: string,
  aiConfig: RuntimeAiConfig,
  options?: ApiCallOptions,
  companyId?: string
): Promise<ApiCallResult> {
  const startedAt = Date.now();
  const telemetry: CallProviderTelemetry = {
    throttleWaitMs: await waitForAiThrottleWindowWithTelemetry(aiConfig.provider),
    fallbackUsed: false,
  };
  const apiKey = await resolveApiKey(aiConfig, companyId);
  validateApiKey(apiKey, aiConfig.provider);

  // Fallback is meant to fail over quickly rather than spend a long time stuck on the primary provider.
  const primaryOpts: ApiCallOptions = { ...options, maxRetries: aiConfig.fallbackProvider ? 2 : undefined };

  try {
    const result = await routeToProvider(aiConfig.provider, prompt, apiKey, aiConfig, primaryOpts);
    const latencyMs = Date.now() - startedAt;
    console.log(`[AI-CALL] provider=${result.provider} model=${result.model} latencyMs=${latencyMs} throttleWaitMs=${telemetry.throttleWaitMs} fallbackUsed=false promptChars=${prompt.length}`);
    recordMetric({
      stage: 'ai',
      action: 'call',
      count: 1,
      duration: latencyMs,
      success: true,
      metadata: {
        provider: result.provider,
        model: result.model,
        companyId: companyId || null,
        throttleWaitMs: telemetry.throttleWaitMs,
        fallbackUsed: false,
        promptChars: prompt.length,
      },
    }).catch(() => {});
    return result;
  } catch (primaryError: any) {
    registerAiRateLimit(primaryError, aiConfig.provider);

    const fallbackConfig = resolveFallbackAiConfig(aiConfig);
    if (fallbackConfig && isRetryableForFallback(primaryError)) {
      const fallbackOpts: ApiCallOptions = { ...options, maxRetries: 2 };
      console.warn(
        `[AI-FALLBACK] ${aiConfig.provider}(${aiConfig.model}) failed: ${primaryError.message?.substring(0, 120)}` +
        ` -> ${fallbackConfig.provider}(${fallbackConfig.model})`
      );
      telemetry.fallbackUsed = true;
      const fallbackThrottleWaitMs = await waitForAiThrottleWindowWithTelemetry(fallbackConfig.provider);
      const fallbackKey = await resolveApiKey(fallbackConfig, companyId);
      validateApiKey(fallbackKey, fallbackConfig.provider);
      try {
        const result = await routeToProvider(fallbackConfig.provider, prompt, fallbackKey, fallbackConfig, fallbackOpts);
        const latencyMs = Date.now() - startedAt;
        console.log(`[AI-CALL] provider=${result.provider} model=${result.model} latencyMs=${latencyMs} throttleWaitMs=${telemetry.throttleWaitMs + fallbackThrottleWaitMs} fallbackUsed=true promptChars=${prompt.length}`);
        recordMetric({
          stage: 'ai',
          action: 'call',
          count: 1,
          duration: latencyMs,
          success: true,
          metadata: {
            provider: result.provider,
            model: result.model,
            companyId: companyId || null,
            primaryProvider: aiConfig.provider,
            primaryModel: aiConfig.model,
            throttleWaitMs: telemetry.throttleWaitMs,
            fallbackThrottleWaitMs,
            fallbackUsed: true,
            promptChars: prompt.length,
          },
        }).catch(() => {});
        return result;
      } catch (fallbackError: any) {
        registerAiRateLimit(fallbackError, fallbackConfig.provider);
        const latencyMs = Date.now() - startedAt;
        console.error(`[AI-CALL] provider=${aiConfig.provider} model=${aiConfig.model} failed latencyMs=${latencyMs} fallbackUsed=true error=${fallbackError.message}`);
        recordMetric({
          stage: 'ai',
          action: 'call',
          count: 1,
          duration: latencyMs,
          success: false,
          metadata: {
            provider: aiConfig.provider,
            model: aiConfig.model,
            fallbackProvider: fallbackConfig.provider,
            fallbackModel: fallbackConfig.model,
            companyId: companyId || null,
            throttleWaitMs: telemetry.throttleWaitMs,
            fallbackUsed: true,
            promptChars: prompt.length,
            error: fallbackError.message?.substring(0, 300) || 'Unknown AI error',
          },
        }).catch(() => {});
        throw fallbackError;
      }
    }
    const latencyMs = Date.now() - startedAt;
    console.error(`[AI-CALL] provider=${aiConfig.provider} model=${aiConfig.model} failed latencyMs=${latencyMs} fallbackUsed=false error=${primaryError.message}`);
    recordMetric({
      stage: 'ai',
      action: 'call',
      count: 1,
      duration: latencyMs,
      success: false,
      metadata: {
        provider: aiConfig.provider,
        model: aiConfig.model,
        companyId: companyId || null,
        throttleWaitMs: telemetry.throttleWaitMs,
        fallbackUsed: false,
        promptChars: prompt.length,
        error: primaryError.message?.substring(0, 300) || 'Unknown AI error',
      },
    }).catch(() => {});
    throw primaryError;
  }
}

// ?????????????????????????????????????????
// Test AI connection (for Settings UI)
// ?????????????????????????????????????????
export async function testAiProviderConnection(
  aiConfig: RuntimeAiConfig,
  companyId?: string
): Promise<{ success: boolean; message: string; model: string; provider: string; latencyMs?: number }> {
  const startMs = Date.now();
  try {
    const result = await callAiProvider(
      'Reply with exactly: OK',
      aiConfig,
      resolveAiCallOptions(aiConfig.provider, 'connection'),
      companyId
    );
    const latencyMs = Date.now() - startMs;
    return {
      success: true,
      message: `Connection successful (${latencyMs}ms)${result.content ? ` ??"${result.content.substring(0, 40)}"` : ''}`,
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

// ?????????????????????????????????????????
// JSON cleanup
// ?????????????????????????????????????????
function cleanupJsonResponse(content: string): string {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) return jsonMatch[0];
  let cleaned = content.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.substring(7);
  else if (cleaned.startsWith('```')) cleaned = cleaned.substring(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.substring(0, cleaned.length - 3);
  return cleaned.trim();
}

function parseJsonObject<T = Record<string, any>>(content: string): T {
  return JSON.parse(cleanupJsonResponse(content)) as T;
}

function clampConfidence(confidence?: number | null): number | null {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return null;
  return Math.min(1, Math.max(0, confidence));
}

function toRelevancePoints(confidence?: number | null): number | null {
  const normalized = clampConfidence(confidence);
  if (normalized == null) return null;
  return Math.round(normalized * 100);
}

// ?????????????????????????????????????????
// Prompt Logging
// ?????????????????????????????????????????
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

// ?????????????????????????????????????????
// Relevance Check
// ?????????????????????????????????????????
export async function checkRelevance(
  article: { title: string; content: string; source: string },
  aiConfig: RuntimeAiConfig,
  context?: PromptExecutionContext,
  filters?: any // RuntimeFilters
): Promise<RelevanceResult> {
  if (hasSportsContext(`${article.title || ''} ${article.content || ''}`)) {
    return {
      isRelevant: false,
      confidence: 0,
      reason: '스포츠 문맥 기사 제외',
    };
  }

  let extraGuidelines = '';
  if (filters) {
    const include = filters.includeKeywords || [];
    const exclude = filters.excludeKeywords || [];
    extraGuidelines += '\nIf the article materially relates to a deal, investment, fundraising, exit, listing, restructuring, or a likely transaction path, classify it as RELEVANT: YES.';
    if (include.length > 0) {
      extraGuidelines += `\nTreat the following keywords as positive relevance hints: ${include.join(', ')}.`;
    }
    if (exclude.length > 0) {
      extraGuidelines += `\nIf the article is mainly about the following excluded topics, mark it as not relevant: ${exclude.join(', ')}.`;
    }
  }

  const prompt = `${sanitizePromptOverride(aiConfig.relevancePrompt) || DEFAULT_RELEVANCE_PROMPT}

${extraGuidelines}

Important:
- Review both the title and the original body text together.
- If a registered keyword appears only as a short alias, abbreviation, or incidental mention but the body is mainly about another topic, mark it as not relevant.
- Only keep the article when the body materially relates to the matched company, tracked company, investment, fundraising, sale, restructuring, or transaction theme.

Title: ${article.title}
Content: ${article.content.substring(0, 2000)}
Source: ${article.source}

Return only valid JSON:
{
  "relevant": true,
  "confidence": 0.0,
  "reason": "short Korean reason"
}`;

  try {
    const result = await callAiProvider(
      prompt,
      aiConfig,
      resolveAiCallOptions(aiConfig.provider, 'relevance'),
      context?.companyId,
    );

    const parsed = parseJsonObject<{ relevant?: boolean; confidence?: number; reason?: string }>(result.content);
    const isRelevant = Boolean(parsed.relevant);
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : (isRelevant ? 0.5 : 0);
    const reason = `${parsed.reason || (isRelevant ? 'Relevant' : 'Not relevant')}`.trim();
    const normalizedConfidence = Math.min(1, Math.max(0, confidence));

    await logPromptExecution('relevance-check', { title: article.title, source: article.source }, result.content, result.model, { ...context, prompt });
    trackAiCost('relevance-check', result.usage, result.model, result.provider, context?.companyId, context?.pipelineRunId).catch(() => {});

    return { isRelevant, confidence: normalizedConfidence, reason };
  } catch (error) {
    // API ?ㅻ쪟??re-throw ??"愿???놁쓬"?쇰줈 泥섎━?섎㈃ ????(湲곗궗媛 wrongly rejected??
    console.error('Error calling AI API for relevance check:', error);
    throw error;
  }
}

// ?????????????????????????????????????????
// Article Analysis
// ?????????????????????????????????????????
export async function analyzeArticle(
  article: { title: string; content: string; source: string; url: string; publishedAt: string },
  aiConfig: RuntimeAiConfig,
  context?: PromptExecutionContext
) {
  const prompt = `${sanitizePromptOverride(aiConfig.analysisPrompt) || DEFAULT_ANALYSIS_PROMPT}

Additional rules:
- summary, category, insights, and tags must be written in Korean.
- Do not output explanatory text outside JSON.
- Keep company names, brands, and legal entity names in their natural form when needed.

Article title: ${article.title}
Source: ${article.source}
Published at: ${article.publishedAt}
URL: ${article.url}
Article body:
${article.content}`;

  const result = await callAiProvider(
    prompt,
    aiConfig,
    resolveAiCallOptions(aiConfig.provider, 'analysis'),
    context?.companyId,
  );
  const content = cleanupJsonResponse(result.content);

  await logPromptExecution('deep-analysis', { title: article.title, source: article.source, url: article.url }, content, result.model, { ...context, prompt });
  trackAiCost('deep-analysis', result.usage, result.model, result.provider, context?.companyId, context?.pipelineRunId).catch(() => {});

  return JSON.parse(content);
}

// ?????????????????????????????????????????
// Batch: Relevance Filtering
// ?????????????????????????????????????????
export async function processRelevanceFiltering(options?: {
  companyId?: string;
  pipelineRunId?: string;
  aiConfig: RuntimeAiConfig;
  filters?: any; // RuntimeFilters
  abortChecker?: () => Promise<boolean>;
}) {
  const db = admin.firestore();
  const baseBatchSize = Math.max(20, options?.aiConfig.maxPendingBatch || 60);

  // Note: Stale article recovery is now handled at drainAiAnalysisQueue level
  // to avoid duplicate reads. See recoverStaleAiStageArticles() call in index.ts

  let queryRef: FirebaseFirestore.Query = db.collection('articles')
    .where('status', 'in', ['pending', 'ai_error']);
  if (options?.pipelineRunId) queryRef = queryRef.where('pipelineRunId', '==', options.pipelineRunId);

  const filters = options?.filters;
  const articles = await loadClaimableArticlesForStage(
    queryRef,
    'filtering',
    baseBatchSize,
    '[RelevanceFilter] No pending or retryable articles found.',
    '[RelevanceFilter] No claimable articles found after lease/retry checks.',
  );

  if (articles.length === 0) {
    return { success: true, processed: 0, passed: 0 };
  }

  console.log(`[RelevanceFilter] Claimed ${articles.length} articles to process.`);

  let processed = 0;
  let passed = 0;
  let failed = 0;

  // 429 rate limit 방지: 최소 동시 호출 1개 (기존 3개에서 낮춤)
  // AI 설정의 maxPendingBatch 값으로 조정 가능 (기본 2)
  const parallelLimit = Math.max(1, Math.min(3, getDynamicBatchSize(Math.min(3, options?.aiConfig.maxPendingBatch || 2))));

  for (let i = 0; i < articles.length; i += parallelLimit) {
    if (options?.abortChecker && await options.abortChecker()) {
      console.log(`[RelevanceFilter] Abort requested at batch ${i}/${articles.length}. Returning partial results.`);
      break;
    }

    const chunk = articles.slice(i, i + parallelLimit);
    const results = await Promise.all(chunk.map(async (doc) => {
      const article = doc.data() as any;
      try {
        const priorityDecision = await getSourcePriorityDecision(article);
        let fastRejectReason: string | null = null;

        if (!priorityDecision.isPriority) {
          const textToSearch = `${article.title || ''} ${article.content || ''}`;
          const normalizedText = textToSearch.toLowerCase();
          if (hasSportsContext(textToSearch)) {
            fastRejectReason = 'Sports context article';
          }

          const mustKeywords = filters?.mustIncludeKeywords || [];
          if (!fastRejectReason && mustKeywords.length > 0) {
            const hasAnyMustKeyword = mustKeywords.some((kw: string) =>
              kw.trim() && normalizedText.includes(kw.trim().toLowerCase())
            );
            for (const kw of mustKeywords) {
              if (kw.trim() && !normalizedText.includes(kw.trim().toLowerCase())) {
                if (hasAnyMustKeyword) break;
                fastRejectReason = `Missing required keyword: ${kw}`;
                break;
              }
            }
          }

          const excludeKeywords = filters?.excludeKeywords || [];
          if (!fastRejectReason && excludeKeywords.length > 0) {
            for (const kw of excludeKeywords) {
              if (kw.trim() && normalizedText.includes(kw.trim().toLowerCase())) {
                fastRejectReason = `Contains excluded keyword: ${kw}`;
                break;
              }
            }
          }
        }

        let result: RelevanceResult;
        let aiRelevanceResult: RelevanceResult | null = null;
        const filteringAiConfig = resolveAiConfigForStage(options!.aiConfig, 'filtering');

        if (fastRejectReason) {
          result = { isRelevant: false, confidence: 0, reason: fastRejectReason };
        } else {
          try {
            const resolvedCompanyId = article.companyId || options?.companyId;

            aiRelevanceResult = await checkRelevance(
              { title: article.title, content: article.content || article.title, source: article.source },
              filteringAiConfig,
              { companyId: resolvedCompanyId, pipelineRunId: article.pipelineRunId || options?.pipelineRunId },
              filters
            );
            result = aiRelevanceResult;

            if (priorityDecision.isPriority && !result.isRelevant) {
              result = {
                isRelevant: true,
                confidence: Math.max(0.8, result.confidence || 0),
                reason: `Priority analysis override (${priorityDecision.reason || 'priority source'}). AI relevance note: ${result.reason}`,
              };
            }
          } catch (aiError: any) {
            registerAiRateLimit(aiError);
            console.error(`[RelevanceFilter] AI call failed for article ${doc.id}:`, {
              title: article.title?.substring(0, 50),
              provider: filteringAiConfig.provider,
              model: filteringAiConfig.model,
              error: aiError.message,
              status: aiError.response?.status,
              responseData: aiError.response?.data ? JSON.stringify(aiError.response.data).substring(0, 300) : undefined,
            });

            if (priorityDecision.isPriority) {
              result = {
                isRelevant: true,
                confidence: 1,
                reason: `Priority analysis override (${priorityDecision.reason || 'priority source'}). Relevance check failed: ${aiError.message}`,
              };
            } else {
              throw aiError;
            }
          }
        }

        return { doc, result, aiRelevanceResult, priorityDecision, error: null };
      } catch (error: any) {
        registerAiRateLimit(error);
        console.error(`Failed to filter article ${doc.id}:`, error.message);
        recordError();
        return { doc, result: null, aiRelevanceResult: null, priorityDecision: null, error };
      }
    }));

    const batch = db.batch();
    const rejectedDocs: FirebaseFirestore.QueryDocumentSnapshot[] = [];

    for (const { doc, result, aiRelevanceResult, priorityDecision, error } of results) {
      if (result) {
        const aiConfidence = clampConfidence(aiRelevanceResult?.confidence ?? null);
        let relevanceBasis: RelevanceBasis = 'ai';

        if (!aiRelevanceResult && !result.isRelevant && result.confidence === 0) {
          relevanceBasis = 'keyword_reject';
        } else if (priorityDecision?.isPriority && aiRelevanceResult) {
          relevanceBasis = 'priority_source_override';
        } else if (priorityDecision?.isPriority && !aiRelevanceResult) {
          relevanceBasis = 'priority_source_fallback';
        }

        const finalConfidence = relevanceBasis === 'priority_source_fallback'
          ? null
          : clampConfidence(aiRelevanceResult?.confidence ?? result.confidence);
        const finalScore = relevanceBasis === 'priority_source_fallback'
          ? null
          : toRelevancePoints(aiRelevanceResult?.confidence ?? result.confidence);

        const collectedData = doc.data() as any;

        batch.update(doc.ref, {
          status: result.isRelevant ? 'filtered' : 'rejected',
          filteredAt: admin.firestore.FieldValue.serverTimestamp(),
          relevanceScore: finalScore,
          relevanceScoreMax: 100,
          relevanceConfidence: finalConfidence,
          relevanceBasis,
          relevanceReason: result.reason,
          aiRelevanceDecision: aiRelevanceResult?.isRelevant ?? result.isRelevant,
          aiRelevanceScore: toRelevancePoints(aiConfidence),
          aiRelevanceConfidence: aiConfidence,
          aiRelevanceReason: aiRelevanceResult?.reason ?? result.reason,
          keywordMatched: collectedData?.keywordMatched || null,
          keywordPrefilterReason: collectedData?.keywordPrefilterReason || null,
          priorityAnalysis: priorityDecision?.isPriority || false,
          analysisPriority: priorityDecision?.priority || 0,
          priorityAnalysisReason: priorityDecision?.reason || null,
          sourcePricingTier: priorityDecision?.sourceMeta?.pricingTier || doc.data()?.sourcePricingTier || null,
          relevanceAttemptCount: admin.firestore.FieldValue.delete(),
          lastAiErrorStage: admin.firestore.FieldValue.delete(),
          lastAiError: admin.firestore.FieldValue.delete(),
          lastAiErrorAt: admin.firestore.FieldValue.delete(),
          ...clearWorkerFields(),
        });
        processed++;
        if (result.isRelevant) passed++;
        else rejectedDocs.push(doc);
      } else if (error) {
        const currentAttempts = Number(doc.data()?.relevanceAttemptCount || 0);
        const nextAttempts = currentAttempts + 1;
        batch.update(doc.ref, buildRetryUpdate(
          'ai_error',
          'relevance',
          nextAttempts,
          error.message || 'Unknown relevance error',
        ));
        failed++;
      }
    }

    if (results.length > 0) {
      try {
        await batch.commit();
      } catch (batchErr: any) {
        // batch에 삭제된 문서가 포함된 경우(수동 초기화 후 등) 개별 업데이트로 폴백
        if (batchErr?.code === 5 || `${batchErr?.message || ''}`.includes('NOT_FOUND')) {
          console.warn('[RelevanceFilter] batch.commit NOT_FOUND → individual fallback');
          for (const { doc: d, result: r, aiRelevanceResult, priorityDecision, error: e } of results) {
            if (!r && !e) continue;
            try {
              if (r) {
                const aiConf = clampConfidence(aiRelevanceResult?.confidence ?? null);
                let basis: RelevanceBasis = 'ai';
                if (!aiRelevanceResult && !r.isRelevant && r.confidence === 0) basis = 'keyword_reject';
                else if (priorityDecision?.isPriority && aiRelevanceResult) basis = 'priority_source_override';
                else if (priorityDecision?.isPriority && !aiRelevanceResult) basis = 'priority_source_fallback';
                await d.ref.update({
                  status: r.isRelevant ? 'filtered' : 'rejected',
                  filteredAt: admin.firestore.FieldValue.serverTimestamp(),
                  relevanceBasis: basis,
                  relevanceReason: r.reason,
                  ...clearWorkerFields(),
                });
              } else if (e) {
                const attempts = Number(d.data()?.relevanceAttemptCount || 0) + 1;
                await d.ref.update(buildRetryUpdate('ai_error', 'relevance', attempts, e.message || 'Unknown error'));
              }
            } catch (indErr: any) {
              if (indErr?.code !== 5 && !`${indErr?.message || ''}`.includes('NOT_FOUND')) {
                console.warn(`[RelevanceFilter] fallback update failed for ${d.id}:`, indErr.message);
              }
              // NOT_FOUND → 이미 삭제된 문서, 무시
            }
          }
        } else {
          throw batchErr;
        }
      }
    }
    if (rejectedDocs.length > 0) await syncArticlesToDedup(rejectedDocs, 'rejected');
    if (i + parallelLimit < articles.length) {
      // 배치 간 최소 지연으로 GLM API rate limit 방지 (오류 시 2초, 정상 시 1초)
      const batchDelay = recentErrorCount > 0 ? 2000 : 1000;
      await new Promise(resolve => setTimeout(resolve, batchDelay));
    }
  }

  return { success: true, processed, passed, failed };
}

// ?????????????????????????????????????????
// Batch: Deep Analysis
// ?????????????????????????????????????????
export async function processDeepAnalysis(options?: {
  companyId?: string;
  pipelineRunId?: string;
  aiConfig: RuntimeAiConfig;
  abortChecker?: () => Promise<boolean>;
}) {
  const db = admin.firestore();
  // 속도보다 정확성 우선: 한 번에 10건씩만 클레임 (타임아웃 시 복구 빠름)
  const baseBatchSize = Math.min(10, options?.aiConfig.maxAnalysisBatch || 10);

  // Note: Stale article recovery is now handled at drainAiAnalysisQueue level
  // to avoid duplicate reads. See recoverStaleAiStageArticles() call in index.ts

  let queryRef: FirebaseFirestore.Query = db.collection('articles')
    .where('status', 'in', ['filtered', 'analysis_error']);
  if (options?.pipelineRunId) queryRef = queryRef.where('pipelineRunId', '==', options.pipelineRunId);

  const claimedArticles = await loadClaimableArticlesForStage(
    queryRef,
    'analyzing',
    baseBatchSize,
    '[DeepAnalysis] No filtered or retryable analysis articles found.',
    '[DeepAnalysis] No claimable articles found after lease/retry checks.',
  );

  if (claimedArticles.length === 0) {
    return { success: true, processed: 0 };
  }

  console.log(`[DeepAnalysis] Claimed ${claimedArticles.length} articles to analyze.`);

  let processed = 0;
  let failed = 0;

  // 순차 처리: GLM-4.7 /coding 엔드포인트 rate limit 대응
  // 동시 호출 1개 + 호출 간 2.5s 고정 딜레이 → 약 24 RPM (안전)
  const parallelLimit = 1;
  const ANALYSIS_CALL_DELAY_MS = 2500;

  const articles = (await Promise.all(claimedArticles.map(async (doc) => {
    const article = doc.data() as any;
    const priorityDecision = await getSourcePriorityDecision(article);
    return { doc, article, priorityDecision };
  }))).sort((a, b) => (b.priorityDecision.priority || 0) - (a.priorityDecision.priority || 0));

  for (let i = 0; i < articles.length; i += parallelLimit) {
    if (options?.abortChecker && await options.abortChecker()) {
      console.log(`[DeepAnalysis] Abort requested at batch ${i}/${articles.length}. Returning partial results.`);
      break;
    }

    const chunk = articles.slice(i, i + parallelLimit);
    const results = await Promise.all(chunk.map(async ({ doc, article, priorityDecision }) => {
      try {
        const publishedAtStr = article.publishedAt
          ? (article.publishedAt.toDate ? article.publishedAt.toDate().toISOString() : new Date(article.publishedAt).toISOString())
          : new Date().toISOString();
        const analysisAiConfig = resolveAiConfigForStage(options!.aiConfig, 'analysis');

        const analysisResult = await analyzeArticle(
          { title: article.title, content: article.content, source: article.source, url: article.url, publishedAt: publishedAtStr },
          analysisAiConfig,
          { companyId: article.companyId || options?.companyId, pipelineRunId: article.pipelineRunId || options?.pipelineRunId }
        );

        return { doc, analysisResult, priorityDecision, error: null };
      } catch (error) {
        registerAiRateLimit(error);
        console.error(`Failed to analyze article ${doc.id}:`, error);
        recordError();
        return { doc, analysisResult: null, priorityDecision, error };
      }
    }));

    const batch = db.batch();
    for (const { doc, analysisResult, priorityDecision, error } of results) {
      if (analysisResult) {
        const normalized = normalizeAnalysisResult(analysisResult);
        batch.update(doc.ref, {
          status: 'analyzed',
          analyzedAt: admin.firestore.FieldValue.serverTimestamp(),
          summary: normalized.summary,
          category: normalized.category,
          companies: normalized.companies,
          deal: normalized.deal,
          insights: normalized.insights,
          tags: normalized.tags,
          priorityAnalysis: priorityDecision?.isPriority || false,
          analysisPriority: priorityDecision?.priority || 0,
          priorityAnalysisReason: priorityDecision?.reason || null,
          analysisAttemptCount: admin.firestore.FieldValue.delete(),
          lastAiErrorStage: admin.firestore.FieldValue.delete(),
          lastAiError: admin.firestore.FieldValue.delete(),
          lastAiErrorAt: admin.firestore.FieldValue.delete(),
          ...clearWorkerFields(),
        });
        processed++;
      } else if (error) {
        const currentAttempts = Number(doc.data()?.analysisAttemptCount || 0);
        const nextAttempts = currentAttempts + 1;
        batch.update(doc.ref, buildRetryUpdate(
          'analysis_error',
          'analysis',
          nextAttempts,
          (error as any)?.message || 'Unknown analysis error',
        ));
        failed++;
      }
    }

    if (results.length > 0) {
      try {
        await batch.commit();
      } catch (batchErr: any) {
        if (batchErr?.code === 5 || `${batchErr?.message || ''}`.includes('NOT_FOUND')) {
          console.warn('[DeepAnalysis] batch.commit NOT_FOUND → individual fallback');
          for (const { doc, analysisResult, priorityDecision, error } of results) {
            try {
              if (analysisResult) {
                const normalized = normalizeAnalysisResult(analysisResult);
                await doc.ref.update({
                  status: 'analyzed',
                  analyzedAt: admin.firestore.FieldValue.serverTimestamp(),
                  summary: normalized.summary,
                  category: normalized.category,
                  companies: normalized.companies,
                  deal: normalized.deal,
                  insights: normalized.insights,
                  tags: normalized.tags,
                  priorityAnalysis: priorityDecision?.isPriority || false,
                  analysisPriority: priorityDecision?.priority || 0,
                  priorityAnalysisReason: priorityDecision?.reason || null,
                  analysisAttemptCount: admin.firestore.FieldValue.delete(),
                  lastAiErrorStage: admin.firestore.FieldValue.delete(),
                  lastAiError: admin.firestore.FieldValue.delete(),
                  lastAiErrorAt: admin.firestore.FieldValue.delete(),
                  ...clearWorkerFields(),
                });
              } else if (error) {
                const currentAttempts = Number(doc.data()?.analysisAttemptCount || 0);
                await doc.ref.update(buildRetryUpdate(
                  'analysis_error',
                  'analysis',
                  currentAttempts + 1,
                  (error as any)?.message || 'Unknown analysis error',
                ));
              }
            } catch (indErr: any) {
              if (indErr?.code !== 5 && !`${indErr?.message || ''}`.includes('NOT_FOUND')) {
                console.warn(`[DeepAnalysis] individual update failed for ${doc.id}:`, indErr.message);
              }
              // NOT_FOUND → doc was deleted, skip silently
            }
          }
        } else {
          throw batchErr;
        }
      }
    }
    // 다음 기사 전 고정 딜레이 (오류 여부와 무관하게 항상 대기)
    if (i + parallelLimit < articles.length) {
      const delay = recentErrorCount > 0 ? ANALYSIS_CALL_DELAY_MS * 2 : ANALYSIS_CALL_DELAY_MS;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return { success: true, processed, failed };
}

