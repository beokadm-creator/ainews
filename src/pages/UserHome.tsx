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
      {/* Header */}
      <div className="border-b border-gray-200 pb-5 dark:border-gray-700/60">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">
          {greeting}, <span className="text-[#d4af37]">{userName}</span>님
        </h1>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          오늘 수집된 분석 기사와 최근 리포트, AI 사용 현황을 한 번에 확인할 수 있습니다.
        </p>
      </div>

      {/* Primary stat cards */}
      <div className={`grid gap-4 ${canViewUsage ? 'md:grid-cols-4' : 'md:grid-cols-3'}`}>
        {[
          { icon: Newspaper, label: '조회 가능한 분석 기사', value: todayCount.toLocaleString(), accent: 'text-[#1e3a5f] dark:text-blue-400' },
          { icon: TrendingUp, label: '최근 분석 완료', value: analyzedCount.toLocaleString(), accent: 'text-emerald-600 dark:text-emerald-400' },
          { icon: BookOpen, label: '최근 리포트', value: recentReports.length.toString(), accent: 'text-purple-600 dark:text-purple-400' },
          ...(canViewUsage ? [{ icon: Coins, label: '24시간 토큰', value: Number(usage?.last24h?.totalTokens || 0).toLocaleString(), accent: 'text-amber-600 dark:text-amber-400' }] : []),
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

      {/* Usage breakdown */}
      {canViewUsage && (
        <div>
          <div className="mb-3 flex items-center gap-3">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">AI 사용량</span>
            <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700/60" />
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {[
              { label: '최근 24시간', value: usage?.last24h?.totalTokens || 0, sub: `${usage?.last24h?.requests || 0}회 호출` },
              { label: '최근 7일', value: usage?.last7d?.totalTokens || 0, sub: `$${Number(usage?.last7d?.totalCostUSD || 0).toFixed(2)}` },
              { label: '최근 30일', value: usage?.last30d?.totalTokens || 0, sub: `$${Number(usage?.last30d?.totalCostUSD || 0).toFixed(2)}` },
            ].map((item) => (
              <div key={item.label} className="rounded-xl border border-gray-200 bg-white px-4 py-3 dark:border-gray-700/60 dark:bg-gray-800/60">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">{item.label}</p>
                <p className="mt-1.5 text-xl font-bold tabular-nums text-gray-900 dark:text-white">{Number(item.value).toLocaleString()}</p>
                <p className="mt-0.5 text-xs text-gray-400">{item.sub}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quick actions */}
      <div>
        <div className="mb-3 flex items-center gap-3">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">빠른 시작</span>
          <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700/60" />
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {[
            { icon: Search, title: '기사 검색', desc: '매체와 기간 기준으로 분석 완료 기사를 찾습니다.', to: '/articles' },
            { icon: FileText, title: '리포트 생성', desc: '검색 결과 전체 또는 선택 기사로 새 리포트를 생성합니다.', to: '/articles', gold: true },
            { icon: Send, title: '발송 관리', desc: '메일링 그룹과 자동·수동 발송 일정을 관리합니다.', to: role === 'company_admin' ? '/delivery' : '/briefing' },
          ].map((action) => (
            <Link
              key={action.title}
              to={action.to}
              className={`group flex items-center gap-4 rounded-xl border p-4 transition-all hover:shadow-sm ${
                action.gold
                  ? 'border-[#d4af37]/30 bg-[#d4af37]/5 hover:border-[#d4af37]/60 dark:bg-[#d4af37]/10'
                  : 'border-gray-200 bg-white hover:border-gray-300 dark:border-gray-700/60 dark:bg-gray-800/60 dark:hover:border-gray-600'
              }`}
            >
              <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${action.gold ? 'bg-[#d4af37]' : 'bg-[#1e3a5f]'}`}>
                <action.icon className="h-4 w-4 text-white" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-900 dark:text-white">{action.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{action.desc}</p>
              </div>
              <ArrowRight className="h-4 w-4 shrink-0 text-gray-300 transition-colors group-hover:text-gray-500 dark:text-gray-600 dark:group-hover:text-gray-400" />
            </Link>
          ))}
        </div>
      </div>

      {/* Recent articles + reports */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Recent articles */}
        <div>
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">최근 분석 기사</span>
              <div className="h-px w-12 bg-gray-200 dark:bg-gray-700/60" />
            </div>
            <Link to="/articles" className="flex items-center gap-1 text-xs text-[#d4af37] hover:underline">
              전체 보기 <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
            {loading ? (
              <div className="flex h-48 items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-[#1e3a5f] dark:text-gray-400" />
              </div>
            ) : recentArticles.length === 0 ? (
              <div className="px-6 py-12 text-center text-sm text-gray-400">표시할 분석 기사가 없습니다.</div>
            ) : (
              <ul className="divide-y divide-gray-100 dark:divide-gray-700/40">
                {recentArticles.map((article) => (
                  <li key={article.id}>
                    <button
                      onClick={() => navigate(`/articles?highlight=${article.id}`)}
                      className="w-full px-4 py-3 text-left transition-colors hover:bg-gray-50 dark:hover:bg-white/5"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="line-clamp-1 text-sm font-medium text-gray-900 dark:text-white">{article.title}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
                            <span>{article.source}</span>
                            {article.category && (
                              <span className="rounded-sm bg-gray-100 px-1.5 py-px dark:bg-gray-700 dark:text-gray-300">{article.category}</span>
                            )}
                            <span>{formatTimestamp(article.publishedAt)}</span>
                          </div>
                        </div>
                        <span className="shrink-0 text-xs font-bold tabular-nums text-[#1e3a5f] dark:text-[#d4af37]">
                          {typeof article.relevanceScore === 'number' ? `${Math.round(article.relevanceScore)}점` : '—'}
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Recent reports */}
        <div>
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">최근 리포트</span>
              <div className="h-px w-12 bg-gray-200 dark:bg-gray-700/60" />
            </div>
            <Link to="/history" className="flex items-center gap-1 text-xs text-[#d4af37] hover:underline">
              이력 보기 <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
            {loading ? (
              <div className="flex h-48 items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-[#1e3a5f] dark:text-gray-400" />
              </div>
            ) : recentReports.length === 0 ? (
              <div className="px-6 py-12 text-center text-sm text-gray-400">생성된 리포트가 없습니다.</div>
            ) : (
              <ul className="divide-y divide-gray-100 dark:divide-gray-700/40">
                {recentReports.map((report) => (
                  <li key={report.id}>
                    <Link
                      to={`/briefing?outputId=${report.id}`}
                      className="block px-4 py-3 transition-colors hover:bg-gray-50 dark:hover:bg-white/5"
                    >
                      <p className="line-clamp-1 text-sm font-medium text-gray-900 dark:text-white">{report.title}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
                        <span className="rounded-sm bg-gray-100 px-1.5 py-px dark:bg-gray-700 dark:text-gray-300">
                          {report.type === 'custom_report' ? '맞춤 리포트' : '브리핑'}
                        </span>
                        <span>기사 {report.articleCount || 0}건</span>
                        <span>{formatTimestamp(report.createdAt)}</span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
