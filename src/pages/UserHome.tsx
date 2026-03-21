import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Search, FileText, TrendingUp, Clock, ChevronRight,
  Newspaper, BookOpen, ArrowRight, Rss, Globe
} from 'lucide-react';
import { db } from '@/lib/firebase';
import { collection, query, where, orderBy, limit, getDocs } from 'firebase/firestore';
import { useAuthStore } from '@/store/useAuthStore';
import { format } from 'date-fns';
import { ko } from 'date-fns/locale';

interface RecentArticle {
  id: string;
  title: string;
  source: string;
  category?: string;
  relevanceScore?: number;
  publishedAt?: any;
  status: string;
}

interface RecentReport {
  id: string;
  title: string;
  type: string;
  articleCount: number;
  keywords?: string[];
  createdAt?: any;
}

function ArticleCard({ article }: { article: RecentArticle }) {
  const navigate = useNavigate();
  const score = article.relevanceScore ?? 0;
  const scoreColor = score >= 7 ? 'text-green-400' : score >= 4 ? 'text-yellow-400' : 'text-red-400';

  return (
    <div
      onClick={() => navigate(`/articles?highlight=${article.id}`)}
      className="group p-4 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl hover:border-[#d4af37]/40 hover:shadow-sm transition-all cursor-pointer"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-900 dark:text-white leading-snug line-clamp-2 group-hover:text-[#d4af37] transition-colors">
            {article.title}
          </p>
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-xs text-gray-400">{article.source}</span>
            {article.category && (
              <span className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 rounded text-[10px] text-gray-500 dark:text-gray-400">
                {article.category}
              </span>
            )}
          </div>
        </div>
        {article.relevanceScore != null && (
          <div className="flex-shrink-0 text-right">
            <span className={`text-sm font-bold ${scoreColor}`}>{score.toFixed(1)}</span>
            <p className="text-[10px] text-gray-400">관련성</p>
          </div>
        )}
      </div>
      {article.publishedAt && (
        <p className="text-[10px] text-gray-300 dark:text-gray-500 mt-2">
          {article.publishedAt?.toDate
            ? format(article.publishedAt.toDate(), 'M월 d일 HH:mm', { locale: ko })
            : ''}
        </p>
      )}
    </div>
  );
}

function ReportCard({ report }: { report: RecentReport }) {
  const createdAt = report.createdAt?.toDate
    ? format(report.createdAt.toDate(), 'M월 d일', { locale: ko })
    : '';
  const typeLabel = report.type === 'custom_report' ? '커스텀 보고서' : 'AI 브리핑';

  return (
    <Link
      to={`/briefing?outputId=${report.id}`}
      className="group flex items-center gap-4 p-4 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl hover:border-[#d4af37]/40 hover:shadow-sm transition-all"
    >
      <div className="w-10 h-10 bg-[#d4af37]/10 rounded-xl flex items-center justify-center flex-shrink-0">
        <BookOpen className="w-5 h-5 text-[#d4af37]" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 dark:text-white truncate group-hover:text-[#d4af37] transition-colors">
          {report.title}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-gray-400">{typeLabel}</span>
          <span className="text-gray-200 dark:text-gray-600">·</span>
          <span className="text-xs text-gray-400">기사 {report.articleCount}개</span>
          {createdAt && (
            <>
              <span className="text-gray-200 dark:text-gray-600">·</span>
              <span className="text-xs text-gray-400">{createdAt}</span>
            </>
          )}
        </div>
        {report.keywords && report.keywords.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {report.keywords.slice(0, 3).map(k => (
              <span key={k} className="px-1.5 py-0.5 bg-[#d4af37]/10 text-[#d4af37] text-[10px] rounded font-medium">
                {k}
              </span>
            ))}
          </div>
        )}
      </div>
      <ChevronRight className="w-4 h-4 text-gray-300 dark:text-gray-600 group-hover:text-[#d4af37] transition-colors flex-shrink-0" />
    </Link>
  );
}

// ─── Quick action cards ───────────────────────────────────
function QuickAction({ icon: Icon, title, desc, to, color }: {
  icon: any; title: string; desc: string; to: string; color: string;
}) {
  return (
    <Link
      to={to}
      className="group flex flex-col gap-3 p-5 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl hover:border-[#d4af37]/40 hover:shadow-md transition-all"
    >
      <div className={`w-10 h-10 ${color} rounded-xl flex items-center justify-center`}>
        <Icon className="w-5 h-5 text-white" />
      </div>
      <div>
        <p className="text-sm font-semibold text-gray-900 dark:text-white group-hover:text-[#d4af37] transition-colors">{title}</p>
        <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{desc}</p>
      </div>
      <div className="flex items-center gap-1 text-xs text-gray-400 group-hover:text-[#d4af37] transition-colors mt-auto">
        바로 가기 <ArrowRight className="w-3 h-3" />
      </div>
    </Link>
  );
}

// ─── Main ─────────────────────────────────────────────────
export default function UserHome() {
  const { user } = useAuthStore();
  const companyId = (user as any)?.companyId;
  const [recentArticles, setRecentArticles] = useState<RecentArticle[]>([]);
  const [recentReports, setRecentReports] = useState<RecentReport[]>([]);
  const [loadingArticles, setLoadingArticles] = useState(true);
  const [loadingReports, setLoadingReports] = useState(true);
  const [todayCount, setTodayCount] = useState(0);
  const [analyzedCount, setAnalyzedCount] = useState(0);

  useEffect(() => {
    if (!companyId) return;

    // Load recent analyzed articles
    async function loadArticles() {
      setLoadingArticles(true);
      try {
        const snap = await getDocs(
          query(
            collection(db, 'articles'),
            where('companyId', '==', companyId),
            where('status', 'in', ['analyzed', 'published']),
            orderBy('analyzedAt', 'desc'),
            limit(6)
          )
        );
        const arts: RecentArticle[] = snap.docs.map(d => ({ id: d.id, ...d.data() } as RecentArticle));
        setRecentArticles(arts);

        // Today count
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todaySnap = await getDocs(
          query(
            collection(db, 'articles'),
            where('companyId', '==', companyId),
            where('createdAt', '>=', today),
            limit(100)
          )
        );
        setTodayCount(todaySnap.size);
        setAnalyzedCount(arts.length);
      } finally {
        setLoadingArticles(false);
      }
    }

    // Load recent reports
    async function loadReports() {
      setLoadingReports(true);
      try {
        const snap = await getDocs(
          query(
            collection(db, 'outputs'),
            where('companyId', '==', companyId),
            orderBy('createdAt', 'desc'),
            limit(5)
          )
        );
        const rpts: RecentReport[] = snap.docs.map(d => ({ id: d.id, ...d.data() } as RecentReport));
        setRecentReports(rpts);
      } finally {
        setLoadingReports(false);
      }
    }

    loadArticles();
    loadReports();
  }, [companyId]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? '좋은 아침이에요' : hour < 18 ? '안녕하세요' : '안녕하세요';
  const userName = (user as any)?.displayName || user?.email?.split('@')[0] || '';

  return (
    <div className="space-y-8 max-w-5xl">
      {/* Greeting */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          {greeting}, <span className="text-[#d4af37]">{userName}</span>님
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          오늘도 최신 뉴스 인텔리전스를 확인하세요.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl p-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-blue-50 dark:bg-blue-500/10 rounded-lg flex items-center justify-center">
              <Newspaper className="w-5 h-5 text-blue-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{todayCount}</p>
              <p className="text-xs text-gray-400">오늘 수집된 기사</p>
            </div>
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl p-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-green-50 dark:bg-green-500/10 rounded-lg flex items-center justify-center">
              <TrendingUp className="w-5 h-5 text-green-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{analyzedCount}</p>
              <p className="text-xs text-gray-400">최근 분석 완료</p>
            </div>
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl p-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-purple-50 dark:bg-purple-500/10 rounded-lg flex items-center justify-center">
              <BookOpen className="w-5 h-5 text-purple-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{recentReports.length}</p>
              <p className="text-xs text-gray-400">최근 보고서</p>
            </div>
          </div>
        </div>
      </div>

      {/* Quick actions */}
      <div>
        <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">빠른 시작</h2>
        <div className="grid grid-cols-3 gap-4">
          <QuickAction
            icon={Search}
            title="기사 검색"
            desc="키워드로 수집된 기사를 검색하고 분석 대상을 선택하세요"
            to="/articles"
            color="bg-blue-500"
          />
          <QuickAction
            icon={FileText}
            title="보고서 생성"
            desc="선택한 기사들로 AI 분석 보고서를 만드세요"
            to="/articles"
            color="bg-[#d4af37]"
          />
          <QuickAction
            icon={BookOpen}
            title="보고서 보기"
            desc="지금까지 생성된 모든 AI 분석 보고서를 확인하세요"
            to="/briefing"
            color="bg-purple-500"
          />
        </div>
      </div>

      {/* Two-column: articles + reports */}
      <div className="grid grid-cols-2 gap-6">
        {/* Recent articles */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              최근 분석된 기사
            </h2>
            <Link to="/articles" className="text-xs text-[#d4af37] hover:underline flex items-center gap-1">
              전체 보기 <ChevronRight className="w-3 h-3" />
            </Link>
          </div>
          {loadingArticles ? (
            <div className="space-y-2">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="h-20 bg-gray-100 dark:bg-gray-800 rounded-xl animate-pulse" />
              ))}
            </div>
          ) : recentArticles.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl">
              <Rss className="w-8 h-8 text-gray-200 dark:text-gray-600 mb-2" />
              <p className="text-sm text-gray-400">수집된 기사가 없습니다</p>
              <p className="text-xs text-gray-300 dark:text-gray-500 mt-1">매체 구독 설정을 확인해 주세요</p>
            </div>
          ) : (
            <div className="space-y-2">
              {recentArticles.map(a => <ArticleCard key={a.id} article={a} />)}
            </div>
          )}
        </div>

        {/* Recent reports */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              최근 보고서
            </h2>
            <Link to="/briefing" className="text-xs text-[#d4af37] hover:underline flex items-center gap-1">
              전체 보기 <ChevronRight className="w-3 h-3" />
            </Link>
          </div>
          {loadingReports ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-20 bg-gray-100 dark:bg-gray-800 rounded-xl animate-pulse" />
              ))}
            </div>
          ) : recentReports.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl">
              <Globe className="w-8 h-8 text-gray-200 dark:text-gray-600 mb-2" />
              <p className="text-sm text-gray-400">생성된 보고서가 없습니다</p>
              <Link to="/articles" className="text-xs text-[#d4af37] mt-2 hover:underline">
                기사를 선택해서 첫 보고서 만들기 →
              </Link>
            </div>
          ) : (
            <div className="space-y-2">
              {recentReports.map(r => <ReportCard key={r.id} report={r} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
