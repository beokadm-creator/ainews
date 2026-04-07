import { useState, useEffect } from 'react';
import { Search, CheckCircle2, Rss, Code2, Globe, Star, Loader2, Save, Filter } from 'lucide-react';
import { httpsCallable } from 'firebase/functions';
import { functions, db } from '@/lib/firebase';
import { collection, doc, getDoc, getDocs, orderBy, query } from 'firebase/firestore';
import { useAuthStore } from '@/store/useAuthStore';
import { dedupeSourceCatalog, getSourceOriginLabel } from '@/lib/sourceCatalog';

type SourceType = 'rss' | 'scraping' | 'api' | 'newsletter';
type PricingTier = 'free' | 'paid' | 'requires_subscription';

interface GlobalSource {
  id: string;
  name: string;
  description: string;
  url: string;
  type: SourceType;
  language: 'ko' | 'en' | 'ja' | 'zh';
  relevanceScore: 1 | 2 | 3 | 4 | 5;
  category: string;
  defaultKeywords: string[];
  status: 'active' | 'inactive' | 'error' | 'testing';
  pricingTier: PricingTier;
  rssUrl?: string;
  lastTestResult?: { success: boolean; message: string; articlesFound?: number };
  notes?: string;
  loginRequired?: boolean;
  allowedCompanyIds?: string[];
  localScraperId?: string;
}

const TYPE_ICON: Record<SourceType, any> = {
  rss: Rss,
  scraping: Code2,
  api: Globe,
  newsletter: Globe,
};

const TYPE_COLOR: Record<SourceType, string> = {
  rss: 'text-orange-500',
  scraping: 'text-purple-500',
  api: 'text-blue-500',
  newsletter: 'text-green-500',
};

function StarRating({ score }: { score: number }) {
  return (
    <span className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(s => (
        <Star key={s} className={`w-3 h-3 ${s <= score ? 'text-yellow-400 fill-yellow-400' : 'text-gray-300 dark:text-gray-600'}`} />
      ))}
    </span>
  );
}

export default function MediaSelector() {
  const { user } = useAuthStore();
  const companyId = (user as any)?.primaryCompanyId || null;
  const isSuperadmin = (user as any)?.role === 'superadmin';
  const canEdit = isSuperadmin || (user as any)?.role === 'company_admin';

  const [allSources, setAllSources] = useState<GlobalSource[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState<SourceType | 'all'>('all');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterOnlyFree, setFilterOnlyFree] = useState(false);
  const [filterOnlySelected, setFilterOnlySelected] = useState(false);

  useEffect(() => {
    loadData();
  }, [companyId]);

  const loadData = async () => {
    setLoading(true);
    try {
      // Load global sources
      const q = query(collection(db, 'globalSources'), orderBy('relevanceScore', 'desc'));
      const snap = await getDocs(q);
      const loadedSources = snap.docs.map(d => ({ id: d.id, ...d.data() } as GlobalSource));
      setAllSources(dedupeSourceCatalog(loadedSources));

      // Load current subscriptions
      if (companyId) {
        const subDoc = await getDoc(doc(db, 'companySourceSubscriptions', companyId));
        if (subDoc.exists()) {
          const data = subDoc.data() as any;
          setSelectedIds(new Set(data.subscribedSourceIds || []));
        }
      }
    } catch (err) {
      console.error('Failed to load:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = (id: string) => {
    if (!canEdit) return;
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSaved(false);
  };

  const handleSave = async () => {
    if (!companyId) return;
    setSaving(true);
    try {
      const fn = httpsCallable(functions, 'updateCompanySourceSubscriptions');
      await fn({ companyId, subscribedSourceIds: [...selectedIds] });
      setSaved(true);
      setTimeout(() => setSaved(false), 5000);
    } catch (err: any) {
      alert('저장 실패: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const filtered = allSources.filter(s => {
    // 1. 슈퍼어드민이 활성화(active)한 매체만 노출
    if (s.status !== 'active') return false;

    // 2. 유료(paid, requires_subscription) 매체는 allowedCompanyIds에 포함된 회사 또는 Superadmin만 노출
    const isPremium = s.pricingTier === 'paid' || s.pricingTier === 'requires_subscription';
    if (isPremium && !isSuperadmin) {
      if (!s.allowedCompanyIds || !s.allowedCompanyIds.includes(companyId)) {
        return false;
      }
    }

    const matchSearch = !searchTerm || s.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchType = filterType === 'all' || s.type === filterType;
    const matchCat = filterCategory === 'all' || s.category === filterCategory;
    const matchFree = !filterOnlyFree || s.pricingTier === 'free';
    const matchSelected = !filterOnlySelected || selectedIds.has(s.id);
    return matchSearch && matchType && matchCat && matchFree && matchSelected;
  });

  // Group by category
  const groups: Record<string, GlobalSource[]> = {};
  const categoryOrder = ['tech', 'startup', 'M&A', 'domestic', 'asian', 'global', 'other'];
  const categoryLabel: Record<string, string> = {
    tech: '💻 테크 매체',
    startup: '🚀 스타트업/PE·VC',
    'M&A': '📊 M&A / 유료 매체',
    domestic: '🇰🇷 국내 매체',
    asian: '🌏 아시아 매체',
    global: '🌐 글로벌 매체',
    other: '📁 기타',
  };

  filtered.forEach(s => {
    const cat = s.category || 'other';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(s);
  });

  if (loading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-[#1e3a5f] dark:text-gray-400" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-12">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 border-b border-gray-200 pb-5 dark:border-gray-700/60">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">매체 구독 선택</h1>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            파이프라인에 포함할 매체를 선택하세요. 현재 <span className="font-bold text-[#1e3a5f] dark:text-blue-400">{selectedIds.size}개</span> 선택됨.
          </p>
        </div>
        {canEdit && (
          <button
            onClick={handleSave}
            disabled={saving}
            className={`inline-flex shrink-0 items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-all disabled:opacity-50 ${
              saved ? 'bg-emerald-600 text-white' : 'bg-[#1e3a5f] text-white hover:bg-[#24456f]'
            }`}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <CheckCircle2 className="h-4 w-4" /> : <Save className="h-4 w-4" />}
            {saving ? '저장 중...' : saved ? '저장 완료!' : '구독 저장'}
          </button>
        )}
      </div>

      <div className="rounded-lg border border-[#1e3a5f]/20 bg-[#1e3a5f]/5 px-4 py-3 text-xs text-[#1e3a5f] dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-300">
        회사 구독 목록은 슈퍼어드민 매체 관리와 동일한 globalSources를 사용합니다. 더벨, 마켓인사이트 같은 외부 스크래핑 매체도 여기서 같은 기준으로 연결됩니다.
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="매체명 검색..."
            className="w-44 rounded-lg border border-gray-200 bg-white py-2 pl-8 pr-3 text-sm text-gray-900 outline-none transition focus:border-[#1e3a5f] dark:border-gray-700/60 dark:bg-gray-800/60 dark:text-white dark:focus:border-blue-400"
          />
        </div>
        <select
          value={filterCategory}
          onChange={e => setFilterCategory(e.target.value)}
          className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 outline-none dark:border-gray-700/60 dark:bg-gray-800/60 dark:text-gray-200"
        >
          <option value="all">모든 분야</option>
          <option value="domestic">국내</option>
          <option value="asian">아시아</option>
          <option value="global">글로벌</option>
          <option value="tech">테크</option>
          <option value="startup">스타트업/PE·VC</option>
          <option value="M&A">M&A / 유료</option>
        </select>
        <select
          value={filterType}
          onChange={e => setFilterType(e.target.value as SourceType | 'all')}
          className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 outline-none dark:border-gray-700/60 dark:bg-gray-800/60 dark:text-gray-200"
        >
          <option value="all">모든 방식</option>
          <option value="rss">RSS</option>
          <option value="scraping">Scraping</option>
          <option value="api">API</option>
        </select>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
          <input type="checkbox" checked={filterOnlyFree} onChange={e => setFilterOnlyFree(e.target.checked)} className="rounded" />
          무료만
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
          <input type="checkbox" checked={filterOnlySelected} onChange={e => setFilterOnlySelected(e.target.checked)} className="rounded" />
          선택된 것만
        </label>
        <button
          onClick={() => {
            const allActiveIds = allSources.filter(s => s.status === 'active' && s.pricingTier === 'free').map(s => s.id);
            setSelectedIds(new Set(allActiveIds));
            setSaved(false);
          }}
          className="ml-auto text-xs text-[#1e3a5f] hover:underline dark:text-blue-400"
        >
          무료 전체 선택
        </button>
        <button onClick={() => { setSelectedIds(new Set()); setSaved(false); }} className="text-xs text-gray-400 hover:underline">
          전체 해제
        </button>
      </div>

      {/* Source groups */}
      {categoryOrder.map(cat => {
        const items = groups[cat];
        if (!items || items.length === 0) return null;
        return (
          <div key={cat}>
            <div className="mb-3 flex items-center gap-3">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">{categoryLabel[cat] || cat}</span>
              <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700/60" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {items.sort((a, b) => b.relevanceScore - a.relevanceScore).map(source => {
                const isSelected = selectedIds.has(source.id);
                const TypeIcon = TYPE_ICON[source.type] || Globe;
                const typeColor = TYPE_COLOR[source.type] || 'text-gray-400';

                return (
                  <button
                    key={source.id}
                    onClick={() => handleToggle(source.id)}
                    disabled={!canEdit}
                    className={`w-full text-left p-4 rounded-xl border transition-all ${
                      isSelected
                        ? 'border-[#1e3a5f] bg-[#1e3a5f]/5 dark:border-blue-500 dark:bg-blue-900/20 shadow-sm'
                        : 'border-gray-200 dark:border-gray-700/60 bg-white dark:bg-gray-800/60 hover:border-gray-300 dark:hover:border-gray-600'
                    } ${!canEdit ? 'cursor-default' : 'cursor-pointer'}`}
                  >
                    <div className="flex items-start gap-3">
                      {/* Checkbox visual */}
                      <div className={`flex-shrink-0 w-5 h-5 rounded border-2 mt-0.5 flex items-center justify-center transition-colors ${
                        isSelected
                          ? 'border-[#1e3a5f] bg-[#1e3a5f] dark:border-blue-500 dark:bg-blue-500'
                          : 'border-gray-300 dark:border-gray-600'
                      }`}>
                        {isSelected && <CheckCircle2 className="w-3.5 h-3.5 text-white" />}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="font-semibold text-gray-900 dark:text-white text-sm">{source.name}</span>
                          <StarRating score={source.relevanceScore} />
                          <span className={`flex items-center gap-1 text-xs font-medium ${typeColor}`}>
                            <TypeIcon className="w-3 h-3" />
                            {source.type.toUpperCase()}
                          </span>
                          {getSourceOriginLabel(source) && (
                            <span className="text-xs text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 px-1.5 py-0.5 rounded-full">
                              {getSourceOriginLabel(source)}
                            </span>
                          )}
                          {source.pricingTier === 'free' && (
                            <span className="text-xs text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 px-1.5 py-0.5 rounded-full">무료</span>
                          )}
                          {source.pricingTier === 'paid' && (
                            <span className="text-xs text-white bg-red-500 dark:bg-red-600 px-1.5 py-0.5 rounded-full font-bold shadow-sm">유료</span>
                          )}
                          {source.pricingTier === 'requires_subscription' && (
                            <span className="text-xs text-white bg-amber-500 dark:bg-amber-600 px-1.5 py-0.5 rounded-full font-bold shadow-sm">구독 필요</span>
                          )}
                          {source.loginRequired && (
                            <span className="text-xs text-gray-500 bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded-full">로그인 필요</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2">{source.description}</p>
                        {source.lastTestResult && (
                          <div className={`flex items-center gap-1 mt-1.5 text-xs ${
                            source.lastTestResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'
                          }`}>
                            {source.lastTestResult.success
                              ? <CheckCircle2 className="w-3 h-3" />
                              : <span className="w-3 h-3 rounded-full bg-red-400 inline-block" />}
                            {source.lastTestResult.success
                              ? `테스트 통과 (${source.lastTestResult.articlesFound || 0}건)`
                              : '테스트 실패'}
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Other categories */}
      {Object.keys(groups)
        .filter(cat => !categoryOrder.includes(cat))
        .map(cat => {
          const items = groups[cat];
          if (!items || items.length === 0) return null;
          return (
            <div key={cat}>
              <div className="mb-3 flex items-center gap-3">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">{cat}</span>
                <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700/60" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {items.map(source => (
                  <button
                    key={source.id}
                    onClick={() => handleToggle(source.id)}
                    disabled={!canEdit}
                    className={`w-full text-left p-4 rounded-xl border transition-all text-sm ${
                      selectedIds.has(source.id)
                        ? 'border-[#1e3a5f] bg-[#1e3a5f]/5 shadow-sm'
                        : 'border-gray-200 dark:border-gray-700/60 bg-white dark:bg-gray-800/60'
                    }`}
                  >
                    <span className="font-medium text-gray-900 dark:text-white">{source.name}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}

      {filtered.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-16 text-center text-gray-400">
          <Filter className="h-8 w-8 opacity-30" />
          <p className="text-sm">조건에 맞는 매체가 없습니다.</p>
        </div>
      )}

      {/* Fixed save bar */}
      {selectedIds.size > 0 && canEdit && (
        <div className="fixed bottom-0 left-0 right-0 z-10 flex items-center justify-between border-t border-gray-200 bg-white/95 px-6 py-3 shadow-lg backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-900/95 lg:left-64">
          <div>
            <span className="text-sm text-gray-700 dark:text-gray-300">
              <span className="font-bold text-[#1e3a5f] dark:text-blue-400">{selectedIds.size}개</span> 매체 선택됨
            </span>
            {saved && (
              <p className="mt-0.5 text-xs text-emerald-600 dark:text-emerald-400">저장 완료. 다음 파이프라인 실행 시 반영됩니다.</p>
            )}
          </div>
          <button
            onClick={handleSave}
            disabled={saving}
            className={`inline-flex items-center gap-2 rounded-xl px-5 py-2 text-sm font-semibold transition-all disabled:opacity-50 ${
              saved ? 'bg-emerald-600 text-white' : 'bg-[#1e3a5f] text-white hover:bg-[#24456f]'
            }`}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? '저장 중...' : saved ? '저장 완료!' : '구독 저장'}
          </button>
        </div>
      )}
    </div>
  );
}
