import { collection, doc, documentId, getDoc, getDocs, query, where } from 'firebase/firestore';
import { db } from '@/lib/firebase';

const SOURCE_BATCH_SIZE = 30;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export async function fetchSubscribedSourceIds(companyId: string): Promise<string[]> {
  const subDoc = await getDoc(doc(db, 'companySourceSubscriptions', companyId));
  if (!subDoc.exists()) return [];
  return ((subDoc.data() as any).subscribedSourceIds || []).filter(Boolean);
}

export async function fetchSubscribedSources(companyId: string) {
  const subscribedIds = await fetchSubscribedSourceIds(companyId);
  if (subscribedIds.length === 0) return [];

  const snapshots = await Promise.all(
    chunk(subscribedIds, SOURCE_BATCH_SIZE).map((batch) =>
      getDocs(query(collection(db, 'globalSources'), where(documentId(), 'in', batch))),
    ),
  );

  return snapshots.flatMap((snapshot) =>
    snapshot.docs.map((item) => ({ id: item.id, ...(item.data() as any) })),
  );
}
