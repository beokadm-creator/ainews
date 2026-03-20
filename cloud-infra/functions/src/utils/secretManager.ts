import * as admin from 'firebase-admin';
import { AiProvider } from '../types/runtime';

// ─────────────────────────────────────────
// In-memory cache
// ─────────────────────────────────────────
const secretCache: Map<string, string> = new Map();

/**
 * 환경변수에서 비밀값을 가져오고 캐싱합니다.
 */
export async function getSecretValue(envKey: string): Promise<string> {
  if (secretCache.has(envKey)) return secretCache.get(envKey)!;
  const value = process.env[envKey] || '';
  if (value) {
    secretCache.set(envKey, value);
  } else {
    console.warn(`Environment variable ${envKey} is not set.`);
  }
  return value;
}

/**
 * GLM API Key를 가져옵니다.
 */
export async function getGlmApiKey(): Promise<string> {
  return getSecretValue('GLM_API_KEY');
}

/**
 * envKey 기반 API Key를 가져옵니다 (기존 호환성 유지).
 */
export async function getApiKeyByEnvKey(envKey?: string): Promise<string> {
  return getSecretValue(envKey || 'GLM_API_KEY');
}

/**
 * 회사별 Firestore에 저장된 API 키를 우선 조회합니다.
 * 없으면 빈 문자열 반환 (호출자가 env fallback을 처리).
 */
export async function getApiKeyForCompany(companyId: string, provider: AiProvider): Promise<string> {
  try {
    const db = admin.firestore();
    const settingsDoc = await db.collection('companySettings').doc(companyId).get();
    if (!settingsDoc.exists) return '';
    const data = settingsDoc.data() as any;
    const key = data?.apiKeys?.[provider] || '';
    return key;
  } catch {
    return '';
  }
}

/**
 * 회사별 API 키를 Firestore에 저장합니다.
 */
export async function saveApiKeyForCompany(companyId: string, provider: AiProvider, apiKey: string): Promise<void> {
  const db = admin.firestore();
  await db.collection('companySettings').doc(companyId).set(
    { apiKeys: { [provider]: apiKey } },
    { merge: true }
  );
  // 캐시 무효화
  secretCache.delete(`company_${companyId}_${provider}`);
}

/**
 * API 키가 유효한지 사전 검증합니다.
 */
export function validateApiKey(apiKey: string | undefined, provider?: string): void {
  if (!apiKey || apiKey.trim() === '' || apiKey.startsWith('your_') || apiKey === 'xxx') {
    throw new Error(
      `API key for provider "${provider || 'unknown'}" is not configured or invalid. ` +
      'Please set the key in Settings > AI Providers.'
    );
  }
}

/**
 * 캐시를 초기화합니다 (테스트 또는 키 갱신 시 사용).
 */
export function clearSecretCache(): void {
  secretCache.clear();
}
