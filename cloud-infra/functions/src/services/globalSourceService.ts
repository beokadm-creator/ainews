import * as admin from 'firebase-admin';
import axios from 'axios';

export type GlobalSourceType = 'rss' | 'scraping' | 'puppeteer' | 'api' | 'newsletter';
export type SourceStatus = 'active' | 'inactive' | 'error' | 'testing';
export type ContentLanguage = 'ko' | 'en' | 'ja' | 'zh';

export interface GlobalSource {
  id: string;
  name: string;
  description: string;
  url: string;
  type: GlobalSourceType;
  language: ContentLanguage;
  relevanceScore: 1 | 2 | 3 | 4 | 5; // ★ 관련성 점수
  category: string; // 'domestic', 'asian', 'global', 'tech'

  // Collection config
  rssUrl?: string;          // RSS type
  apiEndpoint?: string;     // API type
  apiKeyRequired?: boolean;
  apiKeyEnvName?: string;

  // Scraping config
  listSelector?: string;
  titleSelector?: string;
  linkSelector?: string;
  contentSelector?: string;
  dateSelector?: string;
  loginRequired?: boolean;
  authType?: 'none' | 'session' | 'cookie';

  // Metadata
  defaultKeywords: string[];
  status: SourceStatus;
  lastTestedAt?: admin.firestore.Timestamp;
  lastTestResult?: {
    success: boolean;
    message: string;
    articlesFound?: number;
    latencyMs?: number;
  };
  notes?: string;
  pricingTier: 'free' | 'paid' | 'requires_subscription';
  createdAt: admin.firestore.Timestamp;
  updatedAt: admin.firestore.Timestamp;
  createdBy: string;
}

// ─────────────────────────────────────────
// 기본 키워드: 모든 국내 매체에 공통 적용
// ─────────────────────────────────────────
const BASE_KO_KEYWORDS = ['M&A', '인수', '합병', '매각'];
const EXTENDED_KO_KEYWORDS = [...BASE_KO_KEYWORDS, '피인수', '지분인수', '사모펀드', 'PE', 'VC'];
const BASE_EN_KEYWORDS = ['M&A', 'merger', 'acquisition', 'private equity', 'buyout', 'deal'];
const STARTUP_KEYWORDS = ['M&A', 'acquisition', 'merger', 'private equity', 'PE', 'VC', 'venture capital', 'buyout', 'LBO', 'funding', 'raised', 'startup', 'exit'];

// ─────────────────────────────────────────
// Initial seed data from MA-media-sources.md
// ─────────────────────────────────────────
export const INITIAL_GLOBAL_SOURCES: Omit<GlobalSource, 'id' | 'createdAt' | 'updatedAt' | 'createdBy' | 'lastTestedAt' | 'lastTestResult'>[] = [
  // === RSS FREE — 국내 ===
  {
    name: '한국경제신문',
    description: '국내 주요 경제 매체. M&A 전담 기자 보유. RSS 모든 섹션 제공.',
    url: 'https://www.hankyung.com',
    rssUrl: 'https://www.hankyung.com/rss',
    type: 'rss',
    language: 'ko',
    relevanceScore: 4,
    category: 'domestic',
    defaultKeywords: EXTENDED_KO_KEYWORDS,
    status: 'active',
    pricingTier: 'free',
    notes: 'RSS 피드에서 M&A 키워드 필터링 필요',
  },
  {
    name: '매일경제',
    description: '경제 섹션별 RSS 분리. M&A 관련 기사 다수.',
    url: 'https://www.mk.co.kr',
    rssUrl: 'https://www.mk.co.kr/rss',
    type: 'rss',
    language: 'ko',
    relevanceScore: 4,
    category: 'domestic',
    defaultKeywords: EXTENDED_KO_KEYWORDS,
    status: 'active',
    pricingTier: 'free',
  },
  {
    name: '파이낸셜뉴스',
    description: '금융 중심. PE/VC 기사 다수.',
    url: 'https://www.fnnews.com',
    rssUrl: 'https://www.fnnews.com/rss',
    type: 'rss',
    language: 'ko',
    relevanceScore: 3,
    category: 'domestic',
    defaultKeywords: EXTENDED_KO_KEYWORDS,
    status: 'active',
    pricingTier: 'free',
  },
  {
    name: '이데일리',
    description: '종합 경제 매체. M&A 관련 경제 뉴스 수집.',
    url: 'https://www.edaily.co.kr',
    rssUrl: 'https://www.edaily.co.kr/rss',
    type: 'rss',
    language: 'ko',
    relevanceScore: 3,
    category: 'domestic',
    defaultKeywords: EXTENDED_KO_KEYWORDS,
    status: 'active',
    pricingTier: 'free',
  },
  {
    name: '서울경제',
    description: '머니타워 M&A 섹션 보유.',
    url: 'https://www.sedaily.com',
    rssUrl: 'https://www.sedaily.com/rss',
    type: 'rss',
    language: 'ko',
    relevanceScore: 3,
    category: 'domestic',
    defaultKeywords: BASE_KO_KEYWORDS,
    status: 'active',
    pricingTier: 'free',
  },
  {
    name: '헤럴드경제',
    description: '종합 경제 매체. M&A 관련 뉴스 수집.',
    url: 'https://news.heraldcorp.com',
    rssUrl: 'https://news.heraldcorp.com/rss',
    type: 'rss',
    language: 'ko',
    relevanceScore: 3,
    category: 'domestic',
    defaultKeywords: BASE_KO_KEYWORDS,
    status: 'active',
    pricingTier: 'free',
  },
  {
    name: '아시아경제',
    description: '종합 경제 매체.',
    url: 'https://www.asiae.co.kr',
    rssUrl: 'https://www.asiae.co.kr/rss',
    type: 'rss',
    language: 'ko',
    relevanceScore: 3,
    category: 'domestic',
    defaultKeywords: BASE_KO_KEYWORDS,
    status: 'active',
    pricingTier: 'free',
  },
  {
    name: '머니투데이',
    description: '경제/금융 전문 매체.',
    url: 'https://www.mt.co.kr',
    rssUrl: 'https://www.mt.co.kr/rss',
    type: 'rss',
    language: 'ko',
    relevanceScore: 3,
    category: 'domestic',
    defaultKeywords: EXTENDED_KO_KEYWORDS,
    status: 'active',
    pricingTier: 'free',
  },
  {
    name: '연합뉴스',
    description: '뉴스와이어 포함. M&A 공식 발표 빠름. 뉴스와이어 섹션 필수.',
    url: 'https://www.yna.co.kr',
    rssUrl: 'https://www.yna.co.kr/rss',
    type: 'rss',
    language: 'ko',
    relevanceScore: 4,
    category: 'domestic',
    defaultKeywords: [...BASE_KO_KEYWORDS, '뉴스와이어'],
    status: 'active',
    pricingTier: 'free',
  },
  // === RSS FREE — 영문 ===
  {
    name: 'The Korea Herald',
    description: '한국 경제 뉴스 영문판. 크로스보더 M&A 특화.',
    url: 'http://www.koreaherald.com',
    rssUrl: 'http://www.koreaherald.com/rss',
    type: 'rss',
    language: 'en',
    relevanceScore: 3,
    category: 'domestic',
    defaultKeywords: BASE_EN_KEYWORDS,
    status: 'active',
    pricingTier: 'free',
  },
  {
    name: 'DealStreetAsia',
    description: '아시아 M&A 전문 1위 매체. PE/VC/크로스보더 딜 상세 정보 제공. 필수.',
    url: 'https://dealstreetasia.com',
    rssUrl: 'https://dealstreetasia.com/rss',
    type: 'rss',
    language: 'en',
    relevanceScore: 5,
    category: 'asian',
    defaultKeywords: BASE_EN_KEYWORDS,
    status: 'active',
    pricingTier: 'free',
    notes: '아시아 M&A 필수 소스',
  },
  {
    name: 'Financial Times',
    description: '글로벌 M&A 트렌드. M&M (Mergers & Markets) 섹션 보유. 일부 유료.',
    url: 'https://www.ft.com',
    rssUrl: 'https://www.ft.com/rss/home',
    type: 'rss',
    language: 'en',
    relevanceScore: 5,
    category: 'global',
    defaultKeywords: BASE_EN_KEYWORDS,
    status: 'active',
    pricingTier: 'requires_subscription',
    notes: '일부 기사 유료 구독 필요. 헤드라인만 수집 가능.',
  },
  {
    name: 'MarketWatch',
    description: '미국 시장/M&A 뉴스.',
    url: 'https://www.marketwatch.com',
    rssUrl: 'https://www.marketwatch.com/rss/topstories',
    type: 'rss',
    language: 'en',
    relevanceScore: 3,
    category: 'global',
    defaultKeywords: BASE_EN_KEYWORDS,
    status: 'active',
    pricingTier: 'free',
  },
  {
    name: 'TechCrunch',
    description: '테크 M&A 전문. 스타트업 인수합병. Term Sheet 뉴스레터.',
    url: 'https://techcrunch.com',
    rssUrl: 'https://techcrunch.com/feed',
    type: 'rss',
    language: 'en',
    relevanceScore: 5,
    category: 'tech',
    defaultKeywords: ['acquisition', 'merger', 'M&A', 'buyout', 'deal', 'raises'],
    status: 'active',
    pricingTier: 'free',
    notes: 'Term Sheet 섹션 특히 유용',
  },
  // === SCRAPING (유료/RSS 미제공) ===
  {
    name: '더벨 (The Bell)',
    description: '국내 M&A 전문 1위 매체. PE/VC 딜 상세, 심층 리포트. RSS 미제공.',
    url: 'https://www.thebell.co.kr/free/content/MA',
    type: 'scraping',
    language: 'ko',
    relevanceScore: 5,
    category: 'domestic',
    listSelector: '.article-list li, .news-list li',
    titleSelector: '.title a, h3 a',
    linkSelector: '.title a, h3 a',
    contentSelector: '.lead, .summary',
    dateSelector: '.date, time',
    defaultKeywords: EXTENDED_KO_KEYWORDS,
    status: 'active',
    pricingTier: 'requires_subscription',
    authType: 'session',
    loginRequired: true,
    notes: '국내 M&A 필수 1위 소스. 유료 구독 필요. 세션 쿠키 로그인 필요.',
  },
  {
    name: '오투저널 (OtoJournal)',
    description: '벤처캐피털 전문. 스타트업 M&A. RSS 미제공.',
    url: 'https://www.otojournal.com',
    type: 'scraping',
    language: 'ko',
    relevanceScore: 4,
    category: 'domestic',
    listSelector: '.news-list li, .post-list li',
    titleSelector: 'h2 a, h3 a, .title a',
    defaultKeywords: [...BASE_KO_KEYWORDS, 'VC', '벤처', '투자'],
    status: 'inactive',
    pricingTier: 'free',
    notes: '사이트 구조 분석 후 셀렉터 업데이트 필요',
  },
  {
    name: 'Nikkei Asia',
    description: '아시아 크로스보더 M&A 전문. 일본/중국/동남아 딜. 유료 구독 필요.',
    url: 'https://asia.nikkei.com',
    type: 'puppeteer',
    language: 'en',
    relevanceScore: 5,
    category: 'asian',
    listSelector: 'article, .article-list__item',
    titleSelector: 'h3 a, .article-title a',
    defaultKeywords: BASE_EN_KEYWORDS,
    status: 'inactive',
    pricingTier: 'paid',
    loginRequired: true,
    authType: 'session',
    notes: '유료 구독 + 세션 쿠키 로그인 필요. puppeteer로만 수집 가능.',
  },
  // === API ===
  {
    name: 'NewsAPI',
    description: '전 세계 비즈니스 뉴스 어그리게이터. 무료 티어: 일일 100회. M&A 키워드 검색.',
    url: 'https://newsapi.org',
    type: 'api',
    apiEndpoint: 'https://newsapi.org/v2/everything',
    apiKeyRequired: true,
    apiKeyEnvName: 'NEWSAPI_KEY',
    language: 'en',
    relevanceScore: 3,
    category: 'global',
    defaultKeywords: BASE_EN_KEYWORDS,
    status: 'inactive',
    pricingTier: 'free',
    notes: '무료 티어: 일 100회 요청. API 키 필요 (newsapi.org 가입).',
  },
  {
    name: 'Reuters Content API',
    description: '글로벌 M&A 실시간. 딜 뉴스 신속. 유료 API.',
    url: 'https://www.reuters.com/developers',
    type: 'api',
    apiKeyRequired: true,
    apiKeyEnvName: 'REUTERS_API_KEY',
    language: 'en',
    relevanceScore: 5,
    category: 'global',
    defaultKeywords: BASE_EN_KEYWORDS,
    status: 'inactive',
    pricingTier: 'paid',
    notes: '유료. 개발자 등록 후 API 키 발급 필요.',
  },
  // === RSS FREE — 스타트업/PE·VC ===
  {
    name: 'PE Hub',
    description: 'PE/VC 딜 뉴스 전문. 중소형 PE 딜 커버. PE firm 뉴스.',
    url: 'https://www.pehub.com',
    rssUrl: 'https://www.pehub.com/feed/',
    type: 'rss',
    language: 'en',
    relevanceScore: 5,
    category: 'startup',
    defaultKeywords: STARTUP_KEYWORDS,
    status: 'active',
    pricingTier: 'free',
  },
  {
    name: 'PitchBook News',
    description: 'VC/PE 딜 데이터 기반 뉴스. 스타트업 펀딩/EXIT. 밸류에이션 트렌드.',
    url: 'https://pitchbook.com',
    rssUrl: 'https://pitchbook.com/news/rss.xml',
    type: 'rss',
    language: 'en',
    relevanceScore: 5,
    category: 'startup',
    defaultKeywords: [...STARTUP_KEYWORDS, 'series A', 'series B', 'series C', 'valuation'],
    status: 'active',
    pricingTier: 'free',
  },
  {
    name: 'AltAssets',
    description: 'PE/VC 전용 뉴스. LP perspective. 펀드레이징 뉴스.',
    url: 'https://www.altassets.com',
    rssUrl: 'https://www.altassets.com/rss',
    type: 'rss',
    language: 'en',
    relevanceScore: 4,
    category: 'startup',
    defaultKeywords: STARTUP_KEYWORDS,
    status: 'active',
    pricingTier: 'free',
  },
  {
    name: 'VentureBeat',
    description: '테크 스타트업 M&A. VC 투자 뉴스.',
    url: 'https://venturebeat.com',
    rssUrl: 'https://venturebeat.com/feed/',
    type: 'rss',
    language: 'en',
    relevanceScore: 4,
    category: 'startup',
    defaultKeywords: [...STARTUP_KEYWORDS, 'funding round', 'Series'],
    status: 'active',
    pricingTier: 'free',
  },
  {
    name: 'Crunchbase News',
    description: 'Crunchbase 데이터 기반. 글로벌 펀딩/EXIT.',
    url: 'https://news.crunchbase.com',
    rssUrl: 'https://news.crunchbase.com/feed/',
    type: 'rss',
    language: 'en',
    relevanceScore: 4,
    category: 'startup',
    defaultKeywords: [...STARTUP_KEYWORDS, 'series A', 'series B', 'IPO', 'unicorn'],
    status: 'active',
    pricingTier: 'free',
  },
  {
    name: 'Business Insider',
    description: '비즈니스/PE/VC 뉴스. 딜 뉴스 빠름.',
    url: 'https://www.businessinsider.com',
    rssUrl: 'https://www.businessinsider.com/rss',
    type: 'rss',
    language: 'en',
    relevanceScore: 3,
    category: 'startup',
    defaultKeywords: BASE_EN_KEYWORDS,
    status: 'active',
    pricingTier: 'free',
  },
  {
    name: 'Institutional Investor',
    description: '기관투자/PE 뉴스. LP perspective. PE 펀드 성과.',
    url: 'https://www.institutionalinvestor.com',
    rssUrl: 'https://www.institutionalinvestor.com/rss',
    type: 'rss',
    language: 'en',
    relevanceScore: 4,
    category: 'startup',
    defaultKeywords: STARTUP_KEYWORDS,
    status: 'active',
    pricingTier: 'free',
  },
  // === SCRAPING — 스타트업/PE·VC ===
  {
    name: 'Fortune Term Sheet',
    description: 'Fortune의 Term Sheet 컬럼. 딜 뉴스 1위.',
    url: 'https://fortune.com/section/term-sheet/',
    type: 'scraping',
    language: 'en',
    relevanceScore: 5,
    category: 'startup',
    listSelector: '.article-list article, .content-list article, .river-item',
    titleSelector: 'h3 a, h2 a, .article-title a',
    defaultKeywords: STARTUP_KEYWORDS,
    status: 'active',
    pricingTier: 'free',
    notes: '웹 스크래핑 필요. CSS 셀렉터 검증 후 사용 권장.',
  },
  {
    name: 'Axios Pro Rata',
    description: '딜 뉴스 전문. PE/VC/SPAC 커버.',
    url: 'https://www.axios.com/pro-rata',
    type: 'scraping',
    language: 'en',
    relevanceScore: 5,
    category: 'startup',
    listSelector: '.story, .story-content, article',
    titleSelector: 'h2 a, h3 a, .headline a',
    defaultKeywords: STARTUP_KEYWORDS,
    status: 'active',
    pricingTier: 'free',
    notes: '웹 스크래핑. 일부 기사 직접 접근 가능.',
  },
  {
    name: 'Private Equity International',
    description: '글로벌 PE 뉴스 1위. PE 딜 데이터. 펀드레이징 트래킹.',
    url: 'https://www.privateequityinternational.com',
    type: 'scraping',
    language: 'en',
    relevanceScore: 5,
    category: 'startup',
    defaultKeywords: STARTUP_KEYWORDS,
    status: 'inactive',
    pricingTier: 'requires_subscription',
    notes: '유료 구독 필요.',
  },
  {
    name: 'Buyouts News',
    description: 'LBO/Buyout 전문. 중소형 PE 딜.',
    url: 'https://www.buyoutsnews.com',
    type: 'scraping',
    language: 'en',
    relevanceScore: 5,
    category: 'startup',
    defaultKeywords: STARTUP_KEYWORDS,
    status: 'inactive',
    pricingTier: 'requires_subscription',
    notes: '유료 구독 필요.',
  },
];

// ─────────────────────────────────────────
// Seed function
// ─────────────────────────────────────────
export async function seedGlobalSources(): Promise<void> {
  const db = admin.firestore();
  const colRef = db.collection('globalSources');

  const existing = await colRef.limit(1).get();
  if (!existing.empty) {
    console.log('Global sources already seeded, skipping.');
    return;
  }

  const batch = db.batch();
  for (const source of INITIAL_GLOBAL_SOURCES) {
    const ref = colRef.doc();
    batch.set(ref, {
      ...source,
      id: ref.id,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: 'system',
    });
  }
  await batch.commit();
  console.log(`Seeded ${INITIAL_GLOBAL_SOURCES.length} global sources.`);
}

// ─────────────────────────────────────────
// Test a source (RSS/scraping/api)
// ─────────────────────────────────────────
export async function testGlobalSource(sourceId: string): Promise<{
  success: boolean;
  message: string;
  articlesFound?: number;
  latencyMs?: number;
  sampleTitles?: string[];
}> {
  const db = admin.firestore();
  const sourceDoc = await db.collection('globalSources').doc(sourceId).get();
  if (!sourceDoc.exists) {
    return { success: false, message: 'Source not found' };
  }

  const source = sourceDoc.data() as GlobalSource;
  const startMs = Date.now();

  try {
    if (source.type === 'rss') {
      if (!source.rssUrl && !source.url) {
        return { success: false, message: 'RSS source is missing feed URL' };
      }
      return await testRssSource(source, startMs);
    } else if (source.type === 'scraping') {
      return await testScrapingSource(source, startMs);
    } else if (source.type === 'api') {
      return await testApiSource(source, startMs);
    } else if (source.type === 'puppeteer') {
      return {
        success: true,
        message: 'Puppeteer sources require a full pipeline run. Manual test not supported in quick-test mode.',
        latencyMs: Date.now() - startMs,
      };
    } else {
      return { success: false, message: `Unsupported source type: ${source.type}` };
    }
  } catch (err: any) {
    return {
      success: false,
      message: err.message || 'Unknown error',
      latencyMs: Date.now() - startMs,
    };
  }
}

// ─────────────────────────────────────────
// XML 전처리 (testRssSource 전용)
// 1. Bare & 엔티티 수정
// 2. 값 없는 HTML 불리언 속성 수정 (e.g. <img loading> → <img loading="">)
// ─────────────────────────────────────────
function preprocessXmlForTest(xml: string): string {
  return xml
    .replace(/&(?!(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)/gi, '&amp;')
    .replace(/<([a-zA-Z][a-zA-Z0-9_:-]*)([^>]*)>/g, (_m, tagName, rest) => {
      if (!rest || !rest.includes(' ')) return `<${tagName}${rest}>`;
      const fixedRest = rest.replace(
        /(\s+)([a-zA-Z][a-zA-Z0-9_:-]*)(?!\s*=)(?=\s|\/|$)/g,
        '$1$2=""',
      );
      return `<${tagName}${fixedRest}>`;
    });
}

async function testRssSource(source: GlobalSource, startMs: number) {
  const RssParser = require('rss-parser');
  const USER_AGENT = 'Mozilla/5.0 (compatible; ainews-bot/1.0; +https://ainews.io)';
  const HEADERS = {
    'User-Agent': USER_AGENT,
    'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  };
  const parser = new RssParser({ timeout: 15000, headers: HEADERS });

  const feedUrl = source.rssUrl || source.url;
  let feed: any;

  try {
    // 1차 시도: 일반 파싱
    feed = await parser.parseURL(feedUrl);
  } catch (firstErr: any) {
    // 2차 시도: 수동 fetch + XML 전처리 (한국 RSS 비표준 처리)
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(feedUrl, { signal: controller.signal as any, headers: HEADERS });
      clearTimeout(tid);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const rawXml = await resp.text();
      feed = await parser.parseString(preprocessXmlForTest(rawXml));
    } catch (secondErr: any) {
      throw new Error(`RSS parse failed [${firstErr.message}] | Fallback: [${secondErr.message}]`);
    }
  }

  const latencyMs = Date.now() - startMs;
  const items = (feed && Array.isArray(feed.items)) ? feed.items : [];
  const sampleTitles = items.slice(0, 3).map((item: any) => item.title || '(no title)');

  return {
    success: feed && items.length > 0,
    message: items.length > 0
      ? `OK — ${items.length} items found in feed`
      : 'Feed parsed but no items found',
    articlesFound: items.length,
    latencyMs,
    sampleTitles,
  };
}

async function testScrapingSource(source: GlobalSource, startMs: number) {
  const cheerio = require('cheerio');

  const response = await axios.get(source.url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; EUM-Bot/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
    },
    timeout: 15000,
  });

  const latencyMs = Date.now() - startMs;
  const $ = cheerio.load(response.data);

  const listSelector = source.listSelector || 'article, .article, .post, li';
  const titleSelector = source.titleSelector || 'h1, h2, h3, .title';

  const items: string[] = [];
  $(listSelector).each((_: any, el: any) => {
    const titleEl = $(el).find(titleSelector).first();
    const title = titleEl.text().trim();
    if (title && title.length > 5) items.push(title);
  });

  const uniqueItems = [...new Set(items)].slice(0, 20);

  return {
    success: uniqueItems.length > 0,
    message: uniqueItems.length > 0
      ? `OK — ${uniqueItems.length} items found with selector "${listSelector}"`
      : `No items found with selector "${listSelector}". Check selectors.`,
    articlesFound: uniqueItems.length,
    latencyMs,
    sampleTitles: uniqueItems.slice(0, 3),
  };
}

async function testApiSource(source: GlobalSource, startMs: number) {
  if (!source.apiEndpoint) {
    return { success: false, message: 'No API endpoint configured' };
  }

  // Simple connectivity check; actual API auth not required for test
  const response = await axios.get(source.apiEndpoint, {
    timeout: 10000,
    validateStatus: (status) => status < 500,
  });

  const latencyMs = Date.now() - startMs;

  return {
    success: response.status === 200 || response.status === 401 || response.status === 403,
    message: response.status === 200
      ? 'API endpoint reachable'
      : response.status === 401 || response.status === 403
        ? 'Endpoint reachable but auth required (expected). Configure API key.'
        : `HTTP ${response.status}`,
    latencyMs,
  };
}
