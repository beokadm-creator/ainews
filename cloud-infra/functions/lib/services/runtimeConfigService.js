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
exports.getCompanyRuntimeConfig = getCompanyRuntimeConfig;
exports.assertCompanyAccess = assertCompanyAccess;
exports.getDateRangeBounds = getDateRangeBounds;
const admin = __importStar(require("firebase-admin"));
const DEFAULT_FILTERS = {
    keywords: [],
    includeKeywords: [],
    excludeKeywords: [],
    sectors: [],
    sourceIds: [],
    dateRange: {
        mode: 'relative_days',
        days: 1
    }
};
const DEFAULT_AI_CONFIG = {
    provider: 'glm',
    model: 'glm-4',
    apiKeyEnvKey: 'GLM_API_KEY',
    maxPendingBatch: 20,
    maxAnalysisBatch: 10,
};
const DEFAULT_OUTPUT_CONFIG = {
    type: 'analysis_report',
    title: 'AI News Analysis Report',
    includeArticleBody: false,
    maxArticles: 50
};
const DEFAULT_TIMEZONE = 'Asia/Seoul';
function mergeFilters(base, override) {
    return {
        ...base,
        ...override,
        keywords: override?.keywords ?? base.keywords ?? [],
        includeKeywords: override?.includeKeywords ?? base.includeKeywords ?? [],
        excludeKeywords: override?.excludeKeywords ?? base.excludeKeywords ?? [],
        sectors: override?.sectors ?? base.sectors ?? [],
        sourceIds: override?.sourceIds ?? base.sourceIds ?? [],
        dateRange: {
            ...(base.dateRange ?? DEFAULT_FILTERS.dateRange),
            ...(override?.dateRange ?? {})
        }
    };
}
function mergeAiConfig(base, override) {
    return {
        ...base,
        ...override
    };
}
function mergeOutputConfig(base, override) {
    return {
        ...base,
        ...override
    };
}
async function getCompanyRuntimeConfig(companyId, overrides) {
    const db = admin.firestore();
    const companyDoc = await db.collection('companies').doc(companyId).get();
    if (!companyDoc.exists) {
        throw new Error(`Company ${companyId} not found`);
    }
    const company = {
        id: companyDoc.id,
        ...companyDoc.data()
    };
    if (company.active === false) {
        throw new Error(`Company ${companyId} is inactive`);
    }
    const settings = (company.settings ?? {});
    // ── 구독 소스 목록 병합: companySourceSubscriptions → filters.sourceIds
    let subscribedSourceIds = settings.filters?.sourceIds ?? [];
    if (subscribedSourceIds.length === 0) {
        // companySourceSubscriptions에서 구독 중인 globalSources ID 로드
        const subDoc = await db.collection('companySourceSubscriptions').doc(companyId).get();
        if (subDoc.exists) {
            subscribedSourceIds = subDoc.data().subscribedSourceIds ?? [];
        }
    }
    const baseFilters = {
        ...DEFAULT_FILTERS,
        ...(settings.filters ?? {}),
        sourceIds: subscribedSourceIds,
    };
    return {
        companyId,
        companyName: company.name,
        timezone: settings.timezone || DEFAULT_TIMEZONE,
        filters: mergeFilters(baseFilters, overrides?.filters),
        ai: mergeAiConfig({
            ...DEFAULT_AI_CONFIG,
            ...(settings.ai ?? {})
        }, overrides?.ai),
        output: mergeOutputConfig({
            ...DEFAULT_OUTPUT_CONFIG,
            ...(settings.output ?? {})
        }, overrides?.output)
    };
}
async function assertCompanyAccess(uid, companyId) {
    const db = admin.firestore();
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
        throw new Error('User not found');
    }
    const userData = userDoc.data();
    const role = userData.role || 'viewer';
    const companyIds = userData.companyIds || (userData.companyId ? [userData.companyId] : []);
    const managedCompanyIds = userData.managedCompanyIds || [];
    if (role === 'superadmin') {
        return { uid, role, companyIds, managedCompanyIds };
    }
    const canAccess = companyIds.includes(companyId) || managedCompanyIds.includes(companyId);
    if (!canAccess) {
        throw new Error(`User does not belong to company ${companyId}`);
    }
    if (role !== 'company_admin' && role !== 'company_editor') {
        throw new Error('Insufficient role for pipeline execution');
    }
    return { uid, role, companyIds, managedCompanyIds };
}
function getDateRangeBounds(dateRange) {
    if (!dateRange) {
        return { startDate: null, endDate: null };
    }
    if (dateRange.mode === 'absolute') {
        const startDate = dateRange.startDate ? new Date(dateRange.startDate) : null;
        const endDate = dateRange.endDate ? new Date(dateRange.endDate) : null;
        return {
            startDate: startDate && !isNaN(startDate.getTime()) ? startDate : null,
            endDate: endDate && !isNaN(endDate.getTime()) ? endDate : null
        };
    }
    const days = Math.max(1, dateRange.days || 1);
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    return { startDate, endDate };
}
//# sourceMappingURL=runtimeConfigService.js.map