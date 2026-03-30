const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');
const { enrichArticleBody } = require('./lib/services/articleContentFetchService');

const TARGET_SOURCE_IDS = [
  '77XEvu8DKnvRLBMXtsBg', // 파이낸셜뉴스(금융)
  '8XpKfnFyz1cnoEfqHvZu', // 조선비즈(산업/기업)
  'UkOyuXKDY6IijiJmZZeI', // 아시아경제
  'dLCCNA9r9iMMXQbzf54Q', // 서울경제
  'i5OmVNp1vjRvyQwq8UDN', // 파이낸셜뉴스(이코노미)
  'nYT8W3VDOyQbVKcSFWol', // 파이낸셜뉴스(산업)
  'xEYcwpN5WI8rldXfLzAO', // 서울경제(중복 등록 소스)
];

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

async function main() {
  let scanned = 0;
  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const sourceId of TARGET_SOURCE_IDS) {
    const sourceDoc = await db.collection('globalSources').doc(sourceId).get();
    const sourceName = sourceDoc.exists ? sourceDoc.data().name : sourceId;
    const snap = await db.collection('articles').where('sourceId', '==', sourceId).get();

    console.log(`\n[Backfill] ${sourceName}: ${snap.size}건`);

    for (const doc of snap.docs) {
      scanned += 1;
      const article = doc.data();

      try {
        const enriched = await enrichArticleBody({
          url: article.url || '',
          content: article.content || '',
        });

        const nextContent = `${enriched.content || ''}`.trim();
        const prevContent = `${article.content || ''}`.trim();

        if (!nextContent || nextContent === prevContent) {
          unchanged += 1;
          continue;
        }

        await doc.ref.update({
          content: nextContent,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          contentBackfilledAt: admin.firestore.FieldValue.serverTimestamp(),
          contentBackfillVersion: '2026-03-30-source-cleanup',
        });

        updated += 1;
        console.log(`  updated: ${doc.id}`);
      } catch (error) {
        failed += 1;
        console.error(`  failed: ${doc.id} - ${error.message}`);
      }
    }
  }

  console.log('\n[Backfill] done');
  console.log(JSON.stringify({ scanned, updated, unchanged, failed }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
