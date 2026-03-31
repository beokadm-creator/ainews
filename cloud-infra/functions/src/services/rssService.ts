import Parser from 'rss-parser';
import * as admin from 'firebase-admin';
import axios from 'axios';
import { isDuplicateArticle, hashUrl } from './duplicateService';
import { hashTitle } from './duplicateService';
import { recordArticleDedupEntry } from './articleDedupService';
import { cleanHtmlContent, decodeBuffer } from '../utils/encodingUtils';
import { RuntimeFilters, RuntimeAiConfig } from '../types/runtime';
import { getDateRangeBounds } from './runtimeConfigService';
import { mapWithConcurrency } from '../utils/asyncUtils';
import { enrichArticleBody } from './articleContentFetchService';
import { checkKeywordFilter, matchTitleAgainstKeywords } from './globalKeywordService';

const REQUEST_TIMEOUT_MS = 45000;
const RSS_FETCH_TIMEOUT_MS = 60000;
const USER_AGENT = 'Mozilla/5.0 (compatible; NewsBot/1.0; +https://eumnews.com)';
const RSS_SOURCE_CONCURRENCY = 4;
const RSS_BODY_ENRICH_CONCURRENCY = 3;

const parser = new Parser({
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    'User-Agent': USER_AGENT,
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  },
  customFields: {
    item: [
      ['content:encoded', 'contentEncoded'],
      ['description', 'description'],
    ],
  },
});

interface ParsedArticle {
  title: string;
  url: string;
  content: string;
  publishedAt: Date;
}

function resolveKeywordFilter(article: ParsedArticle, source: any, sourceId: string) {
  return checkKeywordFilter(article.title, source.name, sourceId).then((kw) => {
    if (kw.passes) return kw;

    const sourceKeywords = Array.isArray(source.defaultKeywords) ? source.defaultKeywords : [];
    const sourceMatched = matchTitleAgainstKeywords(
      `${article.title || ''} ${article.content || ''}`,
      sourceKeywords,
    );
    if (sourceMatched) {
      return {
        passes: true,
        isBypassSource: false,
        matchedKeyword: sourceMatched,
      };
    }

    return kw;
  });
}

function preprocessXml(xml: string): string {
  return xml
    .replace(/&(?!(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)/gi, '&amp;')
    .replace(/<([a-zA-Z][a-zA-Z0-9_:-]*)([^>]*)>/g, (_m, tagName, rest) => {
      if (!rest || !rest.includes(' ')) return `<${tagName}${rest}>`;
      const fixedRest = rest.replace(
        /(\s+)([a-zA-Z][a-zA-Z0-9_:-]*)(?!\s*=)(?=\s|\/|$)/g,
        '$1$2=""',
      );
      return `<${tagName}${fixedRest}>`;
    });
}

async function fetchRssResponse(url: string, attempt = 1) {
  try {
    return await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 5,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });
  } catch (error: any) {
    const isTimeout = error?.code === 'ECONNABORTED' || `${error?.message || ''}`.includes('timeout');
    if (attempt < 3 && isTimeout) {
      console.warn(`RSS timeout for ${url}, retrying (${attempt}/2)`);
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      return fetchRssResponse(url, attempt + 1);
    }
    throw error;
  }
}

export async function fetchRssFeed(url: string): Promise<ParsedArticle[]> {
  const response = await fetchRssResponse(url);

  const buffer = Buffer.from(response.data);
  const contentType = response.headers['content-type'] || '';
  const xmlAscii = buffer.slice(0, 400).toString('ascii');
  const encDeclMatch = xmlAscii.match(/encoding=["']([^"']+)/i);
  const declaredEnc = encDeclMatch ? encDeclMatch[1].toLowerCase() : '';

  const rawXml = decodeBuffer(buffer, declaredEnc || undefined, contentType);
  const fixedXml = preprocessXml(rawXml);

  let feed: any;
  try {
    feed = await parser.parseString(fixedXml);
  } catch (err: any) {
    console.error(`RSS parse failed for ${url}: ${err.message}`);
    throw new Error(`RSS parse failed for ${url}: ${err.message}`);
  }

  if (!feed?.items) return [];

  const articles: ParsedArticle[] = [];

  for (const item of feed.items) {
    if (!item.title || !item.link) continue;
    const pubDate = item.pubDate ? new Date(item.pubDate) : new Date();

    let title = item.title ? item.title.trim() : '';
    if (title.match(/[\uFFFD\u0080-\u009F]{3,}/)) {
      console.warn(`Skipping article with corrupted title: "${title.substring(0, 50)}"`);
      continue;
    }

    title = cleanHtmlContent(title);
    if (!title || title.length < 3) continue;

    let content = item.contentEncoded || item.description || item.content || '';
    content = cleanHtmlContent(content);

    articles.push({ title, url: item.link, content, publishedAt: pubDate });
  }

  return articles;
}

export async function processRssSources(options?: {
  companyId?: string;
  pipelineRunId?: string;
  filters?: RuntimeFilters;
  aiConfig?: RuntimeAiConfig;
}) {
  const db = admin.firestore();
  const { startDate, endDate } = getDateRangeBounds(options?.filters?.dateRange);

  const allSourcesToProcess: { id: string; data: any }[] = [];
  const requestedSourceIds = new Set((options?.filters?.sourceIds || []).filter(Boolean));
  const allRssSnap = await db.collection('globalSources')
    .where('type', '==', 'rss')
    .where('status', '==', 'active')
    .get();

  allRssSnap.docs.forEach((d) => {
    if (requestedSourceIds.size > 0 && !requestedSourceIds.has(d.id)) return;
    const data = d.data();
    const rssUrl = data.rssUrl || data.url;
    if (!rssUrl) return;
    allSourcesToProcess.push({
      id: d.id,
      data: { ...data, url: rssUrl, companyId: options?.companyId },
    });
  });

  console.log(`[RSS] Total sources to process: ${allSourcesToProcess.length}`);

  const results = await mapWithConcurrency(allSourcesToProcess, RSS_SOURCE_CONCURRENCY, async ({ id: sourceId, data: source }) => {
    const docRef = db.collection('globalSources').doc(sourceId);

    try {
      const articles = await Promise.race([
        fetchRssFeed(source.url || source.rssUrl),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`RSS fetch timeout after ${RSS_FETCH_TIMEOUT_MS / 1000}s`)), RSS_FETCH_TIMEOUT_MS)
        ),
      ]);

      const dateFiltered = articles.filter((article) => {
        if (startDate && article.publishedAt < startDate) return false;
        if (endDate && article.publishedAt > endDate) return false;
        return true;
      });

      // 제목 키워드 필터를 본문 fetch 전에 적용 → 불필요한 HTTP 요청 절감
      // checkKeywordFilter: 통과 여부 + bypass/매칭키워드 함께 반환 (수집 시 status 결정용)
      const keywordResults = await Promise.all(
        dateFiltered.map(async (article) => ({
          article,
          kw: await resolveKeywordFilter(article, source, sourceId),
        }))
      );
      const keywordFiltered = keywordResults.filter(({ kw }) => kw.passes);

      if (keywordFiltered.length < dateFiltered.length) {
        console.log(`[RSS] ${source.name}: title filter ${dateFiltered.length} → ${keywordFiltered.length} (${dateFiltered.length - keywordFiltered.length} skipped)`);
      }

      const enrichedArticles = await mapWithConcurrency(
        keywordFiltered,
        RSS_BODY_ENRICH_CONCURRENCY,
        async ({ article, kw }) => ({ enriched: await enrichArticleBody(article), kw }),
      );

      if (enrichedArticles.length === 0) {
        console.log(`[RSS] ${source.name}: no articles in date range`);
        await docRef.update({
          lastScrapedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastStatus: 'success',
          errorMessage: null,
        });
        return 0;
      }

      const batchSize = 500;
      let sourceCollected = 0;

      for (let i = 0; i < enrichedArticles.length; i += batchSize) {
        const chunk = enrichedArticles.slice(i, Math.min(i + batchSize, enrichedArticles.length));
        const dupChecks = await Promise.all(
          chunk.map(({ enriched }) => isDuplicateArticle(enriched, {
            companyId: source.companyId || options?.companyId,
            fastMode: true,
          }))
        );

        const batch = db.batch();
        const dedupWrites: Promise<any>[] = [];
        dupChecks.forEach((check, idx) => {
          if (check.isDuplicate) return;
          const { enriched: article, kw } = chunk[idx];

          // 키워드 필터 통과 기사: AI 관련도 필터 생략하고 바로 filtered 저장
          // → processDeepAnalysis가 직접 심층 분석 (GLM 호출 1회로 절약)
          const initialStatus = 'pending';
          const relevanceFields = {
            filteredAt: admin.firestore.FieldValue.serverTimestamp(),
            relevanceBasis: kw.isBypassSource ? 'priority_source_bypass' : 'keyword_prefilter',
            relevanceScore: kw.isBypassSource ? 100 : 80,
            relevanceConfidence: kw.isBypassSource ? 1.0 : 0.9,
            relevanceReason: kw.isBypassSource
              ? `우선 매체 (${source.name}) - 전량 수집`
              : `제목 키워드 매칭: "${kw.matchedKeyword}"`,
            keywordMatched: kw.matchedKeyword || null,
            priorityAnalysis: kw.isBypassSource,
            keywordPrefilterReason: kw.isBypassSource ? '우선 매체 수집' : `제목 키워드 매칭: "${kw.matchedKeyword}"`,
            collectedByKeywordFilter: true,
          };

          const articleRef = db.collection('articles').doc();
          batch.set(articleRef, {
            id: articleRef.id,
            ...article,
            companyId: source.companyId || options?.companyId || null,
            pipelineRunId: options?.pipelineRunId || null,
            source: source.name,
            sourceId,
            globalSourceId: sourceId,
            sourceCategory: source.category || null,
            sourcePricingTier: source.pricingTier || 'free',
            collectedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: initialStatus,
            urlHash: hashUrl(article.url),
            titleHash: hashTitle(article.title),
            ...relevanceFields,
          });
          dedupWrites.push(recordArticleDedupEntry({
            id: articleRef.id,
            ...article,
            companyId: source.companyId || options?.companyId || null,
            sourceId,
            globalSourceId: sourceId,
            source: source.name,
            status: initialStatus,
            collectedAt: new Date(),
          }));
          sourceCollected++;
        });

        await batch.commit();
        await Promise.all(dedupWrites);
      }

      await docRef.update({
        lastScrapedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastStatus: 'success',
        errorMessage: null,
      });

      console.log(`[RSS] ${source.name}: +${sourceCollected} articles`);
      return sourceCollected;
    } catch (error: any) {
      await docRef.update({ lastStatus: 'error', errorMessage: error.message }).catch(() => {});
      console.error(`[RSS] ${source.name} error: ${error.message}`);
      return 0;
    }
  });

  const totalCollected = results.reduce((sum, value) => sum + value, 0);
  return { success: true, totalCollected };
}
