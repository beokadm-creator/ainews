/**
 * 유료 소스 초기 설정 스크립트
 * 실행: node setup-paid-sources.cjs
 *
 * 작업:
 * 1. paidSourceAccess 컬렉션 초기화 (이음프라이빗에쿼티 접근 허용)
 * 2. 더벨 globalSource에 isPaid/localScraperRequired 플래그 추가
 * 3. 마켓인사이트 globalSource 생성
 */

const admin = require('firebase-admin');
const serviceAccount = require('../../firebase-service-account.json.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'eumnews-9a99c',
});

const db = admin.firestore();

// 이음프라이빗에쿼티 회사 ID
const EUPM_COMPANY_ID = 'hXrkqZGsBHnVQehV9SIv';

// 더벨 globalSource ID (기존)
const THEBELL_SOURCE_ID = '3SyJIZR4Ih9BLuOztTBa';

async function run() {
  console.log('=== 유료 소스 초기 설정 시작 ===\n');

  // 1. paidSourceAccess 초기화
  console.log('1. paidSourceAccess 설정...');
  await db.collection('paidSourceAccess').doc('marketinsight').set({
    sourceId: 'marketinsight',
    sourceName: '마켓인사이트 (MarketInsight)',
    authorizedCompanyIds: [EUPM_COMPANY_ID],
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: 'system-init',
  });
  console.log('  ✓ marketinsight → [이음프라이빗에쿼티]');

  await db.collection('paidSourceAccess').doc('thebell').set({
    sourceId: 'thebell',
    sourceName: '더벨 (TheBell)',
    authorizedCompanyIds: [EUPM_COMPANY_ID],
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: 'system-init',
  });
  console.log('  ✓ thebell → [이음프라이빗에쿼티]');

  // 2. 더벨 globalSource 업데이트
  console.log('\n2. 더벨 globalSource 업데이트...');
  await db.collection('globalSources').doc(THEBELL_SOURCE_ID).update({
    isPaid: true,
    localScraperRequired: true,
    localScraperId: 'thebell',
    description: '국내 딜/투자 전문 유료 매체. 로컬 Puppeteer 스크래퍼로 수집.',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log('  ✓ 더벨 — isPaid:true, localScraperRequired:true');

  // 3. 마켓인사이트 globalSource 생성
  console.log('\n3. 마켓인사이트 globalSource 생성...');
  const miRef = db.collection('globalSources').doc('marketinsight');
  await miRef.set({
    id: 'marketinsight',
    name: '마켓인사이트 (MarketInsight)',
    url: 'https://marketinsight.hankyung.com/mna',
    type: 'local-scraper',
    localScraperId: 'marketinsight',
    isPaid: true,
    localScraperRequired: true,
    status: 'active',
    category: 'M&A',
    description: '한국경제신문 M&A 전문 유료 매체. 로컬 Puppeteer 스크래퍼로 수집.',
    relevanceScore: 95,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log('  ✓ 마켓인사이트 — id:marketinsight, isPaid:true');

  // 4. 검증
  console.log('\n=== 검증 ===');
  const psa = await db.collection('paidSourceAccess').get();
  psa.docs.forEach(d => {
    console.log(`paidSourceAccess/${d.id}:`, d.data().authorizedCompanyIds);
  });

  const miDoc = await db.collection('globalSources').doc('marketinsight').get();
  console.log('globalSources/marketinsight:', miDoc.data()?.name, '| isPaid:', miDoc.data()?.isPaid);

  const tbDoc = await db.collection('globalSources').doc(THEBELL_SOURCE_ID).get();
  console.log('globalSources/thebell:', tbDoc.data()?.name, '| isPaid:', tbDoc.data()?.isPaid);

  console.log('\n✅ 설정 완료!');
  process.exit(0);
}

run().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
