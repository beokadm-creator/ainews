import { MarketInsightService } from './marketInsightService';
import { ThebellService } from './thebellService';
import { getAuthorizedCompanyIds, saveArticleForCompany, isFirestoreReady, getCollectedUrlHashes, hashUrl } from './firestoreService';

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
  options: { skipBusinessHoursCheck?: boolean } = {},
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

  const [miCompanies, tbCompanies] = await Promise.all([
    getAuthorizedCompanyIds('marketinsight'),
    getAuthorizedCompanyIds('thebell'),
  ]);

  console.log(`[Collection] Authorized — MI: ${miCompanies.length} companies | TB: ${tbCompanies.length} companies`);

  // ─── MarketInsight ───────────────────────────────────────────
  if (miCompanies.length > 0) {
    await collectMarketInsight(marketInsightService, miCompanies, result.marketinsight);
  }

  // 소스 간 자연스러운 간격 (5~15초)
  if (miCompanies.length > 0 && tbCompanies.length > 0) {
    await humanDelay(5000, 15000);
  }

  // ─── TheBell ─────────────────────────────────────────────────
  if (tbCompanies.length > 0) {
    await collectTheBell(thebellService, tbCompanies, result.thebell);
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
  companies: string[],
  stats: SourceResult,
): Promise<void> {
  try {
    console.log('[Collection] MarketInsight: fetching all pages...');
    const listResult = await (service as any).scrapeArticlesAllPages('mna', 100);
    if (!listResult.success || !listResult.data) {
      stats.errors.push(listResult.error || 'No data returned');
      return;
    }

    stats.found = listResult.data.length;
    console.log(`[Collection] MarketInsight: ${stats.found} total articles found`);

    // 이미 수집한 URL 해시 사전 로드 (detail fetch 전 필터링)
    const existingHashes = await getCollectedUrlHashes('marketinsight');
    console.log(`[Collection] MarketInsight: ${existingHashes.size} already collected URLs loaded`);

    const scored = listResult.data
      .map((a: any) => ({
        ...a,
        score: scoreRelevance(a.title, (a as any).summary || ''),
        category: (a as any).category || 'mna',
      }))
      .filter((a: any) => !existingHashes.has(hashUrl(a.link))) // 이미 수집한 URL 제외
      .sort((a: any, b: any) => b.score - a.score);

    stats.relevant = scored.length;
    const skippedCount = stats.found - scored.length;
    console.log(`[Collection] MarketInsight: ${scored.length} new articles (${skippedCount} already collected, skipped)`);

    if (scored.length === 0) return;

    // 신규 기사에 대해서만 detail 수집
    for (let i = 0; i < scored.length; i++) {
      const article = scored[i];

      if (i > 0) await humanDelay(2000, 5000);

      try {
        console.log(`[Collection] MI detail [${i + 1}/${scored.length}]: ${article.title.slice(0, 40)}...`);
        const detail = await service.scrapeArticleDetail(article.link);
        stats.detailFetched++;

        const articleData = {
          title: detail?.title || article.title,
          url: article.link,
          content: detail?.content || (article as any).summary || '',
          publishedAt: new Date(),
          source: 'MarketInsight',
          sourceId: 'marketinsight',
          isPaid: true, // 마켓인사이트는 모두 유료로 표시
          category: article.category,
          subtitle: detail?.subtitle || '',
          date: detail?.date || '',
        };

        for (const companyId of companies) {
          const saved = await saveArticleForCompany(articleData, companyId);
          if (saved) stats.collected++;
          else stats.skipped++;
        }
      } catch (e: any) {
        console.warn(`[Collection] MI detail failed: ${e.message}`);
        stats.errors.push(`detail: ${e.message}`);
      }
    }
  } catch (e: any) {
    console.error('[Collection] MarketInsight list error:', e.message);
    stats.errors.push(e.message);
  }
}

// ─── 더벨 수집 (마이페이지 키워드 뉴스 모든 페이지) ───────────────────
async function collectTheBell(
  service: ThebellService,
  companies: string[],
  stats: SourceResult,
): Promise<void> {
  try {
    console.log('[Collection] TheBell: fetching keyword news (all pages)...');
    const listResult = await (service as any).scrapeKeywordNews(50);
    if (!listResult.success || !listResult.data) {
      stats.errors.push(listResult.error || 'No data returned');
      return;
    }

    stats.found = listResult.data.length;
    console.log(`[Collection] TheBell: ${stats.found} articles found in MyKeywordNews`);

    // 이미 수집한 URL 해시 사전 로드
    const existingHashes = await getCollectedUrlHashes('thebell');
    console.log(`[Collection] TheBell: ${existingHashes.size} already collected URLs loaded`);

    const scored = listResult.data
      .map((a: any) => ({
        ...a,
        score: scoreRelevance(a.title, (a as any).summary || ''),
      }))
      .filter((a: any) => !existingHashes.has(hashUrl(a.link))) // 이미 수집한 URL 제외
      .sort((a: any, b: any) => b.score - a.score);

    stats.relevant = scored.length;
    const skippedCount = stats.found - scored.length;
    console.log(`[Collection] TheBell: ${scored.length} new articles (${skippedCount} already collected, skipped)`);

    if (scored.length === 0) return;

    // 모든 기사에 대해 detail 수집
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

        const articleData = {
          title: detail?.title || article.title,
          url: article.link,
          content: detail?.content || (article as any).summary || '',
          publishedAt: new Date(),
          source: 'TheBell',
          sourceId: 'thebell',
          category: article.category || 'keyword',
          isPaid: article.isPaid || true,
          subtitle: detail?.subtitle || '',
          author: detail?.author || '',
          date: detail?.date || '',
        };

        for (const companyId of companies) {
          const saved = await saveArticleForCompany(articleData, companyId);
          if (saved) stats.collected++;
          else stats.skipped++;
        }
      } catch (e: any) {
        console.warn(`[Collection] TB detail failed: ${e.message}`);
        stats.errors.push(`detail: ${e.message}`);
      }
    }
  } catch (e: any) {
    console.error('[Collection] TheBell list error:', e.message);
    stats.errors.push(e.message);
  }
}
