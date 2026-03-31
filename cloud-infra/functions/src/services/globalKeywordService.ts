import * as admin from 'firebase-admin';
import { DEFAULT_TRACKED_COMPANIES } from './trackedCompanyConfig';

// ─── In-memory cache (per Cloud Function instance warm reuse) ────────────────
let cachedTitleKeywords: string[] | null = null;
let cachedBypassPatterns: string[] | null = null;
let cachedTrackedCompanies: string[] | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5분

// 수집 키워드 필터를 통과하는 우선 매체 (더벨, 마켓인사이트)
const DEFAULT_BYPASS_PATTERNS = ['더벨', 'thebell', '마켓인사이트', 'marketinsight'];

// ─── 초기 시드 키워드 (딜 키워드 + PE하우스 정식명칭 + 약칭) ─────────────────
export const SEED_TITLE_KEYWORDS: string[] = [
  // ── 딜 키워드 ────────────────────────────────────────────────────────────
  '인수', '매각', '투자집행', '지분투자', '경영권투자',
  '인수금융', '바이아웃', '공동투자', 'exit', '엑시트', '회수',
  'IPO', '상장추진', '블록딜', 'PEF', '사모', 'M&A', 'PE',

  // ── PE하우스 정식명칭 ─────────────────────────────────────────────────────
  'MBK파트너스', '한앤컴퍼니', 'IMM프라이빗에쿼티', 'IMM인베스트먼트',
  '스틱인베스트먼트', 'VIG파트너스', '글랜우드프라이빗에쿼티', 'UCK파트너스',
  '스카이레이크인베스트먼트', '프랙시스캐피탈파트너스', 'JKL파트너스',
  '프리미어파트너스', '한국투자프라이빗에쿼티', '에이치프라이빗에쿼티',
  '앵커에쿼티파트너스', '키스톤프라이빗에쿼티', '이음프라이빗에쿼티',
  '제네시스프라이빗에쿼티', '큐캐피탈파트너스', '소시어스프라이빗에쿼티',
  '어센트에쿼티파트너스', '케이스톤파트너스', '센트로이드인베스트먼트',
  '더함파트너스', '아이젠프라이빗에쿼티', '제이앤프라이빗에쿼티',
  '다올프라이빗에쿼티', 'JC파트너스', '하일랜드에쿼티파트너스',
  '브릭스톤프라이빗에쿼티', 'E&F프라이빗에쿼티', '파인크리크',
  '오케스트라프라이빗에쿼티', '유니슨캐피탈', '린드먼아시아',
  '송현인베스트먼트', 'SG프라이빗에쿼티', '맥스턴프라이빗에쿼티',
  'IB파트너스', '파인트리파트너스', '시큐어드인베스트먼트',
  '웰투시인베스트먼트', '큐리어스파트너스', '피에스캐피탈파트너스',
  '라이프사이언스프라이빗에쿼티', '컴퍼니케이파트너스', '대신프라이빗에쿼티',
  '미래에셋캐피탈', '신한프라이빗에쿼티', '우리프라이빗에퀴티',
  'KB프라이빗에쿼티', '하나프라이빗에쿼티', 'NH프라이빗에쿼티',
  '삼성자산운용프라이빗에쿼티', '코레이트자산운용', '스톤브릿지캐피탈',
  '원익투자파트너스', '노앤파트너스', '노틱인베스트먼트', '도미누스인베스트먼트',
  '마이다스프라이빗에쿼티', '비엔더블유인베스트먼트', '시냅틱인베스트먼트',
  '아주아이비투자', '알케미스트캐피탈파트너스코리아', '어펄마캐피탈매니져스코리아',
  '에스비아이인베스트먼트', '에스제이엘파트너스', '에스케이에스프라이빗에쿼티',
  '에이스에쿼티파트너스', '에이피씨프라이빗에쿼티', '오릭스프라이빗에쿼티코리아',
  '유안타인베스트먼트', '유진프라이빗에쿼티', '이지스투자파트너스',
  '제이앤더블유파트너스', '카무르프라이빗에쿼티', '캑터스프라이빗에쿼티',
  '케이엘앤파트너스', '케이클라비스', '코스톤아시아', '크레센도에쿼티파트너스',
  '키움프라이빗에쿼티', '하이랜드캐피탈매니지먼트코리아', '헤임달프라이빗에쿼티',
  '헬리오스프라이빗에쿼티',

  // ── PE하우스 약칭 ─────────────────────────────────────────────────────────
  'MBK', '엠비케이', '한앤코', 'IMM', '아이엠엠', '스틱', 'VIG', '브이아이지',
  '글랜우드', 'UCK', '유씨케이', '스카이레이크', '프랙시스', 'JKL', '제이케이앨',
  '프리미어', '한국투자', '한투PE', '에이치PE', '앵커', '키스톤', '이음', '제네시스',
  '큐캐피탈', '소시어스', '어센트에쿼티', '케이스톤', '센트로이드', '더함', '아이젠',
  'J&PE', '제이앤', '다올', 'JC', '제이씨', '하일랜드', '브릭스톤', 'E&F', '이앤에프',
  '오케스트라', '유니슨', '린드먼', '송현', 'SG', '에쓰지', '맥스턴', '파인트리',
  '시큐어드', '웰투시', '큐리어스', '피에스캐피탈', '라이프사이언스PE', '컴퍼니케이',
  '대신PE', '신한PE', '우리PE', 'KB PE', '하나PE', 'NH PE', '삼성PE',
  '코레이트', '스톤브릿지', '원익', '노앤', '노틱', '도미누스', '마이다스',
  'BNW', '비엔더블유', '시냅틱', '아주아이비', '알케미스트', '어팔마',
  'SBI', '에스비아이', 'SJL', '에스제이엘', 'SKS', '에스케이에스',
  '에이스에쿼티', 'ACE', 'APC', '에이피씨', '오릭스', '유안타', '유진',
  '이지스', 'JNW', '카무르', '캑터스', '케이엘앤', 'KLN', '케이클라비스',
  '코스톤', '크레센도', '키움PE', 'Highland Capital', '하이랜드', '헤임달', '헬리오스',
];

// ─── Cache management ────────────────────────────────────────────────────────

export function invalidateKeywordCache(): void {
  cachedTitleKeywords = null;
  cachedBypassPatterns = null;
  cachedTrackedCompanies = null;
  cacheExpiresAt = 0;
}

async function loadKeywordConfig(): Promise<void> {
  const now = Date.now();
  if (cachedTitleKeywords !== null && now < cacheExpiresAt) return;

  try {
    const db = admin.firestore();
    const doc = await db.collection('systemSettings').doc('globalKeywords').get();
    if (doc.exists) {
      const data = doc.data() as any;
      cachedTitleKeywords = Array.isArray(data.titleKeywords) ? data.titleKeywords.filter(Boolean) : [];
      cachedBypassPatterns = Array.isArray(data.bypassSourcePatterns) ? data.bypassSourcePatterns : DEFAULT_BYPASS_PATTERNS;
      cachedTrackedCompanies = Array.isArray(data.trackedCompanies) ? data.trackedCompanies.filter(Boolean) : DEFAULT_TRACKED_COMPANIES;
    } else {
      cachedTitleKeywords = [];
      cachedBypassPatterns = DEFAULT_BYPASS_PATTERNS;
      cachedTrackedCompanies = DEFAULT_TRACKED_COMPANIES;
    }
  } catch (err) {
    console.warn('[GlobalKeyword] Firestore 로드 실패, 캐시 유지:', err);
    if (cachedTitleKeywords === null) cachedTitleKeywords = [];
    if (cachedBypassPatterns === null) cachedBypassPatterns = DEFAULT_BYPASS_PATTERNS;
    if (cachedTrackedCompanies === null) cachedTrackedCompanies = DEFAULT_TRACKED_COMPANIES;
  }

  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * 기사 제목이 글로벌 키워드 필터를 통과하는지 확인.
 * - 우선 매체(더벨, 마켓인사이트): 항상 통과
 * - 키워드 목록이 비어있으면: 모두 통과 (하위 호환)
 * - 제목에 키워드 하나라도 포함(OR)되면 통과
 */
export interface KeywordFilterResult {
  passes: boolean;
  isBypassSource: boolean;   // 더벨/마켓인사이트 등 우선 매체
  matchedKeyword: string | null; // 매칭된 키워드 (없으면 null)
}

const SPORTS_CONTEXT_PATTERNS: RegExp[] = [
  /\b(soccer|football|baseball|basketball|volleyball|tennis|golf|olympic|olympics|mlb|nba|nfl|epl|kbo|uefa|fifa|fa cup|champions league)\b/i,
  /\b(player|players|coach|match|game|goal|scored|transfer window|transfer fee|release clause|club|athlete|season|tournament)\b/i,
  /(축구|야구|농구|배구|테니스|골프|올림픽|월드컵|챔피언스리그|프리미어리그|KBO|선수|감독|구단|클럽|팀|경기|득점|이적|방출|우승|준우승|개막전|정규시즌)/i,
];

export function hasSportsContext(text: string): boolean {
  const normalized = `${text || ''}`.trim();
  if (!normalized) return false;
  const strongPatterns = [
    SPORTS_CONTEXT_PATTERNS[0],
    SPORTS_CONTEXT_PATTERNS[2],
    /\b(team|teams|league|leagues|athlete|athletes|goalkeeper|pitcher|batter)\b/i,
    /\b(mlb|nba|nfl|epl|kbo|uefa|fifa)\b/i,
  ];
  const weakPatterns = [
    SPORTS_CONTEXT_PATTERNS[1],
    /\b(player|players|coach|match|game|goal|season|tournament|transfer)\b/i,
  ];

  const strongMatches = strongPatterns.filter((pattern) => pattern.test(normalized)).length;
  const weakMatches = weakPatterns.filter((pattern) => pattern.test(normalized)).length;

  if (strongMatches >= 2) return true;
  if (strongMatches >= 1 && weakMatches >= 1) return true;
  return false;
}

/**
 * 명백한 오탐만 제거 (필터링 아님).
 * 예: "바이아웃" + 스포츠 단어만 → 제외
 * 하지만 불확실하면 수집 (false positive가 분석 단계에서 제거됨)
 */
function isDefinitelyNotRelevant(title: string, keyword: string): boolean {
  const titleLower = title.toLowerCase();
  const kwLower = keyword.toLowerCase();

  if (hasSportsContext(titleLower)) return true;

  // 매우 명확한 오탐만 여기서 제거
  if (kwLower === '바이아웃' || kwLower === 'buyout') {
    // 스포츠 맥락이 명확하면 제외
    const sportsOnlyPattern = /\b(선수|구단|클럽|팀)\b.*\b(바이아웃|buyout)\b|\b(바이아웃|buyout)\b.*\b(선수|구단|클럽|팀)\b/i;
    if (sportsOnlyPattern.test(titleLower)) return true;
  }

  // 기타 명확한 오탐도 여기 추가 가능
  // 기본값: 불확실하면 수집 (하단 분석 단계에서 판단)
  return false;
}

const GENERIC_SHORT_KOREAN_KEYWORDS = new Set([
  '인수',
  '매각',
  '회수',
  '사모',
  '엑시트',
  '상장',
  '공모',
]);

const COMPANY_ALIAS_CONTEXT_PATTERN = /(인베스트|인베스트먼트|파트너|파트너스|캐피탈|프라이빗|에쿼티|자산운용|홀딩스|벤처|pe|vc)/i;

function hasLooseWordBoundary(text: string, start: number, length: number): boolean {
  const before = start > 0 ? text[start - 1] : '';
  const after = start + length < text.length ? text[start + length] : '';
  return !/[a-z0-9가-힣]/i.test(before) && !/[a-z0-9가-힣]/i.test(after);
}

function isStrictKoreanAliasKeyword(keyword: string): boolean {
  return /^[가-힣]{2,4}$/.test(keyword) && !GENERIC_SHORT_KOREAN_KEYWORDS.has(keyword);
}

function matchesStrictKoreanAlias(titleLower: string, keyword: string): boolean {
  let idx = titleLower.indexOf(keyword);
  while (idx !== -1) {
    const windowStart = Math.max(0, idx - 8);
    const windowEnd = Math.min(titleLower.length, idx + keyword.length + 16);
    const nearbyText = titleLower.slice(windowStart, windowEnd);

    if (hasLooseWordBoundary(titleLower, idx, keyword.length) || COMPANY_ALIAS_CONTEXT_PATTERN.test(nearbyText)) {
      if (!isDefinitelyNotRelevant(titleLower, keyword)) return true;
    }

    idx = titleLower.indexOf(keyword, idx + 1);
  }

  return false;
}

/** 키워드 매칭 내부 로직 (isBypass 이미 확인된 후) */
function findMatchedKeyword(titleLower: string, keywords: string[]): string | null {
  for (const kw of keywords) {
    const k = `${kw || ''}`.trim().toLowerCase();
    if (!k) continue;
    // 순수 영문자 3자 이하 약칭: 앞뒤 단어경계 검사 (SGI에서 SG 오탐 방지)
    if (k.length <= 3 && /^[a-z]+$/.test(k)) {
      let idx = titleLower.indexOf(k);
      while (idx !== -1) {
        const before = idx > 0 ? titleLower[idx - 1] : '';
        const after = idx + k.length < titleLower.length ? titleLower[idx + k.length] : '';
        if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) {
          if (!isDefinitelyNotRelevant(titleLower, k)) return kw;
        }
        idx = titleLower.indexOf(k, idx + 1);
      }
    } else if (isStrictKoreanAliasKeyword(k)) {
      if (matchesStrictKoreanAlias(titleLower, k)) return kw;
    } else if (titleLower.includes(k)) {
      if (!isDefinitelyNotRelevant(titleLower, k)) return kw;
    }
  }
  return null;
}

/**
 * 기사 제목이 글로벌 키워드 필터를 통과하는지 확인.
 * - 우선 매체(더벨, 마켓인사이트): 항상 통과 (isBypassSource=true)
 * - 키워드 목록이 비어있으면: 모두 통과 (하위 호환)
 * - 제목에 키워드 하나라도 포함(OR)되면 통과
 */
export async function titlePassesGlobalKeywordFilter(
  title: string,
  sourceName?: string | null,
  sourceId?: string | null,
): Promise<boolean> {
  const result = await checkKeywordFilter(title, sourceName, sourceId);
  return result.passes;
}

/**
 * 키워드 필터 결과 + 매칭 상세 정보 반환.
 * 수집 시 status='filtered' 직접 저장에 사용.
 */
export async function checkKeywordFilter(
  title: string,
  sourceName?: string | null,
  sourceId?: string | null,
): Promise<KeywordFilterResult> {
  await loadKeywordConfig();

  if (hasSportsContext(title)) {
    return { passes: false, isBypassSource: false, matchedKeyword: null };
  }

  const bypassPatterns = (cachedBypassPatterns || DEFAULT_BYPASS_PATTERNS)
    .filter((pattern) => {
      const normalizedPattern = `${pattern || ''}`.trim().toLowerCase();
      return normalizedPattern !== 'thebell' && normalizedPattern !== '더벨';
    });
  const sourceNameLower = `${sourceName || ''}`.toLowerCase();
  const sourceIdLower = `${sourceId || ''}`.toLowerCase();

  const isBypassSource = bypassPatterns.some((pattern) => {
    const p = pattern.toLowerCase();
    return sourceNameLower.includes(p) || sourceIdLower.includes(p);
  });
  if (isBypassSource) {
    return { passes: true, isBypassSource: true, matchedKeyword: null };
  }

  const keywords = Array.from(new Set([...(cachedTitleKeywords || []), ...(cachedTrackedCompanies || [])]));
  if (keywords.length === 0) {
    return { passes: true, isBypassSource: false, matchedKeyword: null };
  }

  const titleLower = `${title || ''}`.toLowerCase();
  const matched = findMatchedKeyword(titleLower, keywords);
  return { passes: matched !== null, isBypassSource: false, matchedKeyword: matched };
}

export async function getGlobalKeywordConfig(): Promise<{
  titleKeywords: string[];
  bypassSourcePatterns: string[];
  trackedCompanies: string[];
}> {
  await loadKeywordConfig();
  return {
    titleKeywords: cachedTitleKeywords || [],
    bypassSourcePatterns: cachedBypassPatterns || DEFAULT_BYPASS_PATTERNS,
    trackedCompanies: cachedTrackedCompanies || DEFAULT_TRACKED_COMPANIES,
  };
}

export async function saveGlobalKeywordConfig(
  titleKeywords: string[],
  bypassSourcePatterns?: string[],
  trackedCompanies?: string[],
): Promise<void> {
  const db = admin.firestore();
  const cleaned = titleKeywords.map((k) => `${k || ''}`.trim()).filter(Boolean);
  const cleanedTrackedCompanies = (trackedCompanies || DEFAULT_TRACKED_COMPANIES)
    .map((item) => `${item || ''}`.trim())
    .filter(Boolean);
  await db.collection('systemSettings').doc('globalKeywords').set({
    titleKeywords: cleaned,
    bypassSourcePatterns: bypassSourcePatterns ?? DEFAULT_BYPASS_PATTERNS,
    trackedCompanies: cleanedTrackedCompanies,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  invalidateKeywordCache();
}

/**
 * 초기 시드 키워드를 Firestore에 저장 (기존 데이터가 없을 때만).
 */
export async function seedGlobalKeywordsIfEmpty(): Promise<boolean> {
  const db = admin.firestore();
  const doc = await db.collection('systemSettings').doc('globalKeywords').get();
  if (doc.exists && Array.isArray((doc.data() as any).titleKeywords) && (doc.data() as any).titleKeywords.length > 0) {
    return false; // 이미 설정됨
  }
  await saveGlobalKeywordConfig(SEED_TITLE_KEYWORDS, DEFAULT_BYPASS_PATTERNS, DEFAULT_TRACKED_COMPANIES);
  console.log(`[GlobalKeyword] 초기 키워드 ${SEED_TITLE_KEYWORDS.length}개 시드 완료`);
  return true;
}
