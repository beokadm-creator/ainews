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

async function recordArticleDedupEntry(article: {
  id?: string;
  url: string;
  title?: string;
  source?: string;
  sourceId?: string;
  globalSourceId?: string;
  publishedAt?: Date;
  status?: string;
}): Promise<void> {
  if (!initialized || !article.url) return;

  const db = admin.firestore();
  const urlHash = hashUrl(article.url);
  const ref = db.collection('articleDedup').doc(urlHash);

  await ref.set({
    id: urlHash,
    urlHash,
    normalizedUrl: article.url,
    articleId: article.id || null,
    sourceId: article.sourceId || null,
    globalSourceId: article.globalSourceId || article.sourceId || null,
    source: article.source || null,
    title: article.title || null,
    lastStatus: article.status || 'pending',
    publishedAt: article.publishedAt || null,
    firstSeenAt: admin.firestore.FieldValue.serverTimestamp(),
    lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

/**
 * 이미 수집된 URL 해시 집합을 반환 (detail fetch 전 사전 필터링용).
 * 비용 최적화를 위해 limit을 대폭 낮추고 최근 수집분만 가져옵니다.
 */
export async function getCollectedUrlHashes(sourceId: string, limit = 200): Promise<Set<string>> {
  // Deprecated: use batchCheckCollectedUrlHashes for lower cost
  if (!initialized) return new Set();
  const db = admin.firestore();
  try {
    const snap = await db.collection('articleDedup')
      .where('sourceId', '==', sourceId)
      .orderBy('lastSeenAt', 'desc')
      .limit(limit)
      .get();
    const hashes = new Set<string>();
    snap.docs.forEach((d: any) => {
      const h = d.data().urlHash;
      if (h) hashes.add(h);
    });
    return hashes;
  } catch (err: any) {
    console.warn(`[getCollectedUrlHashes] articleDedup 조회 실패 (${sourceId}): ${err?.message}. articles 컬렉션으로 폴백합니다.`);
    try {
      const snap = await db.collection('articles')
        .where('sourceId', '==', sourceId)
        .orderBy('collectedAt', 'desc')
        .limit(limit)
        .get();
      const hashes = new Set<string>();
      snap.docs.forEach((d: any) => {
        const h = d.data().urlHash;
        if (h) hashes.add(h);
      });
      return hashes;
    } catch {
      return new Set();
    }
  }
}

/**
 * 비용 최적화: 스크랩한 기사의 URL 해시 배열만 전달하여, 
 * 존재하는 해시만 조회 (in 쿼리 활용, 30개씩 분할).
 */
export async function batchCheckCollectedUrlHashes(urlHashes: string[]): Promise<Set<string>> {
  if (!initialized || urlHashes.length === 0) return new Set();
  const db = admin.firestore();
  const result = new Set<string>();
  const unique = [...new Set(urlHashes)];

  for (let i = 0; i < unique.length; i += 30) {
    const chunk = unique.slice(i, i + 30);
    try {
      const snap = await db.collection('articleDedup')
        .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
        .get();
      snap.docs.forEach((d: any) => result.add(d.id));
    } catch (err) {
      console.warn(`[batchCheckCollectedUrlHashes] articleDedup in 쿼리 실패, articles로 폴백: ${err}`);
      try {
        const snap = await db.collection('articles')
          .where('urlHash', 'in', chunk)
          .get();
        snap.docs.forEach((d: any) => {
          if (d.data().urlHash) result.add(d.data().urlHash);
        });
      } catch {
        // 무시
      }
    }
  }
  return result;
}

export interface ArticleData {
  title: string;
  url: string;
  content: string;
  publishedAt: Date;
  source: string;
  sourceId: string;
  globalSourceId?: string;
  category?: string;
  isPaid?: boolean;
  sourcePricingTier?: 'free' | 'paid' | 'requires_subscription';
  priorityAnalysis?: boolean;
  priorityAnalysisReason?: string;
  author?: string;
  subtitle?: string;
  date?: string;
  pipelineRunId?: string; // 추적용 ID (없으면 저장 시 생성)
}

/**
 * 기사를 전역으로 저장 (companyId 없음 — 슈퍼어드민이 전체 수집).
 * urlHash로 중복 체크.
 * @returns true=저장됨, false=중복 스킵
 */
export async function saveArticleGlobal(article: ArticleData): Promise<boolean> {
  if (!initialized) return false;

  const db = admin.firestore();
  const urlHash = hashUrl(article.url);

  const existingDedup = await db.collection('articleDedup').doc(urlHash).get();
  if (existingDedup.exists) return false;

  const articleRef = db.collection('articles').doc();
  await articleRef.set({
    id: articleRef.id,
    title: article.title,
    url: article.url,
    content: article.content,
    publishedAt: article.publishedAt,
    source: article.source,
    sourceId: article.sourceId,
    globalSourceId: article.globalSourceId || article.sourceId,
    sourceCategory: article.category || null,
    sourcePricingTier: article.sourcePricingTier || (article.isPaid ? 'paid' : 'free'),
    priorityAnalysis: article.priorityAnalysis ?? Boolean(article.isPaid),
    priorityAnalysisReason: article.priorityAnalysisReason || (article.isPaid ? 'local paid source' : null),
    isPaid: article.isPaid ?? true, // 로컬 스크래퍼 기사는 유료
    author: article.author || null,
    subtitle: article.subtitle || null,
    date: article.date || null,
    companyId: null, // 전역 기사 — 특정 회사 소속 아님
    pipelineRunId: article.pipelineRunId || null, // 로컬 수집 추적용
    collectedAt: admin.firestore.FieldValue.serverTimestamp(),
    status: 'pending',
    urlHash,
    collectedBy: 'local-scraper',
  });

  await recordArticleDedupEntry({
    id: articleRef.id,
    ...article,
    status: 'pending',
  });

  return true;
}

export interface ScraperStatusData {
  source: 'thebell' | 'marketinsight';
  status: 'success' | 'error' | 'running';
  found: number;
  collected: number;
  skipped: number;
  errorMessage?: string;
  startedAt: Date;
  finishedAt?: Date;
  durationMs?: number;
}

/**
 * 수집 실행 결과를 scraperStatus 컬렉션에 기록.
 * 슈퍼어드민 대시보드에서 PC 스크래퍼 상태 확인용.
 */
export async function reportScraperStatus(data: ScraperStatusData): Promise<void> {
  if (!initialized) return;
  const db = admin.firestore();

  // 최신 상태 문서 (source별 1개 — 덮어쓰기)
  await db.collection('scraperStatus').doc(data.source).set({
    ...data,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // 이력 로그 (최근 100개 유지)
  const logRef = db.collection('scraperStatus').doc(data.source)
    .collection('history').doc();
  await logRef.set({
    ...data,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}
