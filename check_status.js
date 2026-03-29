import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const projectId = 'eumnews-9a99c';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const admin = require('./cloud-infra/functions/node_modules/firebase-admin');

function initializeFirebase() {
  if (admin.apps.length > 0) return;

  const explicitCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const localServiceAccount = path.join(__dirname, 'cloud-infra', 'functions', 'service-account.json');
  const serviceAccountPath = [explicitCredentials, localServiceAccount]
    .find((candidate) => candidate && fs.existsSync(candidate));

  if (serviceAccountPath) {
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId,
    });
    return;
  }

  admin.initializeApp({ projectId });
}

async function countByStatus(db, status) {
  const snapshot = await db.collection('articles').where('status', '==', status).count().get();
  return snapshot.data().count;
}

async function main() {
  initializeFirebase();
  const db = admin.firestore();
  const now = Date.now();
  const statuses = ['pending', 'filtering', 'filtered', 'analyzing', 'analyzed', 'published', 'rejected', 'ai_error', 'analysis_error'];

  console.log('=== Article Counts ===');
  for (const status of statuses) {
    const count = await countByStatus(db, status);
    if (count > 0) {
      console.log(`${status}: ${count}`);
    }
  }

  const workerSnapshot = await db.collection('systemRuntime')
    .where('status', 'in', ['running', 'error'])
    .get();

  console.log('\n=== Worker Leases ===');
  if (workerSnapshot.empty) {
    console.log('No active worker leases.');
  } else {
    workerSnapshot.forEach((doc) => {
      const data = doc.data();
      const leaseUntil = data.leaseUntil?.toDate ? data.leaseUntil.toDate().getTime() : null;
      const remainingMs = leaseUntil ? leaseUntil - now : null;
      console.log(`${doc.id}: status=${data.status || 'unknown'} leaseRemainingMs=${remainingMs ?? 'none'} lastError=${data.lastError || '-'}`);
    });
  }

  const recentRuns = await db.collection('pipelineRuns')
    .orderBy('createdAt', 'desc')
    .limit(10)
    .get();

  console.log('\n=== Recent Pipeline Runs ===');
  if (recentRuns.empty) {
    console.log('No recent pipeline runs found.');
  } else {
    recentRuns.forEach((doc) => {
      const data = doc.data();
      const collectionMs = data.steps?.collection?.result?.duration || 0;
      const filteringMs = data.steps?.filtering?.result?.duration || 0;
      const analysisMs = data.steps?.analysis?.result?.duration || 0;
      const outputMs = data.steps?.output?.result?.duration || 0;
      console.log(`${doc.id}: status=${data.status || '-'} collection=${collectionMs}ms filtering=${filteringMs}ms analysis=${analysisMs}ms output=${outputMs}ms`);
    });
  }
}

main().catch((error) => {
  console.error('Status check failed:', error.message);
  process.exitCode = 1;
});
