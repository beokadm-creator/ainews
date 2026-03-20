import * as admin from 'firebase-admin';

const REQUIRED_COLLECTIONS = [
  'companies',
  'articles',
  'outputs',
  'pipelineRuns',
  'sources',
  'users',
  // 신규 컬렉션
  'globalSources',
  'companySourceSubscriptions',
  'companySettings',
];

export async function validateFirestoreCollections(): Promise<{
  valid: boolean;
  missing: string[];
  existing: string[];
}> {
  const db = admin.firestore();
  const missing: string[] = [];
  const existing: string[] = [];

  for (const collectionName of REQUIRED_COLLECTIONS) {
    try {
      const snapshot = await db.collection(collectionName).limit(1).get();
      existing.push(collectionName);
    } catch (error: any) {
      if (error.code === 5 || error.code === 'NOT_FOUND') {
        missing.push(collectionName);
      } else {
        console.warn(`Warning checking collection ${collectionName}:`, error.message);
        existing.push(collectionName);
      }
    }
  }

  return {
    valid: missing.length === 0,
    missing,
    existing
  };
}

export async function ensureCollectionsExist(): Promise<void> {
  const validation = await validateFirestoreCollections();
  
  if (!validation.valid) {
    console.warn('Missing Firestore collections:', validation.missing.join(', '));
    console.warn('Please create the following collections:', validation.missing.join(', '));
  } else {
    console.log('All required Firestore collections exist:', validation.existing.join(', '));
  }
}
