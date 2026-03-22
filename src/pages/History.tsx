import { useState, useEffect } from 'react';
import { Search, Filter, Calendar, ChevronRight, Loader2, Bookmark, BookmarkCheck, Activity, Database, FileText, Clock } from 'lucide-react';
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

  const [activeTab, setActiveTab] = useState<'reports' | 'articles'>('reports');

  // Articles state
  const [articles, setArticles] = useState<any[]>([]);
  const [articlesLoading, setArticlesLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [lastArticleDoc, setLastArticleDoc] = useState<any>(null);
  const [hasMoreArticles, setHasMoreArticles] = useState(true);
  const [showOnlyBookmarked, setShowOnlyBookmarked] = useState(false);
  const categories = ['all', 'M&A', 'PEF', 'VC', 'IPO', 'other'];

  // Reports (Outputs) state
  const [reports, setReports] = useState<any[]>([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [lastReportDoc, setLastReportDoc] = useState<any>(null);
  const [hasMoreReports, setHasMoreReports] = useState(true);
  const [userMap, setUserMap] = useState<Record<string, string>>({});

  useEffect(() => {
    if (user) {
      if (activeTab === 'articles') {
        if (articles.length === 0) fetchArticles();
      } else {
        if (reports.length === 0) {
          fetchReports();
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
        result.data.forEach((u: any) => map[u.uid] = u.email || u.displayName || '삭제된 사용자');
      }
      setUserMap(map);
    } catch (e) {
      console.warn('Could not load users for mapping');
    }
  };

  const fetchReports = async (isLoadMore = false) => {
    if (!user) return;
    if (!isSuperadmin && !companyId) return;

    if (!isLoadMore) setReportsLoading(true);

    try {
      const reportsRef = collection(db, 'outputs');
      const constraints: any[] = [];
      if (!isSuperadmin) {
        constraints.push(where('companyId', '==', companyId));
      }

      const q = isLoadMore && lastReportDoc
        ? query(reportsRef, ...constraints, orderBy('createdAt', 'desc'), startAfter(lastReportDoc), limit(20))
        : query(reportsRef, ...constraints, orderBy('createdAt', 'desc'), limit(20));

      const querySnapshot = await getDocs(q);
      const fetchedReports = querySnapshot.docs.map(d => ({ id: d.id, ...d.data() as any }));

      setReports(prev => isLoadMore ? [...prev, ...fetchedReports] : fetchedReports);
      setLastReportDoc(querySnapshot.docs[querySnapshot.docs.length - 1]);
      setHasMoreReports(querySnapshot.docs.length === 20);
    } catch (err: any) {
      console.error('Failed to fetch reports:', err);
    } finally {
      setReportsLoading(false);
    }
  };

  const fetchArticles = async (isLoadMore = false) => {
    if (!user) return;
    if (!isSuperadmin && !companyId) return;

    if (!isLoadMore) setArticlesLoading(true);

    try {
      const articlesRef = collection(db, 'articles');
      const constraints: any[] = [where('status', 'in', ['analyzed', 'published'])];

      if (!isSuperadmin) {
        constraints.push(where('companyId', '==', companyId));
      }

      if (selectedCategory !== 'all') {
        constraints.push(where('category', '==', selectedCategory));
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
    const matchesTitle = (article.title || '').toLowerCase().includes(q);
    const matchesSource = (article.source || '').toLowerCase().includes(q);
    const matchesSummary = (article.summary || []).some((s: string) => s.toLowerCase().includes(q));
    
    // 북마크 필터링 (메모리 내)
    if (showOnlyBookmarked && !article.isBookmarked) return false;

    return matchesTitle || matchesSource || matchesSummary;
  });

  const formatDate = (timestamp: any) => {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return format(date, 'yyyy.MM.dd HH:mm');
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-20">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">분야별 내역 및 라이브러리</h1>
          <p className="text-gray-600 dark:text-gray-400 mt-1">생성된 분석 보고서와 매칭된 핵심 기사들을 통합 관리합니다.</p>
        </div>
        <div className="flex items-center gap-2">
           <Activity className="w-5 h-5 text-[#d4af37]" />
           <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">
             최근 {reports.length}개 보고서 조회됨
           </span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex space-x-1 bg-gray-100 dark:bg-gray-800 p-1 rounded-xl w-fit border border-gray-200 dark:border-gray-700">
        <button
          onClick={() => setActiveTab('reports')}
          className={`flex items-center px-5 py-2 rounded-lg text-sm font-medium transition-colors ${
            activeTab === 'reports'
              ? 'bg-white dark:bg-gray-700 text-[#1e3a5f] dark:text-white shadow-sm'
              : 'text-gray-500 hover:text-gray-900 dark:hover:text-gray-300'
          }`}
        >
          <FileText className="w-4 h-4 mr-2" />
          분석 보고서 (Reports)
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
          아카이브 (Articles)
        </button>
      </div>

      {/* ────────────────────────────────────────────────────────── */}
      {/* 1. 분석 보고서 내역 (Reports) */}
      {/* ────────────────────────────────────────────────────────── */}
      {activeTab === 'reports' && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
          {reportsLoading && !reports.length ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="w-8 h-8 animate-spin text-[#d4af37]" />
            </div>
          ) : reports.length === 0 ? (
            <div className="text-center text-gray-500 py-16 flex flex-col items-center gap-2">
              <Activity className="w-10 h-10 text-gray-200 mb-2" />
              아직 생성된 보고서가 없습니다.
            </div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-gray-700">
              {reports.map(report => {
                const creator = userMap[report.requestedBy] || report.requestedBy || (report.type === 'daily_briefing' ? '시스템 자동' : '알 수 없음');
                const isCustom = report.type === 'custom_report';

                return (
                  <div key={report.id} 
                    onClick={() => navigate(`/briefing?outputId=${report.id}`)}
                    className="p-5 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors cursor-pointer group"
                  >
                    <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 mb-1.5">
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${
                            isCustom ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                          }`}>
                            {isCustom ? '커스텀 분석' : '정기 브리핑'}
                          </span>
                          <span className="text-xs text-gray-400 flex items-center">
                            <Clock className="w-3.5 h-3.5 mr-1" />
                            {formatDate(report.createdAt)}
                          </span>
                        </div>
                        
                        <h3 className="text-base font-bold text-gray-900 dark:text-white group-hover:text-[#d4af37] transition-colors truncate">
                          {report.title}
                        </h3>
                        
                        <div className="flex flex-wrap items-center gap-2 mt-2">
                          <span className="text-xs text-gray-500 flex items-center gap-1">
                            👤 {creator}
                          </span>
                          <span className="text-gray-200 dark:text-gray-700">|</span>
                          <span className="text-xs text-gray-500">기사 {report.articleCount || 0}건 참조</span>
                          {report.keywords?.length > 0 && (
                            <>
                              <span className="text-gray-200 dark:text-gray-700">|</span>
                              <div className="flex gap-1">
                                {report.keywords.slice(0, 3).map((k: string) => (
                                  <span key={k} className="text-[10px] bg-gray-100 dark:bg-gray-700 text-gray-500 px-1.5 py-0.5 rounded">
                                    #{k}
                                  </span>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 flex-shrink-0 self-center">
                         <ChevronRight className="w-5 h-5 text-gray-300 group-hover:text-[#d4af37] group-hover:translate-x-1 transition-all" />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {hasMoreReports && !reportsLoading && (
            <div className="p-4 border-t border-gray-100 dark:border-gray-700 text-center bg-gray-50 dark:bg-gray-800/50">
              <button onClick={() => fetchReports(true)} className="text-[#1e3a5f] dark:text-blue-400 font-medium hover:underline px-6 py-2">
                더 보기
              </button>
            </div>
          )}
        </div>
      )}

      {/* ────────────────────────────────────────────────────────── */}
      {/* 2. 기사 아카이브 (Articles) */}
      {/* ────────────────────────────────────────────────────────── */}
      {activeTab === 'articles' && (
        <div className="space-y-4">
          <div className="bg-white dark:bg-gray-800 p-4 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
              <input
                type="text"
                placeholder="제목, 매체명, 요약 내용으로 검색..."
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
                북마크만 보기
              </button>
            </div>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
            {articlesLoading && !articles.length ? (
              <div className="flex items-center justify-center h-64">
                <Loader2 className="w-8 h-8 animate-spin text-[#d4af37]" />
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
                          {article.category || '기타'}
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

                    <p className="text-gray-600 dark:text-gray-400 text-sm mb-3 line-clamp-2 leading-relaxed">
                      {article.summary?.[0] || `${article.content?.substring(0, 100) || ''}...`}
                    </p>

                    <div className="flex flex-wrap items-center gap-2">
                      {article.tags?.slice(0, 5).map((tag: string, idx: number) => (
                        <span key={idx} className="text-[10px] text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 px-1.5 py-0.5 rounded">
                          #{tag}
                        </span>
                      ))}

                      {article.publishedInOutputId && (
                        <button
                          onClick={() => navigate(`/briefing?outputId=${article.publishedInOutputId}`)}
                          className="ml-auto flex items-center text-sm text-[#d4af37] font-medium hover:underline"
                        >
                          관련 보고서 <ChevronRight className="w-4 h-4 ml-0.5" />
                        </button>
                      )}
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
