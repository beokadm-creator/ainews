import * as logger from 'firebase-functions/logger';
import * as admin from 'firebase-admin';
import { isDuplicateArticle, hashTitle, hashUrl, batchFetchDedupEntries } from './duplicateService';
import { recordArticleDedupEntry } from './articleDedupService';
import { sendErrorNotificationToAdmin } from './telegramService';
import { cleanHtmlContent, fixEncodingIssues } from '../utils/encodingUtils';
import { RuntimeFilters, RuntimeAiConfig } from '../types/runtime';
import { getDateRangeBounds } from './runtimeConfigService';
import { fetchNaverNews } from './naverApiService';
import { mapWithConcurrency } from '../utils/asyncUtils';
import { enrichArticleBody } from './articleContentFetchService';
import { checkKeywordFilter } from './globalKeywordService';

const API_SOURCE_CONCURRENCY = 2;
const API_BODY_ENRICH_CONCURRENCY = 3;
const NAVER_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;

let cachedNaverConfig: {
  expiresAt: number;
  value: { clientId?: string; clientSecret?: string };
} | null = null;

function isNaverApiSource(source: any) {
  return (
    source?.apiType === 'naver' ||
    /openapi\.naver\.com/i.test(source?.apiEndpoint || source?.url || '') ||
    /naver/i.test(source?.name || '')
  );
}

export async function processApiSources(options?: {
  companyId?: string;
  pipelineRunId?: string;
  filters?: RuntimeFilters;
  aiConfig?: RuntimeAiConfig;
}) {
  const db = admin.firestore();
  const { startDate, endDate } = getDateRangeBounds(options?.filters?.dateRange);

  const allApiSources: { id: string; data: any }[] = [];
  const requestedSourceIds = new Set((options?.filters?.sourceIds || []).filter(Boolean));
  const snap = await db.collection('globalSources')
    .where('type', '==', 'api')
    .where('status', '==', 'active')
    .get();
  snap.docs.forEach((d) => {
    if (requestedSourceIds.size > 0 && !requestedSourceIds.has(d.id)) return;
    allApiSources.push({ id: d.id, data: d.data() });
  });

  const filteredApiSources = allApiSources.filter(({ data }) => {
    if (!isNaverApiSource(data)) return true;

    const keywordCount = Array.isArray(data.defaultKeywords) ? data.defaultKeywords.length : 0;
    const hasEndpoint = !!(data.url || data.apiEndpoint);

    // Skip placeholder Naver sources that have no keywords and no endpoint metadata.
    return keywordCount > 0 || hasEndpoint;
  });

  if (filteredApiSources.length === 0) {
    logger.info('processApiSources: no active API sources found.');
    return { success: true, totalCollected: 0, sourceResults: [] };
  }

  const sourceResults = await mapWithConcurrency(
    filteredApiSources,
    API_SOURCE_CONCURRENCY,
    async ({ id: sourceId, data: source }) => {
    const docRef = db.collection('globalSources').doc(sourceId);
    try {
      let collected = 0;

      if (isNaverApiSource(source)) {
        collected = await collectFromNaverNews(source, sourceId, options, startDate, endDate);
      } else {
        logger.info(`processApiSources: unsupported API source '${source.name}', skipping.`);
        return {
          sourceId,
          name: source.name || sourceId,
          collected: 0,
          success: true,
        };
      }

      await docRef.update({
        lastScrapedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastStatus: 'success',
        errorMessage: null,
      });

      logger.info(`Processed ${collected} new API articles from ${source.name}`);
      return {
        sourceId,
        name: source.name || sourceId,
        collected,
        success: true,
      };
    } catch (error: any) {
      const result = {
        sourceId,
        name: source.name || sourceId,
        collected: 0,
        success: false,
        error: error.message || 'Unknown error',
      };
      await docRef.update({
        lastStatus: 'error',
        errorMessage: error.message,
      }).catch(() => {});
      await sendErrorNotificationToAdmin('API collection failed', error.message, source.name);
      return result;
    }
  });

  const totalCollected = sourceResults.reduce((sum, item) => sum + Number(item.collected || 0), 0);
  return { success: true, totalCollected, sourceResults };
}

function decodeNaverEntities(text: string): string {
  return fixEncodingIssues(cleanHtmlContent((text || '')
    .replace(/<\/?b>/gi, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim()));
}

// 제목용: HTML 엔티티 디코딩만, 길이 필터 없음
function cleanNaverTitle(text: string): string {
  return decodeNaverEntities(text).replace(/\n+/g, ' ').trim();
}

// 본문/설명용: 가비지 라인 제거 + 최소 길이 필터
function cleanNaverHtml(text: string): string {
  const cleaned = decodeNaverEntities(text);

  const lines = cleaned.split('\n');
  const seenLines = new Set<string>();
  const filtered: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.split(/\s+/).length < 3) continue;
    if (seenLines.has(trimmed)) continue;
    seenLines.add(trimmed);

    const isGarbageHeadline = /^[가-힣a-zA-Z0-9]{2,50}\s+(기업|국제|정치|사회|단독|영상)/;
    if (isGarbageHeadline.test(trimmed)) {
      if (!trimmed.match(/^(서|이|그|하|스페이스X|더|결|원문|개|담)/)) continue;
    }

    filtered.push(trimmed);
  }

  const result = filtered.join('\n').trim();
  return result.length > 100 ? result : '';
}

async function collectFromNaverNews(
  source: any,
  sourceId: string,
  options: { companyId?: string; pipelineRunId?: string; filters?: RuntimeFilters; aiConfig?: RuntimeAiConfig } | undefined,
  startDate: Date | null,
  endDate: Date | null,
): Promise<number> {
  const db = admin.firestore();

  const cfg = await loadNaverConfig(db);
  const clientId = cfg.clientId;
  const clientSecret = cfg.clientSecret;
  if (!clientId || !clientSecret) {
    throw new Error('Naver API credentials are not configured in systemSettings/naverConfig.');
  }

  const keywords: string[] = [
    ...(options?.filters?.keywords || []),
    ...((source.defaultKeywords as string[]) || []),
  ];
  if (keywords.length === 0) keywords.push('M&A', '인수합병', '사모펀드 투자');

  // Naver API는 날짜 범위 파라미터가 없으므로, 응답받은 기사 중 startDate / endDate 기준 필터링 수행
  // (중복 검사는 이후 batchFetchDedupEntries가 훨씬 확실하게 처리하므로, 여기서는 기본 범위만 제한)
  const effectiveStartDate = startDate || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 기본 7일

  const seenUrls = new Set<string>();
  const candidates: Array<{ title: string; url: string; content: string; publishedAt: Date }> = [];

  for (const kw of keywords.slice(0, 8)) {
    try {
      const resp = await fetchNaverNews({
        clientId,
        clientSecret,
        query: kw,
        display: 100,
        start: 1,
        sort: 'date',
      });
      for (const item of resp.data.items || []) {
        if (!item.title) continue;
        const url = item.originallink || item.link;
        if (!url) continue;
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
        const publishedAt = item.pubDate ? new Date(item.pubDate) : new Date();
        if (publishedAt < effectiveStartDate) continue;
        if (endDate && publishedAt > endDate) continue;
        candidates.push({
          title: cleanNaverTitle(item.title),
          url,
          content: cleanNaverHtml(item.description),
          publishedAt,
        });
      }
    } catch (err: any) {
      logger.warn(`Naver search failed for keyword "${kw}": ${err.message}`);
    }
  }

  if (candidates.length === 0) {
    logger.info(`Naver News: 0 fresh candidates (startDate: ${effectiveStartDate.toISOString()})`);
    return 0;
  }

  // STEP 1: 배치 dedup 체크 (body enrichment 전) — 불필요한 HTTP 요청 방지
  const urlHashes = candidates.map((c) => hashUrl(c.url));
  const dedupEntries = await batchFetchDedupEntries(urlHashes);
  const freshCandidates = candidates.filter((c) => !dedupEntries.has(hashUrl(c.url)));

  logger.info(`Naver News: ${candidates.length} fresh → ${freshCandidates.length} after dedup filter`);

  if (freshCandidates.length === 0) {
    return 0;
  }

  // STEP 2: 신규 기사만 body enrichment
  const enrichedCandidates = await mapWithConcurrency(
    freshCandidates,
    API_BODY_ENRICH_CONCURRENCY,
    async (article) => enrichArticleBody(article),
  );

  // STEP 3: 키워드 필터 병렬 처리 (에러 방어)
  const keywordResultsRaw = await Promise.allSettled(
    enrichedCandidates.map(async (article) => ({
      article,
      kw: await checkKeywordFilter(article.title, source.name || '네이버 뉴스', sourceId),
    }))
  );
  
  const keywordPassed = keywordResultsRaw
    .filter((res): res is PromiseFulfilledResult<any> => res.status === 'fulfilled')
    .map((res) => res.value)
    .filter(({ kw }) => kw.passes);

  // STEP 4: 2차 dedup (ledger에 없는 기사에 대해 URL/제목 유사도 체크)
  const finalCandidates: typeof keywordPassed = [];
  for (const item of keywordPassed) {
    const dupCheck = await isDuplicateArticle(item.article, { companyId: options?.companyId, fastMode: true });
    if (!dupCheck.isDuplicate) finalCandidates.push(item);
  }

  if (finalCandidates.length === 0) {
    logger.info(`Naver News: saved 0 / ${candidates.length} articles`);
    return 0;
  }

  // STEP 5: 배치 저장 (500개 한도 방지 청크 처리)
  let collected = 0;
  const chunkedWrites: Promise<any>[] = [];
  const dedupWrites: Promise<any>[] = [];

  for (let i = 0; i < finalCandidates.length; i += 400) {
    const chunk = finalCandidates.slice(i, i + 400);
    const batch = db.batch();

    for (const { article, kw } of chunk) {
      const relevanceFields = {
        filteredAt: admin.firestore.FieldValue.serverTimestamp(),
        relevanceBasis: 'keyword_prefilter',
        relevanceScore: 80,
        relevanceConfidence: 0.9,
        relevanceReason: `제목 키워드 매칭: "${kw.matchedKeyword}"`,
        keywordMatched: kw.matchedKeyword || null,
        keywordPrefilterReason: `제목 키워드 매칭: "${kw.matchedKeyword}"`,
        collectedByKeywordFilter: true,
      };

      const articleRef = db.collection('articles').doc();
      batch.set(articleRef, {
        id: articleRef.id,
        ...article,
        companyId: options?.companyId || null,
        pipelineRunId: options?.pipelineRunId || null,
        source: source.name || '네이버 뉴스',
        sourceId,
        globalSourceId: sourceId,
        sourceCategory: source.category || 'domestic',
        sourcePricingTier: source.pricingTier || 'free',
        collectedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'pending',
        urlHash: hashUrl(article.url),
        titleHash: hashTitle(article.title),
        ...relevanceFields,
      });
      dedupWrites.push(recordArticleDedupEntry({
        id: articleRef.id,
        ...article,
        companyId: options?.companyId || null,
        sourceId,
        globalSourceId: sourceId,
        source: source.name || '네이버 뉴스',
        status: 'pending',
        collectedAt: new Date(),
      }));
      collected++;
    }
    chunkedWrites.push(batch.commit());
  }

  await Promise.all(chunkedWrites);
  await Promise.all(dedupWrites);

  logger.info(`Naver News: saved ${collected} / ${candidates.length} articles`);
  return collected;
}

async function loadNaverConfig(db: FirebaseFirestore.Firestore): Promise<{ clientId?: string; clientSecret?: string }> {
  const now = Date.now();
  if (cachedNaverConfig && cachedNaverConfig.expiresAt > now) {
    return cachedNaverConfig.value;
  }

  const cfgDoc = await db.collection('systemSettings').doc('naverConfig').get();
  const cfg = cfgDoc.exists ? (cfgDoc.data() as any) : {};
  const value = {
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
  };

  cachedNaverConfig = {
    expiresAt: now + NAVER_CONFIG_CACHE_TTL_MS,
    value,
  };

  return value;
}
