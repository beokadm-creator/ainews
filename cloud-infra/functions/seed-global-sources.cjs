const admin = require('firebase-admin');
const path = require('path');
const serviceAccount = require('./service-account.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const mediaSources = [
  // ─── 한국 경제/금융 매체 (RSS) ───────────────────────────────
  { name: '한국경제', url: 'https://www.hankyung.com/feed/economy', type: 'rss', language: 'ko', category: 'domestic', relevanceScore: 4 },
  { name: '매일경제', url: 'https://www.mk.co.kr/rss/30100041/', type: 'rss', language: 'ko', category: 'domestic', relevanceScore: 4 },
  { name: '파이낸셜뉴스', url: 'https://www.fnnews.com/rss/r20/fn_realnews_economy.xml', type: 'rss', language: 'ko', category: 'domestic', relevanceScore: 4 },
  { name: '이데일리', url: 'http://rss.edaily.co.kr/finance_news.xml', type: 'rss', language: 'ko', category: 'domestic', relevanceScore: 3 },
  { name: '서울경제', url: 'https://www.sedaily.com/rss/economy', type: 'rss', language: 'ko', category: 'domestic', relevanceScore: 3 },
  { name: '헤럴드경제', url: 'https://biz.heraldcorp.com/rss/google/economy', type: 'rss', language: 'ko', category: 'domestic', relevanceScore: 3 },
  { name: '아시아경제', url: 'https://www.asiae.co.kr/rss/economy.htm', type: 'rss', language: 'ko', category: 'domestic', relevanceScore: 3 },
  { name: '머니투데이', url: 'http://rss.mt.co.kr/mt_news.xml', type: 'rss', language: 'ko', category: 'domestic', relevanceScore: 3 },
  { name: '연합뉴스', url: 'http://www.yonhapnews.co.kr/RSS/economy.xml', type: 'rss', language: 'ko', category: 'domestic', relevanceScore: 4 },
  { name: '뉴시스', url: 'https://newsis.com/RSS/economy.xml', type: 'rss', language: 'ko', category: 'domestic', relevanceScore: 3 },
  { name: '조선비즈', url: 'http://biz.chosun.com/site/data/rss/news.xml', type: 'rss', language: 'ko', category: 'domestic', relevanceScore: 3 },

  // ─── 해외 M&A/금융 전문 (RSS) ────────────────────────────────
  { name: 'DealStreetAsia', url: 'https://dealstreetasia.com/feed/', type: 'rss', language: 'en', category: 'asian', relevanceScore: 5 },
  { name: 'Financial Times', url: 'https://feeds.ft.com/ft/news?format=rss', type: 'rss', language: 'en', category: 'global', relevanceScore: 5 },
  { name: 'MarketWatch', url: 'https://feeds.marketwatch.com/marketwatch/topstories/', type: 'rss', language: 'en', category: 'global', relevanceScore: 3 },

  // ─── PC 로컬 스크래퍼 (로그인 필요, 유료) ─────────────────────
  { name: '더벨 (The Bell)', url: 'https://www.thebell.co.kr', type: 'local-scraper', language: 'ko', category: 'domestic', relevanceScore: 5, isPaid: true, loginRequired: true },
  { name: '마켓인사이트', url: 'https://marketinsight.hankyung.com', type: 'local-scraper', language: 'ko', category: 'domestic', relevanceScore: 5, isPaid: true, loginRequired: true }
];

async function seed() {
  console.log('Starting seed process...');
  const colRef = db.collection('globalSources');

  for (const src of mediaSources) {
    const query = await colRef.where('url', '==', src.url).get();
    if (query.empty) {
      const docRef = colRef.doc();
      await docRef.set({
        ...src,
        id: docRef.id,
        status: 'active',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`Added: ${src.name}`);
    } else {
      console.log(`Skipped (exists): ${src.name}`);
    }
  }
  process.exit(0);
}

seed().catch(err => {
  console.error(err);
  process.exit(1);
});
