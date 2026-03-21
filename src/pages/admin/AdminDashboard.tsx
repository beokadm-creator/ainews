import { useState, useEffect, useRef } from 'react';
import {
  Rss, Globe, Code2, Cpu, Play, RefreshCw, CheckCircle,
  XCircle, Clock, AlertTriangle, Loader2, ChevronDown, ChevronUp,
  Database, TrendingUp, Activity, Newspaper
} from 'lucide-react';
import { db, functions } from '@/lib/firebase';
import { httpsCallable } from 'firebase/functions';
import {
  collection, query, where, orderBy, limit,
  getDocs, onSnapshot, doc, getCountFromServer, getDoc
} from 'firebase/firestore';
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

export default function AdminDashboard() {
  const [activeType, setActiveType] = useState<string>('all');
  const [sources, setSources] = useState<any[]>([]);
  const [sourceStats, setSourceStats] = useState<SourceStat[]>([]);
  const [companyStats, setCompanyStats] = useState<CompanyStat[]>([]);
  const [trendData, setTrendData] = useState<any[]>([]);
  const [globalStats, setGlobalStats] = useState({
    totalToday: 0,
    totalAnalyzed: 0,
    totalSources: 0,
    errorSources: 0,
  });
  const [loading, setLoading] = useState(true);

  // 파이프라인 실행
  const [recentRuns, setRecentRuns] = useState<any[]>([]);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [companies, setCompanies] = useState<any[]>([]);
  const [selectedCompany, setSelectedCompany] = useState('');
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    loadAll();
  }, []);

  const loadAll = async () => {
    setLoading(true);
    try {
      await Promise.all([
        loadGlobalSources(),
        loadGlobalStats(),
        loadTrendData(),
        loadRecentRuns(),
        loadCompanies(),
      ]);
    } finally {
      setLoading(false);
    }
  };

  const loadGlobalSources = async () => {
    const snap = await getDocs(collection(db, 'globalSources'));
    const srcs = snap.docs.map(d => ({ id: d.id, ...d.data() as any }));
    setSources(srcs);
    // 소스별 오늘 수집 건수
    const today = startOfDay(new Date());
    const stats: SourceStat[] = await Promise.all(srcs.slice(0, 20).map(async src => {
      try {
        const q = query(
          collection(db, 'articles'),
          where('globalSourceId', '==', src.id),
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
    const [todaySnap, analyzedSnap, sourcesSnap] = await Promise.all([
      getCountFromServer(query(collection(db, 'articles'), where('collectedAt', '>=', today))),
      getCountFromServer(query(collection(db, 'articles'), where('status', '==', 'analyzed'))),
      getCountFromServer(collection(db, 'globalSources')),
    ]);
    const errorSrc = (await getDocs(query(
      collection(db, 'globalSources'), where('lastStatus', '==', 'error')
    ))).size;
    setGlobalStats({
      totalToday: todaySnap.data().count,
      totalAnalyzed: analyzedSnap.data().count,
      totalSources: sourcesSnap.data().count,
      errorSources: errorSrc,
    });

    // 회사별 통계
    const companiesSnap = await getDocs(query(collection(db, 'companies'), where('active', '==', true)));
    const cStats: CompanyStat[] = await Promise.all(
      companiesSnap.docs.slice(0, 10).map(async cd => {
        const cid = cd.id;
        const [totalQ, analyzedQ, todayQ] = await Promise.all([
          getCountFromServer(query(collection(db, 'articles'), where('companyId', '==', cid))),
          getCountFromServer(query(collection(db, 'articles'), where('companyId', '==', cid), where('status', '==', 'analyzed'))),
          getCountFromServer(query(collection(db, 'articles'), where('companyId', '==', cid), where('collectedAt', '>=', today))),
        ]);
        return {
          companyId: cid,
          name: (cd.data() as any).name || cid,
          total: totalQ.data().count,
          analyzed: analyzedQ.data().count,
          today: todayQ.data().count,
        };
      })
    );
    setCompanyStats(cStats.sort((a, b) => b.today - a.today));
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

  const loadRecentRuns = async () => {
    const snap = await getDocs(query(
      collection(db, 'pipelineRuns'),
      orderBy('startedAt', 'desc'),
      limit(10)
    ));
    setRecentRuns(snap.docs.map(d => ({ id: d.id, ...d.data() as any })));
  };

  const loadCompanies = async () => {
    const snap = await getDocs(query(collection(db, 'companies'), where('active', '==', true), orderBy('name')));
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() as any }));
    setCompanies(list);
    if (list.length > 0) setSelectedCompany(list[0].id);
  };

  const handleRunPipeline = async (companyId: string) => {
    if (!companyId) return;
    if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }

    try {
      const fn = httpsCallable(functions, 'runFullPipeline');
      const result = await fn({ companyId }) as any;
      const pid = result.data?.pipelineId;
      if (pid) {
        setRunningId(pid);
        const unsub = onSnapshot(doc(db, 'pipelineRuns', pid), snap => {
          if (!snap.exists()) return;
          const data = snap.data() as any;
          setRecentRuns(prev => {
            const idx = prev.findIndex(r => r.id === pid);
            const updated = { id: pid, ...data };
            return idx >= 0 ? prev.map((r, i) => i === idx ? updated : r) : [updated, ...prev];
          });
          if (data.status === 'completed' || data.status === 'failed') {
            setRunningId(null);
            setTimeout(() => { if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; } }, 5000);
            loadGlobalStats();
          }
        });
        unsubRef.current = unsub;
      }
    } catch (err: any) {
      alert('파이프라인 실행 실패: ' + err.message);
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
              { label: '분석 완료 (전체)', value: globalStats.totalAnalyzed.toLocaleString(), icon: CheckCircle, color: 'text-green-400' },
              { label: '활성 매체', value: globalStats.totalSources, icon: Globe, color: 'text-purple-400' },
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
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
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

            {/* 파이프라인 즉시 실행 */}
            <div className="lg:col-span-2 bg-gray-900 border border-white/5 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-white/70 mb-4 flex items-center gap-2">
                <Activity className="w-4 h-4 text-white/30" />파이프라인 즉시 실행
              </h2>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-white/40 block mb-1.5">대상 회사 선택</label>
                  <select
                    value={selectedCompany}
                    onChange={e => setSelectedCompany(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-800 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-[#d4af37]/50"
                  >
                    {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <button
                  onClick={() => handleRunPipeline(selectedCompany)}
                  disabled={!!runningId || !selectedCompany}
                  className="w-full flex items-center justify-center gap-2 py-2.5 bg-[#d4af37]/20 border border-[#d4af37]/30 text-[#d4af37] rounded-lg text-sm font-semibold hover:bg-[#d4af37]/30 transition-colors disabled:opacity-40"
                >
                  {runningId ? <><Loader2 className="w-4 h-4 animate-spin" />실행 중...</> : <><Play className="w-4 h-4" />수집 + 분석 실행</>}
                </button>
                <p className="text-[10px] text-white/25 text-center">수집 → AI 필터링 → 심층 분석 → 보고서 생성</p>
              </div>
            </div>
          </div>

          {/* 회사별 통계 */}
          {companyStats.length > 0 && (
            <div className="bg-gray-900 border border-white/5 rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-white/5">
                <h2 className="text-sm font-semibold text-white/70 flex items-center gap-2">
                  <Database className="w-4 h-4 text-white/30" />회사별 수집 현황
                </h2>
              </div>
              <div className="divide-y divide-white/5">
                {companyStats.map(c => (
                  <div key={c.companyId} className="px-5 py-3 flex items-center gap-4">
                    <div className="w-32 flex-shrink-0">
                      <p className="text-sm font-medium text-white truncate">{c.name}</p>
                    </div>
                    <div className="flex-1 flex items-center gap-6">
                      <div>
                        <p className="text-[10px] text-white/30 mb-0.5">오늘</p>
                        <p className="text-sm font-bold text-blue-400">{c.today}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-white/30 mb-0.5">분석완료</p>
                        <p className="text-sm font-bold text-green-400">{c.analyzed}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-white/30 mb-0.5">전체</p>
                        <p className="text-sm font-bold text-white/60">{c.total.toLocaleString()}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => handleRunPipeline(c.companyId)}
                      disabled={!!runningId}
                      className="flex-shrink-0 flex items-center gap-1 px-2.5 py-1 bg-white/5 hover:bg-white/10 border border-white/10 text-white/50 hover:text-white rounded-lg text-xs transition-colors disabled:opacity-40"
                    >
                      <Play className="w-3 h-3" />실행
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

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
                const isRunning = run.id === runningId || run.status === 'running';
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
                          <p className="text-sm font-medium text-white/80">{run.companyName || run.companyId || '-'}</p>
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
                          {run.steps?.collection?.result?.totalCollected != null && (
                            <> · 수집 {run.steps.collection.result.totalCollected}건</>
                          )}
                          {run.steps?.output?.result?.articleCount != null && (
                            <> · 보고서 {run.steps.output.result.articleCount}건</>
                          )}
                        </p>
                      </div>
                      {isExpanded ? <ChevronUp className="w-4 h-4 text-white/20" /> : <ChevronDown className="w-4 h-4 text-white/20" />}
                    </div>

                    {/* 상세 단계 */}
                    {isExpanded && (
                      <div className="px-5 pb-4 pt-1">
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                          {[
                            { id: 'collection', label: '수집' },
                            { id: 'filtering', label: 'AI 필터링' },
                            { id: 'analysis', label: '심층 분석' },
                            { id: 'output', label: '보고서 생성' },
                          ].map(step => {
                            const s = run.steps?.[step.id];
                            return (
                              <div key={step.id} className={`p-2.5 rounded-lg border text-center ${
                                s?.status === 'completed' ? 'bg-green-500/5 border-green-500/20' :
                                s?.status === 'running' ? 'bg-blue-500/5 border-blue-500/20' :
                                s?.status === 'failed' ? 'bg-red-500/5 border-red-500/20' :
                                'bg-white/5 border-white/10'
                              }`}>
                                <p className="text-[10px] font-semibold text-white/50 mb-1">{step.label}</p>
                                {s?.status === 'completed' ? <CheckCircle className="w-4 h-4 text-green-400 mx-auto" />
                                  : s?.status === 'running' ? <Loader2 className="w-4 h-4 text-blue-400 mx-auto animate-spin" />
                                  : s?.status === 'failed' ? <XCircle className="w-4 h-4 text-red-400 mx-auto" />
                                  : <Clock className="w-4 h-4 text-white/20 mx-auto" />}
                                {s?.result?.totalCollected != null && (
                                  <p className="text-[10px] text-blue-400 font-bold mt-1">+{s.result.totalCollected}</p>
                                )}
                              </div>
                            );
                          })}
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
