import * as cheerio from 'cheerio';
import axios from 'axios';
import * as admin from 'firebase-admin';
import { isDuplicateArticle, hashUrl } from './duplicateService';
import { sendErrorNotificationToAdmin } from './telegramService';
import {
  extractTextFromHtml,
  isContentSufficient,
  cleanNoise,
  matchesRuntimeFilters
} from '../utils/textUtils';
import { fixEncodingIssues, decodeBuffer } from '../utils/encodingUtils';
import { RuntimeFilters, RuntimeAiConfig } from '../types/runtime';
import { getDateRangeBounds } from './runtimeConfigService';

interface ScrapedArticle {
  title: string;
  url: string;
  content: string;
  publishedAt: Date;
}

interface DynamicSourceConfig {
  selector?: string;
  listSelector?: string;
  titleSelector?: string;
  linkSelector?: string;
  contentSelector?: string;
  dateSelector?: string;
  [key: string]: any;
}

const scraperMap: Record<string, (html: string, baseUrl: string) => ScrapedArticle[]> = {
  // ─── 한경 마이뉴스 (hankyung_ma) ──────────────────────────
  hankyung_ma: (html: string, baseUrl: string) => {
    const $ = cheerio.load(html);
    const articles: ScrapedArticle[] = [];

    $('.news-list li').each((_, element) => {
      const titleElement = $(element).find('h3.title a');
      const title = fixEncodingIssues(titleElement.text().trim());
      let url = titleElement.attr('href') || '';
      const summary = fixEncodingIssues($(element).find('.lead').text().trim());

      if (url.startsWith('/')) {
        const urlObj = new URL(baseUrl);
        url = `${urlObj.origin}${url}`;
      }

      if (title && url) {
        articles.push({
          title,
          url,
          content: summary,
          publishedAt: new Date()
        });
      }
    });

    return articles;
  },

  // ─── Default ──────────────────────────────────────────────
  default: (html: string, baseUrl: string) => {
    const $ = cheerio.load(html);
    const articles: ScrapedArticle[] = [];

    $('article, .article, .post, .news-item').each((_, element) => {
      const titleElement = $(element).find('h1, h2, h3, .title').find('a').first();
      if (!titleElement.length) return;

      const title = fixEncodingIssues(titleElement.text().trim());
      let url = titleElement.attr('href') || '';
      const content = fixEncodingIssues($(element).find('p, .summary, .description').text().trim());

      if (url.startsWith('/')) {
        const urlObj = new URL(baseUrl);
        url = `${urlObj.origin}${url}`;
      }

      if (title && url) {
        articles.push({
          title,
          url,
          content,
          publishedAt: new Date()
        });
      }
    });

    return articles;
  }
};

export async function enrichArticles(articles: ScrapedArticle[]): Promise<ScrapedArticle[]> {
  // 동시 요청 수 제한 (서버 부하 방지)
  const CONCURRENCY = 5;
  const results: ScrapedArticle[] = [...articles];

  for (let i = 0; i < articles.length; i += CONCURRENCY) {
    const chunk = articles.slice(i, i + CONCURRENCY);
    const enriched = await Promise.all(
      chunk.map(async (article, idx) => {
        if (isContentSufficient(article.content, 100)) {
          return article;
        }
        try {
          const articleResponse = await axios.get(article.url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 10000,
            responseType: 'arraybuffer'
          });
          const html = decodeBuffer(articleResponse.data, undefined, articleResponse.headers['content-type']);
          const fullContent = extractTextFromHtml(html);
          const cleanedContent = cleanNoise(fullContent);
          if (isContentSufficient(cleanedContent, 50)) {
            return { ...article, content: cleanedContent.substring(0, 5000) };
          }
        } catch {
          // 본문 스크래핑 실패 시 원본 유지 (에러 로그 생략 — 비핵심)
        }
        return article;
      })
    );
    enriched.forEach((a, idx) => { results[i + idx] = a; });
  }
  return results;
}

export async function scrapeWebsiteDynamic(url: string, source: DynamicSourceConfig): Promise<ScrapedArticle[]> {
  const response = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    timeout: 10000,
    responseType: 'arraybuffer'
  });

  const html = decodeBuffer(response.data, undefined, response.headers['content-type']);
  const $ = cheerio.load(html);
  const articles: ScrapedArticle[] = [];
  const listContainer = source.listSelector
    ? $(source.listSelector)
    : (source.selector ? $(source.selector) : $('article, .article, .post, .news-item'));

  listContainer.each((_, element) => {
    const titleEl = source.titleSelector
      ? $(element).find(source.titleSelector).first()
      : $(element).find('h1, h2, h3, .title').find('a').first();

    if (!titleEl.length) return;

    const title = fixEncodingIssues(titleEl.text().trim());
    let href = source.linkSelector
      ? ($(element).find(source.linkSelector).first().attr('href') || '')
      : (titleEl.attr('href') || '');

    const urlObj = new URL(url);
    if (href.startsWith('/')) href = `${urlObj.origin}${href}`;
    else if (!href.startsWith('http')) href = `${urlObj.origin}/${href.replace(/^\//, '')}`;

    const contentEl = source.contentSelector
      ? $(element).find(source.contentSelector)
      : $(element).find('p, .summary, .description');
    const content = fixEncodingIssues(contentEl.text().trim());

    let publishedAt = new Date();
    if (source.dateSelector) {
      const dateText = $(element).find(source.dateSelector).first().text().trim();
      const parsedDate = new Date(dateText);
      if (!isNaN(parsedDate.getTime())) publishedAt = parsedDate;
    }

    if (title && href) {
      articles.push({ title, url: href, content, publishedAt });
    }
  });

  return enrichArticles(articles);
}

export async function scrapeWebsite(url: string, sourceId: string): Promise<ScrapedArticle[]> {
  const response = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    timeout: 10000,
    responseType: 'arraybuffer'
  });

  const html = decodeBuffer(response.data, undefined, response.headers['content-type']);
  const scraper = scraperMap[sourceId] || scraperMap.default;
  const articles = scraper(html, url);
  return enrichArticles(articles);
}

export async function processScrapingSources(options?: {
  companyId?: string;
  pipelineRunId?: string;
  filters?: RuntimeFilters;
  aiConfig?: RuntimeAiConfig;
}) {
  const db = admin.firestore();
  const { startDate, endDate } = getDateRangeBounds(options?.filters?.dateRange);

  // ── 소스 목록 수집: globalSources만 사용 (슈퍼어드민이 관리, 회사는 구독으로 조회)
  const allSourcesToProcess: { id: string; data: any; isGlobal: boolean }[] = [];

  // 1) 구독된 sourceIds가 있으면 해당 소스만 조회
  // 2) 없으면 globalSources에서 모든 active scraping 소스를 조회
  const subscribedIds = options?.filters?.sourceIds ?? [];

  if (subscribedIds.length > 0) {
    const chunks: string[][] = [];
    for (let i = 0; i < subscribedIds.length; i += 30) chunks.push(subscribedIds.slice(i, i + 30));

    for (const chunk of chunks) {
      const globalSnap = await db.collection('globalSources')
        .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
        .get();
      globalSnap.docs.forEach(d => {
        const data = d.data();
        if (data.type !== 'scraping' || data.status !== 'active') return;
        if (allSourcesToProcess.find(s => s.id === d.id)) return;
        allSourcesToProcess.push({ id: d.id, data, isGlobal: true });
      });
    }
  } else {
    const allScrapingSnap = await db.collection('globalSources')
      .where('type', '==', 'scraping')
      .where('status', '==', 'active')
      .get();
    allScrapingSnap.docs.forEach(d => {
      const data = d.data();
      allSourcesToProcess.push({ id: d.id, data, isGlobal: true });
    });
  }

  let totalCollected = 0;

  // ── 병렬 수집 ──
  const perSourceResults = await Promise.allSettled(
    allSourcesToProcess.map(async ({ id: sourceId, data: source, isGlobal }) => {
      const docRef = db.collection('globalSources').doc(sourceId);

      try {
        let articles: any[] = [];
        // 더벨/마켓인사이트는 로컬 PC 스크래퍼에서 처리되므로 Firestore에서만 조회
        if (sourceId === 'thebell' || sourceId === 'marketinsight') {
          const snap = await db.collection('articles')
            .where('sourceId', '==', sourceId)
            .where('status', '==', 'pending')
            .limit(100)
            .get();
          articles = snap.docs.map(d => d.data());
        } else {
          articles = scraperMap[sourceId]
            ? await scrapeWebsite(source.url, sourceId)
            : await scrapeWebsiteDynamic(source.url, source);
        }

        let sourceCollected = 0;

        for (const article of articles) {
          if (startDate && article.publishedAt < startDate) continue;
          if (endDate && article.publishedAt > endDate) continue;

          // ★ source.keywords를 수집 pre-filter로 사용하지 않음 → AI가 관련성 판단
          if (!matchesRuntimeFilters(article.title, article.content, {
            anyKeywords: options?.filters?.keywords || [],
            includeKeywords: options?.filters?.includeKeywords,
            mustIncludeKeywords: options?.filters?.mustIncludeKeywords,
            excludeKeywords: options?.filters?.excludeKeywords,
            sectors: options?.filters?.sectors
          })) {
            continue;
          }

          // ★ 수집 중 AI 중복 체크 비활성화 (API 쿼터 보존)
          const dupCheck = await isDuplicateArticle(article, {
            companyId: source.companyId || options?.companyId,
          });
          if (dupCheck.isDuplicate) continue;

          const articleRef = db.collection('articles').doc();
          await articleRef.set({
            id: articleRef.id,
            ...article,
            companyId: source.companyId || options?.companyId || null,
            pipelineRunId: options?.pipelineRunId || null,
            source: source.name,
            sourceId,
            sourceCategory: source.category || null,
            collectedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: 'pending',
            urlHash: hashUrl(article.url)
          });

          sourceCollected++;
        }

        await docRef.update({
          lastScrapedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastStatus: 'success',
          errorMessage: null
        });

        console.log(`[Scraping] ${source.name}${isGlobal ? ' [global]' : ''}: +${sourceCollected}건`);
        return sourceCollected;
      } catch (error: any) {
        await docRef.update({ lastStatus: 'error', errorMessage: error.message }).catch(() => {});
        console.error(`[Scraping] ${source.name} 오류: ${error.message}`);
        return 0;
      }
    })
  );

  for (const r of perSourceResults) {
    if (r.status === 'fulfilled') totalCollected += r.value;
  }

  return { success: true, totalCollected };
}
