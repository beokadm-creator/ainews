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
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{'\uAD00\uC2EC\uB4F1\uB85D\uD68C\uC0AC'}</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {'\uCD94\uC801 \uD68C\uC0AC \uD0A4\uC6CC\uB4DC\uB85C \uC218\uC9D1\uB41C \uAE30\uC0AC\uB97C \uC77C\uC790\uBCC4\uB85C \uBC14\uB85C \uD655\uC778\uD569\uB2C8\uB2E4.'}
        </p>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-wrap gap-2">
          {companies.map((company) => (
            <button
              key={company}
              type="button"
              onClick={() => setSelectedCompany(company)}
              className={`rounded-full border px-3 py-1.5 text-sm transition ${
                selectedCompany === company
                  ? 'border-[#1e3a5f] bg-[#1e3a5f] text-white'
                  : 'border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-900/30 dark:text-gray-300'
              }`}
            >
              {company}
            </button>
          ))}
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="text-sm text-gray-600 dark:text-gray-300">
            <span className="mb-2 inline-flex items-center gap-1"><Calendar className="h-4 w-4" />{'\uC2DC\uC791'}</span>
            <input
              type="datetime-local"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
              className="mt-2 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm outline-none focus:border-[#1e3a5f] dark:border-gray-700 dark:bg-gray-900/30 dark:text-white"
            />
          </label>
          <label className="text-sm text-gray-600 dark:text-gray-300">
            <span className="mb-2 inline-flex items-center gap-1"><Calendar className="h-4 w-4" />{'\uC885\uB8CC'}</span>
            <input
              type="datetime-local"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
              className="mt-2 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm outline-none focus:border-[#1e3a5f] dark:border-gray-700 dark:bg-gray-900/30 dark:text-white"
            />
          </label>
        </div>

        <div className="mt-4">
          <button
            type="button"
            onClick={() => void loadArticles()}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-xl bg-[#1e3a5f] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#24456f] disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            {'\uAE30\uC0AC \uAC31\uC2E0'}
          </button>
        </div>
      </div>

      <div className="space-y-5">
        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-[#1e3a5f]" /></div>
        ) : groupedArticles.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-gray-300 bg-white px-6 py-12 text-center text-sm text-gray-400 dark:border-gray-700 dark:bg-gray-800">
            {'\uC870\uAC74\uC5D0 \uB9DE\uB294 \uAD00\uC2EC \uD68C\uC0AC \uAE30\uC0AC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.'}
          </div>
        ) : (
          groupedArticles.map(([dateLabel, items]) => (
            <section key={dateLabel} className="rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
              <div className="border-b border-gray-100 px-5 py-3 text-sm font-semibold text-gray-900 dark:border-gray-700 dark:text-white">
                {dateLabel}
              </div>
              <div className="divide-y divide-gray-100 dark:divide-gray-700">
                {items.map((article) => (
                  <button
                    key={article.id}
                    type="button"
                    onClick={() => setPreviewArticle(article)}
                    className="w-full px-5 py-4 text-left transition hover:bg-gray-50 dark:hover:bg-gray-700/20"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                      <span>{article.source}</span>
                      {article.category && (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 dark:bg-gray-700">{article.category}</span>
                      )}
                      <span className="ml-auto">{formatPublishedAt(article.publishedAt)}</span>
                    </div>
                    <div className="mt-1 text-sm font-semibold text-gray-900 dark:text-white">{article.title}</div>
                    {article.tags?.length ? (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {article.tags.slice(0, 5).map((tagName) => (
                          <span key={tagName} className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500 dark:bg-gray-700 dark:text-gray-300">
                            <Tag className="h-2.5 w-2.5" />
                            {tagName}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </button>
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      {previewArticle && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" onClick={() => setPreviewArticle(null)}>
          <div
            className="flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-gray-800"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-gray-200 px-6 py-4 dark:border-gray-700">
              <div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                  <span>{previewArticle.source}</span>
                  {previewArticle.category && <span>{previewArticle.category}</span>}
                  <span>{formatPublishedAt(previewArticle.publishedAt)}</span>
                </div>
                <h3 className="mt-2 text-lg font-bold text-gray-900 dark:text-white">{previewArticle.title}</h3>
              </div>
              <button onClick={() => setPreviewArticle(null)}><X className="h-5 w-5 text-gray-400" /></button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-5">
              {previewArticle.summary?.length ? (
                <div className="mb-6">
                  <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">AI Summary</p>
                  <div className="mt-3 space-y-2">
                    {previewArticle.summary.map((line, index) => (
                      <p key={index} className="text-sm text-gray-700 dark:text-gray-300">- {line}</p>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="mb-6 grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/40">
                  <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">{'\uBD84\uB958 \uADFC\uAC70'}</p>
                  <div className="mt-2 space-y-1 text-sm text-gray-700 dark:text-gray-300">
                    {previewArticle.keywordMatched ? <p>{`\uC81C\uBAA9 \uD0A4\uC6CC\uB4DC \uB9E4\uCE6D: "${previewArticle.keywordMatched}"`}</p> : null}
                    {previewArticle.keywordPrefilterReason ? <p>{previewArticle.keywordPrefilterReason}</p> : null}
                    {previewArticle.relevanceReason ? <p>{previewArticle.relevanceReason}</p> : null}
                  </div>
                </div>
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/40">
                  <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">{'\uD0DC\uADF8'}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {(previewArticle.tags || []).map((tagName) => (
                      <span key={tagName} className="rounded-full bg-white px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                        {tagName}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">{'\uAE30\uC0AC \uC6D0\uBB38'}</p>
                <div className="mt-3 space-y-4">
                  {previewContentParagraphs.length > 0 ? (
                    previewContentParagraphs.map((paragraph, index) => (
                      <p key={`${previewArticle.id}-${index}`} className="text-sm leading-7 text-gray-700 dark:text-gray-300">
                        {paragraph}
                      </p>
                    ))
                  ) : (
                    <p className="text-sm leading-7 text-gray-700 dark:text-gray-300">{'\uC6D0\uBB38 \uBCF8\uBB38\uC774 \uC800\uC7A5\uB418\uC9C0 \uC54A\uC740 \uAE30\uC0AC\uC785\uB2C8\uB2E4.'}</p>
                  )}
                </div>
              </div>
            </div>
            <div className="border-t border-gray-100 px-6 py-4 dark:border-gray-700">
              {previewArticle.url ? (
                <a
                  href={previewArticle.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-sm text-gray-500 underline dark:text-gray-300"
                >
                  <ExternalLink className="h-4 w-4" />
                  {'\uC6D0\uBB38 \uB9C1\uD06C \uC5F4\uAE30'}
                </a>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
