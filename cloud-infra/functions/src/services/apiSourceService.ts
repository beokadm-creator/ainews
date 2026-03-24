import * as admin from 'firebase-admin';
import axios from 'axios';
import { isDuplicateArticle, hashUrl } from './duplicateService';
import { recordArticleDedupEntry } from './articleDedupService';
import { sendErrorNotificationToAdmin } from './telegramService';
import { cleanHtmlContent, fixEncodingIssues } from '../utils/encodingUtils';
import { RuntimeFilters, RuntimeAiConfig } from '../types/runtime';
import { getDateRangeBounds } from './runtimeConfigService';

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
    if (data.apiType !== 'naver') return true;

    const keywordCount = Array.isArray(data.defaultKeywords) ? data.defaultKeywords.length : 0;
    const hasEndpoint = !!(data.url || data.apiEndpoint);

    // Skip placeholder Naver sources that have no keywords and no endpoint metadata.
    return keywordCount > 0 || hasEndpoint;
  });

  if (filteredApiSources.length === 0) {
    console.log('processApiSources: no active API sources found.');
    return { success: true, totalCollected: 0, sourceResults: [] };
  }

  let totalCollected = 0;
  const sourceResults: Array<{ sourceId: string; name: string; collected: number; success: boolean; error?: string }> = [];

  for (const { id: sourceId, data: source } of filteredApiSources) {
    const docRef = db.collection('globalSources').doc(sourceId);
    try {
      let collected = 0;

      if (source.apiType === 'naver') {
        collected = await collectFromNaverNews(source, sourceId, options, startDate, endDate);
      } else {
        console.log(`processApiSources: unsupported API source '${source.name}', skipping.`);
        continue;
      }

      totalCollected += collected;
      sourceResults.push({
        sourceId,
        name: source.name || sourceId,
        collected,
        success: true,
      });

      await docRef.update({
        lastScrapedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastStatus: 'success',
        errorMessage: null,
      });

      console.log(`Processed ${collected} new API articles from ${source.name}`);
    } catch (error: any) {
      sourceResults.push({
        sourceId,
        name: source.name || sourceId,
        collected: 0,
        success: false,
        error: error.message || 'Unknown error',
      });
      await docRef.update({
        lastStatus: 'error',
        errorMessage: error.message,
      }).catch(() => {});
      await sendErrorNotificationToAdmin('API collection failed', error.message, source.name);
    }
  }

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
      const resp = await axios.get('https://openapi.naver.com/v1/search/news.json', {
        headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret },
        params: { query: kw, display: 100, start: 1, sort: 'date' },
        timeout: 10000,
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
  for (const article of candidates) {
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
      sourcePricingTier: source.pricingTier || 'free',
      collectedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'pending',
      urlHash: hashUrl(article.url),
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
