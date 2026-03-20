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
exports.getSecretValue = getSecretValue;
exports.getGlmApiKey = getGlmApiKey;
exports.getApiKeyByEnvKey = getApiKeyByEnvKey;
exports.getApiKeyForCompany = getApiKeyForCompany;
exports.saveApiKeyForCompany = saveApiKeyForCompany;
exports.validateApiKey = validateApiKey;
exports.clearSecretCache = clearSecretCache;
const admin = __importStar(require("firebase-admin"));
// ─────────────────────────────────────────
// In-memory cache
// ─────────────────────────────────────────
const secretCache = new Map();
/**
 * 환경변수에서 비밀값을 가져오고 캐싱합니다.
 */
async function getSecretValue(envKey) {
    if (secretCache.has(envKey))
        return secretCache.get(envKey);
    const value = process.env[envKey] || '';
    if (value) {
        secretCache.set(envKey, value);
    }
    else {
        console.warn(`Environment variable ${envKey} is not set.`);
    }
    return value;
}
/**
 * GLM API Key를 가져옵니다.
 */
async function getGlmApiKey() {
    return getSecretValue('GLM_API_KEY');
}
/**
 * envKey 기반 API Key를 가져옵니다 (기존 호환성 유지).
 */
async function getApiKeyByEnvKey(envKey) {
    return getSecretValue(envKey || 'GLM_API_KEY');
}
/**
 * 회사별 Firestore에 저장된 API 키를 우선 조회합니다.
 * 없으면 빈 문자열 반환 (호출자가 env fallback을 처리).
 */
async function getApiKeyForCompany(companyId, provider) {
    try {
        const db = admin.firestore();
        const settingsDoc = await db.collection('companySettings').doc(companyId).get();
        if (!settingsDoc.exists)
            return '';
        const data = settingsDoc.data();
        const key = data?.apiKeys?.[provider] || '';
        return key;
    }
    catch {
        return '';
    }
}
/**
 * 회사별 API 키를 Firestore에 저장합니다.
 */
async function saveApiKeyForCompany(companyId, provider, apiKey) {
    const db = admin.firestore();
    await db.collection('companySettings').doc(companyId).set({ apiKeys: { [provider]: apiKey } }, { merge: true });
    // 캐시 무효화
    secretCache.delete(`company_${companyId}_${provider}`);
}
/**
 * API 키가 유효한지 사전 검증합니다.
 */
function validateApiKey(apiKey, provider) {
    if (!apiKey || apiKey.trim() === '' || apiKey.startsWith('your_') || apiKey === 'xxx') {
        throw new Error(`API key for provider "${provider || 'unknown'}" is not configured or invalid. ` +
            'Please set the key in Settings > AI Providers.');
    }
}
/**
 * 캐시를 초기화합니다 (테스트 또는 키 갱신 시 사용).
 */
function clearSecretCache() {
    secretCache.clear();
}
//# sourceMappingURL=secretManager.js.map