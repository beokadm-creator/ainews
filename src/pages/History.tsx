import { useState, useEffect } from 'react';
import { Search, Filter, Calendar, ChevronRight, Loader2, Bookmark, BookmarkCheck } from 'lucide-react';
import { db } from '@/lib/firebase';
import { collection, query, orderBy, limit, getDocs, where, startAfter, doc, updateDoc } from 'firebase/firestore';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/useAuthStore';

export default function History() {
  const { user } = useAuthStore();
  const companyId = (user as any)?.primaryCompanyId || null;
  const isSuperadmin = (user as any)?.role === 'superadmin';
  const [articles, setArticles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [lastDoc, setLastDoc] = useState<any>(null);
  const [hasMore, setHasMore] = useState(true);
  const [showOnlyBookmarked, setShowOnlyBookmarked] = useState(false);

  const navigate = useNavigate();
  const categories = ['all', 'M&A', 'PEF', 'VC', 'IPO', 'other'];

  const fetchHistory = async (isLoadMore = false) => {
    // 1. User profile 로딩 대기 가드
    if (!user) return;
    
    // 2. 비-슈퍼어드민인 경우 primaryCompanyId가 로드된 후에만 수행 (broad query 방지)
    if (!isSuperadmin && !companyId) {
      console.warn('History: No companyId found for non-superadmin user. Waiting for profile...');
      setLoading(false);
      return;
    }

    if (!isLoadMore) setLoading(true);

    try {
      const articlesRef = collection(db, 'articles');
      const constraints: any[] = [where('status', '==', 'published')];

      // 필터링: 슈퍼어드민이면 전체, 아니면 자기 회사 것만
      if (!isSuperadmin) {
        constraints.push(where('companyId', '==', companyId));
      }

      if (selectedCategory !== 'all') {
        constraints.push(where('category', '==', selectedCategory));
      }

      if (showOnlyBookmarked) {
        constraints.push(where('isBookmarked', '==', true));
      }

      const q = isLoadMore && lastDoc
        ? query(articlesRef, ...constraints, orderBy('publishedAt', 'desc'), startAfter(lastDoc), limit(20))
        : query(articlesRef, ...constraints, orderBy('publishedAt', 'desc'), limit(20));

      const querySnapshot = await getDocs(q);
      const fetchedArticles = querySnapshot.docs.map(d => ({ id: d.id, ...d.data() as any }));

      setArticles(prev => isLoadMore ? [...prev, ...fetchedArticles] : fetchedArticles);
      setLastDoc(querySnapshot.docs[querySnapshot.docs.length - 1]);
      setHasMore(querySnapshot.docs.length === 20);
    } catch (err: any) {
      console.error('Failed to fetch history:', err);
      // 권한 오류 시 사용자에게 알림 또는 빈 목록 처리
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // user 정보가 있을 때만 실행
    if (user) {
      fetchHistory();
    }
  }, [selectedCategory, showOnlyBookmarked, user, companyId]);

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
    return date.toLocaleDateString();
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Published Articles</h1>
        <p className="text-gray-600 dark:text-gray-400 mt-1">Search analyzed and published articles.</p>
      </div>

      <div className="bg-white dark:bg-gray-800 p-4 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 space-y-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
          <input
            type="text"
            placeholder="Search title, company, tag..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1e3a5f] outline-none"
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
                  selectedCategory === cat ? 'bg-[#1e3a5f] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          <button
            onClick={() => setShowOnlyBookmarked(!showOnlyBookmarked)}
            className={`flex items-center px-4 py-1.5 rounded-full text-sm font-medium transition-colors whitespace-nowrap ${
              showOnlyBookmarked ? 'bg-[#d4af37] text-white' : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
          >
            {showOnlyBookmarked ? <BookmarkCheck className="w-4 h-4 mr-1.5" /> : <Bookmark className="w-4 h-4 mr-1.5" />}
            Bookmarked
          </button>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        {loading && !articles.length ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 animate-spin text-[#1e3a5f]" />
          </div>
        ) : filteredArticles.length === 0 ? (
          <div className="text-center text-gray-500 py-16">No articles found.</div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            {filteredArticles.map(article => (
              <div key={article.id} className="p-6 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                <div className="flex justify-between items-start mb-2">
                  <div className="flex items-center space-x-2">
                    <span className="px-2.5 py-1 bg-gray-100 text-gray-700 text-xs font-medium rounded">
                      {article.category || 'other'}
                    </span>
                    <span className="text-sm text-gray-500 flex items-center">
                      <Calendar className="w-3.5 h-3.5 mr-1" />
                      {formatDate(article.publishedAt)}
                    </span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="text-xs text-gray-400 bg-white border border-gray-200 px-2 py-1 rounded">
                      {article.source}
                    </span>
                    <button onClick={() => toggleBookmark(article.id, article.isBookmarked || false)} className="text-gray-400 hover:text-[#d4af37] transition-colors">
                      {article.isBookmarked ? <BookmarkCheck className="w-5 h-5 text-[#d4af37] fill-[#d4af37]" /> : <Bookmark className="w-5 h-5" />}
                    </button>
                  </div>
                </div>

                <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">
                  <a href={article.url} target="_blank" rel="noreferrer" className="hover:text-[#1e3a5f] hover:underline">
                    {article.title}
                  </a>
                </h3>

                <p className="text-gray-600 dark:text-gray-400 text-sm mb-3 line-clamp-2">
                  {article.summary?.[0] || `${article.content?.substring(0, 100) || ''}...`}
                </p>

                <div className="flex flex-wrap items-center gap-2">
                  {article.tags?.slice(0, 3).map((tag: string, idx: number) => (
                    <span key={idx} className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded-md">#{tag}</span>
                  ))}

                  <button
                    onClick={() => article.publishedInOutputId && navigate(`/briefing?outputId=${article.publishedInOutputId}`)}
                    className="ml-auto flex items-center text-sm text-[#d4af37] font-medium hover:text-[#c19b26]"
                  >
                    View Output <ChevronRight className="w-4 h-4 ml-0.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {hasMore && !loading && !searchTerm && (
          <div className="p-4 border-t border-gray-100 text-center bg-gray-50">
            <button onClick={() => fetchHistory(true)} className="text-[#1e3a5f] font-medium hover:underline px-6 py-2">
              Load More
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
