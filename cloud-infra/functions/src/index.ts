import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { setGlobalOptions } from 'firebase-functions/v2';

setGlobalOptions({
  region: 'us-central1',
  maxInstances: 5,
  concurrency: 50,
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
export const getGlobalSources = onCall({ region: 'us-central1' }, async (request) => {
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
export const upsertGlobalSource = onCall({ region: 'us-central1' }, async (request) => {
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
export const deleteGlobalSource = onCall({ region: 'us-central1' }, async (request) => {
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
export const updateCompanySourceSubscriptions = onCall({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const { companyId: rawCompanyId, subscribedSourceIds } = request.data || {};
  const companyId = rawCompanyId || await getPrimaryCompanyId(request.auth.uid);
  const access = await assertCompanyAccess(request.auth.uid, companyId);
  if (!['superadmin', 'company_admin'].includes(access.role)) {
    throw new HttpsError('permission-denied', 'Company admin required');
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
  return { success: true, companyId, count: subscribedSourceIds.length };
});
// ─────────────────────────────────────────
// [NEW] Company & User Management
// ─────────────────────────────────────────
/** 회사 목록 조회 (Superadmin만) */
export const getCompanies = onCall({ region: 'us-central1' }, async (request) => {
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
export const upsertCompany = onCall({ region: 'us-central1' }, async (request) => {
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
export const adminCreateUser = onCall({ region: 'us-central1' }, async (request) => {
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
export const getCompanyUsers = onCall({ region: 'us-central1' }, async (request) => {
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
export const saveAiApiKey = onCall({ region: 'us-central1' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }
  const { companyId: rawCompanyId, provider, apiKey, baseUrl, model } = request.data || {};
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
  // 기본 활성 프로바이더/모델도 업데이트
  updates['ai.provider'] = provider;
  if (model) updates['ai.model'] = model;
  if (baseUrl) updates['ai.baseUrl'] = baseUrl;
  await db.collection('companySettings').doc(companyId).set(updates, { merge: true });
  return { success: true, message: `Settings for ${provider} saved to company ${companyId}` };
});
/** 회사별 파이프라인 설정 (필터, 출력 등) 업데이트 */
export const updateCompanySettings = onCall({ region: 'us-central1' }, async (request) => {
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
export const testAiConnection = onCall({ region: 'us-central1' }, async (request) => {
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
export const analyzeManualArticle = onCall({ region: 'us-central1' }, async (request) => {
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
export const triggerRssCollection = onRequest({ region: 'us-central1' }, async (request, response) => {
  const isAuthenticated = await requireAdmin(request, response as any);
  if (!isAuthenticated) return;
  try {
    const companyId = request.query.companyId as string | undefined;
    const user = (request as any).user;
    const runtime = await resolveRuntime(user.uid, companyId);
    const result = await processRssSources({
      companyId: runtime.companyId,
      filters: runtime.filters,
      aiConfig: runtime.ai
    });
    response.json(result);
  } catch (error: any) {
    response.status(500).json({ success: false, error: error.message });
  }
});
export const triggerScrapingCollection = onRequest({ region: 'us-central1' }, async (request, response) => {
  const isAuthenticated = await requireAdmin(request, response as any);
  if (!isAuthenticated) return;
  try {
    const companyId = request.query.companyId as string | undefined;
    const user = (request as any).user;
    const runtime = await resolveRuntime(user.uid, companyId);
    const result = await processScrapingSources({
      companyId: runtime.companyId,
      filters: runtime.filters,
      aiConfig: runtime.ai
    });
    response.json(result);
  } catch (error: any) {
    response.status(500).json({ success: false, error: error.message });
  }
});
// ─────────────────────────────────────────
// Callable triggers (AI pipeline steps)
// ─────────────────────────────────────────
export const triggerAiFiltering = onCall({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const runtime = await resolveRuntime(request.auth.uid, request.data?.companyId, request.data?.overrides);
  return processRelevanceFiltering({ companyId: runtime.companyId, aiConfig: runtime.ai });
});
export const triggerDeepAnalysis = onCall({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const runtime = await resolveRuntime(request.auth.uid, request.data?.companyId, request.data?.overrides);
  return processDeepAnalysis({ companyId: runtime.companyId, aiConfig: runtime.ai });
});
export const triggerBriefingGeneration = onCall({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const runtime = await resolveRuntime(request.auth.uid, request.data?.companyId, request.data?.overrides);
  return createDailyBriefing({
    companyId: runtime.companyId,
    aiConfig: runtime.ai,
    outputConfig: runtime.output,
    timezone: runtime.timezone,
  });
});
export const triggerEmailSend = onCall({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const companyId = request.data?.companyId || await getPrimaryCompanyId(request.auth.uid);
  await assertCompanyAccess(request.auth.uid, companyId);
  const outputId = request.data?.id;
  if (!outputId) throw new HttpsError('invalid-argument', 'Output ID is required');
  return sendBriefingEmails(outputId);
});
export const triggerTelegramSend = onCall({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const companyId = request.data?.companyId || await getPrimaryCompanyId(request.auth.uid);
  await assertCompanyAccess(request.auth.uid, companyId);
  const outputId = request.data?.id;
  if (!outputId) throw new HttpsError('invalid-argument', 'Output ID is required');
  return sendBriefingToTelegram(outputId);
});
// ─────────────────────────────────────────
// Paid Source Access Control (Superadmin)
// ─────────────────────────────────────────

/**
 * 유료 소스 접근 허용 회사 조회 (Superadmin only)
 * sourceId: 'marketinsight' | 'thebell'
 */
export const getPaidSourceAccess = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (userDoc.data()?.role !== 'superadmin') throw new HttpsError('permission-denied', 'Superadmin required');

  const db = admin.firestore();
  const snap = await db.collection('paidSourceAccess').get();
  const result: Record<string, string[]> = {};
  snap.docs.forEach(d => {
    result[d.id] = d.data().authorizedCompanyIds || [];
  });
  return result;
});

/**
 * 유료 소스에 회사 접근 허용/해제 (Superadmin only)
 * { sourceId: 'marketinsight' | 'thebell', authorizedCompanyIds: ['companyId1', ...] }
 */
export const managePaidSourceAccess = onCall({ region: 'us-central1', cors: true, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (userDoc.data()?.role !== 'superadmin') throw new HttpsError('permission-denied', 'Superadmin required');

  const { sourceId, sourceName, authorizedCompanyIds } = request.data || {};
  if (!sourceId || !Array.isArray(authorizedCompanyIds)) {
    throw new HttpsError('invalid-argument', 'sourceId and authorizedCompanyIds[] required');
  }

  const db = admin.firestore();
  const batch = db.batch();

  // paidSourceAccess 컬렉션 업데이트
  batch.set(db.collection('paidSourceAccess').doc(sourceId), {
    sourceId,
    ...(sourceName ? { sourceName } : {}),
    authorizedCompanyIds,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: request.auth.uid,
  }, { merge: true });

  // globalSources 문서에 allowedCompanyIds 동기화 (프론트엔드 필터링용)
  const gsByScraper = await db.collection('globalSources')
    .where('localScraperId', '==', sourceId)
    .limit(1)
    .get();
  const gsDirectDoc = await db.collection('globalSources').doc(sourceId).get();
  const gsRef = gsByScraper.empty ? (gsDirectDoc.exists ? gsDirectDoc.ref : null) : gsByScraper.docs[0].ref;
  if (gsRef) {
    batch.update(gsRef, {
      allowedCompanyIds: authorizedCompanyIds,
      pricingTier: 'paid',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  await batch.commit();
  console.log(`[PaidSourceAccess] ${sourceId} → ${authorizedCompanyIds.length} companies authorized by ${request.auth.uid}`);
  return { success: true, sourceId, count: authorizedCompanyIds.length };
});

// ─────────────────────────────────────────
// Scheduled: Collection (hourly per company)
// ─────────────────────────────────────────
export const scheduledNewsCollection = onSchedule(
  { schedule: '0 * * * *', memory: '1GiB', timeoutSeconds: 540 },
  async () => {
    const db = admin.firestore();
    const companiesSnapshot = await db.collection('companies').where('active', '==', true).get();
    for (const companyDoc of companiesSnapshot.docs) {
      try {
        const runtime = await getCompanyRuntimeConfig(companyDoc.id);
        await Promise.all([
          processRssSources({ companyId: runtime.companyId, filters: runtime.filters, aiConfig: runtime.ai }),
          processScrapingSources({ companyId: runtime.companyId, filters: runtime.filters, aiConfig: runtime.ai }),
          processApiSources({ companyId: runtime.companyId, filters: runtime.filters, aiConfig: runtime.ai }),
        ]);
        await processRelevanceFiltering({ companyId: runtime.companyId, aiConfig: runtime.ai });
        await processDeepAnalysis({ companyId: runtime.companyId, aiConfig: runtime.ai });
      } catch (err: any) {
        // WARN-01 FIX: 개별 회사 실패가 전체 스케줄러를 멈추지 않도록
        console.error(`Scheduled collection failed for company ${companyDoc.id}:`, err.message);
      }
    }
  }
);
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
// runFullPipeline: Full manual pipeline trigger
// ─────────────────────────────────────────
export const runFullPipeline = onCall({ region: 'us-central1', timeoutSeconds: 540, memory: '1GiB' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Authentication required');
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
  const updateStep = async (
    step: string,
    status: 'running' | 'completed' | 'failed' | 'skipped',
    result?: any
  ) => {
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
    const [rssResult, scrapingResult, apiResult] = await Promise.all([
      processRssSources({ companyId: runtime.companyId, pipelineRunId: pipelineId, filters: runtime.filters, aiConfig: runtime.ai }),
      processScrapingSources({ companyId: runtime.companyId, pipelineRunId: pipelineId, filters: runtime.filters, aiConfig: runtime.ai }),
      processApiSources({ companyId: runtime.companyId, pipelineRunId: pipelineId, filters: runtime.filters, aiConfig: runtime.ai }),
    ]);
    const totalCollected =
      (rssResult.totalCollected || 0) +
      (scrapingResult.totalCollected || 0) +
      (apiResult.totalCollected || 0);
    await updateStep('collection', 'completed', {
      duration: Date.now() - collectionStart,
      rss: rssResult,
      scraping: scrapingResult,
      api: apiResult,
      totalCollected,
    });
    await updateStep('filtering', 'running');
    const filteringStart = Date.now();
    const filteringResult = await processRelevanceFiltering({
      companyId: runtime.companyId,
      pipelineRunId: pipelineId,
      aiConfig: runtime.ai,
      filters: runtime.filters,
    });
    await updateStep('filtering', 'completed', { duration: Date.now() - filteringStart, ...filteringResult });
    await updateStep('analysis', 'running');
    const analysisStart = Date.now();
    const analysisResult = await processDeepAnalysis({
      companyId: runtime.companyId,
      pipelineRunId: pipelineId,
      aiConfig: runtime.ai,
    });
    await updateStep('analysis', 'completed', { duration: Date.now() - analysisStart, ...analysisResult });
    await updateStep('output', 'running');
    const outputStart = Date.now();
    const outputResult = await createDailyBriefing({
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
  } catch (error: any) {
    await pipelineRef.update({
      status: 'failed',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      error: error.message || String(error),
    });
    throw new HttpsError('internal', `Pipeline failed: ${error.message}`);
  }
});

// ─────────────────────────────────────────
// [NEW] Scraping Rules Management (로컬 PC)
// ─────────────────────────────────────────
/**
 * 스크래핑 규칙 조회 (Superadmin만)
 * Firestore의 scrapingRules 컬렉션에서 모든 규칙 조회
 */
export const getScrapingRules = onCall({ region: 'us-central1' }, async (request) => {
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
export const saveScrapingRule = onCall({ region: 'us-central1' }, async (request) => {
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
export const deleteScrapingRule = onCall({ region: 'us-central1' }, async (request) => {
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
export const executeScrapingRule = onCall({ region: 'us-central1' }, async (request) => {
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
export const generateReport = onCall(
  { region: 'us-central1', timeoutSeconds: 300, memory: '512MiB' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

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
    const runtime = await getCompanyRuntimeConfig(companyId);

    try {
      const result = await generateCustomReport({
        companyId,
        articleIds,
        keywords,
        analysisPrompt,
        reportTitle,
        requestedBy: request.auth.uid,
        aiConfig: runtime.ai,
      });
      return result;
    } catch (err: any) {
      console.error('generateReport error:', err);
      throw new HttpsError('internal', err.message || 'Report generation failed');
    }
  }
);

// ─────────────────────────────────────────
// [NEW] searchArticles: 기사 검색 (키워드/날짜/매체)
// ─────────────────────────────────────────
export const searchArticles = onCall(
  { region: 'us-central1', timeoutSeconds: 60 },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

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

    const companyId = rawCompanyId || await getPrimaryCompanyId(request.auth.uid);
    await assertCompanyAccess(request.auth.uid, companyId);

    const db = admin.firestore();
    let q: admin.firestore.Query = db.collection('articles').where('companyId', '==', companyId);

    // 상태 필터
    if (statuses.length > 0) {
      q = q.where('status', 'in', statuses.slice(0, 10));
    }

    // 날짜 필터
    if (startDate) {
      q = q.where('publishedAt', '>=', new Date(startDate));
    }
    if (endDate) {
      q = q.where('publishedAt', '<=', new Date(endDate));
    }

    q = q.orderBy('publishedAt', 'desc').limit(200);

    const snap = await q.get();
    let articles = snap.docs.map(d => {
      const data = d.data() as any;
      return {
        id: d.id,
        title: data.title || '',
        source: data.source || '',
        globalSourceId: data.globalSourceId || null,
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

    // 매체 필터 (메모리)
    if (sourceIds.length > 0) {
      articles = articles.filter(a => sourceIds.includes(a.globalSourceId) || sourceIds.includes(a.source));
    }

    // 키워드 필터 (메모리: 제목/내용/태그/요약에서 검색)
    if (keywords.length > 0) {
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

    // 페이지네이션
    const total = articles.length;
    const paged = articles.slice(offsetNum, offsetNum + limitNum);

    return { articles: paged, total, hasMore: offsetNum + limitNum < total };
  }
);
