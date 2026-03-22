const admin = require('firebase-admin');
const path = require('path');

const serviceAccount = require('./service-account.json');

// Initialize with environment variables or default config
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

const UPDATED_SOURCES = [
  { name: '매일경제', rssUrl: 'https://www.mk.co.kr/rss/30000003/', type: 'rss' },
  { name: '이데일리', rssUrl: 'http://rss.edaily.co.kr/stock_news.xml', type: 'rss' },
  { name: '서울경제', rssUrl: 'https://www.sedaily.com/rss/economy', type: 'rss' },
  { name: '헤럴드경제', rssUrl: 'https://biz.heraldcorp.com/rss/google/economy', type: 'rss' },
  { name: '아시아경제', rssUrl: 'https://www.asiae.co.kr/rss/economy.htm', type: 'rss' },
  { name: 'The Korea Herald', rssUrl: 'https://www.koreaherald.com/rss/020000000000.xml', type: 'rss' },
  { name: 'DealStreetAsia', rssUrl: 'https://www.dealstreetasia.com/section/private-equity/feed/', type: 'rss' },
  { name: 'Financial Times', rssUrl: 'https://www.ft.com/companies?format=rss', type: 'rss' }
];

async function updateSources() {
  console.log('--- STARTING RSS URL UPDATE ---');
  const colRef = db.collection('globalSources');

  for (const update of UPDATED_SOURCES) {
    const query = await colRef.where('name', '==', update.name).get();
    if (query.empty) {
      console.log(`[SKIP] Source "${update.name}" not found in database.`);
      continue;
    }

    const doc = query.docs[0];
    const oldData = doc.data();

    // Check if it actually needs update
    if (oldData.rssUrl === update.rssUrl && oldData.type === update.type) {
      console.log(`[SAME] "${update.name}" is already up to date.`);
      continue;
    }

    await doc.ref.update({
      rssUrl: update.rssUrl,
      url: update.rssUrl, // Some systems use 'url' instead of 'rssUrl'
      type: update.type,
      status: 'active',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      notes: (oldData.notes || '') + ' | Updated to working RSS URL on 2026-03-22'
    });

    console.log(`[OK] Updated "${update.name}": ${update.rssUrl}`);
  }

  // Handle sources clearly missing RSS
  const pitchbookQuery = await colRef.where('name', '==', 'PitchBook News').get();
  if (!pitchbookQuery.empty) {
    await pitchbookQuery.docs[0].ref.update({
      status: 'inactive',
      notes: 'No public working RSS feed found. Scraping suggested.'
    });
    console.log('[OK] Marked PitchBook News as inactive.');
  }

  console.log('--- RSS URL UPDATE COMPLETE ---');
}

updateSources().catch(console.error);
