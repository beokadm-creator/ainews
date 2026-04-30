import { handleError } from "@/utils/errorHandler";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, Calendar, CheckCircle2, ExternalLink, Loader2, Search, Settings, Tag, X } from 'lucide-react';
import { httpsCallable } from 'firebase/functions';
import { format, subDays } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { functions } from '@/lib/firebase';
import { useAuthStore } from '@/store/useAuthStore';
import { formatArticleContentParagraphs } from '@/lib/articleContent';
import { getArticleReasonDetails as buildArticleReasonDetails } from '@/lib/articleReason';
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
  collectedAt?: any;
  relevanceReason?: string;
  keywordMatched?: string | null;
  keywordPrefilterReason?: string;
  relevanceBasis?: 'keyword_reject' | 'ai' | 'keyword_prefilter';
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

function toDate(value: any): Date | null {
  if (!value) return null;
  try {
    const d = typeof value?.toDate === 'function' ? value.toDate() : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function getArticleDate(article: TrackedArticle): Date | null {
  return toDate(article.publishedAt) ?? toDate(article.collectedAt);
}

function formatArticleDate(article: TrackedArticle): string {
  const d = getArticleDate(article);
  return d ? format(d, 'yyyy.MM.dd HH:mm') : '';
}

function getDateLabel(article: TrackedArticle): string {
  const d = getArticleDate(article);
  return d ? format(d, 'yyyy.MM.dd') : '날짜 확인 중';
}

function defaultDateRange() {
  const now = new Date();
  return {
    start: format(subDays(now, 30), "yyyy-MM-dd'T'HH:mm"),
    end: format(now, "yyyy-MM-dd'T'HH:mm"),
  };
}

const LAST_CHECKED_KEY = (companyId: string) => `tracked_last_checked_${companyId}`;

export default function TrackedCompanies() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const companyId = (user as any)?.primaryCompanyId || (user as any)?.companyIds?.[0] || (user as any)?.companyId || null;
  const defaults = defaultDateRange();

  const [companies, setCompanies] = useState<string[]>(DEFAULT_TRACKED_COMPANIES);
  // '' = 전체
  const [selectedCompany, setSelectedCompany] = useState<string>(DEFAULT_TRACKED_COMPANIES[0] || '');
  const [startDate, setStartDate] = useState(defaults.start);
  const [endDate, setEndDate] = useState(defaults.end);
  const [articles, setArticles] = useState<TrackedArticle[]>([]);
  const [loading, setLoading] = useState(false);
  const [previewArticle, setPreviewArticle] = useState<TrackedArticle | null>(null);

  // 마지막 확인 시각 (localStorage)
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const updateCheckedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 텔레그램 알림 그룹 현황
  const [tgAlertGroups, setTgAlertGroups] = useState<{ id: string; name: string; chatId: string }[]>([]);

  useEffect(() => {
    if (!companyId) return;
    const fn = httpsCallable(functions, 'getTelegramGroups');
    fn({ companyId }).then((result: any) => {
      const groups = (result.data?.groups || []) as any[];
      setTgAlertGroups(groups.filter((g: any) => g.trackedCompanyAlerts));
    }).catch(() => { /* 무시 */ });
  }, [companyId]);

  useEffect(() => {
    if (!companyId) return;
    const loadSettings = async () => {
      const fn = httpsCallable(functions, 'getTrackedCompanies');
      const result = await fn({ companyId }) as any;
      const trackedCompanies = Array.isArray(result.data?.trackedCompanies) && result.data.trackedCompanies.length > 0
        ? result.data.trackedCompanies
        : DEFAULT_TRACKED_COMPANIES;
      setCompanies(trackedCompanies);
      setSelectedCompany((prev) => prev !== '' ? prev : trackedCompanies[0] || '');
    };
    loadSettings().catch(handleError);
  }, [companyId]);

  // lastCheckedAt 읽기
  useEffect(() => {
    if (!companyId) return;
    const raw = localStorage.getItem(LAST_CHECKED_KEY(companyId));
    if (raw) {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) setLastCheckedAt(d);
    }
  }, [companyId]);

  const loadArticles = useCallback(async () => {
    if (!companyId) return;
    if (selectedCompany !== '' && !selectedCompany) return;
    setLoading(true);
    try {
      const fn = httpsCallable(functions, 'searchArticles');
      const keywords = selectedCompany === '' ? companies : [selectedCompany];
      const result = await fn({
        companyId,
        keywords,
        startDate,
        endDate,
        statuses: ['analyzed', 'published'],
        limit: 200,
        offset: 0,
      }) as any;
      setArticles(result.data?.articles || []);

      // 기사 로드 후 5초 뒤에 lastCheckedAt 갱신
      if (updateCheckedTimer.current) clearTimeout(updateCheckedTimer.current);
      updateCheckedTimer.current = setTimeout(() => {
        if (!companyId) return;
        const now = new Date();
        localStorage.setItem(LAST_CHECKED_KEY(companyId), now.toISOString());
        setLastCheckedAt(now);
      }, 5000);
    } finally {
      setLoading(false);
    }
  }, [companyId, companies, endDate, selectedCompany, startDate]);

  useEffect(() => {
    void loadArticles();
  }, [loadArticles]);

  useEffect(() => {
    return () => {
      if (updateCheckedTimer.current) clearTimeout(updateCheckedTimer.current);
    };
  }, []);

  // 기사를 날짜별로 그루핑, NEW 여부 판별
  const { groupedArticles, newCount } = useMemo(() => {
    const grouped = new Map<string, TrackedArticle[]>();
    let newCount = 0;

    for (const article of articles) {
      const label = getDateLabel(article);
      const bucket = grouped.get(label) || [];
      bucket.push(article);
      grouped.set(label, bucket);

      if (lastCheckedAt) {
        const d = getArticleDate(article);
        if (d && d > lastCheckedAt) newCount++;
      }
    }

    return {
      groupedArticles: Array.from(grouped.entries()),
      newCount,
    };
  }, [articles, lastCheckedAt]);

  const isNew = useCallback((article: TrackedArticle) => {
    if (!lastCheckedAt) return false;
    const d = getArticleDate(article);
    return d ? d > lastCheckedAt : false;
  }, [lastCheckedAt]);

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
          {lastCheckedAt && (
            <span className="ml-2 text-gray-400">
              · 마지막 확인 {format(lastCheckedAt, 'MM.dd HH:mm')}
            </span>
          )}
        </p>
      </div>

      {/* 텔레그램 알림 현황 배너 */}
      <div className={`flex items-center justify-between gap-4 rounded-xl border px-4 py-3 ${
        tgAlertGroups.length > 0
          ? 'border-sky-200 bg-sky-50 dark:border-sky-500/30 dark:bg-sky-500/10'
          : 'border-gray-200 bg-gray-50 dark:border-gray-700/60 dark:bg-gray-800/40'
      }`}>
        <div className="flex items-center gap-2.5">
          {tgAlertGroups.length > 0 ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-sky-500" />
          ) : (
            <Bell className="h-4 w-4 shrink-0 text-gray-400" />
          )}
          <div>
            {tgAlertGroups.length > 0 ? (
              <>
                <p className="text-xs font-semibold text-sky-700 dark:text-sky-300">
                  텔레그램 알림 활성 — {tgAlertGroups.map(g => g.name).join(', ')}
                </p>
                <p className="mt-0.5 text-[11px] text-sky-600/80 dark:text-sky-400/80">
                  추적 회사 기사가 새로 수집되면 위 그룹으로 자동 발송됩니다.
                </p>
              </>
            ) : (
              <>
                <p className="text-xs font-semibold text-gray-600 dark:text-gray-300">텔레그램 알림 미설정</p>
                <p className="mt-0.5 text-[11px] text-gray-400">텔레그램 그룹을 설정하면 기사 감지 시 자동으로 알림을 받을 수 있습니다.</p>
              </>
            )}
          </div>
        </div>
        <button
          onClick={() => navigate('/delivery')}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-sky-300 bg-white px-3 py-1.5 text-xs font-medium text-sky-600 hover:bg-sky-50 dark:border-sky-500/40 dark:bg-transparent dark:text-sky-400"
        >
          <Settings className="h-3.5 w-3.5" />
          그룹 설정
        </button>
      </div>

      {/* Filter card */}
      <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
        <div className="p-4">
          <div className="flex flex-wrap gap-2">
            {/* 전체 버튼 */}
            <button
              key="__all__"
              type="button"
              onClick={() => setSelectedCompany('')}
              className={`rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                selectedCompany === ''
                  ? 'border-[#1e3a5f] bg-[#1e3a5f] text-white'
                  : 'border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300 dark:border-gray-700/60 dark:bg-gray-900/30 dark:text-gray-300 dark:hover:border-gray-500'
              }`}
            >
              전체
            </button>
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

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void loadArticles()}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-xl bg-[#1e3a5f] px-4 py-2 text-sm font-semibold text-white hover:bg-[#24456f] disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              기사 갱신
            </button>
            {newCount > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-3 py-1 text-xs font-semibold text-red-600 dark:bg-red-500/10 dark:text-red-400">
                <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
                신규 {newCount}건
              </span>
            )}
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
          groupedArticles.map(([dateLabel, items], groupIndex) => {
            // 이 그룹에 신규 기사가 있는지 확인
            const hasNewInGroup = items.some(a => isNew(a));
            // 이전 그룹들이 모두 NEW였는데 이 그룹부터 OLD인 경우 → 구분선 표시
            const prevGroupsAllNew = groupIndex > 0 &&
              groupedArticles.slice(0, groupIndex).every(([, prevItems]) => prevItems.some(a => isNew(a)));
            const showNewDivider = prevGroupsAllNew && !hasNewInGroup;

            return (
              <div key={dateLabel}>
                {/* 신규/기존 구분선 */}
                {showNewDivider && (
                  <div className="my-3 flex items-center gap-3">
                    <div className="flex-1 border-t border-dashed border-gray-300 dark:border-gray-600" />
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">이전 기사</span>
                    <div className="flex-1 border-t border-dashed border-gray-300 dark:border-gray-600" />
                  </div>
                )}
                <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
                  <div className={`flex items-center gap-2 border-b px-4 py-2.5 dark:border-gray-700/40 ${
                    hasNewInGroup ? 'border-red-100 bg-red-50/40 dark:border-red-500/20 dark:bg-red-500/5' : 'border-gray-100'
                  }`}>
                    <span className="text-xs font-semibold text-gray-500 dark:text-gray-400">{dateLabel}</span>
                    {hasNewInGroup && (
                      <span className="rounded-full bg-red-500 px-1.5 py-px text-[10px] font-bold text-white leading-none">NEW</span>
                    )}
                  </div>
                  <ul className="divide-y divide-gray-100 dark:divide-gray-700/40">
                    {items.map((article) => {
                      const articleIsNew = isNew(article);
                      return (
                        <li key={article.id}>
                          <button
                            type="button"
                            onClick={() => setPreviewArticle(article)}
                            className="w-full px-4 py-3 text-left transition hover:bg-gray-50 dark:hover:bg-white/5"
                          >
                            <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
                              {articleIsNew && (
                                <span className="rounded-sm bg-red-500 px-1.5 py-px text-[10px] font-bold text-white leading-none">N</span>
                              )}
                              <span>{article.source}</span>
                              {article.keywordMatched && selectedCompany === '' && (
                                <span className="rounded-sm bg-blue-50 px-1.5 py-px text-[10px] font-medium text-blue-600 dark:bg-blue-500/10 dark:text-blue-400">
                                  {article.keywordMatched}
                                </span>
                              )}
                              {article.category && (
                                <span className="rounded-sm bg-gray-100 px-1.5 py-px dark:bg-gray-700 dark:text-gray-300">{article.category}</span>
                              )}
                              <span className="ml-auto">{formatArticleDate(article)}</span>
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
                      );
                    })}
                  </ul>
                </section>
              </div>
            );
          })
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
                  <span>{formatArticleDate(previewArticle)}</span>
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
