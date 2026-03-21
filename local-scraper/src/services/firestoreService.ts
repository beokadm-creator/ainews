import * as admin from 'firebase-admin';
import * as crypto from 'crypto';
import * as fs from 'fs';

let initialized = false;

export function initFirestore(): void {
  if (initialized) return;

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  const projectId = process.env.FIREBASE_PROJECT_ID;

  if (!projectId) {
    console.warn('[Firestore] FIREBASE_PROJECT_ID not set — Firestore push disabled');
    return;
  }

  try {
    if (serviceAccountPath && fs.existsSync(serviceAccountPath)) {
      const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId,
      });
      console.log('[Firestore] Initialized with service account');
    } else {
      admin.initializeApp({ projectId });
      console.log('[Firestore] Initialized with Application Default Credentials');
    }
    initialized = true;
  } catch (e: any) {
    console.error('[Firestore] Init failed:', e.message);
  }
}

export function isFirestoreReady(): boolean {
  return initialized;
}

export function hashUrl(url: string): string {
  return crypto.createHash('md5').update(url).digest('hex');
}

/**
 * paidSourceAccess/{sourceId} 컬렉션에서 해당 소스에 접근 허용된 회사 ID 목록을 반환.
 * 컬렉션/문서가 없으면 빈 배열 반환.
 */
export async function getAuthorizedCompanyIds(sourceId: string): Promise<string[]> {
  if (!initialized) return [];
  const db = admin.firestore();
  const doc = await db.collection('paidSourceAccess').doc(sourceId).get();
  if (!doc.exists) return [];
  return (doc.data()?.authorizedCompanyIds as string[]) || [];
}

export interface ArticleData {
  title: string;
  url: string;
  content: string;
  publishedAt: Date;
  source: string;
  sourceId: string;
  category?: string;
  isPaid?: boolean;
  author?: string;
  subtitle?: string;
  date?: string;
}

/**
 * 특정 회사에 기사를 저장. urlHash + companyId 조합으로 중복 체크.
 * @returns true=저장됨, false=중복 스킵
 */
export async function saveArticleForCompany(
  article: ArticleData,
  companyId: string,
): Promise<boolean> {
  if (!initialized) return false;

  const db = admin.firestore();
  const urlHash = hashUrl(article.url);

  const existing = await db.collection('articles')
    .where('urlHash', '==', urlHash)
    .where('companyId', '==', companyId)
    .limit(1)
    .get();

  if (!existing.empty) return false;

  const articleRef = db.collection('articles').doc();
  await articleRef.set({
    id: articleRef.id,
    title: article.title,
    url: article.url,
    content: article.content,
    publishedAt: article.publishedAt,
    source: article.source,
    sourceId: article.sourceId,
    sourceCategory: article.category || null,
    isPaid: article.isPaid ?? null,
    author: article.author || null,
    subtitle: article.subtitle || null,
    date: article.date || null,
    companyId,
    collectedAt: admin.firestore.FieldValue.serverTimestamp(),
    status: 'pending',
    urlHash,
    collectedBy: 'local-scraper',
  });

  return true;
}
