import Parser from 'rss-parser';
import * as admin from 'firebase-admin';
import { isDuplicateArticle, hashUrl } from './duplicateService';
import { sendErrorNotificationToAdmin } from './telegramService';
import { cleanHtmlContent, fixEncodingIssues } from '../utils/encodingUtils';
import { matchesRuntimeFilters } from '../utils/textUtils';
import { RuntimeFilters } from '../types/runtime';
import { getDateRangeBounds } from './runtimeConfigService';

const parser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; ainews-bot/1.0; +https://ainews.io)',
    'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8'
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

export async function fetchRssFeed(url: string): Promise<ParsedArticle[]> {
  const feed = await parser.parseURL(url);
  const articles: ParsedArticle[] = [];

  // 안전하게 feed.items 처리 (undefined/null 체크)
  if (!feed || !Array.isArray(feed.items)) {
    console.warn(`No items found in RSS feed: ${url}`);
    return articles;
  }

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
      const articles = await fetchRssFeed(source.url || source.rssUrl);
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
          companyId: source.companyId || options?.companyId
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
