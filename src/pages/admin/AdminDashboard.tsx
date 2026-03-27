import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Globe,
  Layers3,
  Loader2,
  Newspaper,
  RefreshCw,
  Rss,
  SearchX,
  Sparkles,
  Tags,
  Shield,
} from 'lucide-react';
import {
  collection,
  doc,
  getDoc,
  getCountFromServer,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { formatDistanceToNow } from 'date-fns';
import { db, functions } from '@/lib/firebase';
import { dedupeSourceCatalog } from '@/lib/sourceCatalog';

type WorkerStatus = 'idle' | 'running' | 'error' | string;
type ArticleStatus =
  | 'pending'
  | 'filtering'
  | 'filtered'
  | 'analyzing'
  | 'analyzed'
  | 'published'
  | 'rejected'
  | 'ai_error'
  | 'analysis_error'
  | string;

interface RuntimeDoc {
  status?: WorkerStatus;
  lastSuccessAt?: any;
  lastErrorAt?: any;
  lastError?: string;
  totalCollected?: number;
  totalFiltered?: number;
  totalAnalyzed?: number;
  updatedAt?: any;
  articleCounts?: Record<string, number>;
}

interface SourceRow {
  id: string;
  name: string;
  type: string;
  status: string;
  pricingTier?: string | null;
  lastStatus?: string | null;
  errorMessage?: string | null;
}

interface SourceHealthRow {
  id: string;
  name: string;
  type: string;
  pricingTier?: string | null;
  collected24h: number;
  analyzed24h: number;
  rejected24h: number;
  lastCollectedAt: Date | null;
  lastStatus?: string | null;
  errorMessage?: string | null;
}

const COLLECTED_STATUSES: ArticleStatus[] = ['pending', 'filtering', 'filtered', 'analyzing', 'ai_error', 'analysis_error'];
const EXCLUDED_STATUSES: ArticleStatus[] = ['rejected'];
const ANALYZED_STATUSES: ArticleStatus[] = ['analyzed', 'published'];

function toDate(value: any): Date | null {
  if (!value) return null;
  if (typeof value?.toDate === 'function') return value.toDate();
  if (typeof value?._seconds === 'number') return new Date(value._seconds * 1000);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatRelative(value: any) {
  const date = toDate(value);
  if (!date) return '-';
  return formatDistanceToNow(date, { addSuffix: true });
}

function getWorkerTone(status?: WorkerStatus) {
  if (status === 'running') return 'text-blue-300 border-blue-500/30 bg-blue-500/10';
  if (status === 'error') return 'text-red-300 border-red-500/30 bg-red-500/10';
  return 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10';
}

function getSourceTypeIcon(type?: string) {
  if (type === 'rss') return Rss;
  if (type === 'api') return Globe;
  return Layers3;
}

function StatCard({
  title,
  value,
  hint,
  icon: Icon,
  tone,
}: {
  title: string;
  value: string | number;
  hint: string;
  icon: typeof Activity;
  tone: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-[#0f1728] p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-white/35">{title}</p>
          <p className={`mt-3 text-3xl font-semibold ${tone}`}>{value}</p>
          <p className="mt-2 text-sm text-white/45">{hint}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-3">
          <Icon className={`h-5 w-5 ${tone}`} />
        </div>
      </div>
    </div>
  );
}

export default function AdminDashboard() {
  const [loading, setLoading] = useState(true);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [sourceHealth, setSourceHealth] = useState<SourceHealthRow[]>([]);
  const [collectionWorker, setCollectionWorker] = useState<RuntimeDoc>({});
  const [analysisWorker, setAnalysisWorker] = useState<RuntimeDoc>({});
  const [continuousRuntime, setContinuousRuntime] = useState<RuntimeDoc>({});
  const [counts, setCounts] = useState({
    collected: 0,
    excluded: 0,
    analyzed: 0,
    errors: 0,
    activeSources: 0,
  });
  const [runningAction, setRunningAction] = useState<'collection' | 'premiumCollection' | 'analysis' | null>(null);
  const [keywordConfig, setKeywordConfig] = useState<{ titleKeywords: string[]; bypassSourcePatterns: string[] } | null>(null);

  const loadDashboard = async () => {
    setLoading(true);
    try {
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [
        globalSourcesSnap,
        collectedSnap,
        excludedSnap,
        analyzedSnap,
        errorsSnap,
        recentArticlesSnap,
      ] = await Promise.all([
        getDocs(query(collection(db, 'globalSources'), orderBy('relevanceScore', 'desc'))),
        getCountFromServer(query(collection(db, 'articles'), where('status', 'in', COLLECTED_STATUSES))),
        getCountFromServer(query(collection(db, 'articles'), where('status', 'in', EXCLUDED_STATUSES))),
        getCountFromServer(query(collection(db, 'articles'), where('status', 'in', ANALYZED_STATUSES))),
        getCountFromServer(query(collection(db, 'articles'), where('status', 'in', ['ai_error', 'analysis_error']))),
        getDocs(query(collection(db, 'articles'), where('collectedAt', '>=', since24h), orderBy('collectedAt', 'desc'), limit(500))),
      ]);

      // 키워드 설정 로드
      const kwSnap = await getDoc(doc(db, 'systemSettings', 'globalKeywords'));
      if (kwSnap.exists()) {
        const kwData = kwSnap.data() as any;
        setKeywordConfig({
          titleKeywords: Array.isArray(kwData.titleKeywords) ? kwData.titleKeywords : [],
          bypassSourcePatterns: Array.isArray(kwData.bypassSourcePatterns) ? kwData.bypassSourcePatterns : [],
        });
      }

      const dedupedSources = dedupeSourceCatalog(
        globalSourcesSnap.docs.map((item) => ({ id: item.id, ...(item.data() as any) })),
      ) as SourceRow[];

      const articleRows = recentArticlesSnap.docs.map((item) => ({ id: item.id, ...(item.data() as any) }));
      const healthRows = dedupedSources
        .filter((source) => source.status === 'active')
        .map((source) => {
          const related = articleRows.filter((article) => article.globalSourceId === source.id || article.sourceId === source.id);
          return {
            id: source.id,
            name: source.name,
            type: source.type,
            pricingTier: source.pricingTier,
            collected24h: related.filter((article) => COLLECTED_STATUSES.includes(article.status)).length,
            analyzed24h: related.filter((article) => ANALYZED_STATUSES.includes(article.status)).length,
            rejected24h: related.filter((article) => EXCLUDED_STATUSES.includes(article.status)).length,
            lastCollectedAt: related.length > 0 ? toDate(related[0]?.collectedAt) : null,
            lastStatus: source.lastStatus,
            errorMessage: source.errorMessage,
          };
        })
        .sort((a, b) => (b.collected24h + b.analyzed24h) - (a.collected24h + a.analyzed24h));

      setSources(dedupedSources);
      setSourceHealth(healthRows);
      setCounts({
        collected: collectedSnap.data().count,
        excluded: excludedSnap.data().count,
        analyzed: analyzedSnap.data().count,
        errors: errorsSnap.data().count,
        activeSources: dedupedSources.filter((source) => source.status === 'active').length,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDashboard().catch(console.error);

    const unsubCollection = onSnapshot(doc(db, 'systemRuntime', 'worker_continuous-collection'), (snap) => {
      setCollectionWorker((snap.data() || {}) as RuntimeDoc);
    });
    const unsubAnalysis = onSnapshot(doc(db, 'systemRuntime', 'worker_continuous-analysis'), (snap) => {
      setAnalysisWorker((snap.data() || {}) as RuntimeDoc);
    });
    const unsubContinuous = onSnapshot(doc(db, 'systemRuntime', 'continuousPipeline'), (snap) => {
      setContinuousRuntime((snap.data() || {}) as RuntimeDoc);
    });

    return () => {
      unsubCollection();
      unsubAnalysis();
      unsubContinuous();
    };
  }, []);

  const triggerWorker = async (type: 'collection' | 'premiumCollection' | 'analysis') => {
    setRunningAction(type);
    try {
      const fn = httpsCallable(
        functions,
        type === 'collection'
          ? 'triggerContinuousCollectionNow'
          : type === 'premiumCollection'
          ? 'triggerContinuousPremiumCollectionNow'
          : 'triggerContinuousAnalysisNow',
      );
      await fn({ resetLease: true });
      await loadDashboard();
    } finally {
      setRunningAction(null);
    }
  };

  const workerCards = useMemo(() => ([
    {
      key: 'collection',
      title: 'Collection Worker',
      status: collectionWorker.status || 'idle',
      runtime: collectionWorker,
      description: collectionWorker.status === 'running'
        ? '현재 기사 수집 워커가 실행 중입니다.'
        : '현재 수집 워커는 대기 상태입니다.',
    },
    {
      key: 'analysis',
      title: 'Analysis Worker',
      status: analysisWorker.status || 'idle',
      runtime: analysisWorker,
      description: analysisWorker.status === 'running'
        ? '현재 AI 분류/분석 워커가 실행 중입니다.'
        : '현재 분석 워커는 대기 상태입니다.',
    },
  ]), [analysisWorker, collectionWorker]);

  const topSourceRows = sourceHealth.slice(0, 8);
  const warningSources = sourceHealth.filter((source) => source.lastStatus === 'error' || source.errorMessage).slice(0, 6);
  const runtimeCounts = continuousRuntime.articleCounts || {};

  return (
    <div className="space-y-6 pb-10">
      <div className="flex flex-col gap-4 rounded-[28px] border border-[#23304a] bg-[linear-gradient(135deg,#0f1728_0%,#13203a_100%)] px-6 py-6 text-white shadow-[0_28px_90px_rgba(0,0,0,0.25)] lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-3xl">
          <p className="text-xs uppercase tracking-[0.24em] text-cyan-300/80">Superadmin Control Room</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">실시간 수집, 제외, 분석 운영 대시보드</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => loadDashboard().catch(console.error)}
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-white/80 transition hover:bg-white/10"
          >
            <RefreshCw className="h-4 w-4" />
            새로고침
          </button>
          <button
            onClick={() => triggerWorker('collection').catch(console.error)}
            disabled={runningAction !== null}
            className="inline-flex items-center gap-2 rounded-xl border border-cyan-500/20 bg-cyan-500/10 px-4 py-2 text-sm font-medium text-cyan-200 transition hover:bg-cyan-500/20 disabled:opacity-50"
          >
            {runningAction === 'collection' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            수집 즉시 실행
          </button>
          <button
            onClick={() => triggerWorker('premiumCollection').catch(console.error)}
            disabled={runningAction !== null}
            className="inline-flex items-center gap-2 rounded-xl border border-violet-500/20 bg-violet-500/10 px-4 py-2 text-sm font-medium text-violet-200 transition hover:bg-violet-500/20 disabled:opacity-50"
          >
            {runningAction === 'premiumCollection' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            유료 매체 수집
          </button>
          <button
            onClick={() => triggerWorker('analysis').catch(console.error)}
            disabled={runningAction !== null}
            className="inline-flex items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-50"
          >
            {runningAction === 'analysis' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            분석 즉시 실행
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex min-h-[280px] items-center justify-center rounded-3xl border border-white/10 bg-[#0f1728]">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-300" />
        </div>
      ) : (
        <>
          {/* 키워드 필터 현황 배너 */}
          {keywordConfig !== null && (
            <div className="flex items-center justify-between rounded-2xl border border-[#d4af37]/20 bg-[#d4af37]/5 px-5 py-4">
              <div className="flex items-center gap-4">
                <div className="rounded-xl border border-[#d4af37]/30 bg-[#d4af37]/10 p-2.5">
                  <Tags className="h-5 w-5 text-[#d4af37]" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-white">
                    제목 키워드 필터 활성
                    <span className="ml-2 rounded-full bg-[#d4af37]/20 px-2 py-0.5 text-xs font-bold text-[#d4af37]">
                      {keywordConfig.titleKeywords.length}개
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-white/45">
                    키워드가 제목에 하나라도 포함(OR)된 기사만 수집 ·{' '}
                    <span className="text-green-400">
                      <Shield className="inline h-3 w-3 mr-0.5" />
                      우선 매체: {keywordConfig.bypassSourcePatterns.join(', ')}
                    </span>
                  </p>
                </div>
              </div>
              <Link
                to="/admin/keywords"
                className="text-xs font-medium text-[#d4af37]/70 hover:text-[#d4af37] transition-colors underline-offset-2 hover:underline"
              >
                키워드 관리 →
              </Link>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <StatCard title="Collected Queue" value={counts.collected} hint="수집 후 처리 대기 기사" icon={Newspaper} tone="text-cyan-300" />
            <StatCard title="Excluded" value={counts.excluded} hint="제외 처리된 기사" icon={SearchX} tone="text-rose-300" />
            <StatCard title="Analyzed" value={counts.analyzed} hint="분석 완료 기사" icon={Sparkles} tone="text-emerald-300" />
            <StatCard title="AI Errors" value={counts.errors} hint="AI 재시도 대기 오류 기사" icon={AlertTriangle} tone="text-amber-300" />
            <StatCard title="Active Sources" value={counts.activeSources} hint="현재 활성 매체 수" icon={Globe} tone="text-violet-300" />
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.35fr_0.95fr]">
            <div className="rounded-3xl border border-white/10 bg-[#0f1728] p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-white/35">Workers</p>
                  <h2 className="mt-2 text-xl font-semibold text-white">현재 워커 상태</h2>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-right">
                  <p className="text-xs text-white/35">마지막 사이클 결과</p>
                  <p className="mt-1 text-sm font-medium text-white">
                    수집 {continuousRuntime.totalCollected || 0}건 · 분류 {continuousRuntime.totalFiltered || 0}건 · 분석 {continuousRuntime.totalAnalyzed || 0}건
                  </p>
                </div>
              </div>

              <div className="mt-5 grid gap-4 lg:grid-cols-2">
                {workerCards.map((worker) => (
                  <div key={worker.key} className={`rounded-2xl border p-4 ${getWorkerTone(worker.status)}`}>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs uppercase tracking-[0.18em]">{worker.title}</p>
                        <p className="mt-2 text-lg font-semibold capitalize">{worker.status}</p>
                      </div>
                      {worker.status === 'running' ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />}
                    </div>
                    <p className="mt-3 text-sm leading-6 text-white/75">{worker.description}</p>
                    <div className="mt-4 space-y-1.5 text-xs text-white/60">
                      <p>Last success: {formatRelative(worker.runtime.lastSuccessAt)}</p>
                      <p>Last update: {formatRelative(worker.runtime.updatedAt)}</p>
                      <p>
                        Queue: pending {runtimeCounts.pending || 0} · filtering {runtimeCounts.filtering || 0} · filtered {runtimeCounts.filtered || 0} · analyzing {runtimeCounts.analyzing || 0}
                      </p>
                      {worker.runtime.lastError ? (
                        <p className="text-rose-200 break-all">
                          오류: {worker.runtime.lastError.length > 120 ? worker.runtime.lastError.substring(0, 120) + '...' : worker.runtime.lastError}
                        </p>
                      ) : null}
                      {worker.runtime.lastSuccessAt && worker.runtime.updatedAt && toDate(worker.runtime.lastSuccessAt)?.getTime() !== toDate(worker.runtime.updatedAt)?.getTime() && worker.status === 'error' ? (
                        <p className="text-amber-200/70 text-[10px]">마지막 성공: {formatRelative(worker.runtime.lastSuccessAt)}</p>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.4fr_0.9fr]">
            <div className="rounded-3xl border border-white/10 bg-[#0f1728] p-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-white/35">Source Health</p>
                  <h2 className="mt-2 text-xl font-semibold text-white">매체별 수집과 분석 현황</h2>
                </div>
                <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/55">
                  <BarChart3 className="h-3.5 w-3.5" />
                  최근 24시간 기준
                </div>
              </div>

              <div className="mt-5 overflow-hidden rounded-2xl border border-white/10">
                <table className="w-full text-left">
                  <thead className="bg-white/[0.03] text-xs uppercase tracking-[0.18em] text-white/35">
                    <tr>
                      <th className="px-4 py-3">Source</th>
                      <th className="px-4 py-3">Collected</th>
                      <th className="px-4 py-3">Excluded</th>
                      <th className="px-4 py-3">Analyzed</th>
                      <th className="px-4 py-3">Last Seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topSourceRows.map((source) => {
                      const Icon = getSourceTypeIcon(source.type);
                      return (
                        <tr key={source.id} className="border-t border-white/10 text-sm text-white/75">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              <div className="rounded-xl border border-white/10 bg-white/5 p-2">
                                <Icon className="h-4 w-4 text-white/55" />
                              </div>
                              <div>
                                <p className="font-medium text-white">{source.name}</p>
                                <p className="text-xs text-white/35">{source.type}{source.pricingTier ? ` · ${source.pricingTier}` : ''}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-cyan-300">{source.collected24h}</td>
                          <td className="px-4 py-3 text-rose-300">{source.rejected24h}</td>
                          <td className="px-4 py-3 text-emerald-300">{source.analyzed24h}</td>
                          <td className="px-4 py-3 text-white/45">{source.lastCollectedAt ? formatDistanceToNow(source.lastCollectedAt, { addSuffix: true }) : '-'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-3xl border border-white/10 bg-[#0f1728] p-5">
              <p className="text-xs uppercase tracking-[0.2em] text-white/35">Last Source Errors</p>
              <h2 className="mt-2 text-xl font-semibold text-white">마지막 소스 오류 기록</h2>
              <div className="mt-5 space-y-3">
                {warningSources.length === 0 ? (
                  <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-8 text-center text-sm text-emerald-200">
                    저장된 소스 오류가 없습니다.
                  </div>
                ) : warningSources.map((source) => (
                  <div key={source.id} className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-4">
                    <p className="font-medium text-white">{source.name}</p>
                    <p className="mt-1 text-xs text-white/50">{source.type}{source.pricingTier ? ` · ${source.pricingTier}` : ''}</p>
                    <p className="mt-3 text-sm text-white/70">{source.errorMessage || '마지막 오류 메시지가 없습니다.'}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
