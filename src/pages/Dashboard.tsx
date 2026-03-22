import { useState, useEffect, useRef } from 'react';
import {
  Play, Database, Cpu, FileText, RefreshCw, CheckCircle, XCircle,
  AlertTriangle, Clock, TrendingUp, LayoutDashboard, Filter,
  ChevronDown, ChevronUp, X, Plus, Calendar, Newspaper, Loader2, Info
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { db, functions } from '@/lib/firebase';
import { collection, query, where, getDocs, orderBy, limit, getCountFromServer, onSnapshot, doc, getDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { format, subDays, startOfDay } from 'date-fns';
import { useAuthStore } from '@/store/useAuthStore';

const DATE_RANGE_OPTIONS = [
  { value: 'today', label: '오늘' },
  { value: '3days', label: '최근 3일', days: 3 },
  { value: 'week', label: '최근 1주', days: 7 },
  { value: '2weeks', label: '최근 2주', days: 14 },
];

function TagInput({
  label, placeholder, tags, onChange
}: { label: string; placeholder: string; tags: string[]; onChange: (t: string[]) => void }) {
  const [input, setInput] = useState('');
  const add = () => {
    const v = input.trim();
    if (v && !tags.includes(v)) onChange([...tags, v]);
    setInput('');
  };
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5">{label}</label>
      <div className="flex flex-wrap gap-1.5 mb-2 min-h-[28px]">
        {tags.map(t => (
          <span key={t} className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-[#1e3a5f]/10 dark:bg-[#1e3a5f]/30 text-[#1e3a5f] dark:text-blue-300 rounded text-xs font-medium">
            {t}
            <button type="button" onClick={() => onChange(tags.filter(x => x !== t))}>
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder={placeholder}
          className="flex-1 px-3 py-1.5 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm outline-none focus:ring-2 focus:ring-[#1e3a5f] text-gray-900 dark:text-white placeholder-gray-400"
        />
        <button type="button" onClick={add} className="px-2.5 py-1.5 bg-gray-100 dark:bg-gray-600 hover:bg-gray-200 dark:hover:bg-gray-500 rounded-lg text-gray-600 dark:text-gray-300 transition-colors">
          <Plus className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const companyId = (user as any)?.primaryCompanyId || (user as any)?.companyId || (user as any)?.companyIds?.[0] || null;
  const isSuperadmin = (user as any)?.role === 'superadmin';
  const userRole = (user as any)?.role;
  const canRun = userRole === 'superadmin' || userRole === 'company_admin' || userRole === 'company_editor';

  // Pipeline state
  const [running, setRunning] = useState(false);
  const [pipelineRun, setPipelineRun] = useState<any>(null);
  const [pipelineMsg, setPipelineMsg] = useState('');
  const unsubRef = useRef<(() => void) | null>(null);

  // Filter config (for pipeline run)
  const [showFilters, setShowFilters] = useState(false);
  const [dateRange, setDateRange] = useState('today');
  const [mustIncludeKw, setMustIncludeKw] = useState<string[]>([]);
  const [includeKw, setIncludeKw] = useState<string[]>([]);
  const [excludeKw, setExcludeKw] = useState<string[]>([]);
  const [subscribedSources, setSubscribedSources] = useState<{ id: string; name: string }[]>([]);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);

  // Stats
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ todayCollected: 0, todayPassed: 0, successRate: 0 });
  const [trendData, setTrendData] = useState<any[]>([]);
  const [recentOutputs, setRecentOutputs] = useState<any[]>([]);
  const [recentArticles, setRecentArticles] = useState<any[]>([]);

  useEffect(() => {
    if (user) {
      fetchDashboardData();
      if (companyId) loadSubscribedSources();
    }
  }, [user]);

  const loadSubscribedSources = async () => {
    setSourcesLoading(true);
    try {
      const subDoc = await getDoc(doc(db, 'companySourceSubscriptions', companyId));
      const subscribedIds: string[] = subDoc.exists() ? (subDoc.data() as any).sourceIds || [] : [];
      if (subscribedIds.length === 0) { setSourcesLoading(false); return; }

      const snap = await getDocs(collection(db, 'globalSources'));
      const all = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
      const subscribed = all.filter(s => subscribedIds.includes(s.id)).map(s => ({ id: s.id, name: s.name }));
      setSubscribedSources(subscribed);
      setSelectedSourceIds(subscribed.map(s => s.id)); // default: all selected
    } catch (err) {
      console.error('loadSubscribedSources error:', err);
    } finally {
      setSourcesLoading(false);
    }
  };

  const fetchDashboardData = async () => {
    setLoading(true);
    try {
      const today = new Date();
      const startOfToday = startOfDay(today);
      const articlesRef = collection(db, 'articles');
      // 회사 관리자: 자신의 회사 기사 + 글로벌 기사(companyId: null) 포함
      // 슈퍼어드민: 모든 기사
      const base = companyId && !isSuperadmin
        ? [where('companyId', 'in', [companyId, null])]  // 회사 기사 + 글로벌 기사
        : [];

      // Today stats
      const todayQ = query(articlesRef, ...base, where('collectedAt', '>=', startOfToday));
      const totalSnap = await getCountFromServer(todayQ);

      const passedQ = query(articlesRef, ...base, where('collectedAt', '>=', startOfToday), where('status', 'in', ['analyzed', 'published']));
      const passedSnap = await getCountFromServer(passedQ);

      const total = totalSnap.data().count;
      const passed = passedSnap.data().count;
      setStats({ todayCollected: total, todayPassed: passed, successRate: total > 0 ? Math.round((passed / total) * 100) : 0 });

      // 7-day trend
      const trend = [];
      for (let i = 6; i >= 0; i--) {
        const d = subDays(today, i);
        const s = startOfDay(d);
        const e = startOfDay(subDays(today, i - 1));
        const dQ = query(articlesRef, ...base, where('collectedAt', '>=', s), where('collectedAt', '<', e));
        const dSnap = await getCountFromServer(dQ);
        trend.push({ name: format(d, 'MM/dd'), articles: dSnap.data().count });
      }
      setTrendData(trend);

      // Recent outputs
      const outputsQ = companyId && !isSuperadmin
        ? query(collection(db, 'outputs'), where('companyId', '==', companyId), orderBy('createdAt', 'desc'), limit(5))
        : query(collection(db, 'outputs'), orderBy('createdAt', 'desc'), limit(5));
      const outputsSnap = await getDocs(outputsQ);
      setRecentOutputs(outputsSnap.docs.map(d => ({ id: d.id, ...d.data() as any })));

      // Recent Pipeline Runs (Replaces Recent Articles)
      const runsQ = companyId && !isSuperadmin
        ? query(collection(db, 'pipelineRuns'), where('companyId', '==', companyId), orderBy('startedAt', 'desc'), limit(8))
        : query(collection(db, 'pipelineRuns'), orderBy('startedAt', 'desc'), limit(8));
      const runsSnap = await getDocs(runsQ);
      
      let userMap: Record<string, string> = {};
      if (companyId && (!isSuperadmin)) {
        try {
          const fn = httpsCallable(functions, 'getCompanyUsers');
          const result = await fn({ companyId }) as any;
          if (Array.isArray(result.data)) {
            result.data.forEach((u: any) => userMap[u.uid] = u.email);
          }
        } catch (e) { console.warn('Could not load user map', e); }
      }
      
      setRecentArticles(runsSnap.docs.map(d => {
        const data = d.data() as any;
        return {
          id: d.id,
          title: `분석 ${data.status === 'completed' ? '완료' : data.status === 'failed' ? '실패' : '진행중'}`,
          sourceName: isSuperadmin ? (data.companyName || 'Unknown Company') : (userMap[data.triggeredBy] || data.triggeredBy || '시스템_자동'),
          collectedAt: data.startedAt,
          status: data.status,
          configSnapshot: data.configSnapshot
        };
      }));
    } catch (err) {
      console.error('Dashboard load error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleRunPipeline = async () => {
    if (!companyId) { setPipelineMsg('회사 정보가 없습니다. 관리자에게 문의하세요.'); return; }
    setRunning(true);
    setPipelineMsg('');
    setPipelineRun(null);
    if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }

    // Build date range override
    let dateRangeOverride: any = 'today';
    const sel = DATE_RANGE_OPTIONS.find(o => o.value === dateRange);
    if (sel?.days) dateRangeOverride = { mode: 'relative_days', days: sel.days };

    const overrides: any = {
      filters: {
        ...(mustIncludeKw.length > 0 ? { mustIncludeKeywords: mustIncludeKw } : {}),
        ...(includeKw.length > 0 ? { includeKeywords: includeKw } : {}),
        ...(excludeKw.length > 0 ? { excludeKeywords: excludeKw } : {}),
        ...(selectedSourceIds.length > 0 && selectedSourceIds.length < subscribedSources.length
          ? { sourceIds: selectedSourceIds }
          : {}),
        dateRange: dateRangeOverride,
      },
    };

    try {
      const runFn = httpsCallable(functions, 'runFullPipeline');
      const result = await runFn({ companyId, overrides }) as any;
      const pipelineId = result.data?.pipelineId;

      if (pipelineId) {
        const unsub = onSnapshot(doc(db, 'pipelineRuns', pipelineId), snap => {
          if (!snap.exists()) return;
          const data = snap.data();
          setPipelineRun(data);
          if (data.status === 'completed' || data.status === 'failed') {
            setRunning(false);
            if (data.status === 'completed') fetchDashboardData();
            setTimeout(() => { unsub(); unsubRef.current = null; }, 10000);
          }
        });
        unsubRef.current = unsub;
      } else {
        setRunning(false);
        setPipelineMsg(result.data?.success ? '✅ 파이프라인 완료' : '⚠️ 파이프라인 경고');
        fetchDashboardData();
      }
    } catch (err: any) {
      setRunning(false);
      setPipelineMsg(`❌ 실패: ${err.message}`);
    }
  };

  const toggleSource = (id: string) => {
    setSelectedSourceIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const pipelineStatus = pipelineRun?.status;

  return (
    <div className="space-y-6 pb-10">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">대시보드</h1>
        <p className="text-gray-500 dark:text-gray-400 mt-1 text-sm">업계 동향과 최신 기사를 수집 및 분석하여 맞춤형 브리핑을 제공합니다.</p>
      </div>

      {/* ── Info Guide ─────────────────────────── */}
      <div className="bg-gradient-to-r from-[#1e3a5f] to-[#2a4a73] rounded-xl shadow-lg border-0 overflow-hidden mb-6">
        <div className="px-6 py-5 text-white">
          <h2 className="text-lg font-bold flex items-center gap-2 mb-2 text-yellow-300">
            <Info className="w-5 h-5" />
            EUM News 브리핑 시스템 이용 가이드
          </h2>
          <div className="text-sm text-blue-50 space-y-2 leading-relaxed">
            <p className="font-medium">
              본 시스템은 실시간으로 업데이트되는 업계 주요 기사를 수집하고, AI가 분석요약하여 제공하는 맞춤형 인텔리전스 환경입니다.
            </p>
            <ul className="list-disc list-inside space-y-1.5 ml-1 opacity-95">
              <li><strong>정기 자동 브리핑:</strong> 매일 밤 10시에 새로운 기사를 자동으로 수집 및 분석합니다.</li>
              <li><strong>실시간 즉시 분석:</strong> 특정 키워드의 기사나 최신 동향이 당장 필요할 때, 아래 <strong>[지금 분석 실행]</strong> 버튼을 통해 즉시 데이터를 추출할 수 있습니다.</li>
              <li><strong>언어 기본 설정 (한국어):</strong> 수집되는 <strong>모든 해외 원문 기사는 '한국어 번역'이 기본(Default)</strong>으로 적용되어 제공되며, 원문 보기는 보조 기능으로 지원됩니다.</li>
            </ul>
          </div>
        </div>
      </div>

      {/* ── Pipeline Run Panel ─────────────────────────── */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        {/* Panel header */}
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Play className="w-4 h-4 text-[#1e3a5f] dark:text-blue-400" />
            <span className="font-semibold text-gray-900 dark:text-white">파이프라인 실행</span>
          </div>
          {canRun && (
            <button
              onClick={() => setShowFilters(v => !v)}
              className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
            >
              <Filter className="w-3.5 h-3.5" />
              필터 설정
              {showFilters ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>

        {/* Filter config (collapsible) */}
        {canRun && showFilters && (
          <div className="px-6 py-5 border-b border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-700/20 space-y-5">
            {/* Date range */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                <Calendar className="inline w-3.5 h-3.5 mr-1" />수집 기간
              </label>
              <div className="flex flex-wrap gap-2">
                {DATE_RANGE_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setDateRange(opt.value)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                      dateRange === opt.value
                        ? 'bg-[#1e3a5f] text-white border-[#1e3a5f]'
                        : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600 hover:border-gray-400'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Keywords */}
            <div className="mb-2">
              <p className="text-xs text-gray-400 dark:text-gray-500 mb-3 bg-blue-50/50 dark:bg-blue-900/10 p-2 rounded border border-blue-100 dark:border-blue-800">
                <Info className="inline w-3.5 h-3.5 mr-1 text-blue-500" />
                키워드는 최대한 구체적이고 상세하게 입력할수록 AI가 더 정확하고 유용한 맞춤형 분석 결과를 제공합니다.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <TagInput
                  label="필수 포함 키워드 (AND 조건)"
                  placeholder="예: M&A, 인수합병"
                  tags={mustIncludeKw}
                  onChange={setMustIncludeKw}
                />
                <TagInput
                  label="선택 포함 키워드 (OR 조건)"
                  placeholder="예: 스타트업, 투자"
                  tags={includeKw}
                  onChange={setIncludeKw}
                />
                <TagInput
                  label="제외 키워드"
                  placeholder="예: 광고, 홍보"
                  tags={excludeKw}
                  onChange={setExcludeKw}
                />
              </div>
            </div>

            {/* Sources */}
            {subscribedSources.length > 0 && (
              <div>
                <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                  <Newspaper className="inline w-3.5 h-3.5 mr-1" />매체 선택
                </label>
                <div className="flex flex-wrap gap-2">
                  {subscribedSources.map(src => (
                    <button
                      key={src.id}
                      type="button"
                      onClick={() => toggleSource(src.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                        selectedSourceIds.includes(src.id)
                          ? 'bg-[#1e3a5f] text-white border-[#1e3a5f]'
                          : 'bg-white dark:bg-gray-700 text-gray-400 dark:text-gray-500 border-gray-200 dark:border-gray-600'
                      }`}
                    >
                      {src.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Run button + status */}
        <div className="px-6 py-4">
          {canRun ? (
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <button
                onClick={handleRunPipeline}
                disabled={running}
                className="flex items-center justify-center px-6 py-2.5 bg-[#1e3a5f] text-white rounded-lg font-medium hover:bg-[#2a4a73] transition-colors shadow-sm disabled:opacity-50 text-sm"
              >
                {running
                  ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />실행 중...</>
                  : <><Play className="w-4 h-4 mr-2" />지금 분석 실행</>
                }
              </button>
              <p className="text-xs text-gray-400 dark:text-gray-500">자동 분석은 매일 밤 10시에 실행됩니다.</p>
            </div>
          ) : (
            <p className="text-sm text-gray-400">파이프라인 실행은 스테프 이상 권한이 필요합니다.</p>
          )}

          {pipelineMsg && (
            <p className="mt-2 text-sm font-medium text-gray-600 dark:text-gray-300">{pipelineMsg}</p>
          )}
        </div>

        {/* Progress tracker */}
        {(running || pipelineRun) && (
          <div className="px-6 pb-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">진행 상황</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-bold uppercase ${
                pipelineStatus === 'completed' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                pipelineStatus === 'failed' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
              }`}>
                {pipelineStatus || '시작 중...'}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { id: 'collection', label: '수집', icon: Database },
                { id: 'filtering', label: 'AI 필터링', icon: Filter },
                { id: 'analysis', label: '심층 분석', icon: Cpu },
                { id: 'output', label: '브리핑 생성', icon: FileText },
              ].map(step => {
                const s = pipelineRun?.steps?.[step.id];
                const done = s?.status === 'completed';
                const active = s?.status === 'running';
                const failed = s?.status === 'failed';
                return (
                  <div key={step.id} className={`flex flex-col items-center p-3 rounded-lg border text-center transition-all ${
                    done ? 'bg-green-50 border-green-200 dark:bg-green-900/10 dark:border-green-800' :
                    active ? 'bg-blue-50 border-blue-200 dark:bg-blue-900/10 dark:border-blue-700 ring-2 ring-blue-400/20' :
                    failed ? 'bg-red-50 border-red-200 dark:bg-red-900/10 dark:border-red-800' :
                    'bg-gray-50 border-gray-100 dark:bg-gray-700/30 dark:border-gray-600'
                  }`}>
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center mb-1.5 ${
                      done ? 'bg-green-500 text-white' :
                      active ? 'bg-blue-500 text-white animate-pulse' :
                      failed ? 'bg-red-400 text-white' :
                      'bg-gray-200 dark:bg-gray-600 text-gray-400'
                    }`}>
                      {done ? <CheckCircle className="w-4 h-4" /> :
                       failed ? <XCircle className="w-4 h-4" /> :
                       active ? <RefreshCw className="w-4 h-4 animate-spin" /> :
                       <step.icon className="w-4 h-4" />}
                    </div>
                    <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">{step.label}</span>
                    {s?.result?.totalCollected != null && (
                      <span className="text-[10px] text-green-600 dark:text-green-400 font-bold">+{s.result.totalCollected}건</span>
                    )}
                    {s?.duration && (
                      <span className="text-[10px] text-gray-400">{Math.round(s.duration / 1000)}s</span>
                    )}
                  </div>
                );
              })}
            </div>
            {pipelineRun?.error && (
              <div className="mt-3 p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-xs font-mono overflow-auto max-h-20">
                {pipelineRun.error}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Stats ─────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-7 h-7 animate-spin text-gray-300" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              { label: '오늘 수집', value: stats.todayCollected, icon: LayoutDashboard },
              { label: 'AI 통과', value: stats.todayPassed, icon: CheckCircle },
              { label: '유용률', value: `${stats.successRate}%`, icon: TrendingUp },
            ].map(item => (
              <div key={item.label} className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-5 border border-gray-100 dark:border-gray-700 flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500 dark:text-gray-400">{item.label}</p>
                  <p className="text-3xl font-bold text-gray-900 dark:text-white mt-1">{item.value}</p>
                </div>
                <div className="w-11 h-11 bg-gray-100 dark:bg-gray-700 rounded-lg flex items-center justify-center">
                  <item.icon className="w-5 h-5 text-[#1e3a5f] dark:text-blue-400" />
                </div>
              </div>
            ))}
          </div>

          {/* ── Trend + Recent articles ─────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
            {/* 7-day trend */}
            <div className="lg:col-span-2 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-5">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">최근 7일 수집 추이</h2>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={trendData}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 11 }} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="articles" fill="#1e3a5f" radius={[4, 4, 0, 0]} barSize={24} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Recent Pipeline Runs (Activities) */}
            <div className="lg:col-span-3 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-900 dark:text-white">최근 작업 내역 (AI 파이프라인)</h2>
                <button
                  onClick={() => navigate('/history')}
                  className="text-xs text-[#1e3a5f] dark:text-blue-400 hover:underline"
                >
                  전체 보기
                </button>
              </div>
              <div className="divide-y divide-gray-100 dark:divide-gray-700 overflow-y-auto max-h-64">
                {recentArticles.length === 0 ? (
                  <div className="px-5 py-8 text-center text-sm text-gray-400">작업 내역이 없습니다.</div>
                ) : recentArticles.map(art => (
                  <div key={art.id} className="px-5 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
                    <p className="text-sm font-medium text-gray-900 dark:text-white line-clamp-1">{art.title || '작업'}</p>
                    <div className="flex flex-wrap items-center gap-2 mt-1">
                      <span className="text-[11px] text-gray-500 font-medium">{isSuperadmin ? '🏢' : '👤'} {art.sourceName}</span>
                      <span className="text-[11px] text-gray-300">·</span>
                      <span className="text-[11px] text-gray-400 border border-gray-200 dark:border-gray-600 px-1 rounded">
                        [{art.configSnapshot?.filters?.dateRange?.mode || art.configSnapshot?.filters?.dateRange || 'today'}]
                      </span>
                      {art.configSnapshot?.filters?.includeKeywords?.length > 0 && (
                        <span className="text-[11px] text-gray-400 line-clamp-1 ml-1">
                          키워드: {art.configSnapshot.filters.includeKeywords.join(', ')}
                        </span>
                      )}
                      
                      <div className="flex-1" />
                      <span className="text-[11px] text-gray-400">
                        {art.collectedAt?.toDate ? format(art.collectedAt.toDate(), 'MM/dd HH:mm') : ''}
                      </span>
                      {art.status && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase ml-2 ${
                          art.status === 'completed' ? 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400' :
                          art.status === 'running' ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400' :
                          art.status === 'failed' ? 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400' :
                          'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
                        }`}>
                          {art.status}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ── Recent outputs ─────────────────────────── */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">최근 브리핑</h2>
              <button onClick={() => navigate('/briefing')} className="text-xs text-[#1e3a5f] dark:text-blue-400 hover:underline">
                전체 보기
              </button>
            </div>
            <div className="divide-y divide-gray-100 dark:divide-gray-700">
              {recentOutputs.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-gray-400">
                  아직 브리핑이 없습니다. 파이프라인을 실행해 주세요.
                </div>
              ) : recentOutputs.map(output => (
                <div
                  key={output.id}
                  className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 dark:hover:bg-gray-700/30 cursor-pointer transition-colors"
                  onClick={() => navigate(`/briefing?outputId=${output.id}`)}
                >
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-white">{output.title || output.id}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      기사 {output.articleCount || 0}건 ·{' '}
                      {output.createdAt?.toDate ? format(output.createdAt.toDate(), 'MM/dd HH:mm') : ''}
                    </p>
                  </div>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
                    {output.type || 'report'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
