import { useState, useEffect, useRef } from 'react';
import {
  Rss, Globe, Code2, Cpu, RefreshCw, CheckCircle,
  XCircle, Clock, AlertTriangle, Loader2,
  TrendingUp, Activity, Newspaper, ChevronDown, ChevronUp, Power
} from 'lucide-react';
import { db, functions } from '@/lib/firebase';
import { httpsCallable } from 'firebase/functions';
import {
  collection, query, where, orderBy, limit,
  getDocs, onSnapshot, doc, getCountFromServer, getDoc, setDoc
} from 'firebase/firestore';
import { Monitor, Wifi, WifiOff } from 'lucide-react';
import { format, subDays, startOfDay } from 'date-fns';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

// ─── 수집 방식 정의 ───────────────────────────────────────
const SOURCE_TYPES = [
  {
    id: 'rss',
    label: 'RSS',
    icon: Rss,
    color: 'text-orange-400',
    bg: 'bg-orange-500/10 border-orange-500/20',
    activeBg: 'bg-orange-500/20 border-orange-500/40',
    desc: '뉴스 피드 자동 수집',
  },
  {
    id: 'api',
    label: 'API',
    icon: Globe,
    color: 'text-blue-400',
    bg: 'bg-blue-500/10 border-blue-500/20',
    activeBg: 'bg-blue-500/20 border-blue-500/40',
    desc: '외부 뉴스 API 연동',
  },
  {
    id: 'scraping',
    label: '스크래핑',
    icon: Code2,
    color: 'text-purple-400',
    bg: 'bg-purple-500/10 border-purple-500/20',
    activeBg: 'bg-purple-500/20 border-purple-500/40',
    desc: 'Cheerio 웹 스크래핑',
  },
  {
    id: 'puppeteer',
    label: '로컬PC',
    icon: Cpu,
    color: 'text-green-400',
    bg: 'bg-green-500/10 border-green-500/20',
    activeBg: 'bg-green-500/20 border-green-500/40',
    desc: '더벨 · 마켓인사이트',
  },
];

interface SourceStat {
  sourceId: string;
  name: string;
  type: string;
  todayCount: number;
  lastCollectedAt: any;
  lastStatus: 'success' | 'error' | 'idle';
  errorMessage?: string;
}

interface CompanyStat {
  companyId: string;
  name: string;
  total: number;
  analyzed: number;
  today: number;
}

interface PcScraperStatus {
  source: string;
  status: 'success' | 'error' | 'running' | 'idle';
  found: number;
  collected: number;
  skipped: number;
  errorMessage?: string;
  updatedAt?: any;
  durationMs?: number;
}

export default function AdminDashboard() {
  const [activeType, setActiveType] = useState<string>('all');
  const [sources, setSources] = useState<any[]>([]);
  const [sourceStats, setSourceStats] = useState<SourceStat[]>([]);
  const [trendData, setTrendData] = useState<any[]>([]);
  const [globalStats, setGlobalStats] = useState({
    totalToday: 0,
    totalPending: 0,
    totalAnalyzed: 0,
    totalSources: 0,
    errorSources: 0,
  });
  const [loading, setLoading] = useState(true);
  const [pcScrapers, setPcScrapers] = useState<PcScraperStatus[]>([]);

  // 파이프라인 제어
  const [recentRuns, setRecentRuns] = useState<any[]>([]);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [pipelineControl, setPipelineControl] = useState<any>({});
  const [togglingPipeline, setTogglingPipeline] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    loadAll();
    // 파이프라인 제어 상태 실시간 구독
    const unsub = onSnapshot(doc(db, 'systemSettings', 'pipelineControl'), (snap) => {
      setPipelineControl(snap.exists() ? snap.data() : {});
    });
    unsubRef.current = unsub;
    return () => unsub();
  }, []);

  const loadAll = async () => {
    setLoading(true);
    try {
      await Promise.all([
        loadGlobalSources(),
        loadGlobalStats(),
        loadTrendData(),
        loadRecentRuns(),
        loadPcScraperStatus(),
      ]);
    } finally {
      setLoading(false);
    }
  };

  const loadGlobalSources = async () => {
    const snap = await getDocs(collection(db, 'globalSources'));
    const srcs = snap.docs.map(d => ({ id: d.id, ...d.data() as any }));
    setSources(srcs);
    // 소스별 오늘 수집 건수 (sourceId 필드로 조회)
    const today = startOfDay(new Date());
    const stats: SourceStat[] = await Promise.all(srcs.slice(0, 30).map(async src => {
      try {
        const q = query(
          collection(db, 'articles'),
          where('sourceId', '==', src.id),
          where('collectedAt', '>=', today)
        );
        const cnt = await getCountFromServer(q);
        return {
          sourceId: src.id,
          name: src.name,
          type: src.type,
          todayCount: cnt.data().count,
          lastCollectedAt: src.lastScrapedAt || null,
          lastStatus: src.lastStatus || 'idle',
          errorMessage: src.errorMessage,
        } as SourceStat;
      } catch {
        return {
          sourceId: src.id,
          name: src.name,
          type: src.type,
          todayCount: 0,
          lastCollectedAt: null,
          lastStatus: 'idle' as const,
        };
      }
    }));
    setSourceStats(stats);
  };

  const loadGlobalStats = async () => {
    const today = startOfDay(new Date());
    const [todaySnap, pendingSnap, analyzedSnap, sourcesSnap] = await Promise.all([
      getCountFromServer(query(collection(db, 'articles'), where('collectedAt', '>=', today))),
      getCountFromServer(query(collection(db, 'articles'), where('status', '==', 'pending'))),
      getCountFromServer(query(collection(db, 'articles'), where('status', '==', 'analyzed'))),
      getCountFromServer(collection(db, 'globalSources')),
    ]);
    const errorSrc = (await getDocs(query(
      collection(db, 'globalSources'), where('lastStatus', '==', 'error')
    ))).size;
    setGlobalStats({
      totalToday: todaySnap.data().count,
      totalPending: pendingSnap.data().count,
      totalAnalyzed: analyzedSnap.data().count,
      totalSources: sourcesSnap.data().count,
      errorSources: errorSrc,
    });
  };

  const loadTrendData = async () => {
    const today = new Date();
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const d = subDays(today, i);
      const s = startOfDay(d);
      const e = startOfDay(subDays(today, i - 1));
      const dQ = query(collection(db, 'articles'), where('collectedAt', '>=', s), where('collectedAt', '<', e));
      const dSnap = await getCountFromServer(dQ);
      trend.push({ name: format(d, 'MM/dd'), articles: dSnap.data().count });
    }
    setTrendData(trend);
  };

  const loadPcScraperStatus = async () => {
    const sources = ['thebell', 'marketinsight'];
    const results = await Promise.all(sources.map(async src => {
      try {
        const d = await getDoc(doc(db, 'scraperStatus', src));
        if (d.exists()) return { source: src, ...d.data() } as PcScraperStatus;
        return { source: src, status: 'idle' as const, found: 0, collected: 0, skipped: 0 };
      } catch {
        return { source: src, status: 'idle' as const, found: 0, collected: 0, skipped: 0 };
      }
    }));
    setPcScrapers(results);
  };

  const loadRecentRuns = async () => {
    const snap = await getDocs(query(
      collection(db, 'bulkAiJobs'),
      orderBy('startedAt', 'desc'),
      limit(10)
    ));
    setRecentRuns(snap.docs.map(d => ({ id: d.id, ...d.data() as any })));
  };

  const handleTogglePipeline = async () => {
    const newEnabled = !pipelineControl.pipelineEnabled;
    setTogglingPipeline(true);
    try {
      const fn = httpsCallable(functions, 'setPipelineControl');
      await fn({ type: 'pipeline', enabled: newEnabled });
      await loadRecentRuns();
    } catch (err: any) {
      alert('파이프라인 제어 실패: ' + err.message);
    } finally {
      setTogglingPipeline(false);
    }
  };

  const handleStopAll = async () => {
    setTogglingPipeline(true);
    try {
      const fn = httpsCallable(functions, 'setPipelineControl');
      await fn({ type: 'stopall', enabled: false });
    } catch (err: any) {
      alert('강제 종료 실패: ' + err.message);
    } finally {
      setTogglingPipeline(false);
    }
  };

  const filteredSources = activeType === 'all'
    ? sources
    : sources.filter(s => s.type === activeType);

  const filteredStats = activeType === 'all'
    ? sourceStats
    : sourceStats.filter(s => s.type === activeType);

  const formatTs = (ts: any) => {
    if (!ts) return '-';
    try {
      const d = ts?.toDate ? ts.toDate() : new Date(ts._seconds * 1000);
      return format(d, 'MM/dd HH:mm');
    } catch { return '-'; }
  };

  const runDuration = (run: any) => {
    if (!run.startedAt || !run.completedAt) return null;
    try {
      const s = run.startedAt?.toDate ? run.startedAt.toDate() : new Date(run.startedAt._seconds * 1000);
      const e = run.completedAt?.toDate ? run.completedAt.toDate() : new Date(run.completedAt._seconds * 1000);
      const sec = Math.round((e.getTime() - s.getTime()) / 1000);
      return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
    } catch { return null; }
  };

  return (
    <div className="space-y-6 pb-10">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">수집 현황 대시보드</h1>
          <p className="text-sm text-white/40 mt-0.5">각 수집 방식별 실시간 상태와 기사 수집 현황을 모니터링합니다.</p>
        </div>
        <button onClick={loadAll} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-white/50 hover:text-white border border-white/10 hover:border-white/30 rounded-lg transition-colors disabled:opacity-40">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />새로고침
        </button>
      </div>

      {/* 전체 통계 카드 */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-7 h-7 animate-spin text-white/20" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: '오늘 수집', value: globalStats.totalToday, icon: Newspaper, color: 'text-blue-400' },
              { label: 'AI 필터링 대기', value: globalStats.totalPending, icon: Clock, color: 'text-yellow-400' },
              { label: '분석 완료 (전체)', value: globalStats.totalAnalyzed.toLocaleString(), icon: CheckCircle, color: 'text-green-400' },
              { label: '오류 매체', value: globalStats.errorSources, icon: AlertTriangle, color: globalStats.errorSources > 0 ? 'text-red-400' : 'text-white/30' },
            ].map(card => (
              <div key={card.label} className="bg-gray-900 border border-white/5 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs text-white/40">{card.label}</p>
                  <card.icon className={`w-4 h-4 ${card.color}`} />
                </div>
                <p className={`text-2xl font-bold ${card.color}`}>{card.value}</p>
              </div>
            ))}
          </div>

          {/* 7일 추이 + 파이프라인 실행 */}
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            {/* 차트 */}
            <div className="lg:col-span-3 bg-gray-900 border border-white/5 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-white/70 mb-4 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-white/30" />최근 7일 수집 추이
              </h2>
              <div className="h-40" style={{ minHeight: 160 }}>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={trendData}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#ffffff08" />
                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#ffffff40' }} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#ffffff40' }} allowDecimals={false} />
                    <Tooltip contentStyle={{ background: '#1f2937', border: '1px solid #ffffff10', borderRadius: '8px', color: '#fff' }} />
                    <Bar dataKey="articles" fill="#d4af37" radius={[4, 4, 0, 0]} barSize={20} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* 파이프라인 ON/OFF */}
            <div className="lg:col-span-2 bg-gray-900 border border-white/5 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-white/70 mb-4 flex items-center gap-2">
                <Activity className="w-4 h-4 text-white/30" />수집 + AI 분석 파이프라인
              </h2>
              <div className="space-y-4">
                {/* 토글 스위치 */}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-white/80">자동 반복 실행</p>
                    <p className="text-[11px] text-white/35 mt-0.5">ON 시 수집→분류→분석 무한 반복</p>
                  </div>
                  <button
                    onClick={handleTogglePipeline}
                    disabled={togglingPipeline}
                    className={`relative w-14 h-7 rounded-full transition-colors duration-300 disabled:opacity-50 overflow-hidden ${
                      pipelineControl.pipelineEnabled ? 'bg-green-500' : 'bg-white/15'
                    }`}
                  >
                    <span className={`absolute top-1 w-5 h-5 rounded-full bg-white shadow transition-transform duration-300 ${
                      pipelineControl.pipelineEnabled ? 'translate-x-[33px]' : 'translate-x-1'
                    }`} />
                  </button>
                </div>

                {/* 현재 상태 */}
                <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${
                  pipelineControl.pipelineRunning
                    ? 'bg-blue-500/10 border-blue-500/20'
                    : pipelineControl.pipelineEnabled
                    ? 'bg-green-500/10 border-green-500/20'
                    : 'bg-white/5 border-white/10'
                }`}>
                  {pipelineControl.pipelineRunning ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400 flex-shrink-0" />
                    <p className="text-xs text-blue-400 font-medium">{pipelineControl.currentStep || '실행 중...'}</p></>
                  ) : pipelineControl.pipelineEnabled ? (
                    <><Power className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                    <p className="text-xs text-green-400 font-medium">ON — 다음 사이클 대기 중</p></>
                  ) : (
                    <><Power className="w-3.5 h-3.5 text-white/25 flex-shrink-0" />
                    <p className="text-xs text-white/35">OFF — 수동으로 켜면 자동 반복 시작</p></>
                  )}
                </div>

                {/* 강제 종료 버튼 (실행 중일 때만 표시) */}
                {(pipelineControl.pipelineRunning || pipelineControl.aiOnlyRunning) && (
                  <button
                    onClick={handleStopAll}
                    disabled={togglingPipeline}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-red-400 bg-red-500/10 border border-red-500/20 hover:bg-red-500/20 transition-colors disabled:opacity-50"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                    모든 파이프라인 강제 종료
                  </button>
                )}
              </div>
            </div>
          </div>


          {/* 로컬 PC 스크래퍼 상태 */}
          <div className="bg-gray-900 border border-white/5 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-white/5 flex items-center gap-2">
              <Monitor className="w-4 h-4 text-white/30" />
              <h2 className="text-sm font-semibold text-white/70">로컬 PC 스크래퍼 상태</h2>
              <span className="ml-auto text-[10px] text-white/25">더벨 · 마켓인사이트</span>
            </div>
            <div className="divide-y divide-white/5">
              {pcScrapers.length === 0 ? (
                <div className="py-8 text-center text-white/25 text-sm">
                  스크래퍼 상태 없음 — 아직 수집이 실행된 적 없거나 PC가 오프라인입니다.
                </div>
              ) : pcScrapers.map(sc => {
                const isOk = sc.status === 'success';
                const isErr = sc.status === 'error';
                const isRunning = sc.status === 'running';
                const label = sc.source === 'thebell' ? '더벨' : '마켓인사이트';
                const updatedStr = sc.updatedAt?.toDate
                  ? format(sc.updatedAt.toDate(), 'MM/dd HH:mm')
                  : sc.updatedAt?._seconds
                  ? format(new Date(sc.updatedAt._seconds * 1000), 'MM/dd HH:mm')
                  : '—';
                const durStr = sc.durationMs != null
                  ? sc.durationMs < 60000
                    ? `${Math.round(sc.durationMs / 1000)}s`
                    : `${Math.floor(sc.durationMs / 60000)}m ${Math.round((sc.durationMs % 60000) / 1000)}s`
                  : null;
                return (
                  <div key={sc.source} className="px-5 py-4 flex items-start gap-4">
                    <div className={`w-8 h-8 rounded-lg border flex items-center justify-center flex-shrink-0 ${
                      isErr ? 'bg-red-500/10 border-red-500/20' :
                      isRunning ? 'bg-blue-500/10 border-blue-500/20' :
                      isOk ? 'bg-green-500/10 border-green-500/20' :
                      'bg-white/5 border-white/10'
                    }`}>
                      {isErr ? <WifiOff className="w-4 h-4 text-red-400" />
                        : isOk ? <Wifi className="w-4 h-4 text-green-400" />
                        : <Monitor className="w-4 h-4 text-white/30" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="text-sm font-medium text-white/80">{label}</p>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold border ${
                          isErr ? 'bg-red-500/10 border-red-500/20 text-red-400' :
                          isRunning ? 'bg-blue-500/10 border-blue-500/20 text-blue-400' :
                          isOk ? 'bg-green-500/10 border-green-500/20 text-green-400' :
                          'bg-white/5 border-white/10 text-white/30'
                        }`}>
                          {sc.status === 'success' ? '정상' : sc.status === 'error' ? '오류' : sc.status === 'running' ? '실행중' : '대기'}
                        </span>
                        {updatedStr !== '—' && <span className="text-[10px] text-white/25">마지막 업데이트: {updatedStr}</span>}
                      </div>
                      <div className="flex items-center gap-4 text-xs text-white/40">
                        <span>발견 <span className="text-white/60 font-medium">{sc.found}</span>건</span>
                        <span>저장 <span className="text-green-400 font-medium">{sc.collected}</span>건</span>
                        <span>스킵 <span className="text-white/40">{sc.skipped}</span>건</span>
                        {durStr && <span>소요 {durStr}</span>}
                      </div>
                      {isErr && sc.errorMessage && (
                        <p className="mt-1.5 text-xs text-red-400/80 font-mono bg-red-500/5 border border-red-500/10 rounded px-2 py-1 truncate">
                          {sc.errorMessage}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 수집 방식 탭 + 매체 목록 */}
          <div className="bg-gray-900 border border-white/5 rounded-xl overflow-hidden">
            {/* 방식 탭 */}
            <div className="px-5 py-3.5 border-b border-white/5">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-white/70 mr-2">매체별 수집 현황</h2>
                <button
                  onClick={() => setActiveType('all')}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${activeType === 'all' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'}`}
                >전체 ({sources.length})</button>
                {SOURCE_TYPES.map(t => {
                  const cnt = sources.filter(s => s.type === t.id).length;
                  if (cnt === 0) return null;
                  return (
                    <button
                      key={t.id}
                      onClick={() => setActiveType(t.id)}
                      className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium border transition-colors ${
                        activeType === t.id ? t.activeBg + ' ' + t.color : 'border-transparent text-white/40 hover:text-white/70'
                      }`}
                    >
                      <t.icon className="w-3 h-3" />
                      {t.label} ({cnt})
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 방식 카드 (필터된 소스가 없을 때) */}
            {filteredSources.length === 0 ? (
              <div className="py-10 text-center text-white/25 text-sm">해당 방식의 매체가 없습니다.</div>
            ) : (
              <div className="divide-y divide-white/5">
                {filteredSources.slice(0, 30).map(src => {
                  const stat = filteredStats.find(s => s.sourceId === src.id);
                  const typeMeta = SOURCE_TYPES.find(t => t.id === src.type);
                  return (
                    <div key={src.id} className="px-5 py-3 flex items-center gap-4 hover:bg-white/[0.02] transition-colors">
                      {/* 아이콘 */}
                      {typeMeta && (
                        <div className={`w-7 h-7 rounded-lg border flex items-center justify-center flex-shrink-0 ${typeMeta.bg}`}>
                          <typeMeta.icon className={`w-3.5 h-3.5 ${typeMeta.color}`} />
                        </div>
                      )}
                      {/* 이름 */}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-white/80 truncate">{src.name}</p>
                        <p className="text-[10px] text-white/30 truncate">{src.url || src.rssUrl || ''}</p>
                      </div>
                      {/* 상태 */}
                      <div className="flex items-center gap-4 flex-shrink-0">
                        <div className="text-right">
                          <p className="text-[10px] text-white/25">오늘 수집</p>
                          <p className="text-sm font-bold text-blue-400">{stat?.todayCount ?? '-'}</p>
                        </div>
                        <div className="text-right hidden sm:block">
                          <p className="text-[10px] text-white/25">마지막 수집</p>
                          <p className="text-xs text-white/40">{formatTs(src.lastScrapedAt)}</p>
                        </div>
                        {/* 상태 뱃지 */}
                        {src.lastStatus === 'error' ? (
                          <span className="flex items-center gap-1 text-[10px] text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-0.5 rounded-full">
                            <XCircle className="w-3 h-3" />오류
                          </span>
                        ) : src.lastStatus === 'success' ? (
                          <span className="flex items-center gap-1 text-[10px] text-green-400 bg-green-500/10 border border-green-500/20 px-2 py-0.5 rounded-full">
                            <CheckCircle className="w-3 h-3" />정상
                          </span>
                        ) : src.status === 'active' ? (
                          <span className="flex items-center gap-1 text-[10px] text-blue-400 bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 rounded-full">
                            <CheckCircle className="w-3 h-3" />활성
                          </span>
                        ) : src.status === 'inactive' ? (
                          <span className="text-[10px] text-white/25 bg-white/5 border border-white/10 px-2 py-0.5 rounded-full">비활성</span>
                        ) : (
                          <span className="text-[10px] text-white/20 bg-white/5 px-2 py-0.5 rounded-full">대기</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 최근 파이프라인 실행 이력 */}
          <div className="bg-gray-900 border border-white/5 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-white/5 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white/70 flex items-center gap-2">
                <Clock className="w-4 h-4 text-white/30" />최근 파이프라인 실행 이력
              </h2>
            </div>
            <div className="divide-y divide-white/5">
              {recentRuns.length === 0 ? (
                <div className="py-8 text-center text-white/25 text-sm">실행 이력이 없습니다.</div>
              ) : recentRuns.map(run => {
                const isExpanded = expandedRun === run.id;
                const dur = runDuration(run);
                const isRunning = pipelineControl.pipelineRunning && run.status === 'running';
                return (
                  <div key={run.id}>
                    <div
                      className="px-5 py-3 flex items-center gap-4 cursor-pointer hover:bg-white/[0.02] transition-colors"
                      onClick={() => setExpandedRun(isExpanded ? null : run.id)}
                    >
                      {/* 상태 아이콘 */}
                      <div className="flex-shrink-0">
                        {isRunning ? <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
                          : run.status === 'completed' ? <CheckCircle className="w-4 h-4 text-green-400" />
                          : run.status === 'failed' ? <XCircle className="w-4 h-4 text-red-400" />
                          : <Clock className="w-4 h-4 text-white/30" />}
                      </div>
                      {/* 정보 */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-white/80">
                            {run.currentStep || '전체 파이프라인'}
                          </p>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                            run.status === 'completed' ? 'bg-green-500/10 text-green-400' :
                            run.status === 'failed' ? 'bg-red-500/10 text-red-400' :
                            run.status === 'running' ? 'bg-blue-500/10 text-blue-400' :
                            'bg-white/5 text-white/30'
                          }`}>{run.status}</span>
                          {dur && <span className="text-[10px] text-white/25">{dur}</span>}
                        </div>
                        <p className="text-[10px] text-white/30 mt-0.5">
                          {formatTs(run.startedAt)}
                          {run.result?.totalCollected != null && <> · 수집 {run.result.totalCollected}건</>}
                          {run.result?.totalFiltered != null && <> · 분류 {run.result.totalFiltered}건</>}
                          {run.result?.totalAnalyzed != null && <> · 분석 {run.result.totalAnalyzed}건</>}
                        </p>
                      </div>
                      {isExpanded ? <ChevronUp className="w-4 h-4 text-white/20" /> : <ChevronDown className="w-4 h-4 text-white/20" />}
                    </div>

                    {/* 상세 결과 */}
                    {isExpanded && (
                      <div className="px-5 pb-4 pt-1">
                        <div className="grid grid-cols-3 gap-2">
                          {[
                            { label: '수집', value: run.result?.totalCollected, color: 'text-blue-400' },
                            { label: 'AI 분류', value: run.result?.totalFiltered, color: 'text-yellow-400' },
                            { label: 'AI 분석', value: run.result?.totalAnalyzed, color: 'text-green-400' },
                          ].map(item => (
                            <div key={item.label} className="p-2.5 rounded-lg border bg-white/5 border-white/10 text-center">
                              <p className="text-[10px] text-white/40 mb-1">{item.label}</p>
                              <p className={`text-lg font-bold ${item.color}`}>{item.value ?? '-'}</p>
                            </div>
                          ))}
                        </div>
                        {run.error && (
                          <div className="mt-2 p-2 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-400 font-mono overflow-auto max-h-16">
                            {run.error}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
