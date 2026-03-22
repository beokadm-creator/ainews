const admin = require('firebase-admin');

if (!admin.apps.length) {
  // Try to use ADC or environment-default or ignore auth for purely query purposes
  // if run in a project dir that has .firebaserc and env set.
  admin.initializeApp({
    projectId: 'eumnews-9a99c'
  });
}

const db = admin.firestore();

async function run() {
  const snap = await db.collection('globalSources').get();
  const sources = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  
  const rssApi = sources.filter(s => s.type === 'rss' || s.type === 'api');
  
  console.log('--- FOUND ' + rssApi.length + ' RSS/API SOURCES ---');
  let failures = 0;
  
  rssApi.forEach(s => {
    const isFailed = s.status === 'error' || (s.lastTestResult && s.lastTestResult.success === false);
    if (!isFailed) return; // Only show failures for now as requested
    
    failures++;
    console.log(`[${s.type.toUpperCase()}] ${s.name}`);
    console.log(`  - Status: ${s.status}`);
    console.log(`  - URL: ${s.url}`);
    if (s.rssUrl) console.log(`  - RSS: ${s.rssUrl}`);
    if (s.lastTestResult) {
      console.log(`  - Error: ${s.lastTestResult.message}`);
    }
    console.log('-----------------------------------');
  });
  
  if (failures === 0) {
    console.log('No explicitly failed RSS/API sources found in current state.');
  }
}

run().catch(console.error);
