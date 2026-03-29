import * as admin from 'firebase-admin';
import {
  AiProvider,
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
  dateRange: 'week'
};

const DEFAULT_AI_CONFIG: RuntimeAiConfig = {
  provider: 'glm',
  model: 'glm-4.7',
  apiKeyEnvKey: 'GLM_API_KEY',
  maxPendingBatch: 60,
  maxAnalysisBatch: 24,
};

function normalizeGlmModelConfig(aiConfig: RuntimeAiConfig): RuntimeAiConfig {
  if (aiConfig.provider !== 'glm') {
    return aiConfig;
  }

  const normalizedModel = aiConfig.model || DEFAULT_AI_CONFIG.model;
  const normalizedFilteringModel = aiConfig.filteringModel === 'glm-4-plus'
    ? normalizedModel
    : (aiConfig.filteringModel || normalizedModel);

  return {
    ...aiConfig,
    model: normalizedModel,
    filteringModel: normalizedFilteringModel,
    fallbackProvider: undefined,
    fallbackModel: undefined,
  };
}

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
  return normalizeGlmModelConfig({
    ...base,
    ...override
  });
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

  // ── AI Config: 항상 systemSettings(superadmin)에서 로드
  const sysDoc = await db.collection('systemSettings').doc('aiConfig').get();
  const sysSettings = (sysDoc.data() || {}) as any;
  const activeProvider: string = sysSettings['ai.provider'] || sysSettings.ai?.provider || DEFAULT_AI_CONFIG.provider;
  const aiConfig: RuntimeAiConfig = {
    ...DEFAULT_AI_CONFIG,
    provider: activeProvider as any,
    model: sysSettings[`aiModels.${activeProvider}`] || sysSettings.ai?.model || DEFAULT_AI_CONFIG.model,
    filteringModel: sysSettings[`aiFilteringModels.${activeProvider}`] || sysSettings.aiFilteringModels?.[activeProvider] || sysSettings.ai?.filteringModel || undefined,
    fallbackProvider: (sysSettings[`aiFallbackProviders.${activeProvider}`] || sysSettings.aiFallbackProviders?.[activeProvider] || sysSettings.ai?.fallbackProvider) as AiProvider | undefined || undefined,
    fallbackModel: sysSettings[`aiFallbackModels.${activeProvider}`] || sysSettings.aiFallbackModels?.[activeProvider] || sysSettings.ai?.fallbackModel || undefined,
    baseUrl: sysSettings[`aiBaseUrls.${activeProvider}`] || sysSettings.ai?.baseUrl || null,
  };

  // ── 회사별 설정 (필터, 출력 등)은 companySettings에서 로드
  const settingsDoc = await db.collection('companySettings').doc(companyId).get();
  const runtimeSettings = (settingsDoc.data() || {}) as any;
  const legacySettings = (company.settings ?? {}) as Partial<CompanyRuntimeSettings>;

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
    ai: mergeAiConfig(normalizeGlmModelConfig(aiConfig), overrides?.ai),
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

  // 회사 액세스 확인 (superadmin 아닌 경우)
  const canAccess = companyIds.includes(companyId) || managedCompanyIds.includes(companyId);
  if (!canAccess) {
    throw new Error(`User does not belong to company ${companyId}`);
  }

  // AI 설정 저장은 company_admin만 가능 (editor는 불가)
  // 파이프라인 실행은 company_admin, company_editor 모두 가능

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
