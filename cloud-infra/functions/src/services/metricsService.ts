import * as admin from 'firebase-admin';

export interface PipelineMetrics {
  stage: string;
  action: string;
  count: number;
  duration?: number;
  success: boolean;
  metadata?: Record<string, any>;
}

/**
 * 파이프라인 단계별 메트릭을 Firestore에 기록합니다.
 */
export async function recordMetric(metric: PipelineMetrics): Promise<void> {
  try {
    const db = admin.firestore();
    const dateStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    await db.collection('systemMetrics').add({
      ...metric,
      date: dateStr,
      recordedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (error) {
    // 메트릭 저장 실패는 파이프라인을 중단시키지 않음
    console.warn('Failed to record metric:', error);
  }
}

/**
 * 여러 메트릭을 한 번에 기록합니다 (배치 write).
 */
export async function recordMetrics(metrics: PipelineMetrics[]): Promise<void> {
  if (metrics.length === 0) return;

  try {
    const db = admin.firestore();
    const dateStr = new Date().toISOString().split('T')[0];
    const batch = db.batch();

    for (const metric of metrics) {
      const docRef = db.collection('systemMetrics').doc();
      batch.set(docRef, {
        ...metric,
        date: dateStr,
        recordedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    await batch.commit();
  } catch (error) {
    console.warn('Failed to record metrics batch:', error);
  }
}

/**
 * 특정 날짜의 메트릭을 집계합니다.
 * 주로 대시보드 표시용으로 사용됩니다.
 */
export async function getDailyMetrics(dateStr: string): Promise<Record<string, any>> {
  const db = admin.firestore();

  try {
    const metricsSnapshot = await db.collection('systemMetrics')
      .where('date', '==', dateStr)
      .get();

    if (metricsSnapshot.empty) {
      return { date: dateStr, total: 0 };
    }

    const aggregated: Record<string, any> = { date: dateStr, stages: {} };

    for (const doc of metricsSnapshot.docs) {
      const data = doc.data();
      const stage = data.stage;

      if (!aggregated.stages[stage]) {
        aggregated.stages[stage] = { total: 0, success: 0, failed: 0, totalDuration: 0 };
      }

      const stageStats = aggregated.stages[stage];
      stageStats.total++;
      if (data.success) stageStats.success++;
      else stageStats.failed++;
      if (data.duration) stageStats.totalDuration += data.duration;
    }

    aggregated.total = metricsSnapshot.size;
    return aggregated;
  } catch (error) {
    console.warn('Failed to get daily metrics:', error);
    return { date: dateStr, total: 0, error: String(error) };
  }
}

/**
 * 오래된 메트릭을 정리합니다 (30일 이상).
 */
export async function cleanupOldMetrics(daysToKeep: number = 30): Promise<number> {
  const db = admin.firestore();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
  const cutoffStr = cutoffDate.toISOString().split('T')[0];

  try {
    const oldMetrics = await db.collection('systemMetrics')
      .where('date', '<', cutoffStr)
      .limit(500) // Firestore batch delete limit
      .get();

    if (oldMetrics.empty) return 0;

    const batch = db.batch();
    oldMetrics.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    return oldMetrics.size;
  } catch (error) {
    console.warn('Failed to cleanup old metrics:', error);
    return 0;
  }
}
