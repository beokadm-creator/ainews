import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  BookOpen,
  Coins,
  FileText,
  Loader2,
  Newspaper,
  Search,
  Send,
  TrendingUp,
} from 'lucide-react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { format } from 'date-fns';
import { ko } from 'date-fns/locale';
import { db, functions } from '@/lib/firebase';
import { useAuthStore } from '@/store/useAuthStore';

interface RecentArticle {
  id: string;
  title: string;
  source: string;
  category?: string;
  relevanceScore?: number;
  relevanceBasis?: 'keyword_reject' | 'ai' | 'priority_source_override' | 'priority_source_fallback';
  publishedAt?: any;
}

interface RecentReport {
  id: string;
  title: string;
  type: string;
  articleCount: number;
  createdAt?: any;
}

function formatTimestamp(value: any) {
  if (!value) return '';
  try {
    const date = value?.toDate ? value.toDate() : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return format(date, 'M월 d일 HH:mm', { locale: ko });
  } catch {
    return '';
  }
}

function QuickAction({
  icon: Icon,
  title,
  desc,
  to,
  tone,
}: {
  icon: any;
  title: string;
  desc: string;
  to: string;
  tone: string;
}) {
  return (
    <Link
      to={to}
      className="group flex flex-col gap-3 rounded-2xl border border-gray-200 bg-white p-5 transition-all hover:-translate-y-0.5 hover:border-[#d4af37]/40 hover:shadow-md dark:border-gray-700 dark:bg-gray-800"
    >
      <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${tone}`}>
        <Icon className="h-5 w-5 text-white" />
      </div>
      <div>
        <p className="text-sm font-semibold text-gray-900 transition-colors group-hover:text-[#d4af37] dark:text-white">
          {title}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{desc}</p>
      </div>
      <div className="mt-auto flex items-center gap-1 text-xs text-gray-400 transition-colors group-hover:text-[#d4af37]">
        바로 가기
        <ArrowRight className="h-3 w-3" />
      </div>
    </Link>
  );
}

export default function UserHome() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const companyId = (user as any)?.primaryCompanyId;
  const role = (user as any)?.role;
  const canViewUsage = role === 'company_admin' || role === 'superadmin';

  const [recentArticles, setRecentArticles] = useState<RecentArticle[]>([]);
  const [recentReports, setRecentReports] = useState<RecentReport[]>([]);
  const [usage, setUsage] = useState<any>(null);
  const [todayCount, setTodayCount] = useState(0);
  const [analyzedCount, setAnalyzedCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!companyId) return;

    async function loadDashboard() {
      setLoading(true);
      try {
        const searchArticles = httpsCallable(functions, 'searchArticles');
        const usageCallable = httpsCallable(functions, 'getAiUsageSummary');

        const [articleResult, reportSnap, usageResult] = await Promise.all([
          searchArticles({
            companyId,
            statuses: ['analyzed', 'published'],
            limit: 6,
            offset: 0,
          }) as Promise<any>,
          getDocs(
            query(
              collection(db, 'outputs'),
              where('companyId', '==', companyId),
            )
          ),
          canViewUsage
            ? (usageCallable({ companyId }).catch(() => ({ data: null })) as Promise<any>)
            : Promise.resolve({ data: null }),
        ]);

        const articleData = articleResult?.data || {};
        setRecentArticles(articleData.articles || []);
        setTodayCount(Number(articleData.total || 0));
        setAnalyzedCount(Number(articleData.total || 0));

        const reports = reportSnap.docs
          .map((doc) => ({ id: doc.id, ...(doc.data() as any) }))
          .filter((report: any) => report.companyId === companyId)
          .sort((a: any, b: any) => {
            const aTime = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : 0;
            const bTime = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : 0;
            return bTime - aTime;
          })
          .slice(0, 5);
        setRecentReports(reports);
        setUsage((usageResult as any)?.data || null);
      } finally {
        setLoading(false);
      }
    }

    loadDashboard().catch(console.error);
  }, [companyId, canViewUsage]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? '좋은 아침입니다' : hour < 18 ? '안녕하세요' : '좋은 저녁입니다';
  const userName = (user as any)?.displayName || user?.email?.split('@')[0] || '사용자';

  return (
    <div className="mx-auto max-w-6xl space-y-8 pb-12">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          {greeting}, <span className="text-[#d4af37]">{userName}</span>님
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          오늘 수집된 분석 기사와 최근 리포트, AI 사용 현황을 한 번에 확인할 수 있습니다.
        </p>
      </div>

      <div className={`grid gap-4 ${canViewUsage ? 'md:grid-cols-4' : 'md:grid-cols-3'}`}>
        <div className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 dark:bg-blue-500/10">
              <Newspaper className="h-5 w-5 text-blue-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{todayCount.toLocaleString()}</p>
              <p className="text-xs text-gray-400">조회 가능한 분석 기사</p>
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-green-50 dark:bg-green-500/10">
              <TrendingUp className="h-5 w-5 text-green-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{analyzedCount.toLocaleString()}</p>
              <p className="text-xs text-gray-400">최근 분석 완료 기사</p>
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-50 dark:bg-purple-500/10">
              <BookOpen className="h-5 w-5 text-purple-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{recentReports.length}</p>
              <p className="text-xs text-gray-400">최근 리포트</p>
            </div>
          </div>
        </div>
        {canViewUsage && (
          <div className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-50 dark:bg-amber-500/10">
                <Coins className="h-5 w-5 text-amber-500" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900 dark:text-white">
                  {Number(usage?.last24h?.totalTokens || 0).toLocaleString()}
                </p>
                <p className="text-xs text-gray-400">최근 24시간 토큰</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {canViewUsage && (
        <div className="grid gap-4 md:grid-cols-3">
          {[
            { label: '최근 24시간', value: usage?.last24h?.totalTokens || 0, sub: `${usage?.last24h?.requests || 0}회 호출` },
            { label: '최근 7일', value: usage?.last7d?.totalTokens || 0, sub: `$${Number(usage?.last7d?.totalCostUSD || 0).toFixed(2)}` },
            { label: '최근 30일', value: usage?.last30d?.totalTokens || 0, sub: `$${Number(usage?.last30d?.totalCostUSD || 0).toFixed(2)}` },
          ].map((item) => (
            <div key={item.label} className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
              <p className="text-sm font-medium text-gray-600 dark:text-gray-300">{item.label}</p>
              <p className="mt-3 text-2xl font-bold text-gray-900 dark:text-white">{Number(item.value).toLocaleString()}</p>
              <p className="mt-1 text-xs text-gray-400">{item.sub}</p>
            </div>
          ))}
        </div>
      )}

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">빠른 시작</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <QuickAction icon={Search} title="기사 검색" desc="매체와 기간 기준으로 분석 완료 기사를 찾습니다." to="/articles" tone="bg-blue-500" />
          <QuickAction icon={FileText} title="리포트 생성" desc="검색 결과 전체 또는 선택 기사로 새 리포트를 생성합니다." to="/articles" tone="bg-[#d4af37]" />
          <QuickAction icon={Send} title="발송 관리" desc="메일링 그룹과 자동·수동 발송 일정을 관리합니다." to={role === 'company_admin' ? '/delivery' : '/briefing'} tone="bg-purple-500" />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">최근 분석 기사</h2>
            <Link to="/articles" className="text-xs text-[#d4af37] hover:underline">전체 보기</Link>
          </div>
          <div className="space-y-3">
            {loading ? (
              <div className="flex h-40 items-center justify-center rounded-2xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
                <Loader2 className="h-6 w-6 animate-spin text-[#1e3a5f]" />
              </div>
            ) : recentArticles.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-gray-300 bg-white px-6 py-12 text-center text-sm text-gray-400 dark:border-gray-700 dark:bg-gray-800">
                표시할 분석 기사가 없습니다.
              </div>
            ) : (
              recentArticles.map((article) => (
                <button
                  key={article.id}
                  onClick={() => navigate(`/articles?highlight=${article.id}`)}
                  className="w-full rounded-2xl border border-gray-200 bg-white p-4 text-left transition-all hover:border-[#d4af37]/40 hover:shadow-sm dark:border-gray-700 dark:bg-gray-800"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-sm font-semibold text-gray-900 dark:text-white">{article.title}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-400">
                        <span>{article.source}</span>
                        {article.category && (
                          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500 dark:bg-gray-700 dark:text-gray-300">
                            {article.category}
                          </span>
                        )}
                        <span>{formatTimestamp(article.publishedAt)}</span>
                      </div>
                    </div>
                    <span className="text-sm font-bold text-[#1e3a5f] dark:text-[#d4af37]">
                      {typeof article.relevanceScore === 'number' ? `${Math.round(article.relevanceScore)}점` : '-'}
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">최근 리포트</h2>
            <Link to="/history" className="text-xs text-[#d4af37] hover:underline">이력 보기</Link>
          </div>
          <div className="space-y-3">
            {loading ? (
              <div className="flex h-40 items-center justify-center rounded-2xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
                <Loader2 className="h-6 w-6 animate-spin text-[#1e3a5f]" />
              </div>
            ) : recentReports.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-gray-300 bg-white px-6 py-12 text-center text-sm text-gray-400 dark:border-gray-700 dark:bg-gray-800">
                생성된 리포트가 없습니다.
              </div>
            ) : (
              recentReports.map((report) => (
                <Link
                  key={report.id}
                  to={`/briefing?outputId=${report.id}`}
                  className="block rounded-2xl border border-gray-200 bg-white p-4 transition-all hover:border-[#d4af37]/40 hover:shadow-sm dark:border-gray-700 dark:bg-gray-800"
                >
                  <p className="text-sm font-semibold text-gray-900 dark:text-white">{report.title}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-400">
                    <span>{report.type === 'custom_report' ? '맞춤 리포트' : '브리핑'}</span>
                    <span>참고 기사 {report.articleCount || 0}건</span>
                    <span>{formatTimestamp(report.createdAt)}</span>
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
