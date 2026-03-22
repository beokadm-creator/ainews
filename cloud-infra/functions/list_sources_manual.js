const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json'); // if available, or use default

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: 'eumnews-9a99c'
  });
}

const db = admin.firestore();

async function run() {
  const snap = await db.collection('globalSources').get();
  const sources = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  
  const rssApi = sources.filter(s => s.type === 'rss' || s.type === 'api');
  
  console.log('--- FOUND ' + rssApi.length + ' RSS/API SOURCES ---');
  rssApi.forEach(s => {
    console.log(`[${s.type.toUpperCase()}] ${s.name}`);
    console.log(`  - Status: ${s.status}`);
    console.log(`  - URL: ${s.url}`);
    if (s.rssUrl) console.log(`  - RSS: ${s.rssUrl}`);
    if (s.lastTestResult) {
      console.log(`  - Last Test: ${s.lastTestResult.success ? 'SUCCESS' : 'FAILED'}`);
      if (!s.lastTestResult.success) console.log(`  - Error: ${s.lastTestResult.message}`);
    }
    console.log('-----------------------------------');
  });
}

run().catch(console.error);
