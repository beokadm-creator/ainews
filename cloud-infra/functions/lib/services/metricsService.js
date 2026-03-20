"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordMetric = recordMetric;
exports.recordMetrics = recordMetrics;
exports.getDailyMetrics = getDailyMetrics;
exports.cleanupOldMetrics = cleanupOldMetrics;
const admin = __importStar(require("firebase-admin"));
/**
 * 파이프라인 단계별 메트릭을 Firestore에 기록합니다.
 */
async function recordMetric(metric) {
    try {
        const db = admin.firestore();
        const dateStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        await db.collection('systemMetrics').add({
            ...metric,
            date: dateStr,
            recordedAt: admin.firestore.FieldValue.serverTimestamp()
        });
    }
    catch (error) {
        // 메트릭 저장 실패는 파이프라인을 중단시키지 않음
        console.warn('Failed to record metric:', error);
    }
}
/**
 * 여러 메트릭을 한 번에 기록합니다 (배치 write).
 */
async function recordMetrics(metrics) {
    if (metrics.length === 0)
        return;
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
    }
    catch (error) {
        console.warn('Failed to record metrics batch:', error);
    }
}
/**
 * 특정 날짜의 메트릭을 집계합니다.
 * 주로 대시보드 표시용으로 사용됩니다.
 */
async function getDailyMetrics(dateStr) {
    const db = admin.firestore();
    try {
        const metricsSnapshot = await db.collection('systemMetrics')
            .where('date', '==', dateStr)
            .get();
        if (metricsSnapshot.empty) {
            return { date: dateStr, total: 0 };
        }
        const aggregated = { date: dateStr, stages: {} };
        for (const doc of metricsSnapshot.docs) {
            const data = doc.data();
            const stage = data.stage;
            if (!aggregated.stages[stage]) {
                aggregated.stages[stage] = { total: 0, success: 0, failed: 0, totalDuration: 0 };
            }
            const stageStats = aggregated.stages[stage];
            stageStats.total++;
            if (data.success)
                stageStats.success++;
            else
                stageStats.failed++;
            if (data.duration)
                stageStats.totalDuration += data.duration;
        }
        aggregated.total = metricsSnapshot.size;
        return aggregated;
    }
    catch (error) {
        console.warn('Failed to get daily metrics:', error);
        return { date: dateStr, total: 0, error: String(error) };
    }
}
/**
 * 오래된 메트릭을 정리합니다 (30일 이상).
 */
async function cleanupOldMetrics(daysToKeep = 30) {
    const db = admin.firestore();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffStr = cutoffDate.toISOString().split('T')[0];
    try {
        const oldMetrics = await db.collection('systemMetrics')
            .where('date', '<', cutoffStr)
            .limit(500) // Firestore batch delete limit
            .get();
        if (oldMetrics.empty)
            return 0;
        const batch = db.batch();
        oldMetrics.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        return oldMetrics.size;
    }
    catch (error) {
        console.warn('Failed to cleanup old metrics:', error);
        return 0;
    }
}
//# sourceMappingURL=metricsService.js.map