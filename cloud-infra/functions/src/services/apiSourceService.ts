import * as admin from 'firebase-admin';
import { isDuplicateArticle, hashTitle, hashUrl } from './duplicateService';
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
    console.log('processApiSources: no active API sources found.');
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
        console.log(`processApiSources: unsupported API source '${source.name}', skipping.`);
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

      console.log(`Processed ${collected} new API articles from ${source.name}`);
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

function cleanNaverHtml(text: string): string {
  let cleaned = fixEncodingIssues(cleanHtmlContent((text || '')
    .replace(/<\/?b>/gi, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim()));

  // Naver API 가비지 텍스트 정제: 관련 없는 기사 제목들 제거
  // 패턴: 줄 단위로 중복되는 제목들, 광고성 텍스트, 특수한 구조의 쓰레기
  const lines = cleaned.split('\n');
  const seenLines = new Set<string>();
  const filtered: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 너무 짧은 줄 (1-2단어) 제거
    if (trimmed.split(/\s+/).length < 3) continue;

    // 중복된 줄 제거
    if (seenLines.has(trimmed)) continue;
    seenLines.add(trimmed);

    // 기사 제목처럼 보이는 라인 중 반복되는 것 필터 (관련 없는 뉴스들)
    // 예: "...기업 단독구리를..." "...국제 美 1만명..." 같은 단편적 제목들
    const isGarbageHeadline = /^[가-힣a-zA-Z0-9]{2,50}\s+(기업|국제|정치|사회|단독|영상)/;
    if (isGarbageHeadline.test(trimmed)) {
      // 실제 본문 시작이 아니라면 제거
      if (!trimmed.match(/^(서|이|그|하|스페이스X|더|결|원문|개|담)/)) continue;
    }

    filtered.push(trimmed);
  }

  // 최종 정제된 본문 (최소 5줄 이상, 너무 짧으면 가비지)
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
        if (startDate && publishedAt < startDate) continue;
        if (endDate && publishedAt > endDate) continue;
        candidates.push({
          title: cleanNaverHtml(item.title),
          url,
          content: cleanNaverHtml(item.description),
          publishedAt,
        });
      }
    } catch (err: any) {
      console.warn(`Naver search failed for keyword "${kw}": ${err.message}`);
    }
  }

  let collected = 0;
  const enrichedCandidates = await mapWithConcurrency(
    candidates,
    API_BODY_ENRICH_CONCURRENCY,
    async (article) => enrichArticleBody(article),
  );

  for (const article of enrichedCandidates) {
    const dupCheck = await isDuplicateArticle(article, { companyId: options?.companyId, fastMode: true });
    if (dupCheck.isDuplicate) continue;
    // 제목 키워드 필터 (Naver API는 키워드 검색이지만 추가 보호)
    const kw = await checkKeywordFilter(article.title, source.name || '네이버 뉴스', sourceId);
    if (!kw.passes) continue;

    // 키워드 통과 기사: AI 관련도 필터 생략하고 바로 filtered 저장
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
    await articleRef.set({
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
    await recordArticleDedupEntry({
      id: articleRef.id,
      ...article,
      companyId: options?.companyId || null,
      sourceId,
      globalSourceId: sourceId,
      source: source.name || '네이버 뉴스',
      status: 'pending',
      collectedAt: new Date(),
    });
    collected++;
  }

  console.log(`Naver News: saved ${collected} / ${candidates.length} articles`);
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
