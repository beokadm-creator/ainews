const admin = require('firebase-admin');
const fetch = require('node-fetch');
const serviceAccount = require('./service-account.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

async function trigger() {
  try {
    console.log('🔄 RSS 수집 시작 중...');

    // Custom token 생성
    const token = await admin.auth().createCustomToken('rss-collector');

    // HTTP 요청 보내기
    const response = await fetch(
      'https://triggerrsscollection-mp66iufeia-uc.a.run.app/',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({})
      }
    );

    const data = await response.json();
    console.log('✅ RSS 수집 시작됨');
    console.log('응답:', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('❌ 에러:', err.message);
  }
  process.exit(0);
}

trigger();
