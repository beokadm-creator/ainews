const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// 서비스 계정 키 경로 (명시적으로 확인)
const serviceAccountPath = path.join(__dirname, 'service-account.json');

if (!fs.existsSync(serviceAccountPath)) {
  console.error(`Cannot find service account key at ${serviceAccountPath}`);
  process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function setSuperAdmin(uid, email) {
  try {
    // 1. users 컬렉션에 문서 생성/업데이트
    await db.collection('users').doc(uid).set({
      uid,
      email,
      role: 'superadmin',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log(`Success: User ${email} (UID: ${uid}) is now a Superadmin.`);
    
    // 2. Custom Claims 설정
    await admin.auth().setCustomUserClaims(uid, { role: 'superadmin' });
    console.log(`Success: Custom claims set for ${uid}.`);

  } catch (error) {
    console.error('Error setting superadmin:', error);
  } finally {
    process.exit();
  }
}

// 사용자 정보
const SUPERADMIN_UID = '2vhIaWzty9NifSF6hZezzHVYGAT2';
const SUPERADMIN_EMAIL = 'aaron@beoksolution.com';

setSuperAdmin(SUPERADMIN_UID, SUPERADMIN_EMAIL);
