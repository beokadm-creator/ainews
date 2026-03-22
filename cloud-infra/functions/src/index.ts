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
admin.firestore().settings({ ignoreUndefinedProperties: true });
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

// superadmin용: systemSettings/aiConfig + systemSettings/promptConfig에서 AI 설정 로드
async function getSystemAiConfig(): Promise<{ aiConfig: RuntimeAiConfig; companyId: string }> {
  const db = admin.firestore();
  const [sysDoc, promptDoc] = await Promise.all([
    db.collection('systemSettings').doc('aiConfig').get(),
    db.collection('systemSettings').doc('promptConfig').get(),
  ]);
  const sysData = (sysDoc.data() || {}) as any;
  const promptData = (promptDoc.data() || {}) as any;
  const provider: AiProvider = sysData['ai.provider'] || sysData.ai?.provider || 'glm';
  const defaults = PROVIDER_DEFAULTS[provider];
  const aiConfig: RuntimeAiConfig = {
    ...defaults,
    provider,
    model: sysData[`aiModels.${provider}`] || sysData.ai?.model || defaults.model,
    baseUrl: sysData[`aiBaseUrls.${provider}`] || sysData.ai?.baseUrl || null,
    maxPendingBatch: 20,
    maxAnalysisBatch: 10,
    // 슈퍼어드민이 커스텀 설정한 프롬프트가 있으면 사용, 없으면 코드 기본값
    relevancePrompt: promptData.relevancePrompt || undefined,
    analysisPrompt: promptData.analysisPrompt || undefined,
  };
  // 첫 번째 활성 회사를 fallback companyId로 사용
  const companiesSnap = await db.collection('companies').where('active', '==', true).limit(1).get();
  const companyId = companiesSnap.empty ? '__system__' : companiesSnap.docs[0].id;
  return { aiConfig, companyId };
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
// [NEW] Save/Load AI Prompt Config (Superadmin)
// ─────────────────────────────────────────
export const savePromptConfig = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (userDoc.data()?.role !== 'superadmin') throw new HttpsError('permission-denied', 'Superadmin required');
  const { relevancePrompt, analysisPrompt } = request.data || {};
  const db = admin.firestore();
  const updates: any = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  if (relevancePrompt !== undefined) updates.relevancePrompt = relevancePrompt || null;
  if (analysisPrompt !== undefined) updates.analysisPrompt = analysisPrompt || null;
  await db.collection('systemSettings').doc('promptConfig').set(updates, { merge: true });
  return { success: true };
});

export const getPromptConfig = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (userDoc.data()?.role !== 'superadmin') throw new HttpsError('permission-denied', 'Superadmin required');
  const db = admin.firestore();
  const doc = await db.collection('systemSettings').doc('promptConfig').get();
  const data = doc.data() || {};
  return {
    relevancePrompt: data.relevancePrompt || null,
    analysisPrompt: data.analysisPrompt || null,
  };
});

// ─────────────────────────────────────────
// [NEW] Save AI Provider API Key
// ─────────────────────────────────────────
export const saveAiApiKey = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  try {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Authentication required');
    }
    console.log('saveAiApiKey: Starting with data:', { ...request.data, apiKey: request.data?.apiKey ? '***' : undefined });
    const { companyId: rawCompanyId, provider, apiKey, baseUrl, model, setAsActive } = request.data || {};

    let companyId: string;
    try {
      companyId = rawCompanyId || await getPrimaryCompanyId(request.auth.uid);
      console.log('saveAiApiKey: companyId resolved:', companyId);
    } catch (err: any) {
      console.error('saveAiApiKey: getPrimaryCompanyId failed:', err.message);
      throw new HttpsError('invalid-argument', `Failed to get company ID: ${err.message}`);
    }

    let access: any;
    try {
      access = await assertCompanyAccess(request.auth.uid, companyId);
      console.log('saveAiApiKey: access verified:', { role: access.role });
    } catch (err: any) {
      console.error('saveAiApiKey: assertCompanyAccess failed:', err.message);
      throw new HttpsError('permission-denied', `Access denied: ${err.message}`);
    }

    if (access.role !== 'superadmin' && access.role !== 'company_admin') {
      throw new HttpsError('permission-denied', 'Company admin or superadmin required');
    }
    if (!provider || !['glm', 'gemini', 'openai', 'claude'].includes(provider)) {
      throw new HttpsError('invalid-argument', 'Valid provider required: glm, gemini, openai, claude');
    }

    // 1. API Key 저장
    if (apiKey) {
      if (typeof apiKey !== 'string' || apiKey.trim().length < 5) {
        throw new HttpsError('invalid-argument', 'Valid API key is required');
      }
      console.log('saveAiApiKey: Saving API key for', provider, companyId);
      try {
        await saveApiKeyForCompany(companyId, provider as AiProvider, apiKey.trim());
        console.log('saveAiApiKey: API key saved successfully');
      } catch (keyErr: any) {
        console.error('saveAiApiKey: API key save failed, continuing anyway:', keyErr.message);
        // API 키 저장 실패해도 계속 진행 (나중에 환경 변수나 다른 곳에서 로드 가능)
      }
    }

    // 2. Base URL 및 선택된 모델 저장
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
    console.log('saveAiApiKey: Writing to companySettings:', { companyId, updates });
    await db.collection('companySettings').doc(companyId).set(updates, { merge: true });
    console.log('saveAiApiKey: Wrote to companySettings successfully');

    // Superadmin: also save to global systemSettings
    const userDoc = await db.collection('users').doc(request.auth.uid).get();
    if (userDoc.data()?.role === 'superadmin') {
      console.log('saveAiApiKey: User is superadmin, also saving to systemSettings');
      const sysDocRef = db.collection('systemSettings').doc('aiConfig');
      // update()는 dot-notation을 nested path로 해석 (set+merge는 literal 필드명으로 저장)
      const sysUpdates: any = { ...updates };
      if (!sysUpdates['ai.provider']) sysUpdates['ai.provider'] = provider;
      if (apiKey) {
        sysUpdates[`apiKeys.${provider}`] = apiKey.trim();
      }
      try {
        await sysDocRef.update(sysUpdates);
      } catch {
        // document가 없으면 set으로 fallback (nested object 구조 사용)
        const nested: any = {};
        if (apiKey) nested.apiKeys = { [provider]: apiKey.trim() };
        if (baseUrl !== undefined) { nested.aiBaseUrls = { [provider]: baseUrl }; }
        if (model !== undefined) { nested.aiModels = { [provider]: model }; }
        if (setAsActive) { nested.ai = { provider, model: model || undefined, baseUrl: baseUrl || undefined }; }
        else { nested.ai = { provider }; }
        await sysDocRef.set(nested, { merge: true });
      }
      console.log('saveAiApiKey: Superadmin updates complete');
    }
    console.log('saveAiApiKey: Success');
    return { success: true, message: `Settings for ${provider} saved` };
  } catch (err: any) {
    console.error('saveAiApiKey: ERROR:', err.code, err.message, err.stack);
    // HttpsError는 그대로 re-throw (Firebase가 올바르게 처리)
    if (typeof err.code === 'string' && err.code.startsWith('functions/')) throw err;
    // 일반 Error는 명시적으로 HttpsError로 변환
    throw new HttpsError('internal', err.message || 'Unknown error');
  }
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
  if (!title) {
    throw new HttpsError('invalid-argument', 'Title is required');
  }
  const articleContent = content || title;

  // superadmin은 companyId 없이도 systemSettings AI 설정으로 실행
  let aiConfig: RuntimeAiConfig;
  let resolvedCompanyId: string;
  const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  const isSuperadmin = userDoc.data()?.role === 'superadmin';

  if (isSuperadmin && !companyId) {
    const sys = await getSystemAiConfig();
    aiConfig = sys.aiConfig;
    resolvedCompanyId = sys.companyId;
  } else {
    const runtime = await resolveRuntime(request.auth.uid, companyId);
    aiConfig = runtime.ai;
    resolvedCompanyId = runtime.companyId;
  }

  const relevanceResult = await checkRelevance(
    { title, content: articleContent, source: source || 'manual' },
    aiConfig,
    { companyId: resolvedCompanyId }
  );
  const analysis = await analyzeArticle(
    { title, content: articleContent, source: source || 'manual', url: url || '', publishedAt: publishedAt || new Date().toISOString() },
    aiConfig,
    { companyId: resolvedCompanyId }
  );
  return {
    success: true,
    companyId: resolvedCompanyId,
    isRelevant: relevanceResult.isRelevant,
    confidence: relevanceResult.confidence,
    relevanceReason: relevanceResult.reason,
    analysis,
  };
});
// ─────────────────────────────────────────
// Bulk AI Analysis (전체 기사 일괄 AI 분석)
// ─────────────────────────────────────────
/** Callable: 전체 기사 일괄 분석 시작 (fire-and-forget) */
export const runBulkAiAnalysis = onCall({ region: 'us-central1', timeoutSeconds: 60, cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (userDoc.data()?.role !== 'superadmin') {
    throw new HttpsError('permission-denied', 'Superadmin required');
  }
  const jobRef = admin.firestore().collection('bulkAiJobs').doc();
  await jobRef.set({
    id: jobRef.id,
    status: 'pending',
    triggeredBy: request.auth.uid,
    startedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const execUrl = `https://us-central1-eumnews-9a99c.cloudfunctions.net/runBulkAiAnalysisHttp`;
  fetch(execUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: jobRef.id }),
  }).catch(err => console.error('Failed to trigger runBulkAiAnalysisHttp:', err));
  return { success: true, jobId: jobRef.id };
});

// ── Pipeline abort checker ──
async function isPipelineAborted(db: FirebaseFirestore.Firestore, type: 'pipeline' | 'aionly'): Promise<boolean> {
  try {
    const snap = await db.collection('systemSettings').doc('pipelineControl').get();
    const data = snap.data() || {};
    return type === 'pipeline' ? !data.pipelineEnabled : !data.aiOnlyEnabled;
  } catch { return false; }
}

/** HTTP: 슈퍼어드민 전체 파이프라인 - 수집 → 분류 → 분석 → 보고서 (최대 60분) */
export const runBulkAiAnalysisHttp = onRequest(
  { region: 'us-central1', timeoutSeconds: 3600, memory: '2GiB' },
  async (req, res) => {
    const { jobId } = req.body || {};
    res.json({ accepted: true, jobId });

    const db = admin.firestore();
    const jobRef = jobId ? db.collection('bulkAiJobs').doc(jobId) : null;
    const controlRef = db.collection('systemSettings').doc('pipelineControl');

    const updateJob = async (data: any) => {
      if (jobRef) await jobRef.update(data).catch(() => {});
    };
    const updateControl = async (data: any) => {
      await controlRef.set(data, { merge: true }).catch(() => {});
    };
    // Abort checker that AI functions can call between batches
    const abortChecker = () => isPipelineAborted(db, 'pipeline');

    try {
      // systemSettings에서 AI 설정 로드
      const sys = await getSystemAiConfig();
      const aiConfig = sys.aiConfig;
      const companyId = sys.companyId;
      console.log(`[Pipeline] Starting: provider=${aiConfig.provider}, model=${aiConfig.model}, companyId=${companyId}`);

      // ── 회사별 런타임 설정 로드 (구독 소스 포함) ──
      let runtimeFilters: any = { sourceIds: [] };
      try {
        const runtime = await getCompanyRuntimeConfig(companyId);
        runtimeFilters = runtime.filters;
        console.log(`[Pipeline] Company filters loaded: sourceIds=${(runtimeFilters.sourceIds || []).length}, dateRange=${runtimeFilters.dateRange}`);
      } catch (err: any) {
        console.warn(`[Pipeline] Could not load runtime config for ${companyId}: ${err.message}, using all active sources`);
      }

      // ── 1단계: 수집 ──
      await updateJob({ status: 'running', currentStep: '1/3 수집 중...' });
      await updateControl({ currentStep: '1/3 수집 중...' });
      let totalCollected = 0;

      // 구독된 소스가 있으면 구독 기반, 없으면 모든 active 소스 사용
      const sourceFilter = (runtimeFilters.sourceIds && runtimeFilters.sourceIds.length > 0)
        ? { filters: runtimeFilters, aiConfig }
        : { filters: { sourceIds: (await db.collection('globalSources').where('status', '==', 'active').get()).docs.map(d => d.id) }, aiConfig };

      const [rssResult, scrapingResult, apiResult] = await Promise.allSettled([
        processRssSources(sourceFilter),
        processScrapingSources(sourceFilter),
        processApiSources(sourceFilter),
      ]);
      if (rssResult.status === 'fulfilled') totalCollected += (rssResult.value as any)?.totalCollected || 0;
      if (scrapingResult.status === 'fulfilled') totalCollected += (scrapingResult.value as any)?.totalCollected || 0;
      if (apiResult.status === 'fulfilled') totalCollected += (apiResult.value as any)?.totalCollected || 0;
      if (rssResult.status === 'rejected') console.error('[Pipeline] RSS error:', (rssResult as any).reason?.message);
      if (scrapingResult.status === 'rejected') console.error('[Pipeline] Scraping error:', (scrapingResult as any).reason?.message);
      if (apiResult.status === 'rejected') console.error('[Pipeline] API error:', (apiResult as any).reason?.message);
      console.log(`[Pipeline] Step 1 done: collected=${totalCollected}`);

      // ── 중단 체크 ──
      if (await abortChecker()) {
        console.log('[Pipeline] Abort requested after collection step.');
        await updateJob({ status: 'aborted', currentStep: null, completedAt: admin.firestore.FieldValue.serverTimestamp(), result: { totalCollected, totalFiltered: 0, totalAnalyzed: 0 } });
        await updateControl({ pipelineRunning: false, currentStep: null });
        return;
      }

      // ── 2단계: AI 관련성 분류 (전체 pending 기사) ──
      await updateJob({ currentStep: '2/3 AI 관련성 분류 중...' });
      await updateControl({ currentStep: '2/3 AI 관련성 분류 중...' });
      const filterResult = await processRelevanceFiltering({ aiConfig, companyId, filters: runtimeFilters, abortChecker });
      const totalFiltered = (filterResult as any).processed || 0;
      console.log(`[Pipeline] Step 2 done: filtered=${totalFiltered}, passed=${(filterResult as any).passed || 0}`);

      // ── 중단 체크 ──
      if (await abortChecker()) {
        console.log('[Pipeline] Abort requested after filter step.');
        await updateJob({ status: 'aborted', currentStep: null, completedAt: admin.firestore.FieldValue.serverTimestamp(), result: { totalCollected, totalFiltered, totalAnalyzed: 0 } });
        await updateControl({ pipelineRunning: false, currentStep: null });
        return;
      }

      // ── 3단계: AI 심층 분석 + 요약 (전체 filtered 기사) ──
      await updateJob({ currentStep: '3/3 AI 분석·요약 중...' });
      await updateControl({ currentStep: '3/3 AI 분석·요약 중...' });
      const analysisResult = await processDeepAnalysis({ aiConfig, companyId, abortChecker });
      const totalAnalyzed = (analysisResult as any).processed || 0;
      console.log(`[Pipeline] Step 3 done: analyzed=${totalAnalyzed}`);

      await updateJob({
        status: 'completed',
        currentStep: null,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        result: { totalCollected, totalFiltered, totalAnalyzed },
      });
    } catch (err: any) {
      console.error('[Pipeline] Fatal error:', err.message, err.stack);
      await updateJob({ status: 'failed', error: err.message });
    } finally {
      try {
        await controlRef.set({ pipelineRunning: false, currentStep: null }, { merge: true });
        const controlSnap = await controlRef.get();
        if (controlSnap.data()?.pipelineEnabled) {
          setTimeout(async () => {
            try {
              const newJobRef = db.collection('bulkAiJobs').doc();
              await newJobRef.set({ id: newJobRef.id, status: 'pending', triggeredBy: 'auto', startedAt: admin.firestore.FieldValue.serverTimestamp() });
              await controlRef.set({ pipelineRunning: true }, { merge: true });
              fetch(`https://us-central1-eumnews-9a99c.cloudfunctions.net/runBulkAiAnalysisHttp`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId: newJobRef.id }),
              }).catch(() => {});
            } catch { await controlRef.set({ pipelineRunning: false }, { merge: true }); }
          }, 10000);
        }
      } catch { /* non-critical */ }
    }
  }
);

/** Callable: 파이프라인 / AI전용 ON/OFF 제어 */
export const setPipelineControl = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (userDoc.data()?.role !== 'superadmin') throw new HttpsError('permission-denied', 'Superadmin only');

  const { type, enabled } = request.data as { type: 'pipeline' | 'aionly' | 'stopall'; enabled: boolean };
  const db = admin.firestore();
  const controlRef = db.collection('systemSettings').doc('pipelineControl');

  if (type === 'stopall') {
    // 모든 파이프라인 강제 종료
    await controlRef.set({
      pipelineEnabled: false, pipelineRunning: false,
      aiOnlyEnabled: false, aiOnlyRunning: false,
      currentStep: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { success: true, enabled: false };
  } else if (type === 'pipeline') {
    await controlRef.set({ pipelineEnabled: enabled, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    if (enabled) {
      const snap = await controlRef.get();
      if (!snap.data()?.pipelineRunning) {
        const newJobRef = db.collection('bulkAiJobs').doc();
        await newJobRef.set({ id: newJobRef.id, status: 'pending', triggeredBy: request.auth!.uid, startedAt: admin.firestore.FieldValue.serverTimestamp() });
        await controlRef.set({ pipelineRunning: true }, { merge: true });
        fetch(`https://us-central1-eumnews-9a99c.cloudfunctions.net/runBulkAiAnalysisHttp`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: newJobRef.id }),
        }).catch(() => {});
      }
    }
  } else if (type === 'aionly') {
    await controlRef.set({ aiOnlyEnabled: enabled, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    if (enabled) {
      const snap = await controlRef.get();
      if (!snap.data()?.aiOnlyRunning) {
        await controlRef.set({ aiOnlyRunning: true }, { merge: true });
        fetch(`https://us-central1-eumnews-9a99c.cloudfunctions.net/runAiOnlyHttp`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        }).catch(() => {});
      }
    }
  }
  return { success: true, enabled };
});

/** HTTP: AI 전용 루프 - 관련성 분류 + 심층 분석 (반복 실행, 최대 60분) */
export const runAiOnlyHttp = onRequest(
  { region: 'us-central1', timeoutSeconds: 3600, memory: '2GiB' },
  async (req, res) => {
    res.json({ accepted: true });
    const db = admin.firestore();
    const controlRef = db.collection('systemSettings').doc('pipelineControl');
    const abortChecker = () => isPipelineAborted(db, 'aionly');
    try {
      await controlRef.set({ aiOnlyRunning: true }, { merge: true });
      const sys = await getSystemAiConfig();
      const aiConfig = sys.aiConfig;
      const companyId = sys.companyId;
      console.log(`[AI-Only] Starting: provider=${aiConfig.provider}, model=${aiConfig.model}, companyId=${companyId}`);

      const filterResult = await processRelevanceFiltering({ aiConfig, companyId, abortChecker });
      const totalFiltered = (filterResult as any).processed || 0;
      console.log(`[AI-Only] Filter done: processed=${totalFiltered}, passed=${(filterResult as any).passed || 0}`);

      if (await abortChecker()) {
        console.log('[AI-Only] Abort requested after filter step.');
        await controlRef.set({ aiOnlyRunning: false, aiOnlyLastResult: { totalFiltered, totalAnalyzed: 0 } }, { merge: true });
        return;
      }

      const analysisResult = await processDeepAnalysis({ aiConfig, companyId, abortChecker });
      const totalAnalyzed = (analysisResult as any).processed || 0;
      console.log(`[AI-Only] Analysis done: analyzed=${totalAnalyzed}`);

      await controlRef.set({ lastAiOnlyAt: admin.firestore.FieldValue.serverTimestamp(), aiOnlyLastResult: { totalFiltered, totalAnalyzed } }, { merge: true });
    } catch (err: any) {
      console.error('[AI-Only] Error:', err.message, err.stack);
    } finally {
      try {
        await controlRef.set({ aiOnlyRunning: false }, { merge: true });
        const snap = await controlRef.get();
        if (snap.data()?.aiOnlyEnabled) {
          setTimeout(async () => {
            try {
              await controlRef.set({ aiOnlyRunning: true }, { merge: true });
              fetch(`https://us-central1-eumnews-9a99c.cloudfunctions.net/runAiOnlyHttp`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
              }).catch(() => {});
            } catch { await controlRef.set({ aiOnlyRunning: false }, { merge: true }); }
          }, 5000);
        }
      } catch { /* non-critical */ }
    }
  }
);

// ─────────────────────────────────────────
// Diagnostic endpoint (시스템 상태 확인용)
// ─────────────────────────────────────────
export const diagnosticHttp = onRequest(
  { region: 'us-central1', timeoutSeconds: 30 },
  async (req, res) => {
    const db = admin.firestore();
    try {
      // POST: 상태 초기화 액션
      if (req.method === 'POST') {
        const { action } = req.body || {};
        if (action === 'resetPipelineState') {
          await db.collection('systemSettings').doc('pipelineControl').set({
            pipelineEnabled: false, pipelineRunning: false,
            aiOnlyEnabled: false, aiOnlyRunning: false,
            currentStep: null,
          }, { merge: true });
          res.json({ success: true, message: 'Pipeline state reset' });
          return;
        }
        if (action === 'clearStaleJobs') {
          // running/pending 상태 job을 모두 aborted로 표시 (force=true 시 시간 무관)
          const force = req.body?.force === true;
          const cutoff = new Date(Date.now() - 30 * 60 * 1000); // 30분 기준
          const staleSnap = await db.collection('bulkAiJobs')
            .where('status', 'in', ['running', 'pending'])
            .get();
          const batch = db.batch();
          let count = 0;
          staleSnap.docs.forEach(d => {
            const startedAt = d.data().startedAt?.toDate?.() || new Date(0);
            if (force || startedAt < cutoff) {
              batch.update(d.ref, { status: 'aborted', completedAt: admin.firestore.FieldValue.serverTimestamp() });
              count++;
            }
          });
          if (count > 0) await batch.commit();
          res.json({ success: true, message: `Marked ${count} stale jobs as aborted` });
          return;
        }
      }
      // 1. AI config
      const aiDoc = await db.collection('systemSettings').doc('aiConfig').get();
      const aiData = aiDoc.data() || {};
      const provider = aiData['ai.provider'] || 'unknown';

      // 2. Active sources
      const srcSnap = await db.collection('globalSources').where('status', '==', 'active').get();
      const sources = srcSnap.docs.map(d => {
        const data = d.data();
        return { id: d.id, name: data.name, type: data.type, rssUrl: (data.rssUrl || '').substring(0, 80), url: (data.url || '').substring(0, 80) };
      });

      // 3. Pipeline control
      const ctrlDoc = await db.collection('systemSettings').doc('pipelineControl').get();
      const ctrl = ctrlDoc.data() || {};

      // 4. Article status counts
      const [pending, filtered, analyzed, rejected] = await Promise.all([
        db.collection('articles').where('status', '==', 'pending').count().get(),
        db.collection('articles').where('status', '==', 'filtered').count().get(),
        db.collection('articles').where('status', '==', 'analyzed').count().get(),
        db.collection('articles').where('status', '==', 'rejected').count().get(),
      ]);

      // 5. API key check
      const hasKeyNested = !!(aiData.apiKeys && aiData.apiKeys[provider]);
      const hasKeyLiteral = !!aiData[`apiKeys.${provider}`];

      // 6. Company settings fallback
      const companiesSnap = await db.collection('companies').where('active', '==', true).limit(1).get();
      const fallbackCompanyId = companiesSnap.empty ? null : companiesSnap.docs[0].id;
      let hasCompanyKey = false;
      if (fallbackCompanyId) {
        const compDoc = await db.collection('companySettings').doc(fallbackCompanyId).get();
        hasCompanyKey = !!(compDoc.data()?.apiKeys?.[provider]);
      }

      // 7. Recent articles by source (last 24h)
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentSnap = await db.collection('articles')
        .where('collectedAt', '>=', admin.firestore.Timestamp.fromDate(since24h))
        .limit(200)
        .get();
      const sourceCount: Record<string, number> = {};
      recentSnap.docs.forEach(d => {
        const src = d.data().source || 'unknown';
        sourceCount[src] = (sourceCount[src] || 0) + 1;
      });
      const recentBySource = Object.entries(sourceCount)
        .sort((a, b) => b[1] - a[1])
        .map(([source, count]) => ({ source, count }));

      // 8. Company subscription info
      let subscribedSourceIds: string[] = [];
      if (fallbackCompanyId) {
        const subDoc = await db.collection('companySourceSubscriptions').doc(fallbackCompanyId).get();
        subscribedSourceIds = subDoc.exists ? ((subDoc.data() as any).subscribedSourceIds ?? []) : [];
      }
      // Map subscribed IDs to names
      const allSourceMap: Record<string, string> = {};
      srcSnap.docs.forEach(d => { allSourceMap[d.id] = d.data().name; });
      const subscribedSources = subscribedSourceIds.map(id => ({ id, name: allSourceMap[id] || id }));
      const notSubscribed = sources.filter(s => !subscribedSourceIds.includes(s.id)).map(s => ({ id: s.id, name: s.name, type: s.type }));

      res.json({
        ai: {
          provider,
          model: aiData[`aiModels.${provider}`] || aiData['ai.model'],
          baseUrl: aiData[`aiBaseUrls.${provider}`] || aiData['ai.baseUrl'] || null,
          hasKeyNested,
          hasKeyLiteral,
          hasCompanyKey,
          fallbackCompanyId,
          allFields: Object.keys(aiData),
        },
        pipelineControl: ctrl,
        activeSources: { count: sources.length, sources },
        articleCounts: {
          pending: pending.data().count,
          filtered: filtered.data().count,
          analyzed: analyzed.data().count,
          rejected: rejected.data().count,
        },
        recentArticlesBySource: recentBySource,
        subscription: {
          companyId: fallbackCompanyId,
          subscribedCount: subscribedSourceIds.length,
          subscribedSources,
          notSubscribed,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);

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
// Scheduled: AI Analysis (every 4 hours)
// ─────────────────────────────────────────
export const scheduledAiAnalysis = onSchedule('0 */4 * * *', async () => {
  const db = admin.firestore();
  const companiesSnapshot = await db.collection('companies').where('active', '==', true).get();
  for (const companyDoc of companiesSnapshot.docs) {
    try {
      const runtime = await getCompanyRuntimeConfig(companyDoc.id);
      await processRelevanceFiltering({ companyId: runtime.companyId, aiConfig: runtime.ai, filters: runtime.filters });
      await processDeepAnalysis({ companyId: runtime.companyId, aiConfig: runtime.ai });
    } catch (err: any) {
      console.error(`Scheduled AI analysis failed for company ${companyDoc.id}:`, err.message);
    }
  }
});
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
  try {
    // superadmin이고 companyId가 없으면 첫 번째 활성 회사 사용
    let targetCompanyId = request.data?.companyId;
    if (!targetCompanyId) {
      const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
      if (userDoc.data()?.role === 'superadmin') {
        const companiesSnap = await admin.firestore().collection('companies').where('active', '==', true).limit(1).get();
        if (!companiesSnap.empty) {
          targetCompanyId = companiesSnap.docs[0].id;
          console.log('runFullPipeline: superadmin using companyId:', targetCompanyId);
        } else {
          throw new HttpsError('not-found', '활성화된 회사가 없습니다');
        }
      }
    }

    console.log('runFullPipeline: resolveRuntime for', targetCompanyId);
    const runtime = await resolveRuntime(request.auth.uid, targetCompanyId, request.data?.overrides);
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
  } catch (err: any) {
    console.error('runFullPipeline error:', err.code, err.message);
    if (typeof err.code === 'string' && err.code.startsWith('functions/')) throw err;
    throw new HttpsError('internal', err.message || 'Pipeline failed');
  }
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
          status: 'pending',  // 'new' → 'pending' (다른 수집 경로와 일치)
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
