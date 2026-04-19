import * as logger from 'firebase-functions/logger';
import * as admin from 'firebase-admin';
import { logPromptExecution, callAiProvider, resolveAiCallOptions } from './aiService';
import { RuntimeAiConfig } from '../types/runtime';

import { buildSafePrompt, parseAiJsonResponse } from '../utils/aiHelpers';

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    
    // 1. 네이버 뉴스 전용 처리
    if (parsed.hostname.includes('naver.com')) {
      const oid = parsed.searchParams.get('oid');
      const aid = parsed.searchParams.get('aid');
      if (oid && aid) return `${parsed.origin}${parsed.pathname}?oid=${oid}&aid=${aid}`;
    }

    // 2. 일반적인 트래킹 파라미터 제거 (utm_*, gclid, fbclid 등)
    const paramsToExclude = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid'];
    paramsToExclude.forEach(param => parsed.searchParams.delete(param));

    // 3. 파라미터 정렬 (순서가 달라도 동일 URL로 인식하게 함)
    parsed.searchParams.sort();

    // 4. 불필요한 해시 제거
    parsed.hash = '';

    return parsed.toString();
  } catch {
    return url;
  }
}

export function hashUrl(url: string): string {
  const normalized = normalizeUrl(url);
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

export function hashTitle(title: string): string {
  return title.replace(/\s+/g, '').toLowerCase().substring(0, 12);
}

export function calculateSimilarity(str1: string, str2: string): number {
  if (!str1 || !str2) return 0;

  const s1 = str1.replace(/\s+/g, '').toLowerCase();
  const s2 = str2.replace(/\s+/g, '').toLowerCase();

  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return 0;

  let matchCount = 0;
  for (let i = 0; i < s1.length - 1; i++) {
    const bigram = s1.substring(i, i + 2);
    if (s2.includes(bigram)) matchCount++;
  }

  return (2 * matchCount) / (s1.length + s2.length - 2);
}

export function calculateTokenSimilarity(str1: string, str2: string): number {
  const tokens1 = new Set(str1.toLowerCase().split(/\s+/).filter(Boolean));
  const tokens2 = new Set(str2.toLowerCase().split(/\s+/).filter(Boolean));
  if (tokens1.size === 0 || tokens2.size === 0) return 0;

  const intersection = [...tokens1].filter(token => tokens2.has(token));
  return intersection.length / Math.sqrt(tokens1.size * tokens2.size);
}

async function checkSemanticDuplicateWithAI(article1: any, article2: any, aiConfig: RuntimeAiConfig): Promise<boolean> {
  const instruction = `Determine if these two articles describe the exact same event or deal.
Return ONLY valid JSON in this format:
{
  "duplicate": true/false,
  "reason": "short reason"
}`;

  const contentStr = `Article A
Title: ${article1.title}
Content: ${(article1.content || '').substring(0, 300)}

Article B
Title: ${article2.title}
Content: ${(article2.content || '').substring(0, 300)}`;

  const prompt = buildSafePrompt(instruction, contentStr);

  try {
    const result = await callAiProvider(prompt, aiConfig, resolveAiCallOptions(aiConfig.provider, 'dedup'), undefined);
    const parsed = parseAiJsonResponse<{ duplicate: boolean; reason: string }>(result.content);
    await logPromptExecution('dedup-check', { title_a: article1.title, title_b: article2.title }, result.content, result.model);
    return Boolean(parsed?.duplicate);
  } catch (error) {
    logger.error('AI duplicate check failed:', error);
    return false;
  }
}

/**
 * Batch-fetch dedup ledger entries for multiple URL hashes in a single query.
 * Returns a map of urlHash → dedup document data (only for hashes that exist).
 * Use this before individual isDuplicateArticle calls to avoid N separate reads.
 */
export async function batchFetchDedupEntries(urlHashes: string[]): Promise<Map<string, any>> {
  const db = admin.firestore();
  const result = new Map<string, any>();
  if (urlHashes.length === 0) return result;
  const unique = [...new Set(urlHashes)];
  const CHUNK_SIZE = 10;
  for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
    const chunk = unique.slice(i, i + CHUNK_SIZE);
    const snap = await db.collection('articleDedup')
      .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
      .get();
    snap.docs.forEach((doc) => result.set(doc.id, doc.data()));
  }
  return result;
}

export async function isDuplicateArticle(
  newArticle: any,
  options?: { companyId?: string; aiConfig?: RuntimeAiConfig; fastMode?: boolean }
): Promise<{ isDuplicate: boolean; reason?: string; duplicateOf?: string }> {
  const db = admin.firestore();
  const normalizedUrl = normalizeUrl(newArticle.url);
  const urlHash = hashUrl(newArticle.url);
  const titleHash = hashTitle(newArticle.title);

  const dedupDoc = await db.collection('articleDedup').doc(urlHash).get();
  if (dedupDoc.exists) {
    const dedupData = dedupDoc.data() as any;
    // companyId 컨텍스트 없는 경우(글로벌) 또는 dedup 항목의 companyId가 현재 company와 일치하는 경우만 중복으로 판정
    // Note: dedupData.companyId가 없는 구형 항목은 per-company 컨텍스트에서 중복 판정하지 않음 (articles 컬렉션 체크로 폴스루)
    if (!options?.companyId || (dedupData?.companyId && dedupData.companyId === options.companyId)) {
      return {
        isDuplicate: true,
        reason: 'Dedupe ledger match',
        duplicateOf: dedupData?.articleId || dedupDoc.id,
      };
    }
  }

  if (options?.fastMode) {
    const recentArticlesSnapshot = await db.collection('articles')
      .where('titleHash', '==', titleHash)
      .limit(10)
      .get();
    const oneDayAgoMs = Date.now() - (24 * 60 * 60 * 1000);

    for (const doc of recentArticlesSnapshot.docs) {
      const existingArticle = doc.data();
      if (options.companyId && existingArticle.companyId && existingArticle.companyId !== options.companyId) {
        continue;
      }
      const collectedAt = existingArticle.collectedAt?.toDate
        ? existingArticle.collectedAt.toDate().getTime()
        : new Date(existingArticle.collectedAt || 0).getTime();
      if (!Number.isFinite(collectedAt) || collectedAt < oneDayAgoMs) {
        continue;
      }
      if (normalizeUrl(existingArticle.url) === normalizedUrl) {
        return { isDuplicate: true, reason: 'Normalized URL match', duplicateOf: doc.id };
      }
      const titleSim = calculateTokenSimilarity(newArticle.title, existingArticle.title);
      if (titleSim > 0.92) {
        return { isDuplicate: true, reason: 'High title similarity', duplicateOf: doc.id };
      }
    }

    return { isDuplicate: false };
  }

  let exactUrlQuery: FirebaseFirestore.Query = db.collection('articles')
    .where('url', '==', newArticle.url);
  if (options?.companyId) {
    exactUrlQuery = exactUrlQuery.where('companyId', '==', options.companyId);
  }
  const exactUrlSnapshot = await exactUrlQuery.limit(1).get();
  if (!exactUrlSnapshot.empty) {
    return { isDuplicate: true, reason: 'Exact URL match', duplicateOf: exactUrlSnapshot.docs[0].id };
  }

  let hashQuery: FirebaseFirestore.Query = db.collection('articles')
    .where('urlHash', '==', urlHash);
  if (options?.companyId) {
    hashQuery = hashQuery.where('companyId', '==', options.companyId);
  }
  const hashSnapshot = await hashQuery.limit(5).get();
  for (const doc of hashSnapshot.docs) {
    const existingArticle = doc.data();
    if (normalizeUrl(existingArticle.url) === normalizedUrl) {
      return { isDuplicate: true, reason: 'Normalized URL match', duplicateOf: doc.id };
    }
  }

  let recentQuery: FirebaseFirestore.Query = db.collection('articles')
    .where('titleHash', '==', titleHash);
  const recentArticlesSnapshot = await recentQuery.limit(options?.fastMode ? 20 : 50).get();

  const oneDayAgoMs = Date.now() - (24 * 60 * 60 * 1000);

  for (const doc of recentArticlesSnapshot.docs) {
    const existingArticle = doc.data();
    if (options?.companyId && existingArticle.companyId && existingArticle.companyId !== options.companyId) {
      continue;
    }
    const collectedAt = existingArticle.collectedAt?.toDate
      ? existingArticle.collectedAt.toDate().getTime()
      : new Date(existingArticle.collectedAt || 0).getTime();
    if (!Number.isFinite(collectedAt) || collectedAt < oneDayAgoMs) {
      continue;
    }
    const titleSim = calculateTokenSimilarity(newArticle.title, existingArticle.title);
    if (titleSim > 0.92) {
      return { isDuplicate: true, reason: 'High title similarity', duplicateOf: doc.id };
    }

    if (options?.fastMode) continue;

    if (options?.aiConfig && (titleSim > 0.65 || calculateSimilarity(newArticle.title, existingArticle.title) > 0.75)) {
      const isSemanticDup = await checkSemanticDuplicateWithAI(newArticle, existingArticle, options.aiConfig);
      if (isSemanticDup) {
        return { isDuplicate: true, reason: 'AI semantic match', duplicateOf: doc.id };
      }
    }
  }

  return { isDuplicate: false };
}
