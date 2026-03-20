const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function removeDuplicates() {
  console.log('Checking for duplicates...');
  const snap = await db.collection('globalSources').get();
  
  const byUrl = {};
  const byName = {};
  
  // Group by URL and name
  snap.forEach(doc => {
    const data = doc.data();
    
    if (data.url) {
      if (!byUrl[data.url]) byUrl[data.url] = [];
      byUrl[data.url].push({ id: doc.id, name: data.name });
    }
    
    if (data.name) {
      if (!byName[data.name]) byName[data.name] = [];
      byName[data.name].push({ id: doc.id, url: data.url });
    }
  });
  
  // Find duplicates
  const urlDups = Object.entries(byUrl).filter(([_, ids]) => ids.length > 1);
  const nameDups = Object.entries(byName).filter(([_, ids]) => ids.length > 1);
  
  if (urlDups.length === 0 && nameDups.length === 0) {
    console.log('No duplicates found!');
    process.exit(0);
  }
  
  console.log('\n=== URL DUPLICATES ===');
  for (const [url, items] of urlDups) {
    console.log(`URL: ${url}`);
    items.forEach(item => console.log(`  - ${item.id} (${item.name})`));
  }
  
  console.log('\n=== NAME DUPLICATES ===');
  for (const [name, items] of nameDups) {
    console.log(`Name: ${name}`);
    items.forEach(item => console.log(`  - ${item.id} (${item.url})`));
  }
  
  // Remove URL duplicates (keep first, delete rest)
  let deleted = 0;
  for (const [url, items] of urlDups) {
    for (let i = 1; i < items.length; i++) {
      console.log(`\n✓ Deleting: ${items[i].id}`);
      await db.collection('globalSources').doc(items[i].id).delete();
      deleted++;
    }
  }
  
  console.log(`\n✓ Removed ${deleted} duplicate documents`);
  console.log(`Total remaining: ${snap.size - deleted}`);
  process.exit(0);
}

removeDuplicates().catch(err => {
  console.error(err);
  process.exit(1);
});
