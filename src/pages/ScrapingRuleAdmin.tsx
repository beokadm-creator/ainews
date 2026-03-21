import { useState, useEffect } from 'react';
import { Plus, Trash2, Save, Play, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '@/lib/firebase';
import { useAuthStore } from '@/store/useAuthStore';

interface ScrapingRule {
  id: string;
  sourceId: string; // 'thebell' | 'marketinsight'
  sourceName: string;
  keywords: string[];
  categories: string[];
  enabled: boolean;
  createdAt?: any;
  updatedAt?: any;
}

interface ExecutionResult {
  sourceId: string;
  success: boolean;
  articlesFound?: number;
  message: string;
  executedAt?: string;
}

const THEBELL_CATEGORIES = ['뉴스', 'M&A', 'PE/VC', '공시', '분석'];
const MARKETINSIGHT_CATEGORIES = ['M&A', '기업거래', '인수합병', '지분인수', 'PE'];
const COMMON_KEYWORDS = [
  'M&A',
  '인수',
  '합병',
  '매각',
  '지분인수',
  'PE',
  'VC',
  '벤처',
  '투자',
  '전략적인수',
  '사모펀드',
];

export default function ScrapingRuleAdmin() {
  const { user } = useAuthStore();
  const isSuperadmin = (user as any)?.role === 'superadmin';

  const [rules, setRules] = useState<ScrapingRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [executionResult, setExecutionResult] = useState<ExecutionResult | null>(null);

  // Form states
  const [selectedSourceId, setSelectedSourceId] = useState<'thebell' | 'marketinsight'>('thebell');
  const [keywords, setKeywords] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isSuperadmin) {
      loadRules();
    }
  }, [isSuperadmin]);

  const loadRules = async () => {
    setLoading(true);
    try {
      const fn = httpsCallable(functions, 'getScrapingRules');
      const result = (await fn()) as any;
      setRules(result.data || []);
    } catch (err) {
      console.error('Failed to load rules:', err);
    } finally {
      setLoading(false);
    }
  };

  const getSourceName = (sourceId: string) => {
    return sourceId === 'thebell' ? '더벨 (The Bell)' : '마켓인사이트 (M&A)';
  };

  const getCategories = () => {
    return selectedSourceId === 'thebell' ? THEBELL_CATEGORIES : MARKETINSIGHT_CATEGORIES;
  };

  const handleAddKeyword = () => {
    if (newKeyword.trim() && !keywords.includes(newKeyword.trim())) {
      setKeywords([...keywords, newKeyword.trim()]);
      setNewKeyword('');
    }
  };

  const handleRemoveKeyword = (idx: number) => {
    setKeywords(keywords.filter((_, i) => i !== idx));
  };

  const handleToggleCategory = (cat: string) => {
    setCategories(prev =>
      prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]
    );
  };

  const handleSaveRule = async () => {
    if (keywords.length === 0 || categories.length === 0) {
      alert('키워드와 카테고리를 최소 1개씩 선택해주세요.');
      return;
    }

    setSaving(true);
    try {
      const fn = httpsCallable(functions, 'saveScrapingRule');
      await fn({
        sourceId: selectedSourceId,
        keywords,
        categories,
        enabled: true,
      });
      setKeywords([]);
      setCategories([]);
      alert('저장되었습니다.');
      loadRules();
    } catch (err: any) {
      alert('저장 실패: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleExecute = async (sourceId: string) => {
    setExecuting(true);
    setExecutionResult(null);
    try {
      const fn = httpsCallable(functions, 'executeScrapingRule');
      const result = (await fn({ sourceId })) as any;
      setExecutionResult(result.data);
    } catch (err: any) {
      setExecutionResult({
        sourceId,
        success: false,
        message: err.message,
      });
    } finally {
      setExecuting(false);
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
    if (!confirm('이 규칙을 삭제하시겠습니까?')) return;

    try {
      const fn = httpsCallable(functions, 'deleteScrapingRule');
      await fn({ ruleId });
      loadRules();
    } catch (err: any) {
      alert('삭제 실패: ' + err.message);
    }
  };

  if (!isSuperadmin) {
    return (
      <div className="p-12 text-center text-gray-500">
        <AlertCircle className="w-12 h-12 mx-auto mb-4 opacity-20" />
        <p>Access Denied. Superadmin required.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-[#1e3a5f]" />
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-20">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">스크래핑 규칙 관리</h1>
        <p className="text-gray-500 dark:text-gray-400 mt-1">
          더벨과 마켓인사이트의 스크래핑 키워드와 카테고리를 설정합니다.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Rule Configuration */}
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">규칙 추가</h2>

          {/* Source Selection */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              매체 선택
            </label>
            <select
              value={selectedSourceId}
              onChange={e => {
                setSelectedSourceId(e.target.value as any);
                setKeywords([]);
                setCategories([]);
              }}
              className="w-full px-4 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-[#1e3a5f]"
            >
              <option value="thebell">더벨 (The Bell)</option>
              <option value="marketinsight">마켓인사이트 (M&A)</option>
            </select>
          </div>

          {/* Keywords */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              키워드
            </label>
            <div className="flex gap-2 mb-3">
              <input
                type="text"
                value={newKeyword}
                onChange={e => setNewKeyword(e.target.value)}
                onKeyPress={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddKeyword();
                  }
                }}
                placeholder="키워드 입력 후 추가"
                className="flex-1 px-4 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-[#1e3a5f]"
              />
              <button
                onClick={handleAddKeyword}
                className="px-4 py-2 bg-[#1e3a5f] text-white rounded-lg text-sm font-medium hover:bg-[#2a4a73] transition-colors flex items-center gap-2"
              >
                <Plus className="w-4 h-4" /> 추가
              </button>
            </div>

            <div className="flex flex-wrap gap-2">
              {keywords.map((kw, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-2 px-3 py-1.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full text-sm"
                >
                  {kw}
                  <button
                    onClick={() => handleRemoveKeyword(idx)}
                    className="ml-1 text-blue-500 hover:text-blue-700 dark:hover:text-blue-200"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            <div className="mt-3 p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
              <p className="text-xs text-gray-600 dark:text-gray-400 mb-2 font-medium">자주 사용하는 키워드:</p>
              <div className="flex flex-wrap gap-2">
                {COMMON_KEYWORDS.map(kw => (
                  <button
                    key={kw}
                    onClick={() => {
                      if (!keywords.includes(kw)) {
                        setKeywords([...keywords, kw]);
                      }
                    }}
                    className="px-2.5 py-1 text-xs bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-300 dark:hover:bg-gray-500 transition-colors"
                  >
                    + {kw}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Categories */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              카테고리
            </label>
            <div className="grid grid-cols-2 gap-2">
              {getCategories().map(cat => (
                <label
                  key={cat}
                  className="flex items-center gap-2 cursor-pointer p-3 rounded-lg border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={categories.includes(cat)}
                    onChange={() => handleToggleCategory(cat)}
                    className="rounded"
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">{cat}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Save Button */}
          <button
            onClick={handleSaveRule}
            disabled={saving}
            className="w-full flex items-center justify-center px-4 py-2.5 bg-[#1e3a5f] hover:bg-[#2a4a73] text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                저장 중...
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                규칙 저장
              </>
            )}
          </button>
        </div>

        {/* Saved Rules & Execution */}
        <div className="space-y-6">
          {/* Active Rules */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">저장된 규칙</h2>

            {rules.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">저장된 규칙이 없습니다.</p>
            ) : (
              <div className="space-y-4">
                {rules.map(rule => (
                  <div
                    key={rule.id}
                    className="p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600"
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h3 className="font-medium text-gray-900 dark:text-white">{rule.sourceName}</h3>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          업데이트: {rule.updatedAt ? new Date(rule.updatedAt.toDate?.() || rule.updatedAt).toLocaleDateString('ko-KR') : '—'}
                        </p>
                      </div>
                      <button
                        onClick={() => handleDeleteRule(rule.id)}
                        className="p-1.5 text-gray-400 hover:text-red-500 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="mb-3">
                      <p className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">키워드:</p>
                      <div className="flex flex-wrap gap-1.5">
                        {rule.keywords.map(kw => (
                          <span
                            key={kw}
                            className="px-2 py-0.5 text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded"
                          >
                            {kw}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="mb-3">
                      <p className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">카테고리:</p>
                      <div className="flex flex-wrap gap-1.5">
                        {rule.categories.map(cat => (
                          <span
                            key={cat}
                            className="px-2 py-0.5 text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 rounded"
                          >
                            {cat}
                          </span>
                        ))}
                      </div>
                    </div>

                    <button
                      onClick={() => handleExecute(rule.sourceId)}
                      disabled={executing}
                      className="w-full flex items-center justify-center px-3 py-1.5 text-xs font-medium bg-[#1e3a5f] hover:bg-[#2a4a73] text-white rounded transition-colors disabled:opacity-50"
                    >
                      {executing ? (
                        <>
                          <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
                          실행 중...
                        </>
                      ) : (
                        <>
                          <Play className="w-3 h-3 mr-1.5" />
                          스크래핑 실행
                        </>
                      )}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Execution Result */}
          {executionResult && (
            <div
              className={`p-4 rounded-lg border ${
                executionResult.success
                  ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
                  : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
              }`}
            >
              <div className="flex gap-3">
                {executionResult.success ? (
                  <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                )}
                <div>
                  <p
                    className={`text-sm font-medium ${
                      executionResult.success
                        ? 'text-green-800 dark:text-green-300'
                        : 'text-red-800 dark:text-red-300'
                    }`}
                  >
                    {getSourceName(executionResult.sourceId)}
                  </p>
                  <p
                    className={`text-xs mt-1 ${
                      executionResult.success
                        ? 'text-green-700 dark:text-green-400'
                        : 'text-red-700 dark:text-red-400'
                    }`}
                  >
                    {executionResult.message}
                    {executionResult.articlesFound && ` (${executionResult.articlesFound}개 기사)`}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
