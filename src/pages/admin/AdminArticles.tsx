import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Clock,
  ExternalLink,
  Filter,
  RefreshCw,
  Search,
  Trash2,
  XCircle,
  Zap,
} from 'lucide-react';
import { format } from 'date-fns';
import { httpsCallable } from 'firebase/functions';
import {
  collection,
  doc,
  DocumentData,
  getCountFromServer,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  QueryDocumentSnapshot,
  startAfter,
  where,
} from 'firebase/firestore';
import { db, functions } from '@/lib/firebase';
import { useAuthStore } from '@/store/useAuthStore';

interface Article {
  id: string;
  title: string;
  source: string;
  sourceId: string;
  url: string;
  status: string;
  content?: string;
  relevanceScore?: number;
  relevanceBasis?: 'keyword_reject' | 'ai' | 'priority_source_override' | 'priority_source_fallback';
  relevanceReason?: string;
  filterReason?: string;
  category?: string;
  tags?: string[];
  summary?: string[];
  publishedAt?: any;
  collectedAt?: any;
  isPaid?: boolean;
}

interface RuntimeDoc {
  status?: string;
  updatedAt?: any;
  lastSuccessAt?: any;
  lastErrorAt?: any;
  lastError?: string;
  totalCollected?: number;
  totalFiltered?: number;
  totalAnalyzed?: number;
}

interface SourceHealth {
  sourceId: string;
  name: string;
  type: string;
  lastCollectedAt: any;
  todayCount: number;
  status: 'ok' | 'idle' | 'error';
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; icon: any }> = {
  pending: { label: '수집대기', color: 'text-blue-300', bg: 'bg-blue-500/10 border-blue-500/30', icon: Clock },
  filtering: { label: '분류중', color: 'text-sky-300', bg: 'bg-sky-500/10 border-sky-500/30', icon: Filter },
  filtered: { label: '분석대기', color: 'text-cyan-300', bg: 'bg-cyan-500/10 border-cyan-500/30', icon: Filter },
  analyzing: { label: '분석중', color: 'text-amber-300', bg: 'bg-amber-500/10 border-amber-500/30', icon: Activity },
  analyzed: { label: '분석완료', color: 'text-emerald-300', bg: 'bg-emerald-500/10 border-emerald-500/30', icon: CheckCircle },
  published: { label: '분석완료', color: 'text-emerald-300', bg: 'bg-emerald-500/10 border-emerald-500/30', icon: CheckCircle },
  rejected: { label: '제외', color: 'text-rose-300', bg: 'bg-rose-500/10 border-rose-500/30', icon: XCircle },
  ai_error: { label: '오류', color: 'text-orange-300', bg: 'bg-orange-500/10 border-orange-500/30', icon: AlertTriangle },
  analysis_error: { label: '오류', color: 'text-orange-300', bg: 'bg-orange-500/10 border-orange-500/30', icon: AlertTriangle },
};

const SOURCE_OPTIONS = [
  { value: '', label: '전체 매체' },
  { value: 'thebell', label: '더벨' },
  { value: 'marketinsight', label: '마켓인사이트' },
  { value: 'hankyung_ma', label: '한국경제 M&A' },
];

const SOURCE_HEALTH_IDS = [
  { id: 'thebell', name: '더벨', type: 'puppeteer' },
  { id: 'marketinsight', name: '마켓인사이트', type: 'puppeteer' },
  { id: 'hankyung_ma', name: '한국경제 M&A', type: 'rss' },
];

const PAGE_SIZE = 30;
const COLLECTED_STATUSES = ['pending', 'filtering', 'filtered', 'analyzing', 'ai_error', 'analysis_error'];

function formatTimestamp(value: any, withYear = false) {
  if (!value) return '-';
  try {
    if (typeof value?.toDate === 'function') {
      return format(value.toDate(), withYear ? 'yyyy.MM.dd HH:mm' : 'MM.dd HH:mm');
    }
    if (typeof value?._seconds === 'number') {
      return format(new Date(value._seconds * 1000), withYear ? 'yyyy.MM.dd HH:mm' : 'MM.dd HH:mm');
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return format(date, withYear ? 'yyyy.MM.dd HH:mm' : 'MM.dd HH:mm');
  } catch {
    return '-';
  }
}

function workerTone(status?: string) {
  if (status === 'running') return 'border-blue-500/30 bg-blue-500/10 text-blue-200';
  if (status === 'error') return 'border-red-500/30 bg-red-500/10 text-red-200';
  return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
}

function workerLabel(status?: string) {
  if (status === 'running') return '작동 중';
  if (status === 'error') return '오류';
  return '대기';
}

function relevanceBasisLabel(basis?: Article['relevanceBasis']) {
  switch (basis) {
    case 'keyword_reject':
      return '키워드 규칙 제외';
    case 'priority_source_override':
      return '우선 매체 예외 통과';
    case 'priority_source_fallback':
      return '우선 매체 예외 보류 통과';
    case 'ai':
      return 'AI 판정';
    default:
      return '-';
  }
}

function ScoreBar({ score }: { score: number }) {
  const pct = Math.min(100, Math.max(0, score));
  const color = score >= 80 ? 'bg-emerald-500' : score >= 60 ? 'bg-amber-500' : 'bg-rose-500';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-12 text-right font-mono text-xs text-white/60">{Math.round(score)}점</span>
    </div>
  );
}

function ArticleRow({
  article,
  expanded,
  onToggle,
  onAnalyze,
}: {
  article: Article;
  expanded: boolean;
  onToggle: () => void;
  onAnalyze: (article: Article) => Promise<void>;
}) {
  const status = STATUS_CONFIG[article.status] || STATUS_CONFIG.pending;
  const StatusIcon = status.icon;

  return (
    <>
      <tr className="cursor-pointer border-b border-white/5 transition-colors hover:bg-white/3" onClick={onToggle}>
        <td className="px-4 py-3">
          <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${status.bg} ${status.color}`}>
            <StatusIcon className="h-2.5 w-2.5" />
            {status.label}
          </span>
        </td>
        <td className="max-w-xs px-4 py-3">
          <p className="truncate text-sm leading-snug text-white/90">{article.title}</p>
          <p className="mt-0.5 flex items-center gap-1 text-[10px] text-white/35">
            <span>{article.source}</span>
            {article.isPaid ? <span className="rounded bg-amber-500/20 px-1 py-0 text-[9px] font-bold text-amber-300">유료</span> : null}
          </p>
        </td>
        <td className="px-4 py-3 text-xs text-white/45">{article.category || '-'}</td>
        <td className="w-28 px-4 py-3">
          {article.relevanceScore != null ? <ScoreBar score={article.relevanceScore} /> : <span className="text-xs text-white/20">-</span>}
        </td>
        <td className="px-4 py-3 text-[11px] text-white/45">{formatTimestamp(article.collectedAt)}</td>
        <td className="px-4 py-3">
          {expanded ? <ChevronUp className="h-3.5 w-3.5 text-white/35" /> : <ChevronDown className="h-3.5 w-3.5 text-white/25" />}
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b border-white/5 bg-white/2">
          <td colSpan={6} className="px-4 pb-4 pt-2">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-3">
                {article.summary?.length ? (
                  <div>
                    <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-white/30">AI 요약</p>
                    <ul className="space-y-1">
                      {article.summary.map((item, index) => (
                        <li key={`${article.id}-summary-${index}`} className="flex gap-2 text-xs leading-relaxed text-white/65">
                          <span className="text-[#d4af37]">•</span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {(article.relevanceReason || article.filterReason) ? (
                  <div>
                    <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-white/30">분류 근거</p>
                    <p className="text-xs leading-relaxed text-white/55">{article.relevanceReason || article.filterReason}</p>
                    {article.relevanceBasis ? (
                      <p className="mt-1 text-[11px] text-white/35">
                        판정 기준: {relevanceBasisLabel(article.relevanceBasis)}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="space-y-3">
                {article.tags?.length ? (
                  <div>
                    <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-white/30">태그</p>
                    <div className="flex flex-wrap gap-1">
                      {article.tags.map((tag) => (
                        <span key={tag} className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-white/55">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="flex items-center gap-2">
                  {article.url ? (
                    <a
                      href={article.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(event) => event.stopPropagation()}
                      className="inline-flex items-center gap-1 text-xs text-[#d4af37]/80 transition-colors hover:text-[#d4af37]"
                    >
                      <ExternalLink className="h-3 w-3" />
                      원문 보기
                    </a>
                  ) : null}
                  {article.status !== 'analyzed' && article.status !== 'published' ? (
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        void onAnalyze(article);
                      }}
                      className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-blue-300 transition-colors hover:bg-blue-500/10 hover:text-blue-200"
                    >
                      <Zap className="h-3 w-3" />
                      수동 분석
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function SourceHealthPanel({ items }: { items: SourceHealth[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {items.map((item) => (
        <div key={item.sourceId} className="rounded-xl border border-white/5 bg-gray-800/60 p-3">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-white/80">{item.name}</p>
              <p className="text-[10px] uppercase tracking-[0.18em] text-white/25">{item.type}</p>
            </div>
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                item.status === 'ok'
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                  : item.status === 'error'
                    ? 'border-red-500/30 bg-red-500/10 text-red-300'
                    : 'border-white/10 bg-white/5 text-white/40'
              }`}
            >
              {item.status === 'ok' ? '정상' : item.status === 'error' ? '오류' : '대기'}
            </span>
          </div>
          <p className="text-xs text-white/45">24시간 수집 {item.todayCount.toLocaleString()}건</p>
          <p className="mt-1 text-xs text-white/35">마지막 수집 {formatTimestamp(item.lastCollectedAt, true)}</p>
        </div>
      ))}
    </div>
  );
}

export default function AdminArticles() {
  const { user } = useAuthStore();
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sourceHealth, setSourceHealth] = useState<SourceHealth[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedSource, setSelectedSource] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('');
  const [dateRange, setDateRange] = useState<'today' | '3d' | '7d' | '30d' | ''>('');
  const [stats, setStats] = useState({ total: 0, collected: 0, analyzed: 0, rejected: 0 });
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeResult, setAnalyzeResult] = useState<{ success: boolean; message: string } | null>(null);
  const [deduping, setDeduping] = useState(false);
  const [dedupResult, setDedupResult] = useState<{ removedCount: number } | null>(null);
  const [analysisWorker, setAnalysisWorker] = useState<RuntimeDoc>({});
  const [runtimeAccessError, setRuntimeAccessError] = useState<string | null>(null);
  const lastDocRef = useRef<QueryDocumentSnapshot<DocumentData> | null>(null);

  const loadArticles = useCallback(async (reset = true) => {
    if (reset) {
      setLoading(true);
      lastDocRef.current = null;
    } else {
      setLoadingMore(true);
    }

    try {
      const conditions: any[] = [];
      if (selectedSource) conditions.push(where('sourceId', '==', selectedSource));
      if (selectedStatus === 'collected') {
        conditions.push(where('status', 'in', ['pending', 'filtering', 'filtered']));
      } else if (selectedStatus === 'analyzed') {
        conditions.push(where('status', 'in', ['analyzed', 'published']));
      } else if (selectedStatus === 'error') {
        conditions.push(where('status', 'in', ['ai_error', 'analysis_error']));
      } else if (selectedStatus) {
        conditions.push(where('status', '==', selectedStatus));
      }

      if (dateRange) {
        const days = dateRange === 'today' ? 1 : dateRange === '3d' ? 3 : dateRange === '7d' ? 7 : 30;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        conditions.push(where('collectedAt', '>=', since));
      }

      let articleQuery = query(collection(db, 'articles'), ...conditions, orderBy('collectedAt', 'desc'), limit(PAGE_SIZE + 1));

      if (!reset && lastDocRef.current) {
        articleQuery = query(
          collection(db, 'articles'),
          ...conditions,
          orderBy('collectedAt', 'desc'),
          startAfter(lastDocRef.current),
          limit(PAGE_SIZE + 1),
        );
      }

      const snapshot = await getDocs(articleQuery);
      const docs = snapshot.docs;
      const more = docs.length > PAGE_SIZE;
      const sliced = more ? docs.slice(0, PAGE_SIZE) : docs;

      let loaded = sliced.map((item) => ({ id: item.id, ...(item.data() as Article) }));
      if (search.trim()) {
        const keyword = search.toLowerCase();
        loaded = loaded.filter((item) => item.title?.toLowerCase().includes(keyword) || item.source?.toLowerCase().includes(keyword));
      }

      if (reset) {
        setArticles(loaded);
      } else {
        setArticles((prev) => [...prev, ...loaded]);
      }

      const nextLastDoc = sliced[sliced.length - 1] ?? null;
      lastDocRef.current = nextLastDoc;
      setHasMore(more);

      if (reset) {
        const [totalSnap, collectedSnap, analyzedSnap, rejectedSnap] = await Promise.all([
          getCountFromServer(collection(db, 'articles')),
          getCountFromServer(query(collection(db, 'articles'), where('status', 'in', COLLECTED_STATUSES))),
          getCountFromServer(query(collection(db, 'articles'), where('status', 'in', ['analyzed', 'published']))),
          getCountFromServer(query(collection(db, 'articles'), where('status', '==', 'rejected'))),
        ]);
        setStats({
          total: totalSnap.data().count,
          collected: collectedSnap.data().count,
          analyzed: analyzedSnap.data().count,
          rejected: rejectedSnap.data().count,
        });
      }
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [dateRange, search, selectedSource, selectedStatus]);

  const loadSourceHealth = useCallback(async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await Promise.all(
      SOURCE_HEALTH_IDS.map(async (source) => {
        try {
          const [recentSnap, todaySnap] = await Promise.all([
            getDocs(query(collection(db, 'articles'), where('sourceId', '==', source.id), orderBy('collectedAt', 'desc'), limit(1))),
            getCountFromServer(query(collection(db, 'articles'), where('sourceId', '==', source.id), where('collectedAt', '>=', since))),
          ]);
          const lastCollectedAt = recentSnap.docs[0]?.data()?.collectedAt ?? null;
          const lastDate = typeof lastCollectedAt?.toDate === 'function'
            ? lastCollectedAt.toDate()
            : typeof lastCollectedAt?._seconds === 'number'
              ? new Date(lastCollectedAt._seconds * 1000)
              : null;
          const activeWithinSixHours = lastDate ? Date.now() - lastDate.getTime() < 6 * 60 * 60 * 1000 : false;
          return {
            sourceId: source.id,
            name: source.name,
            type: source.type,
            lastCollectedAt,
            todayCount: todaySnap.data().count,
            status: activeWithinSixHours ? 'ok' : 'idle',
          } as SourceHealth;
        } catch {
          return {
            sourceId: source.id,
            name: source.name,
            type: source.type,
            lastCollectedAt: null,
            todayCount: 0,
            status: 'error',
          } as SourceHealth;
        }
      }),
    );
    setSourceHealth(rows);
  }, []);

  useEffect(() => {
    void loadSourceHealth();
    const unsubAnalysis = onSnapshot(
      doc(db, 'systemRuntime', 'worker_continuous-analysis'),
      (snapshot) => {
        setRuntimeAccessError(null);
        setAnalysisWorker((snapshot.data() || {}) as RuntimeDoc);
      },
      (error) => {
        console.error('Failed to subscribe analysis runtime:', error);
        setRuntimeAccessError('운영 상태 문서 권한 문제로 실시간 워커 표시를 일시 중단했습니다.');
        setAnalysisWorker({});
      },
    );
    return () => {
      unsubAnalysis();
    };
  }, [loadSourceHealth]);

  useEffect(() => {
    void loadArticles(true);
  }, [dateRange, search, selectedSource, selectedStatus, loadArticles]);

  const handleDeleteAll = async () => {
    if (!window.confirm('전체 기사를 모두 삭제합니다. 이 작업은 되돌릴 수 없습니다.')) return;

    setDeleting(true);
    try {
      const response = await fetch('https://deleteallarticleshttp-mp66iufeia-uc.a.run.app', {
        method: 'POST',
        headers: { 'x-uid': (user as any)?.uid },
      });
      const data = await response.json();
      if (data.success) {
        alert(`${data.deletedCount}건의 기사를 삭제했습니다.`);
        void loadArticles(true);
      } else {
        alert(`삭제 실패: ${data.error}`);
      }
    } catch (error: any) {
      alert(`삭제 실패: ${error.message}`);
    } finally {
      setDeleting(false);
    }
  };

  const handleDeleteExcluded = async () => {
    if (!window.confirm('제외 기사만 일괄 삭제합니다.')) return;

    setDeleting(true);
    try {
      const response = await fetch('https://deleteexcludedarticleshttp-mp66iufeia-uc.a.run.app', {
        method: 'POST',
        headers: { 'x-uid': (user as any)?.uid },
      });
      const data = await response.json();
      if (data.success) {
        alert(`${data.deletedCount}건의 제외 기사를 삭제했습니다.`);
        void loadArticles(true);
      } else {
        alert(`삭제 실패: ${data.error}`);
      }
    } catch (error: any) {
      alert(`삭제 실패: ${error.message}`);
    } finally {
      setDeleting(false);
    }
  };

  const handleDeleteAllOutputs = async () => {
    if (!window.confirm('모든 분석 결과를 삭제합니다. 이 작업은 되돌릴 수 없습니다.')) return;

    setDeleting(true);
    try {
      const response = await fetch('https://deletealloutputshttp-mp66iufeia-uc.a.run.app', {
        method: 'POST',
        headers: { 'x-uid': (user as any)?.uid },
      });
      const data = await response.json();
      if (data.success) {
        alert(`${data.deletedCount}건의 분석 결과를 삭제했습니다.`);
      } else {
        alert(`삭제 실패: ${data.error}`);
      }
    } catch (error: any) {
      alert(`삭제 실패: ${error.message}`);
    } finally {
      setDeleting(false);
    }
  };

  const handleFindAndRemoveDuplicates = async () => {
    if (!window.confirm('중복 기사를 탐지하고 낮은 점수의 중복을 제외 처리합니다. 계속하시겠습니까?')) return;
    setDeduping(true);
    setDedupResult(null);
    try {
      const fn = httpsCallable(functions, 'findAndRemoveDuplicates');
      const result = (await fn({})) as any;
      setDedupResult({ removedCount: result.data.removedCount });
      if (result.data.removedCount > 0) {
        void loadArticles(true);
      }
    } catch (error: any) {
      alert(`중복 제거 실패: ${error.message}`);
    } finally {
      setDeduping(false);
    }
  };

  const handleAnalyze = async (article: Article) => {
    setAnalyzing(true);
    setAnalyzeResult(null);
    try {
      const analyzeManualArticle = httpsCallable(functions, 'analyzeManualArticle');
      const content = article.content || article.summary?.join(' ') || article.title;
      const result = (await analyzeManualArticle({
        title: article.title,
        content,
        source: article.source,
        url: article.url,
        publishedAt: article.publishedAt,
      })) as any;

      if (result.data.success) {
        setAnalyzeResult({
          success: true,
          message: `수동 분석을 완료했습니다. 신뢰도 ${(result.data.confidence * 100).toFixed(0)}%`,
        });
        setTimeout(() => {
          void loadArticles(true);
        }, 1500);
      } else {
        setAnalyzeResult({ success: false, message: `분석 실패: ${result.data.error}` });
      }
    } catch (error: any) {
      setAnalyzeResult({ success: false, message: `분석 실패: ${error.message}` });
    } finally {
      setAnalyzing(false);
    }
  };

  const statusButtons = [
    { value: '', label: '전체' },
    { value: 'collected', label: '수집대기' },
    { value: 'analyzing', label: '분석중' },
    { value: 'analyzed', label: '분석완료' },
    { value: 'rejected', label: '제외' },
    { value: 'error', label: '오류' },
  ] as const;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">기사 흐름 관리</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => {
              void loadArticles(true);
              void loadSourceHealth();
            }}
            disabled={deleting}
            className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${deleting ? 'animate-spin' : ''}`} />
            새로고침
          </button>
          <button
            onClick={handleFindAndRemoveDuplicates}
            disabled={deduping || deleting}
            className="inline-flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-300 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${deduping ? 'animate-spin' : ''}`} />
            중복 제거
          </button>
          <button
            onClick={handleDeleteExcluded}
            disabled={deleting}
            className="inline-flex items-center gap-2 rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-1.5 text-xs text-orange-300 transition-colors hover:bg-orange-500/20 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            제외 기사 삭제
          </button>
          <button
            onClick={handleDeleteAll}
            disabled={deleting}
            className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 transition-colors hover:bg-red-500/20 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            전체 기사 삭제
          </button>
          <button
            onClick={handleDeleteAllOutputs}
            disabled={deleting}
            className="inline-flex items-center gap-2 rounded-lg border border-fuchsia-500/30 bg-fuchsia-500/10 px-3 py-1.5 text-xs text-fuchsia-300 transition-colors hover:bg-fuchsia-500/20 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            분석 결과 삭제
          </button>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-1">
        <div className={`rounded-2xl border p-4 ${workerTone(analysisWorker.status)}`}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-white/45">Analysis Worker</p>
              <p className="mt-2 text-lg font-semibold text-white">{workerLabel(analysisWorker.status)}</p>
            </div>
            <Activity className={`h-5 w-5 ${analysisWorker.status === 'running' ? 'animate-pulse' : ''}`} />
          </div>
          <p className="mt-3 text-xs text-white/65">마지막 성공 {formatTimestamp(analysisWorker.lastSuccessAt, true)}</p>
          <p className="mt-1 text-xs text-white/65">마지막 오류 {formatTimestamp(analysisWorker.lastErrorAt, true)}</p>
          {analysisWorker.lastError ? <p className="mt-2 text-xs leading-relaxed text-red-200/90">{analysisWorker.lastError}</p> : null}
        </div>
      </div>

      {analyzeResult ? (
        <div
          className={`flex items-center gap-2 rounded-lg border px-4 py-3 text-sm font-medium ${
            analyzeResult.success
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-red-500/30 bg-red-500/10 text-red-300'
          }`}
        >
          {analyzeResult.success ? <CheckCircle className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
          {analyzeResult.message}
        </div>
      ) : null}

      {dedupResult ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm font-medium text-amber-300">
          <CheckCircle className="h-4 w-4" />
          중복 {dedupResult.removedCount}건이 제외 처리되었습니다.
        </div>
      ) : null}

      {runtimeAccessError ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {runtimeAccessError}
        </div>
      ) : null}

      {sourceHealth.length ? (
        <div className="space-y-2">
          <p className="flex items-center gap-1 text-xs text-white/35">
            <Activity className="h-3.5 w-3.5" />
            핵심 유료/핵심 매체 수집 현황
          </p>
          <SourceHealthPanel items={sourceHealth} />
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-4">
        {[
          { label: '전체 기사', value: stats.total, color: 'text-white' },
          { label: '수집 큐', value: stats.collected, color: 'text-blue-300' },
          { label: '분석 완료', value: stats.analyzed, color: 'text-emerald-300' },
          { label: '제외', value: stats.rejected, color: 'text-rose-300' },
        ].map((item) => (
          <div key={item.label} className="rounded-xl border border-white/5 bg-gray-800/60 p-4">
            <p className="text-xs font-medium text-white/35">{item.label}</p>
            <p className={`mt-1 text-2xl font-bold ${item.color}`}>{item.value.toLocaleString()}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-white/5 bg-gray-800/60 p-4">
        <div className="flex flex-wrap gap-3">
          <div className="relative min-w-48 flex-1">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/25" />
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="제목 또는 매체 검색"
              className="w-full rounded-lg border border-white/10 bg-white/5 py-2 pl-8 pr-3 text-sm text-white placeholder-white/25 focus:outline-none focus:border-[#d4af37]/50"
            />
          </div>

          <select
            value={selectedSource}
            onChange={(event) => setSelectedSource(event.target.value)}
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 focus:outline-none focus:border-[#d4af37]/50"
          >
            {SOURCE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <div className="flex flex-wrap gap-1">
            {statusButtons.map((status) => (
              <button
                key={status.value}
                onClick={() => setSelectedStatus(status.value)}
                className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  selectedStatus === status.value
                    ? 'border-[#d4af37]/50 bg-[#d4af37]/20 text-[#d4af37]'
                    : 'border-white/10 bg-white/5 text-white/55 hover:text-white/80'
                }`}
              >
                {status.label}
              </button>
            ))}
          </div>

          <div className="flex gap-1">
            {[
              ['', '전체'],
              ['today', '오늘'],
              ['3d', '3일'],
              ['7d', '7일'],
              ['30d', '30일'],
            ].map(([value, label]) => (
              <button
                key={value}
                onClick={() => setDateRange(value as typeof dateRange)}
                className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  dateRange === value
                    ? 'border-[#d4af37]/50 bg-[#d4af37]/20 text-[#d4af37]'
                    : 'border-white/10 bg-white/5 text-white/55 hover:text-white/80'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-white/5 bg-gray-800/60">
        {loading ? (
          <div className="flex justify-center py-20">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-[#d4af37]/40 border-t-[#d4af37]" />
          </div>
        ) : articles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-white/25">
            <AlertTriangle className="mb-2 h-8 w-8" />
            <p className="text-sm">조건에 맞는 기사가 없습니다.</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/5">
                    <th className="w-24 px-4 py-3 text-left text-[10px] font-bold uppercase tracking-[0.18em] text-white/25">상태</th>
                    <th className="px-4 py-3 text-left text-[10px] font-bold uppercase tracking-[0.18em] text-white/25">제목 / 매체</th>
                    <th className="w-28 px-4 py-3 text-left text-[10px] font-bold uppercase tracking-[0.18em] text-white/25">카테고리</th>
                    <th className="w-36 px-4 py-3 text-left text-[10px] font-bold uppercase tracking-[0.18em] text-white/25">관련도</th>
                    <th className="w-28 px-4 py-3 text-left text-[10px] font-bold uppercase tracking-[0.18em] text-white/25">수집 시각</th>
                    <th className="w-8 px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {articles.map((article) => (
                    <ArticleRow
                      key={article.id}
                      article={article}
                      expanded={expandedId === article.id}
                      onToggle={() => setExpandedId((prev) => (prev === article.id ? null : article.id))}
                      onAnalyze={handleAnalyze}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {hasMore ? (
              <div className="flex justify-center border-t border-white/5 px-4 py-3">
                <button
                  onClick={() => void loadArticles(false)}
                  disabled={loadingMore}
                  className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50"
                >
                  {loadingMore ? (
                    <>
                      <div className="h-3.5 w-3.5 animate-spin rounded-full border border-white/30 border-t-white" />
                      불러오는 중
                    </>
                  ) : (
                    `${PAGE_SIZE}건 더 보기`
                  )}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>

      {analyzing ? <div className="text-xs text-white/35">수동 분석 요청을 처리 중입니다.</div> : null}
    </div>
  );
}
