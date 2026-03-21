import { useState, useEffect, useCallback } from 'react';
import {
  Search, Filter, Calendar, Newspaper, X, Plus,
  CheckSquare, Square, FileText, ChevronDown, ChevronUp,
  Loader2, RefreshCw, Tag, ArrowRight
} from 'lucide-react';
import { functions, db } from '@/lib/firebase';
import { httpsCallable } from 'firebase/functions';
import { collection, getDocs, doc, getDoc } from 'firebase/firestore';
import { format, subDays, startOfDay } from 'date-fns';
import { useAuthStore } from '@/store/useAuthStore';
import { useNavigate } from 'react-router-dom';

const DATE_PRESETS = [
  { label: '오늘', days: 0 },
  { label: '3일', days: 3 },
  { label: '1주', days: 7 },
  { label: '2주', days: 14 },
  { label: '1개월', days: 30 },
];

const STATUS_OPTIONS = [
  { value: 'analyzed', label: 'AI 분석 완료' },
  { value: 'published', label: '보고서 포함됨' },
  { value: 'pending_filter', label: '필터링 대기' },
  { value: 'collected', label: '수집됨' },
];

function TagInput({
  tags, onChange, placeholder
}: { tags: string[]; onChange: (t: string[]) => void; placeholder: string }) {
  const [input, setInput] = useState('');
  const add = () => {
    const v = input.trim();
    if (v && !tags.includes(v)) onChange([...tags, v]);
    setInput('');
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 min-h-[36px] px-3 py-1.5 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg">
      {tags.map(t => (
        <span key={t} className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#1e3a5f]/10 dark:bg-[#1e3a5f]/30 text-[#1e3a5f] dark:text-blue-300 rounded text-xs font-medium">
          {t}
          <button type="button" onClick={() => onChange(tags.filter(x => x !== t))}>
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      <input
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        placeholder={tags.length === 0 ? placeholder : ''}
        className="flex-1 min-w-[120px] outline-none text-sm bg-transparent text-gray-900 dark:text-white placeholder-gray-400"
      />
    </div>
  );
}

interface ArticleItem {
  id: string;
  title: string;
  source: string;
  publishedAt: any;
  status: string;
  summary: string[];
  category: string;
  tags: string[];
  relevanceScore: number;
  content: string;
  url: string;
}

export default function Articles() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const companyId = (user as any)?.primaryCompanyId || (user as any)?.companyIds?.[0] || null;

  // 검색 필터 상태
  const [keywords, setKeywords] = useState<string[]>([]);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>(['analyzed', 'published']);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(true);

  // 매체 목록
  const [sources, setSources] = useState<{ id: string; name: string }[]>([]);

  // 결과 상태
  const [articles, setArticles] = useState<ArticleItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  // 기사 선택 상태
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // 기사 원문 팝업
  const [previewArticle, setPreviewArticle] = useState<ArticleItem | null>(null);

  useEffect(() => {
    if (companyId) loadSources();
  }, [companyId]);

  const loadSources = async () => {
    try {
      const subDoc = await getDoc(doc(db, 'companySourceSubscriptions', companyId));
      const subscribedIds: string[] = subDoc.exists() ? (subDoc.data() as any).sourceIds || [] : [];
      if (subscribedIds.length === 0) return;
      const snap = await getDocs(collection(db, 'globalSources'));
      const all = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
      setSources(all.filter(s => subscribedIds.includes(s.id)).map(s => ({ id: s.id, name: s.name })));
    } catch (err) {
      console.error('loadSources error:', err);
    }
  };

  const handleSearch = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setSearched(true);
    try {
      const fn = httpsCallable(functions, 'searchArticles');
      const result = await fn({
        companyId,
        keywords,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        sourceIds: selectedSourceIds.length > 0 ? selectedSourceIds : undefined,
        statuses: selectedStatuses.length > 0 ? selectedStatuses : undefined,
        limit: 100,
        offset: 0,
      }) as any;
      setArticles(result.data.articles || []);
      setTotal(result.data.total || 0);
    } catch (err: any) {
      console.error('searchArticles error:', err);
      alert('검색 실패: ' + err.message);
    } finally {
      setLoading(false);
    }
  }, [companyId, keywords, startDate, endDate, selectedSourceIds, selectedStatuses]);

  const applyDatePreset = (days: number) => {
    const now = new Date();
    if (days === 0) {
      setStartDate(format(startOfDay(now), "yyyy-MM-dd'T'HH:mm"));
      setEndDate(format(now, "yyyy-MM-dd'T'HH:mm"));
    } else {
      setStartDate(format(startOfDay(subDays(now, days)), "yyyy-MM-dd'T'HH:mm"));
      setEndDate(format(now, "yyyy-MM-dd'T'HH:mm"));
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === articles.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(articles.map(a => a.id)));
    }
  };

  const toggleStatus = (status: string) => {
    setSelectedStatuses(prev =>
      prev.includes(status) ? prev.filter(s => s !== status) : [...prev, status]
    );
  };

  const toggleSource = (id: string) => {
    setSelectedSourceIds(prev =>
      prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id]
    );
  };

  const handleCreateReport = () => {
    if (selectedIds.size === 0) {
      alert('보고서에 포함할 기사를 선택해주세요.');
      return;
    }
    const ids = Array.from(selectedIds).join(',');
    navigate(`/reports/new?articleIds=${ids}`);
  };

  const formatDate = (ts: any) => {
    if (!ts) return '';
    try {
      const d = ts?.toDate ? ts.toDate() : new Date(ts);
      return format(d, 'yyyy.MM.dd HH:mm');
    } catch { return ''; }
  };

  const getStatusBadge = (status: string) => {
    const map: Record<string, { label: string; cls: string }> = {
      analyzed: { label: 'AI 분석', cls: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
      published: { label: '보고서 포함', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
      pending_filter: { label: '대기', cls: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' },
      collected: { label: '수집', cls: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400' },
      filtered_out: { label: '필터링됨', cls: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400' },
    };
    const s = map[status] || { label: status, cls: 'bg-gray-100 text-gray-500' };
    return <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${s.cls}`}>{s.label}</span>;
  };

  return (
    <div className="space-y-5 pb-12">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">기사 검색</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">수집된 기사를 검색하고 선택하여 분석 보고서를 생성하세요.</p>
        </div>
        {selectedIds.size > 0 && (
          <button
            onClick={handleCreateReport}
            className="flex items-center gap-2 px-5 py-2.5 bg-[#d4af37] text-white rounded-lg font-semibold text-sm hover:bg-[#b8942d] transition-colors shadow-md"
          >
            <FileText className="w-4 h-4" />
            선택 기사 {selectedIds.size}건 · 보고서 생성
            <ArrowRight className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* 검색 필터 */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <button
          className="w-full px-5 py-4 flex items-center justify-between text-left"
          onClick={() => setShowFilters(v => !v)}
        >
          <span className="flex items-center gap-2 font-semibold text-gray-900 dark:text-white text-sm">
            <Filter className="w-4 h-4 text-[#1e3a5f] dark:text-blue-400" />
            검색 필터
          </span>
          {showFilters ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
        </button>

        {showFilters && (
          <div className="px-5 pb-5 space-y-4 border-t border-gray-100 dark:border-gray-700 pt-4">
            {/* 키워드 */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5">
                <Search className="inline w-3.5 h-3.5 mr-1" />검색 키워드 (Enter로 추가)
              </label>
              <TagInput tags={keywords} onChange={setKeywords} placeholder="키워드 입력 후 Enter..." />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* 날짜 범위 */}
              <div>
                <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5">
                  <Calendar className="inline w-3.5 h-3.5 mr-1" />기사 날짜 범위
                </label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {DATE_PRESETS.map(p => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => applyDatePreset(p.days)}
                      className="px-2.5 py-1 rounded text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-[#1e3a5f] hover:text-white transition-colors"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2 items-center">
                  <input type="datetime-local" value={startDate} onChange={e => setStartDate(e.target.value)}
                    className="flex-1 px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                  <span className="text-gray-400 text-sm">~</span>
                  <input type="datetime-local" value={endDate} onChange={e => setEndDate(e.target.value)}
                    className="flex-1 px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                </div>
              </div>

              {/* 기사 상태 */}
              <div>
                <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5">
                  기사 상태
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {STATUS_OPTIONS.map(s => (
                    <button
                      key={s.value}
                      type="button"
                      onClick={() => toggleStatus(s.value)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all ${
                        selectedStatuses.includes(s.value)
                          ? 'bg-[#1e3a5f] text-white border-[#1e3a5f]'
                          : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600'
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 매체 선택 */}
            {sources.length > 0 && (
              <div>
                <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5">
                  <Newspaper className="inline w-3.5 h-3.5 mr-1" />매체 선택 (미선택 시 전체)
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {sources.map(src => (
                    <button
                      key={src.id}
                      type="button"
                      onClick={() => toggleSource(src.id)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all ${
                        selectedSourceIds.includes(src.id)
                          ? 'bg-[#1e3a5f] text-white border-[#1e3a5f]'
                          : 'bg-white dark:bg-gray-700 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-600'
                      }`}
                    >
                      {src.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 검색 버튼 */}
            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={handleSearch}
                disabled={loading}
                className="flex items-center gap-2 px-5 py-2 bg-[#1e3a5f] text-white rounded-lg font-medium text-sm hover:bg-[#2a4a73] transition-colors disabled:opacity-50"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                검색
              </button>
              <button
                type="button"
                onClick={() => { setKeywords([]); setStartDate(''); setEndDate(''); setSelectedStatuses(['analyzed', 'published']); setSelectedSourceIds([]); }}
                className="flex items-center gap-1.5 px-3 py-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-sm"
              >
                <RefreshCw className="w-3.5 h-3.5" />초기화
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 결과 */}
      {searched && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
          {/* 결과 헤더 */}
          <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
            <div className="flex items-center gap-3">
              {articles.length > 0 && (
                <button
                  type="button"
                  onClick={toggleAll}
                  className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                >
                  {selectedIds.size === articles.length
                    ? <CheckSquare className="w-4 h-4 text-[#1e3a5f]" />
                    : <Square className="w-4 h-4" />
                  }
                  전체 선택
                </button>
              )}
              <span className="text-sm text-gray-500 dark:text-gray-400">
                총 <strong className="text-gray-900 dark:text-white">{total}</strong>건
                {selectedIds.size > 0 && (
                  <span className="ml-2 text-[#1e3a5f] dark:text-blue-400 font-semibold">
                    ({selectedIds.size}건 선택됨)
                  </span>
                )}
              </span>
            </div>
            {selectedIds.size > 0 && (
              <button
                onClick={handleCreateReport}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-[#d4af37] text-white rounded-lg font-semibold text-sm hover:bg-[#b8942d] transition-colors"
              >
                <FileText className="w-3.5 h-3.5" />
                보고서 생성
              </button>
            )}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-7 h-7 animate-spin text-gray-300" />
            </div>
          ) : articles.length === 0 ? (
            <div className="py-16 text-center text-gray-400">
              <Search className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium">검색 결과가 없습니다.</p>
              <p className="text-sm mt-1">키워드나 날짜 범위를 조정해보세요.</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-gray-700">
              {articles.map(article => {
                const selected = selectedIds.has(article.id);
                return (
                  <div
                    key={article.id}
                    className={`flex items-start gap-3 px-5 py-4 transition-colors cursor-pointer group ${
                      selected
                        ? 'bg-blue-50/50 dark:bg-blue-900/10'
                        : 'hover:bg-gray-50 dark:hover:bg-gray-700/30'
                    }`}
                    onClick={() => toggleSelect(article.id)}
                  >
                    {/* 체크박스 */}
                    <div className="mt-0.5 flex-shrink-0">
                      {selected
                        ? <CheckSquare className="w-5 h-5 text-[#1e3a5f] dark:text-blue-400" />
                        : <Square className="w-5 h-5 text-gray-300 dark:text-gray-600 group-hover:text-gray-400" />
                      }
                    </div>

                    {/* 기사 내용 */}
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        {getStatusBadge(article.status)}
                        <span className="text-xs text-gray-500 dark:text-gray-400 font-medium">{article.source}</span>
                        {article.category && (
                          <span className="text-xs text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded">
                            {article.category}
                          </span>
                        )}
                        {article.relevanceScore > 0 && (
                          <span className="text-[10px] text-green-600 dark:text-green-400 font-semibold">
                            관련도 {Math.round(article.relevanceScore * 100)}%
                          </span>
                        )}
                        <span className="text-xs text-gray-400 ml-auto">{formatDate(article.publishedAt)}</span>
                      </div>

                      <h3 className="text-sm font-semibold text-gray-900 dark:text-white line-clamp-2 mb-1.5">
                        {article.title}
                      </h3>

                      {article.summary.length > 0 && (
                        <ul className="space-y-0.5 mb-1.5">
                          {article.summary.slice(0, 2).map((s, i) => (
                            <li key={i} className="text-xs text-gray-500 dark:text-gray-400 line-clamp-1">· {s}</li>
                          ))}
                        </ul>
                      )}

                      {article.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {article.tags.slice(0, 5).map(tag => (
                            <span key={tag} className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 rounded">
                              <Tag className="w-2.5 h-2.5" />{tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 원문 보기 */}
                    <button
                      onClick={e => { e.stopPropagation(); setPreviewArticle(article); }}
                      className="flex-shrink-0 mt-0.5 px-2.5 py-1 text-xs text-gray-400 dark:text-gray-500 hover:text-[#1e3a5f] dark:hover:text-blue-400 border border-gray-200 dark:border-gray-600 rounded hover:border-[#1e3a5f] transition-colors"
                    >
                      원문
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 하단 고정 선택 버튼 */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40">
          <button
            onClick={handleCreateReport}
            className="flex items-center gap-2.5 px-6 py-3 bg-[#d4af37] text-white rounded-full font-bold text-sm shadow-xl hover:bg-[#b8942d] transition-colors"
          >
            <FileText className="w-4 h-4" />
            {selectedIds.size}건 선택 · 분석 보고서 생성하기
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* 기사 원문 팝업 */}
      {previewArticle && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setPreviewArticle(null)}>
          <div
            className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[80vh] overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  {getStatusBadge(previewArticle.status)}
                  <span className="text-xs text-gray-500">{previewArticle.source}</span>
                  <span className="text-xs text-gray-400">{formatDate(previewArticle.publishedAt)}</span>
                </div>
                <h3 className="font-bold text-gray-900 dark:text-white text-base leading-snug">{previewArticle.title}</h3>
              </div>
              <button onClick={() => setPreviewArticle(null)} className="ml-3 flex-shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-5">
              {previewArticle.summary.length > 0 && (
                <div className="mb-4">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">AI 요약</p>
                  <ul className="space-y-1.5">
                    {previewArticle.summary.map((s, i) => (
                      <li key={i} className="text-sm text-gray-700 dark:text-gray-300">· {s}</li>
                    ))}
                  </ul>
                </div>
              )}
              {previewArticle.content && (
                <div>
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">기사 원문</p>
                  <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">
                    {previewArticle.content}
                  </p>
                </div>
              )}
              {!previewArticle.content && previewArticle.summary.length === 0 && (
                <p className="text-sm text-gray-400">원문 내용이 없습니다.</p>
              )}
            </div>
            <div className="px-6 py-4 border-t border-gray-100 dark:border-gray-700 flex items-center gap-3">
              <button
                onClick={() => { toggleSelect(previewArticle.id); setPreviewArticle(null); }}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  selectedIds.has(previewArticle.id)
                    ? 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
                    : 'bg-[#1e3a5f] text-white hover:bg-[#2a4a73]'
                }`}
              >
                {selectedIds.has(previewArticle.id)
                  ? <><CheckSquare className="w-4 h-4" />선택 해제</>
                  : <><Plus className="w-4 h-4" />보고서에 추가</>
                }
              </button>
              {previewArticle.url && (
                <a
                  href={previewArticle.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 underline"
                  onClick={e => e.stopPropagation()}
                >
                  원문 링크
                </a>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
