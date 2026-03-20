import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { SourceType } from '../src/types';

// TODO: Replace with your service account key path
// const serviceAccount = require('./serviceAccountKey.json');

// initializeApp({
//   credential: cert(serviceAccount)
// });

// const db = getFirestore();

const initialSources = [
  {
    id: 'naver_econ_rss',
    name: '네이버 경제 뉴스',
    url: 'https://news.naver.com/main/list.nhn?mode=LSD&mid=sec&sid1=101',
    type: 'rss' as SourceType,
    active: true,
    note: '기본 경제 뉴스 RSS'
  },
  {
    id: 'naver_finance_rss',
    name: '네이버 금융 뉴스',
    url: 'https://news.naver.com/main/list.nhn?mode=LSD&mid=sec&sid1=259',
    type: 'rss' as SourceType,
    active: true,
    note: '금융/증권 섹션 RSS'
  },
  {
    id: 'google_news_ma',
    name: '구글 뉴스 (M&A/사모펀드)',
    url: 'https://news.google.com/rss/search?q=M%26A+%EC%82%AC%EB%AA%A8%ED%8E%80%EB%93%9C&hl=ko&gl=KR',
    type: 'rss' as SourceType,
    active: true,
    note: '구글 뉴스 키워드 검색 결과'
  },
  {
    id: 'mk_econ_rss',
    name: '매일경제 경제',
    url: 'https://www.mk.co.kr/rss/30100001/',
    type: 'rss' as SourceType,
    active: true,
    note: '매경 경제 섹션'
  },
  {
    id: 'hankyung_econ_rss',
    name: '한국경제 경제',
    url: 'https://www.hankyung.com/rss/economy.rdf',
    type: 'rss' as SourceType,
    active: true,
    note: '한경 경제 섹션'
  },
  {
    id: 'wsj_markets_rss',
    name: 'WSJ Markets (영문)',
    url: 'https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml',
    type: 'rss' as SourceType,
    active: true,
    note: 'Wall Street Journal 비즈니스/마켓 (자동 국문 번역됨)'
  },
  {
    id: 'bloomberg_ma_rss',
    name: 'Bloomberg M&A (영문)',
    url: 'https://feeds.bloomberg.com/markets/news.rss',
    type: 'rss' as SourceType,
    active: true,
    note: 'Bloomberg 마켓 뉴스 (자동 국문 번역됨)'
  },
  {
    id: 'thebell',
    name: '더벨(The Bell)',
    url: 'https://www.thebell.co.kr',
    type: 'puppeteer' as SourceType,
    active: false,
    authType: 'puppeteer',
    note: '관리자 PC 등록 및 세션 추출 필요 (Phase 11에서 활성화)'
  },
  {
    id: 'investchosun',
    name: '인베스트조선',
    url: 'https://www.investchosun.com',
    type: 'puppeteer' as SourceType,
    active: false,
    authType: 'session',
    note: '유료 계정 로그인 필요 (1계정 2IP 제한 주의)'
  }
];

const initialSettings = {
  id: 'global',
  scrapingIntervalMinutes: 60,
  briefingGenerationTime: '07:00',
  timezone: 'Asia/Seoul',
  activeDays: [1, 2, 3, 4, 5], // Mon-Fri
  glmModel: 'glm-4',
  promptVersion: 'v1.0',
  adminEmails: [],
  adminTelegramIds: [],
  notifyOnScrapingError: true,
  updatedAt: new Date(),
  updatedBy: 'system'
};

export async function seedDatabase(db: FirebaseFirestore.Firestore) {
  console.log('Starting database seeding...');

  try {
    // Seed Sources
    const sourcesRef = db.collection('sources');
    for (const source of initialSources) {
      await sourcesRef.doc(source.id).set({
        ...source,
        createdAt: new Date(),
        updatedAt: new Date()
      });
      console.log(`Seeded source: ${source.name}`);
    }

    // Seed Global Settings
    await db.collection('settings').doc('global').set(initialSettings);
    console.log('Seeded global settings');

    console.log('Database seeding completed successfully!');
  } catch (error) {
    console.error('Error seeding database:', error);
    throw error;
  }
}

// If running directly
// seedDatabase(db).catch(console.error);
