import { useState, useEffect } from 'react';
import {
  Key, CheckCircle2, XCircle, Loader2, RefreshCw, Eye, EyeOff,
  ChevronDown, ChevronUp, Zap, FileText, RotateCcw, Save
} from 'lucide-react';
import { db, functions } from '@/lib/firebase';
import { httpsCallable } from 'firebase/functions';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { useAuthStore } from '@/store/useAuthStore';

// ─── Types ──────────────────────────────────────────────────────
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
    models: ['glm-4.7', 'glm-4-plus', 'glm-4-flash', 'glm-4'],
    docsUrl: 'https://open.bigmodel.cn',
    color: '#6366f1',
    placeholder: 'GLM API Key (from open.bigmodel.cn)',
  },
  gemini: {
    label: 'Google Gemini',
    modelDefault: 'gemini-2.5-flash',
    models: [
      'gemini-2.5-pro',         // 최고 성능 · 딥분석용
      'gemini-2.5-flash',       // 빠름+성능 균형 · 분석 권장
      'gemini-2.5-flash-lite',  // 가장 빠름·저렴 · 필터링 권장
    ],
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
    modelDefault: 'claude-sonnet-4-6',
    models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
    docsUrl: 'https://console.anthropic.com',
    color: '#cc785c',
    placeholder: 'Anthropic API Key (sk-ant-...)',
  },
};

interface ProviderState {
  hasKey: boolean;
  isActive: boolean;
  testing: boolean;
  testResult: { success: boolean; message: string; latencyMs?: number } | null;
  saving: boolean;
  showKey: boolean;
  expanded: boolean;
  apiKeyInput: string;
  baseUrlInput: string;
  selectedModel: string;
  selectedFilteringModel: string; // 필터링 전용 모델
  selectedFallbackProvider: AiProvider | '';  // 병목 시 전환할 provider
  selectedFallbackModel: string;              // fallback provider 모델
}

function initState(modelDefault: string): ProviderState {
  return { hasKey: false, isActive: false, testing: false, testResult: null, saving: false, showKey: false, expanded: false, apiKeyInput: '', baseUrlInput: '', selectedModel: modelDefault, selectedFilteringModel: '', selectedFallbackProvider: '', selectedFallbackModel: '' };
}

// ─── Default prompts (mirrors backend DEFAULT_RELEVANCE_PROMPT / DEFAULT_ANALYSIS_PROMPT)
const DEFAULT_RELEVANCE_PROMPT = `당신은 M&A, 사모펀드(PEF), 벤처캐피털, 전략적 투자 분야의 전문 애널리스트입니다.

아래 기사가 투자 모니터링 워크플로우에 관련된 기사인지 판단하세요.

관련 있는 기사 예시:
- 인수합병(M&A), 경영권 인수, 공개매수
- 지분 매각, 사업부 분리매각(carve-out), 분할
- 사모펀드(PEF) 딜, 바이아웃, 펀드 결성/청산
- 벤처캐피털 투자유치, 시리즈 투자
- 전략적 투자자(SI), 재무적 투자자(FI) 참여
- IPO, 상장, 블록딜
- 인수금융, 리파이낸싱, 구조조정, MBO

출력 형식 (반드시 아래 형식 그대로 출력):
RELEVANT: YES or NO
CONFIDENCE: 0.0~1.0 사이의 숫자
REASON: 한 문장으로 판단 근거 (한국어로 작성)`;

const DEFAULT_ANALYSIS_PROMPT = `당신은 뉴스 기사에서 투자 정보를 구조화하여 추출하는 전문 애널리스트입니다.

모든 출력값(summary, category, insights, tags)은 반드시 자연스러운 한국어로 작성하세요.
기업명·펀드명 등 고유명사는 한국어 표기를 우선하되, 필요 시 영문을 괄호로 병기하세요. (예: 카카오(Kakao))

아래 JSON 형식만 반환하세요 (다른 텍스트 없이):
{
  "companies": {
    "acquiror": "인수자 (없으면 null)",
    "target": "피인수 대상 (없으면 null)",
    "financialSponsor": "재무적 투자자/PE (없으면 null)"
  },
  "deal": {
    "type": "딜 유형 (예: 인수합병, 지분투자, IPO 등)",
    "amount": "거래 금액 (예: 3,000억원, 미공개)",
    "stake": "지분율 (없으면 null)"
  },
  "summary": ["핵심 내용 1", "핵심 내용 2", "핵심 내용 3"],
  "category": "카테고리 (예: M&A, 사모펀드, 벤처투자, IPO 등)",
  "insights": "투자자 관점에서의 시사점 및 분석 (없으면 null)",
  "tags": ["태그1", "태그2", "태그3"]
}`;

// ─── Main Component ─────────────────────────────────────────────
export default function AdminSettings() {
  const { user } = useAuthStore();
  const companyId = (user as any)?.primaryCompanyId || null;

  const [loading, setLoading] = useState(true);

  // Prompt config state
  const [relevancePrompt, setRelevancePrompt] = useState('');
  const [analysisPrompt, setAnalysisPrompt] = useState('');
  const [promptSaving, setPromptSaving] = useState(false);
  const [promptSaveResult, setPromptSaveResult] = useState<{ success: boolean; message: string } | null>(null);

  // Naver News API credentials
  const [naverClientId, setNaverClientId] = useState('');
  const [naverClientSecret, setNaverClientSecret] = useState('');
  const [naverHasConfig, setNaverHasConfig] = useState(false);
  const [naverSaving, setNaverSaving] = useState(false);
  const [naverShowSecret, setNaverShowSecret] = useState(false);

  const [providerState, setProviderState] = useState<Record<AiProvider, ProviderState>>({
    glm: initState(PROVIDERS.glm.modelDefault),
    gemini: initState(PROVIDERS.gemini.modelDefault),
    openai: initState(PROVIDERS.openai.modelDefault),
    claude: initState(PROVIDERS.claude.modelDefault),
  });

  // ─── Load settings ─────────────────────────────────────────
  useEffect(() => {
    if (!companyId) { setLoading(false); return; }
    const load = async () => {
      try {
        // Try systemSettings first (superadmin global), fall back to companySettings
        const [sysDoc, compDoc, naverDoc, promptDoc] = await Promise.all([
          getDoc(doc(db, 'systemSettings', 'aiConfig')),
          getDoc(doc(db, 'companySettings', companyId)),
          getDoc(doc(db, 'systemSettings', 'naverConfig')),
          getDoc(doc(db, 'systemSettings', 'promptConfig')),
        ]);
        // Load custom prompts (empty string = using default)
        const pd = promptDoc.exists() ? promptDoc.data() as any : {};
        setRelevancePrompt(pd.relevancePrompt || '');
        setAnalysisPrompt(pd.analysisPrompt || '');
        if (naverDoc.exists()) {
          const nd = naverDoc.data() as any;
          setNaverHasConfig(!!(nd.clientId && nd.clientSecret));
        }
        const sysData = sysDoc.exists() ? sysDoc.data() as any : {};
        const compData = compDoc.exists() ? compDoc.data() as any : {};
        const storedKeys = compData.apiKeys || sysData.apiKeys || {};
        const storedModels = { ...sysData['aiModels'], ...compData.aiModels };
        const storedFilteringModels = { ...sysData['aiFilteringModels'], ...compData.aiFilteringModels };
        const storedFallbackProviders = { ...sysData['aiFallbackProviders'], ...compData.aiFallbackProviders };
        const storedFallbackModels = { ...sysData['aiFallbackModels'], ...compData.aiFallbackModels };
        const storedBaseUrls = { ...sysData['aiBaseUrls'], ...compData.aiBaseUrls };
        const activeProvider = compData.ai?.provider || sysData.ai?.provider || 'glm';

        setProviderState(prev => {
          const updated = { ...prev };
          (Object.keys(PROVIDERS) as AiProvider[]).forEach(p => {
            updated[p] = {
              ...updated[p],
              hasKey: !!storedKeys[p],
              isActive: p === activeProvider,
              selectedModel: storedModels[p] || PROVIDERS[p].modelDefault,
              selectedFilteringModel: storedFilteringModels[p] || '',
              selectedFallbackProvider: (storedFallbackProviders[p] || '') as AiProvider | '',
              selectedFallbackModel: storedFallbackModels[p] || '',
              baseUrlInput: storedBaseUrls[p] || ''
            };
          });
          return updated;
        });
      } catch (err) {
        console.error('Failed to load AI settings:', err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [companyId]);

  const update = (p: AiProvider, u: Partial<ProviderState>) =>
    setProviderState(prev => ({ ...prev, [p]: { ...prev[p], ...u } }));

  // ─── Save prompt config ─────────────────────────────────────
  const handleSavePrompts = async () => {
    setPromptSaving(true);
    setPromptSaveResult(null);
    try {
      const fn = httpsCallable(functions, 'savePromptConfig');
      await fn({ relevancePrompt: relevancePrompt || null, analysisPrompt: analysisPrompt || null });
      setPromptSaveResult({ success: true, message: '프롬프트 설정이 저장됐습니다.' });
    } catch (err: any) {
      setPromptSaveResult({ success: false, message: err.message });
    } finally {
      setPromptSaving(false);
    }
  };

  // ─── Save key ──────────────────────────────────────────────
  const handleSave = async (provider: AiProvider) => {
    console.log('handleSave called, companyId:', companyId, 'user:', (user as any)?.uid, 'role:', (user as any)?.role);
    if (!companyId) {
      alert('companyId가 없습니다. 사용자 설정을 확인하세요.');
      return;
    }
    const state = providerState[provider];
    if (!state.apiKeyInput.trim() && !state.hasKey) return;
    update(provider, { saving: true, testResult: null });
    try {
      const fn = httpsCallable(functions, 'saveAiApiKey');
      const result = await fn({
        companyId,
        provider,
        apiKey: state.apiKeyInput.trim() || null,
        baseUrl: state.baseUrlInput.trim() || null,
        model: state.selectedModel,
        filteringModel: state.selectedFilteringModel || null,
        fallbackProvider: state.selectedFallbackProvider || null,
        fallbackModel: state.selectedFallbackModel || null,
        setAsActive: state.isActive,
      }) as any;
      console.log(`✅ Saved ${provider}:`, result.data);
      update(provider, { saving: false, hasKey: true, apiKeyInput: '', showKey: false });
    } catch (err: any) {
      console.error(`❌ Save error for ${provider}:`, {
        message: err.message,
        code: err.code,
        details: err.details,
        fullError: err
      });
      update(provider, { saving: false, testResult: { success: false, message: `에러: ${err.code || 'unknown'} - ${err.message}` } });
    }
  };

  // ─── Toggle active provider ─────────────────────────────────
  const handleToggleActive = (provider: AiProvider) => {
    setProviderState(prev => {
      const updated = { ...prev };
      (Object.keys(PROVIDERS) as AiProvider[]).forEach(p => {
        updated[p] = { ...updated[p], isActive: p === provider };
      });
      return updated;
    });
  };

  // ─── Test connection ───────────────────────────────────────
  const handleTest = async (provider: AiProvider) => {
    if (!companyId) return;
    update(provider, { testing: true, testResult: null });
    try {
      const fn = httpsCallable(functions, 'testAiConnection');
      const result = await fn({ companyId, provider, model: providerState[provider].selectedModel, baseUrl: providerState[provider].baseUrlInput.trim() || null }) as any;
      update(provider, { testing: false, testResult: result.data });
    } catch (err: any) {
      update(provider, { testing: false, testResult: { success: false, message: err.message } });
    }
  };

  const handleSaveNaver = async () => {
    if (!naverClientId.trim() || !naverClientSecret.trim()) return;
    setNaverSaving(true);
    try {
      await setDoc(doc(db, 'systemSettings', 'naverConfig'), {
        clientId: naverClientId.trim(),
        clientSecret: naverClientSecret.trim(),
        updatedAt: new Date(),
      });
      setNaverHasConfig(true);
      setNaverClientId('');
      setNaverClientSecret('');
    } catch (err: any) {
      alert('저장 실패: ' + err.message);
    } finally {
      setNaverSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-blue-400" /></div>;
  }

  return (
    <div className="space-y-5 max-w-3xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">AI 설정</h1>
        <p className="text-white/40 text-sm mt-0.5">글로벌 AI 프로바이더 API 키를 관리합니다. 저장 시 전체 시스템에 적용됩니다.</p>
      </div>

      {/* Info banner */}
      <div className="flex items-start gap-3 p-4 bg-blue-500/10 border border-blue-500/20 rounded-xl text-sm text-blue-300">
        <Zap className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <p>API 키는 서버에 안전하게 암호화 저장됩니다. 저장 후 키 값은 다시 표시되지 않습니다. "테스트"로 연결을 확인하세요.</p>
      </div>

      {/* ─── 네이버 뉴스 검색 API ─── */}
      <div className="bg-white/5 border border-white/8 rounded-xl overflow-hidden">
        <div className="px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="w-3 h-3 rounded-full bg-green-400 flex-shrink-0" />
            <span className="font-semibold text-white text-sm">네이버 뉴스 검색 API</span>
            {naverHasConfig
              ? <span className="flex items-center text-xs text-green-400 bg-green-500/10 px-2 py-0.5 rounded-full"><CheckCircle2 className="w-3 h-3 mr-1" />설정됨</span>
              : <span className="text-xs text-white/30 bg-white/5 px-2 py-0.5 rounded-full">미설정</span>
            }
          </div>
        </div>
        <div className="px-5 pb-5 pt-1 space-y-3 border-t border-white/5">
          <p className="text-xs text-white/40">키워드 기반 최신 뉴스 수집. 자격증명은 <span className="text-blue-400">Naver Developers</span>에서 발급합니다.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-white/40 mb-1">Client ID</label>
              <input
                value={naverClientId}
                onChange={e => setNaverClientId(e.target.value)}
                placeholder={naverHasConfig ? '새 Client ID 입력 (교체)' : 'Client ID'}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-blue-500/40"
              />
            </div>
            <div>
              <label className="block text-xs text-white/40 mb-1">Client Secret</label>
              <div className="relative">
                <input
                  type={naverShowSecret ? 'text' : 'password'}
                  value={naverClientSecret}
                  onChange={e => setNaverClientSecret(e.target.value)}
                  placeholder={naverHasConfig ? '새 Secret 입력 (교체)' : 'Client Secret'}
                  className="w-full px-3 py-2 pr-9 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-blue-500/40"
                />
                <button type="button" onClick={() => setNaverShowSecret(p => !p)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60">
                  {naverShowSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>
          <button
            onClick={handleSaveNaver}
            disabled={naverSaving || !naverClientId.trim() || !naverClientSecret.trim()}
            className="flex items-center px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            {naverSaving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Key className="w-4 h-4 mr-2" />}
            네이버 API 키 저장
          </button>
        </div>
      </div>

      {/* ─── AI 판단 기준 프롬프트 설정 ─── */}
      <div className="bg-white/5 border border-white/8 rounded-xl overflow-hidden">
        <div className="px-5 py-4 flex items-center gap-3">
          <FileText className="w-4 h-4 text-purple-400" />
          <div>
            <h2 className="font-semibold text-white text-sm">AI 판단 기준 설정</h2>
            <p className="text-xs text-white/40 mt-0.5">관련성 분류·심층 분석에 사용되는 프롬프트입니다. 비워두면 시스템 기본값이 사용됩니다.</p>
          </div>
        </div>
        <div className="px-5 pb-5 pt-1 space-y-5 border-t border-white/5">

          {/* 관련성 분류 프롬프트 */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-white/70">관련성 분류 프롬프트 <span className="text-white/30 font-normal">(필터링됨 / 제외됨 판단 기준)</span></label>
              <button
                onClick={() => setRelevancePrompt('')}
                className="flex items-center gap-1 text-xs text-white/30 hover:text-white/60 transition-colors"
                title="기본값으로 초기화"
              >
                <RotateCcw className="w-3 h-3" />기본값
              </button>
            </div>
            <textarea
              value={relevancePrompt}
              onChange={e => setRelevancePrompt(e.target.value)}
              placeholder={DEFAULT_RELEVANCE_PROMPT}
              rows={10}
              className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-purple-500/40 resize-y font-mono leading-relaxed placeholder:text-white/20"
            />
            <p className="text-xs text-white/30 mt-1">반드시 <code className="bg-white/8 px-1 rounded">RELEVANT: YES or NO</code> · <code className="bg-white/8 px-1 rounded">CONFIDENCE: 숫자</code> · <code className="bg-white/8 px-1 rounded">REASON: 텍스트</code> 형식으로 응답하도록 지시해야 합니다.</p>
          </div>

          {/* 심층 분석 프롬프트 */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-white/70">심층 분석 프롬프트 <span className="text-white/30 font-normal">(분석됨 항목 추출 기준)</span></label>
              <button
                onClick={() => setAnalysisPrompt('')}
                className="flex items-center gap-1 text-xs text-white/30 hover:text-white/60 transition-colors"
                title="기본값으로 초기화"
              >
                <RotateCcw className="w-3 h-3" />기본값
              </button>
            </div>
            <textarea
              value={analysisPrompt}
              onChange={e => setAnalysisPrompt(e.target.value)}
              placeholder={DEFAULT_ANALYSIS_PROMPT}
              rows={14}
              className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-purple-500/40 resize-y font-mono leading-relaxed placeholder:text-white/20"
            />
            <p className="text-xs text-white/30 mt-1">반드시 <code className="bg-white/8 px-1 rounded">companies</code>, <code className="bg-white/8 px-1 rounded">deal</code>, <code className="bg-white/8 px-1 rounded">summary</code>, <code className="bg-white/8 px-1 rounded">category</code>, <code className="bg-white/8 px-1 rounded">tags</code> 키를 포함한 JSON 형식으로 응답하도록 지시해야 합니다.</p>
          </div>

          {/* Save result */}
          {promptSaveResult && (
            <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${promptSaveResult.success ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
              {promptSaveResult.success ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
              {promptSaveResult.message}
            </div>
          )}

          <button
            onClick={handleSavePrompts}
            disabled={promptSaving}
            className="flex items-center px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            {promptSaving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
            프롬프트 저장
          </button>
        </div>
      </div>

      {/* Provider cards */}
      {(Object.keys(PROVIDERS) as AiProvider[]).map(provider => {
        const info = PROVIDERS[provider];
        const state = providerState[provider];
        return (
          <div key={provider} className="bg-white/5 border border-white/8 rounded-xl overflow-hidden">
            {/* Header row */}
            <button
              className="w-full flex items-center justify-between px-5 py-4 hover:bg-white/3 transition-colors"
              onClick={() => update(provider, { expanded: !state.expanded })}
            >
              <div className="flex items-center gap-3">
                <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: info.color }} />
                <span className="font-semibold text-white text-sm">{info.label}</span>
                {state.hasKey
                  ? <span className="flex items-center text-xs text-green-400 bg-green-500/10 px-2 py-0.5 rounded-full"><CheckCircle2 className="w-3 h-3 mr-1" />키 저장됨</span>
                  : <span className="text-xs text-white/30 bg-white/5 px-2 py-0.5 rounded-full">미설정</span>
                }
                {state.isActive && state.hasKey && (
                  <span className="flex items-center text-xs text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-full font-medium">● 사용 중</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {state.hasKey && (
                  <>
                    <button
                      onClick={e => { e.stopPropagation(); handleToggleActive(provider); }}
                      className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                        state.isActive
                          ? 'bg-blue-600 text-white hover:bg-blue-500'
                          : 'bg-white/8 text-white/70 hover:bg-white/12'
                      }`}
                    >
                      {state.isActive ? '사용 중' : '사용'}
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); handleTest(provider); }}
                      disabled={state.testing}
                      className="flex items-center px-3 py-1.5 text-xs font-medium bg-white/8 text-white/70 rounded-lg hover:bg-white/12 transition-colors disabled:opacity-50"
                    >
                      {state.testing ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" />테스트 중...</> : <><RefreshCw className="w-3 h-3 mr-1" />테스트</>}
                    </button>
                  </>
                )}
                {state.expanded ? <ChevronUp className="w-4 h-4 text-white/30" /> : <ChevronDown className="w-4 h-4 text-white/30" />}
              </div>
            </button>

            {/* Test result */}
            {state.testResult && (
              <div className={`px-5 py-2.5 text-sm flex items-center gap-2 border-t border-white/5 ${
                state.testResult.success ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
              }`}>
                {state.testResult.success ? <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> : <XCircle className="w-4 h-4 flex-shrink-0" />}
                {state.testResult.message}
                {state.testResult.latencyMs && <span className="ml-auto text-xs opacity-60">{state.testResult.latencyMs}ms</span>}
              </div>
            )}

            {/* Expanded body */}
            {state.expanded && (
              <div className="px-5 pb-5 pt-3 space-y-4 border-t border-white/5">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Model selection */}
                  <div>
                    <label className="block text-xs text-white/40 mb-1.5">분석 모델</label>
                    <select
                      value={info.models.includes(state.selectedModel) ? state.selectedModel : 'custom'}
                      onChange={e => e.target.value !== 'custom' && update(provider, { selectedModel: e.target.value })}
                      className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-blue-500/40"
                    >
                      {info.models.map(m => <option key={m} value={m}>{m}</option>)}
                      <option value="custom">직접 입력...</option>
                    </select>
                    {!info.models.includes(state.selectedModel) && (
                      <input
                        value={state.selectedModel}
                        onChange={e => update(provider, { selectedModel: e.target.value })}
                        placeholder="모델명 입력"
                        className="w-full mt-2 px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none"
                      />
                    )}
                  </div>

                  {/* Filtering Model selection */}
                  <div>
                    <label className="block text-xs text-white/40 mb-1.5">
                      필터링 모델 <span className="text-white/20">(관련성 판단 전용 · 빠른 모델 권장)</span>
                    </label>
                    <select
                      value={state.selectedFilteringModel || '__same__'}
                      onChange={e => update(provider, { selectedFilteringModel: e.target.value === '__same__' ? '' : e.target.value })}
                      className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-blue-500/40"
                    >
                      <option value="__same__">분석 모델과 동일</option>
                      {info.models.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                    {state.selectedFilteringModel && (
                      <p className="mt-1 text-[10px] text-green-400/60">
                        필터링: {state.selectedFilteringModel} · 분석: {state.selectedModel}
                      </p>
                    )}
                  </div>

                  {/* Fallback Provider */}
                  <div>
                    <label className="block text-xs text-white/40 mb-1.5">
                      폴백 Provider <span className="text-white/20">(429·타임아웃 발생 시 자동 전환)</span>
                    </label>
                    <select
                      value={state.selectedFallbackProvider}
                      onChange={e => update(provider, { selectedFallbackProvider: e.target.value as AiProvider | '', selectedFallbackModel: '' })}
                      className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-blue-500/40"
                    >
                      <option value="">사용 안 함</option>
                      {(Object.keys(PROVIDERS) as AiProvider[]).filter(p => p !== provider).map(p => (
                        <option key={p} value={p}>{PROVIDERS[p].label}</option>
                      ))}
                    </select>
                    {state.selectedFallbackProvider && (
                      <div className="mt-2">
                        <label className="block text-xs text-white/40 mb-1">폴백 모델</label>
                        <select
                          value={state.selectedFallbackModel || '__default__'}
                          onChange={e => update(provider, { selectedFallbackModel: e.target.value === '__default__' ? '' : e.target.value })}
                          className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-blue-500/40"
                        >
                          <option value="__default__">기본값 ({PROVIDERS[state.selectedFallbackProvider as AiProvider]?.modelDefault})</option>
                          {PROVIDERS[state.selectedFallbackProvider as AiProvider]?.models.map(m => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                        <p className="mt-1 text-[10px] text-amber-400/60">
                          {provider} 실패 시 → {state.selectedFallbackProvider} ({state.selectedFallbackModel || PROVIDERS[state.selectedFallbackProvider as AiProvider]?.modelDefault}) 자동 전환
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Base URL */}
                  <div>
                    <label className="block text-xs text-white/40 mb-1.5">API 엔드포인트 (선택)</label>
                    {provider === 'glm' && (
                      <div className="flex gap-1.5 mb-1.5 flex-wrap">
                        {[
                          { label: 'GLM v4', url: 'https://api.z.ai/api/paas/v4' },
                          { label: 'Coding', url: 'https://api.z.ai/api/coding/paas/v4' },
                        ].map(o => (
                          <button key={o.url} onClick={() => update(provider, { baseUrlInput: o.url })}
                            className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                              state.baseUrlInput === o.url ? 'bg-blue-600 text-white border-blue-600' : 'bg-white/5 text-white/50 border-white/10 hover:border-white/20'
                            }`}>
                            {o.label}
                          </button>
                        ))}
                      </div>
                    )}
                    <input
                      value={state.baseUrlInput}
                      onChange={e => update(provider, { baseUrlInput: e.target.value })}
                      placeholder="기본값 사용"
                      className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-blue-500/40"
                    />
                  </div>
                </div>

                <p className="text-xs text-white/30">
                  API 키 발급: <a href={info.docsUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">{info.docsUrl}</a>
                </p>

                {/* API Key input */}
                <div>
                  <label className="block text-xs text-white/40 mb-1.5">{state.hasKey ? 'API 키 교체' : 'API 키'}</label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <input
                        type={state.showKey ? 'text' : 'password'}
                        value={state.apiKeyInput}
                        onChange={e => update(provider, { apiKeyInput: e.target.value })}
                        placeholder={info.placeholder}
                        className="w-full px-3 py-2 pr-10 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-blue-500/40"
                      />
                      <button
                        type="button"
                        onClick={() => update(provider, { showKey: !state.showKey })}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60"
                      >
                        {state.showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    <button
                      onClick={() => handleSave(provider)}
                      disabled={state.saving || (!state.apiKeyInput.trim() && !state.hasKey)}
                      className="flex items-center px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 whitespace-nowrap"
                    >
                      {state.saving ? <Loader2 className="w-4 h-4 animate-spin" /> : (state.hasKey ? '저장' : 'API 키 저장')}
                    </button>
                  </div>
                </div>

                {/* Test button in expanded */}
                <button
                  onClick={() => handleTest(provider)}
                  disabled={state.testing || !state.hasKey}
                  className="flex items-center px-4 py-2 border border-white/10 text-white/60 rounded-lg text-sm hover:bg-white/5 hover:text-white transition-colors disabled:opacity-40"
                >
                  {state.testing
                    ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />연결 테스트 중...</>
                    : <><RefreshCw className="w-4 h-4 mr-2" />연결 테스트</>}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
