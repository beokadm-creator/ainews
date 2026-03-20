import { useState } from 'react';
import { functions } from '@/lib/firebase';
import { httpsCallable } from 'firebase/functions';
import { Loader2, RefreshCw, LogIn, ExternalLink, Calendar } from 'lucide-react';
import { useAuthStore } from '@/store/useAuthStore';

interface ThebellArticle {
  title: string;
  url: string;
  content: string;
  publishedAt: string | Date;
}

export default function Thebell() {
  const { user } = useAuthStore();
  const role = (user as any)?.role;
  const isSuperadmin = role === 'superadmin';

  const [articles, setArticles] = useState<ThebellArticle[]>([]);
  const [loginLoading, setLoginLoading] = useState(false);
  const [scrapeLoading, setScrapeLoading] = useState(false);
  const [loginStatus, setLoginStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scraped, setScraped] = useState(false);

  const handleLogin = async () => {
    setLoginLoading(true);
    setError(null);
    setLoginStatus(null);
    try {
      const loginFn = httpsCallable(functions, 'thebellLogin');
      const result: any = await loginFn({});
      setLoginStatus(result.data?.message || '로그인 성공');
    } catch (err: any) {
      setError(err.message || '로그인 실패');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleScrape = async () => {
    setScrapeLoading(true);
    setError(null);
    try {
      const scrapeFn = httpsCallable(functions, 'thebellScrape');
      const result: any = await scrapeFn({});
      setArticles(result.data?.articles || []);
      setScraped(true);
    } catch (err: any) {
      setError(err.message || '스크래핑 실패');
    } finally {
      setScrapeLoading(false);
    }
  };

  const formatDate = (publishedAt: string | Date) => {
    try {
      const d = typeof publishedAt === 'string' ? new Date(publishedAt) : publishedAt;
      return d.toLocaleString('ko-KR');
    } catch {
      return String(publishedAt);
    }
  };

  if (!isSuperadmin) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-gray-500 dark:text-gray-400 font-medium">접근 권한이 없습니다.</p>
          <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">Superadmin 전용 페이지입니다.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">더벨</h1>
          <p className="text-gray-600 dark:text-gray-400 mt-1">더벨 유료 회원 기사 스크래핑</p>
        </div>
      </div>

      {/* Actions */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6 space-y-4">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider">작업</h2>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={handleLogin}
            disabled={loginLoading || scrapeLoading}
            className="flex items-center px-4 py-2 bg-[#1e3a5f] text-white rounded-lg shadow-sm text-sm font-medium hover:bg-[#2a4a73] disabled:opacity-50 transition-colors"
          >
            {loginLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <LogIn className="w-4 h-4 mr-2" />}
            유료 회원 로그인
          </button>
          <button
            onClick={handleScrape}
            disabled={loginLoading || scrapeLoading}
            className="flex items-center px-4 py-2 bg-[#d4af37] text-white rounded-lg shadow-sm text-sm font-medium hover:bg-[#b8962e] disabled:opacity-50 transition-colors"
          >
            {scrapeLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
            기사 스크래핑
          </button>
        </div>

        {loginStatus && (
          <div className="px-4 py-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg text-sm text-green-700 dark:text-green-400">
            {loginStatus}
          </div>
        )}
        {error && (
          <div className="px-4 py-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-400">
            {error}
          </div>
        )}
      </div>

      {/* Results */}
      {scraped && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">스크래핑 결과</h2>
            <span className="text-sm text-gray-500 dark:text-gray-400">{articles.length}건</span>
          </div>

          {articles.length === 0 ? (
            <div className="p-12 text-center text-gray-500 dark:text-gray-400">
              <RefreshCw className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium">스크래핑된 기사가 없습니다.</p>
              <p className="text-sm mt-1">로그인 후 다시 시도해 보세요.</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-gray-700">
              {articles.map((article, index) => (
                <div key={index} className="px-6 py-5 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <a href={article.url} target="_blank" rel="noreferrer" className="group flex items-start gap-1">
                        <h3 className="text-base font-semibold text-gray-900 dark:text-white group-hover:text-[#1e3a5f] dark:group-hover:text-blue-400 transition-colors leading-snug">
                          {article.title}
                        </h3>
                        <ExternalLink className="w-3.5 h-3.5 text-gray-400 flex-shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                      </a>
                      {article.content && (
                        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400 leading-relaxed line-clamp-3">
                          {article.content}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
                    <span className="inline-block px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded">
                      더벨
                    </span>
                    {article.publishedAt && (
                      <span className="flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        {formatDate(article.publishedAt)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
