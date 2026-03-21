import { useState, useEffect } from 'react';
import { Key, CheckCircle2, XCircle, Loader2, Database, RefreshCw, Eye, EyeOff, ChevronDown, ChevronUp, Plus, Trash2, Mail, Filter as FilterIcons } from 'lucide-react';
import { db, functions } from '@/lib/firebase';
import { httpsCallable } from 'firebase/functions';
import { collection, query, where, getDocs, doc, updateDoc, setDoc, deleteDoc, getDoc } from 'firebase/firestore';
import { useAuthStore } from '@/store/useAuthStore';

type AiProvider = 'glm' | 'gemini' | 'openai' | 'claude';

interface ProviderInfo {
  label: string;
  modelDefault: string;
  models: string[];
  docsUrl: string;
  color: string;
  placeholder: string;
}

const PROVIDERS: Record<AiProvider, ProviderInfo> = {
  glm: {
    label: 'Zhipu GLM',
    modelDefault: 'glm-4.7',
    models: ['glm-4.7'],
    docsUrl: 'https://open.bigmodel.cn',
    color: '#6366f1',
    placeholder: 'GLM API Key (from open.bigmodel.cn)',
  },
  gemini: {
    label: 'Google Gemini',
    modelDefault: 'gemini-1.5-pro',
    models: ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-pro'],
    docsUrl: 'https://aistudio.google.com',
    color: '#4285F4',
    placeholder: 'Gemini API Key (from aistudio.google.com)',
  },
  openai: {
    label: 'OpenAI GPT',
    modelDefault: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    docsUrl: 'https://platform.openai.com',
    color: '#10A37F',
    placeholder: 'OpenAI API Key (sk-...)',
  },
  claude: {
    label: 'Anthropic Claude',
    modelDefault: 'claude-3-5-sonnet-20241022',
    models: ['claude-3-5-sonnet-20241022', 'claude-3-opus-20240229', 'claude-3-haiku-20240307'],
    docsUrl: 'https://console.anthropic.com',
    color: '#cc785c',
    placeholder: 'Anthropic API Key (sk-ant-...)',
  },
};

interface ProviderStatus {
  hasKey: boolean;
  testing: boolean;
  testResult: { success: boolean; message: string; latencyMs?: number } | null;
  saving: boolean;
  showKey: boolean;
  expanded: boolean;
  apiKeyInput: string;
  baseUrlInput: string; // ★ New: Base URL input
  selectedModel: string;
}

function initialProviderStatus(modelDefault: string): ProviderStatus {
  return { 
    hasKey: false, 
    testing: false, 
    testResult: null, 
    saving: false, 
    showKey: false, 
    expanded: false, 
    apiKeyInput: '', 
    baseUrlInput: '', // ★ Initial value
    selectedModel: modelDefault 
  };
}

export default function Settings() {
  const { user } = useAuthStore();
  const companyId = (user as any)?.primaryCompanyId || null;
  const userRole = (user as any)?.role;
  const canEdit = userRole === 'superadmin' || userRole === 'company_admin';

  const [loading, setLoading] = useState(true);
  const [providerState, setProviderState] = useState<Record<AiProvider, ProviderStatus>>({
    glm: initialProviderStatus(PROVIDERS.glm.modelDefault),
    gemini: initialProviderStatus(PROVIDERS.gemini.modelDefault),
    openai: initialProviderStatus(PROVIDERS.openai.modelDefault),
    claude: initialProviderStatus(PROVIDERS.claude.modelDefault),
  });

  // Sources state
  const [sources, setSources] = useState<any[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);

  // Subscribers state
  const [subscriberEmails, setSubscriberEmails] = useState<string[]>([]);
  const [newEmail, setNewEmail] = useState('');
  const [savingSubscribers, setSavingSubscribers] = useState(false);

  // Pipeline Settings state
  const [filters, setFilters] = useState<any>({
    mustIncludeKeywords: [],
    includeKeywords: [],
    excludeKeywords: [],
    sectors: [],
    dateRange: 'today', // today, week, month
  });
  const [outputConfig, setOutputConfig] = useState<any>({
    title: 'AI News Analysis Report',
    maxArticles: 50,
  });
  const [savingPipeline, setSavingPipeline] = useState(false);

  useEffect(() => {
    if (companyId) {
      loadCompanySettings();
      loadSources();
    } else {
      setLoading(false);
    }
  }, [companyId]);

  const loadCompanySettings = async () => {
    setLoading(true);
    try {
      const settingsDoc = await getDoc(doc(db, 'companySettings', companyId));
      if (settingsDoc.exists()) {
        const data = settingsDoc.data() as any;
        const storedKeys = data.apiKeys || {};
        const storedModels = data.aiModels || {};
        const storedBaseUrls = data.aiBaseUrls || {}; // ★ Load custom URLs
        const emails = data.subscriberEmails || [];
        setSubscriberEmails(emails);
        
        if (data.filters) setFilters(data.filters);
        if (data.output) setOutputConfig(data.output);

        setProviderState(prev => {
          const updated = { ...prev };
          (Object.keys(PROVIDERS) as AiProvider[]).forEach(p => {
            updated[p] = {
              ...updated[p],
              hasKey: !!storedKeys[p],
              selectedModel: storedModels[p] || PROVIDERS[p].modelDefault,
              baseUrlInput: storedBaseUrls[p] || '', // ★ Load to input
            };
          });
          return updated;
        });
      }
    } catch (err) {
      console.error('Failed to load company settings:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadSources = async () => {
    if (!companyId) return;
    setSourcesLoading(true);
    try {
      const q = query(collection(db, 'sources'), where('companyId', '==', companyId));
      const snap = await getDocs(q);
      setSources(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
      console.error('Failed to load sources:', err);
    } finally {
      setSourcesLoading(false);
    }
  };

  const updateProvider = (provider: AiProvider, updates: Partial<ProviderStatus>) => {
    setProviderState(prev => ({ ...prev, [provider]: { ...prev[provider], ...updates } }));
  };

  const handleSaveApiKey = async (provider: AiProvider) => {
    const state = providerState[provider];
    if (!companyId) return;

    // API 키 입력이 있어야 저장 (baseUrl/model은 항상 같이 저장됨)
    if (!state.apiKeyInput.trim() && !state.hasKey) return;

    updateProvider(provider, { saving: true, testResult: null });
    try {
      const saveFn = httpsCallable(functions, 'saveAiApiKey');
      await saveFn({
        companyId,
        provider,
        apiKey: state.apiKeyInput.trim() || null,
        baseUrl: state.baseUrlInput.trim() || null,
        model: state.selectedModel
      });

      updateProvider(provider, { saving: false, hasKey: true, apiKeyInput: '', showKey: false });
    } catch (err: any) {
      updateProvider(provider, { saving: false, testResult: { success: false, message: err.message } });
    }
  };

  const handleTestConnection = async (provider: AiProvider) => {
    if (!companyId) return;
    updateProvider(provider, { testing: true, testResult: null });
    try {
      const testFn = httpsCallable(functions, 'testAiConnection');
      const result = await testFn({ 
        companyId, 
        provider, 
        model: providerState[provider].selectedModel,
        baseUrl: providerState[provider].baseUrlInput.trim() || null // ★ Pass for test
      }) as any;
      updateProvider(provider, { testing: false, testResult: result.data });
    } catch (err: any) {
      updateProvider(provider, { testing: false, testResult: { success: false, message: err.message } });
    }
  };

  const handleSaveSubscribers = async () => {
    if (!companyId) return;
    setSavingSubscribers(true);
    try {
      await setDoc(
        doc(db, 'companySettings', companyId),
        { subscriberEmails },
        { merge: true }
      );
    } catch (err: any) {
      alert('Failed to save: ' + err.message);
    } finally {
      setSavingSubscribers(false);
    }
  };

  const handleSavePipelineSettings = async () => {
    if (!companyId) return;
    setSavingPipeline(true);
    try {
      const updateFn = httpsCallable(functions, 'updateCompanySettings');
      await updateFn({
        companyId,
        filters,
        output: outputConfig
      });
    } catch (err: any) {
      console.error('Failed to save pipeline settings:', err);
    } finally {
      setSavingPipeline(false);
    }
  };

  const toggleSourceActive = async (id: string, currentStatus: boolean) => {
    try {
      await updateDoc(doc(db, 'sources', id), { active: !currentStatus });
      setSources(prev => prev.map(s => s.id === id ? { ...s, active: !currentStatus } : s));
    } catch (err) {
      console.error('Failed to toggle source:', err);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-[#1e3a5f]" />
      </div>
    );
  }

  if (!companyId) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-12 text-center text-gray-500">
        <p>No company assigned. Contact your superadmin to be assigned to a company.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Settings</h1>
        <p className="text-gray-600 dark:text-gray-400 mt-1">
          Manage AI providers, news sources, and email subscribers for your company.
        </p>
      </div>

      {/* ─── AI Provider Management ─── */}
      <section className="space-y-4">
        <div className="flex items-center gap-2 mb-2">
          <Key className="w-5 h-5 text-[#1e3a5f] dark:text-blue-400" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">AI Provider API Keys</h2>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 -mt-2">
          API keys are stored securely on the server. Once saved, the key value is not shown again. Click "Test" to verify connectivity.
        </p>

        {(Object.keys(PROVIDERS) as AiProvider[]).map(provider => {
          const info = PROVIDERS[provider];
          const state = providerState[provider];
          return (
            <div key={provider} className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
              {/* Header */}
              <button
                className="w-full flex items-center justify-between px-6 py-4 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                onClick={() => updateProvider(provider, { expanded: !state.expanded })}
              >
                <div className="flex items-center gap-3">
                  <span
                    className="w-3 h-3 rounded-full flex-shrink-0"
                    style={{ backgroundColor: info.color }}
                  />
                  <span className="font-semibold text-gray-900 dark:text-white">{info.label}</span>
                  {state.hasKey && (
                    <span className="flex items-center text-xs text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 px-2 py-0.5 rounded-full">
                      <CheckCircle2 className="w-3 h-3 mr-1" />Key saved
                    </span>
                  )}
                  {!state.hasKey && (
                    <span className="text-xs text-gray-400 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded-full">
                      Not configured
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {/* Test button (quick access) */}
                  {state.hasKey && (
                    <button
                      onClick={e => { e.stopPropagation(); handleTestConnection(provider); }}
                      disabled={state.testing}
                      className="flex items-center px-3 py-1.5 text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50"
                    >
                      {state.testing
                        ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" />Testing...</>
                        : <><RefreshCw className="w-3 h-3 mr-1" />Test</>
                      }
                    </button>
                  )}
                  {state.expanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                </div>
              </button>

              {/* Test result banner */}
              {state.testResult && (
                <div className={`px-6 py-2 text-sm flex items-center gap-2 ${
                  state.testResult.success
                    ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400'
                    : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'
                }`}>
                  {state.testResult.success
                    ? <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                    : <XCircle className="w-4 h-4 flex-shrink-0" />}
                  {state.testResult.message}
                  {state.testResult.latencyMs && (
                    <span className="ml-auto text-xs opacity-70">{state.testResult.latencyMs}ms</span>
                  )}
                </div>
              )}

              {/* Expanded body */}
              {state.expanded && (
                <div className="px-6 pb-6 pt-2 space-y-4 border-t border-gray-100 dark:border-gray-700">
                  {/* Model selection */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1.5">
                        Model Name
                      </label>
                      <div className="flex gap-2">
                        <select
                          value={info.models.includes(state.selectedModel) ? state.selectedModel : 'custom'}
                          onChange={e => {
                            if (e.target.value === 'custom') {
                              // keep current for editing
                            } else {
                              updateProvider(provider, { selectedModel: e.target.value });
                            }
                          }}
                          disabled={!canEdit}
                          className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-[#1e3a5f]"
                        >
                          {info.models.map(m => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                          <option value="custom">Other (Manual Input)</option>
                        </select>
                        {(!info.models.includes(state.selectedModel) || state.selectedModel === 'custom') && (
                          <input
                            type="text"
                            value={state.selectedModel === 'custom' ? '' : state.selectedModel}
                            onChange={e => updateProvider(provider, { selectedModel: e.target.value })}
                            placeholder="e.g. glm-4.7"
                            className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-[#1e3a5f]"
                          />
                        )}
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1.5">
                        API Endpoint (Select or Custom)
                      </label>
                      <div className="space-y-2">
                        {info.label === 'Zhipu GLM' && (
                          <div className="flex flex-wrap gap-2 mb-2">
                            {[
                              { label: 'GLM v4 API', url: 'https://api.z.ai/api/paas/v4' },
                              { label: 'Coding Plan', url: 'https://api.z.ai/api/coding/paas/v4' },
                            ].map(opt => (
                              <button
                                key={opt.url}
                                onClick={() => updateProvider(provider, { baseUrlInput: opt.url })}
                                className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                                  state.baseUrlInput.includes(opt.url)
                                    ? 'bg-[#1e3a5f] text-white border-[#1e3a5f]'
                                    : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-gray-200 dark:border-gray-700 hover:bg-gray-50'
                                }`}
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        )}
                        <input
                          type="text"
                          value={state.baseUrlInput}
                          onChange={e => updateProvider(provider, { baseUrlInput: e.target.value })}
                          placeholder={info.label === 'Zhipu GLM' ? 'Enter endpoint URL' : 'Default endpoint'}
                          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-[#1e3a5f]"
                        />
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-gray-400">
                    Get API key at <a href={info.docsUrl} target="_blank" rel="noreferrer" className="text-[#1e3a5f] dark:text-blue-400 hover:underline">{info.docsUrl}</a>
                  </p>

                  {/* API Key input */}
                  {canEdit && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                        {state.hasKey ? 'Replace API Key' : 'API Key'}
                      </label>
                      <div className="flex gap-2">
                        <div className="relative flex-1">
                          <input
                            type={state.showKey ? 'text' : 'password'}
                            value={state.apiKeyInput}
                            onChange={e => updateProvider(provider, { apiKeyInput: e.target.value })}
                            placeholder={info.placeholder}
                            className="w-full px-3 py-2 pr-10 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-[#1e3a5f]"
                          />
                          <button
                            type="button"
                            onClick={() => updateProvider(provider, { showKey: !state.showKey })}
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                          >
                            {state.showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                        <button
                          onClick={() => handleSaveApiKey(provider)}
                          disabled={state.saving || (!state.apiKeyInput.trim() && !state.hasKey)}
                          className="flex items-center px-4 py-2 bg-[#1e3a5f] text-white rounded-lg text-sm font-medium hover:bg-[#2a4a73] transition-colors disabled:opacity-50 whitespace-nowrap"
                        >
                          {state.saving ? <Loader2 className="w-4 h-4 animate-spin" /> : (state.hasKey ? '설정 저장' : 'API 키 저장')}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Test button (in expanded view) */}
                  <button
                    onClick={() => handleTestConnection(provider)}
                    disabled={state.testing || !state.hasKey}
                    className="flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-lg text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-40"
                  >
                    {state.testing
                      ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Testing Connection...</>
                      : <><RefreshCw className="w-4 h-4 mr-2" />Test Connection</>
                    }
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </section>

      {/* ─── Pipeline Filtering & Output ─── */}
      <section className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FilterIcons className="w-5 h-5 text-[#1e3a5f] dark:text-blue-400" />
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Pipeline Filtering & Rules</h2>
          </div>
          <button
            onClick={handleSavePipelineSettings}
            disabled={savingPipeline || !canEdit}
            className="flex items-center px-4 py-1.5 bg-[#1e3a5f] text-white rounded-lg text-sm font-medium hover:bg-[#2a4a73] transition-colors disabled:opacity-50"
          >
            {savingPipeline ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
            Save Rules
          </button>
        </div>
        <div className="bg-blue-50/50 dark:bg-blue-900/10 px-6 py-3 border-b border-gray-100 dark:border-gray-700 text-sm text-gray-600 dark:text-gray-400 flex items-start gap-2">
          <Database className="w-4 h-4 mt-0.5 text-blue-500 flex-shrink-0" />
          <p>
            분석 기간을 선택하고 키워드를 구체적으로 입력할수록 더 정밀하고 관련된 분석 결과를 얻을 수 있습니다. 
            <strong> AND(필수)</strong> 키워드는 반드시 포함되어야 하며, <strong> OR(선택)</strong> 키워드는 하나라도 포함되면 수집됩니다.
          </p>
        </div>
        <div className="p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">분석 기간 (Date Range)</label>
                <div className="flex gap-2 mb-4">
                  <select
                    value={filters.dateRange || 'today'}
                    onChange={e => setFilters((p: any) => ({ ...p, dateRange: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm outline-none bg-white dark:bg-gray-700 dark:text-white"
                  >
                    <option value="today">당일 (Today)</option>
                    <option value="week">1주일 (Last 7 Days)</option>
                    <option value="month">1개월 (Last 30 Days)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 text-blue-600">AND Keywords (필수 포함)</label>
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    placeholder="e.g. 인수, 합병"
                    className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm outline-none bg-white dark:bg-gray-700 dark:text-white"
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        const val = (e.target as any).value.trim();
                        if (val) {
                          setFilters((prev: any) => ({ ...prev, mustIncludeKeywords: [...(prev.mustIncludeKeywords || []), val] }));
                          (e.target as any).value = '';
                        }
                      }
                    }}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  {(filters.mustIncludeKeywords || []).map((kw: string, i: number) => (
                    <span key={i} className="inline-flex items-center px-2 py-1 bg-blue-50 text-blue-700 border border-blue-200 rounded text-xs">
                      {kw}
                      <button onClick={() => setFilters((p: any) => ({ ...p, mustIncludeKeywords: p.mustIncludeKeywords.filter((_: any, idx: number) => idx !== i) }))} className="ml-1 hover:text-blue-900">×</button>
                    </span>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">OR Keywords (선택 포함)</label>
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    placeholder="e.g. M&A"
                    className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm outline-none focus:ring-2 focus:ring-[#1e3a5f] dark:bg-gray-700 dark:text-white"
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        const val = (e.target as any).value.trim();
                        if (val) {
                          setFilters((prev: any) => ({ ...prev, includeKeywords: [...(prev.includeKeywords || []), val] }));
                          (e.target as any).value = '';
                        }
                      }
                    }}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  {(filters.includeKeywords || []).map((kw: string, i: number) => (
                    <span key={i} className="inline-flex items-center px-2 py-1 bg-green-50 text-green-700 border border-green-200 rounded text-xs">
                      {kw}
                      <button onClick={() => setFilters((p: any) => ({ ...p, includeKeywords: p.includeKeywords.filter((_: any, idx: number) => idx !== i) }))} className="ml-1 hover:text-green-900">×</button>
                    </span>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 text-red-600">NOT Keywords (제외)</label>
                <input
                  type="text"
                  placeholder="e.g. 채용, 웨비나"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm outline-none focus:ring-2 focus:ring-red-500 dark:bg-gray-700 dark:text-white"
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      const val = (e.target as any).value.trim();
                      if (val) {
                        setFilters((prev: any) => ({ ...prev, excludeKeywords: [...(prev.excludeKeywords || []), val] }));
                        (e.target as any).value = '';
                      }
                    }
                  }}
                />
                <div className="flex flex-wrap gap-2 mt-2">
                  {(filters.excludeKeywords || []).map((kw: string, i: number) => (
                    <span key={i} className="inline-flex items-center px-2 py-1 bg-red-50 text-red-700 border border-red-200 rounded text-xs">
                      {kw}
                      <button onClick={() => setFilters((p: any) => ({ ...p, excludeKeywords: p.excludeKeywords.filter((_: any, idx: number) => idx !== i) }))} className="ml-1 hover:text-red-900">×</button>
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Target Sectors</label>
                <div className="grid grid-cols-2 gap-2">
                  {['M&A', 'PEF', 'VC', 'IPO', 'Investment', 'Real Estate'].map(sector => (
                    <label key={sector} className="flex items-center gap-2 text-sm p-2 border border-gray-100 dark:border-gray-700 rounded-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700">
                      <input
                        type="checkbox"
                        className="rounded border-gray-300 text-[#1e3a5f]"
                        checked={(filters.sectors || []).includes(sector)}
                        onChange={e => {
                          const checked = e.target.checked;
                          setFilters((prev: any) => ({
                            ...prev,
                            sectors: checked
                              ? [...(prev.sectors || []), sector]
                              : (prev.sectors || []).filter((s: string) => s !== sector)
                          }));
                        }}
                      />
                      <span className="text-gray-700 dark:text-gray-300">{sector}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Output Report Title</label>
                <input
                  type="text"
                  value={outputConfig.title || ''}
                  onChange={e => setOutputConfig((p: any) => ({ ...p, title: e.target.value }))}
                  placeholder="e.g. Daily Deal Analysis"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm outline-none focus:ring-2 focus:ring-[#1e3a5f] dark:bg-gray-700 dark:text-white"
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─── Email Subscribers ─── */}
      <section className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Mail className="w-5 h-5 text-[#1e3a5f] dark:text-blue-400" />
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Email Subscribers</h2>
          </div>
          <button
            onClick={handleSaveSubscribers}
            disabled={savingSubscribers || !canEdit}
            className="flex items-center px-4 py-1.5 bg-[#1e3a5f] text-white rounded-lg text-sm font-medium hover:bg-[#2a4a73] transition-colors disabled:opacity-50"
          >
            {savingSubscribers ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
            Save
          </button>
        </div>
        <div className="p-6 space-y-3">
          {subscriberEmails.map((email, idx) => (
            <div key={idx} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
              <span className="text-sm text-gray-800 dark:text-gray-200">{email}</span>
              {canEdit && (
                <button
                  onClick={() => setSubscriberEmails(prev => prev.filter((_, i) => i !== idx))}
                  className="text-gray-400 hover:text-red-500 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
          {canEdit && (
            <form
              onSubmit={e => {
                e.preventDefault();
                if (newEmail.trim() && !subscriberEmails.includes(newEmail.trim())) {
                  setSubscriberEmails(prev => [...prev, newEmail.trim()]);
                  setNewEmail('');
                }
              }}
              className="flex gap-2"
            >
              <input
                type="email"
                value={newEmail}
                onChange={e => setNewEmail(e.target.value)}
                placeholder="Add subscriber email..."
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-[#1e3a5f]"
              />
              <button
                type="submit"
                className="flex items-center px-3 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-lg text-sm hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
              >
                <Plus className="w-4 h-4 mr-1" />Add
              </button>
            </form>
          )}
          {subscriberEmails.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-2">No subscribers configured.</p>
          )}
        </div>
      </section>

      {/* ─── News Source Management ─── */}
      <section className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Database className="w-5 h-5 text-[#1e3a5f] dark:text-blue-400" />
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">News Sources</h2>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs bg-[#1e3a5f] text-white px-2.5 py-1 rounded-full">{sources.length} sources</span>
            <button
              onClick={loadSources}
              disabled={sourcesLoading}
              className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${sourcesLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          {sources.length === 0 ? (
            <div className="px-6 py-8 text-center text-gray-400 text-sm">
              No sources configured for this company.
            </div>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-600">
                <tr>
                  <th className="px-6 py-3 font-medium text-gray-500 dark:text-gray-400">Source</th>
                  <th className="px-6 py-3 font-medium text-gray-500 dark:text-gray-400">Type</th>
                  <th className="px-6 py-3 font-medium text-gray-500 dark:text-gray-400">URL / Note</th>
                  <th className="px-6 py-3 font-medium text-gray-500 dark:text-gray-400">Last Run</th>
                  <th className="px-6 py-3 font-medium text-gray-500 dark:text-gray-400 text-right">Active</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {sources.map(source => (
                  <tr key={source.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                    <td className="px-6 py-4 font-medium text-gray-900 dark:text-white">{source.name}</td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        source.type === 'rss' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300' :
                        source.type === 'puppeteer' ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300' :
                        'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                      }`}>
                        {(source.type || '').toUpperCase()}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-gray-500 dark:text-gray-400 max-w-xs truncate" title={source.note || source.url}>
                      {source.note || source.url}
                    </td>
                    <td className="px-6 py-4 text-gray-500 dark:text-gray-400 text-xs">
                      {source.lastScrapedAt?.toDate
                        ? source.lastScrapedAt.toDate().toLocaleString('ko-KR')
                        : 'Never'}
                      {source.lastStatus === 'error' && (
                        <span className="ml-1 text-red-500">⚠</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          className="sr-only peer"
                          checked={!!source.active}
                          disabled={!canEdit}
                          onChange={() => toggleSourceActive(source.id, source.active)}
                        />
                        <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-[#d4af37]" />
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
