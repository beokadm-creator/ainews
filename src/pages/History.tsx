import { useState, useEffect } from 'react';
import { Search, Filter, Calendar, ChevronRight, Loader2, Bookmark, BookmarkCheck, Activity, Database, CheckCircle, XCircle } from 'lucide-react';
import { db, functions } from '@/lib/firebase';
import { collection, query, orderBy, limit, getDocs, where, startAfter, doc, updateDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/useAuthStore';
import { format } from 'date-fns';

export default function History() {
  const { user } = useAuthStore();
  const companyId = (user as any)?.primaryCompanyId || null;
  const isSuperadmin = (user as any)?.role === 'superadmin';
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState<'runs' | 'articles'>('runs');

  // Articles state
  const [articles, setArticles] = useState<any[]>([]);
  const [articlesLoading, setArticlesLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [lastArticleDoc, setLastArticleDoc] = useState<any>(null);
  const [hasMoreArticles, setHasMoreArticles] = useState(true);
  const [showOnlyBookmarked, setShowOnlyBookmarked] = useState(false);
  const categories = ['all', 'M&A', 'PEF', 'VC', 'IPO', 'other'];

  // Pipeline Runs state
  const [runs, setRuns] = useState<any[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [lastRunDoc, setLastRunDoc] = useState<any>(null);
  const [hasMoreRuns, setHasMoreRuns] = useState(true);
  const [userMap, setUserMap] = useState<Record<string, string>>({});

  useEffect(() => {
    if (user) {
      if (activeTab === 'articles') {
        if (articles.length === 0) fetchArticles();
      } else {
        if (runs.length === 0) {
          fetchRuns();
          if (companyId && !isSuperadmin) loadUserMap();
        }
      }
    }
  }, [activeTab, user, companyId]);

  useEffect(() => {
    if (activeTab === 'articles' && user) {
      setArticles([]);
      setLastArticleDoc(null);
      setHasMoreArticles(true);
      fetchArticles(false);
    }
  }, [selectedCategory, showOnlyBookmarked]);

  const loadUserMap = async () => {
    try {
      const fn = httpsCallable(functions, 'getCompanyUsers');
      const result = await fn({ companyId }) as any;
      const map: Record<string, string> = {};
      if (Array.isArray(result.data)) {
        result.data.forEach((u: any) => map[u.uid] = u.email);
      }
      setUserMap(map);
    } catch (e) {
      console.warn('Could not load users for mapping');
    }
  };

  const fetchRuns = async (isLoadMore = false) => {
    if (!user) return;
    if (!isSuperadmin && !companyId) return;

    if (!isLoadMore) setRunsLoading(true);

    try {
      const runsRef = collection(db, 'pipelineRuns');
      const constraints: any[] = [];
      if (!isSuperadmin) {
        constraints.push(where('companyId', '==', companyId));
      }

      const q = isLoadMore && lastRunDoc
        ? query(runsRef, ...constraints, orderBy('startedAt', 'desc'), startAfter(lastRunDoc), limit(20))
        : query(runsRef, ...constraints, orderBy('startedAt', 'desc'), limit(20));

      const querySnapshot = await getDocs(q);
      const fetchedRuns = querySnapshot.docs.map(d => ({ id: d.id, ...d.data() as any }));

      setRuns(prev => isLoadMore ? [...prev, ...fetchedRuns] : fetchedRuns);
      setLastRunDoc(querySnapshot.docs[querySnapshot.docs.length - 1]);
      setHasMoreRuns(querySnapshot.docs.length === 20);
    } catch (err: any) {
      console.error('Failed to fetch runs:', err);
    } finally {
      setRunsLoading(false);
    }
  };

  const fetchArticles = async (isLoadMore = false) => {
    if (!user) return;
    if (!isSuperadmin && !companyId) return;

    if (!isLoadMore) setArticlesLoading(true);

    try {
      const articlesRef = collection(db, 'articles');
      const constraints: any[] = [where('status', '==', 'published')];

      if (!isSuperadmin) {
        constraints.push(where('companyId', '==', companyId));
      }

      if (selectedCategory !== 'all') {
        constraints.push(where('category', '==', selectedCategory));
      }

      if (showOnlyBookmarked) {
        constraints.push(where('isBookmarked', '==', true));
      }

      const q = isLoadMore && lastArticleDoc
        ? query(articlesRef, ...constraints, orderBy('publishedAt', 'desc'), startAfter(lastArticleDoc), limit(20))
        : query(articlesRef, ...constraints, orderBy('publishedAt', 'desc'), limit(20));

      const querySnapshot = await getDocs(q);
      const fetchedArticles = querySnapshot.docs.map(d => ({ id: d.id, ...d.data() as any }));

      setArticles(prev => isLoadMore ? [...prev, ...fetchedArticles] : fetchedArticles);
      setLastArticleDoc(querySnapshot.docs[querySnapshot.docs.length - 1]);
      setHasMoreArticles(querySnapshot.docs.length === 20);
    } catch (err: any) {
      console.error('Failed to fetch articles:', err);
    } finally {
      setArticlesLoading(false);
    }
  };

  const toggleBookmark = async (articleId: string, currentStatus: boolean) => {
    const articleRef = doc(db, 'articles', articleId);
    await updateDoc(articleRef, { isBookmarked: !currentStatus });
    setArticles(prev => prev.map(article => article.id === articleId ? { ...article, isBookmarked: !currentStatus } : article));
  };

  const filteredArticles = articles.filter(article => {
    if (!searchTerm) return true;
    const q = searchTerm.toLowerCase();
    return (
      article.title?.toLowerCase().includes(q) ||
      article.companies?.target?.toLowerCase().includes(q) ||
      article.companies?.acquiror?.toLowerCase().includes(q) ||
      article.tags?.some((tag: string) => tag.toLowerCase().includes(q))
    );
  });

  const formatDate = (timestamp: any) => {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return format(date, 'yyyy.MM.dd HH:mm');
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-20">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">내역 조회</h1>
        <p className="text-gray-600 dark:text-gray-400 mt-1">AI 파이프라인의 작업 내역과 분석된 기사 라이브러리를 확인합니다.</p>
      </div>

      {/* Tabs */}
      <div className="flex space-x-1 bg-gray-100 dark:bg-gray-800 p-1 rounded-xl w-fit border border-gray-200 dark:border-gray-700">
        <button
          onClick={() => setActiveTab('runs')}
          className={`flex items-center px-5 py-2 rounded-lg text-sm font-medium transition-colors ${
            activeTab === 'runs'
              ? 'bg-white dark:bg-gray-700 text-[#1e3a5f] dark:text-white shadow-sm'
              : 'text-gray-500 hover:text-gray-900 dark:hover:text-gray-300'
          }`}
        >
          <Activity className="w-4 h-4 mr-2" />
          작업 내역 (Activities)
        </button>
        <button
          onClick={() => setActiveTab('articles')}
          className={`flex items-center px-5 py-2 rounded-lg text-sm font-medium transition-colors ${
            activeTab === 'articles'
              ? 'bg-white dark:bg-gray-700 text-[#1e3a5f] dark:text-white shadow-sm'
              : 'text-gray-500 hover:text-gray-900 dark:hover:text-gray-300'
          }`}
        >
          <Database className="w-4 h-4 mr-2" />
          라이브러리 (Articles)
        </button>
      </div>

      {/* ────────────────────────────────────────────────────────── */}
      {/* 1. 작업 내역 (Pipeline Runs) */}
      {/* ────────────────────────────────────────────────────────── */}
      {activeTab === 'runs' && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
          {runsLoading && !runs.length ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="w-8 h-8 animate-spin text-[#1e3a5f]" />
            </div>
          ) : runs.length === 0 ? (
            <div className="text-center text-gray-500 py-16">기록된 작업 내역이 없습니다.</div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-gray-700">
              {runs.map(run => {
                const config = run.configSnapshot;
                const filters = config?.filters || {};
                const sourceName = isSuperadmin 
                  ? (run.companyName || 'Unknown Company') 
                  : (userMap[run.triggeredBy] || run.triggeredBy || '시스템_자동');

                return (
                  <div key={run.id} className="p-5 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                    <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4">
                      
                      {/* Left side */}
                      <div>
                        <div className="flex items-center gap-3 mb-2">
                          <span className="text-sm font-bold text-gray-900 dark:text-white">
                            {isSuperadmin ? '🏢 ' : '👤 '}{sourceName}
                          </span>
                          <span className="text-xs text-gray-400 flex items-center">
                            <Calendar className="w-3.5 h-3.5 mr-1" />
                            {formatDate(run.startedAt)}
                          </span>
                          <span className={`text-[10px] px-2 py-0.5 rounded font-bold uppercase ${
                            run.status === 'completed' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                            run.status === 'failed' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                            'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                          }`}>
                            {run.status === 'completed' ? '완료' : run.status === 'failed' ? '실패' : '진행중'}
                          </span>
                        </div>
                        
                        <div className="flex flex-wrap items-center gap-2 mt-2">
                          <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-2 py-1 rounded border border-gray-200 dark:border-gray-600">
                            기간: {filters.dateRange?.mode || filters.dateRange || 'today'}
                          </span>
                          {filters.includeKeywords?.length > 0 && (
                            <span className="text-xs text-[#1e3a5f] dark:text-blue-300 bg-[#1e3a5f]/10 dark:bg-blue-900/30 px-2 py-1 rounded font-medium">
                              + 포함: {filters.includeKeywords.join(', ')}
                            </span>
                          )}
                          {filters.excludeKeywords?.length > 0 && (
                            <span className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/10 px-2 py-1 rounded font-medium">
                              - 제외: {filters.excludeKeywords.join(', ')}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Right side stats */}
                      <div className="flex space-x-6 text-center bg-gray-50 dark:bg-gray-700/30 p-3 rounded-lg border border-gray-100 dark:border-gray-600">
                        <div>
                          <p className="text-[10px] text-gray-500 uppercase font-semibold">수집</p>
                          <p className="text-sm font-bold text-gray-900 dark:text-white">
                            {run.steps?.collection?.result?.totalCollected || 0}
                          </p>
                        </div>
                        <div>
                          <p className="text-[10px] text-gray-500 uppercase font-semibold">필터 통과</p>
                          <p className="text-sm font-bold text-green-600 dark:text-green-400">
                            {run.steps?.filtering?.result?.passedCount || 0}
                          </p>
                        </div>
                        <div>
                          <p className="text-[10px] text-gray-500 uppercase font-semibold">최종 분석</p>
                          <p className="text-sm font-bold text-[#d4af37] dark:text-yellow-400">
                            {run.steps?.analysis?.result?.analyzedCount || 0}
                          </p>
                        </div>
                      </div>

                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {hasMoreRuns && !runsLoading && (
            <div className="p-4 border-t border-gray-100 dark:border-gray-700 text-center bg-gray-50 dark:bg-gray-800/50">
              <button onClick={() => fetchRuns(true)} className="text-[#1e3a5f] dark:text-blue-400 font-medium hover:underline px-6 py-2">
                더 보기
              </button>
            </div>
          )}
        </div>
      )}


      {/* ────────────────────────────────────────────────────────── */}
      {/* 2. 라이브러리 (Articles) [기존 History 기능] */}
      {/* ────────────────────────────────────────────────────────── */}
      {activeTab === 'articles' && (
        <div className="space-y-4">
          <div className="bg-white dark:bg-gray-800 p-4 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
              <input
                type="text"
                placeholder="Search title, company, tag..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-[#1e3a5f] outline-none bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center space-x-2 overflow-x-auto pb-2 flex-1">
                <Filter className="w-4 h-4 text-gray-500 flex-shrink-0 mr-1" />
                {categories.map(cat => (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    className={`whitespace-nowrap px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                      selectedCategory === cat 
                        ? 'bg-[#1e3a5f] text-white border border-[#1e3a5f]' 
                        : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>

              <button
                onClick={() => setShowOnlyBookmarked(!showOnlyBookmarked)}
                className={`flex items-center px-4 py-1.5 rounded-full text-sm font-medium transition-colors whitespace-nowrap ${
                  showOnlyBookmarked 
                    ? 'bg-[#d4af37] text-white border border-[#d4af37]' 
                    : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
                }`}
              >
                {showOnlyBookmarked ? <BookmarkCheck className="w-4 h-4 mr-1.5" /> : <Bookmark className="w-4 h-4 mr-1.5" />}
                Bookmarked
              </button>
            </div>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
            {articlesLoading && !articles.length ? (
              <div className="flex items-center justify-center h-64">
                <Loader2 className="w-8 h-8 animate-spin text-[#1e3a5f]" />
              </div>
            ) : filteredArticles.length === 0 ? (
              <div className="text-center text-gray-500 py-16">조건에 맞는 기사가 없습니다.</div>
            ) : (
              <div className="divide-y divide-gray-100 dark:divide-gray-700">
                {filteredArticles.map(article => (
                  <div key={article.id} className="p-6 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                    <div className="flex justify-between items-start mb-2">
                      <div className="flex items-center space-x-2">
                        <span className="px-2.5 py-1 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 text-xs font-medium rounded border border-gray-200 dark:border-gray-600">
                          {article.category || 'other'}
                        </span>
                        <span className="text-sm text-gray-500 flex items-center">
                          <Calendar className="w-3.5 h-3.5 mr-1" />
                          {formatDate(article.publishedAt)}
                        </span>
                      </div>
                      <div className="flex items-center space-x-2">
                        <span className="text-xs text-gray-400 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 px-2 py-1 rounded">
                          {article.source}
                        </span>
                        <button onClick={() => toggleBookmark(article.id, article.isBookmarked || false)} className="text-gray-400 hover:text-[#d4af37] transition-colors">
                          {article.isBookmarked ? <BookmarkCheck className="w-5 h-5 text-[#d4af37] fill-[#d4af37]" /> : <Bookmark className="w-5 h-5" />}
                        </button>
                      </div>
                    </div>

                    <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">
                      <a href={article.url} target="_blank" rel="noreferrer" className="hover:text-[#1e3a5f] dark:hover:text-blue-400 hover:underline">
                        {article.title}
                      </a>
                    </h3>

                    <p className="text-gray-600 dark:text-gray-400 text-sm mb-3 line-clamp-2">
                      {article.summary?.[0] || `${article.content?.substring(0, 100) || ''}...`}
                    </p>

                    <div className="flex flex-wrap items-center gap-2">
                      {article.tags?.slice(0, 3).map((tag: string, idx: number) => (
                        <span key={idx} className="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 px-2 py-1 rounded-md">
                          #{tag}
                        </span>
                      ))}

                      <button
                        onClick={() => article.publishedInOutputId && navigate(`/briefing?outputId=${article.publishedInOutputId}`)}
                        className="ml-auto flex items-center text-sm text-[#d4af37] font-medium hover:text-[#c19b26]"
                      >
                        결과 보고서 보기 <ChevronRight className="w-4 h-4 ml-0.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {hasMoreArticles && !articlesLoading && !searchTerm && (
              <div className="p-4 border-t border-gray-100 dark:border-gray-700 text-center bg-gray-50 dark:bg-gray-800/50">
                <button onClick={() => fetchArticles(true)} className="text-[#1e3a5f] dark:text-blue-400 font-medium hover:underline px-6 py-2">
                  더 보기
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
