import { useState, useEffect, useCallback } from 'react';
import {
  Search, Filter, ChevronDown, ChevronUp, ExternalLink,
  CheckCircle, XCircle, Clock, AlertTriangle, RefreshCw
} from 'lucide-react';
import { db } from '@/lib/firebase';
import {
  collection, query, where, orderBy, limit, getDocs,
  startAfter, QueryDocumentSnapshot, DocumentData, getCountFromServer
} from 'firebase/firestore';
import { format } from 'date-fns';

// ─── Types ────────────────────────────────────────────────
interface Article {
  id: string;
  title: string;
  source: string;
  sourceId: string;
  url: string;
  status: string;
  relevanceScore?: number;
  filterReason?: string;
  category?: string;
  tags?: string[];
  summary?: string[];
  publishedAt?: any;
  collectedAt?: any;
  isPaid?: boolean;
}

// ─── Status config ────────────────────────────────────────
const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; icon: any }> = {
  pending:    { label: '수집됨',    color: 'text-blue-400',   bg: 'bg-blue-500/10 border-blue-500/30',    icon: Clock },
  collected:  { label: '수집됨',    color: 'text-blue-400',   bg: 'bg-blue-500/10 border-blue-500/30',    icon: Clock },
  filtered:   { label: '필터링됨',  color: 'text-yellow-400', bg: 'bg-yellow-500/10 border-yellow-500/30', icon: Filter },
  analyzed:   { label: '분석완료',  color: 'text-green-400',  bg: 'bg-green-500/10 border-green-500/30',  icon: CheckCircle },
  published:  { label: '발행됨',    color: 'text-purple-400', bg: 'bg-purple-500/10 border-purple-500/30', icon: CheckCircle },
  rejected:   { label: '제외됨',    color: 'text-red-400',    bg: 'bg-red-500/10 border-red-500/30',       icon: XCircle },
};

const SOURCE_OPTIONS = [
  { value: '', label: '모든 매체' },
  { value: 'thebell', label: '더벨' },
  { value: 'marketinsight', label: '마켓인사이트' },
  { value: 'hankyung_ma', label: '한경 M&A' },
];

const PAGE_SIZE = 30;

// ─── Score bar ────────────────────────────────────────────
function ScoreBar({ score }: { score: number }) {
  const pct = Math.min(100, Math.max(0, score * 10));
  const color = score >= 7 ? 'bg-green-500' : score >= 4 ? 'bg-yellow-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono text-white/60 w-6">{score.toFixed(1)}</span>
    </div>
  );
}

// ─── Article row ─────────────────────────────────────────
function ArticleRow({ article, expanded, onToggle }: {
  article: Article;
  expanded: boolean;
  onToggle: () => void;
}) {
  const status = STATUS_CONFIG[article.status] || STATUS_CONFIG.pending;
  const StatusIcon = status.icon;
  const collectedDate = article.collectedAt?.toDate
    ? format(article.collectedAt.toDate(), 'MM.dd HH:mm')
    : '—';

  return (
    <>
      <tr
        className="border-b border-white/5 hover:bg-white/3 cursor-pointer transition-colors"
        onClick={onToggle}
      >
        <td className="px-4 py-3">
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${status.bg} ${status.color}`}>
            <StatusIcon className="w-2.5 h-2.5" />
            {status.label}
          </span>
        </td>
        <td className="px-4 py-3 max-w-xs">
          <p className="text-sm text-white/90 truncate leading-snug">{article.title}</p>
          <p className="text-[10px] text-white/30 mt-0.5 flex items-center gap-1">
            {article.source}
            {article.isPaid && <span className="px-1 py-0 bg-amber-500/20 text-amber-400 rounded text-[9px] font-bold">유료</span>}
          </p>
        </td>
        <td className="px-4 py-3 text-xs text-white/40 whitespace-nowrap">{article.category || '—'}</td>
        <td className="px-4 py-3 w-28">
          {article.relevanceScore != null
            ? <ScoreBar score={article.relevanceScore} />
            : <span className="text-xs text-white/20">—</span>
          }
        </td>
        <td className="px-4 py-3 text-[11px] text-white/40 whitespace-nowrap">{collectedDate}</td>
        <td className="px-4 py-3">
          {expanded
            ? <ChevronUp className="w-3.5 h-3.5 text-white/30" />
            : <ChevronDown className="w-3.5 h-3.5 text-white/20" />
          }
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-white/5 bg-white/2">
          <td colSpan={6} className="px-4 pb-4 pt-2">
            <div className="grid grid-cols-2 gap-4">
              {/* Left: summary + reason */}
              <div className="space-y-2">
                {article.summary && article.summary.length > 0 && (
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-white/25 mb-1">AI 요약</p>
                    <ul className="space-y-0.5">
                      {article.summary.map((s, i) => (
                        <li key={i} className="text-xs text-white/60 leading-relaxed flex gap-1.5">
                          <span className="text-[#d4af37] mt-0.5">•</span>
                          {s}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {article.filterReason && (
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-white/25 mb-1">필터 판단 근거</p>
                    <p className="text-xs text-white/50 leading-relaxed">{article.filterReason}</p>
                  </div>
                )}
              </div>
              {/* Right: tags + links */}
              <div className="space-y-2">
                {article.tags && article.tags.length > 0 && (
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-white/25 mb-1">태그</p>
                    <div className="flex flex-wrap gap-1">
                      {article.tags.map(tag => (
                        <span key={tag} className="px-1.5 py-0.5 bg-white/5 border border-white/10 rounded text-[10px] text-white/50">{tag}</span>
                      ))}
                    </div>
                  </div>
                )}
                {article.url && (
                  <a
                    href={article.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={e => e.stopPropagation()}
                    className="inline-flex items-center gap-1 text-xs text-[#d4af37]/70 hover:text-[#d4af37] transition-colors"
                  >
                    <ExternalLink className="w-3 h-3" />
                    원문 보기
                  </a>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Main ─────────────────────────────────────────────────
export default function AdminArticles() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [lastDoc, setLastDoc] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [selectedSource, setSelectedSource] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('');
  const [dateRange, setDateRange] = useState<'today' | '3d' | '7d' | '30d' | ''>('');

  // Stats
  const [stats, setStats] = useState({ total: 0, pending: 0, analyzed: 0, rejected: 0 });

  // ─── Load articles ───────────────────────────────────────
  const loadArticles = useCallback(async (reset = true) => {
    if (reset) { setLoading(true); setLastDoc(null); }
    else setLoadingMore(true);

    try {
      const conditions: any[] = [];
      if (selectedSource) conditions.push(where('sourceId', '==', selectedSource));
      if (selectedStatus) conditions.push(where('status', '==', selectedStatus));

      if (dateRange) {
        const days = dateRange === 'today' ? 1 : dateRange === '3d' ? 3 : dateRange === '7d' ? 7 : 30;
        const since = new Date(Date.now() - days * 86400000);
        conditions.push(where('collectedAt', '>=', since));
      }

      let q = query(
        collection(db, 'articles'),
        ...conditions,
        orderBy('collectedAt', 'desc'),
        limit(PAGE_SIZE + 1)
      );

      if (!reset && lastDoc) {
        q = query(
          collection(db, 'articles'),
          ...conditions,
          orderBy('collectedAt', 'desc'),
          startAfter(lastDoc),
          limit(PAGE_SIZE + 1)
        );
      }

      const snap = await getDocs(q);
      const docs = snap.docs;
      const hasMoreDocs = docs.length > PAGE_SIZE;
      const sliced = hasMoreDocs ? docs.slice(0, PAGE_SIZE) : docs;

      let loaded: Article[] = sliced.map(d => ({ id: d.id, ...d.data() } as Article));

      if (search) {
        const lower = search.toLowerCase();
        loaded = loaded.filter(a =>
          a.title?.toLowerCase().includes(lower) ||
          a.source?.toLowerCase().includes(lower)
        );
      }

      if (reset) setArticles(loaded);
      else setArticles(prev => [...prev, ...loaded]);

      setLastDoc(sliced[sliced.length - 1] ?? null);
      setHasMore(hasMoreDocs);

      // Stats from recent 500 articles
      if (reset) {
        const [totalSnap, pendingSnap, analyzedSnap, rejectedSnap] = await Promise.all([
          getCountFromServer(collection(db, 'articles')),
          getCountFromServer(query(collection(db, 'articles'), where('status', '==', 'pending'))),
          getCountFromServer(query(collection(db, 'articles'), where('status', '==', 'analyzed'))),
          getCountFromServer(query(collection(db, 'articles'), where('status', '==', 'rejected'))),
        ]);
        setStats({
          total: totalSnap.data().count,
          pending: pendingSnap.data().count,
          analyzed: analyzedSnap.data().count,
          rejected: rejectedSnap.data().count,
        });
      }
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSource, selectedStatus, dateRange, search]);

  useEffect(() => {
    loadArticles(true);
  }, [selectedSource, selectedStatus, dateRange]);

  useEffect(() => {
    const t = setTimeout(() => loadArticles(true), 400);
    return () => clearTimeout(t);
  }, [search]);

  return (
    <div className="space-y-5">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">수집 기사 검증</h1>
          <p className="text-sm text-white/40 mt-0.5">전체 수집 기사 조회 & AI 검증 현황</p>
        </div>
        <button
          onClick={() => loadArticles(true)}
          className="flex items-center gap-2 px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs text-white/60 hover:text-white transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          새로고침
        </button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: '전체 기사', value: stats.total, color: 'text-white/80' },
          { label: '수집/처리중', value: stats.pending, color: 'text-blue-400' },
          { label: '분석완료', value: stats.analyzed, color: 'text-green-400' },
          { label: '제외됨', value: stats.rejected, color: 'text-red-400' },
        ].map(s => (
          <div key={s.label} className="bg-gray-800/60 border border-white/5 rounded-xl p-4">
            <p className="text-xs text-white/30 font-medium">{s.label}</p>
            <p className={`text-2xl font-bold mt-1 ${s.color}`}>{s.value.toLocaleString()}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-gray-800/60 border border-white/5 rounded-xl p-4">
        <div className="flex flex-wrap gap-3">
          {/* Text search */}
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/25" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="제목 / 매체 검색..."
              className="w-full pl-8 pr-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-white/25 focus:outline-none focus:border-[#d4af37]/50"
            />
          </div>

          {/* Source filter */}
          <select
            value={selectedSource}
            onChange={e => setSelectedSource(e.target.value)}
            className="px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white/70 focus:outline-none focus:border-[#d4af37]/50"
          >
            {SOURCE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>

          {/* Status filter */}
          <div className="flex gap-1 flex-wrap">
            {(['', 'pending', 'filtered', 'analyzed', 'published', 'rejected'] as const).map(s => (
              <button
                key={s}
                onClick={() => setSelectedStatus(s)}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  selectedStatus === s
                    ? 'bg-[#d4af37]/20 border-[#d4af37]/50 text-[#d4af37]'
                    : 'bg-white/5 border-white/10 text-white/50 hover:text-white/80'
                }`}
              >
                {s === '' ? '전체' : STATUS_CONFIG[s]?.label || s}
              </button>
            ))}
          </div>

          {/* Date presets */}
          <div className="flex gap-1">
            {([['', '전체'], ['today', '오늘'], ['3d', '3일'], ['7d', '7일'], ['30d', '30일']] as const).map(([val, lbl]) => (
              <button
                key={val}
                onClick={() => setDateRange(val)}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  dateRange === val
                    ? 'bg-[#d4af37]/20 border-[#d4af37]/50 text-[#d4af37]'
                    : 'bg-white/5 border-white/10 text-white/50 hover:text-white/80'
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-gray-800/60 border border-white/5 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-6 h-6 border-2 border-[#d4af37]/40 border-t-[#d4af37] rounded-full animate-spin" />
          </div>
        ) : articles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-white/25">
            <AlertTriangle className="w-8 h-8 mb-2" />
            <p className="text-sm">조건에 맞는 기사가 없습니다</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/5">
                    <th className="px-4 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-white/25 w-24">상태</th>
                    <th className="px-4 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-white/25">제목 / 매체</th>
                    <th className="px-4 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-white/25 w-28">카테고리</th>
                    <th className="px-4 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-white/25 w-36">관련성 점수</th>
                    <th className="px-4 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-white/25 w-28">수집일</th>
                    <th className="px-4 py-3 w-8" />
                  </tr>
                </thead>
                <tbody>
                  {articles.map(article => (
                    <ArticleRow
                      key={article.id}
                      article={article}
                      expanded={expandedId === article.id}
                      onToggle={() => setExpandedId(expandedId === article.id ? null : article.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {hasMore && (
              <div className="px-4 py-3 border-t border-white/5 flex justify-center">
                <button
                  onClick={() => loadArticles(false)}
                  disabled={loadingMore}
                  className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm text-white/60 hover:text-white transition-colors disabled:opacity-50"
                >
                  {loadingMore
                    ? <><div className="w-3.5 h-3.5 border border-white/30 border-t-white rounded-full animate-spin" /> 불러오는 중...</>
                    : `다음 ${PAGE_SIZE}개 더 보기`
                  }
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
