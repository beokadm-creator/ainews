import { useState, useEffect, useCallback } from 'react';
import {
  Globe, Plus, Edit2, Trash2, RefreshCw, CheckCircle2, XCircle, AlertTriangle,
  Loader2, ChevronDown, ChevronUp, Rss, Code2, Cpu, Mail, Star, Eye, EyeOff,
  Search, Filter, Lock
} from 'lucide-react';
import { httpsCallable } from 'firebase/functions';
import { collection, getDocs, orderBy, query, doc, getDoc } from 'firebase/firestore';
import { functions, db } from '@/lib/firebase';
import { useAuthStore } from '@/store/useAuthStore';
import { getAuth } from 'firebase/auth';

type SourceType = 'rss' | 'scraping' | 'puppeteer' | 'api' | 'newsletter';
type PricingTier = 'free' | 'paid' | 'requires_subscription';
type SourceStatus = 'active' | 'inactive' | 'error' | 'testing';
type Category = 'domestic' | 'asian' | 'global' | 'tech' | 'all';

interface GlobalSource {
  id: string;
  name: string;
  description: string;
  url: string;
  type: SourceType;
  language: 'ko' | 'en' | 'ja' | 'zh';
  relevanceScore: 1 | 2 | 3 | 4 | 5;
  category: string;
  rssUrl?: string;
  apiEndpoint?: string;
  apiKeyRequired?: boolean;
  apiKeyEnvName?: string;
  listSelector?: string;
  titleSelector?: string;
  linkSelector?: string;
  contentSelector?: string;
  dateSelector?: string;
  loginRequired?: boolean;
  authType?: string;
  defaultKeywords: string[];
  status: SourceStatus;
  lastTestedAt?: any;
  lastTestResult?: {
    success: boolean;
    message: string;
    articlesFound?: number;
    latencyMs?: number;
    sampleTitles?: string[];
  };
  notes?: string;
  pricingTier: PricingTier;
}

const TYPE_META: Record<SourceType, { label: string; icon: any; color: string; bg: string }> = {
  rss: { label: 'RSS', icon: Rss, color: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-100 dark:bg-orange-900/30' },
  scraping: { label: 'Scraping', icon: Code2, color: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-100 dark:bg-purple-900/30' },
  puppeteer: { label: 'Puppeteer', icon: Cpu, color: 'text-indigo-600 dark:text-indigo-400', bg: 'bg-indigo-100 dark:bg-indigo-900/30' },
  api: { label: 'API', icon: Globe, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-100 dark:bg-blue-900/30' },
  newsletter: { label: 'Newsletter', icon: Mail, color: 'text-green-600 dark:text-green-400', bg: 'bg-green-100 dark:bg-green-900/30' },
};

const PRICING_META: Record<PricingTier, { label: string; color: string }> = {
  free: { label: '무료', color: 'text-green-600 dark:text-green-400' },
  paid: { label: '유료', color: 'text-white bg-red-500 rounded px-1 font-bold' },
  requires_subscription: { label: '구독 필요', color: 'text-white bg-amber-500 rounded px-1 font-bold' },
};

const BLANK_SOURCE: Partial<GlobalSource> = {
  type: 'rss',
  language: 'ko',
  relevanceScore: 3,
  category: 'domestic',
  status: 'inactive',
  pricingTier: 'free',
  defaultKeywords: ['M&A', '인수', '합병'],
  loginRequired: false,
  authType: 'none',
};

function StarRating({ score }: { score: number }) {
  return (
    <span className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(s => (
        <Star
          key={s}
          className={`w-3 h-3 ${s <= score ? 'text-yellow-400 fill-yellow-400' : 'text-gray-300 dark:text-gray-600'}`}
        />
      ))}
    </span>
  );
}

export default function MediaAdmin() {
  const { user } = useAuthStore();
  const isSuperadmin = (user as any)?.role === 'superadmin';

  const [sources, setSources] = useState<GlobalSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState<SourceType | 'all'>('all');
  const [filterCategory, setFilterCategory] = useState<Category>('all');
  const [filterPricing, setFilterPricing] = useState<PricingTier | 'all'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [editingSource, setEditingSource] = useState<Partial<GlobalSource> | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [savingSource, setSavingSource] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadSources = useCallback(async () => {
    setLoading(true);
    try {
      const q = query(collection(db, 'globalSources'), orderBy('relevanceScore', 'desc'));
      const snap = await getDocs(q);
      setSources(snap.docs.map(d => ({ id: d.id, ...d.data() } as GlobalSource)));
    } catch (err) {
      console.error('Failed to load sources:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadSources(); }, [loadSources]);

  const handleTest = async (source: GlobalSource) => {
    setTestingId(source.id);
    try {
      const auth = getAuth();
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('Not authenticated');

      const response = await fetch(
        'https://us-central1-eumnews-9a99c.cloudfunctions.net/testSourceConnectionHttp',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ sourceId: source.id }),
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Test failed');
      }

      await loadSources();
    } catch (err: any) {
      console.error('Test failed:', err);
    } finally {
      setTestingId(null);
    }
  };

  const handleSave = async () => {
    if (!editingSource?.name || !editingSource?.url || !editingSource?.type) return;
    setSavingSource(true);
    try {
      const fn = httpsCallable(functions, 'upsertGlobalSource');
      await fn(editingSource);
      await loadSources();
      setIsModalOpen(false);
      setEditingSource(null);
    } catch (err: any) {
      alert('Save failed: ' + err.message);
    } finally {
      setSavingSource(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('이 매체를 삭제하시겠습니까?')) return;
    setDeletingId(id);
    try {
      const fn = httpsCallable(functions, 'deleteGlobalSource');
      await fn({ id });
      setSources(prev => prev.filter(s => s.id !== id));
    } catch (err: any) {
      alert('Delete failed: ' + err.message);
    } finally {
      setDeletingId(null);
    }
  };

  const filtered = sources.filter(s => {
    const matchSearch = !searchTerm || s.name.toLowerCase().includes(searchTerm.toLowerCase()) || s.url.toLowerCase().includes(searchTerm.toLowerCase());
    const matchType = filterType === 'all' || s.type === filterType;
    const matchCat = filterCategory === 'all' || s.category === filterCategory;
    const matchPricing = filterPricing === 'all' || s.pricingTier === filterPricing;
    return matchSearch && matchType && matchCat && matchPricing;
  });

  if (!isSuperadmin) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-12 text-center text-gray-500">
        <Globe className="w-12 h-12 mx-auto mb-3 text-gray-300" />
        <p className="font-medium">Superadmin access required.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Media Library</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">
            글로벌 매체 라이브러리 관리. 회사는 이 목록에서 구독할 매체를 선택합니다.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadSources}
            disabled={loading}
            className="p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
            title="새로고침"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => {
              // 모든 RSS 일괄 테스트
              const rssSources = sources.filter(s => s.type === 'rss');
              rssSources.forEach(src => setTimeout(() => handleTest(src), 200));
            }}
            disabled={loading || testingId !== null}
            className="flex items-center px-3 py-2 text-xs font-medium bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-700 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors"
            title="모든 RSS 연결 테스트"
          >
            <RefreshCw className={`w-3 h-3 mr-1.5 ${testingId ? 'animate-spin' : ''}`} />
            RSS 일괄 테스트
          </button>
          <button
            onClick={() => { setEditingSource(BLANK_SOURCE); setIsModalOpen(true); }}
            className="flex items-center px-4 py-2 bg-[#1e3a5f] text-white rounded-lg font-medium text-sm hover:bg-[#2a4a73] transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4 mr-2" />매체 추가
          </button>
        </div>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {(Object.keys(TYPE_META) as SourceType[]).map(type => {
          const count = sources.filter(s => s.type === type).length;
          const meta = TYPE_META[type];
          return (
            <button
              key={type}
              onClick={() => setFilterType(filterType === type ? 'all' : type)}
              className={`flex items-center justify-between p-3 rounded-xl border transition-all ${
                filterType === type
                  ? 'border-[#1e3a5f] bg-[#1e3a5f]/5 shadow-sm dark:border-blue-500 dark:bg-blue-900/20'
                  : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-gray-300'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`p-1.5 rounded-lg ${meta.bg}`}>
                  <meta.icon className={`w-3.5 h-3.5 ${meta.color}`} />
                </span>
                <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{meta.label}</span>
              </div>
              <span className="text-lg font-bold text-gray-900 dark:text-white">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="매체명/URL 검색..."
            className="pl-9 pr-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-[#1e3a5f] w-56"
          />
        </div>
        <select
          value={filterCategory}
          onChange={e => setFilterCategory(e.target.value as Category)}
          className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white outline-none"
        >
          <option value="all">모든 분야</option>
          <option value="domestic">국내</option>
          <option value="asian">아시아</option>
          <option value="global">글로벌</option>
          <option value="tech">테크</option>
        </select>
        <select
          value={filterPricing}
          onChange={e => setFilterPricing(e.target.value as PricingTier | 'all')}
          className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white outline-none"
        >
          <option value="all">모든 가격</option>
          <option value="free">무료</option>
          <option value="paid">유료</option>
          <option value="requires_subscription">구독 필요</option>
        </select>
        <span className="flex items-center text-sm text-gray-500 dark:text-gray-400 ml-2">
          {filtered.length} / {sources.length} 매체
        </span>
      </div>

      {/* Source list */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-8 h-8 animate-spin text-[#1e3a5f]" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <Globe className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p>조건에 맞는 매체가 없습니다.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(source => {
            const typeMeta = TYPE_META[source.type] ?? { label: source.type || '?', icon: Globe, color: 'text-gray-600 dark:text-gray-400', bg: 'bg-gray-100 dark:bg-gray-700' };
            const pricingMeta = PRICING_META[source.pricingTier] ?? { label: source.pricingTier || '', color: 'text-gray-500' };
            const isExpanded = expandedId === source.id;
            const isTesting = testingId === source.id;
            const isDeleting = deletingId === source.id;

            return (
              <div
                key={source.id}
                className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden hover:shadow-md transition-shadow"
              >
                {/* Row header */}
                <div className="flex items-center gap-3 p-4">
                  {/* Type badge */}
                  <span className={`flex-shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium ${typeMeta.bg} ${typeMeta.color}`}>
                    <typeMeta.icon className="w-3 h-3" />
                    {typeMeta.label}
                  </span>

                  {/* Status dot */}
                  <span className={`flex-shrink-0 w-2.5 h-2.5 rounded-full ${
                    source.status === 'active' ? 'bg-green-400' :
                    source.status === 'error' ? 'bg-red-400' :
                    source.status === 'testing' ? 'bg-yellow-400 animate-pulse' :
                    'bg-gray-300 dark:bg-gray-600'
                  }`} />

                  {/* Name + meta */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-gray-900 dark:text-white">{source.name}</span>
                      <StarRating score={source.relevanceScore} />
                      <span className={`text-[10px] font-bold uppercase py-0.5 px-1.5 rounded-full shadow-sm ${pricingMeta.color}`}>
                        {pricingMeta.label}
                      </span>
                      <span className="text-xs text-gray-400 uppercase">{source.language}</span>
                      <span className="text-xs text-gray-400">
                        {source.category === 'domestic' ? '국내' : source.category === 'asian' ? '아시아' : source.category === 'global' ? '글로벌' : source.category}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">{source.url}</p>
                  </div>

                  {/* Test result badge */}
                  {source.lastTestResult && (
                    <div className="flex-shrink-0 hidden md:flex items-center gap-1">
                      {source.lastTestResult.success
                        ? <CheckCircle2 className="w-4 h-4 text-green-500" />
                        : <XCircle className="w-4 h-4 text-red-400" />}
                      {source.lastTestResult.articlesFound !== undefined && (
                        <span className="text-xs text-gray-500">{source.lastTestResult.articlesFound}건</span>
                      )}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex-shrink-0 flex items-center gap-1">
                    <button
                      onClick={() => handleTest(source)}
                      disabled={isTesting}
                      title="연결 테스트"
                      className="p-1.5 text-gray-400 hover:text-[#1e3a5f] dark:hover:text-blue-400 transition-colors disabled:opacity-50 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      {isTesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => { setEditingSource({ ...source }); setIsModalOpen(true); }}
                      title="편집"
                      className="p-1.5 text-gray-400 hover:text-[#1e3a5f] dark:hover:text-blue-400 transition-colors rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(source.id)}
                      disabled={isDeleting}
                      title="삭제"
                      className="p-1.5 text-gray-400 hover:text-red-500 transition-colors rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20"
                    >
                      {isDeleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : source.id)}
                      className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="border-t border-gray-100 dark:border-gray-700 px-4 py-4 bg-gray-50 dark:bg-gray-900/30 space-y-3">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                      <div className="space-y-1.5">
                        {source.rssUrl && (
                          <div className="flex gap-2">
                            <span className="text-gray-500 w-20 flex-shrink-0">RSS URL</span>
                            <a href={source.rssUrl} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline truncate">{source.rssUrl}</a>
                          </div>
                        )}
                        {source.apiEndpoint && (
                          <div className="flex gap-2">
                            <span className="text-gray-500 w-20 flex-shrink-0">API</span>
                            <span className="text-gray-700 dark:text-gray-300 truncate">{source.apiEndpoint}</span>
                          </div>
                        )}
                        {source.listSelector && (
                          <div className="flex gap-2">
                            <span className="text-gray-500 w-20 flex-shrink-0">List</span>
                            <code className="text-xs bg-gray-200 dark:bg-gray-700 px-1.5 py-0.5 rounded text-gray-800 dark:text-gray-200">{source.listSelector}</code>
                          </div>
                        )}
                        {source.titleSelector && (
                          <div className="flex gap-2">
                            <span className="text-gray-500 w-20 flex-shrink-0">Title</span>
                            <code className="text-xs bg-gray-200 dark:bg-gray-700 px-1.5 py-0.5 rounded text-gray-800 dark:text-gray-200">{source.titleSelector}</code>
                          </div>
                        )}
                        {source.loginRequired && (
                          <div className="flex gap-2">
                            <span className="text-gray-500 w-20 flex-shrink-0">Auth</span>
                            <span className="text-yellow-600 dark:text-yellow-400">로그인 필요 ({source.authType})</span>
                          </div>
                        )}
                      </div>
                      <div className="space-y-1.5">
                        <div className="flex gap-2">
                          <span className="text-gray-500 w-20 flex-shrink-0">키워드</span>
                          <div className="flex flex-wrap gap-1">
                            {(source.defaultKeywords || []).map(kw => (
                              <span key={kw} className="text-xs bg-[#1e3a5f]/10 text-[#1e3a5f] dark:bg-blue-900/30 dark:text-blue-300 px-2 py-0.5 rounded-full">{kw}</span>
                            ))}
                          </div>
                        </div>
                        {source.notes && (
                          <div className="flex gap-2">
                            <span className="text-gray-500 w-20 flex-shrink-0">메모</span>
                            <span className="text-gray-600 dark:text-gray-400 text-xs">{source.notes}</span>
                          </div>
                        )}
                        {source.lastTestedAt && (
                          <div className="flex gap-2">
                            <span className="text-gray-500 w-20 flex-shrink-0">마지막 테스트</span>
                            <span className="text-gray-600 dark:text-gray-400 text-xs">
                              {source.lastTestedAt?.toDate ? source.lastTestedAt.toDate().toLocaleString('ko-KR') : ''}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Test result detail */}
                    {source.lastTestResult && (
                      <div className={`p-3 rounded-lg text-sm ${
                        source.lastTestResult.success
                          ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'
                          : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'
                      }`}>
                        <div className="flex items-center gap-2 mb-1">
                          {source.lastTestResult.success
                            ? <CheckCircle2 className="w-4 h-4 text-green-600" />
                            : <XCircle className="w-4 h-4 text-red-500" />}
                          <span className={source.lastTestResult.success ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
                            {source.lastTestResult.message}
                          </span>
                          {source.lastTestResult.latencyMs && (
                            <span className="ml-auto text-xs text-gray-500">{source.lastTestResult.latencyMs}ms</span>
                          )}
                        </div>
                        {source.lastTestResult.sampleTitles && source.lastTestResult.sampleTitles.length > 0 && (
                          <div className="mt-2 space-y-1">
                            <p className="text-xs text-gray-500 font-medium">수집 샘플:</p>
                            {source.lastTestResult.sampleTitles.map((title, i) => (
                              <p key={i} className="text-xs text-gray-600 dark:text-gray-400 pl-3 border-l-2 border-gray-300">• {title}</p>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Test button */}
                    <button
                      onClick={() => handleTest(source)}
                      disabled={isTesting}
                      className="flex items-center px-4 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
                    >
                      {isTesting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                      {isTesting ? '테스트 중...' : '연결 테스트 실행'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Edit/Create Modal */}
      {isModalOpen && editingSource && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center overflow-y-auto py-8 px-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-2xl my-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-lg font-bold text-gray-900 dark:text-white">
                {editingSource.id ? '매체 편집' : '새 매체 추가'}
              </h2>
              <button
                onClick={() => { setIsModalOpen(false); setEditingSource(null); }}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
              {/* Basic info */}
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">매체명 *</label>
                  <input
                    type="text"
                    value={editingSource.name || ''}
                    onChange={e => setEditingSource(s => ({ ...s, name: e.target.value }))}
                    placeholder="한국경제신문"
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-[#1e3a5f]"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">설명</label>
                  <textarea
                    value={editingSource.description || ''}
                    onChange={e => setEditingSource(s => ({ ...s, description: e.target.value }))}
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-[#1e3a5f]"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">사이트 URL *</label>
                  <input
                    type="url"
                    value={editingSource.url || ''}
                    onChange={e => setEditingSource(s => ({ ...s, url: e.target.value }))}
                    placeholder="https://www.example.com"
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-[#1e3a5f]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">수집 방식 *</label>
                  <select
                    value={editingSource.type || 'rss'}
                    onChange={e => setEditingSource(s => ({ ...s, type: e.target.value as SourceType }))}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white outline-none"
                  >
                    <option value="rss">RSS</option>
                    <option value="scraping">Scraping (Cheerio)</option>
                    <option value="puppeteer">Puppeteer (JS 렌더링)</option>
                    <option value="api">API</option>
                    <option value="newsletter">Newsletter</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">언어</label>
                  <select
                    value={editingSource.language || 'ko'}
                    onChange={e => setEditingSource(s => ({ ...s, language: e.target.value as any }))}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white outline-none"
                  >
                    <option value="ko">한국어</option>
                    <option value="en">English</option>
                    <option value="ja">日本語</option>
                    <option value="zh">中文</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">분야</label>
                  <select
                    value={editingSource.category || 'domestic'}
                    onChange={e => setEditingSource(s => ({ ...s, category: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white outline-none"
                  >
                    <option value="domestic">국내</option>
                    <option value="asian">아시아</option>
                    <option value="global">글로벌</option>
                    <option value="tech">테크</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">가격</label>
                  <select
                    value={editingSource.pricingTier || 'free'}
                    onChange={e => setEditingSource(s => ({ ...s, pricingTier: e.target.value as PricingTier }))}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white outline-none"
                  >
                    <option value="free">무료</option>
                    <option value="paid">유료</option>
                    <option value="requires_subscription">구독 필요</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">관련성 (★)</label>
                  <select
                    value={editingSource.relevanceScore || 3}
                    onChange={e => setEditingSource(s => ({ ...s, relevanceScore: parseInt(e.target.value) as any }))}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white outline-none"
                  >
                    {[5,4,3,2,1].map(n => <option key={n} value={n}>{Array(n).fill('★').join('')}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">상태</label>
                  <select
                    value={editingSource.status || 'inactive'}
                    onChange={e => setEditingSource(s => ({ ...s, status: e.target.value as SourceStatus }))}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white outline-none"
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
              </div>

{/* Type-specific fields */}
              {editingSource.type === 'rss' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">RSS URL</label>
                  <input
                    type="url"
                    value={editingSource.rssUrl || editingSource.url || ''}
                    onChange={e => setEditingSource(s => ({ ...s, rssUrl: e.target.value }))}
                    placeholder="https://www.example.com/rss"
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-[#1e3a5f]"
                  />
                </div>
              )}

              {(editingSource.type === 'scraping' || editingSource.type === 'puppeteer') && (
                <div className="space-y-3 p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">CSS 셀렉터 설정</p>
                  {[
                    { key: 'listSelector', label: '리스트 컨테이너', placeholder: '.article-list li, .news-list li' },
                    { key: 'titleSelector', label: '제목', placeholder: 'h3 a, .title a' },
                    { key: 'linkSelector', label: '링크 (선택)', placeholder: 'a.read-more' },
                    { key: 'contentSelector', label: '본문/요약 (선택)', placeholder: '.lead, .summary' },
                    { key: 'dateSelector', label: '날짜 (선택)', placeholder: 'time, .date' },
                  ].map(field => (
                    <div key={field.key}>
                      <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{field.label}</label>
                      <input
                        type="text"
                        value={(editingSource as any)[field.key] || ''}
                        onChange={e => setEditingSource(s => ({ ...s, [field.key]: e.target.value }))}
                        placeholder={field.placeholder}
                        className="w-full px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-[#1e3a5f] font-mono"
                      />
                    </div>
                  ))}
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!editingSource.loginRequired}
                        onChange={e => setEditingSource(s => ({ ...s, loginRequired: e.target.checked }))}
                        className="rounded"
                      />
                      <span className="text-sm text-gray-700 dark:text-gray-300">로그인 필요</span>
                    </label>
                    {editingSource.loginRequired && (
                      <select
                        value={editingSource.authType || 'session'}
                        onChange={e => setEditingSource(s => ({ ...s, authType: e.target.value }))}
                        className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-xs bg-white dark:bg-gray-800 text-gray-900 dark:text-white outline-none"
                      >
                        <option value="session">Session Cookie</option>
                        <option value="cookie">Cookie</option>
                      </select>
                    )}
                  </div>
                </div>
              )}

              {editingSource.type === 'api' && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">API Endpoint</label>
                    <input
                      type="url"
                      value={editingSource.apiEndpoint || ''}
                      onChange={e => setEditingSource(s => ({ ...s, apiEndpoint: e.target.value }))}
                      placeholder="https://api.example.com/v1/articles"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-[#1e3a5f]"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">API Key 환경변수명</label>
                    <input
                      type="text"
                      value={editingSource.apiKeyEnvName || ''}
                      onChange={e => setEditingSource(s => ({ ...s, apiKeyEnvName: e.target.value, apiKeyRequired: !!e.target.value }))}
                      placeholder="NEWSAPI_KEY"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white outline-none font-mono"
                    />
                  </div>
                </div>
              )}

              {/* Keywords */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">기본 키워드 (쉼표 구분)</label>
                <input
                  type="text"
                  value={(editingSource.defaultKeywords || []).join(', ')}
                  onChange={e => setEditingSource(s => ({ ...s, defaultKeywords: e.target.value.split(',').map(k => k.trim()).filter(Boolean) }))}
                  placeholder="M&A, 인수, 합병, PE, VC"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-[#1e3a5f]"
                />
              </div>

              {/* Notes */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">관리자 메모</label>
                <textarea
                  value={editingSource.notes || ''}
                  onChange={e => setEditingSource(s => ({ ...s, notes: e.target.value }))}
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-[#1e3a5f]"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-700">
              <button
                onClick={() => { setIsModalOpen(false); setEditingSource(null); }}
                className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white transition-colors"
              >
                취소
              </button>
              <button
                onClick={handleSave}
                disabled={savingSource || !editingSource.name || !editingSource.url}
                className="flex items-center px-5 py-2 bg-[#1e3a5f] text-white rounded-lg text-sm font-medium hover:bg-[#2a4a73] transition-colors disabled:opacity-50"
              >
                {savingSource ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                {editingSource.id ? '수정 저장' : '매체 추가'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
