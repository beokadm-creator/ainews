import * as logger from 'firebase-functions/logger';
// v2026-04-16
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { throwSafeError } from './utils/safeError';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { setGlobalOptions } from 'firebase-functions/v2';


setGlobalOptions({
  region: 'us-central1',
  maxInstances: 0,
  concurrency: 1,
  cpu: 'gcf_gen1',
  memory: '256MiB',
  invoker: 'public',
});
import * as admin from 'firebase-admin';
import axios from 'axios';
import { randomBytes } from 'crypto';
import { processRssSources } from './services/rssService';
import { checkRelevance, processRelevanceFiltering, processDeepAnalysis, analyzeArticle, testAiProviderConnection } from './services/aiService';
import { createDailyBriefing, generateCustomReport } from './services/briefingService';
import { sendBriefingEmails, sendOutputEmails, verifyUnsubscribeToken, generateUnsubscribeToken } from './services/emailService';
import { buildOutputAssetBundle, buildOutputHtmlAsset, buildSharedReportPage } from './services/reportAssetService';
import { sendBriefingToTelegram, sendTrackedCompanyTelegramAlert } from './services/telegramService';
import { processApiSources } from './services/apiSourceService';
import { processScrapingSources } from './services/scrapingSourceService';
import { processPuppeteerSources } from './services/puppeteerSourceService';
import { purgeRejectedArticlesPreservingDedupe, syncArticlesToDedup } from './services/articleDedupService';
import { hashTitle, calculateTokenSimilarity } from './services/duplicateService';
import { ensureCollectionsExist } from './utils/firestoreValidation';
import { requireAdmin } from './utils/authMiddleware';
import { seedPromptTemplates } from './seed/promptTemplates';
import { assertCompanyAccess, getCompanyRuntimeConfig } from './services/runtimeConfigService';
import { PipelineInvocationOverrides, RuntimeAiConfig, AiProvider, PROVIDER_DEFAULTS, RuntimePipelineConfig } from './types/runtime';
import { saveApiKeyForCompany } from './utils/secretManager';
import { seedGlobalSources, testGlobalSource as runGlobalSourceTest } from './services/globalSourceService';
import { getGlobalKeywordConfig, saveGlobalKeywordConfig, seedGlobalKeywordsIfEmpty, invalidateKeywordCache } from './services/globalKeywordService';
import { recordMetric } from './services/metricsService';
import { DEFAULT_TRACKED_COMPANIES } from './services/trackedCompanyConfig';
admin.initializeApp();

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Log critical error to firestore without blocking
  try {
    admin.firestore().collection('systemLogs').add({
      type: 'unhandledRejection',
      reason: String(reason),
      stack: reason instanceof Error ? reason.stack : null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  } catch (e) {
    logger.error('Failed to log unhandledRejection to firestore:', e);
  }
});

// ─── Module-level source ID cache (mirrors globalKeywordService pattern) ─────
let cachedActiveSourceIds: string[] | null = null;
let sourceCacheExpiresAt = 0;
const SOURCE_CACHE_TTL_MS = 5 * 60 * 1000;

async function getActiveSourceIds(): Promise<string[]> {
  const now = Date.now();
  if (cachedActiveSourceIds !== null && now < sourceCacheExpiresAt) return cachedActiveSourceIds;
  const snap = await admin.firestore().collection('globalSources').where('status', '==', 'active').get();
  cachedActiveSourceIds = snap.docs.map((doc: any) => doc.id);
  sourceCacheExpiresAt = Date.now() + SOURCE_CACHE_TTL_MS;
  return cachedActiveSourceIds || [];
}

function invalidateSourceCache() {
  cachedActiveSourceIds = null;
  sourceCacheExpiresAt = 0;
}

function invalidatePipelineCountsCache() {
  _pipelineCountsCache = null;
}
admin.firestore().settings({ ignoreUndefinedProperties: true });
// Seeding (?꾩슂 ???섎룞 ?ㅽ뻾 ?먮뒗 蹂꾨룄 ?몃━嫄곕줈 ?대룞 沅뚯옣)
// ensureCollectionsExist().catch(console.error);
// seedPromptTemplates().catch(err => {
//   logger.warn('Failed to seed prompt templates:', err);
// });
// seedGlobalSources().catch(err => {
//   logger.warn('Failed to seed global sources:', err);
// });
// ?????????????????????????????????????????
// Helpers
// ?????????????????????????????????????????
async function getPrimaryCompanyId(uid: string): Promise<string> {
  const userDoc = await admin.firestore().collection('users').doc(uid).get();
  if (!userDoc.exists) {
    throw new HttpsError('permission-denied', 'User record not found');
  }
  const userData = userDoc.data() as {
    companyIds?: string[];
    managedCompanyIds?: string[];
    companyId?: string;
  };
  const companyId = userData.companyIds?.[0] || userData.managedCompanyIds?.[0] || userData.companyId;
  if (!companyId) {
    throw new HttpsError('permission-denied', 'No company assigned to user');
  }
  return companyId;
}
async function resolveRuntime(uid: string, companyId?: string, overrides?: PipelineInvocationOverrides) {
  const resolvedCompanyId = companyId || await getPrimaryCompanyId(uid);
  await assertCompanyAccess(uid, resolvedCompanyId);
  return getCompanyRuntimeConfig(resolvedCompanyId, overrides);
}

type ManagedReportMode = 'internal' | 'external';

interface ManagedReportFilters {
  sourceIds?: string[];
  keywords?: string[];
  datePreset?: '24h' | '3d' | '7d' | '15d' | '30d';
  startDate?: string | null;
  endDate?: string | null;
  limit?: number;
}

interface CompanyReportPromptSettings {
  internalPrompt: string;
  externalPrompt: string;
  companyName: string | null;
  publisherName: string | null;
  internalTemplateOutputId?: string | null;
  externalTemplateOutputId?: string | null;
}

interface ManagedReportSourceDefinition {
  id: string;
  name: string;
  pool: Set<string>;
}

interface ManagedReportArticleLoadResult {
  articles: any[];
  matchedSourceNames: string[];
  sourceCoverage: Array<{
    sourceId: string;
    sourceName: string;
    articleCount: number;
  }>;
}

function getPresetWindowHours(datePreset?: ManagedReportFilters['datePreset']) {
  switch (datePreset) {
    case '3d': return 72;
    case '7d': return 168;
    case '15d': return 360;
    case '30d': return 720;
    case '24h':
    default:
      return 24;
  }
}

function parseKstDateInput(value?: string | null, fallback?: Date) {
  if (!value) return fallback || null;

  const raw = `${value}`.trim();
  if (!raw) return fallback || null;

  let parsed: Date | null = null;

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) {
    parsed = new Date(`${raw}:00+09:00`);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    parsed = new Date(`${raw}T00:00:00+09:00`);
  } else {
    parsed = new Date(raw);
  }

  if (!parsed || Number.isNaN(parsed.getTime())) {
    return fallback || null;
  }

  return parsed;
}

function getManagedReportWindow(filters?: ManagedReportFilters) {
  const now = new Date();
  const fallbackStart = new Date(now.getTime() - getPresetWindowHours(filters?.datePreset) * 60 * 60 * 1000);
  const parsedStart = parseKstDateInput(filters?.startDate, fallbackStart) || fallbackStart;
  const parsedEnd = parseKstDateInput(filters?.endDate, now) || now;

  return {
    startDate: Number.isNaN(parsedStart.getTime()) ? fallbackStart : parsedStart,
    endDate: Number.isNaN(parsedEnd.getTime()) ? now : parsedEnd,
  };
}

function normalizeSourceIdentity(value?: string) {
  return `${value || ''}`
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function getSourceIdentityAliases(value?: string) {
  const normalized = normalizeSourceIdentity(value);
  const aliases = new Set<string>();
  if (!normalized) return aliases;

  aliases.add(normalized);

  if (normalized === '3syjizr4ih9bluozttba') {
    aliases.add('thebell');
    aliases.add('?붾꺼');
  }

  if (normalized.includes('thebell') || normalized.includes('?붾꺼')) {
    aliases.add('thebell');
    aliases.add('?붾꺼');
  }

  if (normalized.includes('marketinsight') || normalized.includes('留덉폆?몄궗?댄듃')) {
    aliases.add('marketinsight');
    aliases.add('留덉폆?몄궗?댄듃');
  }

  if (normalized.includes('navernews') || normalized.includes('네이버뉴스')) {
    aliases.add('navernews');
    aliases.add('네이버뉴스');
  }

  return aliases;
}

function buildSourceIdentityPool(source: any) {
  const pool = new Set<string>();
  [source?.id, source?.localScraperId, source?.name, source?.url].forEach((value) => {
    getSourceIdentityAliases(value).forEach((alias) => pool.add(alias));
  });
  return pool;
}

function buildArticleIdentityPool(article: any) {
  const pool = new Set<string>();
  [article?.globalSourceId, article?.sourceId, article?.source, article?.publisher, article?.pressName, article?.sourceName].forEach((value) => {
    getSourceIdentityAliases(value).forEach((alias) => pool.add(alias));
  });
  return pool;
}

function articleMatchesSourcePool(article: any, allowedPool: Set<string>) {
  if (allowedPool.size === 0) return true;
  for (const key of buildArticleIdentityPool(article)) {
    if (allowedPool.has(key)) return true;
  }
  return false;
}

function matchArticleToSources(article: any, sources: ManagedReportSourceDefinition[]) {
  if (sources.length === 0) return [];
  const articlePool = buildArticleIdentityPool(article);
  return sources
    .filter((source) => {
      for (const alias of articlePool) {
        if (source.pool.has(alias)) return true;
      }
      return false;
    })
    .map((source) => source.id);
}

// Cloud Function 타임아웃(540s) 이내에 안전하게 종료: 7분 예산
const DRAIN_BUDGET_MS = 7 * 60 * 1000;

async function drainAiAnalysisQueue(aiConfig: RuntimeAiConfig, companyId?: string) {
  // Quick existence check: skip heavy processing if nothing to do
  const db = admin.firestore();
  const [pendingSnap, filteredSnap] = await Promise.all([
    db.collection('articles').where('status', '==', 'pending').limit(1).get(),
    db.collection('articles').where('status', '==', 'filtered').limit(1).get(),
  ]);
  if (pendingSnap.empty && filteredSnap.empty) {
    logger.info('[drainQueue] No pending/filtered articles — skipping analysis cycle');
    return { totalFiltered: 0, totalAnalyzed: 0 };
  }

  let totalFiltered = 0;
  let totalAnalyzed = 0;
  const maxRounds = 20;
  const startTime = Date.now();

  for (let round = 0; round < maxRounds; round++) {
    if (Date.now() - startTime > DRAIN_BUDGET_MS) {
      logger.info(`[drainQueue] 7분 시간 예산 초과 → round ${round}에서 정상 종료`);
      break;
    }

    const filteringStartedAt = Date.now();
    const filteringResult = await processRelevanceFiltering({ companyId, aiConfig });
    const filteredThisRound = Number(filteringResult?.processed || 0);
    totalFiltered += filteredThisRound;

    // Invalidate pipeline counts cache after processing articles
    if (filteredThisRound > 0) {
      invalidatePipelineCountsCache();
    }
    if (filteredThisRound > 0) {
      logger.info(`[drainQueue] round=${round} filtered=${filteredThisRound} passed=${Number(filteringResult?.passed || 0)} failed=${Number(filteringResult?.failed || 0)}`);
      recordMetric({
        stage: 'pipeline',
        action: 'continuous_filtering_round',
        count: filteredThisRound,
        duration: Date.now() - filteringStartedAt,
        success: true,
        metadata: {
          companyId: companyId || null,
          provider: aiConfig.provider,
          model: aiConfig.model,
          round,
          passed: Number(filteringResult?.passed || 0),
          failed: Number(filteringResult?.failed || 0),
        },
      }).catch(() => {});
    }

    const analysisStartedAt = Date.now();
    const analysisResult = await processDeepAnalysis({ companyId, aiConfig });
    const analyzedThisRound = Number(analysisResult?.processed || 0);
    totalAnalyzed += analyzedThisRound;

    // Invalidate pipeline counts cache after processing articles
    if (analyzedThisRound > 0) {
      invalidatePipelineCountsCache();
    }
    if (analyzedThisRound > 0) {
      logger.info(`[drainQueue] round=${round} analyzed=${analyzedThisRound} failed=${Number(analysisResult?.failed || 0)}`);
      recordMetric({
        stage: 'pipeline',
        action: 'continuous_analysis_round',
        count: analyzedThisRound,
        duration: Date.now() - analysisStartedAt,
        success: true,
        metadata: {
          companyId: companyId || null,
          provider: aiConfig.provider,
          model: aiConfig.model,
          round,
          failed: Number(analysisResult?.failed || 0),
        },
      }).catch(() => {});
    }

    if (filteredThisRound === 0 && analyzedThisRound === 0) break;
  }

  return { totalFiltered, totalAnalyzed };
}

// 워커 리스: Cloud Function 타임아웃 540s(9분) 이내에 drainQueue가 정상 종료됨
// → 8분으로 단축해 비정상 종료 시에도 빠르게 다음 워커가 인계
const CONTINUOUS_COLLECTION_LOCK_MS = 8 * 60 * 1000;
const CONTINUOUS_ANALYSIS_LOCK_MS = 8 * 60 * 1000;
const CONTINUOUS_PREMIUM_COLLECTION_LOCK_MS = 10 * 60 * 1000;

// Instance-level cache for system AI config (avoids 3 Firestore reads per scheduled invocation)
let _sysAiConfigCache: { data: { aiConfig: RuntimeAiConfig; companyId: string }; expiresAt: number } | null = null;
const SYS_AI_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;

// Instance-level cache for article pipeline counts (avoids 9 count() queries per scheduled invocation)
let _pipelineCountsCache: { data: Record<string, number>; expiresAt: number } | null = null;
const PIPELINE_COUNTS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes to significantly reduce full-collection count() query costs

async function withWorkerLease<T>(
  workerId: string,
  leaseMs: number,
  fn: () => Promise<T>,
): Promise<{ executed: boolean; result?: T }> {
  const db = admin.firestore();
  const leaseRef = db.collection('systemRuntime').doc(`worker_${workerId}`);
  const now = Date.now();
  const leaseUntil = admin.firestore.Timestamp.fromMillis(now + leaseMs);

  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(leaseRef);
    const data = snap.data() as any;
    const activeLease = data?.leaseUntil?.toDate
      ? data.leaseUntil.toDate()
      : (data?.leaseUntil ? new Date(data.leaseUntil) : null);

    if (activeLease && !Number.isNaN(activeLease.getTime()) && activeLease.getTime() > now) {
      return false;
    }

    tx.set(leaseRef, {
      workerId,
      status: 'running',
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      leaseUntil,
    }, { merge: true });

    return true;
  });

  if (!claimed) {
    return { executed: false };
  }

  // Heartbeat to prevent deadlocks during long-running tasks
  const heartbeatInterval = setInterval(async () => {
    try {
      await leaseRef.update({
        leaseUntil: admin.firestore.Timestamp.fromMillis(Date.now() + leaseMs),
        lastHeartbeatAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      logger.error(`Heartbeat failed for worker ${workerId}:`, e);
    }
  }, Math.min(leaseMs / 2, 60000)); // Every 1 minute or half lease time

  try {
    const result = await fn();
    clearInterval(heartbeatInterval);
    await leaseRef.set({
      workerId,
      status: 'idle',
      lastSuccessAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      leaseUntil: admin.firestore.FieldValue.delete(),
      lastError: admin.firestore.FieldValue.delete(),
      lastErrorAt: admin.firestore.FieldValue.delete(),
    }, { merge: true });
    return { executed: true, result };
  } catch (error: any) {
    clearInterval(heartbeatInterval);
    await leaseRef.set({
      workerId,
      status: 'error',
      lastErrorAt: admin.firestore.FieldValue.serverTimestamp(),
      lastError: error?.message || 'Unknown worker error',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      leaseUntil: admin.firestore.FieldValue.delete(),
    }, { merge: true }).catch(() => {});
    throw error;
  }
}

async function getContinuousCollectionContext(aiConfig: RuntimeAiConfig, companyId?: string) {
  const activeSourceIds = await getActiveSourceIds();

  return {
    companyId,
    aiConfig,
    filters: {
      sourceIds: activeSourceIds,
      dateRange: { mode: 'relative_days' as const, days: 2 },
    },
  };
}

async function runContinuousCollectionCycle(aiConfig: RuntimeAiConfig, companyId?: string) {
  const context = await getContinuousCollectionContext(aiConfig, companyId);
  const [rssResult, apiResult, scrapingResult] = await Promise.allSettled([
    processRssSources(context),
    processApiSources(context),
    processScrapingSources(context),
  ]);

  const totalCollected =
    (rssResult.status === 'fulfilled' ? (rssResult.value as any)?.totalCollected || 0 : 0) +
    (apiResult.status === 'fulfilled' ? (apiResult.value as any)?.totalCollected || 0 : 0) +
    (scrapingResult.status === 'fulfilled' ? (scrapingResult.value as any)?.totalCollected || 0 : 0);

  if (rssResult.status === 'rejected') logger.error('[ContinuousCollection] RSS error:', rssResult.reason);
  if (apiResult.status === 'rejected') logger.error('[ContinuousCollection] API error:', apiResult.reason);
  if (scrapingResult.status === 'rejected') logger.error('[ContinuousCollection] Scraping error:', scrapingResult.reason);

  return { totalCollected };
}

async function runContinuousPremiumCollectionCycle(aiConfig: RuntimeAiConfig, companyId?: string) {
  const context = await getContinuousCollectionContext(aiConfig, companyId);
  try {
    const result = await processPuppeteerSources(context);
    return { totalCollected: Number(result?.totalCollected || 0) };
  } catch (error) {
    logger.error('[ContinuousPremiumCollection] Puppeteer error:', error);
    throw error;
  }
}

async function runContinuousAnalysisCycle(aiConfig: RuntimeAiConfig, companyId?: string) {
  return drainAiAnalysisQueue(aiConfig, companyId);
}

async function runContinuousCollectionWorker(aiConfig: RuntimeAiConfig, companyId?: string) {
  const lease = await withWorkerLease('continuous-collection', CONTINUOUS_COLLECTION_LOCK_MS, async () => {
    return runContinuousCollectionCycle(aiConfig, companyId);
  });

  if (!lease.executed) {
    return { skipped: true, totalCollected: 0 };
  }

  return {
    skipped: false,
    ...(lease.result || { totalCollected: 0 }),
  };
}

async function runContinuousAnalysisWorker(aiConfig: RuntimeAiConfig, companyId?: string) {
  const lease = await withWorkerLease('continuous-analysis', CONTINUOUS_ANALYSIS_LOCK_MS, async () => {
    return runContinuousAnalysisCycle(aiConfig, companyId);
  });

  if (!lease.executed) {
    return { skipped: true, totalFiltered: 0, totalAnalyzed: 0 };
  }

  return {
    skipped: false,
    ...(lease.result || { totalFiltered: 0, totalAnalyzed: 0 }),
  };
}

async function runContinuousPremiumCollectionWorker(aiConfig: RuntimeAiConfig, companyId?: string) {
  const lease = await withWorkerLease('continuous-premium-collection', CONTINUOUS_PREMIUM_COLLECTION_LOCK_MS, async () => {
    return runContinuousPremiumCollectionCycle(aiConfig, companyId);
  });

  if (!lease.executed) {
    return { skipped: true, totalCollected: 0 };
  }

  return {
    skipped: false,
    ...(lease.result || { totalCollected: 0 }),
  };
}

async function getArticlePipelineCounts() {
  const now = Date.now();
  if (_pipelineCountsCache && _pipelineCountsCache.expiresAt > now) {
    return _pipelineCountsCache.data;
  }

  const db = admin.firestore();
  
  // 글로벌 캐시 조회 (서로 다른 Cloud Function 인스턴스간 중복 카운트 방지)
  const pipelineDoc = await db.collection('systemRuntime').doc('continuousPipeline').get();
  if (pipelineDoc.exists) {
    const data = pipelineDoc.data() as any;
    if (data.articleCounts && data.articleCountsUpdatedAt) {
      const updatedAtMs = data.articleCountsUpdatedAt.toDate 
        ? data.articleCountsUpdatedAt.toDate().getTime() 
        : new Date(data.articleCountsUpdatedAt).getTime();
      
      if (now - updatedAtMs < PIPELINE_COUNTS_CACHE_TTL_MS) {
        _pipelineCountsCache = { data: data.articleCounts, expiresAt: now + PIPELINE_COUNTS_CACHE_TTL_MS };
        return data.articleCounts;
      }
    }
  }

  const [pending, filtering, filtered, analyzing, analyzed, published, rejected, aiError, analysisError] = await Promise.all([
    db.collection('articles').where('status', '==', 'pending').count().get(),
    db.collection('articles').where('status', '==', 'filtering').count().get(),
    db.collection('articles').where('status', '==', 'filtered').count().get(),
    db.collection('articles').where('status', '==', 'analyzing').count().get(),
    db.collection('articles').where('status', '==', 'analyzed').count().get(),
    db.collection('articles').where('status', '==', 'published').count().get(),
    db.collection('articles').where('status', '==', 'rejected').count().get(),
    db.collection('articles').where('status', '==', 'ai_error').count().get(),
    db.collection('articles').where('status', '==', 'analysis_error').count().get(),
  ]);

  const counts = {
    pending: pending.data().count,
    filtering: filtering.data().count,
    filtered: filtered.data().count,
    analyzing: analyzing.data().count,
    analyzed: analyzed.data().count,
    published: published.data().count,
    rejected: rejected.data().count,
    aiError: aiError.data().count,
    analysisError: analysisError.data().count,
  };

  _pipelineCountsCache = { data: counts, expiresAt: now + PIPELINE_COUNTS_CACHE_TTL_MS };
  
  // 새롭게 계산된 경우 글로벌 캐시 시간도 갱신
  await db.collection('systemRuntime').doc('continuousPipeline').set({
    articleCounts: counts,
    articleCountsUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  return counts;
}

async function updateContinuousPipelineRuntime(payload: Record<string, any>) {
  const counts = await getArticlePipelineCounts();
  await admin.firestore().collection('systemRuntime').doc('continuousPipeline').set({
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...payload,
  }, { merge: true });
  return counts;
}

// force=true: 수동 리셋 시 아티클 레벨 리스 만료 여부 무관하게 모두 복구
async function recoverStaleAiStageArticles(force = false) {
  const db = admin.firestore();
  const now = Date.now();
  let recoveredFiltering = 0;
  let recoveredAnalyzing = 0;

  const [filteringSnap, analyzingSnap] = await Promise.all([
    db.collection('articles').where('status', '==', 'filtering').limit(200).get(),
    db.collection('articles').where('status', '==', 'analyzing').limit(200).get(),
  ]);

  const batch = db.batch();

  for (const doc of filteringSnap.docs) {
    if (!force) {
      const data = doc.data() as any;
      const leaseUntil = data?.workerLeaseUntil?.toDate
        ? data.workerLeaseUntil.toDate()
        : (data?.workerLeaseUntil ? new Date(data.workerLeaseUntil) : null);
      const isExpired = !leaseUntil || Number.isNaN(leaseUntil.getTime()) || leaseUntil.getTime() <= now;
      if (!isExpired) continue;
    }
    batch.set(doc.ref, {
      status: 'pending',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      workerStage: admin.firestore.FieldValue.delete(),
      workerLeaseUntil: admin.firestore.FieldValue.delete(),
      nextAiAttemptAt: admin.firestore.FieldValue.delete(),
    }, { merge: true });
    recoveredFiltering += 1;
  }

  for (const doc of analyzingSnap.docs) {
    if (!force) {
      const data = doc.data() as any;
      const leaseUntil = data?.workerLeaseUntil?.toDate
        ? data.workerLeaseUntil.toDate()
        : (data?.workerLeaseUntil ? new Date(data.workerLeaseUntil) : null);
      const isExpired = !leaseUntil || Number.isNaN(leaseUntil.getTime()) || leaseUntil.getTime() <= now;
      if (!isExpired) continue;
    }
    batch.set(doc.ref, {
      status: 'filtered',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      workerStage: admin.firestore.FieldValue.delete(),
      workerLeaseUntil: admin.firestore.FieldValue.delete(),
      nextAiAttemptAt: admin.firestore.FieldValue.delete(),
    }, { merge: true });
    recoveredAnalyzing += 1;
  }

  if (recoveredFiltering > 0 || recoveredAnalyzing > 0) {
    await batch.commit();
    logger.info(`[RecoverStale] filtering→pending: ${recoveredFiltering}, analyzing→filtered: ${recoveredAnalyzing} (force=${force})`);
  }

  return { recoveredFiltering, recoveredAnalyzing };
}

async function requireSuperadminUid(uid: string) {
  const userDoc = await admin.firestore().collection('users').doc(uid).get();
  if (userDoc.data()?.role !== 'superadmin') {
    throw new HttpsError('permission-denied', 'Superadmin required');
  }
}

async function runContinuousPipelineCycle() {
  const { aiConfig, companyId } = await getSystemAiConfig();

  // 수집과 분석을 병렬 실행: 각자 독립 리스를 사용하므로 충돌 없음
  // 순차 실행 시 수집이 오래 걸리면 분석이 타임아웃에 밀리는 문제 해결
  const [collection, analysis] = await Promise.all([
    runContinuousCollectionWorker(aiConfig, companyId),
    runContinuousAnalysisWorker(aiConfig, companyId),
  ]);

  const counts = await updateContinuousPipelineRuntime({
    lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
    totalCollected: collection.totalCollected,
    totalFiltered: analysis.totalFiltered,
    totalAnalyzed: analysis.totalAnalyzed,
    collectionSkipped: collection.skipped,
    analysisSkipped: analysis.skipped,
  });

  return {
    ...collection,
    ...analysis,
    articleCounts: counts,
    companyId,
    provider: aiConfig.provider,
    model: aiConfig.model,
  };
}

type PipelineStepStatus = 'running' | 'completed' | 'failed' | 'skipped' | 'aborted';

async function updatePipelineStep(
  pipelineRef: FirebaseFirestore.DocumentReference | null,
  step: 'collection' | 'filtering' | 'analysis' | 'output',
  status: PipelineStepStatus,
  result?: any,
) {
  if (!pipelineRef) return;

  await pipelineRef.set({
    steps: {
      [step]: {
        status,
        completedAt: status === 'running' ? null : admin.firestore.FieldValue.serverTimestamp(),
        ...(result ? { result } : {}),
      },
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

async function collectArticlesOnce(options: {
  companyId?: string;
  pipelineRunId?: string;
  filters: any;
  aiConfig: RuntimeAiConfig;
  logPrefix?: string;
}) {
  const context = {
    companyId: options.companyId,
    pipelineRunId: options.pipelineRunId,
    filters: options.filters,
    aiConfig: options.aiConfig,
  };

  const [rssResult, apiResult, scrapingResult, puppeteerResult] = await Promise.allSettled([
    processRssSources(context),
    processApiSources(context),
    processScrapingSources(context),
    processPuppeteerSources(context),
  ]);

  const totalCollected =
    (rssResult.status === 'fulfilled' ? (rssResult.value as any)?.totalCollected || 0 : 0) +
    (apiResult.status === 'fulfilled' ? (apiResult.value as any)?.totalCollected || 0 : 0) +
    (scrapingResult.status === 'fulfilled' ? (scrapingResult.value as any)?.totalCollected || 0 : 0) +
    (puppeteerResult.status === 'fulfilled' ? (puppeteerResult.value as any)?.totalCollected || 0 : 0);

  const logPrefix = options.logPrefix || '[Pipeline]';
  if (rssResult.status === 'rejected') logger.error(`${logPrefix} RSS error:`, rssResult.reason);
  if (apiResult.status === 'rejected') logger.error(`${logPrefix} API error:`, apiResult.reason);
  if (scrapingResult.status === 'rejected') logger.error(`${logPrefix} Scraping error:`, scrapingResult.reason);
  if (puppeteerResult.status === 'rejected') logger.error(`${logPrefix} Puppeteer error:`, puppeteerResult.reason);

  return {
    totalCollected,
    rss: rssResult.status === 'fulfilled' ? rssResult.value : null,
    api: apiResult.status === 'fulfilled' ? apiResult.value : null,
    scraping: scrapingResult.status === 'fulfilled' ? scrapingResult.value : null,
    puppeteer: puppeteerResult.status === 'fulfilled' ? puppeteerResult.value : null,
  };
}

async function executePipelineRun(options: {
  runtime: RuntimePipelineConfig;
  pipelineRef?: FirebaseFirestore.DocumentReference | null;
  pipelineRunId?: string;
  includeOutput?: boolean;
}) {
  const pipelineRef = options.pipelineRef || null;
  const runtime = options.runtime;

  if (pipelineRef) {
    await pipelineRef.set({
      status: 'running',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  try {
    await updatePipelineStep(pipelineRef, 'collection', 'running');
    const collectionStartedAt = Date.now();
    const collection = await collectArticlesOnce({
      companyId: runtime.companyId,
      pipelineRunId: options.pipelineRunId,
      filters: runtime.filters,
      aiConfig: runtime.ai,
      logPrefix: '[PipelineRun]',
    });
    await updatePipelineStep(pipelineRef, 'collection', 'completed', {
      duration: Date.now() - collectionStartedAt,
      ...collection,
    });

    await updatePipelineStep(pipelineRef, 'filtering', 'running');
    const filteringStartedAt = Date.now();
    const filteringResult = await processRelevanceFiltering({
      companyId: runtime.companyId,
      pipelineRunId: options.pipelineRunId,
      aiConfig: runtime.ai,
      filters: runtime.filters,
    });
    await updatePipelineStep(pipelineRef, 'filtering', 'completed', {
      duration: Date.now() - filteringStartedAt,
      ...(filteringResult || {}),
    });

    // Invalidate pipeline counts cache after filtering articles
    if (filteringResult?.processed && filteringResult.processed > 0) {
      invalidatePipelineCountsCache();
    }

    await updatePipelineStep(pipelineRef, 'analysis', 'running');
    const analysisStartedAt = Date.now();
    const analysisResult = await processDeepAnalysis({
      companyId: runtime.companyId,
      pipelineRunId: options.pipelineRunId,
      aiConfig: runtime.ai,
    });
    await updatePipelineStep(pipelineRef, 'analysis', 'completed', {
      duration: Date.now() - analysisStartedAt,
      ...(analysisResult || {}),
    });

    // Invalidate pipeline counts cache after analysis
    if (analysisResult?.processed && analysisResult.processed > 0) {
      invalidatePipelineCountsCache();
    }

    let outputResult: any = null;
    if (options.includeOutput !== false) {
      await updatePipelineStep(pipelineRef, 'output', 'running');
      const outputStartedAt = Date.now();
      outputResult = await createDailyBriefing({
        companyId: runtime.companyId,
        pipelineRunId: options.pipelineRunId,
        aiConfig: runtime.ai,
        outputConfig: runtime.output,
        timezone: runtime.timezone,
      });
      await updatePipelineStep(pipelineRef, 'output', outputResult.success ? 'completed' : 'failed', {
        duration: Date.now() - outputStartedAt,
        ...outputResult,
      });
    } else {
      await updatePipelineStep(pipelineRef, 'output', 'skipped', {
        reason: 'Continuous pipeline does not generate outputs in this cycle.',
      });
    }

    const result = {
      totalCollected: collection.totalCollected,
      totalFiltered: Number(filteringResult?.processed || 0),
      totalAnalyzed: Number(analysisResult?.processed || 0),
      output: outputResult,
    };

    if (pipelineRef) {
      await pipelineRef.set({
        status: outputResult && outputResult.success === false ? 'failed' : 'completed',
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        result,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    return result;
  } catch (error: any) {
    if (pipelineRef) {
      await pipelineRef.set({
        status: 'failed',
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        error: error.message || String(error),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true }).catch(() => {});
    }
    throw error;
  }
}

const SOURCE_BATCH_LIMIT = 30;

function chunkItems<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function fetchGlobalSourcesByIds(db: admin.firestore.Firestore, sourceIds: string[]) {
  if (!sourceIds.length) return [];

  const snapshots = await Promise.all(
    chunkItems(sourceIds, SOURCE_BATCH_LIMIT).map((batch) =>
      db.collection('globalSources')
        .where(admin.firestore.FieldPath.documentId(), 'in', batch)
        .get(),
    ),
  );

  return snapshots.flatMap((snap) => snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as any) })));
}

async function loadAccessibleArticlesForManagedReport(
  companyId: string,
  filters?: ManagedReportFilters,
): Promise<ManagedReportArticleLoadResult> {
  const db = admin.firestore();
  const subDoc = await db.collection('companySourceSubscriptions').doc(companyId).get();
  const subscribedSourceIds: string[] = subDoc.exists
    ? ((subDoc.data() as any).subscribedSourceIds || [])
    : [];

  if (subscribedSourceIds.length === 0) {
    return { articles: [], matchedSourceNames: [], sourceCoverage: [] };
  }

  const requestedSourceIds = Array.isArray(filters?.sourceIds) && filters?.sourceIds.length > 0
    ? filters!.sourceIds!.filter((id) => subscribedSourceIds.includes(id))
    : subscribedSourceIds;

  if (requestedSourceIds.length === 0) {
    return { articles: [], matchedSourceNames: [], sourceCoverage: [] };
  }

  const requestedSources = await fetchGlobalSourcesByIds(db, requestedSourceIds);

  const requestedSourceDefinitions: ManagedReportSourceDefinition[] = requestedSources.map((source) => ({
    id: source.id,
    name: source.name || source.id,
    pool: buildSourceIdentityPool(source),
  }));
  const requestedSourcePool = new Set<string>();
  requestedSourceDefinitions.forEach((source) => {
    source.pool.forEach((key) => requestedSourcePool.add(key));
  });

  const { startDate, endDate } = getManagedReportWindow(filters);
  const keywordPool = (filters?.keywords || [])
    .map((keyword) => `${keyword || ''}`.trim().toLowerCase())
    .filter(Boolean);
  const targetLimit = Math.min(filters?.limit || 120, 200);
  const perStatusLimit = Math.min(Math.max(targetLimit * 2, 120), 300);
  const matchedArticles: any[] = [];
  const seenArticleIds = new Set<string>();
  const sourceCoverage = new Map<string, number>();
  const snaps = await Promise.all(
    ['analyzed', 'published'].map((status) =>
      db.collection('articles')
        .where('status', '==', status)
        .where('publishedAt', '>=', startDate)
        .where('publishedAt', '<=', endDate)
        .orderBy('publishedAt', 'desc')
        .limit(perStatusLimit)
        .get(),
    ),
  );

  for (const snap of snaps) {
    for (const doc of snap.docs) {
      const article: any = { id: doc.id, ...(doc.data() as any) };
      if (seenArticleIds.has(article.id)) continue;
      if (!articleMatchesSourcePool(article, requestedSourcePool)) continue;

      if (keywordPool.length > 0) {
        const haystack = [
          article.title || '',
          article.content || '',
          ...(article.summary || []),
          ...(article.tags || []),
        ].join(' ').toLowerCase();
        if (!keywordPool.some((keyword) => haystack.includes(keyword))) {
          continue;
        }
      }

      const matchedSourceIds = matchArticleToSources(article, requestedSourceDefinitions);
      if (matchedSourceIds.length === 0) continue;

      seenArticleIds.add(article.id);
      matchedArticles.push(article);
      matchedSourceIds.forEach((sourceId) => {
        sourceCoverage.set(sourceId, (sourceCoverage.get(sourceId) || 0) + 1);
      });
    }
  }

  matchedArticles.sort((left, right) => {
    const leftTime = left.publishedAt?.toDate ? left.publishedAt.toDate().getTime() : new Date(left.publishedAt || 0).getTime();
    const rightTime = right.publishedAt?.toDate ? right.publishedAt.toDate().getTime() : new Date(right.publishedAt || 0).getTime();
    return rightTime - leftTime;
  });

  // 리포트 시점 중복 제거: 제목 토큰 유사도 0.75 초과 기사 필터링
  const dedupedArticles: any[] = [];
  for (const article of matchedArticles) {
    const isDup = dedupedArticles.some(
      (kept) => calculateTokenSimilarity(article.title || '', kept.title || '') > 0.75,
    );
    if (!isDup) dedupedArticles.push(article);
  }

  return {
    articles: dedupedArticles.slice(0, targetLimit),
    matchedSourceNames: requestedSourceDefinitions
      .filter((source) => (sourceCoverage.get(source.id) || 0) > 0)
      .map((source) => source.name),
    sourceCoverage: requestedSourceDefinitions.map((source) => ({
      sourceId: source.id,
      sourceName: source.name,
      articleCount: sourceCoverage.get(source.id) || 0,
    })),
  };
}

function buildManagedReportPrompt(
  mode: ManagedReportMode,
  sourceNames: string[],
  basePrompt?: string,
  keywords: string[] = [],
  structureGuide?: string | null,
) {
  const sourceText = sourceNames.length > 0
    ? `뉴스 출처: ${sourceNames.join(', ')}`
    : '뉴스 출처: 구독 중인 전체 활성 출처';
  const keywordText = keywords.length > 0
    ? `키워드 필터: ${keywords.join(', ')}`
    : '키워드 필터: 별도 지정 없음';

  const sharedRules = [
    '전체 내용은 한국어로 작성합니다.',
    '팩트 기반으로만 분석하고 작성합니다.',
    'AI 추측, 투자 조언, 법적 의견, 미래 예측 등은 포함하지 않습니다.',
    '수집된 기사만 다루고, 새로 발생하는 이슈는 자율적으로 추가하지 않습니다.',
    '기사에서 확인된 수치나 사실관계 작성시 출처를 포함하기 어려우면, 출처없이 정보만 정리합니다.',
  ].join('\n');

  // When user has provided a specific prompt, it takes highest priority
  if (basePrompt) {
    const parts = [
      '[PRIMARY INSTRUCTION — FOLLOW STRICTLY]',
      basePrompt,
      '',
      sourceText,
      keywordText,
      '',
      '[Secondary structural guidance — apply only where user instructions do not specify otherwise]',
      sharedRules,
    ];
    if (structureGuide) parts.push('', structureGuide);
    return parts.join('\n').trim();
  }

  if (mode === 'external') {
    const parts = [
      `${sharedRules}`,
      `${sourceText}`,
      `${keywordText}`,
      `외부 공유용 이메일/문서 형태로 작성합니다.`,
      `문서의 특정 부분으로 바로 이동할 수 있도록 목차를 포함합니다.`,
      `구성은 다음 섹션을 갖춥니다:`,
      `1. 키워드 요약`,
      `2. 주요 기사 요약 3~6건`,
      `3. 시장의 방향으로 해석되는 시사점`,
      `4. 참고 기사 목록`,
    ];
    if (structureGuide) parts.push('', structureGuide);
    return parts.join('\n').trim();
  }

  const parts = [
    `${sharedRules}`,
    `${sourceText}`,
    `${keywordText}`,
    `내부 업무용 문서 형태로 작성합니다.`,
    `구성은 다음 섹션을 갖춥니다:`,
    `1. 키워드 요약`,
    `2. 업계별로 정렬된 요약`,
    `3. 출처별 기사원문 시사점`,
    `4. 주목해야하는 이슈`,
    `5. 참고 기사 목록`,
  ];
  if (structureGuide) parts.push('', structureGuide);
  return parts.join('\n').trim();
}

async function getCompanyReportPromptSettings(companyId: string): Promise<CompanyReportPromptSettings> {
  const settingsDoc = await admin.firestore().collection('companySettings').doc(companyId).get();
  const settings = (settingsDoc.data() || {}) as any;

  return {
    internalPrompt: `${settings?.reportPrompts?.internal || ''}`.trim(),
    externalPrompt: `${settings?.reportPrompts?.external || ''}`.trim(),
    companyName: settings?.companyName || null,
    publisherName: settings?.branding?.publisherName || null,
    internalTemplateOutputId: settings?.styleTemplates?.internal || null,
    externalTemplateOutputId: settings?.styleTemplates?.external || null,
  };
}

async function extractTemplateStructureGuideFromOutputId(outputId: string): Promise<string | null> {
  try {
    const outputDoc = await admin.firestore().collection('outputs').doc(outputId).get();
    if (!outputDoc.exists) return null;
    const outputData = outputDoc.data() as any;
    const rawHtml = outputData.htmlContent || outputData.rawOutput || '';
    if (!rawHtml) return null;

    const { load } = await import('cheerio');
    const $ = load(rawHtml);
    const headings: string[] = [];
    $('h1, h2, h3').each((_: number, el: any) => {
      const text = $(el).text().trim();
      const tag = (el.tagName || el.name || 'h2').toLowerCase();
      const depth = tag === 'h1' ? '' : (tag === 'h2' ? '  ' : '    ');
      if (text) headings.push(`${depth}${text}`);
    });
    if (headings.length === 0) return null;

    return [
      '[STRUCTURE GUIDE — based on a reference report template]',
      'Follow this section structure and hierarchy as closely as possible:',
      headings.join('\n'),
    ].join('\n');
  } catch {
    return null;
  }
}

async function extractTemplateStructureGuide(companyId: string, mode: ManagedReportMode): Promise<string | null> {
  try {
    const settingsDoc = await admin.firestore().collection('companySettings').doc(companyId).get();
    const settings = (settingsDoc.data() || {}) as any;
    const templateOutputId = mode === 'external'
      ? settings?.styleTemplates?.external
      : settings?.styleTemplates?.internal;
    if (!templateOutputId) return null;
    return extractTemplateStructureGuideFromOutputId(templateOutputId);
  } catch {
    return null;
  }
}

async function resolveManagedReportBasePrompt(companyId: string, mode: ManagedReportMode, requestedPrompt?: string) {
  const trimmedRequestedPrompt = `${requestedPrompt || ''}`.trim();
  if (trimmedRequestedPrompt) {
    return trimmedRequestedPrompt;
  }

  const companyPrompts = await getCompanyReportPromptSettings(companyId);
  return mode === 'external'
    ? companyPrompts.externalPrompt
    : companyPrompts.internalPrompt;
}

function getFunctionsBaseUrl() {
  return 'https://us-central1-eumnews-9a99c.cloudfunctions.net';
}

function getPublicAppUrl() {
  return 'https://eumnews-9a99c.web.app';
}

function triggerManagedReportProcessing(payload: {
  outputId: string;
  companyId: string;
  requestedBy?: string;
  recipients?: string[];
}) {
  fetch(`${getFunctionsBaseUrl()}/processManagedReportHttp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch((error) => {
    logger.error('Failed to trigger processManagedReportHttp:', error);
  });
}

interface ManagedReportExecutionOptions {
  outputId: string;
  companyId: string;
  requestedBy?: string;
  recipients?: string[];
}

async function executeManagedReport({
  outputId,
  companyId,
  requestedBy,
  recipients = [],
}: ManagedReportExecutionOptions) {
  const db = admin.firestore();
  const outputRef = db.collection('outputs').doc(outputId);
  const outputDoc = await outputRef.get();

  if (!outputDoc.exists) {
    throw new Error('Managed report document not found');
  }

  const output = outputDoc.data() as any;
  await outputRef.set({
    status: 'processing',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    startedAt: admin.firestore.FieldValue.serverTimestamp(),
    errorMessage: null,
    failedAt: null,
    attempts: admin.firestore.FieldValue.increment(1),
  }, { merge: true });

  let reportArticles: any[] = [];
  let matchedSourceNames: string[] = [];
  let sourceCoverage: ManagedReportArticleLoadResult['sourceCoverage'] = [];
  if (Array.isArray(output.articleIds) && output.articleIds.length > 0) {
    const articleDocs = await Promise.all(
      output.articleIds.map((articleId: string) => db.collection('articles').doc(articleId).get())
    );
    reportArticles = articleDocs.filter((doc) => doc.exists).map((doc) => ({ id: doc.id, ...doc.data() }));
  } else {
    const reportLoad = await loadAccessibleArticlesForManagedReport(companyId, output.filters || {});
    reportArticles = reportLoad.articles;
    matchedSourceNames = reportLoad.matchedSourceNames;
    sourceCoverage = reportLoad.sourceCoverage;
  }

  if (reportArticles.length === 0) {
    throw new Error('No analyzed articles found for the selected window and sources');
  }

  const sourceNames = Array.isArray(output.sourceNames) ? output.sourceNames : [];
  const keywordList = Array.isArray(output.filters?.keywords) ? output.filters.keywords : [];
  const basePrompt = await resolveManagedReportBasePrompt(companyId, output.serviceMode || 'internal', output.analysisPrompt || '');
  const structureGuide = output.templateOutputId
    ? await extractTemplateStructureGuideFromOutputId(output.templateOutputId)
    : await extractTemplateStructureGuide(companyId, output.serviceMode || 'internal');
  const prompt = buildManagedReportPrompt(output.serviceMode || 'internal', sourceNames, basePrompt, keywordList, structureGuide);
  const runtime = await getCompanyRuntimeConfig(companyId);
  const reportTitle = output.title || (output.serviceMode === 'external' ? '이음M&A NEWS' : '내부 분석 리포트');

  // Compute sequential Vol. number for this company
  const existingOutputsCount = await db.collection('outputs')
    .where('companyId', '==', companyId)
    .where('status', '==', 'completed')
    .count()
    .get();
  const volNumber = existingOutputsCount.data().count + 1;

  let result;
  if (output.serviceMode === 'eum_daily') {
    const { generateEumDailyReport } = require('./services/briefingService');
    result = await generateEumDailyReport({
      companyId,
      articleIds: reportArticles.map((article) => article.id),
      keywords: keywordList,
      analysisPrompt: prompt,
      savedPrompt: basePrompt,
      reportTitle,
      volNumber,
      requestedBy: requestedBy || output.requestedBy || '__system__',
      aiConfig: runtime.ai,
      outputId,
      outputMetadata: {
        type: 'managed_report',
        serviceMode: 'eum_daily',
        distributionGroupId: output.distributionGroupId || null,
        distributionGroupName: output.distributionGroupName || null,
        scheduledAt: output.scheduledAt || null,
        selectedSourceNames: sourceNames,
        matchedSourceNames: matchedSourceNames.length > 0 ? matchedSourceNames : sourceNames,
        sourceCoverage,
      },
    });
  } else {
    result = await generateCustomReport({
      companyId,
      articleIds: reportArticles.map((article) => article.id),
      keywords: keywordList,
      analysisPrompt: prompt,
      savedPrompt: basePrompt,
      reportTitle,
      volNumber,
      requestedBy: requestedBy || output.requestedBy || '__system__',
      aiConfig: runtime.ai,
      outputId,
      outputMetadata: {
        type: 'managed_report',
        serviceMode: output.serviceMode || 'internal',
        distributionGroupId: output.distributionGroupId || null,
        distributionGroupName: output.distributionGroupName || null,
        scheduledAt: output.scheduledAt || null,
        selectedSourceNames: sourceNames,
        matchedSourceNames: matchedSourceNames.length > 0 ? matchedSourceNames : sourceNames,
        sourceCoverage,
      },
    });
  }

  await outputRef.set({
    status: 'completed',
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    generatedOutputId: null,
    parentRequestId: null,
    articleIds: reportArticles.map((article) => article.id),
    articleCount: reportArticles.length,
    selectedSourceNames: sourceNames,
    matchedSourceNames: matchedSourceNames.length > 0 ? matchedSourceNames : sourceNames,
    sourceCoverage,
  }, { merge: true });

  const resolvedRecipients = Array.isArray(recipients) && recipients.length > 0
    ? recipients
    : (output.recipientsPreview || []);

  if (output.serviceMode === 'external' && (output.sendNow || resolvedRecipients.length > 0)) {
    const sendResult = await sendOutputEmails(
      result.outputId,
      resolvedRecipients,
      {
        subjectPrefix: '[EUM PE ?몃?由ы룷??',
        markAsField: 'externalSentAt',
        metadata: {
          externalSendCount: resolvedRecipients.length,
        },
      }
    );

    await outputRef.set({
      externalSentAt: admin.firestore.FieldValue.serverTimestamp(),
      externalSendCount: sendResult.sentCount || resolvedRecipients.length,
    }, { merge: true });
  }

  return {
    outputId,
    generatedOutputId: null,
    articleCount: reportArticles.length,
  };
}

interface StandaloneCustomReportExecutionOptions {
  outputId: string;
  companyId: string;
  articleIds: string[];
  keywords?: string[];
  analysisPrompt?: string;
  reportTitle: string;
  requestedBy: string;
}

async function executeStandaloneCustomReport({
  outputId,
  companyId,
  articleIds,
  keywords = [],
  analysisPrompt = '',
  reportTitle,
  requestedBy,
}: StandaloneCustomReportExecutionOptions) {
  const db = admin.firestore();
  const outputRef = db.collection('outputs').doc(outputId);

  try {
    await outputRef.set({
      status: 'processing',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      errorMessage: null,
      failedAt: null,
    }, { merge: true });

    const runtime = await getCompanyRuntimeConfig(companyId);
    const result = await generateCustomReport({
      companyId,
      articleIds,
      keywords,
      analysisPrompt,
      reportTitle,
      requestedBy,
      aiConfig: runtime.ai,
      outputId,
    });

    await outputRef.set({
      status: 'completed',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      generatedOutputId: null,
      parentRequestId: null,
      articleIds,
      articleCount: articleIds.length,
    }, { merge: true });

    return {
      outputId,
      generatedOutputId: null,
    };
  } catch (err: any) {
    logger.error(`executeStandaloneCustomReport failed for ${outputId}:`, err);
    await outputRef.set({
      status: 'failed',
      errorMessage: err.message || 'Unknown error',
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});
    throw err;
  }
}

// superadmin?? systemSettings/aiConfig + systemSettings/promptConfig?먯꽌 AI ?ㅼ젙 濡쒕뱶
async function getSystemAiConfig(): Promise<{ aiConfig: RuntimeAiConfig; companyId: string }> {
  const now = Date.now();
  if (_sysAiConfigCache && _sysAiConfigCache.expiresAt > now) {
    return _sysAiConfigCache.data;
  }
  const db = admin.firestore();
  const [sysDoc, promptDoc] = await Promise.all([
    db.collection('systemSettings').doc('aiConfig').get(),
    db.collection('systemSettings').doc('promptConfig').get(),
  ]);
  const sysData = (sysDoc.data() || {}) as any;
  const promptData = (promptDoc.data() || {}) as any;
  const provider: AiProvider = sysData['ai.provider'] || sysData.ai?.provider || 'glm';
  const defaults = PROVIDER_DEFAULTS[provider];
  const aiConfig: RuntimeAiConfig = {
    ...defaults,
    provider,
    model: sysData[`aiModels.${provider}`] || sysData.ai?.model || defaults.model,
    filteringModel: sysData[`aiFilteringModels.${provider}`] || sysData.aiFilteringModels?.[provider] || sysData.ai?.filteringModel || undefined,
    fallbackProvider: (sysData[`aiFallbackProviders.${provider}`] || sysData.aiFallbackProviders?.[provider] || sysData.ai?.fallbackProvider) as AiProvider | undefined || undefined,
    fallbackModel: sysData[`aiFallbackModels.${provider}`] || sysData.aiFallbackModels?.[provider] || sysData.ai?.fallbackModel || undefined,
    baseUrl: sysData[`aiBaseUrls.${provider}`] || sysData.ai?.baseUrl || null,
    maxPendingBatch: 60,
    maxAnalysisBatch: 40,
    // ?덊띁?대뱶誘쇱씠 而ㅼ뒪? ?ㅼ젙???꾨＼?꾪듃媛 ?덉쑝硫??ъ슜, ?놁쑝硫?肄붾뱶 湲곕낯媛?
    relevancePrompt: promptData.relevancePrompt || undefined,
    analysisPrompt: promptData.analysisPrompt || undefined,
  };
  if (aiConfig.provider === 'glm') {
    aiConfig.filteringModel = aiConfig.filteringModel === 'glm-4-plus'
      ? aiConfig.model
      : (aiConfig.filteringModel || aiConfig.model);
    aiConfig.fallbackProvider = undefined;
    aiConfig.fallbackModel = undefined;
  }
  // 泥?踰덉㎏ ?쒖꽦 ?뚯궗瑜?fallback companyId濡??ъ슜
  const companiesSnap = await db.collection('companies').where('active', '==', true).limit(1).get();
  const companyId = companiesSnap.empty ? '__system__' : companiesSnap.docs[0].id;
  const result = { aiConfig, companyId };
  _sysAiConfigCache = { data: result, expiresAt: Date.now() + SYS_AI_CONFIG_CACHE_TTL_MS };
  return result;
}
// ?????????????????????????????????????????
// [NEW] Global Source Management (Superadmin)
// ?????????????????????????????????????????
/** 湲濡쒕쾶 ?뚯뒪 紐⑸줉 議고쉶 (紐⑤뱺 ?몄쬆 ?ъ슜?? */
export const getGlobalSources = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  try {
    const db = admin.firestore();
    const snap = await db.collection('globalSources').orderBy('relevanceScore', 'desc').get();
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (err: any) {
    logger.error('getGlobalSources error:', err);
    throw new HttpsError('internal', err.message);
  }
});
/** 湲濡쒕쾶 ?뚯뒪 ?앹꽦/?섏젙 (Superadmin留? */
export const upsertGlobalSource = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (userDoc.data()?.role !== 'superadmin') {
    throw new HttpsError('permission-denied', 'Superadmin required');
  }
  const { id, ...data } = request.data || {};
  
  // ??濡쒓퉭 異붽?
  logger.info('[upsertGlobalSource] ?쒖옉', { uid: request.auth.uid, id, dataName: data.name });
  
  if (!data.name || !data.url || !data.type) {
    logger.error('[upsertGlobalSource] ?꾩닔 ?꾨뱶 ?꾨씫', { hasName: !!data.name, hasUrl: !!data.url, hasType: !!data.type });
    throw new HttpsError('invalid-argument', 'name, url, type are required');
  }
  
  const db = admin.firestore();
  const docRef = id ? db.collection('globalSources').doc(id) : db.collection('globalSources').doc();
  
  logger.info('[upsertGlobalSource] 寃쎈줈', { 
    mode: id ? 'update' : 'create', 
    targetId: id || '(??ID)', 
    docRefId: docRef.id 
  });
  
  try {
    await docRef.set({
      ...data,
      id: docRef.id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(id ? {} : {
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: request.auth.uid,
      }),
    }, { merge: !!id });
    
    logger.info('[upsertGlobalSource] ????깃났', { docId: docRef.id, mode: id ? 'update' : 'create' });
    
    invalidateSourceCache();
    return { success: true, id: docRef.id };
  } catch (error: any) {
    logger.error('[upsertGlobalSource] ????ㅽ뙣', { docId: docRef.id, error: error.message, stack: error.stack });
    throw new HttpsError('internal', `????ㅽ뙣: ${error.message}`);
  }
});
/** 湲濡쒕쾶 ?뚯뒪 ??젣 (Superadmin留? */
export const deleteGlobalSource = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (userDoc.data()?.role !== 'superadmin') {
    throw new HttpsError('permission-denied', 'Superadmin required');
  }
  const { id } = request.data || {};
  if (!id) throw new HttpsError('invalid-argument', 'Source ID required');
  const db = admin.firestore();
  invalidateSourceCache();
  await db.collection('globalSources').doc(id).delete();

  const subscriptionSnap = await db.collection('companySourceSubscriptions').get();
  await Promise.all(
    subscriptionSnap.docs.map(async (subscriptionDoc) => {
      const subscribedSourceIds: string[] = (subscriptionDoc.data() as any).subscribedSourceIds || [];
      if (!subscribedSourceIds.includes(id)) return;

      await subscriptionDoc.ref.set({
        subscribedSourceIds: subscribedSourceIds.filter((sourceId) => sourceId !== id),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: request.auth?.uid || '__system__',
      }, { merge: true });
    })
  );

  return { success: true };
});
/** ?뚯궗媛 援щ룆 ?뚯뒪 ?좏깮 ???*/

export const testGlobalSource = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (userDoc.data()?.role !== 'superadmin') throw new HttpsError('permission-denied', 'Superadmin required');
  const { sourceId } = request.data || {};
  if (!sourceId) throw new HttpsError('invalid-argument', 'sourceId required');
  const result = await runGlobalSourceTest(sourceId);
  await admin.firestore().collection('globalSources').doc(sourceId).update({
    lastTestedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastTestResult: result,
    ...(result.success ? { status: 'active' } : { status: 'error' }),
    lastStatus: result.success ? 'success' : 'error',
    errorMessage: result.success ? null : result.message,
  });
  return result;
});

export const deleteAllArticlesHttp = onRequest(
  { region: 'us-central1', timeoutSeconds: 300, memory: '512MiB' },
  async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-uid');
    if (request.method === 'OPTIONS') { response.status(200).send('OK'); return; }
    try {
      const db = admin.firestore();
      const uid = request.headers['x-uid'] as string;
      if (!uid) { response.status(401).json({ error: 'Unauthorized' }); return; }
      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists || (userDoc.data() as any)?.role !== 'superadmin') { response.status(403).json({ error: 'Forbidden - Superadmin only' }); return; }
      const deleted = await deleteArticlesByQuery(db, db.collection('articles'));
      response.json({ success: true, message: `전체 기사 삭제 완료: ${deleted}건`, deletedCount: deleted });
    } catch (err: any) {
      logger.error('deleteAllArticles error:', err);
      response.status(500).json({ error: err.message });
    }
  }
);

export const deleteExcludedArticlesHttp = onRequest(
  { region: 'us-central1', timeoutSeconds: 300, memory: '512MiB' },
  async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-uid');
    if (request.method === 'OPTIONS') { response.status(200).send('OK'); return; }
    try {
      const db = admin.firestore();
      const uid = request.headers['x-uid'] as string;
      if (!uid) { response.status(401).json({ error: 'Unauthorized' }); return; }
      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists || (userDoc.data() as any)?.role !== 'superadmin') { response.status(403).json({ error: 'Forbidden - Superadmin only' }); return; }
      const deleted = await purgeRejectedArticlesByQuery(db, db.collection('articles').where('status', '==', 'rejected'));
      response.json({ success: true, message: `제외된 기사 삭제 완료: ${deleted}건`, deletedCount: deleted });
    } catch (err: any) {
      logger.error('deleteExcludedArticles error:', err);
      response.status(500).json({ error: err.message });
    }
  }
);

export const deleteAllOutputsHttp = onRequest(
  { region: 'us-central1', timeoutSeconds: 300, memory: '512MiB' },
  async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-uid');
    if (request.method === 'OPTIONS') { response.status(200).send('OK'); return; }
    try {
      const db = admin.firestore();
      const uid = request.headers['x-uid'] as string;
      if (!uid) { response.status(401).json({ error: 'Unauthorized' }); return; }
      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists || (userDoc.data() as any)?.role !== 'superadmin') { response.status(403).json({ error: 'Forbidden - Superadmin only' }); return; }
      const deleted = await deleteArticlesByQuery(db, db.collection('outputs'));
      response.json({ success: true, message: `모든 보고서 삭제 완료: ${deleted}건`, deletedCount: deleted });
    } catch (err: any) {
      logger.error('deleteAllOutputs error:', err);
      response.status(500).json({ error: err.message });
    }
  }
);

export const findAndRemoveDuplicates = onCall(
  { region: 'us-central1', cors: true, invoker: 'public', timeoutSeconds: 120, memory: '512MiB' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
    await requireSuperadminUid(request.auth.uid);
    const db = admin.firestore();
    const statuses = ['pending', 'filtered', 'analyzed'];
    const snaps = await Promise.all(statuses.map((s) => db.collection('articles').where('status', '==', s).limit(500).get()));
    const all: any[] = [];
    for (const snap of snaps) for (const d of snap.docs) all.push({ id: d.id, ...d.data() });
    const groups = new Map<string, any[]>();
    for (const article of all) {
      const key: string = article.titleHash || hashTitle(article.title || '');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(article);
    }
    const batch = db.batch();
    let removedCount = 0;
    let groupsFound = 0;
    for (const [, group] of groups) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => {
        const scoreDiff = (b.relevanceScore || 0) - (a.relevanceScore || 0);
        if (scoreDiff !== 0) return scoreDiff;
        const timeA = a.publishedAt?.toDate ? a.publishedAt.toDate().getTime() : 0;
        const timeB = b.publishedAt?.toDate ? b.publishedAt.toDate().getTime() : 0;
        return timeB - timeA;
      });
      const keep = sorted[0];
      const duplicates = sorted.slice(1).filter((c) => calculateTokenSimilarity(keep.title || '', c.title || '') > 0.85);
      if (duplicates.length === 0) continue;
      groupsFound++;
      for (const dup of duplicates) {
        batch.set(db.collection('articles').doc(dup.id), { status: 'rejected', filterReason: 'duplicate_detected', duplicateOf: keep.id, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        removedCount++;
      }
    }
    if (removedCount > 0) await batch.commit();
    return { success: true, removedCount, groupsFound };
  }
);

export const updateCompanySourceSubscriptions = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const { companyId: rawCompanyId, subscribedSourceIds } = request.data || {};
  const companyId = rawCompanyId || await getPrimaryCompanyId(request.auth.uid);
  const access = await assertCompanyAccess(request.auth.uid, companyId);
  if (!['superadmin', 'company_admin'].includes(access.role)) {
    throw new HttpsError('permission-denied', 'Permission denied');
  }
  if (!Array.isArray(subscribedSourceIds)) {
    throw new HttpsError('invalid-argument', 'subscribedSourceIds must be an array');
  }
  const db = admin.firestore();
  await db.collection('companySourceSubscriptions').doc(companyId).set({
    companyId,
    subscribedSourceIds,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: request.auth.uid,
  });
  return { success: true, companyId };
});

// ?????????????????????????????????????????
// [NEW] Company & User Management
// ?????????????????????????????????????????
/** ?뚯궗 紐⑸줉 議고쉶 (Superadmin留? */
export const getCompanies = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  try {
    const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
    if (userDoc.data()?.role !== 'superadmin') {
      throw new HttpsError('permission-denied', 'Superadmin required');
    }
    const db = admin.firestore();
    const snap = await db.collection('companies').orderBy('name').get();
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (err: any) {
    logger.error('getCompanies error:', err);
    if (err instanceof HttpsError) {
      throw err;
    }
    throw new HttpsError('internal', err.message);
  }
});
/** ?뚯궗 ?앹꽦/?섏젙 (Superadmin留? */
export const upsertCompany = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (userDoc.data()?.role !== 'superadmin') {
    throw new HttpsError('permission-denied', 'Superadmin required');
  }
  const { id, name, active, settings } = request.data || {};
  if (!name) throw new HttpsError('invalid-argument', 'Company name is required');
  const db = admin.firestore();
  const docRef = id ? db.collection('companies').doc(id) : db.collection('companies').doc();
  await docRef.set({
    id: docRef.id,
    name,
    active: active ?? true,
    settings: settings || {},
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...(id ? {} : { createdAt: admin.firestore.FieldValue.serverTimestamp() }),
  }, { merge: true });
  return { success: true, id: docRef.id };
});
/** ?ъ슜???앹꽦 (Superadmin ?먮뒗 Company Admin) */
export const adminCreateUser = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const { email, password, displayName, role, companyId: targetCompanyId } = request.data || {};
  if (!email || !password || !role || !targetCompanyId) {
    throw new HttpsError('invalid-argument', 'Missing required fields');
  }
  // 沅뚰븳 ?뺤씤
  const callerDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  const callerData = callerDoc.data();
  const isSuper = callerData?.role === 'superadmin';
  const isCompanyAdmin = callerData?.role === 'company_admin' && 
                        (callerData?.companyIds?.includes(targetCompanyId) || callerData?.companyId === targetCompanyId);
  if (!isSuper && !isCompanyAdmin) {
    throw new HttpsError('permission-denied', 'Insufficient permissions to create user');
  }
  // ??븷 ?쒗븳: Company Admin? superadmin???앹꽦?????놁쓬
  if (!isSuper && role === 'superadmin') {
    throw new HttpsError('permission-denied', 'Only superadmins can create other superadmins');
  }
  try {
    // Auth ?ъ슜???앹꽦
    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: displayName || email.split('@')[0],
    });
    // Firestore ?ъ슜??臾몄꽌 ?앹꽦
    await admin.firestore().collection('users').doc(userRecord.uid).set({
      uid: userRecord.uid,
      email,
      role,
      companyId: targetCompanyId,
      companyIds: [targetCompanyId],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: request.auth.uid,
    });
    // Custom Claims ?ㅼ젙
    await admin.auth().setCustomUserClaims(userRecord.uid, { role, companyId: targetCompanyId });
    return { success: true, uid: userRecord.uid };
  } catch (error: any) {
    throw new HttpsError('internal', error.message);
  }
});
/** ?뱀젙 ?뚯궗 ?ъ슜??紐⑸줉 議고쉶 */
export const getCompanyUsers = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const { companyId } = request.data || {};
  if (!companyId) throw new HttpsError('invalid-argument', 'Company ID required');
  const callerDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  const isSuper = callerDoc.data()?.role === 'superadmin';
  const isTargetAdmin = callerDoc.data()?.role === 'company_admin' && 
                       (callerDoc.data()?.companyIds?.includes(companyId) || callerDoc.data()?.companyId === companyId);
  if (!isSuper && !isTargetAdmin) {
    throw new HttpsError('permission-denied', 'Access denied');
  }
  const snap = await admin.firestore().collection('users')
    .where('companyIds', 'array-contains', companyId)
    .get();
  return snap.docs
    // company_admin ?몄텧 ??superadmin 怨꾩젙 ?몄텧 湲덉?
    .filter(doc => isSuper || doc.data().role !== 'superadmin')
    .map(doc => {
      const data = doc.data();
      return {
        uid: data.uid,
        email: data.email,
        role: data.role,
        createdAt: data.createdAt,
      };
    });
});
/** ?ъ슜????젣 (Superadmin ?먮뒗 蹂몄씤 ?뚯궗 Company Admin) */
export const deleteCompanyUser = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const { uid: targetUid } = request.data || {};
  if (!targetUid) throw new HttpsError('invalid-argument', 'Target user UID required');

  const callerDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  const callerData = callerDoc.data();
  const isSuper = callerData?.role === 'superadmin';

  // ??젣 ????좎? ?뺣낫 議고쉶
  const targetDoc = await admin.firestore().collection('users').doc(targetUid).get();
  if (!targetDoc.exists) throw new HttpsError('not-found', 'Target user not found');
  const targetData = targetDoc.data();

  // Company Admin: 蹂몄씤 ?뚯궗 ?뚯냽?닿퀬 superadmin???꾨땶 ?좎?留???젣 媛??
  if (!isSuper) {
    const callerCompanyId = callerData?.companyIds?.[0] || callerData?.companyId;
    const targetInSameCompany = targetData?.companyIds?.includes(callerCompanyId) || targetData?.companyId === callerCompanyId;
    if (callerData?.role !== 'company_admin' || !targetInSameCompany) {
      throw new HttpsError('permission-denied', 'Insufficient permissions');
    }
    if (targetData?.role === 'superadmin' || targetData?.role === 'company_admin') {
      throw new HttpsError('permission-denied', 'Cannot delete admin accounts');
    }
  }

  await admin.auth().deleteUser(targetUid);
  await admin.firestore().collection('users').doc(targetUid).delete();
  return { success: true };
});

// ?????????????????????????????????????????
// [NEW] Save/Load AI Prompt Config (Superadmin)
// ?????????????????????????????????????????
export const savePromptConfig = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (userDoc.data()?.role !== 'superadmin') throw new HttpsError('permission-denied', 'Superadmin required');
  const { relevancePrompt, analysisPrompt } = request.data || {};
  const db = admin.firestore();
  const updates: any = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  if (relevancePrompt !== undefined) updates.relevancePrompt = relevancePrompt || null;
  if (analysisPrompt !== undefined) updates.analysisPrompt = analysisPrompt || null;
  await db.collection('systemSettings').doc('promptConfig').set(updates, { merge: true });
  return { success: true };
});

export const getPromptConfig = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (userDoc.data()?.role !== 'superadmin') throw new HttpsError('permission-denied', 'Superadmin required');
  const db = admin.firestore();
  const doc = await db.collection('systemSettings').doc('promptConfig').get();
  const data = doc.data() || {};
  return {
    relevancePrompt: data.relevancePrompt || null,
    analysisPrompt: data.analysisPrompt || null,
  };
});

// ?????????????????????????????????????????
// [NEW] Save AI Provider API Key
// ?????????????????????????????????????????
export const saveAiApiKey = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  try {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Authentication required');
    }
    logger.info('saveAiApiKey: Starting with data:', { ...request.data, apiKey: request.data?.apiKey ? '***' : undefined });
    const { companyId: rawCompanyId, provider, apiKey, baseUrl, model, filteringModel, fallbackProvider, fallbackModel, setAsActive } = request.data || {};

    let companyId: string;
    try {
      companyId = rawCompanyId || await getPrimaryCompanyId(request.auth.uid);
      logger.info('saveAiApiKey: companyId resolved:', companyId);
    } catch (err: any) {
      logger.error('saveAiApiKey: getPrimaryCompanyId failed:', err.message);
      throw new HttpsError('invalid-argument', `Failed to get company ID: ${err.message}`);
    }

    let access: any;
    try {
      access = await assertCompanyAccess(request.auth.uid, companyId);
      logger.info('saveAiApiKey: access verified:', { role: access.role });
    } catch (err: any) {
      logger.error('saveAiApiKey: assertCompanyAccess failed:', err.message);
      throw new HttpsError('permission-denied', `Access denied: ${err.message}`);
    }

    if (access.role !== 'superadmin' && access.role !== 'company_admin') {
      throw new HttpsError('permission-denied', 'Company admin or superadmin required');
    }
    if (!provider || !['glm', 'gemini', 'openai', 'claude'].includes(provider)) {
      throw new HttpsError('invalid-argument', 'Valid provider required: glm, gemini, openai, claude');
    }

    // 1. API Key ???
    if (apiKey) {
      if (typeof apiKey !== 'string' || apiKey.trim().length < 5) {
        throw new HttpsError('invalid-argument', 'Valid API key is required');
      }
      logger.info('saveAiApiKey: Saving API key for', provider, companyId);
      try {
        await saveApiKeyForCompany(companyId, provider as AiProvider, apiKey.trim());
        logger.info('saveAiApiKey: API key saved successfully');
      } catch (keyErr: any) {
        logger.error('saveAiApiKey: API key save failed, continuing anyway:', keyErr.message);
        // API ??????ㅽ뙣?대룄 怨꾩냽 吏꾪뻾 (?섏쨷???섍꼍 蹂?섎굹 ?ㅻⅨ 怨녹뿉??濡쒕뱶 媛??
      }
    }

    // 2. Base URL 諛??좏깮??紐⑤뜽 ???
    const db = admin.firestore();
    const updates: any = {};
    if (baseUrl !== undefined) {
      updates[`aiBaseUrls.${provider}`] = baseUrl;
    }
    if (model !== undefined) {
      updates[`aiModels.${provider}`] = model;
    }
    if (filteringModel !== undefined) {
      updates[`aiFilteringModels.${provider}`] = filteringModel || null;
    }
    if (fallbackProvider !== undefined) {
      updates[`aiFallbackProviders.${provider}`] = fallbackProvider || null;
    }
    if (fallbackModel !== undefined) {
      updates[`aiFallbackModels.${provider}`] = fallbackModel || null;
    }
    // setAsActive?대㈃ ?쒖꽦 ?꾨줈諛붿씠?붾줈 ?ㅼ젙
    if (setAsActive) {
      updates['ai.provider'] = provider;
      if (model) updates['ai.model'] = model;
      if (baseUrl) updates['ai.baseUrl'] = baseUrl;
      if (filteringModel !== undefined) updates['ai.filteringModel'] = filteringModel || null;
    }
    logger.info('saveAiApiKey: Writing to companySettings:', { companyId, updates });
    await db.collection('companySettings').doc(companyId).set(updates, { merge: true });
    logger.info('saveAiApiKey: Wrote to companySettings successfully');

    // Superadmin: also save to global systemSettings
    const userDoc = await db.collection('users').doc(request.auth.uid).get();
    if (userDoc.data()?.role === 'superadmin') {
      logger.info('saveAiApiKey: User is superadmin, also saving to systemSettings');
      const sysDocRef = db.collection('systemSettings').doc('aiConfig');
      // update()??dot-notation??nested path濡??댁꽍 (set+merge??literal ?꾨뱶紐낆쑝濡????
      const sysUpdates: any = { ...updates };
      if (!sysUpdates['ai.provider']) sysUpdates['ai.provider'] = provider;
      if (apiKey) {
        sysUpdates[`apiKeys.${provider}`] = apiKey.trim();
      }
      try {
        await sysDocRef.update(sysUpdates);
      } catch {
        // document媛 ?놁쑝硫?set?쇰줈 fallback (nested object 援ъ“ ?ъ슜)
        const nested: any = {};
        if (apiKey) nested.apiKeys = { [provider]: apiKey.trim() };
        if (baseUrl !== undefined) { nested.aiBaseUrls = { [provider]: baseUrl }; }
        if (model !== undefined) { nested.aiModels = { [provider]: model }; }
        if (filteringModel !== undefined) { nested.aiFilteringModels = { [provider]: filteringModel || null }; }
        if (filteringModel !== undefined) { nested.aiFilteringModels = { [provider]: filteringModel || null }; }
        if (fallbackProvider !== undefined) { nested.aiFallbackProviders = { [provider]: fallbackProvider || null }; }
        if (fallbackModel !== undefined) { nested.aiFallbackModels = { [provider]: fallbackModel || null }; }
        if (setAsActive) { nested.ai = { provider, model: model || undefined, baseUrl: baseUrl || undefined, filteringModel: filteringModel || undefined, fallbackProvider: fallbackProvider || undefined, fallbackModel: fallbackModel || undefined }; }
        else { nested.ai = { provider }; }
        await sysDocRef.set(nested, { merge: true });
      }
      logger.info('saveAiApiKey: Superadmin updates complete');
    }
    logger.info('saveAiApiKey: Success');
    return { success: true, message: `Settings for ${provider} saved` };
  } catch (err: any) {
    logger.error('saveAiApiKey: ERROR:', err.code, err.message, err.stack);
    // HttpsError??洹몃?濡?re-throw (Firebase媛 ?щ컮瑜닿쾶 泥섎━)
    if (typeof err.code === 'string' && err.code.startsWith('functions/')) throw err;
    // ?쇰컲 Error??紐낆떆?곸쑝濡?HttpsError濡?蹂??
    throw new HttpsError('internal', err.message || 'Unknown error');
  }
});
/** ?뚯궗蹂??뚯씠?꾨씪???ㅼ젙 (?꾪꽣, 異쒕젰 ?? ?낅뜲?댄듃 */
export const updateCompanySettings = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const { companyId, filters, output, timezone } = request.data || {};
  const targetCompanyId = companyId || await getPrimaryCompanyId(request.auth.uid);
  await assertCompanyAccess(request.auth.uid, targetCompanyId);
  const db = admin.firestore();
  const updates: any = {};
  if (filters) updates.filters = filters;
  if (output) updates.output = output;
  if (timezone) updates.timezone = timezone;
  if (Object.keys(updates).length === 0) return { success: false, message: 'No updates provided' };
  await db.collection('companySettings').doc(targetCompanyId).set(updates, { merge: true });
  return { success: true };
});

export const saveCompanySettings = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

  const {
    companyId: rawCompanyId,
    companyName,
    publisherName,
    logoDataUrl,
    internalPrompt,
    externalPrompt,
    smtp,
    trackingCompanies,
  } = request.data || {};

  const companyId = rawCompanyId || await getPrimaryCompanyId(request.auth.uid);
  const access = await assertCompanyAccess(request.auth.uid, companyId);
  if (!['superadmin', 'company_admin'].includes(access.role)) {
    throw new HttpsError('permission-denied', 'Company admin or superadmin required');
  }

  const safeCompanyName = `${companyName || publisherName || ''}`.trim() || '이음프라이빗에쿼티';
  const safePublisherName = `${publisherName || companyName || ''}`.trim() || safeCompanyName;
  const safeLogoDataUrl = typeof logoDataUrl === 'string' && logoDataUrl.trim()
    ? logoDataUrl.trim()
    : null;
  const safeSmtp = smtp && typeof smtp === 'object'
    ? {
      host: `${smtp.host || ''}`.trim(),
      port: Number(smtp.port || 587),
      secure: Boolean(smtp.secure),
      user: `${smtp.user || ''}`.trim(),
      pass: `${smtp.pass || ''}`.trim(),
      from: `${smtp.from || ''}`.trim(),
    }
    : null;
  const safeTrackingCompanies = Array.isArray(trackingCompanies)
    ? trackingCompanies.map((item: string) => `${item || ''}`.trim()).filter(Boolean)
    : [];

  await admin.firestore().collection('companySettings').doc(companyId).set({
    companyName: safeCompanyName,
    reportPrompts: {
      internal: `${internalPrompt || ''}`.trim(),
      external: `${externalPrompt || ''}`.trim(),
    },
    branding: {
      publisherName: safePublisherName,
      logoDataUrl: safeLogoDataUrl,
    },
    trackingCompanies: safeTrackingCompanies,
    ...(safeSmtp ? { smtp: safeSmtp } : {}),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: request.auth.uid,
  }, { merge: true });

  return { success: true, companyId };
});

export const saveCompanyStyleTemplate = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

  const { companyId: rawCompanyId, mode, outputId } = request.data || {};

  if (!['internal', 'external'].includes(mode)) {
    throw new HttpsError('invalid-argument', 'mode must be internal or external');
  }

  const companyId = rawCompanyId || await getPrimaryCompanyId(request.auth.uid);
  const access = await assertCompanyAccess(request.auth.uid, companyId);
  if (!['superadmin', 'company_admin'].includes(access.role)) {
    throw new HttpsError('permission-denied', 'Company admin or superadmin required');
  }

  const db = admin.firestore();

  if (outputId) {
    const outputDoc = await db.collection('outputs').doc(outputId).get();
    if (!outputDoc.exists || outputDoc.data()?.companyId !== companyId) {
      throw new HttpsError('not-found', 'Output not found or not accessible');
    }
  }

  const updatePayload: Record<string, any> = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: request.auth.uid,
  };
  if (outputId) {
    updatePayload[`styleTemplates.${mode}`] = outputId;
  } else {
    updatePayload[`styleTemplates.${mode}`] = admin.firestore.FieldValue.delete();
  }

  await db.collection('companySettings').doc(companyId).set(updatePayload, { merge: true });

  return { success: true, companyId, mode, outputId: outputId || null };
});
// ?????????????????????????????????????????
// [NEW] Test AI Provider Connection
// ?????????????????????????????????????????
export const testAiConnection = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }
  const { companyId: rawCompanyId, provider, model, baseUrl } = request.data || {};
  const companyId = rawCompanyId || await getPrimaryCompanyId(request.auth.uid);
  await assertCompanyAccess(request.auth.uid, companyId);
  try {
    const targetProvider: AiProvider = provider || 'glm';
    const defaults = PROVIDER_DEFAULTS[targetProvider];
    const testConfig: RuntimeAiConfig = {
      provider: targetProvider,
      model: model || defaults.model,
      baseUrl: baseUrl || null,
      apiKeyEnvKey: defaults.apiKeyEnvKey,
    };
    const result = await testAiProviderConnection(testConfig, companyId);
    return result;
  } catch (error: any) {
    return {
      success: false,
      message: error.message || 'Connection test failed',
    };
  }
});
// ?????????????????????????????????????????
// Analyze Manual Article
// ?????????????????????????????????????????
export const analyzeManualArticle = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }
  const { title, content, source, url, publishedAt, companyId } = request.data || {};
  if (!title) {
    throw new HttpsError('invalid-argument', 'Title is required');
  }
  const articleContent = content || title;

  // superadmin? companyId ?놁씠??systemSettings AI ?ㅼ젙?쇰줈 ?ㅽ뻾
  let aiConfig: RuntimeAiConfig;
  let resolvedCompanyId: string;
  const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  const isSuperadmin = userDoc.data()?.role === 'superadmin';

  if (isSuperadmin && !companyId) {
    const sys = await getSystemAiConfig();
    aiConfig = sys.aiConfig;
    resolvedCompanyId = sys.companyId;
  } else {
    const runtime = await resolveRuntime(request.auth.uid, companyId);
    aiConfig = runtime.ai;
    resolvedCompanyId = runtime.companyId;
  }

  const relevanceResult = await checkRelevance(
    { title, content: articleContent, source: source || 'manual' },
    aiConfig,
    { companyId: resolvedCompanyId }
  );
  const analysis = await analyzeArticle(
    { title, content: articleContent, source: source || 'manual', url: url || '', publishedAt: publishedAt || new Date().toISOString() },
    aiConfig,
    { companyId: resolvedCompanyId }
  );
  return {
    success: true,
    companyId: resolvedCompanyId,
    isRelevant: relevanceResult.isRelevant,
    confidence: relevanceResult.confidence,
    relevanceReason: relevanceResult.reason,
    analysis,
  };
});
// ?????????????????????????????????????????
export const diagnosticHttp = onRequest(
  { region: 'us-central1', timeoutSeconds: 30 },
  async (req, res) => {
    const db = admin.firestore();
    try {
      // POST: ?곹깭 珥덇린???≪뀡
      if (req.method === 'POST') {
        const { action } = req.body || {};
        if (action === 'resetPipelineState') {
          await db.collection('systemRuntime').doc('worker_continuous-collection').set({
            leaseUntil: admin.firestore.FieldValue.delete(),
            status: 'idle',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
          await db.collection('systemRuntime').doc('worker_continuous-analysis').set({
            leaseUntil: admin.firestore.FieldValue.delete(),
            status: 'idle',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
          await db.collection('systemRuntime').doc('continuousPipeline').set({
            lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
            resetBy: 'diagnosticHttp',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
          const recovered = await recoverStaleAiStageArticles(true);
          res.json({ success: true, message: 'Pipeline state reset', ...recovered });
          return;
        }
        if (action === 'cleanupTheBell') {
          const normalize = (value: any) => `${value || ''}`.toLowerCase().replace(/[\s_()-]+/g, '');
          const isTheBell = (payload: any) => {
            const candidates = [
              payload?.sourceId,
              payload?.globalSourceId,
              payload?.source,
              payload?.url,
              payload?.normalizedUrl,
              payload?.title,
            ].map(normalize);
            return candidates.some((value) =>
              value.includes('thebell') ||
              value.includes('?붾꺼') ||
              value.includes('3syjizr4ih9bluozttba')
            );
          };

          const [articleSnap, dedupSnap] = await Promise.all([
            db.collection('articles').get(),
            db.collection('articleDedup').get(),
          ]);

          const articleMap = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
          const dedupMap = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
          articleSnap.docs.forEach((doc) => {
            if (isTheBell(doc.data())) articleMap.set(doc.id, doc);
          });
          dedupSnap.docs.forEach((doc) => {
            if (isTheBell(doc.data())) dedupMap.set(doc.id, doc);
          });

          const deleteBatchDocs = async (docs: FirebaseFirestore.QueryDocumentSnapshot[]) => {
            let deleted = 0;
            for (let i = 0; i < docs.length; i += 400) {
              const batch = db.batch();
              docs.slice(i, i + 400).forEach((doc) => batch.delete(doc.ref));
              await batch.commit();
              deleted += Math.min(400, docs.length - i);
            }
            return deleted;
          };

          const deletedArticles = await deleteBatchDocs([...articleMap.values()]);
          const deletedDedup = await deleteBatchDocs([...dedupMap.values()]);

          res.json({
            success: true,
            action,
            deletedArticles,
            deletedDedup,
          });
          return;
        }
        if (action === 'inspectApiSources') {
          const apiSnap = await db.collection('globalSources')
            .where('type', '==', 'api')
            .get();
          const cfgDoc = await db.collection('systemSettings').doc('naverConfig').get();
          const cfg = cfgDoc.exists ? (cfgDoc.data() as any) : {};

          res.json({
            success: true,
            action,
            naverConfig: {
              hasClientId: !!cfg.clientId,
              hasClientSecret: !!cfg.clientSecret,
              clientIdPreview: cfg.clientId ? `${String(cfg.clientId).slice(0, 4)}...` : null,
            },
            apiSources: apiSnap.docs.map((doc) => {
              const data = doc.data() as any;
              return {
                id: doc.id,
                name: data.name || null,
                status: data.status || null,
                type: data.type || null,
                apiType: data.apiType || null,
                url: data.url || null,
                apiEndpoint: data.apiEndpoint || null,
                defaultKeywords: Array.isArray(data.defaultKeywords) ? data.defaultKeywords : [],
                lastStatus: data.lastStatus || null,
                lastTestResult: data.lastTestResult || null,
              };
            }),
          });
          return;
        }
        if (action === 'testNaverApi') {
          const cfgDoc = await db.collection('systemSettings').doc('naverConfig').get();
          const cfg = cfgDoc.exists ? (cfgDoc.data() as any) : {};
          const apiSnap = await db.collection('globalSources')
            .where('type', '==', 'api')
            .get();

          const sources = apiSnap.docs
            .map((doc) => ({ id: doc.id, ...(doc.data() as any) }))
            .filter((source: any) => source.apiType === 'naver');

          if (!cfg.clientId || !cfg.clientSecret) {
            res.json({
              success: false,
              action,
              error: 'Naver API credentials are missing',
              sourceCount: sources.length,
            });
            return;
          }

          const results = await Promise.all(sources.map(async (source: any) => {
            const keyword = (Array.isArray(source.defaultKeywords) && source.defaultKeywords.length > 0)
              ? source.defaultKeywords[0]
              : 'M&A';
            try {
              const resp = await axios.get('https://openapi.naver.com/v1/search/news.json', {
                headers: {
                  'X-Naver-Client-Id': cfg.clientId,
                  'X-Naver-Client-Secret': cfg.clientSecret,
                },
                params: { query: keyword, display: 10, start: 1, sort: 'date' },
                timeout: 10000,
              });
              const items = Array.isArray(resp.data?.items) ? resp.data.items : [];
              return {
                id: source.id,
                name: source.name || null,
                status: source.status || null,
                keyword,
                total: resp.data?.total ?? null,
                returnedItems: items.length,
                linksPresent: items.filter((item: any) => item.originallink || item.link).length,
                sampleTitles: items.slice(0, 3).map((item: any) => `${item.title || ''}`.replace(/<\/?b>/gi, '')),
              };
            } catch (error: any) {
              return {
                id: source.id,
                name: source.name || null,
                status: source.status || null,
                keyword,
                error: error.message || 'Unknown error',
                responseStatus: error.response?.status || null,
                responseData: error.response?.data || null,
              };
            }
          }));

          res.json({
            success: true,
            action,
            naverConfig: {
              hasClientId: !!cfg.clientId,
              hasClientSecret: !!cfg.clientSecret,
            },
            results,
          });
          return;
        }
        if (action === 'runApiCollection') {
          const result = await processApiSources();
          const since = new Date(Date.now() - 30 * 60 * 1000);
          const recentSnap = await db.collection('articles')
            .where('collectedAt', '>=', admin.firestore.Timestamp.fromDate(since))
            .orderBy('collectedAt', 'desc')
            .limit(100)
            .get();

          const bySource: Record<string, number> = {};
          recentSnap.docs.forEach((doc) => {
            const data = doc.data() as any;
            const source = data.source || 'unknown';
            bySource[source] = (bySource[source] || 0) + 1;
          });

          res.json({
            success: true,
            action,
            result,
            recentCollectedBySource: bySource,
          });
          return;
        }
        if (action === 'countNaverArticles') {
          const statuses = ['pending', 'filtered', 'analyzed', 'published'];
          const sourceNames = ['?ㅼ씠踰??댁뒪', '?ㅼ씠踰??댁뒪 (M&A/?ъ옄)'];
          const sourceCounts: Record<string, Record<string, number>> = {};

          for (const sourceName of sourceNames) {
            sourceCounts[sourceName] = {};
            for (const status of statuses) {
              const snap = await db.collection('articles')
                .where('source', '==', sourceName)
                .where('status', '==', status)
                .count()
                .get();
              sourceCounts[sourceName][status] = snap.data().count || 0;
            }
          }

          res.json({
            success: true,
            action,
            sourceCounts,
          });
          return;
        }
        if (action === 'normalizeNaverSources') {
          const canonicalId = 'qp7aZkqLLDGqRAqscpYK';
          const legacyId = 'XTu0io8BExlACzgBUemZ';
          const canonicalName = '?ㅼ씠踰??댁뒪 (M&A/?ъ옄)';

          const [legacyArticles, legacyDedup] = await Promise.all([
            db.collection('articles').where('sourceId', '==', legacyId).get(),
            db.collection('articleDedup').where('sourceId', '==', legacyId).get(),
          ]);

          const updateDocs = async (
            docs: FirebaseFirestore.QueryDocumentSnapshot[],
            updates: Record<string, any>,
          ) => {
            let updated = 0;
            for (let i = 0; i < docs.length; i += 400) {
              const batch = db.batch();
              const chunk = docs.slice(i, i + 400);
              chunk.forEach((doc) => batch.set(doc.ref, updates, { merge: true }));
              await batch.commit();
              updated += chunk.length;
            }
            return updated;
          };

          const [updatedArticles, updatedDedup] = await Promise.all([
            updateDocs(legacyArticles.docs, {
              sourceId: canonicalId,
              globalSourceId: canonicalId,
              source: canonicalName,
            }),
            updateDocs(legacyDedup.docs, {
              sourceId: canonicalId,
              globalSourceId: canonicalId,
              source: canonicalName,
            }),
          ]);

          await db.collection('globalSources').doc(legacyId).set({
            status: 'inactive',
            notes: 'Inactive placeholder source. Consolidated into ?ㅼ씠踰??댁뒪 (M&A/?ъ옄).',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastStatus: 'inactive',
          }, { merge: true });

          res.json({
            success: true,
            action,
            canonicalId,
            legacyId,
            updatedArticles,
            updatedDedup,
          });
          return;
        }
      }
      // 1. AI config
      const aiDoc = await db.collection('systemSettings').doc('aiConfig').get();
      const aiData = aiDoc.data() || {};
      const provider = aiData['ai.provider'] || 'unknown';

      // 2. Active sources
      const srcSnap = await db.collection('globalSources').where('status', '==', 'active').get();
      const sources = srcSnap.docs.map(d => {
        const data = d.data();
        return { id: d.id, name: data.name, type: data.type, rssUrl: (data.rssUrl || '').substring(0, 80), url: (data.url || '').substring(0, 80) };
      });

      // 3. Continuous runtime state
      const [continuousPipelineDoc, collectionWorkerDoc, analysisWorkerDoc] = await Promise.all([
        db.collection('systemRuntime').doc('continuousPipeline').get(),
        db.collection('systemRuntime').doc('worker_continuous-collection').get(),
        db.collection('systemRuntime').doc('worker_continuous-analysis').get(),
      ]);
      const continuousPipeline = continuousPipelineDoc.data() || {};
      const collectionWorker = collectionWorkerDoc.data() || {};
      const analysisWorker = analysisWorkerDoc.data() || {};

      // 4. Article status counts
      const [pending, filtered, analyzed, rejected] = await Promise.all([
        db.collection('articles').where('status', '==', 'pending').count().get(),
        db.collection('articles').where('status', '==', 'filtered').count().get(),
        db.collection('articles').where('status', '==', 'analyzed').count().get(),
        db.collection('articles').where('status', '==', 'rejected').count().get(),
      ]);

      // 5. API key check
      const hasKeyNested = !!(aiData.apiKeys && aiData.apiKeys[provider]);
      const hasKeyLiteral = !!aiData[`apiKeys.${provider}`];

      // 6. Company settings fallback
      const companiesSnap = await db.collection('companies').where('active', '==', true).limit(1).get();
      const fallbackCompanyId = companiesSnap.empty ? null : companiesSnap.docs[0].id;
      let hasCompanyKey = false;
      if (fallbackCompanyId) {
        const compDoc = await db.collection('companySettings').doc(fallbackCompanyId).get();
        hasCompanyKey = !!(compDoc.data()?.apiKeys?.[provider]);
      }

      // 7. Recent articles by source (last 24h)
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentSnap = await db.collection('articles')
        .where('collectedAt', '>=', admin.firestore.Timestamp.fromDate(since24h))
        .limit(200)
        .get();
      const sourceCount: Record<string, number> = {};
      recentSnap.docs.forEach(d => {
        const src = d.data().source || 'unknown';
        sourceCount[src] = (sourceCount[src] || 0) + 1;
      });
      const recentBySource = Object.entries(sourceCount)
        .sort((a, b) => b[1] - a[1])
        .map(([source, count]) => ({ source, count }));

      // 8. Company subscription info
      let subscribedSourceIds: string[] = [];
      if (fallbackCompanyId) {
        const subDoc = await db.collection('companySourceSubscriptions').doc(fallbackCompanyId).get();
        subscribedSourceIds = subDoc.exists ? ((subDoc.data() as any).subscribedSourceIds ?? []) : [];
      }
      // Map subscribed IDs to names
      const allSourceMap: Record<string, string> = {};
      srcSnap.docs.forEach(d => { allSourceMap[d.id] = d.data().name; });
      const subscribedSources = subscribedSourceIds.map(id => ({ id, name: allSourceMap[id] || id }));
      const notSubscribed = sources.filter(s => !subscribedSourceIds.includes(s.id)).map(s => ({ id: s.id, name: s.name, type: s.type }));

      res.json({
        ai: {
          provider,
          model: aiData[`aiModels.${provider}`] || aiData['ai.model'],
          baseUrl: aiData[`aiBaseUrls.${provider}`] || aiData['ai.baseUrl'] || null,
          hasKeyNested,
          hasKeyLiteral,
          hasCompanyKey,
          fallbackCompanyId,
          allFields: Object.keys(aiData),
        },
        pipelineRuntime: {
          mode: 'continuous',
          toggleSupported: false,
          pipelineEnabled: true,
          pipelineRunning: collectionWorker.status === 'running' || analysisWorker.status === 'running',
          currentStep: collectionWorker.status === 'running'
            ? 'continuous-collection'
            : analysisWorker.status === 'running'
            ? 'continuous-analysis'
            : null,
          collectionWorker,
          analysisWorker,
          continuousPipeline,
        },
        activeSources: { count: sources.length, sources },
        articleCounts: {
          pending: pending.data().count,
          filtered: filtered.data().count,
          analyzed: analyzed.data().count,
          rejected: rejected.data().count,
        },
        recentArticlesBySource: recentBySource,
        subscription: {
          companyId: fallbackCompanyId,
          subscribedCount: subscribedSourceIds.length,
          subscribedSources,
          notSubscribed,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);


// ?????????????????????????????????????????
// HTTP triggers (collection)
// ?????????????????????????????????????????
// triggerRssCollection: removed (replaced by scheduled pipeline in runFullPipeline)
// triggerAiFiltering, triggerDeepAnalysis, triggerBriefingGeneration: removed (internal steps, use runFullPipeline)
export const triggerEmailSend = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const companyId = request.data?.companyId || await getPrimaryCompanyId(request.auth.uid);
  await assertCompanyAccess(request.auth.uid, companyId);
  const outputId = request.data?.id;
  if (!outputId) throw new HttpsError('invalid-argument', 'Output ID is required');
  // Optional: explicit recipients from selected distribution groups
  const explicitRecipients: string[] | undefined = Array.isArray(request.data?.recipients) && request.data.recipients.length > 0
    ? request.data.recipients
    : undefined;
  return sendOutputEmails(outputId, explicitRecipients);
});
export const triggerTelegramSend = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const companyId = request.data?.companyId || await getPrimaryCompanyId(request.auth.uid);
  await assertCompanyAccess(request.auth.uid, companyId);
  const outputId = request.data?.id;
  if (!outputId) throw new HttpsError('invalid-argument', 'Output ID is required');
  return sendBriefingToTelegram(outputId);
});
/** Public HTTP endpoint: validates HMAC token and records unsubscribe in Firestore */
export const handleUnsubscribe = onRequest(
  { region: 'us-central1', cors: true, invoker: 'public' },
  async (request, response) => {
    const email = `${request.query.email || ''}`.trim().toLowerCase();
    const companyId = `${request.query.companyId || ''}`.trim();
    const token = `${request.query.token || ''}`.trim();

    if (!email || !companyId || !token) {
      response.status(400).send('<html><body><p>잘못된 요청입니다. 필수 파라미터가 누락되었습니다.</p></body></html>');
      return;
    }

    if (!verifyUnsubscribeToken(email, companyId, token)) {
      response.status(403).send('<html><body><p>유효하지 않은 구독 취소 링크입니다.</p></body></html>');
      return;
    }

    try {
      const db = admin.firestore();
      // Use email hash as doc ID to ensure one record per email
      const emailHash = Buffer.from(email).toString('base64url').slice(0, 40);
      await db.collection('emailUnsubscribes').doc(companyId).collection('entries').doc(emailHash).set({
        email,
        companyId,
        unsubscribedAt: admin.firestore.FieldValue.serverTimestamp(),
        token,
      }, { merge: true });

      response.status(200).send(`<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"/><title>구독 취소 완료</title></head><body style="font-family:sans-serif;max-width:500px;margin:60px auto;text-align:center;"><h2>구독이 취소되었습니다</h2><p style="color:#6b7280;">${escapeHtmlSimple(email)} 주소로의 뉴스레터 발송이 중단됩니다.</p></body></html>`);
    } catch (err) {
      logger.error('handleUnsubscribe error', err);
      response.status(500).send('<html><body><p>오류가 발생했습니다. 잠시 후 다시 시도해 주세요.</p></body></html>');
    }
  },
);

function escapeHtmlSimple(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Admin callable: toggle subscribe/unsubscribe status for an email */
export const manageEmailSubscription = onCall(
  { region: 'us-central1', cors: true, invoker: 'public' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

    const { email, companyId: reqCompanyId, action } = request.data || {};
    if (!email || !['subscribe', 'unsubscribe'].includes(action)) {
      throw new HttpsError('invalid-argument', 'email and action (subscribe|unsubscribe) are required');
    }

    const companyId = reqCompanyId || await getPrimaryCompanyId(request.auth.uid);
    await assertCompanyAccess(request.auth.uid, companyId);

    const db = admin.firestore();
    const emailNorm = `${email}`.trim().toLowerCase();
    const emailHash = Buffer.from(emailNorm).toString('base64url').slice(0, 40);
    const entryRef = db.collection('emailUnsubscribes').doc(companyId).collection('entries').doc(emailHash);

    if (action === 'unsubscribe') {
      await entryRef.set({
        email: emailNorm,
        companyId,
        unsubscribedAt: admin.firestore.FieldValue.serverTimestamp(),
        token: generateUnsubscribeToken(emailNorm, companyId),
      }, { merge: true });
    } else {
      // Resubscribe: delete the unsubscribe record
      await entryRef.delete();
    }

    return { success: true, email: emailNorm, action };
  },
);

export const notifyTrackedCompanyArticleCreated = onDocumentCreated(
  { region: 'us-central1', document: 'articles/{articleId}' },
  async (event) => {
    const article = event.data?.data();
    if (!article) return;

    const matchedKeyword = `${article.keywordMatched || ''}`.trim();
    if (!matchedKeyword || !DEFAULT_TRACKED_COMPANIES.includes(matchedKeyword)) {
      return;
    }

    try {
      await sendTrackedCompanyTelegramAlert(article);
    } catch (error: any) {
      logger.error('notifyTrackedCompanyArticleCreated failed', {
        articleId: event.params.articleId,
        message: error?.message || 'Unknown error',
      });
    }
  }
);
export const downloadReportAsset = onCall(
  { region: 'us-central1', timeoutSeconds: 540, memory: '1GiB', cors: true, invoker: 'public' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

    const outputId = request.data?.id;
    const format = request.data?.format;
    if (!outputId || !['pdf', 'html'].includes(format)) {
      throw new HttpsError('invalid-argument', 'Output ID and valid format are required');
    }

    const outputDoc = await admin.firestore().collection('outputs').doc(outputId).get();
    if (!outputDoc.exists) {
      throw new HttpsError('not-found', 'Output not found');
    }

    const output = outputDoc.data() as any;
    const companyId = output.companyId || request.data?.companyId || await getPrimaryCompanyId(request.auth.uid);
    await assertCompanyAccess(request.auth.uid, companyId);

    if (format === 'html') {
      const htmlAsset = await buildOutputHtmlAsset(outputId);
      return {
        filename: htmlAsset.htmlFilename,
        mimeType: 'text/html;charset=utf-8',
        base64: Buffer.from(htmlAsset.html, 'utf8').toString('base64'),
      };
    }

    const assetBundle = await buildOutputAssetBundle(outputId);
    return {
      filename: assetBundle.pdfFilename,
      mimeType: 'application/pdf',
      base64: assetBundle.pdfBuffer.toString('base64'),
    };
  },
);

export const createReportShareLink = onCall(
  { region: 'us-central1', timeoutSeconds: 120, cors: true, invoker: 'public' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

    const outputId = request.data?.id;
    const regenerate = request.data?.regenerate === true;
    if (!outputId) throw new HttpsError('invalid-argument', 'Output ID is required');

    const outputRef = admin.firestore().collection('outputs').doc(outputId);
    const outputDoc = await outputRef.get();
    if (!outputDoc.exists) {
      throw new HttpsError('not-found', 'Output not found');
    }

    const output = outputDoc.data() as any;
    const companyId = output.companyId || request.data?.companyId || await getPrimaryCompanyId(request.auth.uid);
    await assertCompanyAccess(request.auth.uid, companyId);

    const shareToken = !regenerate && output.shareToken
      ? output.shareToken
      : randomBytes(18).toString('base64url');
    const shareUrl = `${getPublicAppUrl()}/shared-report/${shareToken}`;

    await outputRef.set({
      shareEnabled: true,
      shareToken,
      shareUrl,
      shareUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      shareUpdatedBy: request.auth.uid,
    }, { merge: true });

    return {
      success: true,
      shareToken,
      shareUrl,
    };
  },
);

export const sharedReportPage = onRequest(
  { region: 'us-central1', timeoutSeconds: 120, cors: true, invoker: 'public' },
  async (request, response) => {
    const tokenFromPath = `${request.path || ''}`.split('/').filter(Boolean).pop();
    const shareToken = `${request.query.token || tokenFromPath || ''}`.trim();

    if (!shareToken) {
      response.status(400).send('Missing share token');
      return;
    }

    const outputSnap = await admin.firestore()
      .collection('outputs')
      .where('shareToken', '==', shareToken)
      .where('shareEnabled', '==', true)
      .limit(1)
      .get();

    if (outputSnap.empty) {
      response.status(404).send('Shared report not found');
      return;
    }

    const output = { id: outputSnap.docs[0].id, ...(outputSnap.docs[0].data() as any) };

    const rawHtml = output.htmlContent || output.rawOutput || '';
    if (!rawHtml) {
      response.status(404).send('Report content not available');
      return;
    }

    // Serve AI-generated HTML as-is with only footnote modal injected (no branded shell)
    const sharedHtml = await buildSharedReportPage(output);

    await outputSnap.docs[0].ref.set({
      shareLastViewedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.status(200).send(sharedHtml);
  },
);

export const requestManagedReport = onCall(
  { region: 'us-central1', timeoutSeconds: 3600, cors: true, invoker: 'public' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

    const {
      companyId: rawCompanyId,
      mode = 'internal',
      articleIds = [],
      filters = {},
      reportTitle,
      prompt = '',
      distributionGroupId = null,
      distributionGroupName = null,
      recipients = [],
      sendNow = false,
      scheduledAt = null,
      sourceNames = [],
      previewOnly = false,
      templateOutputId = null,
    } = request.data || {};

    const companyId = rawCompanyId || await getPrimaryCompanyId(request.auth.uid);
    const access = await assertCompanyAccess(request.auth.uid, companyId);

    if (mode === 'external' && !['superadmin', 'company_admin'].includes(access.role)) {
      throw new HttpsError('permission-denied', 'Only company admins can manage external delivery');
    }

    if (!Array.isArray(articleIds) && typeof filters !== 'object') {
      throw new HttpsError('invalid-argument', 'Article IDs or filters are required');
    }

    const db = admin.firestore();
    const outputRef = db.collection('outputs').doc();

    await outputRef.set({
      id: outputRef.id,
      companyId,
      type: 'managed_report',
      status: scheduledAt ? 'scheduled' : 'pending',
      serviceMode: mode,
      title: reportTitle || (mode === 'external' ? '이음M&A NEWS' : '내부 분석 리포트'),
      articleIds: Array.isArray(articleIds) ? articleIds : [],
      filters: filters || {},
      analysisPrompt: prompt || '',
      distributionGroupId,
      distributionGroupName,
      recipientCount: Array.isArray(recipients) ? recipients.length : 0,
      recipientsPreview: Array.isArray(recipients) ? recipients.slice(0, 20) : [],
      sendNow: Boolean(sendNow),
      previewOnly: Boolean(previewOnly),
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      requestedBy: request.auth.uid,
      attempts: 0,
      sourceNames: Array.isArray(sourceNames) ? sourceNames : [],
      templateOutputId: templateOutputId || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (!scheduledAt) {
      triggerManagedReportProcessing({
        outputId: outputRef.id,
        companyId,
        requestedBy: request.auth.uid,
        recipients,
      });
    }

    return { success: true, outputId: outputRef.id, status: scheduledAt ? 'scheduled' : 'pending' };
  }
);

export const updateReportContent = onCall(
  { region: 'us-central1', timeoutSeconds: 30, cors: true, invoker: 'public' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
    const { outputId, htmlContent } = request.data || {};
    if (!outputId || typeof htmlContent !== 'string') {
      throw new HttpsError('invalid-argument', 'outputId and htmlContent are required');
    }
    const db = admin.firestore();
    const outputDoc = await db.collection('outputs').doc(outputId).get();
    if (!outputDoc.exists) throw new HttpsError('not-found', 'Output not found');
    const outputData = outputDoc.data() as any;
    await assertCompanyAccess(request.auth.uid, outputData.companyId);
    await db.collection('outputs').doc(outputId).set(
      { htmlContent, rawOutput: htmlContent, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    return { success: true };
  }
);

export const retryManagedReport = onCall(
  { region: 'us-central1', timeoutSeconds: 3600, cors: true, invoker: 'public' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
    const { outputId } = request.data || {};
    if (!outputId) throw new HttpsError('invalid-argument', 'outputId is required');

    const db = admin.firestore();
    const outputRef = db.collection('outputs').doc(outputId);
    const outputDoc = await outputRef.get();
    if (!outputDoc.exists) throw new HttpsError('not-found', 'Output not found');

    const output = outputDoc.data() as any;
    const companyId = output.companyId || await getPrimaryCompanyId(request.auth.uid);
    await assertCompanyAccess(request.auth.uid, companyId);

    await outputRef.set({
      status: 'pending',
      errorMessage: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      generatedOutputId: null,
    }, { merge: true });

    triggerManagedReportProcessing({
      outputId,
      companyId,
      requestedBy: request.auth.uid,
      recipients: output.recipientsPreview || [],
    });

    return { success: true, outputId, status: 'pending' };
  }
);

export const getAiUsageSummary = onCall(
  { region: 'us-central1', timeoutSeconds: 60, cors: true, invoker: 'public' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
    const companyId = request.data?.companyId || await getPrimaryCompanyId(request.auth.uid);
    const access = await assertCompanyAccess(request.auth.uid, companyId);

    if (!['superadmin', 'company_admin'].includes(access.role)) {
      throw new HttpsError('permission-denied', 'Only admins can view token usage');
    }

    const summary = {
      last24h: { totalTokens: 0, promptTokens: 0, completionTokens: 0, totalCostUSD: 0, requests: 0 },
      last7d: { totalTokens: 0, promptTokens: 0, completionTokens: 0, totalCostUSD: 0, requests: 0 },
      last30d: { totalTokens: 0, promptTokens: 0, completionTokens: 0, totalCostUSD: 0, requests: 0 },
      recent: [] as any[],
    };

    try {
      const db = admin.firestore();
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const snap = await db.collection('aiCostTracking')
        .where('companyId', '==', companyId)
        .where('createdAt', '>=', thirtyDaysAgo)
        .orderBy('createdAt', 'desc')
        .limit(200)
        .get();

      const now = Date.now();
      const oneDay = 24 * 60 * 60 * 1000;
      const sevenDays = 7 * oneDay;
      const thirtyDays = 30 * oneDay;

      snap.docs.forEach((doc) => {
        const data = doc.data() as any;
        const createdAt = data.createdAt?.toDate ? data.createdAt.toDate().getTime() : now;
        const entry = {
          id: doc.id,
          stage: data.stage || 'unknown',
          provider: data.provider || 'unknown',
          model: data.model || '',
          totalTokens: Number(data.totalTokens || 0),
          totalCostUSD: Number(data.totalCostUSD || 0),
          createdAt: data.createdAt || null,
        };

        if (summary.recent.length < 20) summary.recent.push(entry);

        const apply = (bucket: typeof summary.last24h) => {
          bucket.totalTokens += Number(data.totalTokens || 0);
          bucket.promptTokens += Number(data.promptTokens || 0);
          bucket.completionTokens += Number(data.completionTokens || 0);
          bucket.totalCostUSD += Number(data.totalCostUSD || 0);
          bucket.requests += 1;
        };

        if (now - createdAt <= thirtyDays) apply(summary.last30d);
        if (now - createdAt <= sevenDays) apply(summary.last7d);
        if (now - createdAt <= oneDay) apply(summary.last24h);
      });
    } catch (error: any) {
      logger.error('getAiUsageSummary failed, returning empty summary', error);
    }

    return summary;
  }
);
// getPaidSourceAccess, managePaidSourceAccess: removed (paid source access UI removed)
// scheduledNewsCollection: removed (replaced by local PC scraper auto-scheduler)
// ?????????????????????????????????????????
// Scheduled: AI Analysis (every 4 hours)
// ?????????????????????????????????????????
export const scheduledAiAnalysis = onSchedule({ schedule: '*/5 * * * *', region: 'us-central1', timeoutSeconds: 540, memory: '1GiB' }, async () => {
  try {
    const { aiConfig, companyId } = await getSystemAiConfig();
    const result = await runContinuousAnalysisWorker(aiConfig, companyId);
    if (result.skipped) {
      logger.info('scheduledAiAnalysis skipped because another analysis worker is active');
      return;
    }
    await updateContinuousPipelineRuntime({
      lastAnalysisRunAt: admin.firestore.FieldValue.serverTimestamp(),
      totalFiltered: result.totalFiltered || 0,
      totalAnalyzed: result.totalAnalyzed || 0,
      analysisSkipped: false,
    });
    logger.info('scheduledAiAnalysis completed', result);
  } catch (err: any) {
    logger.error('Scheduled AI analysis failed:', err.message);
  }
});

// Reads 절감을 위해 수집 주기를 매 정각(1시간 간격)으로 조정
export const scheduledContinuousCollection = onSchedule({ schedule: '0 * * * *', region: 'us-central1', timeoutSeconds: 540, memory: '1GiB' }, async () => {
  try {
    const { aiConfig, companyId } = await getSystemAiConfig();
    const result = await runContinuousCollectionWorker(aiConfig, companyId);
    if (result.skipped) {
      logger.info('scheduledContinuousCollection skipped because another collection worker is active');
      return;
    }
    await updateContinuousPipelineRuntime({
      lastCollectionRunAt: admin.firestore.FieldValue.serverTimestamp(),
      totalCollected: result.totalCollected || 0,
      collectionSkipped: false,
    });
    logger.info('scheduledContinuousCollection completed', result);
  } catch (err: any) {
    logger.error('Scheduled continuous collection failed:', err.message);
  }
});

// Premium 수집도 동일하게 1시간 간격(정각)으로 조정
export const scheduledPremiumCollection = onSchedule({ schedule: '0 * * * *', region: 'us-central1', timeoutSeconds: 540, memory: '1GiB' }, async () => {
  try {
    const { aiConfig, companyId } = await getSystemAiConfig();
    const result = await runContinuousPremiumCollectionWorker(aiConfig, companyId);
    if (result.skipped) {
      logger.info('scheduledPremiumCollection skipped because another premium collection worker is active');
      return;
    }
    await updateContinuousPipelineRuntime({
      lastPremiumCollectionRunAt: admin.firestore.FieldValue.serverTimestamp(),
      totalPremiumCollected: result.totalCollected || 0,
      premiumCollectionSkipped: false,
    });
    logger.info('scheduledPremiumCollection completed', result);
  } catch (err: any) {
    logger.error('Scheduled premium collection failed:', err.message);
  }
});

export const triggerContinuousCollectionNow = onCall({ region: 'us-central1', cors: true, invoker: 'public', timeoutSeconds: 540, memory: '1GiB' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  await requireSuperadminUid(request.auth.uid);

  if (request.data?.resetLease) {
    await admin.firestore().collection('systemRuntime').doc('worker_continuous-collection').set({
      status: 'idle',
      lastManualResetAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      leaseUntil: admin.firestore.FieldValue.delete(),
    }, { merge: true });
  }

  const { aiConfig, companyId } = await getSystemAiConfig();
  const result = await runContinuousCollectionWorker(aiConfig, companyId);
  const counts = await updateContinuousPipelineRuntime({
    lastManualCollectionRunAt: admin.firestore.FieldValue.serverTimestamp(),
    totalCollected: result.totalCollected || 0,
    collectionSkipped: !!result.skipped,
  });

  return { success: true, ...result, articleCounts: counts };
});

export const triggerContinuousPremiumCollectionNow = onCall({ region: 'us-central1', cors: true, invoker: 'public', timeoutSeconds: 540, memory: '1GiB' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  await requireSuperadminUid(request.auth.uid);

  if (request.data?.resetLease) {
    await admin.firestore().collection('systemRuntime').doc('worker_continuous-premium-collection').set({
      status: 'idle',
      lastManualResetAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      leaseUntil: admin.firestore.FieldValue.delete(),
    }, { merge: true });
  }

  const { aiConfig, companyId } = await getSystemAiConfig();
  const result = await runContinuousPremiumCollectionWorker(aiConfig, companyId);
  const counts = await updateContinuousPipelineRuntime({
    lastManualPremiumCollectionRunAt: admin.firestore.FieldValue.serverTimestamp(),
    totalPremiumCollected: result.totalCollected || 0,
    premiumCollectionSkipped: !!result.skipped,
  });

  return { success: true, ...result, articleCounts: counts };
});

export const triggerContinuousAnalysisNow = onCall({ region: 'us-central1', cors: true, invoker: 'public', timeoutSeconds: 540, memory: '1GiB' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  await requireSuperadminUid(request.auth.uid);

  let recovered = { recoveredFiltering: 0, recoveredAnalyzing: 0 };
  if (request.data?.resetLease) {
    await admin.firestore().collection('systemRuntime').doc('worker_continuous-analysis').set({
      status: 'idle',
      lastManualResetAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      leaseUntil: admin.firestore.FieldValue.delete(),
    }, { merge: true });
    // 수동 리셋 시 아티클 레벨 리스 만료 여부 무관하게 강제 복구
    recovered = await recoverStaleAiStageArticles(true);
  }

  const { aiConfig, companyId } = await getSystemAiConfig();
  const result = await runContinuousAnalysisWorker(aiConfig, companyId);
  const counts = await updateContinuousPipelineRuntime({
    lastManualAnalysisRunAt: admin.firestore.FieldValue.serverTimestamp(),
    totalFiltered: result.totalFiltered || 0,
    totalAnalyzed: result.totalAnalyzed || 0,
    analysisSkipped: !!result.skipped,
  });

  return { success: true, ...result, ...recovered, articleCounts: counts };
});
export const scheduledDistributionDispatch = onSchedule('*/15 * * * *', async () => {
  const db = admin.firestore();
  const now = new Date();
  const kstNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const todayKst = kstNow.toISOString().slice(0, 10);
  const hhmm = `${`${kstNow.getHours()}`.padStart(2, '0')}:${`${kstNow.getMinutes()}`.padStart(2, '0')}`;

  const groupsSnap = await db.collection('distributionGroups').where('active', '==', true).get();
  const groups = groupsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() as any }));

  for (const group of groups) {
    try {
      const shouldRunAuto = Boolean(group.autoEnabled)
        && group.autoTimeKst === hhmm
        && group.lastAutoSentOnKst !== todayKst;

      const scheduledAt = group.nextReservedSendAt?.toDate
        ? group.nextReservedSendAt.toDate()
        : (group.nextReservedSendAt ? new Date(group.nextReservedSendAt) : null);
      const shouldRunReserved = Boolean(scheduledAt) && scheduledAt.getTime() <= now.getTime();

      if (!shouldRunAuto && !shouldRunReserved) continue;

      const requestRef = db.collection('outputs').doc();
      await requestRef.set({
        id: requestRef.id,
        companyId: group.companyId,
        type: 'managed_report',
        status: 'pending',
        serviceMode: 'external',
        title: group.reportTitle || `${group.name} 외부 리포트`,
        filters: {
          sourceIds: group.sourceIds || [],
          keywords: group.keywords || [],
          datePreset: group.datePreset || '24h',
        },
        analysisPrompt: group.prompt || '',
        distributionGroupId: group.id,
        distributionGroupName: group.name,
        recipientCount: Array.isArray(group.emails) ? group.emails.length : 0,
        recipientsPreview: Array.isArray(group.emails) ? group.emails.slice(0, 20) : [],
        sendNow: true,
        requestedBy: '__scheduler__',
        attempts: 0,
        sourceNames: group.sourceNames || [],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await executeManagedReport({
        outputId: requestRef.id,
        companyId: group.companyId,
        requestedBy: '__scheduler__',
        recipients: group.emails || [],
      });

      await db.collection('distributionGroups').doc(group.id).set({
        lastAutoSentOnKst: shouldRunAuto ? todayKst : (group.lastAutoSentOnKst || null),
        nextReservedSendAt: shouldRunReserved ? null : (group.nextReservedSendAt || null),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (error) {
      logger.error(`scheduledDistributionDispatch failed for group ${group.id}:`, error);
    }
  }
});
// ?????????????????????????????????????????
// Scheduled: Briefing generation (daily 22:00)
// ?????????????????????????????????????????
export const scheduledBriefingGeneration = onSchedule({
  schedule: '0 22 * * *',
  timeoutSeconds: 1800,
}, async () => {
  const db = admin.firestore();
  const companiesSnapshot = await db.collection('companies').where('active', '==', true).get();
  for (const companyDoc of companiesSnapshot.docs) {
    try {
      const runtime = await getCompanyRuntimeConfig(companyDoc.id);
      await createDailyBriefing({
        companyId: runtime.companyId,
        aiConfig: runtime.ai,
        outputConfig: runtime.output,
        timezone: runtime.timezone,
      });
    } catch (err: any) {
      logger.error(`Scheduled briefing failed for company ${companyDoc.id}:`, err.message);
    }
  }
});
// ?????????????????????????????????????????
// runFullPipeline: ?뚯씠?꾨씪???쒖옉 (利됱떆 pipelineId 諛섑솚, ?ㅼ젣 ?ㅽ뻾? background HTTP)
// ?????????????????????????????????????????
export const runFullPipeline = onCall({ region: 'us-central1', timeoutSeconds: 3600 }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  try {
    let targetCompanyId = request.data?.companyId;
    if (!targetCompanyId) {
      const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
      if (userDoc.data()?.role === 'superadmin') {
        const companiesSnap = await admin.firestore().collection('companies').where('active', '==', true).limit(1).get();
        if (!companiesSnap.empty) {
          targetCompanyId = companiesSnap.docs[0].id;
          logger.info('runFullPipeline: superadmin using companyId:', targetCompanyId);
        } else {
          throw new HttpsError('not-found', '?쒖꽦?붾맂 ?뚯궗媛 ?놁뒿?덈떎');
        }
      }
    }

    logger.info('runFullPipeline: resolveRuntime for', targetCompanyId);
    const runtime = await resolveRuntime(request.auth.uid, targetCompanyId, request.data?.overrides);
    const db = admin.firestore();
    const pipelineRef = db.collection('pipelineRuns').doc();
    const pipelineId = pipelineRef.id;

    await pipelineRef.set({
      id: pipelineId,
      companyId: runtime.companyId,
      companyName: runtime.companyName,
      status: 'pending',
      triggeredBy: request.auth.uid,
      configSnapshot: runtime,
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      mode: 'manual',
      steps: {},
    });

    const execUrl = `https://us-central1-eumnews-9a99c.cloudfunctions.net/executePipelineHttp`;
    fetch(execUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipelineId }),
    }).catch(err => logger.error('Failed to trigger executePipelineHttp:', err));

    return { pipelineId, success: true };
  } catch (err: any) {
    logger.error('runFullPipeline error:', err.code, err.message);
    if (typeof err.code === 'string' && err.code.startsWith('functions/')) throw err;
    throw new HttpsError('internal', err.message || 'Pipeline failed');
  }
});

export const executePipelineHttp = onRequest(
  { region: 'us-central1', timeoutSeconds: 3600, memory: '1GiB', cors: true },
  async (req, res) => {
    const { pipelineId } = req.body || {};
    if (!pipelineId) {
      res.status(400).json({ error: 'Missing pipelineId' });
      return;
    }

    const db = admin.firestore();
    const pipelineRef = db.collection('pipelineRuns').doc(pipelineId);
    const pipelineDoc = await pipelineRef.get();
    if (!pipelineDoc.exists) {
      res.status(404).json({ error: 'Pipeline not found' });
      return;
    }

    res.json({ accepted: true, pipelineId });

    const runtime = pipelineDoc.data()?.configSnapshot as RuntimePipelineConfig | undefined;
    if (!runtime) {
      await pipelineRef.set({
        status: 'failed',
        error: 'Missing configSnapshot',
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return;
    }

    try {
      await executePipelineRun({
        runtime,
        pipelineRef,
        pipelineRunId: pipelineId,
        includeOutput: true,
      });
    } catch (error: any) {
      logger.error('Pipeline execution error:', error.message);
    }
  },
);
// [NEW] generateReport: ?ъ슜???좏깮 湲곗궗 + ?꾨＼?꾪듃 ??HTML 遺꾩꽍 蹂닿퀬??
// ?????????????????????????????????????????
// [FAST] generateReportV2: 蹂닿퀬??臾몄꽌 ?앹꽦 ??利됱떆 ID 諛섑솚
// ?ㅼ젣 ?앹꽦? generateReportContentHttp?먯꽌 諛깃렇?쇱슫?쒕줈 ?섑뻾
export const generateReportV2 = onCall(
  { region: 'us-central1', timeoutSeconds: 3600, cors: true, invoker: 'public' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

    try {
      const {
        companyId: rawCompanyId,
        articleIds,
        keywords = [],
        analysisPrompt = '',
        reportTitle,
      } = request.data || {};

      if (!Array.isArray(articleIds) || articleIds.length === 0) {
        throw new HttpsError('invalid-argument', 'articleIds array is required');
      }

      const companyId = rawCompanyId || await getPrimaryCompanyId(request.auth.uid);
      await assertCompanyAccess(request.auth.uid, companyId);

      const db = admin.firestore();

      // 1. Output document ?앹꽦 (pending ?곹깭濡?
      const outputRef = db.collection('outputs').doc();
      const reportTitleResolved = reportTitle || `${keywords[0] || '시장'} 동향 분석 보고서`;

      await outputRef.set({
        id: outputRef.id,
        companyId,
        type: 'custom_report',
        title: reportTitleResolved,
        keywords,
        analysisPrompt,
        articleIds,
        articleCount: articleIds.length,
        status: 'pending',
        requestedBy: request.auth.uid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 백그라운드 비동기 실행: await하지 않고 즉시 outputId 반환
      // → GLM 생성 시간(30-120s)에 관계없이 onCall 함수는 즉시 응답
      // Cloud Run 인스턴스가 살아있는 동안 백그라운드로 계속 실행됨
      executeStandaloneCustomReport({
        outputId: outputRef.id,
        companyId,
        articleIds,
        keywords,
        analysisPrompt,
        reportTitle: reportTitleResolved,
        requestedBy: request.auth.uid,
      }).catch((err: any) => {
        logger.error('Background report generation failed:', err.message);
        admin.firestore().collection('outputs').doc(outputRef.id).set({
          status: 'failed',
          errorMessage: err.message || 'Report generation failed',
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true }).catch(() => {});
      });

      // 즉시 outputId 반환 → 프론트엔드는 Firestore 실시간 구독으로 완료 감지
      return {
        success: true,
        outputId: outputRef.id,
        status: 'pending',
        message: 'Report generation started. Monitor outputId for status updates.',
      };
    } catch (err: any) {
      const errorMsg = err.message || (typeof err === 'string' ? err : 'Unknown error');
      logger.error('generateReportV2 FAILED:', {
        message: errorMsg,
        stack: err.stack,
        data: request.data
      });
      if (err instanceof HttpsError) throw err;
      throw new HttpsError('internal', `Report creation failed: ${errorMsg}`);
    }
  }
);
export const generateReport = generateReportV2;

// ─────────────────────────────────────────────────────────────────────────────
// regenerateReportContent: 기존 기사는 유지한 채 새 프롬프트로 리포트 재생성
// ─────────────────────────────────────────────────────────────────────────────
export const regenerateReportContent = onCall(
  { region: 'us-central1', timeoutSeconds: 3600, cors: true, invoker: 'public' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

    const { outputId, newPrompt } = request.data || {};
    if (!outputId) throw new HttpsError('invalid-argument', 'outputId is required');

    const db = admin.firestore();
    const outputDoc = await db.collection('outputs').doc(outputId).get();
    if (!outputDoc.exists) throw new HttpsError('not-found', 'Output not found');

    const output = outputDoc.data() as any;
    await assertCompanyAccess(request.auth.uid, output.companyId);

    const articleIds: string[] = output.articleIds || [];
    if (articleIds.length === 0) {
      throw new HttpsError('failed-precondition', 'No article IDs found on this output');
    }

    const keywords: string[] = output.keywords || [];
    const reportTitle: string = output.title || 'Market Intelligence Report';
    const analysisPrompt = (typeof newPrompt === 'string' && newPrompt.trim()) ? newPrompt.trim() : (output.analysisPrompt || '');

    // Set status to processing immediately so frontend onSnapshot fires
    await db.collection('outputs').doc(outputId).set({
      status: 'processing',
      analysisPrompt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    // Fire background regeneration (reuses same outputId — htmlContent is overwritten)
    executeStandaloneCustomReport({
      outputId,
      companyId: output.companyId,
      articleIds,
      keywords,
      analysisPrompt,
      reportTitle,
      requestedBy: request.auth.uid,
    }).catch((err: any) => {
      logger.error('[regenerateReportContent] Background failed:', err.message);
      db.collection('outputs').doc(outputId).set({
        status: 'failed',
        errorMessage: err.message || 'Regeneration failed',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    return { success: true, outputId };
  }
);

// [NEW] generateReportContentHttp: 蹂닿퀬???댁슜 ?앹꽦 (諛깃렇?쇱슫?? 理쒕? 540珥?
export const generateReportContentHttp = onRequest(
  { region: 'us-central1', timeoutSeconds: 3600, memory: '1GiB' },
  async (req, res) => {
    // CORS
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.set('Access-Control-Max-Age', '3600');
      res.status(204).send('');
      return;
    }

    try {
      const auth = req.headers.authorization?.split('Bearer ')[1];
      if (!auth) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      const decodedToken = await admin.auth().verifyIdToken(auth);
      if (!decodedToken.uid) {
        res.status(401).json({ error: 'Invalid token' });
        return;
      }

      const { outputId, companyId, articleIds, keywords = [], analysisPrompt = '', reportTitle, requestedBy } = req.body;

      if (!outputId || !companyId) {
        res.status(400).json({ error: 'Missing outputId or companyId' });
        return;
      }

      await assertCompanyAccess(decodedToken.uid, companyId);

      const db = admin.firestore();
      const outputRef = db.collection('outputs').doc(outputId);

      try {
        await outputRef.update({
          status: 'processing',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        const runtime = await getCompanyRuntimeConfig(companyId);

        await generateCustomReport({
          companyId,
          articleIds,
          keywords,
          analysisPrompt,
          reportTitle,
          requestedBy: requestedBy || decodedToken.uid,
          aiConfig: runtime.ai,
          outputId,
        });

        await outputRef.update({
          status: 'completed',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        logger.info(`Report ${outputId} generated successfully`);
        res.json({ success: true, outputId, status: 'completed' });
      } catch (err: any) {
        logger.error(`Report ${outputId} generation failed:`, err);
        await outputRef.update({
          status: 'failed',
          errorMessage: err.message || 'Unknown error',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(e => logger.error('Failed to update status:', e));
        res.status(500).json({ error: err.message || 'Internal error' });
      }
    } catch (err: any) {
      logger.error('generateReportContentHttp error:', err);
      res.status(500).json({ error: err.message || 'Internal error' });
    }
  },
);

export const processManagedReportHttp = onRequest(
  { region: 'us-central1', timeoutSeconds: 3600, memory: '1GiB', cors: true },
  async (req, res) => {
    const { outputId, companyId, requestedBy, recipients = [] } = req.body || {};

    if (!outputId || !companyId) {
      res.status(400).json({ error: 'Missing outputId or companyId' });
      return;
    }

    const db = admin.firestore();
    const outputRef = db.collection('outputs').doc(outputId);

    try {
        const outputDoc = await outputRef.get();
        if (!outputDoc.exists) {
          throw new Error('Managed report document not found');
        }

        const output = outputDoc.data() as any;
        await outputRef.set({
          status: 'processing',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          startedAt: admin.firestore.FieldValue.serverTimestamp(),
          attempts: admin.firestore.FieldValue.increment(1),
        }, { merge: true });

        let reportArticles: any[] = [];
        let matchedSourceNames: string[] = [];
        let sourceCoverage: ManagedReportArticleLoadResult['sourceCoverage'] = [];
        if (Array.isArray(output.articleIds) && output.articleIds.length > 0) {
          const articleDocs = await Promise.all(
            output.articleIds.map((articleId: string) => db.collection('articles').doc(articleId).get())
          );
          reportArticles = articleDocs.filter((doc) => doc.exists).map((doc) => ({ id: doc.id, ...doc.data() }));
        } else {
          const reportLoad = await loadAccessibleArticlesForManagedReport(companyId, output.filters || {});
          reportArticles = reportLoad.articles;
          matchedSourceNames = reportLoad.matchedSourceNames;
          sourceCoverage = reportLoad.sourceCoverage;
        }

        if (reportArticles.length === 0) {
          throw new Error('No analyzed articles found for the selected window and sources');
        }

        const sourceNames = Array.isArray(output.sourceNames) ? output.sourceNames : [];
        const keywordList = Array.isArray(output.filters?.keywords) ? output.filters.keywords : [];
        const basePrompt = await resolveManagedReportBasePrompt(companyId, output.serviceMode || 'internal', output.analysisPrompt || '');
        const structureGuide = output.templateOutputId
          ? await extractTemplateStructureGuideFromOutputId(output.templateOutputId)
          : await extractTemplateStructureGuide(companyId, output.serviceMode || 'internal');
        const prompt = buildManagedReportPrompt(output.serviceMode || 'internal', sourceNames, basePrompt, keywordList, structureGuide);
        const runtime = await getCompanyRuntimeConfig(companyId);
        const reportTitle = output.title || (output.serviceMode === 'external' ? '이음M&A NEWS' : '내부 분석 리포트');

        const result = await generateCustomReport({
          companyId,
          articleIds: reportArticles.map((article) => article.id),
          keywords: keywordList,
          analysisPrompt: prompt,
          savedPrompt: basePrompt,
          reportTitle,
          requestedBy: requestedBy || output.requestedBy || '__system__',
          aiConfig: runtime.ai,
          outputId,
          outputMetadata: {
            type: 'managed_report',
            serviceMode: output.serviceMode || 'internal',
            distributionGroupId: output.distributionGroupId || null,
            distributionGroupName: output.distributionGroupName || null,
            scheduledAt: output.scheduledAt || null,
            selectedSourceNames: sourceNames,
            matchedSourceNames: matchedSourceNames.length > 0 ? matchedSourceNames : sourceNames,
            sourceCoverage,
          },
        });

        await outputRef.set({
          status: 'completed',
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          generatedOutputId: null,
          parentRequestId: null,
          articleIds: reportArticles.map((article) => article.id),
          articleCount: reportArticles.length,
          selectedSourceNames: sourceNames,
          matchedSourceNames: matchedSourceNames.length > 0 ? matchedSourceNames : sourceNames,
          sourceCoverage,
        }, { merge: true });

        const resolvedRecipients = Array.isArray(recipients) && recipients.length > 0
          ? recipients
          : (output.recipientsPreview || []);

        if (output.serviceMode === 'external' && !output.previewOnly && (output.sendNow || resolvedRecipients.length > 0)) {
          const sendResult = await sendOutputEmails(
            result.outputId,
            resolvedRecipients,
            {
              subjectPrefix: '[EUM PE ?몃?由ы룷??',
              markAsField: 'externalSentAt',
              metadata: {
                externalSendCount: resolvedRecipients.length,
              },
            }
          );

          await outputRef.set({
            externalSentAt: admin.firestore.FieldValue.serverTimestamp(),
            externalSendCount: sendResult.sentCount || resolvedRecipients.length,
          }, { merge: true });
        }

        res.json({ success: true, outputId, status: 'completed' });
      } catch (error: any) {
        logger.error('processManagedReportHttp error:', error);
        await outputRef.set({
          status: 'failed',
          errorMessage: error.message || 'Unknown error',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true }).catch(() => {});
        res.status(500).json({ error: error.message || 'Unknown error' });
      }
  }
);

// ?????????????????????????????????????????
// [NEW] searchArticles: 湲곗궗 寃??(?ㅼ썙???좎쭨/留ㅼ껜)
// ?????????????????????????????????????????
export const searchArticles = onCall(
  { region: 'us-central1', timeoutSeconds: 60, cors: true, invoker: 'public' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

    try {
      const {
        companyId: rawCompanyId,
        keywords = [],
        categories = [],
        startDate,
        endDate,
        sourceIds = [],
        statuses = ['analyzed', 'published'],
        limit: limitNum = 50,
        offset: offsetNum = 0,
      } = request.data || {};

      if (!request.auth.uid) throw new HttpsError('unauthenticated', 'Authentication required');

      const db = admin.firestore();
      const companyId = rawCompanyId || await getPrimaryCompanyId(request.auth.uid);
      const access = await assertCompanyAccess(request.auth.uid, companyId);
      const isSuperadmin = access.role === 'superadmin';

      const now = new Date();
      const defaultStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const parsedStart = parseKstDateInput(startDate, defaultStart) || defaultStart;
      const parsedEnd = parseKstDateInput(endDate, now) || now;
      const effectiveStart = !isNaN(parsedStart.getTime()) ? parsedStart : defaultStart;
      const effectiveEnd = !isNaN(parsedEnd.getTime()) ? parsedEnd : now;
      const normalizedStatuses = Array.isArray(statuses) && statuses.length > 0
        ? [...new Set(statuses)].slice(0, 10)
        : ['analyzed', 'published'];
      const allowedStatuses = isSuperadmin ? normalizedStatuses : ['analyzed', 'published'];

      let accessibleSourceIds: string[] = [];
      let accessibleSources: any[] = [];

      if (!isSuperadmin) {
        const subDoc = await db.collection('companySourceSubscriptions').doc(companyId).get();
        const subscribedSourceIds: string[] = subDoc.exists
          ? ((subDoc.data() as any).subscribedSourceIds || [])
          : [];

        if (subscribedSourceIds.length === 0) {
          return { articles: [], total: 0, hasMore: false };
        }

        accessibleSources = (await fetchGlobalSourcesByIds(db, subscribedSourceIds))
          .filter((source) => {
            if (source.status !== 'active') return false;
            const isPremium = source.pricingTier === 'paid' || source.pricingTier === 'requires_subscription';
            if (!isPremium) return true;
            return Array.isArray(source.allowedCompanyIds) && source.allowedCompanyIds.includes(companyId);
          });

        accessibleSourceIds = accessibleSources.map((source) => source.id);

        if (accessibleSourceIds.length === 0) {
          return { articles: [], total: 0, hasMore: false };
        }
      }

      const requestedSourceIds = Array.isArray(sourceIds) ? sourceIds.filter(Boolean) : [];
      const effectiveSourceIds = isSuperadmin
        ? requestedSourceIds
        : requestedSourceIds.length > 0
          ? requestedSourceIds.filter((id: string) => accessibleSourceIds.includes(id))
          : accessibleSourceIds;

      const effectiveSources: any[] = isSuperadmin
        ? (effectiveSourceIds.length > 0 ? await fetchGlobalSourcesByIds(db, effectiveSourceIds) : [])
        : (requestedSourceIds.length > 0
          ? accessibleSources.filter((source) => effectiveSourceIds.includes(source.id))
          : accessibleSources);

      const accessibleSourcePool = new Set<string>();
      accessibleSources.forEach((source) => {
        buildSourceIdentityPool(source).forEach((key) => accessibleSourcePool.add(key));
      });

      const effectiveSourcePool = new Set<string>();
      effectiveSources.forEach((source) => {
        buildSourceIdentityPool(source).forEach((key) => effectiveSourcePool.add(key));
      });

      const normalizeArticle = (d: FirebaseFirestore.QueryDocumentSnapshot) => {
        const data = d.data() as any;
        return {
          id: d.id,
          title: data.title || '',
          source: data.source || '',
          sourceId: data.globalSourceId || data.sourceId || null,
          globalSourceId: data.globalSourceId || null,
          legacySourceId: data.sourceId || null,
          publishedAt: data.publishedAt,
          collectedAt: data.collectedAt,
          status: data.status,
          summary: data.summary || [],
          category: data.category || '',
          tags: data.tags || [],
          relevanceScore: data.relevanceScore || 0,
          relevanceBasis: data.relevanceBasis || null,
          relevanceReason: data.relevanceReason || '',
          aiRelevanceReason: data.aiRelevanceReason || '',
          keywordMatched: data.keywordMatched || null,
          keywordPrefilterReason: data.keywordPrefilterReason || '',
          content: data.content || '',
          url: data.url || '',
          companyId: data.companyId,
        };
      };

      const matchesSourceAccess = (article: any) => {
        if (isSuperadmin) {
          return effectiveSourcePool.size === 0 || articleMatchesSourcePool(article, effectiveSourcePool);
        }

        if (!articleMatchesSourcePool(article, accessibleSourcePool)) return false;
        return articleMatchesSourcePool(article, effectiveSourcePool);
      };

      const matchesKeyword = (article: any) => {
        if (!keywords || !Array.isArray(keywords) || keywords.length === 0) return true;
        const kwLower = (keywords as string[]).map((k: string) => k.toLowerCase());
        const text = [
          article.title,
          article.content,
          ...(article.summary || []),
          ...(article.tags || []),
        ].join(' ').toLowerCase();
        return kwLower.some((kw) => text.includes(kw));
      };

      const matchesCategory = (article: any) => {
        if (!categories || !Array.isArray(categories) || categories.length === 0) return true;
        return (categories as string[]).includes(article.category || '');
      };

      const matchedArticles: any[] = [];
      const safeLimit = Math.min(Number(limitNum || 50), 200);
      const requiredMatches = Number(offsetNum || 0) + safeLimit + 50;
      const perStatusLimit = Math.min(Math.max(requiredMatches * 2, 120), 400);

      const articleSnaps = await Promise.all(
        allowedStatuses.map((status) =>
          db.collection('articles')
            .where('status', '==', status)
            .where('publishedAt', '>=', effectiveStart)
            .where('publishedAt', '<=', effectiveEnd)
            .orderBy('publishedAt', 'desc')
            .limit(perStatusLimit)
            .get(),
        ),
      );

      const scanned = articleSnaps.reduce((sum, snap) => sum + snap.size, 0);

      matchedArticles.push(
        ...articleSnaps
          .flatMap((snap) => snap.docs)
          .map(normalizeArticle)
          .filter(matchesSourceAccess)
          .filter(matchesKeyword)
          .filter(matchesCategory)
      );

      matchedArticles.sort((left, right) => {
        const leftTime = left.publishedAt?.toDate ? left.publishedAt.toDate().getTime() : new Date(left.publishedAt || 0).getTime();
        const rightTime = right.publishedAt?.toDate ? right.publishedAt.toDate().getTime() : new Date(right.publishedAt || 0).getTime();
        return rightTime - leftTime;
      });

      const total = matchedArticles.length;
      const paged = matchedArticles.slice(offsetNum, offsetNum + safeLimit);

      return {
        articles: paged,
        total,
        hasMore: offsetNum + safeLimit < total,
        startDate: effectiveStart.toISOString(),
        endDate: effectiveEnd.toISOString(),
        scanned,
      };
    } catch (err: any) {
      logger.error('searchArticles error:', err);
      if (err instanceof HttpsError) throw err;
      throw new HttpsError('internal', err.message || 'Search failed');
    }
  }
);

// ?????????????????????????????????????????
// 湲곗궗 ??젣 ?좏떥: 諛곗튂 ?묒뾽 (500嫄댁뵫)
// ?????????????????????????????????????????
async function deleteArticlesByQuery(db: admin.firestore.Firestore, q: admin.firestore.Query) {
  let deleted = 0;
  let snapshot = await q.limit(500).get();

  while (snapshot.docs.length > 0) {
    const batch = db.batch();
    snapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit();
    deleted += snapshot.docs.length;
    logger.info(`Deleted ${deleted} articles...`);

    snapshot = await q.limit(500).get();
  }
  return deleted;
}

async function purgeRejectedArticlesByQuery(db: admin.firestore.Firestore, q: admin.firestore.Query) {
  let deleted = 0;
  let snapshot = await q.limit(500).get();

  while (snapshot.docs.length > 0) {
    deleted += await purgeRejectedArticlesPreservingDedupe(snapshot.docs);
    snapshot = await q.limit(500).get();
  }

  return deleted;
}

// ?????????????????????????????????????????
// 紐⑤뱺 湲곗궗 ??젣 (Superadmin??
// ?????????????????????????????????????????

// ?????????????????????????????????????????
// ?쒖쇅??湲곗궗 ??젣 (status='rejected')
// ?????????????????????????????????????????

// ─────────────────────────────────────────────────────────────────────────────
// findAndRemoveDuplicates: 저장된 기사 중 제목/내용 중복 탐지 후 하위 중복 제거
// ─────────────────────────────────────────────────────────────────────────────


// ?????????????????????????????????????????
// 紐⑤뱺 蹂닿퀬????젣 (outputs 而щ젆??
// ?????????????????????????????????????????

// ?????????????????????????????????????????
// 글로벌 키워드 관리 (슈퍼어드민 전용)
// ?????????????????????????????????????????

export const getGlobalKeywords = onCall({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const db = admin.firestore();
  const userDoc = await db.collection('users').doc(request.auth.uid).get();
  if (!userDoc.exists || (userDoc.data() as any)?.role !== 'superadmin') {
    throw new HttpsError('permission-denied', 'Superadmin only');
  }
  const config = await getGlobalKeywordConfig();
  return config;
});

export const getTrackedCompanies = onCall({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const companyId = request.data?.companyId || await getPrimaryCompanyId(request.auth.uid);
  await assertCompanyAccess(request.auth.uid, companyId);
  const config = await getGlobalKeywordConfig();
  return {
    trackedCompanies: Array.isArray(config.trackedCompanies) ? config.trackedCompanies : [],
  };
});

export const saveGlobalKeywords = onCall({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const db = admin.firestore();
  const userDoc = await db.collection('users').doc(request.auth.uid).get();
  if (!userDoc.exists || (userDoc.data() as any)?.role !== 'superadmin') {
    throw new HttpsError('permission-denied', 'Superadmin only');
  }
  const { titleKeywords, trackedCompanies } = request.data || {};
  if (!Array.isArray(titleKeywords)) {
    throw new HttpsError('invalid-argument', 'titleKeywords must be an array');
  }
  await saveGlobalKeywordConfig(titleKeywords, trackedCompanies);
  invalidateKeywordCache();
  return { success: true, count: titleKeywords.length };
});

export const seedGlobalKeywords = onCall({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const db = admin.firestore();
  const userDoc = await db.collection('users').doc(request.auth.uid).get();
  if (!userDoc.exists || (userDoc.data() as any)?.role !== 'superadmin') {
    throw new HttpsError('permission-denied', 'Superadmin only');
  }
  const seeded = await seedGlobalKeywordsIfEmpty();
  const config = await getGlobalKeywordConfig();
  return { success: true, seeded, count: config.titleKeywords.length };
});

// ?????????????????????????????????????????
// 기사 + 중복 원장 전체 초기화 (슈퍼어드민 전용)
// - 키워드 필터 테스트 완료 후 클린 스타트용
// ?????????????????????????????????????????

export const resetAllArticles = onCall(
  { region: 'us-central1', timeoutSeconds: 540 },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
    
    const db = admin.firestore();
    const userDoc = await db.collection('users').doc(request.auth.uid).get();
    if (!userDoc.exists || (userDoc.data() as any)?.role !== 'superadmin') {
      throw new HttpsError('permission-denied', 'Superadmin only');
    }

    const confirmToken = request.data?.confirm;
    if (confirmToken !== 'RESET_ALL_CONFIRMED') {
      throw new HttpsError('invalid-argument', 'confirm 필드에 "RESET_ALL_CONFIRMED" 값이 필요합니다');
    }

    const articlesDeleted = await deleteArticlesByQuery(db, db.collection('articles'));
    let dedupDeleted = 0;
    while (true) {
      const snap = await db.collection('articleDedup').limit(400).get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      dedupDeleted += snap.docs.length;
    }
    invalidateKeywordCache();

    logger.info(`[ResetAll] articles: ${articlesDeleted}, dedup: ${dedupDeleted}`);
    return {
      success: true,
      message: `초기화 완료 — 기사 ${articlesDeleted}건, 중복원장 ${dedupDeleted}건 삭제`,
      articlesDeleted,
      dedupDeleted,
    };
  }
);
