import * as admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: 'eumnews-9a99c'
  });
}

const db = admin.firestore();

async function listFailedSources() {
  const sourcesRef = db.collection('globalSources');
  // RSS와 API 타입만 조회
  const snapshot = await sourcesRef
    .where('type', 'in', ['rss', 'api'])
    .get();

  const failedSources = snapshot.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter((s: any) => 
      s.status === 'error' || 
      (s.lastTestResult && s.lastTestResult.success === false)
    );

  console.log(JSON.stringify(failedSources, null, 2));
}

listFailedSources().catch(console.error);
