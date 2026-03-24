export type UserRole =
  | 'superadmin'
  | 'company_admin'
  | 'company_editor'
  | 'viewer';

export type OutputType =
  | 'analysis_report'
  | 'article_list'
  | 'custom_prompt';

export type AiProvider = 'glm' | 'gemini' | 'openai' | 'claude';

export interface RuntimeDateRange {
  mode?: 'relative_days' | 'absolute';
  days?: number;
  startDate?: string | null;
  endDate?: string | null;
}

export interface RuntimeFilters {
  keywords?: string[];
  mustIncludeKeywords?: string[];
  includeKeywords?: string[];
  excludeKeywords?: string[];
  sectors?: string[];
  sourceIds?: string[];
  dateRange?: RuntimeDateRange | 'today' | 'week' | 'month';
}

export interface RuntimeAiConfig {
  provider: AiProvider;
  model: string;
  filteringModel?: string;    // 필터링 전용 빠른 모델 (미설정 시 model과 동일)
  fallbackProvider?: AiProvider; // 기본 provider 실패 시 전환할 provider (429/timeout/5xx)
  fallbackModel?: string;     // fallback provider에서 사용할 모델 (미설정 시 해당 provider 기본값)
  baseUrl?: string; // ★ Custom API endpoint (e.g. z.ai)
  apiKeyEnvKey?: string;
  relevancePrompt?: string;
  analysisPrompt?: string;
  outputPrompt?: string;
  maxPendingBatch?: number;
  maxAnalysisBatch?: number;
}

export interface RuntimeOutputConfig {
  type: OutputType;
  title?: string;
  prompt?: string;
  includeArticleBody?: boolean;
  maxArticles?: number;
}

export interface CompanyRuntimeSettings {
  timezone: string;
  filters: RuntimeFilters;
  ai: RuntimeAiConfig;
  output: RuntimeOutputConfig;
}

export interface CompanyDocument {
  id: string;
  name: string;
  slug?: string;
  active?: boolean;
  createdAt?: unknown;
  settings?: Partial<CompanyRuntimeSettings>;
}

export interface RuntimePipelineConfig {
  companyId: string;
  companyName: string;
  timezone: string;
  filters: RuntimeFilters;
  ai: RuntimeAiConfig;
  output: RuntimeOutputConfig;
}

export interface PipelineInvocationOverrides {
  filters?: Partial<RuntimeFilters>;
  ai?: Partial<RuntimeAiConfig>;
  output?: Partial<RuntimeOutputConfig>;
}

// Provider-specific defaults
export const PROVIDER_DEFAULTS: Record<AiProvider, { model: string; apiKeyEnvKey: string }> = {
  glm: { model: 'glm-4', apiKeyEnvKey: 'GLM_API_KEY' },
  gemini: { model: 'gemini-2.5-flash', apiKeyEnvKey: 'GEMINI_API_KEY' },
  openai: { model: 'gpt-4o', apiKeyEnvKey: 'OPENAI_API_KEY' },
  claude: { model: 'claude-3-5-sonnet-20241022', apiKeyEnvKey: 'ANTHROPIC_API_KEY' },
};
