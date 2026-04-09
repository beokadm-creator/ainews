import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { BarChart3, BookOpen, Clock3, FileText, Loader2, Newspaper } from 'lucide-react';
import { format } from 'date-fns';
import { ko } from 'date-fns/locale';
import { db, functions } from '@/lib/firebase';
import { useAuthStore } from '@/store/useAuthStore';

function formatTimestamp(value: any) {
  if (!value) return '—';
  try {
    const date = value?.toDate ? value.toDate() : new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return format(date, 'yyyy.MM.dd HH:mm', { locale: ko });
  } catch {
    return '—';
  }
}

export default function History() {
  const { user } = useAuthStore();
  const companyId = (user as any)?.primaryCompanyId;
  const [loading, setLoading] = useState(true);
  const [reports, setReports] = useState<any[]>([]);
  const [articles, setArticles] = useState<any[]>([]);

  useEffect(() => {
    if (!companyId) return;

    async function loadHistory() {
      setLoading(true);
      try {
        const searchArticles = httpsCallable(functions, 'searchArticles');
        const [reportSnap, articleResult] = await Promise.all([
          getDocs(query(collection(db, 'outputs'), where('companyId', '==', companyId), orderBy('createdAt', 'desc'), limit(100))),
          searchArticles({
            companyId,
            statuses: ['analyzed', 'published'],
            limit: 20,
            offset: 0,
          }) as Promise<any>,
        ]);

        setReports(
          reportSnap.docs
            .map((doc) => ({ id: doc.id, ...(doc.data() as any) }))
            .filter((item: any) => item.companyId === companyId)
            .sort((a: any, b: any) => {
              const aTime = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : 0;
              const bTime = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : 0;
              return bTime - aTime;
            })
        );
        setArticles(articleResult?.data?.articles || []);
      } finally {
        setLoading(false);
      }
    }

    loadHistory().catch(console.error);
  }, [companyId]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-12">
      {/* Header */}
      <div className="border-b border-gray-200 pb-5 dark:border-gray-700/60">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">이력</h1>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          실제 운영 중인 내부 리포트와 최근 분석 기사 흐름을 함께 확인합니다.
        </p>
      </div>

      {loading ? (
        <div className="flex min-h-[320px] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-[#1e3a5f] dark:text-gray-400" />
        </div>
      ) : (
        <>
          {/* Stat cards */}
          <div className="grid gap-4 md:grid-cols-3">
            {[
              { icon: FileText, label: '리포트 이력', value: reports.length.toString(), accent: 'text-[#1e3a5f] dark:text-blue-400' },
              { icon: Newspaper, label: '최근 분석 기사', value: articles.length.toString(), accent: 'text-emerald-600 dark:text-emerald-400' },
              { icon: Clock3, label: '마지막 리포트 생성', value: reports[0]?.createdAt ? formatTimestamp(reports[0].createdAt).slice(5) : '—', accent: 'text-amber-600 dark:text-amber-400' },
            ].map((stat) => (
              <div key={stat.label} className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700/60 dark:bg-gray-800/60">
                <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                  <stat.icon className="h-3.5 w-3.5" />
                  {stat.label}
                </div>
                <p className={`mt-2 text-2xl font-bold tabular-nums ${stat.accent}`}>{stat.value}</p>
              </div>
            ))}
          </div>

          {/* Report + article lists */}
          <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
            {/* Reports */}
            <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
              <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-700/40">
                <div className="flex items-center gap-2">
                  <BookOpen className="h-3.5 w-3.5 text-[#d4af37]" />
                  <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">리포트 이력</span>
                </div>
                <Link to="/briefing" className="text-[11px] text-[#d4af37] hover:underline">전체 보기</Link>
              </div>
              <ul className="divide-y divide-gray-100 dark:divide-gray-700/40">
                {reports.length === 0 ? (
                  <li className="px-5 py-12 text-center text-sm text-gray-400">생성된 리포트가 없습니다.</li>
                ) : (
                  reports.map((report) => (
                    <li key={report.id}>
                      <Link
                        to={`/briefing?outputId=${report.id}`}
                        className="block px-4 py-3 transition-colors hover:bg-gray-50 dark:hover:bg-white/5"
                      >
                        <p className="truncate text-sm font-medium text-gray-900 dark:text-white">{report.title}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
                          <span className="rounded-sm bg-gray-100 px-1.5 py-px dark:bg-gray-700 dark:text-gray-300">
                            {report.type === 'custom_report' ? '맞춤 리포트' : '브리핑'}
                          </span>
                          <span>기사 {report.articleCount || 0}건</span>
                          <span>{formatTimestamp(report.createdAt)}</span>
                        </div>
                      </Link>
                    </li>
                  ))
                )}
              </ul>
            </div>

            {/* Articles */}
            <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
              <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-700/40">
                <div className="flex items-center gap-2">
                  <BarChart3 className="h-3.5 w-3.5 text-[#1e3a5f] dark:text-blue-400" />
                  <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">최근 분석 기사</span>
                </div>
                <Link to="/articles" className="text-[11px] text-[#d4af37] hover:underline">기사 검색</Link>
              </div>
              <ul className="divide-y divide-gray-100 dark:divide-gray-700/40">
                {articles.length === 0 ? (
                  <li className="px-5 py-12 text-center text-sm text-gray-400">표시할 분석 기사가 없습니다.</li>
                ) : (
                  articles.map((article) => (
                    <li key={article.id}>
                      <Link
                        to={`/articles?highlight=${article.id}`}
                        className="block px-4 py-3 transition-colors hover:bg-gray-50 dark:hover:bg-white/5"
                      >
                        <p className="line-clamp-2 text-sm font-medium text-gray-900 dark:text-white">{article.title}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
                          <span>{article.source}</span>
                          {article.category && (
                            <span className="rounded-sm bg-gray-100 px-1.5 py-px dark:bg-gray-700 dark:text-gray-300">{article.category}</span>
                          )}
                          <span>{formatTimestamp(article.publishedAt)}</span>
                        </div>
                      </Link>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
