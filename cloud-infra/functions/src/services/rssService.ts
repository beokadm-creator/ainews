import Parser from 'rss-parser';
import * as admin from 'firebase-admin';
import axios from 'axios';
import { isDuplicateArticle, hashUrl } from './duplicateService';
import { sendErrorNotificationToAdmin } from './telegramService';
import { cleanHtmlContent, decodeBuffer } from '../utils/encodingUtils';
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
  // Always fetch with axios to control encoding at byte level
  // This correctly handles EUC-KR feeds (연합뉴스 등) that report wrong charset
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  const buffer = Buffer.from(response.data);
  const contentType = response.headers['content-type'] || '';

  // XML encoding declaration is the most reliable source for RSS/XML files
  // e.g. <?xml version="1.0" encoding="EUC-KR"?>
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

    // Clean title: strip any HTML tags and decode entities
    let title = item.title ? item.title.trim() : '';

    // Skip articles with severely corrupted titles (detect broken UTF-8)
    // Patterns: too many consecutive mojibake characters (U+FFFD, control chars, etc.)
    if (title.match(/[\uFFFD\u0080-\u009F]{3,}/)) {
      console.warn(`Skipping article with corrupted title: "${title.substring(0, 50)}"`);
      continue;
    }

    title = cleanHtmlContent(title);

    // Skip if title is empty after cleaning or too short
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

  // ── 소스 목록 수집: globalSources만 사용 (슈퍼어드민이 관리, 회사는 구독으로 조회)
  const allSourcesToProcess: { id: string; data: any; isGlobal: boolean }[] = [];

  // 1) 구독된 sourceIds가 있으면 해당 소스만 조회
  // 2) 없으면 globalSources에서 모든 active RSS 소스를 조회
  const subscribedIds = options?.filters?.sourceIds ?? [];

  let globalQuery: FirebaseFirestore.Query;
  if (subscribedIds.length > 0) {
    // 구독 기반: documentId in-query (30개씩 청크)
    const chunks: string[][] = [];
    for (let i = 0; i < subscribedIds.length; i += 30) chunks.push(subscribedIds.slice(i, i + 30));

    for (const chunk of chunks) {
      const snap = await db.collection('globalSources')
        .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
        .get();
      snap.docs.forEach(d => {
        const data = d.data();
        if (data.type !== 'rss' || data.status !== 'active') return;
        if (allSourcesToProcess.find(s => s.id === d.id)) return;
        const rssUrl = data.rssUrl || data.url;
        if (!rssUrl) {
          console.warn(`[RSS] Skipping ${data.name}: no RSS URL configured`);
          return;
        }
        allSourcesToProcess.push({
          id: d.id,
          data: { ...data, url: rssUrl, companyId: options?.companyId },
          isGlobal: true,
        });
      });
    }
  } else {
    // 구독 없음: 모든 active RSS 소스
    const allRssSnap = await db.collection('globalSources')
      .where('type', '==', 'rss')
      .where('status', '==', 'active')
      .get();
    allRssSnap.docs.forEach(d => {
      const data = d.data();
      const rssUrl = data.rssUrl || data.url;
      if (!rssUrl) return;
      allSourcesToProcess.push({
        id: d.id,
        data: { ...data, url: rssUrl, companyId: options?.companyId },
        isGlobal: true,
      });
    });
  }

  console.log(`[RSS] Total sources to process: ${allSourcesToProcess.length}`);

  let totalCollected = 0;

  // ── 병렬 수집: 모든 소스를 동시에 처리 (순차 for → 병렬 Promise.allSettled) ──
  const perSourceResults = await Promise.allSettled(
    allSourcesToProcess.map(async ({ id: sourceId, data: source }) => {
      const docRef = db.collection('globalSources').doc(sourceId);

      try {
        const baseArticles = await fetchRssFeed(source.url || source.rssUrl);
        const articles = await enrichArticles(baseArticles);
        let sourceCollected = 0;

        for (const article of articles) {
          if (startDate && article.publishedAt < startDate) continue;
          if (endDate && article.publishedAt > endDate) continue;

          // ★ source.defaultKeywords를 수집 pre-filter로 사용하지 않음
          // → AI가 관련성 분류 단계에서 판단. 수집은 pipeline-level 강제 필터만 적용.
          if (!matchesRuntimeFilters(article.title, article.content, {
            anyKeywords: options?.filters?.keywords || [],
            includeKeywords: options?.filters?.includeKeywords,
            mustIncludeKeywords: options?.filters?.mustIncludeKeywords,
            excludeKeywords: options?.filters?.excludeKeywords,
            sectors: options?.filters?.sectors
          })) {
            continue;
          }

          // ★ 수집 중 AI 중복 체크 비활성화 (API 쿼터 보존) → URL 해시 매칭만
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
            globalSourceId: sourceId,  // 항상 globalSources에서 조회
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

        console.log(`[RSS] ${source.name}: +${sourceCollected}건`);
        return sourceCollected;
      } catch (error: any) {
        await docRef.update({ lastStatus: 'error', errorMessage: error.message }).catch(() => {});
        console.error(`[RSS] ${source.name} 오류: ${error.message}`);
        return 0;
      }
    })
  );

  for (const r of perSourceResults) {
    if (r.status === 'fulfilled') totalCollected += r.value;
  }

  return { success: true, totalCollected };
}
