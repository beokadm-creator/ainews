const admin = require('firebase-admin');
const path = require('path');
const serviceAccount = require('./service-account.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const mediaSources = [
  { name: '한국경제신문', url: 'https://www.hankyung.com/rss', type: 'rss', language: 'ko', relevanceScore: 4 },
  { name: '매일경제', url: 'https://www.mk.co.kr/rss', type: 'rss', language: 'ko', relevanceScore: 4 },
  { name: '파이낸셜뉴스', url: 'https://www.fnnews.com/rss', type: 'rss', language: 'ko', relevanceScore: 3 },
  { name: '이데일리', url: 'https://www.edaily.co.kr/rss', type: 'rss', language: 'ko', relevanceScore: 3 },
  { name: '서울경제', url: 'https://www.sedaily.com/rss', type: 'rss', language: 'ko', relevanceScore: 3 },
  { name: '헤럴드경제', url: 'https://news.heraldcorp.com/rss', type: 'rss', language: 'ko', relevanceScore: 3 },
  { name: '아시아경제', url: 'https://www.asiae.co.kr/rss', type: 'rss', language: 'ko', relevanceScore: 3 },
  { name: '머니투데이', url: 'https://www.mt.co.kr/rss', type: 'rss', language: 'ko', relevanceScore: 3 },
  { name: '연합뉴스', url: 'https://www.yna.co.kr/rss', type: 'rss', language: 'ko', relevanceScore: 4 },
  { name: 'The Korea Herald', url: 'http://www.koreaherald.com/rss', type: 'rss', language: 'en', relevanceScore: 3 },
  { name: 'DealStreetAsia', url: 'https://dealstreetasia.com/rss', type: 'rss', language: 'en', relevanceScore: 5 },
  { name: 'Financial Times', url: 'https://www.ft.com/rss', type: 'rss', language: 'en', relevanceScore: 5 },
  { name: 'MarketWatch', url: 'https://www.marketwatch.com/rss', type: 'rss', language: 'en', relevanceScore: 3 },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed', type: 'rss', language: 'en', relevanceScore: 5 },
  { name: '더벨 (The Bell)', url: 'https://www.thebell.co.kr/free/content/MA', type: 'scraping', language: 'ko', relevanceScore: 5 },
  { name: '오투저널 (OtoJournal)', url: 'https://www.otojournal.com', type: 'scraping', language: 'ko', relevanceScore: 4 }
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
