import * as admin from 'firebase-admin';
import { isDuplicateArticle, hashUrl } from './duplicateService';
import { matchesRuntimeFilters } from '../utils/textUtils';
import { RuntimeFilters, RuntimeAiConfig } from '../types/runtime';
import { getDateRangeBounds } from './runtimeConfigService';

/**
 * Scraping Service - PC 스크래퍼 전용
 * 
 * 클라우드에서 직접 웹 스크래핑하지 않음.
 * 로컬 PC 스크래퍼가 Firestore에 저장한 기사만 조회하여 처리.
 * 
 * 지원 소스:
 * - thebell (더벨) - 로컬 PC 스크래퍼
 * - marketinsight (마켓인사이트) - 로컬 PC 스크래퍼
 */

// PC 스크래퍼에서 처리하는 소스 ID 목록
const PC_SCRAPER_SOURCES = ['thebell', 'marketinsight'];

export async function processScrapingSources(options?: {
  companyId?: string;
  pipelineRunId?: string;
  filters?: RuntimeFilters;
  aiConfig?: RuntimeAiConfig;
}) {
  const db = admin.firestore();
  const { startDate, endDate } = getDateRangeBounds(options?.filters?.dateRange);

  // ── 소스 목록 수집: PC 스크래퍼 소스만 처리 (thebell, marketinsight)
  const allSourcesToProcess: { id: string; data: any }[] = [];
  const subscribedIds = options?.filters?.sourceIds ?? [];

  // 구독 기반 또는 전체 active scraping 소스 조회
  const sourceIdsToCheck = subscribedIds.length > 0 ? subscribedIds : PC_SCRAPER_SOURCES;

  // Firestore in-query 제한: 최대 10개씩 청크
  const chunks: string[][] = [];
  for (let i = 0; i < sourceIdsToCheck.length; i += 10) {
    chunks.push(sourceIdsToCheck.slice(i, i + 10));
  }

  for (const chunk of chunks) {
    const globalSnap = await db.collection('globalSources')
      .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
      .get();
    globalSnap.docs.forEach(d => {
      const data = d.data();
      // PC 스크래퍼 소스이고 active인 경우만 추가
      if (data.type !== 'scraping' || data.status !== 'active') return;
      if (!PC_SCRAPER_SOURCES.includes(d.id)) return; // PC 스크래퍼 소스만 처리
      if (allSourcesToProcess.find(s => s.id === d.id)) return;
      allSourcesToProcess.push({ id: d.id, data });
    });
  }

  console.log(`[Scraping] PC scraper sources to process: ${allSourcesToProcess.length} (${allSourcesToProcess.map(s => s.id).join(', ')})`);

  if (allSourcesToProcess.length === 0) {
    console.log('[Scraping] No PC scraper sources found. Skipping.');
    return { success: true, totalCollected: 0 };
  }

  let totalCollected = 0;

  // ── 각 소스별로 Firestore에서 pending 기사 조회 ──
  const perSourceResults = await Promise.allSettled(
    allSourcesToProcess.map(async ({ id: sourceId, data: source }) => {
      const docRef = db.collection('globalSources').doc(sourceId);

      try {
        // PC 스크래퍼가 저장한 pending 기사 조회
        const snap = await db.collection('articles')
          .where('sourceId', '==', sourceId)
          .where('status', '==', 'pending')
          .limit(100)
          .get();

        const articles = snap.docs.map(d => ({ id: d.id, ...d.data() })) as any[];
        let sourceCollected = 0;

        for (const article of articles) {
          // 날짜 필터링
          const publishedAt = article.publishedAt?.toDate ? article.publishedAt.toDate() : new Date(article.publishedAt);
          if (startDate && publishedAt < startDate) continue;
          if (endDate && publishedAt > endDate) continue;

          // 키워드 필터링 (AI가 최종 판단하므로 여기서는 기본만)
          if (!matchesRuntimeFilters(article.title, article.content || '', {
            anyKeywords: options?.filters?.keywords || [],
            includeKeywords: options?.filters?.includeKeywords,
            mustIncludeKeywords: options?.filters?.mustIncludeKeywords,
            excludeKeywords: options?.filters?.excludeKeywords,
            sectors: options?.filters?.sectors
          })) {
            continue;
          }

          // 이미 Firestore에 저장되어 있으므로 상태만 업데이트하지 않고 카운트
          // (PC 스크래퍼가 이미 저장했으므로 중복 저장 불필요)
          sourceCollected++;
        }

        await docRef.update({
          lastScrapedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastStatus: 'success',
          errorMessage: null
        }).catch(() => {});

        console.log(`[Scraping] ${source.name}: ${sourceCollected}건 (from PC scraper)`);
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
