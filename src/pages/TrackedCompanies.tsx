import { useCallback, useEffect, useMemo, useState } from 'react';
import { Building2, Calendar, ExternalLink, Loader2, Search, Tag, X } from 'lucide-react';
import { httpsCallable } from 'firebase/functions';
import { format, subDays } from 'date-fns';
import { functions } from '@/lib/firebase';
import { useAuthStore } from '@/store/useAuthStore';
import { formatArticleContentParagraphs } from '@/lib/articleContent';
import { DEFAULT_TRACKED_COMPANIES } from '@/lib/trackedCompanies';

interface TrackedArticle {
  id: string;
  title: string;
  source: string;
  category?: string;
  tags?: string[];
  summary?: string[];
  content?: string;
  url?: string;
  publishedAt?: any;
  relevanceReason?: string;
  keywordMatched?: string | null;
  keywordPrefilterReason?: string;
  relevanceBasis?: 'keyword_reject' | 'ai' | 'priority_source_override' | 'priority_source_fallback';
  aiRelevanceReason?: string;
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

function getAnalysisBasisLabel(basis?: TrackedArticle['relevanceBasis']) {
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

function getArticleReasonDetails(article: TrackedArticle) {
  const analysisReasonRaw = normalizeReasonText(article.aiRelevanceReason || article.relevanceReason);
  const analysisReason = !isInternalExclusionReason(analysisReasonRaw) ? analysisReasonRaw : '';
  const analysisBasisLabel = getAnalysisBasisLabel(article.relevanceBasis);

  return {
    analysisReason,
    analysisBasisLabel,
  };
}

function formatPublishedAt(value: any) {
  if (!value) return '';
  try {
    const date = typeof value?.toDate === 'function' ? value.toDate() : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return format(date, 'yyyy.MM.dd HH:mm');
  } catch {
    return '';
  }
}

function defaultDateRange() {
  const now = new Date();
  return {
    start: format(subDays(now, 30), "yyyy-MM-dd'T'HH:mm"),
    end: format(now, "yyyy-MM-dd'T'HH:mm"),
  };
}

export default function TrackedCompanies() {
  const { user } = useAuthStore();
  const companyId = (user as any)?.primaryCompanyId || (user as any)?.companyIds?.[0] || (user as any)?.companyId || null;
  const defaults = defaultDateRange();

  const [companies, setCompanies] = useState<string[]>(DEFAULT_TRACKED_COMPANIES);
  const [selectedCompany, setSelectedCompany] = useState<string>(DEFAULT_TRACKED_COMPANIES[0] || '');
  const [startDate, setStartDate] = useState(defaults.start);
  const [endDate, setEndDate] = useState(defaults.end);
  const [articles, setArticles] = useState<TrackedArticle[]>([]);
  const [loading, setLoading] = useState(false);
  const [previewArticle, setPreviewArticle] = useState<TrackedArticle | null>(null);

  useEffect(() => {
    if (!companyId) return;
    const loadSettings = async () => {
      const fn = httpsCallable(functions, 'getTrackedCompanies');
      const result = await fn({ companyId }) as any;
      const trackedCompanies = Array.isArray(result.data?.trackedCompanies) && result.data.trackedCompanies.length > 0
        ? result.data.trackedCompanies
        : DEFAULT_TRACKED_COMPANIES;
      setCompanies(trackedCompanies);
      setSelectedCompany((prev) => prev || trackedCompanies[0] || '');
    };
    loadSettings().catch(console.error);
  }, [companyId]);

  const loadArticles = useCallback(async () => {
    if (!companyId || !selectedCompany) return;
    setLoading(true);
    try {
      const fn = httpsCallable(functions, 'searchArticles');
      const result = await fn({
        companyId,
        keywords: [selectedCompany],
        startDate,
        endDate,
        statuses: ['analyzed', 'published'],
        limit: 200,
        offset: 0,
      }) as any;
      setArticles(result.data?.articles || []);
    } finally {
      setLoading(false);
    }
  }, [companyId, endDate, selectedCompany, startDate]);

  useEffect(() => {
    void loadArticles();
  }, [loadArticles]);

  const groupedArticles = useMemo(() => {
    const grouped = new Map<string, TrackedArticle[]>();
    for (const article of articles) {
      const label = formatPublishedAt(article.publishedAt)?.slice(0, 10) || '\uB0A0\uC9DC \uBBF8\uC0C1';
      const bucket = grouped.get(label) || [];
      bucket.push(article);
      grouped.set(label, bucket);
    }
    return Array.from(grouped.entries());
  }, [articles]);

  const previewContentParagraphs = useMemo(
    () => formatArticleContentParagraphs(previewArticle?.content || ''),
    [previewArticle],
  );

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <div className="border-b border-gray-200 pb-5 dark:border-gray-700/60">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">관심등록회사</h1>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          추적 회사 키워드로 수집된 기사를 일자별로 바로 확인합니다.
        </p>
      </div>

      {/* Filter card */}
      <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
        <div className="p-4">
          <div className="flex flex-wrap gap-2">
            {companies.map((company) => (
              <button
                key={company}
                type="button"
                onClick={() => setSelectedCompany(company)}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                  selectedCompany === company
                    ? 'border-[#1e3a5f] bg-[#1e3a5f] text-white'
                    : 'border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300 dark:border-gray-700/60 dark:bg-gray-900/30 dark:text-gray-300 dark:hover:border-gray-500'
                }`}
              >
                {company}
              </button>
            ))}
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                <Calendar className="h-3 w-3" />시작
              </span>
              <input
                type="datetime-local"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm outline-none transition focus:border-[#1e3a5f] dark:border-gray-700/60 dark:bg-gray-900/40 dark:text-white dark:focus:border-blue-400"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                <Calendar className="h-3 w-3" />종료
              </span>
              <input
                type="datetime-local"
                value={endDate}
                onChange={(event) => setEndDate(event.target.value)}
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm outline-none transition focus:border-[#1e3a5f] dark:border-gray-700/60 dark:bg-gray-900/40 dark:text-white dark:focus:border-blue-400"
              />
            </label>
          </div>

          <div className="mt-3">
            <button
              type="button"
              onClick={() => void loadArticles()}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-xl bg-[#1e3a5f] px-4 py-2 text-sm font-semibold text-white hover:bg-[#24456f] disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              기사 갱신
            </button>
          </div>
        </div>
      </div>

      {/* Article list */}
      <div className="space-y-4">
        {loading ? (
          <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-[#1e3a5f] dark:text-gray-400" /></div>
        ) : groupedArticles.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-200 px-6 py-12 text-center text-sm text-gray-400 dark:border-gray-700/60">
            조건에 맞는 관심 회사 기사가 없습니다.
          </div>
        ) : (
          groupedArticles.map(([dateLabel, items]) => (
            <section key={dateLabel} className="rounded-xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
              <div className="border-b border-gray-100 px-4 py-2.5 dark:border-gray-700/40">
                <span className="text-xs font-semibold text-gray-500 dark:text-gray-400">{dateLabel}</span>
              </div>
              <ul className="divide-y divide-gray-100 dark:divide-gray-700/40">
                {items.map((article) => (
                  <li key={article.id}>
                    <button
                      type="button"
                      onClick={() => setPreviewArticle(article)}
                      className="w-full px-4 py-3 text-left transition hover:bg-gray-50 dark:hover:bg-white/5"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
                        <span>{article.source}</span>
                        {article.category && (
                          <span className="rounded-sm bg-gray-100 px-1.5 py-px dark:bg-gray-700 dark:text-gray-300">{article.category}</span>
                        )}
                        <span className="ml-auto">{formatPublishedAt(article.publishedAt)}</span>
                      </div>
                      <div className="mt-1 text-sm font-medium text-gray-900 dark:text-white">{article.title}</div>
                      {article.tags?.length ? (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {article.tags.slice(0, 5).map((tagName) => (
                            <span key={tagName} className="inline-flex items-center gap-0.5 rounded-sm bg-gray-100 px-1.5 py-px text-[10px] text-gray-500 dark:bg-gray-700 dark:text-gray-300">
                              <Tag className="h-2.5 w-2.5" />
                              {tagName}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      {/* Article preview modal */}
      {previewArticle && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm" onClick={() => setPreviewArticle(null)}>
          <div
            className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700/60 dark:bg-gray-900"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-700/60">
              <div className="min-w-0 flex-1 pr-4">
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
                  <span>{previewArticle.source}</span>
                  {previewArticle.category && <span className="rounded-sm bg-gray-100 px-1.5 py-px dark:bg-gray-700 dark:text-gray-300">{previewArticle.category}</span>}
                  <span>{formatPublishedAt(previewArticle.publishedAt)}</span>
                </div>
                <h3 className="mt-2 text-base font-bold text-gray-900 dark:text-white">{previewArticle.title}</h3>
              </div>
              <button onClick={() => setPreviewArticle(null)} className="shrink-0 rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/10 dark:hover:text-gray-200">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {(() => {
                const reasonDetails = getArticleReasonDetails(previewArticle);
                return (reasonDetails.analysisBasisLabel || reasonDetails.analysisReason) ? (
                  <div className="mb-5 rounded-lg border border-gray-100 bg-gray-50 p-3 dark:border-gray-700/40 dark:bg-gray-800/60">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">분석 근거</p>
                    <div className="mt-2 space-y-1 text-xs text-gray-700 dark:text-gray-300">
                      {reasonDetails.analysisBasisLabel ? <p>{reasonDetails.analysisBasisLabel}</p> : null}
                      {reasonDetails.analysisReason ? <p>{reasonDetails.analysisReason}</p> : null}
                    </div>
                  </div>
                ) : null;
              })()}
              {previewArticle.summary?.length ? (
                <div className="mb-5">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-400">AI Summary</p>
                  <div className="rounded-lg border border-[#1e3a5f]/10 bg-[#1e3a5f]/5 p-3 dark:border-blue-500/20 dark:bg-blue-500/10">
                    <ul className="space-y-1.5">
                      {previewArticle.summary.map((line, index) => (
                        <li key={index} className="flex gap-2 text-xs text-gray-700 dark:text-gray-300">
                          <span className="shrink-0 text-gray-400">—</span>
                          <span>{line}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : null}
              <div className="mb-5 grid gap-3 md:grid-cols-2">
                <div className="rounded-lg border border-gray-100 bg-gray-50 p-3 dark:border-gray-700/40 dark:bg-gray-800/60">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-400">태그</p>
                  <div className="flex flex-wrap gap-1">
                    {(previewArticle.tags || []).map((tagName) => (
                      <span key={tagName} className="rounded-sm bg-white px-2 py-0.5 text-[11px] text-gray-600 dark:bg-gray-700 dark:text-gray-300">{tagName}</span>
                    ))}
                  </div>
                </div>
                <div className="rounded-lg border border-gray-100 bg-gray-50 p-3 dark:border-gray-700/40 dark:bg-gray-800/60">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-400">카테고리</p>
                  <p className="text-xs text-gray-700 dark:text-gray-300">{previewArticle.category || '—'}</p>
                </div>
              </div>
              <div>
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-400">기사 원문</p>
                <div className="space-y-3">
                  {previewContentParagraphs.length > 0 ? (
                    previewContentParagraphs.map((paragraph, index) => (
                      <p key={`${previewArticle.id}-${index}`} className="text-sm leading-7 text-gray-700 dark:text-gray-300">{paragraph}</p>
                    ))
                  ) : (
                    <p className="text-sm text-gray-400">원문 본문이 저장되지 않은 기사입니다.</p>
                  )}
                </div>
              </div>
            </div>
            <div className="border-t border-gray-100 px-5 py-3 dark:border-gray-700/60">
              {previewArticle.url ? (
                <a href={previewArticle.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-xs text-gray-500 hover:text-gray-700 hover:underline dark:text-gray-400 dark:hover:text-gray-200">
                  <ExternalLink className="h-3.5 w-3.5" />
                  원문 링크 열기
                </a>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
