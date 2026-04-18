import * as admin from 'firebase-admin';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { isDuplicateArticle, hashTitle, hashUrl } from './duplicateService';
import { recordArticleDedupEntry } from './articleDedupService';
import { decodeBuffer, cleanHtmlContent } from '../utils/encodingUtils';
import { extractTextFromHtml } from '../utils/textUtils';
import { RuntimeAiConfig, RuntimeFilters } from '../types/runtime';
import { getDateRangeBounds } from './runtimeConfigService';
import { mapWithConcurrency } from '../utils/asyncUtils';
import { checkKeywordFilter } from './globalKeywordService';

const REQUEST_TIMEOUT_MS = 15000;
const USER_AGENT = 'Mozilla/5.0 (compatible; NewsBot/1.0; +https://eumnews.com)';
const MAX_SCRAPING_ITEMS = 30;
const SCRAPING_SOURCE_CONCURRENCY = 2;

interface ScrapedArticle {
  title: string;
  url: string;
  content: string;
  publishedAt: Date;
}

interface ScrapingSource {
  id: string;
  name: string;
  url: string;
  category?: string;
  listSelector?: string;
  titleSelector?: string;
  linkSelector?: string;
  contentSelector?: string;
  dateSelector?: string;
  loginRequired?: boolean;
}

async function fetchHtml(url: string): Promise<string> {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  return decodeBuffer(Buffer.from(response.data), undefined, response.headers['content-type'] || '');
}

function toAbsoluteUrl(baseUrl: string, href?: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function parsePublishedAt(rawValue?: string): Date {
  if (!rawValue) return new Date();
  const normalized = rawValue.replace(/\./g, '-').replace(/\//g, '-').trim();
  const parsed = new Date(normalized);
  if (!isNaN(parsed.getTime())) return parsed;
  return new Date();
}

async function scrapeSourceArticles(source: ScrapingSource): Promise<ScrapedArticle[]> {
  if (source.loginRequired) {
    throw new Error(`Scraping source '${source.name}' requires login and is not supported by the HTTP scraper.`);
  }
  if (!source.listSelector || !source.titleSelector || !source.linkSelector) {
    throw new Error(`Scraping source '${source.name}' is missing required selectors.`);
  }

  const listHtml = await fetchHtml(source.url);
  const $ = cheerio.load(listHtml);
  const items = $(source.listSelector).slice(0, MAX_SCRAPING_ITEMS).toArray();

  const articles = await Promise.all(items.map(async (item) => {
    const itemNode = $(item);
    const titleNode = itemNode.find(source.titleSelector!).first();
    const linkNode = itemNode.find(source.linkSelector!).first();

    const title = cleanHtmlContent(titleNode.text() || '').trim();
    const url = toAbsoluteUrl(source.url, linkNode.attr('href'));
    if (!title || !url) return null;

    const dateText = source.dateSelector
      ? cleanHtmlContent(itemNode.find(source.dateSelector).first().text() || '').trim()
      : '';
    let content = '';

    try {
      const articleHtml = await fetchHtml(url);
      if (source.contentSelector) {
        const article$ = cheerio.load(articleHtml);
        const selected = article$(source.contentSelector).first();
        content = cleanHtmlContent(selected.html() || selected.text() || '');
      }
      if (!content) {
        content = extractTextFromHtml(articleHtml, url);
      }
    } catch (error: any) {
      console.warn(`[Scraping] Failed to fetch article body for ${url}: ${error.message}`);
    }

    return {
      title,
      url,
      content: content.trim(),
      publishedAt: parsePublishedAt(dateText),
    } satisfies ScrapedArticle;
  }));

  return articles.filter((article): article is ScrapedArticle => Boolean(article));
}

export async function processScrapingSources(options?: {
  companyId?: string;
  pipelineRunId?: string;
  filters?: RuntimeFilters;
  aiConfig?: RuntimeAiConfig;
}) {
  const db = admin.firestore();
  const { startDate, endDate } = getDateRangeBounds(options?.filters?.dateRange);

  const snap = await db.collection('globalSources')
    .where('type', '==', 'scraping')
    .where('status', '==', 'active')
    .get();
  const requestedSourceIds = new Set((options?.filters?.sourceIds || []).filter(Boolean));

  const allScrapingSources = snap.docs.map((doc) => ({
    id: doc.id,
    data: doc.data(),
  })).filter((source) => requestedSourceIds.size === 0 || requestedSourceIds.has(source.id));

  if (allScrapingSources.length === 0) {
    console.log('processScrapingSources: no active scraping sources found.');
    return { success: true, totalCollected: 0 };
  }

  const results = await mapWithConcurrency(allScrapingSources, SCRAPING_SOURCE_CONCURRENCY, async ({ id: sourceId, data }) => {
    const source = data as ScrapingSource & { category?: string };
    const docRef = db.collection('globalSources').doc(sourceId);

    try {
      const articles = await scrapeSourceArticles({ ...source, id: sourceId });
      const validArticles = articles.filter((article) => {
        if (startDate && article.publishedAt < startDate) return false;
        if (endDate && article.publishedAt > endDate) return false;
        return true;
      });

      let sourceCollected = 0;
      for (const article of validArticles) {
        const dupCheck = await isDuplicateArticle(article, {
          companyId: options?.companyId,
          aiConfig: options?.aiConfig,
          fastMode: true,
        });
        if (dupCheck.isDuplicate) continue;
        // 제목 키워드 필터: 매칭 안 되면 DB 미기록
        const kw = await checkKeywordFilter(article.title, source.name, sourceId);
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
          source: source.name,
          sourceId,
          globalSourceId: sourceId,
          sourceCategory: source.category || null,
          sourcePricingTier: (data as any).pricingTier || 'free',
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
          source: source.name,
          status: 'pending',
          collectedAt: new Date(),
        });
        sourceCollected++;
      }

      await docRef.update({
        lastScrapedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastStatus: 'success',
        errorMessage: null,
      });

      console.log(`[Scraping] ${source.name}: +${sourceCollected} articles`);
      return sourceCollected;
    } catch (error: any) {
      await docRef.update({
        lastStatus: 'error',
        errorMessage: error.message,
      }).catch(() => {});
      console.error(`[Scraping] ${source.name} error: ${error.message}`);
      return 0;
    }
  });

  const totalCollected = results.reduce((sum, value) => sum + value, 0);
  return { success: true, totalCollected };
}

export async function testScrapingSource(source: ScrapingSource): Promise<{
  success: boolean;
  message: string;
  articlesFound?: number;
  latencyMs?: number;
  sampleTitles?: string[];
}> {
  const startMs = Date.now();

  try {
    const articles = await scrapeSourceArticles(source);
    return {
      success: articles.length > 0,
      message: articles.length > 0
        ? `OK - ${articles.length} scraping articles found`
        : 'Scraping page loaded but no articles matched the selectors',
      articlesFound: articles.length,
      latencyMs: Date.now() - startMs,
      sampleTitles: articles.slice(0, 3).map((article) => article.title),
    };
  } catch (error: any) {
    return {
      success: false,
      message: error.message || 'Scraping test failed',
      latencyMs: Date.now() - startMs,
    };
  }
}
