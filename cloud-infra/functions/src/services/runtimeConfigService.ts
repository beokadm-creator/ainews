import * as admin from 'firebase-admin';
import {
  CompanyDocument,
  CompanyRuntimeSettings,
  PipelineInvocationOverrides,
  RuntimeAiConfig,
  RuntimeFilters,
  RuntimeOutputConfig,
  RuntimePipelineConfig,
  UserRole
} from '../types/runtime';

const DEFAULT_FILTERS: RuntimeFilters = {
  keywords: [],
  mustIncludeKeywords: [],
  includeKeywords: [],
  excludeKeywords: [],
  sectors: [],
  sourceIds: [],
  dateRange: 'today'
};

const DEFAULT_AI_CONFIG: RuntimeAiConfig = {
  provider: 'glm',
  model: 'glm-4.7',
  apiKeyEnvKey: 'GLM_API_KEY',
  maxPendingBatch: 20,
  maxAnalysisBatch: 10,
};

const DEFAULT_OUTPUT_CONFIG: RuntimeOutputConfig = {
  type: 'analysis_report',
  title: 'AI News Analysis Report',
  includeArticleBody: false,
  maxArticles: 50
};

const DEFAULT_TIMEZONE = 'Asia/Seoul';

function mergeFilters(base: RuntimeFilters, override?: Partial<RuntimeFilters>): RuntimeFilters {
  const mergedDateRange = override?.dateRange ?? base.dateRange ?? DEFAULT_FILTERS.dateRange;

  return {
    ...base,
    ...override,
    keywords: override?.keywords ?? base.keywords ?? [],
    mustIncludeKeywords: override?.mustIncludeKeywords ?? base.mustIncludeKeywords ?? [],
    includeKeywords: override?.includeKeywords ?? base.includeKeywords ?? [],
    excludeKeywords: override?.excludeKeywords ?? base.excludeKeywords ?? [],
    sectors: override?.sectors ?? base.sectors ?? [],
    sourceIds: override?.sourceIds ?? base.sourceIds ?? [],
    dateRange: mergedDateRange,
  };
}

function mergeAiConfig(base: RuntimeAiConfig, override?: Partial<RuntimeAiConfig>): RuntimeAiConfig {
  return {
    ...base,
    ...override
  };
}

function mergeOutputConfig(base: RuntimeOutputConfig, override?: Partial<RuntimeOutputConfig>): RuntimeOutputConfig {
  return {
    ...base,
    ...override
  };
}

export async function getCompanyRuntimeConfig(
  companyId: string,
  overrides?: PipelineInvocationOverrides
): Promise<RuntimePipelineConfig> {
  const db = admin.firestore();
  const companyDoc = await db.collection('companies').doc(companyId).get();

  if (!companyDoc.exists) {
    throw new Error(`Company ${companyId} not found`);
  }

  const company = {
    id: companyDoc.id,
    ...companyDoc.data()
  } as CompanyDocument;

  if (company.active === false) {
    throw new Error(`Company ${companyId} is inactive`);
  }

  // ── [FIX] Load runtime settings from companySettings collection
  const settingsDoc = await db.collection('companySettings').doc(companyId).get();
  const runtimeSettings = (settingsDoc.data() || {}) as any;

  // 구형 settings 구조 (companies/{id}/settings)
  const legacySettings = (company.settings ?? {}) as Partial<CompanyRuntimeSettings>;

  // AI Config 병합 (companySettings -> legacySettings -> Default)
  const aiConfig: RuntimeAiConfig = {
    ...DEFAULT_AI_CONFIG,
    ...(legacySettings.ai ?? {}),
    ...(runtimeSettings.ai ?? {}), // 신규 필드 (객체 통째로 덮어쓰기 권장)
    model: runtimeSettings.aiModels?.[runtimeSettings.ai?.provider || legacySettings.ai?.provider || 'glm'] || 
           runtimeSettings.ai?.model || legacySettings.ai?.model || DEFAULT_AI_CONFIG.model,
    baseUrl: runtimeSettings.aiBaseUrls?.[runtimeSettings.ai?.provider || legacySettings.ai?.provider || 'glm'] || 
             runtimeSettings.ai?.baseUrl || legacySettings.ai?.baseUrl || null,
  };

  // Filters 병합 (companySettings -> legacySettings -> Subscriptions -> Default)
  let subscribedSourceIds: string[] = runtimeSettings.filters?.sourceIds ?? legacySettings.filters?.sourceIds ?? [];
  if (subscribedSourceIds.length === 0) {
    const subDoc = await db.collection('companySourceSubscriptions').doc(companyId).get();
    if (subDoc.exists) {
      subscribedSourceIds = (subDoc.data() as any).subscribedSourceIds ?? [];
    }
  }

  const baseFilters: RuntimeFilters = {
    ...DEFAULT_FILTERS,
    ...(legacySettings.filters ?? {}),
    ...(runtimeSettings.filters ?? {}),
    sourceIds: subscribedSourceIds,
  };

  // Output Config 병합
  const baseOutput: RuntimeOutputConfig = {
    ...DEFAULT_OUTPUT_CONFIG,
    ...(legacySettings.output ?? {}),
    ...(runtimeSettings.output ?? {}),
  };

  return {
    companyId,
    companyName: company.name,
    timezone: runtimeSettings.timezone || legacySettings.timezone || DEFAULT_TIMEZONE,
    filters: mergeFilters(baseFilters, overrides?.filters),
    ai: mergeAiConfig(aiConfig, overrides?.ai),
    output: mergeOutputConfig(baseOutput, overrides?.output)
  };
}

export async function assertCompanyAccess(
  uid: string,
  companyId: string
): Promise<{
  uid: string;
  role: UserRole;
  companyIds: string[];
  managedCompanyIds: string[];
}> {
  const db = admin.firestore();
  const userDoc = await db.collection('users').doc(uid).get();

  if (!userDoc.exists) {
    throw new Error('User not found');
  }

  const userData = userDoc.data() as {
    role?: UserRole;
    companyIds?: string[];
    managedCompanyIds?: string[];
    companyId?: string;
  };

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

export function getDateRangeBounds(dateRange?: RuntimeFilters['dateRange']): {
  startDate: Date | null;
  endDate: Date | null;
} {
  if (!dateRange) {
    return { startDate: null, endDate: null };
  }

  let days = 1;
  if (typeof dateRange === 'string') {
    if (dateRange === 'week') days = 7;
    else if (dateRange === 'month') days = 30;
    // 'today' is 1
  } else {
    if (dateRange.mode === 'absolute') {
      const startDate = dateRange.startDate ? new Date(dateRange.startDate) : null;
      const endDate = dateRange.endDate ? new Date(dateRange.endDate) : null;
      return {
        startDate: startDate && !isNaN(startDate.getTime()) ? startDate : null,
        endDate: endDate && !isNaN(endDate.getTime()) ? endDate : null
      };
    }
    days = Math.max(1, dateRange.days || 1);
  }

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  return { startDate, endDate };
}
