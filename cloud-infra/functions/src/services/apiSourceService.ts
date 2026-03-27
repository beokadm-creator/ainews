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
import { titlePassesGlobalKeywordFilter } from './globalKeywordService';

const API_SOURCE_CONCURRENCY = 2;
const API_BODY_ENRICH_CONCURRENCY = 3;

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
  const snap = await db.collection('globalSources')
    .where('type', '==', 'api')
    .where('status', '==', 'active')
    .get();
  snap.docs.forEach((d) => {
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
  return fixEncodingIssues(cleanHtmlContent((text || '')
    .replace(/<\/?b>/gi, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim()));
}

async function collectFromNaverNews(
  source: any,
  sourceId: string,
  options: { companyId?: string; pipelineRunId?: string; filters?: RuntimeFilters; aiConfig?: RuntimeAiConfig } | undefined,
  startDate: Date | null,
  endDate: Date | null,
): Promise<number> {
  const db = admin.firestore();

  const cfgDoc = await db.collection('systemSettings').doc('naverConfig').get();
  const cfg = cfgDoc.exists ? (cfgDoc.data() as any) : {};
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
    const passes = await titlePassesGlobalKeywordFilter(article.title, source.name || '네이버 뉴스', sourceId);
    if (!passes) continue;

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
