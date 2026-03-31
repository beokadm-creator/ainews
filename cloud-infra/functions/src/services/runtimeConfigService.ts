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

const DEFAULT_OUTPUT_CONFIG: RuntimeOutputConfig = {
  type: 'analysis_report',
  title: 'AI News Analysis Report',
  includeArticleBody: false,
  maxArticles: 50
};

const DEFAULT_TIMEZONE = 'Asia/Seoul';
const RUNTIME_CACHE_TTL_MS = 5 * 60 * 1000;

type RuntimeBaseConfig = {
  companyId: string;
  companyName: string;
  timezone: string;
  filters: RuntimeFilters;
  ai: RuntimeAiConfig;
  output: RuntimeOutputConfig;
};

const runtimeConfigCache = new Map<string, { expiresAt: number; value: RuntimeBaseConfig }>();
let cachedSystemAiConfig: { expiresAt: number; value: RuntimeAiConfig } | null = null;

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

async function loadSystemAiConfig(): Promise<RuntimeAiConfig> {
  const now = Date.now();
  if (cachedSystemAiConfig && cachedSystemAiConfig.expiresAt > now) {
    return cachedSystemAiConfig.value;
  }

  const db = admin.firestore();
  const sysDoc = await db.collection('systemSettings').doc('aiConfig').get();
  const sysSettings = (sysDoc.data() || {}) as any;
  const activeProvider: string = sysSettings['ai.provider'] || sysSettings.ai?.provider || DEFAULT_AI_CONFIG.provider;
  const aiConfig = normalizeGlmModelConfig({
    ...DEFAULT_AI_CONFIG,
    provider: activeProvider as any,
    model: sysSettings[`aiModels.${activeProvider}`] || sysSettings.ai?.model || DEFAULT_AI_CONFIG.model,
    filteringModel: sysSettings[`aiFilteringModels.${activeProvider}`] || sysSettings.aiFilteringModels?.[activeProvider] || sysSettings.ai?.filteringModel || undefined,
    fallbackProvider: (sysSettings[`aiFallbackProviders.${activeProvider}`] || sysSettings.aiFallbackProviders?.[activeProvider] || sysSettings.ai?.fallbackProvider) as AiProvider | undefined || undefined,
    fallbackModel: sysSettings[`aiFallbackModels.${activeProvider}`] || sysSettings.aiFallbackModels?.[activeProvider] || sysSettings.ai?.fallbackModel || undefined,
    baseUrl: sysSettings[`aiBaseUrls.${activeProvider}`] || sysSettings.ai?.baseUrl || null,
  });

  cachedSystemAiConfig = {
    expiresAt: now + RUNTIME_CACHE_TTL_MS,
    value: aiConfig,
  };

  return aiConfig;
}

async function loadBaseRuntimeConfig(companyId: string): Promise<RuntimeBaseConfig> {
  const db = admin.firestore();
  const [companyDoc, aiConfig, settingsDoc, subDoc] = await Promise.all([
    db.collection('companies').doc(companyId).get(),
    loadSystemAiConfig(),
    db.collection('companySettings').doc(companyId).get(),
    db.collection('companySourceSubscriptions').doc(companyId).get(),
  ]);

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

  const runtimeSettings = (settingsDoc.data() || {}) as any;
  const legacySettings = (company.settings ?? {}) as Partial<CompanyRuntimeSettings>;
  const subscribedSourceIds = runtimeSettings.filters?.sourceIds
    ?? legacySettings.filters?.sourceIds
    ?? (subDoc.exists ? ((subDoc.data() as any).subscribedSourceIds ?? []) : []);

  const baseFilters: RuntimeFilters = {
    ...DEFAULT_FILTERS,
    ...(legacySettings.filters ?? {}),
    ...(runtimeSettings.filters ?? {}),
    sourceIds: subscribedSourceIds,
  };

  const baseOutput: RuntimeOutputConfig = {
    ...DEFAULT_OUTPUT_CONFIG,
    ...(legacySettings.output ?? {}),
    ...(runtimeSettings.output ?? {}),
  };

  return {
    companyId,
    companyName: company.name,
    timezone: runtimeSettings.timezone || legacySettings.timezone || DEFAULT_TIMEZONE,
    filters: baseFilters,
    ai: aiConfig,
    output: baseOutput,
  };
}

export async function getCompanyRuntimeConfig(
  companyId: string,
  overrides?: PipelineInvocationOverrides
): Promise<RuntimePipelineConfig> {
  const now = Date.now();
  let baseConfig = runtimeConfigCache.get(companyId);

  if (!baseConfig || baseConfig.expiresAt <= now) {
    baseConfig = {
      expiresAt: now + RUNTIME_CACHE_TTL_MS,
      value: await loadBaseRuntimeConfig(companyId),
    };
    runtimeConfigCache.set(companyId, baseConfig);
  }

  return {
    companyId: baseConfig.value.companyId,
    companyName: baseConfig.value.companyName,
    timezone: baseConfig.value.timezone,
    filters: mergeFilters(baseConfig.value.filters, overrides?.filters),
    ai: mergeAiConfig(baseConfig.value.ai, overrides?.ai),
    output: mergeOutputConfig(baseConfig.value.output, overrides?.output)
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
