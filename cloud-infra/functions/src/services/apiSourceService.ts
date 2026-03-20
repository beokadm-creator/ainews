import * as admin from 'firebase-admin';
import axios from 'axios';
import { isDuplicateArticle, hashUrl } from './duplicateService';
import { sendErrorNotificationToAdmin } from './telegramService';
import { cleanHtmlContent, fixEncodingIssues } from '../utils/encodingUtils';
import { matchesRuntimeFilters } from '../utils/textUtils';
import { RuntimeFilters, RuntimeAiConfig } from '../types/runtime';
import { getDateRangeBounds } from './runtimeConfigService';

// ─────────────────────────────────────────
// NewsAPI response types
// ─────────────────────────────────────────

interface NewsApiSource {
  id: string | null;
  name: string;
}

interface NewsApiArticle {
  title: string;
  url: string;
  description: string | null;
  content: string | null;
  publishedAt: string;
  source: NewsApiSource;
  author: string | null;
}

interface NewsApiResponse {
  status: string;
  totalResults: number;
  articles: NewsApiArticle[];
  message?: string;
  code?: string;
}

// ─────────────────────────────────────────
// Main pipeline entry point
// ─────────────────────────────────────────

export async function processApiSources(options?: {
  companyId?: string;
  pipelineRunId?: string;
  filters?: RuntimeFilters;
  aiConfig?: RuntimeAiConfig;
}) {
  const db = admin.firestore();
  const { startDate, endDate } = getDateRangeBounds(options?.filters?.dateRange);

  const subscribedIds = options?.filters?.sourceIds ?? [];
  if (subscribedIds.length === 0) {
    console.log('processApiSources: no subscribed source IDs, skipping.');
    return { success: true, totalCollected: 0 };
  }

  // Batch Firestore 'in' queries (max 30 per query)
  const allApiSources: { id: string; data: any }[] = [];
  for (let i = 0; i < subscribedIds.length; i += 30) {
    const chunk = subscribedIds.slice(i, i + 30);
    const snap = await db.collection('globalSources')
      .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
      .where('type', '==', 'api')
      .where('status', '==', 'active')
      .get();
    snap.docs.forEach(d => allApiSources.push({ id: d.id, data: d.data() }));
  }

  if (allApiSources.length === 0) {
    console.log('processApiSources: no active API-type sources in subscriptions.');
    return { success: true, totalCollected: 0 };
  }

  let totalCollected = 0;

  for (const { id: sourceId, data: source } of allApiSources) {
    const docRef = db.collection('globalSources').doc(sourceId);
    try {
      let collected = 0;

      if (source.apiEndpoint?.includes('newsapi.org')) {
        collected = await collectFromNewsApi(source, sourceId, options, startDate, endDate);
      } else {
        console.log(`processApiSources: unsupported API source '${source.name}', skipping.`);
        continue;
      }

      totalCollected += collected;

      await docRef.update({
        lastScrapedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastStatus: 'success',
        errorMessage: null,
      });

      console.log(`Processed ${collected} new API articles from ${source.name}`);
    } catch (error: any) {
      await docRef.update({
        lastStatus: 'error',
        errorMessage: error.message,
      }).catch(() => {});
      await sendErrorNotificationToAdmin('API collection failed', error.message, source.name);
    }
  }

  return { success: true, totalCollected };
}

// ─────────────────────────────────────────
// NewsAPI collector
// ─────────────────────────────────────────

async function collectFromNewsApi(
  source: any,
  sourceId: string,
  options: { companyId?: string; pipelineRunId?: string; filters?: RuntimeFilters; aiConfig?: RuntimeAiConfig } | undefined,
  startDate: Date | null,
  endDate: Date | null,
): Promise<number> {
  const db = admin.firestore();

  const envVarName = source.apiKeyEnvName || 'NEWSAPI_KEY';
  const apiKey = process.env[envVarName];
  if (!apiKey) {
    throw new Error(`NewsAPI key not found — set env var '${envVarName}' in Cloud Functions`);
  }

  const anyKeywords: string[] = [
    ...(source.defaultKeywords || []),
    ...(options?.filters?.keywords || []),
  ];

  // NewsAPI supports OR logic; quote multi-word terms
  const searchTerms = anyKeywords.length > 0
    ? anyKeywords.slice(0, 6).map(k => (k.includes(' ') ? `"${k}"` : k)).join(' OR ')
    : '"M&A" OR "merger" OR "acquisition" OR "private equity"';

  const from = startDate
    ? startDate.toISOString().split('T')[0]
    : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const params: Record<string, string | number> = {
    q: searchTerms,
    language: 'en',
    sortBy: 'publishedAt',
    pageSize: 100,
    apiKey,
    from,
  };

  const response = await axios.get<NewsApiResponse>(
    source.apiEndpoint || 'https://newsapi.org/v2/everything',
    { params, timeout: 15000 },
  );

  if (response.data.status !== 'ok') {
    throw new Error(`NewsAPI error: ${response.data.code} — ${response.data.message}`);
  }

  const rawArticles = response.data.articles || [];
  let collected = 0;

  for (const item of rawArticles) {
    if (!item.title || !item.url) continue;
    if (item.title === '[Removed]') continue;

    const publishedAt = item.publishedAt ? new Date(item.publishedAt) : new Date();
    if (startDate && publishedAt < startDate) continue;
    if (endDate && publishedAt > endDate) continue;

    const title = fixEncodingIssues(item.title);
    const rawContent = [item.description, item.content].filter(Boolean).join(' ');
    const content = cleanHtmlContent(fixEncodingIssues(rawContent));

    if (!matchesRuntimeFilters(title, content, {
      anyKeywords,
      includeKeywords: options?.filters?.includeKeywords,
      excludeKeywords: options?.filters?.excludeKeywords,
      sectors: options?.filters?.sectors,
    })) {
      continue;
    }

    const dupCheck = await isDuplicateArticle(
      { title, url: item.url, content, publishedAt },
      { companyId: options?.companyId, aiConfig: options?.aiConfig },
    );
    if (dupCheck.isDuplicate) continue;

    const articleRef = db.collection('articles').doc();
    await articleRef.set({
      id: articleRef.id,
      title,
      url: item.url,
      content,
      publishedAt,
      companyId: options?.companyId || null,
      pipelineRunId: options?.pipelineRunId || null,
      source: source.name,
      sourceId,
      globalSourceId: sourceId,
      sourceCategory: source.category || null,
      collectedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'pending',
      urlHash: hashUrl(item.url),
    });

    collected++;
  }

  console.log(`NewsAPI: saved ${collected} / ${rawArticles.length} articles (query: "${searchTerms}")`);
  return collected;
}
