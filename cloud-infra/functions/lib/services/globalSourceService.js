"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.INITIAL_GLOBAL_SOURCES = void 0;
exports.seedGlobalSources = seedGlobalSources;
exports.testGlobalSource = testGlobalSource;
const admin = __importStar(require("firebase-admin"));
const axios_1 = __importDefault(require("axios"));
// ─────────────────────────────────────────
// Initial seed data from MA-media-sources.md
// ─────────────────────────────────────────
exports.INITIAL_GLOBAL_SOURCES = [
    // === RSS FREE ===
    {
        name: '한국경제신문',
        description: '국내 주요 경제 매체. M&A 전담 기자 보유. RSS 모든 섹션 제공.',
        url: 'https://www.hankyung.com',
        rssUrl: 'https://www.hankyung.com/rss',
        type: 'rss',
        language: 'ko',
        relevanceScore: 4,
        category: 'domestic',
        defaultKeywords: ['M&A', '인수', '합병', '피인수', '사모펀드', 'PE', 'VC'],
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
        defaultKeywords: ['M&A', '인수합병', '피인수', '지분인수', '사모펀드'],
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
        defaultKeywords: ['M&A', 'PE', 'VC', '인수', '합병'],
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
        defaultKeywords: ['M&A', '인수', '합병', 'PE'],
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
        defaultKeywords: ['M&A', '인수', '합병'],
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
        defaultKeywords: ['M&A', '인수', '합병'],
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
        defaultKeywords: ['M&A', '인수', '합병'],
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
        defaultKeywords: ['M&A', '인수', '합병', 'PE', 'VC'],
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
        defaultKeywords: ['M&A', '인수', '합병', '뉴스와이어'],
        status: 'active',
        pricingTier: 'free',
    },
    {
        name: 'The Korea Herald',
        description: '한국 경제 뉴스 영문판. 크로스보더 M&A 특화.',
        url: 'http://www.koreaherald.com',
        rssUrl: 'http://www.koreaherald.com/rss',
        type: 'rss',
        language: 'en',
        relevanceScore: 3,
        category: 'domestic',
        defaultKeywords: ['M&A', 'merger', 'acquisition', 'private equity'],
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
        defaultKeywords: ['M&A', 'merger', 'acquisition', 'PE', 'VC', 'private equity'],
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
        defaultKeywords: ['M&A', 'merger', 'acquisition', 'deal', 'private equity'],
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
        defaultKeywords: ['M&A', 'merger', 'acquisition', 'deal'],
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
        defaultKeywords: ['acquisition', 'merger', 'M&A', 'buyout', 'deal'],
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
        defaultKeywords: ['M&A', 'PE', 'VC', '인수', '합병', '사모펀드'],
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
        defaultKeywords: ['M&A', 'VC', '벤처', '투자', '인수'],
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
        defaultKeywords: ['M&A', 'acquisition', 'merger', 'private equity', 'deal'],
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
        defaultKeywords: ['M&A', 'merger', 'acquisition', 'private equity', 'buyout'],
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
        defaultKeywords: ['M&A', 'merger', 'acquisition', 'deal'],
        status: 'inactive',
        pricingTier: 'paid',
        notes: '유료. 개발자 등록 후 API 키 발급 필요.',
    },
];
// ─────────────────────────────────────────
// Seed function
// ─────────────────────────────────────────
async function seedGlobalSources() {
    const db = admin.firestore();
    const colRef = db.collection('globalSources');
    const existing = await colRef.limit(1).get();
    if (!existing.empty) {
        console.log('Global sources already seeded, skipping.');
        return;
    }
    const batch = db.batch();
    for (const source of exports.INITIAL_GLOBAL_SOURCES) {
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
    console.log(`Seeded ${exports.INITIAL_GLOBAL_SOURCES.length} global sources.`);
}
// ─────────────────────────────────────────
// Test a source (RSS/scraping/api)
// ─────────────────────────────────────────
async function testGlobalSource(sourceId) {
    const db = admin.firestore();
    const sourceDoc = await db.collection('globalSources').doc(sourceId).get();
    if (!sourceDoc.exists) {
        return { success: false, message: 'Source not found' };
    }
    const source = sourceDoc.data();
    const startMs = Date.now();
    try {
        if (source.type === 'rss' && source.rssUrl) {
            return await testRssSource(source, startMs);
        }
        else if (source.type === 'scraping') {
            return await testScrapingSource(source, startMs);
        }
        else if (source.type === 'api') {
            return await testApiSource(source, startMs);
        }
        else if (source.type === 'puppeteer') {
            return {
                success: true,
                message: 'Puppeteer sources require a full pipeline run. Manual test not supported in quick-test mode.',
                latencyMs: Date.now() - startMs,
            };
        }
        else {
            return { success: false, message: `Unsupported source type: ${source.type}` };
        }
    }
    catch (err) {
        return {
            success: false,
            message: err.message || 'Unknown error',
            latencyMs: Date.now() - startMs,
        };
    }
}
async function testRssSource(source, startMs) {
    const RssParser = require('rss-parser');
    const parser = new RssParser({ timeout: 10000 });
    const feed = await parser.parseURL(source.rssUrl);
    const latencyMs = Date.now() - startMs;
    const items = feed.items || [];
    const sampleTitles = items.slice(0, 3).map((item) => item.title || '(no title)');
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
async function testScrapingSource(source, startMs) {
    const cheerio = require('cheerio');
    const response = await axios_1.default.get(source.url, {
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
    const items = [];
    $(listSelector).each((_, el) => {
        const titleEl = $(el).find(titleSelector).first();
        const title = titleEl.text().trim();
        if (title && title.length > 5)
            items.push(title);
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
async function testApiSource(source, startMs) {
    if (!source.apiEndpoint) {
        return { success: false, message: 'No API endpoint configured' };
    }
    // Simple connectivity check; actual API auth not required for test
    const response = await axios_1.default.get(source.apiEndpoint, {
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
//# sourceMappingURL=globalSourceService.js.map