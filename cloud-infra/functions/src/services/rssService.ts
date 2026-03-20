import Parser from 'rss-parser';
import * as admin from 'firebase-admin';
import { isDuplicateArticle, hashUrl } from './duplicateService';
import { sendErrorNotificationToAdmin } from './telegramService';
import { cleanHtmlContent, fixEncodingIssues } from '../utils/encodingUtils';
import { matchesRuntimeFilters } from '../utils/textUtils';
import { RuntimeFilters } from '../types/runtime';
import { getDateRangeBounds } from './runtimeConfigService';
import { enrichArticles } from './scrapingService';
import { RuntimeAiConfig } from '../types/runtime';

const REQUEST_TIMEOUT_MS = 15000;
const USER_AGENT = 'Mozilla/5.0 (compatible; NewsBot/1.0; +https://eumnews.com)';

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
      ['description', 'description']
    ]
  }
});

interface ParsedArticle {
  title: string;
  url: string;
  content: string;
  publishedAt: Date;
}

/**
 * 한국 RSS 피드에서 자주 발생하는 비표준 XML 문제를 수정합니다.
 *
 * 수정 항목:
 *  1. Bare & 엔티티 (e.g. "M&A" → "M&amp;A")
 *  2. 값 없는 HTML 불리언 속성 (e.g. <img loading> → <img loading="">)
 *     서울경제, 매일경제 등의 RSS가 HTML 태그를 그대로 삽입하는 경우 발생
 */
function preprocessXml(xml: string): string {
  return xml
    // 1. Fix bare & entities
    .replace(/&(?!(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)/gi, '&amp;')
    // 2. Fix HTML boolean/valueless attributes inside tags
    //    Matches: whitespace + attrName (not followed by =) + (whitespace | / | end-of-attrs)
    .replace(/<([a-zA-Z][a-zA-Z0-9_:-]*)([^>]*)>/g, (_m, tagName, rest) => {
      if (!rest || !rest.includes(' ')) return `<${tagName}${rest}>`;
      const fixedRest = rest.replace(
        /(\s+)([a-zA-Z][a-zA-Z0-9_:-]*)(?!\s*=)(?=\s|\/|$)/g,
        '$1$2=""',
      );
      return `<${tagName}${fixedRest}>`;
    });
}

/**
 * RSS 피드를 가져옵니다. 파싱 오류 시 XML 전처리 후 재시도합니다.
 * 한국 뉴스 RSS 피드의 비표준 XML 엔티티 문제를 처리합니다.
 */
export async function fetchRssFeed(url: string): Promise<ParsedArticle[]> {
  let feed: any;

  try {
    // 1차 시도: 일반 파싱
    feed = await parser.parseURL(url);
  } catch (firstError: any) {
    // 2차 시도: 수동 fetch + XML 전처리 후 재파싱
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const response = await fetch(url, {
        signal: controller.signal as any,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
          'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        }
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const rawXml = await response.text();
      const fixedXml = preprocessXml(rawXml);
      feed = await parser.parseString(fixedXml);
      console.log(`RSS fallback parsing succeeded for ${url}`);
    } catch (secondError: any) {
      throw new Error(`RSS parse failed [${firstError.message}] | Fallback: [${secondError.message}]`);
    }
  }

  if (!feed?.items) return [];

  const articles: ParsedArticle[] = [];

  for (const item of feed.items) {
    const pubDate = item.pubDate ? new Date(item.pubDate) : new Date();
    if (!item.title || !item.link) continue;

    let content = item.contentEncoded || item.description || item.content || '';
    content = fixEncodingIssues(content);
    content = cleanHtmlContent(content);

    articles.push({
      title: fixEncodingIssues(item.title || ''),
      url: item.link,
      content,
      publishedAt: pubDate
    });
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

  // ── 소스 목록 수집: legacy sources + globalSources 구독 모두 처리
  const allSourcesToProcess: { id: string; data: any; isGlobal: boolean }[] = [];

  // 1) Legacy company-specific sources
  let legacyQuery: FirebaseFirestore.Query = db.collection('sources')
    .where('type', '==', 'rss')
    .where('active', '==', true);

  if (options?.companyId) {
    legacyQuery = legacyQuery.where('companyId', '==', options.companyId);
  }

  const legacySnap = await legacyQuery.get();
  legacySnap.docs.forEach(d => allSourcesToProcess.push({ id: d.id, data: d.data(), isGlobal: false }));

  // 2) GlobalSources (구독 sourceIds 기반)
  const subscribedIds = options?.filters?.sourceIds ?? [];
  if (subscribedIds.length > 0) {
    // Firestore 'in' 최대 30개씩 배치
    const chunks: string[][] = [];
    for (let i = 0; i < subscribedIds.length; i += 30) chunks.push(subscribedIds.slice(i, i + 30));

    for (const chunk of chunks) {
      const globalSnap = await db.collection('globalSources')
        .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
        .where('type', '==', 'rss')
        .where('status', '==', 'active')
        .get();
      globalSnap.docs.forEach(d => {
        const data = d.data();
        // 이미 legacy에 있는 ID 제외
        if (!allSourcesToProcess.find(s => s.id === d.id)) {
          allSourcesToProcess.push({
            id: d.id,
            data: { ...data, url: data.rssUrl || data.url, companyId: options?.companyId },
            isGlobal: true,
          });
        }
      });
    }
  }

  let totalCollected = 0;

  for (const { id: sourceId, data: source, isGlobal } of allSourcesToProcess) {
    const docRef = isGlobal
      ? db.collection('globalSources').doc(sourceId)
      : db.collection('sources').doc(sourceId);

    try {
      const baseArticles = await fetchRssFeed(source.url || source.rssUrl);
      const articles = await enrichArticles(baseArticles); // [ADD] 본문 강화 루팈
      let sourceCollected = 0;

      for (const article of articles) {
        if (startDate && article.publishedAt < startDate) continue;
        if (endDate && article.publishedAt > endDate) continue;

        const anyKeywords = [
          ...(source.keywords || source.defaultKeywords || []),
          ...(options?.filters?.keywords || [])
        ];

        if (!matchesRuntimeFilters(article.title, article.content, {
          anyKeywords,
          includeKeywords: options?.filters?.includeKeywords,
          excludeKeywords: options?.filters?.excludeKeywords,
          sectors: options?.filters?.sectors
        })) {
          continue;
        }

        const dupCheck = await isDuplicateArticle(article, {
          companyId: source.companyId || options?.companyId,
          aiConfig: options?.aiConfig
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
          globalSourceId: isGlobal ? sourceId : null,
          sourceCategory: source.category || null,
          collectedAt: admin.firestore.FieldValue.serverTimestamp(),
          status: 'pending',
          urlHash: hashUrl(article.url)
        });

        sourceCollected++;
        totalCollected++;
      }

      await docRef.update({
        lastScrapedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastStatus: 'success',
        errorMessage: null
      });

      console.log(`Processed ${sourceCollected} new RSS articles from ${source.name}${isGlobal ? ' [global]' : ''}`);
    } catch (error: any) {
      await docRef.update({
        lastStatus: 'error',
        errorMessage: error.message
      }).catch(() => {});
      await sendErrorNotificationToAdmin('RSS collection failed', error.message, source.name);
    }
  }

  return { success: true, totalCollected };
}
