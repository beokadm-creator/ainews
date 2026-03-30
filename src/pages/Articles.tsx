import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Calendar,
  CheckSquare,
  FileText,
  Filter,
  Globe,
  Loader2,
  Newspaper,
  Plus,
  RefreshCw,
  Search,
  Square,
  Tag,
  X,
} from 'lucide-react';
import { format, subHours } from 'date-fns';
import { doc, getDoc, getDocs, collection } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { useNavigate } from 'react-router-dom';
import { db, functions } from '@/lib/firebase';
import { useAuthStore } from '@/store/useAuthStore';
import { dedupeSourceCatalog } from '@/lib/sourceCatalog';
import { formatArticleContentParagraphs } from '@/lib/articleContent';
import { getArticleReasonDetails as buildArticleReasonDetails } from '@/lib/articleReason';

const DATE_PRESETS = [
  { label: '최근 24시간', hours: 24 },
  { label: '최근 3일', hours: 72 },
  { label: '최근 7일', hours: 168 },
  { label: '최근 15일', hours: 360 },
  { label: '최근 1개월', hours: 720 },
];

function getDefaultDateRange() {
  const now = new Date();
  return {
    startDate: format(subHours(now, 24), "yyyy-MM-dd'T'HH:mm"),
    endDate: format(now, "yyyy-MM-dd'T'HH:mm"),
  };
}

function toSafeDate(value: any): Date | null {
  if (!value) return null;

  try {
    if (typeof value?.toDate === 'function') {
      const converted = value.toDate();
      return Number.isNaN(converted?.getTime?.()) ? null : converted;
    }

    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }

    if (typeof value === 'string' || typeof value === 'number') {
      const converted = new Date(value);
      return Number.isNaN(converted.getTime()) ? null : converted;
    }
  } catch {
    return null;
  }

  return null;
}

function formatPublishedAt(value: any) {
  const safeDate = toSafeDate(value);
  if (!safeDate) return '';
  try {
    return format(safeDate, 'yyyy.MM.dd HH:mm');
  } catch {
    return '';
  }
}

function TagInput({
  tags,
  onChange,
  placeholder,
}: {
  tags: string[];
  onChange: (value: string[]) => void;
  placeholder: string;
}) {
  const [input, setInput] = useState('');

  const addTag = () => {
    const value = input.trim();
    if (value && !tags.includes(value)) onChange([...tags, value]);
    setInput('');
  };

  return (
    <div className="flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 transition focus-within:border-[#1e3a5f] dark:border-gray-700/60 dark:bg-gray-900/40">
      {tags.map((tag) => (
        <span key={tag} className="inline-flex items-center gap-1 rounded-md bg-[#1e3a5f]/10 px-2 py-0.5 text-xs font-medium text-[#1e3a5f] dark:bg-blue-500/10 dark:text-blue-300">
          {tag}
          <button type="button" onClick={() => onChange(tags.filter((item) => item !== tag))}>
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            addTag();
          }
        }}
        placeholder={tags.length === 0 ? placeholder : ''}
        className="min-w-[160px] flex-1 bg-transparent text-sm outline-none dark:text-white"
      />
    </div>
  );
}

interface ArticleItem {
  id: string;
  title: string;
  source: string;
  sourceId?: string;
  publishedAt: any;
  status: string;
  summary: string[];
  category: string;
  tags: string[];
  relevanceScore?: number;
  relevanceBasis?: 'keyword_reject' | 'ai' | 'priority_source_override' | 'priority_source_fallback' | 'priority_source_bypass' | 'keyword_prefilter';
  relevanceReason?: string;
  aiRelevanceReason?: string;
  keywordMatched?: string | null;
  keywordPrefilterReason?: string;
  priorityAnalysisReason?: string;
  content: string;
  url: string;
}

function normalizeReasonText(value?: string | null) {
  return `${value || ''}`.replace(/\s+/g, ' ').trim();
}

function isInternalExclusionReason(value?: string | null) {
  const normalized = normalizeReasonText(value).toLowerCase();
  if (!normalized) return false;

  return [
    'sports context article',
    '스포츠 문맥 기사 제외',
    'contains excluded keyword',
    'missing required keyword',
    '제목 키워드 매칭',
    '우선 매체 수집',
  ].some((token) => normalized.includes(token.toLowerCase()));
}

function getAnalysisBasisLabel(basis?: ArticleItem['relevanceBasis']) {
  switch (basis) {
    case 'ai':
      return '원문 AI 관련성 검토 통과';
    case 'priority_source_override':
      return '우선 매체 예외로 분석 진행';
    case 'priority_source_fallback':
      return '우선 매체 예외 보류 통과로 분석 진행';
    case 'keyword_reject':
      return '';
    default:
      return '분석 단계 진행';
  }
}

function getArticleReasonDetails(article: ArticleItem) {
  const analysisReasonRaw = normalizeReasonText(article.aiRelevanceReason || article.relevanceReason);
  const analysisReason = !isInternalExclusionReason(analysisReasonRaw) ? analysisReasonRaw : '';
  const analysisBasisLabel = getAnalysisBasisLabel(article.relevanceBasis);

  return {
    analysisReason,
    analysisBasisLabel,
  };
}

interface SourceItem {
  id: string;
  name: string;
  category?: string;
  localScraperId?: string;
}

const PAGE_SIZE = 50;

export default function Articles() {
  const { user } = useAuthStore();
  const companyId = (user as any)?.primaryCompanyId || (user as any)?.companyIds?.[0] || null;
  const navigate = useNavigate();
  const defaults = getDefaultDateRange();

  const [keywords, setKeywords] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [startDate, setStartDate] = useState(defaults.startDate);
  const [endDate, setEndDate] = useState(defaults.endDate);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [articles, setArticles] = useState<ArticleItem[]>([]);
  const [totalResults, setTotalResults] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searched, setSearched] = useState(false);
  const [previewArticle, setPreviewArticle] = useState<ArticleItem | null>(null);

  useEffect(() => {
    const next = getDefaultDateRange();
    setKeywords([]);
    setSelectedCategories([]);
    setSelectedSourceIds([]);
    setStartDate(next.startDate);
    setEndDate(next.endDate);
    setArticles([]);
    setTotalResults(0);
    setHasMore(false);
    setSelectedIds(new Set());
    setSearched(false);
  }, []);

  useEffect(() => {
    if (!companyId) return;
    const loadSources = async () => {
      const subDoc = await getDoc(doc(db, 'companySourceSubscriptions', companyId));
      const subscribedIds: string[] = subDoc.exists() ? ((subDoc.data() as any).subscribedSourceIds || []) : [];
      const sourceSnap = await getDocs(collection(db, 'globalSources'));
      const available = dedupeSourceCatalog(
        sourceSnap.docs
        .map((item) => ({ id: item.id, ...(item.data() as any) }))
        .filter((item) => subscribedIds.includes(item.id))
      ).map((item) => ({ id: item.id, name: item.name, category: item.category, localScraperId: item.localScraperId }));
      setSources(available);
    };
    loadSources().catch(console.error);
  }, [companyId]);

  const runSearch = useCallback(async (offset = 0, append = false) => {
    if (!companyId) return;
    if (append) setLoadingMore(true);
    else {
      setLoading(true);
      setSearched(true);
    }
    try {
      const fn = httpsCallable(functions, 'searchArticles');
      const result = await fn({
        companyId,
        keywords,
        categories: selectedCategories,
        startDate,
        endDate,
        sourceIds: selectedSourceIds.length > 0 ? selectedSourceIds : undefined,
        statuses: ['analyzed', 'published'],
        limit: PAGE_SIZE,
        offset,
      }) as any;
      const nextArticles = result.data?.articles || [];
      setArticles((prev) => append ? [...prev, ...nextArticles] : nextArticles);
      setTotalResults(Number(result.data?.total || 0));
      setHasMore(Boolean(result.data?.hasMore));
      if (!append) {
        setSelectedIds(new Set());
      }
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [companyId, endDate, keywords, selectedCategories, selectedSourceIds, startDate]);

  const handleSearch = useCallback(async () => {
    await runSearch(0, false);
  }, [runSearch]);

  const handleLoadMore = useCallback(async () => {
    await runSearch(articles.length, true);
  }, [articles.length, runSearch]);

  const applyDatePreset = (hours: number) => {
    const now = new Date();
    setStartDate(format(subHours(now, hours), "yyyy-MM-dd'T'HH:mm"));
    setEndDate(format(now, "yyyy-MM-dd'T'HH:mm"));
  };

  const toggleSource = (sourceId: string) => {
    setSelectedSourceIds((prev) => prev.includes(sourceId) ? prev.filter((id) => id !== sourceId) : [...prev, sourceId]);
  };

  const toggleCategory = (category: string) => {
    setSelectedCategories((prev) => prev.includes(category) ? prev.filter((item) => item !== category) : [...prev, category]);
  };

  const toggleSelect = (articleId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(articleId)) next.delete(articleId);
      else next.add(articleId);
      return next;
    });
  };

  const createReportFromSelection = () => {
    if (selectedIds.size === 0) return;
    navigate(`/reports/new?articleIds=${Array.from(selectedIds).join(',')}`);
  };

  const createReportFromFilters = () => {
    const params = new URLSearchParams();
    if (keywords.length > 0) params.set('keywords', keywords.join(','));
    if (selectedCategories.length > 0) params.set('categories', selectedCategories.join(','));
    if (selectedSourceIds.length > 0) params.set('sourceIds', selectedSourceIds.join(','));
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    navigate(`/reports/new?${params.toString()}`);
  };

  const allSelected = useMemo(
    () => articles.length > 0 && selectedIds.size === articles.length,
    [articles.length, selectedIds.size],
  );
  const availableCategories = useMemo(
    () => Array.from(new Set(articles.map((article) => article.category).filter(Boolean))),
    [articles],
  );
  const previewContentParagraphs = useMemo(
    () => formatArticleContentParagraphs(previewArticle?.content || ''),
    [previewArticle],
  );

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-200 pb-5 dark:border-gray-700/60">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">기사 검색</h1>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            최근 기간과 매체를 고른 뒤 기사 원문을 확인하고, 선택 기사 또는 검색 결과 전체로 내부 리포트를 생성합니다.
          </p>
        </div>
        {selectedIds.size > 0 ? (
          <button
            onClick={createReportFromSelection}
            className="inline-flex items-center gap-2 rounded-xl bg-[#d4af37] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#c59f2c]"
          >
            <FileText className="h-4 w-4" />
            선택 기사 {selectedIds.size}건 리포트
            <ArrowRight className="h-4 w-4" />
          </button>
        ) : searched && articles.length > 0 ? (
          <button
            onClick={createReportFromFilters}
            className="inline-flex items-center gap-2 rounded-xl bg-[#1e3a5f] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#24456f]"
          >
            <FileText className="h-4 w-4" />
            검색 결과 전체 리포트
          </button>
        ) : null}
      </div>

      {/* Filter card */}
      <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
        <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3 dark:border-gray-700/40">
          <Filter className="h-3.5 w-3.5 text-[#1e3a5f] dark:text-blue-400" />
          <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">리포트용 검색 조건</span>
        </div>

        <div className="space-y-4 p-4">
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">키워드</label>
            <TagInput tags={keywords} onChange={setKeywords} placeholder="예: PE, 인수금융, 구조조정" />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1.5 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                <Calendar className="h-3 w-3" />기사 기간
              </label>
              <div className="mb-2 flex flex-wrap gap-1.5">
                {DATE_PRESETS.map((preset) => (
                  <button key={preset.label} type="button" onClick={() => applyDatePreset(preset.hours)}
                    className="rounded-md bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-600 hover:bg-[#1e3a5f] hover:text-white dark:bg-gray-700 dark:text-gray-300">
                    {preset.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input type="datetime-local" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm outline-none focus:border-[#1e3a5f] dark:border-gray-700/60 dark:bg-gray-900/40 dark:text-white" />
                <span className="shrink-0 text-gray-400">~</span>
                <input type="datetime-local" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm outline-none focus:border-[#1e3a5f] dark:border-gray-700/60 dark:bg-gray-900/40 dark:text-white" />
              </div>
            </div>

            <div>
              <label className="mb-1.5 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                <Newspaper className="h-3 w-3" />대상 매체
              </label>
              <div className="flex flex-wrap gap-1.5">
                {sources.map((source) => (
                  <button key={source.id} type="button" onClick={() => toggleSource(source.id)}
                    className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
                      selectedSourceIds.includes(source.id)
                        ? 'border-[#1e3a5f] bg-[#1e3a5f] text-white'
                        : 'border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300 dark:border-gray-700/60 dark:bg-gray-900/30 dark:text-gray-300'
                    }`}>
                    {source.name}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button onClick={handleSearch} disabled={loading}
              className="inline-flex items-center gap-2 rounded-xl bg-[#1e3a5f] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#24456f] disabled:opacity-50">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}검색
            </button>
            <button type="button" onClick={() => {
              const next = getDefaultDateRange();
              setKeywords([]); setSelectedCategories([]); setSelectedSourceIds([]);
              setStartDate(next.startDate); setEndDate(next.endDate);
              setArticles([]); setTotalResults(0); setHasMore(false);
              setSelectedIds(new Set()); setSearched(false);
            }} className="inline-flex items-center gap-2 rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700/60 dark:text-gray-300 dark:hover:bg-white/5">
              <RefreshCw className="h-4 w-4" />초기화
            </button>
          </div>
        </div>
      </div>

      {searched && (
        <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
          {/* Results toolbar */}
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-700/40">
            <div className="flex items-center gap-3 text-xs text-gray-600 dark:text-gray-300">
              <button type="button" onClick={() => setSelectedIds(allSelected ? new Set() : new Set(articles.map((a) => a.id)))}
                className="inline-flex items-center gap-1.5">
                {allSelected ? <CheckSquare className="h-4 w-4 text-[#1e3a5f]" /> : <Square className="h-4 w-4 text-gray-400" />}
                전체 선택
              </button>
              <span className="text-gray-400">|</span>
              <span>검색 결과 {articles.length}건</span>
              {selectedIds.size > 0 && <span className="font-semibold text-[#1e3a5f] dark:text-blue-400">{selectedIds.size}건 선택됨</span>}
            </div>
            {articles.length > 0 && selectedIds.size === 0 && (
              <button onClick={createReportFromFilters} className="rounded-lg bg-[#1e3a5f] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#24456f]">
                결과 전체 리포트
              </button>
            )}
          </div>

          {/* Category filters */}
          {availableCategories.length > 0 && (
            <div className="border-b border-gray-100 px-4 py-2.5 dark:border-gray-700/40">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">카테고리</span>
                {availableCategories.map((category) => (
                  <button key={category} type="button" onClick={() => toggleCategory(category)}
                    className={`rounded-md border px-2 py-0.5 text-[11px] transition ${
                      selectedCategories.includes(category)
                        ? 'border-[#1e3a5f] bg-[#1e3a5f] text-white'
                        : 'border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-700/60 dark:bg-gray-900/30 dark:text-gray-300'
                    }`}>
                    {category}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Article rows */}
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-gray-300 dark:text-gray-600" />
            </div>
          ) : articles.length === 0 ? (
            <div className="py-16 text-center text-sm text-gray-400">조건에 맞는 분석 완료 기사가 없습니다.</div>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-700/40">
              {articles.map((article) => {
                const selected = selectedIds.has(article.id);
                const reasonDetails = buildArticleReasonDetails(article);
                return (
                  <li key={article.id}
                    onClick={() => toggleSelect(article.id)}
                    className={`flex cursor-pointer items-start gap-3 px-4 py-3 transition ${
                      selected ? 'bg-[#1e3a5f]/5 dark:bg-blue-500/10' : 'hover:bg-gray-50 dark:hover:bg-white/5'
                    }`}
                  >
                    <div className="mt-0.5 shrink-0">
                      {selected ? <CheckSquare className="h-4 w-4 text-[#1e3a5f]" /> : <Square className="h-4 w-4 text-gray-300 dark:text-gray-600" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
                        <span>{article.source}</span>
                        {article.category && <span className="rounded-sm bg-gray-100 px-1.5 py-px dark:bg-gray-700 dark:text-gray-300">{article.category}</span>}
                        {typeof article.relevanceScore === 'number' && (
                          <span className="text-emerald-600 dark:text-emerald-400">관련도 {Math.round(article.relevanceScore)}/100</span>
                        )}
                        <span className="ml-auto">{formatPublishedAt(article.publishedAt)}</span>
                      </div>
                      <p className="mt-0.5 text-sm font-medium text-gray-900 dark:text-white">{article.title}</p>
                      <div className="mt-1 space-y-0.5">
                        {(article.summary || []).slice(0, 2).map((line, index) => (
                          <p key={index} className="text-[11px] text-gray-500 dark:text-gray-400">— {line}</p>
                        ))}
                      </div>
                      {(reasonDetails.analysisBasisLabel || reasonDetails.analysisReason) && (
                        <div className="mt-1.5 rounded-md bg-gray-50 px-2.5 py-1.5 text-[11px] text-gray-500 dark:bg-gray-900/40 dark:text-gray-400">
                          {reasonDetails.analysisBasisLabel ? <p>분석: {reasonDetails.analysisBasisLabel}</p> : null}
                          {reasonDetails.analysisReason ? <p className="mt-0.5">근거: {reasonDetails.analysisReason}</p> : null}
                        </div>
                      )}
                      {article.tags?.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {article.tags.slice(0, 5).map((tagName) => (
                            <span key={tagName} className="inline-flex items-center gap-0.5 rounded-sm bg-gray-100 px-1.5 py-px text-[10px] text-gray-500 dark:bg-gray-700 dark:text-gray-300">
                              <Tag className="h-2.5 w-2.5" />{tagName}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); setPreviewArticle(article); }}
                      className="shrink-0 rounded-lg border border-gray-200 px-2.5 py-1.5 text-[11px] font-medium text-gray-500 hover:border-[#1e3a5f] hover:text-[#1e3a5f] dark:border-gray-700/60 dark:text-gray-300">
                      원문
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {hasMore && (
            <div className="border-t border-gray-100 px-4 py-3 dark:border-gray-700/40">
              <button onClick={handleLoadMore} disabled={loadingMore}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700/60 dark:text-gray-300 dark:hover:bg-white/5">
                {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                더 50건 불러오기
              </button>
            </div>
          )}
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2">
          <button onClick={createReportFromSelection}
            className="inline-flex items-center gap-2 rounded-full bg-[#d4af37] px-6 py-3 text-sm font-bold text-white shadow-xl hover:bg-[#c59f2c]">
            <Plus className="h-4 w-4" />선택 기사 {selectedIds.size}건으로 리포트 만들기
          </button>
        </div>
      )}

      {/* Article preview modal */}
      {previewArticle && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm" onClick={() => setPreviewArticle(null)}>
          <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700/60 dark:bg-gray-900"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-700/60">
              <div className="min-w-0 flex-1 pr-4">
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
                  <span>{previewArticle.source}</span>
                  {formatPublishedAt(previewArticle.publishedAt) && <span>{formatPublishedAt(previewArticle.publishedAt)}</span>}
                </div>
                <h3 className="mt-2 text-base font-bold text-gray-900 dark:text-white">{previewArticle.title}</h3>
              </div>
              <button onClick={() => setPreviewArticle(null)} className="shrink-0 rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/10 dark:hover:text-gray-200">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {(() => {
                const reasonDetails = buildArticleReasonDetails(previewArticle);
                return (reasonDetails.analysisBasisLabel || reasonDetails.analysisReason) ? (
                  <div className="mb-4 rounded-lg border border-gray-100 bg-gray-50 p-3 dark:border-gray-700/40 dark:bg-gray-800/60">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">분석 근거</p>
                    <div className="mt-1.5 space-y-1 text-xs text-gray-700 dark:text-gray-300">
                      {reasonDetails.analysisBasisLabel ? <p>{reasonDetails.analysisBasisLabel}</p> : null}
                      {reasonDetails.analysisReason ? <p>{reasonDetails.analysisReason}</p> : null}
                    </div>
                  </div>
                ) : null;
              })()}
              {previewArticle.summary?.length > 0 && (
                <div className="mb-4">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-400">AI 요약</p>
                  <div className="rounded-lg border border-[#1e3a5f]/10 bg-[#1e3a5f]/5 p-3 dark:border-blue-500/20 dark:bg-blue-500/10">
                    <ul className="space-y-1.5">
                      {previewArticle.summary.map((line, index) => (
                        <li key={index} className="flex gap-2 text-xs text-gray-700 dark:text-gray-300">
                          <span className="shrink-0 text-gray-400">—</span><span>{line}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
              <div>
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-400">기사 원문</p>
                <div className="space-y-3">
                  {previewContentParagraphs.length > 0 ? (
                    previewContentParagraphs.map((paragraph, index) => (
                      <p key={`${previewArticle.id}-paragraph-${index}`} className="text-sm leading-7 text-gray-700 dark:text-gray-300">{paragraph}</p>
                    ))
                  ) : (
                    <p className="text-sm text-gray-400">원문 전문이 저장되지 않은 기사입니다.</p>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 border-t border-gray-100 px-5 py-3 dark:border-gray-700/60">
              <button onClick={() => { toggleSelect(previewArticle.id); setPreviewArticle(null); }}
                className="rounded-xl bg-[#1e3a5f] px-4 py-2 text-sm font-semibold text-white hover:bg-[#24456f]">
                {selectedIds.has(previewArticle.id) ? '선택 해제' : '리포트에 추가'}
              </button>
              {previewArticle.url && (
                <a href={previewArticle.url} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-xs text-gray-500 hover:text-gray-700 hover:underline dark:text-gray-400 dark:hover:text-gray-200">
                  <Globe className="h-3.5 w-3.5" />원문 링크 열기
                </a>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
