import { MarketInsightService } from './marketInsightService';
import { ThebellService } from './thebellService';
import { saveArticleGlobal, isFirestoreReady, getCollectedUrlHashes, hashUrl, reportScraperStatus } from './firestoreService';
import { sendScraperErrorAlert } from './emailAlertService';

// ─── 관련도 키워드 ───────────────────────────────────────────────
// 점수가 높을수록 핵심 딜 기사 (가중치별 분류)
const HIGH_VALUE_KEYWORDS = [
  '인수합병', 'M&A', '바이아웃', '경영권 인수', '공개매수',
  '사모펀드', 'PEF', 'PE펀드', '프라이빗에쿼티',
  '인수금융', '리파이낸싱', 'EXIT', '엑시트',
];
const DEAL_KEYWORDS = [
  '인수', '매각', '매물', '지분투자', '지분 매각', '경영권',
  'IPO', '상장', '블록딜', '공모', '합병', '분할',
  '투자유치', '재무적투자자', '전략적투자자', 'FI', 'SI',
  '펀드 결성', '펀드 청산', '회수', '드라이파우더',
];

function scoreRelevance(title: string, summary: string = ''): number {
  const text = title + ' ' + summary;
  let score = 0;
  HIGH_VALUE_KEYWORDS.forEach(kw => { if (text.includes(kw)) score += 2; });
  DEAL_KEYWORDS.forEach(kw => { if (text.includes(kw)) score += 1; });
  return score;
}

// 한 번 수집에서 detail을 가져올 최대 기사 수 (소스당)
const MAX_DETAIL_FETCH = parseInt(process.env.MAX_DETAIL_FETCH || '8');

// ─── 사람처럼 대기 ────────────────────────────────────────────────
export async function humanDelay(minMs = 3000, maxMs = 8000): Promise<void> {
  const ms = minMs + Math.floor(Math.random() * (maxMs - minMs));
  await new Promise(r => setTimeout(r, ms));
}

// 한국 업무 시간 체크 (KST 7시~23시)
export function isKoreanBusinessHours(): boolean {
  const kstHour = (new Date().getUTCHours() + 9) % 24;
  return kstHour >= 7 && kstHour < 23;
}

// 다음 수집까지 랜덤 대기 시간 (50~85분, 분 단위)
export function randomCollectIntervalMs(): number {
  const minMin = 50, maxMin = 85;
  return (minMin + Math.floor(Math.random() * (maxMin - minMin))) * 60 * 1000;
}

// ─── 결과 타입 ────────────────────────────────────────────────────
export interface SourceResult {
  found: number;
  relevant: number;
  detailFetched: number;
  collected: number;
  skipped: number;
  errors: string[];
}

export interface CollectionResult {
  success: boolean;
  marketinsight: SourceResult;
  thebell: SourceResult;
  totalCollected: number;
  firestoreEnabled: boolean;
  skippedBusinessHours?: boolean;
}

// ─── 메인 수집 함수 ───────────────────────────────────────────────
export async function collectAllArticles(
  marketInsightService: MarketInsightService,
  thebellService: ThebellService,
  options: { skipBusinessHoursCheck?: boolean; onlyTheBell?: boolean; onlyMarketInsight?: boolean } = {},
): Promise<CollectionResult> {

  if (!options.skipBusinessHoursCheck && !isKoreanBusinessHours()) {
    console.log('[Collection] Outside Korean business hours (7am-11pm KST) — skipping');
    return {
      success: true,
      marketinsight: { found: 0, relevant: 0, detailFetched: 0, collected: 0, skipped: 0, errors: [] },
      thebell: { found: 0, relevant: 0, detailFetched: 0, collected: 0, skipped: 0, errors: [] },
      totalCollected: 0,
      firestoreEnabled: isFirestoreReady(),
      skippedBusinessHours: true,
    };
  }

  const result: CollectionResult = {
    success: true,
    marketinsight: { found: 0, relevant: 0, detailFetched: 0, collected: 0, skipped: 0, errors: [] },
    thebell: { found: 0, relevant: 0, detailFetched: 0, collected: 0, skipped: 0, errors: [] },
    totalCollected: 0,
    firestoreEnabled: isFirestoreReady(),
  };

  // 슈퍼어드민이 전체 수집 — 회사 구분 없음
  if (!options.onlyTheBell) {
    await collectMarketInsight(marketInsightService, result.marketinsight);
  }

  // 소스 간 자연스러운 간격 (5~15초)
  if (!options.onlyMarketInsight && !options.onlyTheBell) {
    await humanDelay(5000, 15000);
  }

  if (!options.onlyMarketInsight) {
    await collectTheBell(thebellService, result.thebell);
  }

  result.totalCollected = result.marketinsight.collected + result.thebell.collected;
  console.log(
    `[Collection] ✓ Complete | MI: ${result.marketinsight.collected} saved` +
    ` (${result.marketinsight.relevant}/${result.marketinsight.found} relevant)` +
    ` | TB: ${result.thebell.collected} saved` +
    ` (${result.thebell.relevant}/${result.thebell.found} relevant)` +
    ` | Total new: ${result.totalCollected}`
  );
  return result;
}

// ─── 마켓인사이트 수집 (모든 페이지) ────────────────────────────────────
async function collectMarketInsight(
  service: MarketInsightService,
  stats: SourceResult,
): Promise<void> {
  const startedAt = new Date();
  try {
    await reportScraperStatus({ source: 'marketinsight', status: 'running', found: 0, collected: 0, skipped: 0, startedAt });

    console.log('[Collection] MarketInsight: fetching articles (max 5 pages, recent 1 month)...');
    const listResult = await (service as any).scrapeArticlesAllPages('mna', 5); // 최근 1개월분 (약 50~100개 기사)
    if (!listResult.success || !listResult.data) {
      const errMsg = listResult.error || 'No data returned';
      stats.errors.push(errMsg);
      await reportScraperStatus({ source: 'marketinsight', status: 'error', found: 0, collected: 0, skipped: 0, errorMessage: errMsg, startedAt, finishedAt: new Date(), durationMs: Date.now() - startedAt.getTime() });
      return;
    }

    // 최근 한달 필터링 (2026년 2월 21일 이후)
    const oneMonthAgo = new Date();
    oneMonthAgo.setDate(oneMonthAgo.getDate() - 30);

    stats.found = listResult.data.length;
    console.log(`[Collection] MarketInsight: ${stats.found} total articles found (fetched 5 pages max)`);

    const existingHashes = await getCollectedUrlHashes('marketinsight');
    console.log(`[Collection] MarketInsight: ${existingHashes.size} already collected URLs loaded`);

    const scored = listResult.data
      .filter((a: any) => {
        // 날짜 필터링: 최근 한달 기사만
        if (!a.date) return false;
        const articleDate = new Date(a.date);
        return articleDate >= oneMonthAgo;
      })
      .map((a: any) => ({
        ...a,
        score: scoreRelevance(a.title, (a as any).summary || ''),
        category: (a as any).category || 'mna',
      }))
      .filter((a: any) => !existingHashes.has(hashUrl(a.link)))
      .sort((a: any, b: any) => b.score - a.score);

    stats.relevant = scored.length;
    const skippedCount = stats.found - scored.length;
    console.log(`[Collection] MarketInsight: ${scored.length} new articles (${skippedCount} already collected, skipped)`);

    if (scored.length === 0) {
      await reportScraperStatus({ source: 'marketinsight', status: 'success', found: stats.found, collected: 0, skipped: skippedCount, startedAt, finishedAt: new Date(), durationMs: Date.now() - startedAt.getTime() });
      return;
    }

    for (let i = 0; i < scored.length; i++) {
      const article = scored[i];
      if (i > 0) await humanDelay(2000, 5000);

      try {
        console.log(`[Collection] MI detail [${i + 1}/${scored.length}]: ${article.title.slice(0, 40)}...`);
        const detail = await service.scrapeArticleDetail(article.link);
        stats.detailFetched++;

        const saved = await saveArticleGlobal({
          title: detail?.title || article.title,
          url: article.link,
          content: detail?.content || (article as any).summary || '',
          publishedAt: new Date(),
          source: 'MarketInsight',
          sourceId: 'marketinsight',
          isPaid: true,
          category: article.category,
          subtitle: detail?.subtitle || '',
          date: detail?.date || '',
        });
        if (saved) stats.collected++;
        else stats.skipped++;
      } catch (e: any) {
        console.warn(`[Collection] MI detail failed: ${e.message}`);
        stats.errors.push(`detail: ${e.message}`);
      }
    }

    await reportScraperStatus({ source: 'marketinsight', status: 'success', found: stats.found, collected: stats.collected, skipped: stats.skipped, startedAt, finishedAt: new Date(), durationMs: Date.now() - startedAt.getTime() });
  } catch (e: any) {
    console.error('[Collection] MarketInsight list error:', e.message);
    stats.errors.push(e.message);
    await reportScraperStatus({ source: 'marketinsight', status: 'error', found: stats.found, collected: stats.collected, skipped: stats.skipped, errorMessage: e.message, startedAt, finishedAt: new Date(), durationMs: Date.now() - startedAt.getTime() });
    await sendScraperErrorAlert('MarketInsight', e.message, { found: stats.found, collected: stats.collected });
  }
}

// ─── 더벨 수집 (마이페이지 키워드 뉴스 모든 페이지) ───────────────────
async function collectTheBell(
  service: ThebellService,
  stats: SourceResult,
): Promise<void> {
  const startedAt = new Date();
  try {
    await reportScraperStatus({ source: 'thebell', status: 'running', found: 0, collected: 0, skipped: 0, startedAt });

    console.log('[Collection] TheBell: fetching keyword news (all pages)...');
    const listResult = await (service as any).scrapeKeywordNews(50);
    if (!listResult.success || !listResult.data) {
      const errMsg = listResult.error || 'No data returned';
      stats.errors.push(errMsg);
      await reportScraperStatus({ source: 'thebell', status: 'error', found: 0, collected: 0, skipped: 0, errorMessage: errMsg, startedAt, finishedAt: new Date(), durationMs: Date.now() - startedAt.getTime() });
      return;
    }

    stats.found = listResult.data.length;
    console.log(`[Collection] TheBell: ${stats.found} articles found in MyKeywordNews`);

    const existingHashes = await getCollectedUrlHashes('thebell');
    console.log(`[Collection] TheBell: ${existingHashes.size} already collected URLs loaded`);

    const scored = listResult.data
      .map((a: any) => ({
        ...a,
        score: scoreRelevance(a.title, (a as any).summary || ''),
      }))
      .filter((a: any) => !existingHashes.has(hashUrl(a.link)))
      .sort((a: any, b: any) => b.score - a.score);

    stats.relevant = scored.length;
    const skippedCount = stats.found - scored.length;
    console.log(`[Collection] TheBell: ${scored.length} new articles (${skippedCount} already collected, skipped)`);

    if (scored.length === 0) {
      await reportScraperStatus({ source: 'thebell', status: 'success', found: stats.found, collected: 0, skipped: skippedCount, startedAt, finishedAt: new Date(), durationMs: Date.now() - startedAt.getTime() });
      return;
    }

    for (let i = 0; i < scored.length; i++) {
      const article = scored[i];
      if (i > 0) await humanDelay(3000, 7000);

      try {
        console.log(
          `[Collection] TB detail [${i + 1}/${scored.length}]:` +
          ` ${article.title.slice(0, 40)}... [${article.isPaid ? '유료' : '무료'}]`
        );
        const detail = await service.scrapeArticleDetail(article.link);
        stats.detailFetched++;

        const saved = await saveArticleGlobal({
          title: detail?.title || article.title,
          url: article.link,
          content: detail?.content || (article as any).summary || '',
          publishedAt: new Date(),
          source: 'TheBell',
          sourceId: 'thebell',
          category: article.category || 'keyword',
          isPaid: true,
          subtitle: detail?.subtitle || '',
          author: detail?.author || '',
          date: detail?.date || '',
        });
        if (saved) stats.collected++;
        else stats.skipped++;
      } catch (e: any) {
        console.warn(`[Collection] TB detail failed: ${e.message}`);
        stats.errors.push(`detail: ${e.message}`);
      }
    }

    await reportScraperStatus({ source: 'thebell', status: 'success', found: stats.found, collected: stats.collected, skipped: stats.skipped, startedAt, finishedAt: new Date(), durationMs: Date.now() - startedAt.getTime() });
  } catch (e: any) {
    console.error('[Collection] TheBell list error:', e.message);
    stats.errors.push(e.message);
    await reportScraperStatus({ source: 'thebell', status: 'error', found: stats.found, collected: stats.collected, skipped: stats.skipped, errorMessage: e.message, startedAt, finishedAt: new Date(), durationMs: Date.now() - startedAt.getTime() });
    await sendScraperErrorAlert('TheBell', e.message, { found: stats.found, collected: stats.collected });
  }
}
