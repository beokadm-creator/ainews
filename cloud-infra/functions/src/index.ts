import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { setGlobalOptions } from 'firebase-functions/v2';

setGlobalOptions({
  region: 'us-central1',
  maxInstances: 5,
  concurrency: 50,
  invoker: 'public',
});
import * as admin from 'firebase-admin';
import axios from 'axios';
import { processRssSources } from './services/rssService';
import { checkRelevance, processRelevanceFiltering, processDeepAnalysis, analyzeArticle, testAiProviderConnection } from './services/aiService';
import { createDailyBriefing, generateCustomReport } from './services/briefingService';
import { sendBriefingEmails } from './services/emailService';
import { sendBriefingToTelegram } from './services/telegramService';
import { processScrapingSources } from './services/scrapingService';
import { processApiSources } from './services/apiSourceService';
import { ensureCollectionsExist } from './utils/firestoreValidation';
import { requireAdmin } from './utils/authMiddleware';
import { seedPromptTemplates } from './seed/promptTemplates';
import { assertCompanyAccess, getCompanyRuntimeConfig } from './services/runtimeConfigService';
import { PipelineInvocationOverrides, RuntimeAiConfig, AiProvider, PROVIDER_DEFAULTS } from './types/runtime';
import { saveApiKeyForCompany } from './utils/secretManager';
import { seedGlobalSources, testGlobalSource } from './services/globalSourceService';
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
async function getPrimaryCompanyId(uid: string): Promise<string> {
  const userDoc = await admin.firestore().collection('users').doc(uid).get();
  if (!userDoc.exists) {
    throw new HttpsError('permission-denied', 'User record not found');
  }
  const userData = userDoc.data() as {
    companyIds?: string[];
    managedCompanyIds?: string[];
    companyId?: string;
  };
  const companyId = userData.companyIds?.[0] || userData.managedCompanyIds?.[0] || userData.companyId;
  if (!companyId) {
    throw new HttpsError('permission-denied', 'No company assigned to user');
  }
  return companyId;
}
async function resolveRuntime(uid: string, companyId?: string, overrides?: PipelineInvocationOverrides) {
  const resolvedCompanyId = companyId || await getPrimaryCompanyId(uid);
  await assertCompanyAccess(uid, resolvedCompanyId);
  return getCompanyRuntimeConfig(resolvedCompanyId, overrides);
}
// ─────────────────────────────────────────
// [NEW] Global Source Management (Superadmin)
// ─────────────────────────────────────────
/** 글로벌 소스 목록 조회 (모든 인증 사용자) */
export const getGlobalSources = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  try {
    const db = admin.firestore();
    const snap = await db.collection('globalSources').orderBy('relevanceScore', 'desc').get();
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (err: any) {
    console.error('getGlobalSources error:', err);
    throw new HttpsError('internal', err.message);
  }
});
/** 글로벌 소스 생성/수정 (Superadmin만) */
export const upsertGlobalSource = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (userDoc.data()?.role !== 'superadmin') {
    throw new HttpsError('permission-denied', 'Superadmin required');
  }
  const { id, ...data } = request.data || {};
  if (!data.name || !data.url || !data.type) {
    throw new HttpsError('invalid-argument', 'name, url, type are required');
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
export const deleteGlobalSource = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (userDoc.data()?.role !== 'superadmin') {
    throw new HttpsError('permission-denied', 'Superadmin required');
  }
  const { id } = request.data || {};
  if (!id) throw new HttpsError('invalid-argument', 'Source ID required');
  await admin.firestore().collection('globalSources').doc(id).delete();
  return { success: true };
});
/** 글로벌 소스 연결 테스트 (Superadmin만) - HTTP 함수 with CORS */
export const testSourceConnectionHttp = onRequest(
  { region: 'us-central1', timeoutSeconds: 60, memory: '512MiB' },
  async (request, response) => {
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
      const result = await testGlobalSource(sourceId);
      // 테스트 결과를 문서에 저장
      await admin.firestore().collection('globalSources').doc(sourceId).update({
        lastTestedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastTestResult: result,
        ...(result.success ? { status: 'active' } : { status: 'error' }),
      });
      response.json(result);
    } catch (err: any) {
      response.status(500).json({ error: err.message || 'Test failed' });
    }
  }
);
/** 회사가 구독 소스 선택 저장 */
export const updateCompanySourceSubscriptions = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const { companyId: rawCompanyId, subscribedSourceIds } = request.data || {};
  const companyId = rawCompanyId || await getPrimaryCompanyId(request.auth.uid);
  const access = await assertCompanyAccess(request.auth.uid, companyId);
  if (!['superadmin', 'company_admin', 'company_editor'].includes(access.role)) {
    throw new HttpsError('permission-denied', 'Permission denied');
  }
  if (!Array.isArray(subscribedSourceIds)) {
    throw new HttpsError('invalid-argument', 'subscribedSourceIds must be an array');
  }
  const db = admin.firestore();
  await db.collection('companySourceSubscriptions').doc(companyId).set({
    companyId,
    subscribedSourceIds,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: request.auth.uid,
  });
  return { success: true, companyId };
});

/** 알림 설정 (이메일, 텔레그램 등) 업데이트 */
export const updateNotificationSettings = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const { companyId: rawCompanyId, telegram, emails } = request.data || {};
  const companyId = rawCompanyId || await getPrimaryCompanyId(request.auth.uid);
  await assertCompanyAccess(request.auth.uid, companyId);
  
  const db = admin.firestore();
  const updates: any = {};
  if (telegram) updates['notifications.telegram'] = telegram;
  if (emails) updates['subscriberEmails'] = emails;
  
  await db.collection('companySettings').doc(companyId).set(updates, { merge: true });
  return { success: true };
});
// ─────────────────────────────────────────
// [NEW] Company & User Management
// ─────────────────────────────────────────
/** 회사 목록 조회 (Superadmin만) */
export const getCompanies = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  try {
    const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
    if (userDoc.data()?.role !== 'superadmin') {
      throw new HttpsError('permission-denied', 'Superadmin required');
    }
    const db = admin.firestore();
    const snap = await db.collection('companies').orderBy('name').get();
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (err: any) {
    console.error('getCompanies error:', err);
    if (err instanceof HttpsError) {
      throw err;
    }
    throw new HttpsError('internal', err.message);
  }
});
/** 회사 생성/수정 (Superadmin만) */
export const upsertCompany = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (userDoc.data()?.role !== 'superadmin') {
    throw new HttpsError('permission-denied', 'Superadmin required');
  }
  const { id, name, active, settings } = request.data || {};
  if (!name) throw new HttpsError('invalid-argument', 'Company name is required');
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
export const adminCreateUser = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const { email, password, displayName, role, companyId: targetCompanyId } = request.data || {};
  if (!email || !password || !role || !targetCompanyId) {
    throw new HttpsError('invalid-argument', 'Missing required fields');
  }
  // 권한 확인
  const callerDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  const callerData = callerDoc.data();
  const isSuper = callerData?.role === 'superadmin';
  const isCompanyAdmin = callerData?.role === 'company_admin' && 
                        (callerData?.companyIds?.includes(targetCompanyId) || callerData?.companyId === targetCompanyId);
  if (!isSuper && !isCompanyAdmin) {
    throw new HttpsError('permission-denied', 'Insufficient permissions to create user');
  }
  // 역할 제한: Company Admin은 superadmin을 생성할 수 없음
  if (!isSuper && role === 'superadmin') {
    throw new HttpsError('permission-denied', 'Only superadmins can create other superadmins');
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
  } catch (error: any) {
    throw new HttpsError('internal', error.message);
  }
});
/** 특정 회사 사용자 목록 조회 */
export const getCompanyUsers = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const { companyId } = request.data || {};
  if (!companyId) throw new HttpsError('invalid-argument', 'Company ID required');
  const callerDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  const isSuper = callerDoc.data()?.role === 'superadmin';
  const isTargetAdmin = callerDoc.data()?.role === 'company_admin' && 
                       (callerDoc.data()?.companyIds?.includes(companyId) || callerDoc.data()?.companyId === companyId);
  if (!isSuper && !isTargetAdmin) {
    throw new HttpsError('permission-denied', 'Access denied');
  }
  const snap = await admin.firestore().collection('users')
    .where('companyIds', 'array-contains', companyId)
    .get();
  return snap.docs
    // company_admin 호출 시 superadmin 계정 노출 금지
    .filter(doc => isSuper || doc.data().role !== 'superadmin')
    .map(doc => {
      const data = doc.data();
      return {
        uid: data.uid,
        email: data.email,
        role: data.role,
        createdAt: data.createdAt,
      };
    });
});
/** 사용자 삭제 (Superadmin 또는 본인 회사 Company Admin) */
export const deleteCompanyUser = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const { uid: targetUid } = request.data || {};
  if (!targetUid) throw new HttpsError('invalid-argument', 'Target user UID required');

  const callerDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  const callerData = callerDoc.data();
  const isSuper = callerData?.role === 'superadmin';

  // 삭제 대상 유저 정보 조회
  const targetDoc = await admin.firestore().collection('users').doc(targetUid).get();
  if (!targetDoc.exists) throw new HttpsError('not-found', 'Target user not found');
  const targetData = targetDoc.data();

  // Company Admin: 본인 회사 소속이고 superadmin이 아닌 유저만 삭제 가능
  if (!isSuper) {
    const callerCompanyId = callerData?.companyIds?.[0] || callerData?.companyId;
    const targetInSameCompany = targetData?.companyIds?.includes(callerCompanyId) || targetData?.companyId === callerCompanyId;
    if (callerData?.role !== 'company_admin' || !targetInSameCompany) {
      throw new HttpsError('permission-denied', 'Insufficient permissions');
    }
    if (targetData?.role === 'superadmin' || targetData?.role === 'company_admin') {
      throw new HttpsError('permission-denied', 'Cannot delete admin accounts');
    }
  }

  await admin.auth().deleteUser(targetUid);
  await admin.firestore().collection('users').doc(targetUid).delete();
  return { success: true };
});

// ─────────────────────────────────────────
// [NEW] Save AI Provider API Key
// ─────────────────────────────────────────
export const saveAiApiKey = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }
  const { companyId: rawCompanyId, provider, apiKey, baseUrl, model, setAsActive } = request.data || {};
  const companyId = rawCompanyId || await getPrimaryCompanyId(request.auth.uid);
  const access = await assertCompanyAccess(request.auth.uid, companyId);
  if (access.role !== 'superadmin' && access.role !== 'company_admin') {
    throw new HttpsError('permission-denied', 'Company admin or superadmin required');
  }
  if (!provider || !['glm', 'gemini', 'openai', 'claude'].includes(provider)) {
    throw new HttpsError('invalid-argument', 'Valid provider required: glm, gemini, openai, claude');
  }
  // 1. API Key 저장 (Secret Manager - 기존 로직 유지)
  if (apiKey) {
    if (typeof apiKey !== 'string' || apiKey.trim().length < 5) {
      throw new HttpsError('invalid-argument', 'Valid API key is required');
    }
    await saveApiKeyForCompany(companyId, provider as AiProvider, apiKey.trim());
  }
  // 2. Base URL 및 선택된 모델 저장 (Firestore companySettings에 저장)
  const db = admin.firestore();
  const updates: any = {};
  if (baseUrl !== undefined) {
    updates[`aiBaseUrls.${provider}`] = baseUrl;
  }
  if (model !== undefined) {
    updates[`aiModels.${provider}`] = model;
  }
  // setAsActive이면 활성 프로바이더로 설정
  if (setAsActive) {
    updates['ai.provider'] = provider;
    if (model) updates['ai.model'] = model;
    if (baseUrl) updates['ai.baseUrl'] = baseUrl;
  }
  await db.collection('companySettings').doc(companyId).set(updates, { merge: true });
  // Superadmin: also save to global systemSettings as fallback for all companies
  const userDoc = await db.collection('users').doc(request.auth.uid).get();
  if (userDoc.data()?.role === 'superadmin') {
    const sysUpdates = { ...updates };
    // 시스템 레벨에서는 항상 활성화 (또는 선택적)
    if (!sysUpdates['ai.provider']) sysUpdates['ai.provider'] = provider;
    await db.collection('systemSettings').doc('aiConfig').set(sysUpdates, { merge: true });
    if (apiKey) {
      await saveApiKeyForCompany('__system__', provider as AiProvider, apiKey.trim());
    }
  }
  return { success: true, message: `Settings for ${provider} saved` };
});
/** 회사별 파이프라인 설정 (필터, 출력 등) 업데이트 */
export const updateCompanySettings = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const { companyId, filters, output, timezone } = request.data || {};
  const targetCompanyId = companyId || await getPrimaryCompanyId(request.auth.uid);
  await assertCompanyAccess(request.auth.uid, targetCompanyId);
  const db = admin.firestore();
  const updates: any = {};
  if (filters) updates.filters = filters;
  if (output) updates.output = output;
  if (timezone) updates.timezone = timezone;
  if (Object.keys(updates).length === 0) return { success: false, message: 'No updates provided' };
  await db.collection('companySettings').doc(targetCompanyId).set(updates, { merge: true });
  return { success: true };
});
// ─────────────────────────────────────────
// [NEW] Test AI Provider Connection
// ─────────────────────────────────────────
export const testAiConnection = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }
  const { companyId: rawCompanyId, provider, model, baseUrl } = request.data || {};
  const companyId = rawCompanyId || await getPrimaryCompanyId(request.auth.uid);
  await assertCompanyAccess(request.auth.uid, companyId);
  try {
    const targetProvider: AiProvider = provider || 'glm';
    const defaults = PROVIDER_DEFAULTS[targetProvider];
    const testConfig: RuntimeAiConfig = {
      provider: targetProvider,
      model: model || defaults.model,
      baseUrl: baseUrl || null,
      apiKeyEnvKey: defaults.apiKeyEnvKey,
    };
    const result = await testAiProviderConnection(testConfig, companyId);
    return result;
  } catch (error: any) {
    return {
      success: false,
      message: error.message || 'Connection test failed',
    };
  }
});
// ─────────────────────────────────────────
// Analyze Manual Article
// ─────────────────────────────────────────
export const analyzeManualArticle = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }
  const { title, content, source, url, publishedAt, companyId } = request.data || {};
  if (!title || !content) {
    throw new HttpsError('invalid-argument', 'Title and content are required');
  }
  const runtime = await resolveRuntime(request.auth.uid, companyId);
  const relevanceResult = await checkRelevance(
    { title, content, source: source || 'manual' },
    runtime.ai,
    { companyId: runtime.companyId }
  );
  const analysis = await analyzeArticle(
    { title, content, source: source || 'manual', url: url || '', publishedAt: publishedAt || new Date().toISOString() },
    runtime.ai,
    { companyId: runtime.companyId }
  );
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
// triggerRssCollection, triggerScrapingCollection: removed (replaced by scheduled pipeline in runFullPipeline)
// triggerAiFiltering, triggerDeepAnalysis, triggerBriefingGeneration: removed (internal steps, use runFullPipeline)
export const triggerEmailSend = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const companyId = request.data?.companyId || await getPrimaryCompanyId(request.auth.uid);
  await assertCompanyAccess(request.auth.uid, companyId);
  const outputId = request.data?.id;
  if (!outputId) throw new HttpsError('invalid-argument', 'Output ID is required');
  return sendBriefingEmails(outputId);
});
export const triggerTelegramSend = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const companyId = request.data?.companyId || await getPrimaryCompanyId(request.auth.uid);
  await assertCompanyAccess(request.auth.uid, companyId);
  const outputId = request.data?.id;
  if (!outputId) throw new HttpsError('invalid-argument', 'Output ID is required');
  return sendBriefingToTelegram(outputId);
});
// getPaidSourceAccess, managePaidSourceAccess: removed (paid source access UI removed)
// scheduledNewsCollection: removed (replaced by local PC scraper auto-scheduler)
// ─────────────────────────────────────────
// Scheduled: Briefing generation (daily 22:00)
// ─────────────────────────────────────────
export const scheduledBriefingGeneration = onSchedule('0 22 * * *', async () => {
  const db = admin.firestore();
  const companiesSnapshot = await db.collection('companies').where('active', '==', true).get();
  for (const companyDoc of companiesSnapshot.docs) {
    try {
      const runtime = await getCompanyRuntimeConfig(companyDoc.id);
      await createDailyBriefing({
        companyId: runtime.companyId,
        aiConfig: runtime.ai,
        outputConfig: runtime.output,
        timezone: runtime.timezone,
      });
    } catch (err: any) {
      console.error(`Scheduled briefing failed for company ${companyDoc.id}:`, err.message);
    }
  }
});
// ─────────────────────────────────────────
// runFullPipeline: 파이프라인 시작 (즉시 pipelineId 반환, 실제 실행은 background HTTP)
// ─────────────────────────────────────────
export const runFullPipeline = onCall({ region: 'us-central1', timeoutSeconds: 60 }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

  const runtime = await resolveRuntime(request.auth.uid, request.data?.companyId, request.data?.overrides);
  const db = admin.firestore();
  const pipelineRef = db.collection('pipelineRuns').doc();
  const pipelineId = pipelineRef.id;

  await pipelineRef.set({
    id: pipelineId,
    companyId: runtime.companyId,
    companyName: runtime.companyName,
    status: 'pending',
    triggeredBy: request.auth.uid,
    configSnapshot: runtime,
    startedAt: admin.firestore.FieldValue.serverTimestamp(),
    steps: {},
  });

  // Kick off background HTTP execution — no await (fire and forget)
  // executePipelineHttp runs independently in Cloud Run with its own 9-min timeout
  const execUrl = `https://us-central1-eumnews-9a99c.cloudfunctions.net/executePipelineHttp`;
  fetch(execUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pipelineId, companyId: runtime.companyId }),
  }).catch(err => console.error('Failed to trigger executePipelineHttp:', err));

  return { pipelineId, success: true };
});

// ─────────────────────────────────────────
// executePipelineHttp: 실제 파이프라인 실행 (9분 타임아웃, HTTP 트리거)
// ─────────────────────────────────────────
export const executePipelineHttp = onRequest(
  { region: 'us-central1', timeoutSeconds: 540, memory: '1GiB' },
  async (req, res) => {
    const { pipelineId, companyId } = req.body || {};
    if (!pipelineId || !companyId) {
      res.status(400).json({ error: 'Missing pipelineId or companyId' });
      return;
    }

    const db = admin.firestore();
    const pipelineRef = db.collection('pipelineRuns').doc(pipelineId);
    const pipelineDoc = await pipelineRef.get();
    if (!pipelineDoc.exists) {
      res.status(404).json({ error: 'Pipeline not found' });
      return;
    }

    // Respond immediately so the caller (runFullPipeline) doesn't wait
    res.json({ accepted: true, pipelineId });

    const runtime = pipelineDoc.data()?.configSnapshot;
    if (!runtime) {
      await pipelineRef.update({ status: 'failed', error: 'Missing configSnapshot' });
      return;
    }

    const updateStep = async (
      step: string,
      status: 'running' | 'completed' | 'failed' | 'skipped',
      result?: any,
    ) => {
      await pipelineRef.update({
        [`steps.${step}`]: {
          status,
          completedAt: status === 'running' ? null : admin.firestore.FieldValue.serverTimestamp(),
          ...(result ? { result } : {}),
        },
      });
    };

    await pipelineRef.update({ status: 'running' });
    try {
      await updateStep('collection', 'running');
      const collectionStart = Date.now();
      const [rssResult, scrapingResult, apiResult] = await Promise.all([
        processRssSources({ companyId, pipelineRunId: pipelineId, filters: runtime.filters, aiConfig: runtime.ai }),
        processScrapingSources({ companyId, pipelineRunId: pipelineId, filters: runtime.filters, aiConfig: runtime.ai }),
        processApiSources({ companyId, pipelineRunId: pipelineId, filters: runtime.filters, aiConfig: runtime.ai }),
      ]);
      const totalCollected =
        (rssResult.totalCollected || 0) +
        (scrapingResult.totalCollected || 0) +
        (apiResult.totalCollected || 0);
      await updateStep('collection', 'completed', {
        duration: Date.now() - collectionStart,
        rss: rssResult, scraping: scrapingResult, api: apiResult, totalCollected,
      });

      await updateStep('filtering', 'running');
      const filteringStart = Date.now();
      const filteringResult = await processRelevanceFiltering({
        companyId, pipelineRunId: pipelineId, aiConfig: runtime.ai, filters: runtime.filters,
      });
      await updateStep('filtering', 'completed', { duration: Date.now() - filteringStart, ...filteringResult });

      await updateStep('analysis', 'running');
      const analysisStart = Date.now();
      const analysisResult = await processDeepAnalysis({ companyId, pipelineRunId: pipelineId, aiConfig: runtime.ai });
      await updateStep('analysis', 'completed', { duration: Date.now() - analysisStart, ...analysisResult });

      await updateStep('output', 'running');
      const outputStart = Date.now();
      const outputResult = await createDailyBriefing({
        companyId, pipelineRunId: pipelineId, aiConfig: runtime.ai,
        outputConfig: runtime.output, timezone: runtime.timezone,
      });
      await updateStep('output', outputResult.success ? 'completed' : 'failed', {
        duration: Date.now() - outputStart, ...outputResult,
      });

      await pipelineRef.update({
        status: outputResult.success ? 'completed' : 'failed',
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (error: any) {
      console.error('Pipeline execution error:', error.message);
      await pipelineRef.update({
        status: 'failed',
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        error: error.message || String(error),
      }).catch(() => {});
    }
  },
);

// ─────────────────────────────────────────
// [NEW] Scraping Rules Management (로컬 PC)
// ─────────────────────────────────────────
/**
 * 스크래핑 규칙 조회 (Superadmin만)
 * Firestore의 scrapingRules 컬렉션에서 모든 규칙 조회
 */
export const getScrapingRules = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

  const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (userDoc.data()?.role !== 'superadmin') {
    throw new HttpsError('permission-denied', 'Superadmin required');
  }

  try {
    const db = admin.firestore();
    const snap = await db.collection('scrapingRules').get();
    const data = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return { data };
  } catch (err: any) {
    throw new HttpsError('internal', err.message);
  }
});

/**
 * 스크래핑 규칙 저장 (Superadmin만)
 * sourceId: 'thebell' | 'marketinsight'
 * keywords: string[]
 * categories: string[]
 */
export const saveScrapingRule = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

  const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (userDoc.data()?.role !== 'superadmin') {
    throw new HttpsError('permission-denied', 'Superadmin required');
  }

  const { sourceId, keywords, categories } = request.data || {};
  if (!sourceId || !keywords || !categories) {
    throw new HttpsError('invalid-argument', 'sourceId, keywords, categories required');
  }

  try {
    const db = admin.firestore();

    // 같은 sourceId의 기존 규칙 찾기
    const existingSnap = await db.collection('scrapingRules')
      .where('sourceId', '==', sourceId)
      .get();

    const sourceName = sourceId === 'thebell' ? '더벨 (The Bell)' : '마켓인사이트 (M&A)';
    const ruleData = {
      sourceId,
      sourceName,
      keywords,
      categories,
      enabled: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    let ruleId: string;
    if (existingSnap.empty) {
      // 새로운 규칙 생성
      const newRef = db.collection('scrapingRules').doc();
      await newRef.set({
        ...ruleData,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      ruleId = newRef.id;
    } else {
      // 기존 규칙 업데이트
      const docId = existingSnap.docs[0].id;
      await db.collection('scrapingRules').doc(docId).update(ruleData);
      ruleId = docId;
    }

    return { success: true, ruleId };
  } catch (err: any) {
    throw new HttpsError('internal', err.message);
  }
});

/**
 * 스크래핑 규칙 삭제 (Superadmin만)
 */
export const deleteScrapingRule = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

  const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (userDoc.data()?.role !== 'superadmin') {
    throw new HttpsError('permission-denied', 'Superadmin required');
  }

  const { ruleId } = request.data || {};
  if (!ruleId) throw new HttpsError('invalid-argument', 'ruleId required');

  try {
    await admin.firestore().collection('scrapingRules').doc(ruleId).delete();
    return { success: true };
  } catch (err: any) {
    throw new HttpsError('internal', err.message);
  }
});

/**
 * 스크래핑 규칙 실행 (Superadmin만)
 * 로컬 Windows PC의 Puppeteer 서버를 호출
 * 환경변수: LOCAL_PC_SCRAPER_URL (예: http://192.168.1.100:3001)
 */
export const executeScrapingRule = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

  const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (userDoc.data()?.role !== 'superadmin') {
    throw new HttpsError('permission-denied', 'Superadmin required');
  }

  const { sourceId } = request.data || {};
  if (!sourceId) throw new HttpsError('invalid-argument', 'sourceId required');

  try {
    const db = admin.firestore();

    // 규칙 조회
    const ruleSnap = await db.collection('scrapingRules')
      .where('sourceId', '==', sourceId)
      .get();

    if (ruleSnap.empty) {
      throw new Error(`No scraping rule found for sourceId: ${sourceId}`);
    }

    const rule = ruleSnap.docs[0].data();
    const scraperUrl = process.env.LOCAL_PC_SCRAPER_URL;

    if (!scraperUrl) {
      throw new Error('LOCAL_PC_SCRAPER_URL environment variable not set');
    }

    // 로컬 PC 서버 호출
    const endpoint = sourceId === 'thebell'
      ? `${scraperUrl}/api/thebell/scrape`
      : `${scraperUrl}/api/marketinsight/scrape`;

    const response = await axios.get(endpoint, {
      params: {
        keywords: rule.keywords.join(','),
        categories: rule.categories.join(','),
      },
      timeout: 60000,
    });

    if (!response.data.success) {
      throw new Error(response.data.message || 'Scraping failed');
    }

    // 수집된 기사를 Firestore에 저장
    const articles = response.data.data || [];
    const batchSize = 500;

    for (let i = 0; i < articles.length; i += batchSize) {
      const batch = db.batch();
      const chunk = articles.slice(i, i + batchSize);

      for (const article of chunk) {
        const articleRef = db.collection('articles').doc();
        batch.set(articleRef, {
          ...article,
          source: sourceId === 'thebell' ? '더벨' : '마켓인사이트',
          sourceId,
          collectedAt: admin.firestore.FieldValue.serverTimestamp(),
          status: 'new',
        });
      }

      await batch.commit();
    }

    return {
      data: {
        sourceId,
        success: true,
        articlesFound: articles.length,
        message: `${articles.length}개 기사 수집 완료`,
        executedAt: new Date().toISOString(),
      },
    };
  } catch (err: any) {
    return {
      data: {
        sourceId,
        success: false,
        message: err.message || 'Execution failed',
      },
    };
  }
});

// ─────────────────────────────────────────
// [NEW] generateReport: 사용자 선택 기사 + 프롬프트 → HTML 분석 보고서
// ─────────────────────────────────────────
// [FAST] generateReportV2: 보고서 문서 생성 후 즉시 ID 반환
// 실제 생성은 generateReportContentHttp에서 백그라운드로 수행
export const generateReportV2 = onCall(
  { region: 'us-central1', timeoutSeconds: 60, cors: true, invoker: 'public' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

    try {
      const {
        companyId: rawCompanyId,
        articleIds,
        keywords = [],
        analysisPrompt = '',
        reportTitle,
      } = request.data || {};

      if (!Array.isArray(articleIds) || articleIds.length === 0) {
        throw new HttpsError('invalid-argument', 'articleIds 배열이 필요합니다');
      }

      const companyId = rawCompanyId || await getPrimaryCompanyId(request.auth.uid);
      await assertCompanyAccess(request.auth.uid, companyId);

      const db = admin.firestore();

      // 1. Output document 생성 (pending 상태로)
      const outputRef = db.collection('outputs').doc();
      const reportTitleResolved = reportTitle || `${keywords[0] || '시장'} 동향 분석 보고서`;

      await outputRef.set({
        id: outputRef.id,
        companyId,
        type: 'custom_report',
        title: reportTitleResolved,
        keywords,
        analysisPrompt,
        articleIds,
        articleCount: articleIds.length,
        status: 'pending',
        requestedBy: request.auth.uid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 2. 백그라운드 실행: generateReportContentHttp 호출 (await 하지 않음)
      const functionsUrl = `https://us-central1-eumnews-9a99c.cloudfunctions.net/generateReportContentHttp`;
      fetch(functionsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outputId: outputRef.id,
          companyId,
          articleIds,
          keywords,
          analysisPrompt,
          reportTitle: reportTitleResolved,
          requestedBy: request.auth.uid,
        }),
      }).catch(err => console.error('Failed to trigger generateReportContentHttp:', err));

      // 3. 즉시 ID 반환
      return {
        success: true,
        outputId: outputRef.id,
        status: 'pending',
        message: 'Report generation started. Check status with outputId.',
      };
    } catch (err: any) {
      const errorMsg = err.message || (typeof err === 'string' ? err : 'Unknown error');
      console.error('generateReportV2 FAILED:', {
        message: errorMsg,
        stack: err.stack,
        data: request.data
      });
      if (err instanceof HttpsError) throw err;
      throw new HttpsError('internal', `Report creation failed: ${errorMsg}`);
    }
  }
);
export const generateReport = generateReportV2;

// [NEW] generateReportContentHttp: 보고서 내용 생성 (백그라운드, 최대 540초)
export const generateReportContentHttp = onRequest(
  { region: 'us-central1', timeoutSeconds: 540, memory: '1GiB' },
  async (req, res) => {
    const { outputId, companyId, articleIds, keywords = [], analysisPrompt = '', reportTitle, requestedBy } = req.body;

    if (!outputId || !companyId) {
      res.status(400).json({ error: 'Missing outputId or companyId' });
      return;
    }

    try {
      const db = admin.firestore();
      const outputRef = db.collection('outputs').doc(outputId);

      // 즉시 응답 (클라이언트가 기다리지 않음)
      res.json({ accepted: true, outputId, status: 'processing' });

      // 백그라운드에서 생성 시작
      (async () => {
        try {
          // Status 업데이트: processing
          await outputRef.update({
            status: 'processing',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          // 런타임 설정 조회
          const runtime = await getCompanyRuntimeConfig(companyId);

          // 실제 보고서 생성
          const result = await generateCustomReport({
            companyId,
            articleIds,
            keywords,
            analysisPrompt,
            reportTitle,
            requestedBy,
            aiConfig: runtime.ai,
          });

          // Status 업데이트: completed
          await outputRef.update({
            status: 'completed',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          console.log(`Report ${outputId} generated successfully`);
        } catch (err: any) {
          console.error(`Report ${outputId} generation failed:`, err);
          // Status 업데이트: failed
          await outputRef.update({
            status: 'failed',
            errorMessage: err.message || 'Unknown error',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }).catch(e => console.error('Failed to update status:', e));
        }
      })();
    } catch (err: any) {
      console.error('generateReportContentHttp error:', err);
      res.status(500).json({ error: err.message || 'Internal error' });
    }
  },
);

// ─────────────────────────────────────────
// [NEW] searchArticles: 기사 검색 (키워드/날짜/매체)
// ─────────────────────────────────────────
export const searchArticles = onCall(
  { region: 'us-central1', timeoutSeconds: 60, cors: true, invoker: 'public' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

    try {
      const {
        companyId: rawCompanyId,
        keywords = [],
        startDate,
        endDate,
        sourceIds = [],
        statuses = ['analyzed', 'published'],
        limit: limitNum = 50,
        offset: offsetNum = 0,
      } = request.data || {};

      // companyId is currently not used for filtering as articles are global
      if (!request.auth.uid) throw new HttpsError('unauthenticated', 'Authentication required');

      const db = admin.firestore();
      let q: admin.firestore.Query = db.collection('articles');

      // Status filter
      if (statuses && Array.isArray(statuses) && statuses.length > 0) {
        q = q.where('status', 'in', statuses.slice(0, 10));
      }

      // Date filters (collectedAt)
      if (startDate) {
        const start = new Date(startDate);
        if (!isNaN(start.getTime())) {
          q = q.where('collectedAt', '>=', start);
        } else {
          console.warn('searchArticles: invalid startDate', startDate);
        }
      }
      if (endDate) {
        const end = new Date(endDate);
        if (!isNaN(end.getTime())) {
          q = q.where('collectedAt', '<=', end);
        } else {
          console.warn('searchArticles: invalid endDate', endDate);
        }
      }

      q = q.orderBy('collectedAt', 'desc').limit(200);

      const snap = await q.get();
      let articles = snap.docs.map(d => {
        const data = d.data() as any;
        return {
          id: d.id,
          title: data.title || '',
          source: data.source || '',
          sourceId: data.sourceId || data.globalSourceId || null,
          publishedAt: data.publishedAt,
          collectedAt: data.collectedAt,
          status: data.status,
          summary: data.summary || [],
          category: data.category || '',
          tags: data.tags || [],
          relevanceScore: data.relevanceScore || 0,
          content: data.content || '',
          url: data.url || '',
          companyId: data.companyId,
        };
      });

      // Source filter (memory) — resolve source names and support direct source name matching
      if (sourceIds && Array.isArray(sourceIds) && sourceIds.length > 0) {
        // Try to resolve source names from globalSources
        let sourceNames: string[] = [];
        const nameBatches: string[][] = [];
        for (let i = 0; i < sourceIds.length; i += 30) nameBatches.push(sourceIds.slice(i, i + 30));
        try {
          const nameResults = await Promise.all(
            nameBatches.map(batch =>
              db.collection('globalSources')
                .where(admin.firestore.FieldPath.documentId(), 'in', batch)
                .get()
                .then(snap => snap.docs.map(d => (d.data().name as string) || ''))
            )
          );
          sourceNames = nameResults.flat().filter(Boolean);
        } catch (err) {
          console.warn('Failed to resolve source names from globalSources:', err);
        }

        // Filter: match by globalSourceId, source ID, source name (direct), or resolved names
        articles = articles.filter(a => {
          // 1. Direct ID match (globalSourceId)
          if (a.sourceId && sourceIds.includes(a.sourceId)) return true;
          // 2. Source ID as string (for "thebell", "marketinsight", etc.)
          if (sourceIds.includes(a.source)) return true;
          // 3. Resolved source names from globalSources
          if (sourceNames.includes(a.source)) return true;
          // 4. Direct source name match (for "더벨", "마켓인사이트", etc.)
          if (sourceIds.includes(a.source)) return true;
          return false;
        });
      }

      // Keyword filter (memory)
      if (keywords && Array.isArray(keywords) && keywords.length > 0) {
        const kwLower = (keywords as string[]).map((k: string) => k.toLowerCase());
        articles = articles.filter(article => {
          const text = [
            article.title,
            article.content,
            ...(article.summary || []),
            ...(article.tags || []),
          ].join(' ').toLowerCase();
          return kwLower.some(kw => text.includes(kw));
        });
      }

      // Pagination
      const total = articles.length;
      const paged = articles.slice(offsetNum, offsetNum + limitNum);

      return { articles: paged, total, hasMore: offsetNum + limitNum < total };
    } catch (err: any) {
      console.error('searchArticles error:', err);
      if (err instanceof HttpsError) throw err;
      throw new HttpsError('internal', err.message || 'Search failed');
    }
  }
);

// ─────────────────────────────────────────
// 기사 삭제 유틸: 배치 작업 (500건씩)
// ─────────────────────────────────────────
async function deleteArticlesByQuery(db: admin.firestore.Firestore, q: admin.firestore.Query) {
  let deleted = 0;
  let snapshot = await q.limit(500).get();

  while (snapshot.docs.length > 0) {
    const batch = db.batch();
    snapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit();
    deleted += snapshot.docs.length;
    console.log(`Deleted ${deleted} articles...`);

    snapshot = await q.limit(500).get();
  }
  return deleted;
}

// ─────────────────────────────────────────
// 모든 기사 삭제 (Superadmin용)
// ─────────────────────────────────────────
export const deleteAllArticlesHttp = onRequest(
  { region: 'us-central1', timeoutSeconds: 300, memory: '512MiB' },
  async (request, response) => {
    // CORS
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-uid');
    if (request.method === 'OPTIONS') {
      response.status(200).send('OK');
      return;
    }

    try {
      const db = admin.firestore();
      const uid = request.headers['x-uid'] as string;
      if (!uid) {
        response.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists || (userDoc.data() as any)?.role !== 'superadmin') {
        response.status(403).json({ error: 'Forbidden - Superadmin only' });
        return;
      }

      const q = db.collection('articles');
      const deleted = await deleteArticlesByQuery(db, q);

      response.json({
        success: true,
        message: `전체 기사 삭제 완료: ${deleted}건`,
        deletedCount: deleted,
      });
    } catch (err: any) {
      console.error('deleteAllArticles error:', err);
      response.status(500).json({ error: err.message });
    }
  }
);

// ─────────────────────────────────────────
// 제외된 기사 삭제 (status='rejected')
// ─────────────────────────────────────────
export const deleteExcludedArticlesHttp = onRequest(
  { region: 'us-central1', timeoutSeconds: 300, memory: '512MiB' },
  async (request, response) => {
    // CORS
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-uid');
    if (request.method === 'OPTIONS') {
      response.status(200).send('OK');
      return;
    }

    try {
      const db = admin.firestore();
      const uid = request.headers['x-uid'] as string;
      if (!uid) {
        response.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists || (userDoc.data() as any)?.role !== 'superadmin') {
        response.status(403).json({ error: 'Forbidden - Superadmin only' });
        return;
      }

      const q = db.collection('articles').where('status', '==', 'rejected');
      const deleted = await deleteArticlesByQuery(db, q);

      response.json({
        success: true,
        message: `제외된 기사 삭제 완료: ${deleted}건`,
        deletedCount: deleted,
      });
    } catch (err: any) {
      console.error('deleteExcludedArticles error:', err);
      response.status(500).json({ error: err.message });
    }
  }
);

// ─────────────────────────────────────────
// 모든 보고서 삭제 (outputs 컬렉션)
// ─────────────────────────────────────────
export const deleteAllOutputsHttp = onRequest(
  { region: 'us-central1', timeoutSeconds: 300, memory: '512MiB' },
  async (request, response) => {
    // CORS
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-uid');
    if (request.method === 'OPTIONS') {
      response.status(200).send('OK');
      return;
    }

    try {
      const db = admin.firestore();
      const uid = request.headers['x-uid'] as string;
      if (!uid) {
        response.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists || (userDoc.data() as any)?.role !== 'superadmin') {
        response.status(403).json({ error: 'Forbidden - Superadmin only' });
        return;
      }

      const q = db.collection('outputs');
      const deleted = await deleteArticlesByQuery(db, q);

      response.json({
        success: true,
        message: `모든 보고서 삭제 완료: ${deleted}건`,
        deletedCount: deleted,
      });
    } catch (err: any) {
      console.error('deleteAllOutputs error:', err);
      response.status(500).json({ error: err.message });
    }
  }
);
