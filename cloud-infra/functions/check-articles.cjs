const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function check() {
  try {
    console.log('📊 DB 통계 조회 중...\n');

    // 1. Sources 확인
    const sourcesSnap = await db.collection('globalSources').get();
    console.log(`✅ globalSources: ${sourcesSnap.size}개`);
    sourcesSnap.docs.forEach(doc => {
      const data = doc.data();
      console.log(`  - ${data.name} (${data.type}): ${data.url}`);
    });

    console.log('\n');

    // 2. Articles 상태별 통계
    const statuses = ['pending', 'analyzed', 'rejected', 'published'];
    for (const status of statuses) {
      const snap = await db.collection('articles')
        .where('status', '==', status)
        .limit(1)
        .get();
      console.log(`📰 Articles (${status}): ${snap.size} 건 확인됨`);
    }

    // 3. 전체 articles 수
    const allArticles = await db.collection('articles').count().get();
    console.log(`\n📊 전체 articles: ${allArticles.data().count}건`);

    // 4. 최근 articles 샘플
    const recent = await db.collection('articles')
      .orderBy('collectedAt', 'desc')
      .limit(5)
      .get();

    if (recent.docs.length > 0) {
      console.log('\n📋 최근 수집된 기사:');
      recent.docs.forEach((doc, i) => {
        const data = doc.data();
        console.log(`  ${i+1}. [${data.status}] ${data.title} (${data.source})`);
      });
    }

  } catch (err) {
    console.error('❌ 에러:', err.message);
  }
  process.exit(0);
}

check();
