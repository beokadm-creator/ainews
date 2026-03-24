import * as admin from 'firebase-admin';
import { hashUrl, normalizeUrl } from './duplicateService';

type ArticleLike = {
  id?: string;
  url?: string;
  companyId?: string | null;
  sourceId?: string | null;
  globalSourceId?: string | null;
  source?: string | null;
  title?: string | null;
  status?: string | null;
  publishedAt?: any;
  collectedAt?: any;
};

function toTimestamp(value: any) {
  if (!value) return admin.firestore.FieldValue.serverTimestamp();
  if (value instanceof admin.firestore.Timestamp) return value;
  if (value?.toDate) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return admin.firestore.FieldValue.serverTimestamp();
  }
  return admin.firestore.Timestamp.fromDate(parsed);
}

export function getArticleDedupKey(url?: string) {
  return hashUrl(url || '');
}

export async function recordArticleDedupEntry(article: ArticleLike) {
  if (!article?.url) return null;

  const db = admin.firestore();
  const dedupKey = getArticleDedupKey(article.url);
  const ref = db.collection('articleDedup').doc(dedupKey);

  await ref.set({
    id: dedupKey,
    urlHash: dedupKey,
    normalizedUrl: normalizeUrl(article.url),
    articleId: article.id || null,
    companyId: article.companyId ?? null,
    sourceId: article.sourceId || null,
    globalSourceId: article.globalSourceId || article.sourceId || null,
    source: article.source || null,
    title: article.title || null,
    lastStatus: article.status || 'pending',
    publishedAt: toTimestamp(article.publishedAt),
    firstSeenAt: admin.firestore.FieldValue.serverTimestamp(),
    lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
    lastCollectedAt: toTimestamp(article.collectedAt),
  }, { merge: true });

  return dedupKey;
}

export async function syncArticlesToDedup(
  docs: FirebaseFirestore.QueryDocumentSnapshot[],
  statusOverride?: string
) {
  if (!docs.length) return 0;

  await Promise.all(docs.map((doc) => recordArticleDedupEntry({
    id: doc.id,
    ...(doc.data() as any),
    ...(statusOverride ? { status: statusOverride } : {}),
  })));

  return docs.length;
}

export async function purgeRejectedArticlesPreservingDedupe(
  docs: FirebaseFirestore.QueryDocumentSnapshot[]
) {
  if (!docs.length) return 0;

  const db = admin.firestore();
  let deleted = 0;

  for (let i = 0; i < docs.length; i += 400) {
    const chunk = docs.slice(i, i + 400);
    await syncArticlesToDedup(chunk, 'rejected');

    const batch = db.batch();
    chunk.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    deleted += chunk.length;
  }

  return deleted;
}
