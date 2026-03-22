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

  // 복합 인덱스 문제 회피: documentId()만으로 쿼리, type/status는 코드 필터링
  // Firestore in-query 제한: 최대 10개씩 청크
  const allApiSources: { id: string; data: any }[] = [];
  for (let i = 0; i < subscribedIds.length; i += 10) {
    const chunk = subscribedIds.slice(i, i + 10);
    const snap = await db.collection('globalSources')
      .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
      .get();
    snap.docs.forEach(d => {
      const data = d.data();
      if (data.type === 'api' && data.status === 'active') {
        allApiSources.push({ id: d.id, data });
      }
    });
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

      if (source.apiType === 'naver') {
        collected = await collectFromNaverNews(source, sourceId, options, startDate, endDate);
      } else if (source.apiEndpoint?.includes('newsapi.org')) {
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

  // ★ source.defaultKeywords를 수집 pre-filter로 사용하지 않음 → AI가 관련성 판단
  const anyKeywords: string[] = [
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
      mustIncludeKeywords: options?.filters?.mustIncludeKeywords,
      excludeKeywords: options?.filters?.excludeKeywords,
      sectors: options?.filters?.sectors,
    })) {
      continue;
    }

    // ★ 수집 중 AI 중복 체크 비활성화 (API 쿼터 보존) → URL 해시 매칭만
    const dupCheck = await isDuplicateArticle(
      { title, url: item.url, content, publishedAt },
      { companyId: options?.companyId },
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

// ─────────────────────────────────────────
// 네이버 뉴스 검색 API collector
// 자격증명은 Firestore systemSettings/naverConfig 에 저장
// ─────────────────────────────────────────

function cleanNaverHtml(text: string): string {
  return (text || '')
    .replace(/<\/?b>/gi, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

async function collectFromNaverNews(
  source: any,
  sourceId: string,
  options: { companyId?: string; pipelineRunId?: string; filters?: RuntimeFilters; aiConfig?: RuntimeAiConfig } | undefined,
  startDate: Date | null,
  endDate: Date | null,
): Promise<number> {
  const db = admin.firestore();

  // Read credentials from systemSettings/naverConfig
  const cfgDoc = await db.collection('systemSettings').doc('naverConfig').get();
  const cfg = cfgDoc.exists ? (cfgDoc.data() as any) : {};
  const clientId = cfg.clientId;
  const clientSecret = cfg.clientSecret;
  if (!clientId || !clientSecret) {
    throw new Error('네이버 API 자격증명 미설정 — 슈퍼어드민 > AI 설정 > 네이버 뉴스 탭에서 저장하세요.');
  }

  // ★ source.defaultKeywords를 수집 pre-filter로 사용하지 않음 → AI가 관련성 판단
  const keywords: string[] = [
    ...(options?.filters?.keywords || []),
  ];
  if (keywords.length === 0) keywords.push('M&A', '인수합병', '스타트업 투자');

  // Collect articles per keyword (Naver doesn't support OR logic well)
  const seenUrls = new Set<string>();
  const candidates: Array<{ title: string; url: string; content: string; publishedAt: Date }> = [];

  for (const kw of keywords.slice(0, 8)) {
    try {
      const resp = await axios.get('https://openapi.naver.com/v1/search/news.json', {
        headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret },
        params: { query: kw, display: 100, start: 1, sort: 'date' },
        timeout: 10000,
      });
      for (const item of resp.data.items || []) {
        if (!item.title || !item.originallink) continue;
        const url = item.originallink;
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
  for (const article of candidates) {
    if (!matchesRuntimeFilters(article.title, article.content, {
      anyKeywords: keywords,
      includeKeywords: options?.filters?.includeKeywords,
      mustIncludeKeywords: options?.filters?.mustIncludeKeywords,
      excludeKeywords: options?.filters?.excludeKeywords,
      sectors: options?.filters?.sectors,
    })) continue;

    // URL-level dedup (skip AI content dedup — Naver articles overlap by design)
    const dupCheck = await isDuplicateArticle(article, { companyId: options?.companyId });
    if (dupCheck.isDuplicate) continue;

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
      collectedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'pending',
      urlHash: hashUrl(article.url),
    });
    collected++;
  }

  console.log(`Naver News: saved ${collected} / ${candidates.length} articles`);
  return collected;
}
