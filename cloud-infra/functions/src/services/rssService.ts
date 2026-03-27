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
import { titlePassesGlobalKeywordFilter } from './globalKeywordService';

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
  const allRssSnap = await db.collection('globalSources')
    .where('type', '==', 'rss')
    .where('status', '==', 'active')
    .get();

  allRssSnap.docs.forEach((d) => {
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

      const validArticles = articles.filter((article) => {
        if (startDate && article.publishedAt < startDate) return false;
        if (endDate && article.publishedAt > endDate) return false;
        return true;
      });

      const enrichedArticles = await mapWithConcurrency(
        validArticles,
        RSS_BODY_ENRICH_CONCURRENCY,
        async (article) => enrichArticleBody(article),
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
          chunk.map((article) => isDuplicateArticle(article, {
            companyId: source.companyId || options?.companyId,
            fastMode: true,
          }))
        );

        const batch = db.batch();
        const dedupWrites: Promise<any>[] = [];
        const keywordChecks = await Promise.all(
          chunk.map((article, idx) =>
            dupChecks[idx].isDuplicate
              ? Promise.resolve(false)
              : titlePassesGlobalKeywordFilter(article.title, source.name, sourceId)
          )
        );
        dupChecks.forEach((check, idx) => {
          if (check.isDuplicate) return;
          if (!keywordChecks[idx]) return; // 제목 키워드 미매칭 → DB 미기록
          const article = chunk[idx];
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
            status: 'pending',
            urlHash: hashUrl(article.url),
            titleHash: hashTitle(article.title),
          });
          dedupWrites.push(recordArticleDedupEntry({
            id: articleRef.id,
            ...article,
            companyId: source.companyId || options?.companyId || null,
            sourceId,
            globalSourceId: sourceId,
            source: source.name,
            status: 'pending',
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
