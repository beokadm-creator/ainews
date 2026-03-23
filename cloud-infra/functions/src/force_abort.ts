import * as admin from 'firebase-admin';

admin.initializeApp();
const db = admin.firestore();

async function forceAbort() {
  try {
    console.log('[1/2] systemSettings/pipelineControl 업데이트...');
    
    // 파이프라인 제어 문서 업데이트
    await db.doc('systemSettings/pipelineControl').set({
      pipelineEnabled: false,
      pipelineRunning: false,
      aiOnlyEnabled: false,
      aiOnlyRunning: false,
      currentStep: null,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    
    console.log('✓ 파이프라인 제어 업데이트 완료');
    
    console.log('\n[2/2] 실행 중인 작업 강제 종료...');
    
    // pending/running 상태의 모든 bulkAiJobs 조회
    const snapshot = await db.collection('bulkAiJobs')
      .where('status', 'in', ['pending', 'running'])
      .get();
    
    console.log(`발견된 실행 중 작업: ${snapshot.size}개`);
    
    if (snapshot.size > 0) {
      const batch = db.batch();
      snapshot.docs.forEach(doc => {
        batch.update(doc.ref, {
          status: 'aborted',
          abortedAt: admin.firestore.FieldValue.serverTimestamp(),
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
      
      await batch.commit();
      console.log(`✓ ${snapshot.size}개 작업 강제 종료 완료`);
    } else {
      console.log('✓ 실행 중인 작업 없음');
    }
    
    console.log('\n✅ 파이프라인 강제 종료 완료!');
    console.log('할당량이 곧 해제될 예정입니다.');
    
    process.exit(0);
  } catch (error: any) {
    console.error('❌ 강제 종료 실패:', error.message);
    process.exit(1);
  }
}

forceAbort();
