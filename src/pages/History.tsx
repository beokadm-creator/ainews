import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { BarChart3, BookOpen, Clock3, FileText, Loader2, Newspaper } from 'lucide-react';
import { format } from 'date-fns';
import { ko } from 'date-fns/locale';
import { db, functions } from '@/lib/firebase';
import { useAuthStore } from '@/store/useAuthStore';

function formatTimestamp(value: any) {
  if (!value) return '-';
  try {
    const date = value?.toDate ? value.toDate() : new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return format(date, 'yyyy.MM.dd HH:mm', { locale: ko });
  } catch {
    return '-';
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
          getDocs(query(collection(db, 'outputs'), where('companyId', '==', companyId))),
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
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">이력</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          실제 운영 중인 내부 리포트와 최근 분석 기사 흐름을 함께 확인합니다.
        </p>
      </div>

      {loading ? (
        <div className="flex min-h-[320px] items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-[#1e3a5f]" />
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 dark:bg-blue-500/10">
                  <FileText className="h-5 w-5 text-blue-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-gray-900 dark:text-white">{reports.length}</p>
                  <p className="text-xs text-gray-400">리포트 이력</p>
                </div>
              </div>
            </div>
            <div className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-green-50 dark:bg-green-500/10">
                  <Newspaper className="h-5 w-5 text-green-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-gray-900 dark:text-white">{articles.length}</p>
                  <p className="text-xs text-gray-400">최근 분석 기사</p>
                </div>
              </div>
            </div>
            <div className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-50 dark:bg-amber-500/10">
                  <Clock3 className="h-5 w-5 text-amber-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-gray-900 dark:text-white">
                    {reports[0]?.createdAt ? formatTimestamp(reports[0].createdAt).slice(5) : '-'}
                  </p>
                  <p className="text-xs text-gray-400">마지막 리포트 생성</p>
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
            <section className="rounded-2xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
              <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-gray-700">
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
                  <BookOpen className="h-4 w-4 text-[#d4af37]" />
                  리포트 이력
                </div>
                <Link to="/briefing" className="text-xs text-[#d4af37] hover:underline">전체 보기</Link>
              </div>
              <div className="divide-y divide-gray-100 dark:divide-gray-700">
                {reports.length === 0 ? (
                  <div className="px-5 py-12 text-center text-sm text-gray-400">생성된 리포트가 없습니다.</div>
                ) : (
                  reports.map((report) => (
                    <Link
                      key={report.id}
                      to={`/briefing?outputId=${report.id}`}
                      className="block px-5 py-4 transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/30"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-gray-900 dark:text-white">{report.title}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-400">
                            <span>{report.type === 'custom_report' ? '맞춤 리포트' : '브리핑'}</span>
                            <span>참고 기사 {report.articleCount || 0}건</span>
                            <span>{formatTimestamp(report.createdAt)}</span>
                          </div>
                        </div>
                      </div>
                    </Link>
                  ))
                )}
              </div>
            </section>

            <section className="rounded-2xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
              <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-gray-700">
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
                  <BarChart3 className="h-4 w-4 text-[#1e3a5f]" />
                  최근 분석 기사
                </div>
                <Link to="/articles" className="text-xs text-[#d4af37] hover:underline">기사 검색</Link>
              </div>
              <div className="divide-y divide-gray-100 dark:divide-gray-700">
                {articles.length === 0 ? (
                  <div className="px-5 py-12 text-center text-sm text-gray-400">표시할 분석 기사가 없습니다.</div>
                ) : (
                  articles.map((article) => (
                    <Link
                      key={article.id}
                      to={`/articles?highlight=${article.id}`}
                      className="block px-5 py-4 transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/30"
                    >
                      <p className="line-clamp-2 text-sm font-medium text-gray-900 dark:text-white">{article.title}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-400">
                        <span>{article.source}</span>
                        {article.category && <span>{article.category}</span>}
                        <span>{formatTimestamp(article.publishedAt)}</span>
                      </div>
                    </Link>
                  ))
                )}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
