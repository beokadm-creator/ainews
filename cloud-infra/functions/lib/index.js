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
exports.runFullPipeline = exports.scheduledBriefingGeneration = exports.scheduledNewsCollection = exports.triggerTelegramSend = exports.triggerEmailSend = exports.triggerBriefingGeneration = exports.triggerDeepAnalysis = exports.triggerAiFiltering = exports.triggerPuppeteerCollection = exports.triggerScrapingCollection = exports.triggerRssCollection = exports.analyzeManualArticle = exports.testAiConnection = exports.saveAiApiKey = exports.getCompanyUsers = exports.adminCreateUser = exports.upsertCompany = exports.getCompanies = exports.updateCompanySourceSubscriptions = exports.testSourceConnectionHttp = exports.deleteGlobalSource = exports.upsertGlobalSource = exports.getGlobalSources = void 0;
const https_1 = require("firebase-functions/v2/https");
const scheduler_1 = require("firebase-functions/v2/scheduler");
const admin = __importStar(require("firebase-admin"));
const rssService_1 = require("./services/rssService");
const aiService_1 = require("./services/aiService");
const briefingService_1 = require("./services/briefingService");
const emailService_1 = require("./services/emailService");
const telegramService_1 = require("./services/telegramService");
const scrapingService_1 = require("./services/scrapingService");
const puppeteerService_1 = require("./services/puppeteerService");
const authMiddleware_1 = require("./utils/authMiddleware");
const runtimeConfigService_1 = require("./services/runtimeConfigService");
const runtime_1 = require("./types/runtime");
const secretManager_1 = require("./utils/secretManager");
const globalSourceService_1 = require("./services/globalSourceService");
admin.initializeApp();
// Seeding (필요 시 수동 실행 또는 별도 트리거로 이동 권장)
// ensureCollectionsExist().catch(console.error);
// seedPromptTemplates().catch(err => {
//   console.warn('Failed to seed prompt templates:', err);
// });
// seedGlobalSources().catch(err => {
//   console.warn('Failed to seed global sources:', err);
// });
// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────
async function getPrimaryCompanyId(uid) {
    const userDoc = await admin.firestore().collection('users').doc(uid).get();
    if (!userDoc.exists) {
        throw new https_1.HttpsError('permission-denied', 'User record not found');
    }
    const userData = userDoc.data();
    const companyId = userData.companyIds?.[0] || userData.managedCompanyIds?.[0] || userData.companyId;
    if (!companyId) {
        throw new https_1.HttpsError('permission-denied', 'No company assigned to user');
    }
    return companyId;
}
async function resolveRuntime(uid, companyId, overrides) {
    const resolvedCompanyId = companyId || await getPrimaryCompanyId(uid);
    await (0, runtimeConfigService_1.assertCompanyAccess)(uid, resolvedCompanyId);
    return (0, runtimeConfigService_1.getCompanyRuntimeConfig)(resolvedCompanyId, overrides);
}
// ─────────────────────────────────────────
// [NEW] Global Source Management (Superadmin)
// ─────────────────────────────────────────
/** 글로벌 소스 목록 조회 (모든 인증 사용자) */
exports.getGlobalSources = (0, https_1.onCall)({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
    if (!request.auth)
        throw new https_1.HttpsError('unauthenticated', 'Authentication required');
    try {
        const db = admin.firestore();
        const snap = await db.collection('globalSources').orderBy('relevanceScore', 'desc').get();
        return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }
    catch (err) {
        console.error('getGlobalSources error:', err);
        throw new https_1.HttpsError('internal', err.message);
    }
});
/** 글로벌 소스 생성/수정 (Superadmin만) */
exports.upsertGlobalSource = (0, https_1.onCall)({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
    if (!request.auth)
        throw new https_1.HttpsError('unauthenticated', 'Authentication required');
    const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
    if (userDoc.data()?.role !== 'superadmin') {
        throw new https_1.HttpsError('permission-denied', 'Superadmin required');
    }
    const { id, ...data } = request.data || {};
    if (!data.name || !data.url || !data.type) {
        throw new https_1.HttpsError('invalid-argument', 'name, url, type are required');
    }
    const db = admin.firestore();
    const docRef = id ? db.collection('globalSources').doc(id) : db.collection('globalSources').doc();
    await docRef.set({
        ...data,
        id: docRef.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...(id ? {} : {
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            createdBy: request.auth.uid,
        }),
    }, { merge: !!id });
    return { success: true, id: docRef.id };
});
/** 글로벌 소스 삭제 (Superadmin만) */
exports.deleteGlobalSource = (0, https_1.onCall)({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
    if (!request.auth)
        throw new https_1.HttpsError('unauthenticated', 'Authentication required');
    const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
    if (userDoc.data()?.role !== 'superadmin') {
        throw new https_1.HttpsError('permission-denied', 'Superadmin required');
    }
    const { id } = request.data || {};
    if (!id)
        throw new https_1.HttpsError('invalid-argument', 'Source ID required');
    await admin.firestore().collection('globalSources').doc(id).delete();
    return { success: true };
});
/** 글로벌 소스 연결 테스트 (Superadmin만) - HTTP 함수 with CORS */
exports.testSourceConnectionHttp = (0, https_1.onRequest)({ region: 'us-central1', timeoutSeconds: 60, memory: '512MiB' }, async (request, response) => {
    // CORS 헤더 설정
    response.set('Access-Control-Allow-Origin', '*');
    response.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (request.method === 'OPTIONS') {
        response.status(204).send('');
        return;
    }
    try {
        const auth = request.headers.authorization?.split('Bearer ')[1];
        if (!auth) {
            response.status(401).json({ error: 'Authentication required' });
            return;
        }
        const decodedToken = await admin.auth().verifyIdToken(auth);
        const userDoc = await admin.firestore().collection('users').doc(decodedToken.uid).get();
        if (userDoc.data()?.role !== 'superadmin') {
            response.status(403).json({ error: 'Superadmin required' });
            return;
        }
        const { sourceId } = request.body || {};
        if (!sourceId) {
            response.status(400).json({ error: 'sourceId required' });
            return;
        }
        const result = await (0, globalSourceService_1.testGlobalSource)(sourceId);
        // 테스트 결과를 문서에 저장
        await admin.firestore().collection('globalSources').doc(sourceId).update({
            lastTestedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastTestResult: result,
            ...(result.success ? { status: 'active' } : { status: 'error' }),
        });
        response.json(result);
    }
    catch (err) {
        response.status(500).json({ error: err.message || 'Test failed' });
    }
});
/** 회사가 구독 소스 선택 저장 */
exports.updateCompanySourceSubscriptions = (0, https_1.onCall)({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
    if (!request.auth)
        throw new https_1.HttpsError('unauthenticated', 'Authentication required');
    const { companyId: rawCompanyId, subscribedSourceIds } = request.data || {};
    const companyId = rawCompanyId || await getPrimaryCompanyId(request.auth.uid);
    const access = await (0, runtimeConfigService_1.assertCompanyAccess)(request.auth.uid, companyId);
    if (!['superadmin', 'company_admin'].includes(access.role)) {
        throw new https_1.HttpsError('permission-denied', 'Company admin required');
    }
    if (!Array.isArray(subscribedSourceIds)) {
        throw new https_1.HttpsError('invalid-argument', 'subscribedSourceIds must be an array');
    }
    const db = admin.firestore();
    await db.collection('companySourceSubscriptions').doc(companyId).set({
        companyId,
        subscribedSourceIds,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: request.auth.uid,
    });
    return { success: true, companyId, count: subscribedSourceIds.length };
});
// ─────────────────────────────────────────
// [NEW] Company & User Management
// ─────────────────────────────────────────
/** 회사 목록 조회 (Superadmin만) */
exports.getCompanies = (0, https_1.onCall)({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
    if (!request.auth)
        throw new https_1.HttpsError('unauthenticated', 'Authentication required');
    try {
        const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
        if (userDoc.data()?.role !== 'superadmin') {
            throw new https_1.HttpsError('permission-denied', 'Superadmin required');
        }
        const db = admin.firestore();
        const snap = await db.collection('companies').orderBy('name').get();
        return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }
    catch (err) {
        console.error('getCompanies error:', err);
        if (err instanceof https_1.HttpsError) {
            throw err;
        }
        throw new https_1.HttpsError('internal', err.message);
    }
});
/** 회사 생성/수정 (Superadmin만) */
exports.upsertCompany = (0, https_1.onCall)({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
    if (!request.auth)
        throw new https_1.HttpsError('unauthenticated', 'Authentication required');
    const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
    if (userDoc.data()?.role !== 'superadmin') {
        throw new https_1.HttpsError('permission-denied', 'Superadmin required');
    }
    const { id, name, active, settings } = request.data || {};
    if (!name)
        throw new https_1.HttpsError('invalid-argument', 'Company name is required');
    const db = admin.firestore();
    const docRef = id ? db.collection('companies').doc(id) : db.collection('companies').doc();
    await docRef.set({
        id: docRef.id,
        name,
        active: active ?? true,
        settings: settings || {},
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...(id ? {} : { createdAt: admin.firestore.FieldValue.serverTimestamp() }),
    }, { merge: true });
    return { success: true, id: docRef.id };
});
/** 사용자 생성 (Superadmin 또는 Company Admin) */
exports.adminCreateUser = (0, https_1.onCall)({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
    if (!request.auth)
        throw new https_1.HttpsError('unauthenticated', 'Authentication required');
    const { email, password, displayName, role, companyId: targetCompanyId } = request.data || {};
    if (!email || !password || !role || !targetCompanyId) {
        throw new https_1.HttpsError('invalid-argument', 'Missing required fields');
    }
    // 권한 확인
    const callerDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
    const callerData = callerDoc.data();
    const isSuper = callerData?.role === 'superadmin';
    const isCompanyAdmin = callerData?.role === 'company_admin' &&
        (callerData?.companyIds?.includes(targetCompanyId) || callerData?.companyId === targetCompanyId);
    if (!isSuper && !isCompanyAdmin) {
        throw new https_1.HttpsError('permission-denied', 'Insufficient permissions to create user');
    }
    // 역할 제한: Company Admin은 superadmin을 생성할 수 없음
    if (!isSuper && role === 'superadmin') {
        throw new https_1.HttpsError('permission-denied', 'Only superadmins can create other superadmins');
    }
    try {
        // Auth 사용자 생성
        const userRecord = await admin.auth().createUser({
            email,
            password,
            displayName: displayName || email.split('@')[0],
        });
        // Firestore 사용자 문서 생성
        await admin.firestore().collection('users').doc(userRecord.uid).set({
            uid: userRecord.uid,
            email,
            role,
            companyId: targetCompanyId,
            companyIds: [targetCompanyId],
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            createdBy: request.auth.uid,
        });
        // Custom Claims 설정
        await admin.auth().setCustomUserClaims(userRecord.uid, { role, companyId: targetCompanyId });
        return { success: true, uid: userRecord.uid };
    }
    catch (error) {
        throw new https_1.HttpsError('internal', error.message);
    }
});
/** 특정 회사 사용자 목록 조회 */
exports.getCompanyUsers = (0, https_1.onCall)({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
    if (!request.auth)
        throw new https_1.HttpsError('unauthenticated', 'Authentication required');
    const { companyId } = request.data || {};
    if (!companyId)
        throw new https_1.HttpsError('invalid-argument', 'Company ID required');
    const callerDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
    const isSuper = callerDoc.data()?.role === 'superadmin';
    const isTargetAdmin = callerDoc.data()?.role === 'company_admin' &&
        (callerDoc.data()?.companyIds?.includes(companyId) || callerDoc.data()?.companyId === companyId);
    if (!isSuper && !isTargetAdmin) {
        throw new https_1.HttpsError('permission-denied', 'Access denied');
    }
    const snap = await admin.firestore().collection('users')
        .where('companyIds', 'array-contains', companyId)
        .get();
    return snap.docs.map(doc => {
        const data = doc.data();
        return {
            uid: data.uid,
            email: data.email,
            role: data.role,
            createdAt: data.createdAt,
        };
    });
});
// ─────────────────────────────────────────
// [NEW] Save AI Provider API Key
// ─────────────────────────────────────────
exports.saveAiApiKey = (0, https_1.onCall)({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required');
    }
    const { companyId: rawCompanyId, provider, apiKey, baseUrl, model } = request.data || {};
    const companyId = rawCompanyId || await getPrimaryCompanyId(request.auth.uid);
    const access = await (0, runtimeConfigService_1.assertCompanyAccess)(request.auth.uid, companyId);
    if (access.role !== 'superadmin' && access.role !== 'company_admin') {
        throw new https_1.HttpsError('permission-denied', 'Company admin or superadmin required');
    }
    if (!provider || !['glm', 'gemini', 'openai', 'claude'].includes(provider)) {
        throw new https_1.HttpsError('invalid-argument', 'Valid provider required: glm, gemini, openai, claude');
    }
    // 1. API Key 저장 (Secret Manager - 기존 로직 유지)
    if (apiKey) {
        if (typeof apiKey !== 'string' || apiKey.trim().length < 5) {
            throw new https_1.HttpsError('invalid-argument', 'Valid API key is required');
        }
        await (0, secretManager_1.saveApiKeyForCompany)(companyId, provider, apiKey.trim());
    }
    // 2. Base URL 및 선택된 모델 저장 (Firestore companySettings에 저장)
    const db = admin.firestore();
    const updates = {};
    if (baseUrl !== undefined) {
        updates.aiBaseUrls = { [provider]: baseUrl };
    }
    if (model !== undefined) {
        updates.aiModels = { [provider]: model };
    }
    if (Object.keys(updates).length > 0) {
        // merge: true를 쓰면 aiModels 안의 다른 provider 값들이 사라지지 않음
        await db.collection('companySettings').doc(companyId).set(updates, { merge: true });
    }
    return { success: true };
});
// ─────────────────────────────────────────
// [NEW] Test AI Provider Connection
// ─────────────────────────────────────────
exports.testAiConnection = (0, https_1.onCall)({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required');
    }
    const { companyId: rawCompanyId, provider, model, baseUrl } = request.data || {};
    const companyId = rawCompanyId || await getPrimaryCompanyId(request.auth.uid);
    await (0, runtimeConfigService_1.assertCompanyAccess)(request.auth.uid, companyId);
    try {
        const targetProvider = provider || 'glm';
        const defaults = runtime_1.PROVIDER_DEFAULTS[targetProvider];
        const testConfig = {
            provider: targetProvider,
            model: model || defaults.model,
            baseUrl: baseUrl || null,
            apiKeyEnvKey: defaults.apiKeyEnvKey,
        };
        const result = await (0, aiService_1.testAiProviderConnection)(testConfig, companyId);
        return result;
    }
    catch (error) {
        return {
            success: false,
            message: error.message || 'Connection test failed',
        };
    }
});
// ─────────────────────────────────────────
// Analyze Manual Article
// ─────────────────────────────────────────
exports.analyzeManualArticle = (0, https_1.onCall)({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required');
    }
    const { title, content, source, url, publishedAt, companyId } = request.data || {};
    if (!title || !content) {
        throw new https_1.HttpsError('invalid-argument', 'Title and content are required');
    }
    const runtime = await resolveRuntime(request.auth.uid, companyId);
    const relevanceResult = await (0, aiService_1.checkRelevance)({ title, content, source: source || 'manual' }, runtime.ai, { companyId: runtime.companyId });
    const analysis = await (0, aiService_1.analyzeArticle)({ title, content, source: source || 'manual', url: url || '', publishedAt: publishedAt || new Date().toISOString() }, runtime.ai, { companyId: runtime.companyId });
    return {
        success: true,
        companyId: runtime.companyId,
        isRelevant: relevanceResult.isRelevant,
        confidence: relevanceResult.confidence,
        relevanceReason: relevanceResult.reason,
        analysis,
    };
});
// ─────────────────────────────────────────
// HTTP triggers (collection)
// ─────────────────────────────────────────
exports.triggerRssCollection = (0, https_1.onRequest)({ region: 'us-central1' }, async (request, response) => {
    const isAuthenticated = await (0, authMiddleware_1.requireAdmin)(request, response);
    if (!isAuthenticated)
        return;
    try {
        const companyId = request.query.companyId;
        const user = request.user;
        const runtime = await resolveRuntime(user.uid, companyId);
        const result = await (0, rssService_1.processRssSources)({ companyId: runtime.companyId, filters: runtime.filters });
        response.json(result);
    }
    catch (error) {
        response.status(500).json({ success: false, error: error.message });
    }
});
exports.triggerScrapingCollection = (0, https_1.onRequest)({ region: 'us-central1' }, async (request, response) => {
    const isAuthenticated = await (0, authMiddleware_1.requireAdmin)(request, response);
    if (!isAuthenticated)
        return;
    try {
        const companyId = request.query.companyId;
        const user = request.user;
        const runtime = await resolveRuntime(user.uid, companyId);
        const result = await (0, scrapingService_1.processScrapingSources)({ companyId: runtime.companyId, filters: runtime.filters });
        response.json(result);
    }
    catch (error) {
        response.status(500).json({ success: false, error: error.message });
    }
});
exports.triggerPuppeteerCollection = (0, https_1.onRequest)({ region: 'us-central1', memory: '1GiB', timeoutSeconds: 300 }, async (request, response) => {
    const isAuthenticated = await (0, authMiddleware_1.requireAdmin)(request, response);
    if (!isAuthenticated)
        return;
    try {
        const companyId = request.query.companyId;
        const user = request.user;
        const runtime = await resolveRuntime(user.uid, companyId);
        const result = await (0, puppeteerService_1.processPuppeteerSources)({ companyId: runtime.companyId, filters: runtime.filters });
        response.json(result);
    }
    catch (error) {
        response.status(500).json({ success: false, error: error.message });
    }
});
// ─────────────────────────────────────────
// Callable triggers (AI pipeline steps)
// ─────────────────────────────────────────
exports.triggerAiFiltering = (0, https_1.onCall)({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
    if (!request.auth)
        throw new https_1.HttpsError('unauthenticated', 'Authentication required');
    const runtime = await resolveRuntime(request.auth.uid, request.data?.companyId, request.data?.overrides);
    return (0, aiService_1.processRelevanceFiltering)({ companyId: runtime.companyId, aiConfig: runtime.ai });
});
exports.triggerDeepAnalysis = (0, https_1.onCall)({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
    if (!request.auth)
        throw new https_1.HttpsError('unauthenticated', 'Authentication required');
    const runtime = await resolveRuntime(request.auth.uid, request.data?.companyId, request.data?.overrides);
    return (0, aiService_1.processDeepAnalysis)({ companyId: runtime.companyId, aiConfig: runtime.ai });
});
exports.triggerBriefingGeneration = (0, https_1.onCall)({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
    if (!request.auth)
        throw new https_1.HttpsError('unauthenticated', 'Authentication required');
    const runtime = await resolveRuntime(request.auth.uid, request.data?.companyId, request.data?.overrides);
    return (0, briefingService_1.createDailyBriefing)({
        companyId: runtime.companyId,
        aiConfig: runtime.ai,
        outputConfig: runtime.output,
        timezone: runtime.timezone,
    });
});
exports.triggerEmailSend = (0, https_1.onCall)({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
    if (!request.auth)
        throw new https_1.HttpsError('unauthenticated', 'Authentication required');
    const companyId = request.data?.companyId || await getPrimaryCompanyId(request.auth.uid);
    await (0, runtimeConfigService_1.assertCompanyAccess)(request.auth.uid, companyId);
    const outputId = request.data?.id;
    if (!outputId)
        throw new https_1.HttpsError('invalid-argument', 'Output ID is required');
    return (0, emailService_1.sendBriefingEmails)(outputId);
});
exports.triggerTelegramSend = (0, https_1.onCall)({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
    if (!request.auth)
        throw new https_1.HttpsError('unauthenticated', 'Authentication required');
    const companyId = request.data?.companyId || await getPrimaryCompanyId(request.auth.uid);
    await (0, runtimeConfigService_1.assertCompanyAccess)(request.auth.uid, companyId);
    const outputId = request.data?.id;
    if (!outputId)
        throw new https_1.HttpsError('invalid-argument', 'Output ID is required');
    return (0, telegramService_1.sendBriefingToTelegram)(outputId);
});
// ─────────────────────────────────────────
// Scheduled: Collection (hourly per company)
// ─────────────────────────────────────────
exports.scheduledNewsCollection = (0, scheduler_1.onSchedule)({ schedule: '0 * * * *', memory: '1GiB', timeoutSeconds: 300 }, async () => {
    const db = admin.firestore();
    const companiesSnapshot = await db.collection('companies').where('active', '==', true).get();
    for (const companyDoc of companiesSnapshot.docs) {
        try {
            const runtime = await (0, runtimeConfigService_1.getCompanyRuntimeConfig)(companyDoc.id);
            await Promise.all([
                (0, rssService_1.processRssSources)({ companyId: runtime.companyId, filters: runtime.filters }),
                (0, scrapingService_1.processScrapingSources)({ companyId: runtime.companyId, filters: runtime.filters }),
                (0, puppeteerService_1.processPuppeteerSources)({ companyId: runtime.companyId, filters: runtime.filters }),
            ]);
            await (0, aiService_1.processRelevanceFiltering)({ companyId: runtime.companyId, aiConfig: runtime.ai });
            await (0, aiService_1.processDeepAnalysis)({ companyId: runtime.companyId, aiConfig: runtime.ai });
        }
        catch (err) {
            // WARN-01 FIX: 개별 회사 실패가 전체 스케줄러를 멈추지 않도록
            console.error(`Scheduled collection failed for company ${companyDoc.id}:`, err.message);
        }
    }
});
// ─────────────────────────────────────────
// Scheduled: Briefing generation (daily 22:00)
// ─────────────────────────────────────────
exports.scheduledBriefingGeneration = (0, scheduler_1.onSchedule)('0 22 * * *', async () => {
    const db = admin.firestore();
    const companiesSnapshot = await db.collection('companies').where('active', '==', true).get();
    for (const companyDoc of companiesSnapshot.docs) {
        try {
            const runtime = await (0, runtimeConfigService_1.getCompanyRuntimeConfig)(companyDoc.id);
            await (0, briefingService_1.createDailyBriefing)({
                companyId: runtime.companyId,
                aiConfig: runtime.ai,
                outputConfig: runtime.output,
                timezone: runtime.timezone,
            });
        }
        catch (err) {
            console.error(`Scheduled briefing failed for company ${companyDoc.id}:`, err.message);
        }
    }
});
// ─────────────────────────────────────────
// runFullPipeline: Full manual pipeline trigger
// ─────────────────────────────────────────
exports.runFullPipeline = (0, https_1.onCall)({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required');
    }
    const runtime = await resolveRuntime(request.auth.uid, request.data?.companyId, request.data?.overrides);
    const db = admin.firestore();
    const pipelineRef = db.collection('pipelineRuns').doc();
    const pipelineId = pipelineRef.id;
    await pipelineRef.set({
        id: pipelineId,
        companyId: runtime.companyId,
        companyName: runtime.companyName,
        status: 'running',
        triggeredBy: request.auth.uid,
        configSnapshot: runtime,
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
        steps: {},
    });
    const updateStep = async (step, status, result) => {
        await pipelineRef.update({
            [`steps.${step}`]: {
                status,
                completedAt: status === 'running' ? null : admin.firestore.FieldValue.serverTimestamp(),
                ...(result ? { result } : {}),
            },
        });
    };
    try {
        await updateStep('collection', 'running');
        const collectionStart = Date.now();
        const [rssResult, scrapingResult, puppeteerResult] = await Promise.all([
            (0, rssService_1.processRssSources)({ companyId: runtime.companyId, pipelineRunId: pipelineId, filters: runtime.filters }),
            (0, scrapingService_1.processScrapingSources)({ companyId: runtime.companyId, pipelineRunId: pipelineId, filters: runtime.filters }),
            (0, puppeteerService_1.processPuppeteerSources)({ companyId: runtime.companyId, pipelineRunId: pipelineId, filters: runtime.filters }),
        ]);
        const totalCollected = (rssResult.totalCollected || 0) +
            (scrapingResult.totalCollected || 0) +
            (puppeteerResult.totalCollected || 0);
        await updateStep('collection', 'completed', {
            duration: Date.now() - collectionStart,
            rss: rssResult,
            scraping: scrapingResult,
            puppeteer: puppeteerResult,
            totalCollected,
        });
        await updateStep('filtering', 'running');
        const filteringStart = Date.now();
        const filteringResult = await (0, aiService_1.processRelevanceFiltering)({
            companyId: runtime.companyId,
            pipelineRunId: pipelineId,
            aiConfig: runtime.ai,
        });
        await updateStep('filtering', 'completed', { duration: Date.now() - filteringStart, ...filteringResult });
        await updateStep('analysis', 'running');
        const analysisStart = Date.now();
        const analysisResult = await (0, aiService_1.processDeepAnalysis)({
            companyId: runtime.companyId,
            pipelineRunId: pipelineId,
            aiConfig: runtime.ai,
        });
        await updateStep('analysis', 'completed', { duration: Date.now() - analysisStart, ...analysisResult });
        await updateStep('output', 'running');
        const outputStart = Date.now();
        const outputResult = await (0, briefingService_1.createDailyBriefing)({
            companyId: runtime.companyId,
            pipelineRunId: pipelineId,
            aiConfig: runtime.ai,
            outputConfig: runtime.output,
            timezone: runtime.timezone,
        });
        await updateStep('output', outputResult.success ? 'completed' : 'failed', {
            duration: Date.now() - outputStart,
            ...outputResult,
        });
        const finalStatus = outputResult.success ? 'completed' : 'failed';
        await pipelineRef.update({ status: finalStatus, completedAt: admin.firestore.FieldValue.serverTimestamp() });
        return {
            success: outputResult.success,
            pipelineId,
            companyId: runtime.companyId,
            outputId: outputResult.outputId || null,
            outputType: runtime.output.type,
        };
    }
    catch (error) {
        await pipelineRef.update({
            status: 'failed',
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
            error: error.message || String(error),
        });
        throw new https_1.HttpsError('internal', `Pipeline failed: ${error.message}`);
    }
});
//# sourceMappingURL=index.js.map