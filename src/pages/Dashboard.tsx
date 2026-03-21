import { useState, useEffect } from 'react';
import { LayoutDashboard, TrendingUp, Clock, CheckCircle, AlertTriangle, Play, Database, Cpu, FileText, RefreshCw, XCircle, Search, Filter as FilterIcon, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { db, functions } from '@/lib/firebase';
import { collection, query, where, getDocs, orderBy, limit, getCountFromServer, onSnapshot, doc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';
import { format, subDays, startOfDay } from 'date-fns';
import { useAuthStore } from '@/store/useAuthStore';

const COLORS = ['#1e3a5f', '#d4af37', '#4ade80', '#f87171', '#60a5fa', '#a78bfa', '#fb923c'];

export default function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const companyId = (user as any)?.primaryCompanyId || null;
  const isSuperadmin = (user as any)?.role === 'superadmin';

  const [loading, setLoading] = useState(true);
  const [runningPipeline, setRunningPipeline] = useState(false);
  const [pipelineMsg, setPipelineMsg] = useState('');
  const [stats, setStats] = useState({
    todayCollected: 0,
    todayPassed: 0,
    successRate: 0,
  });
  const [pipelineRun, setPipelineRun] = useState<any>(null); // ★ New: Current pipeline run track
  const [recentOutputs, setRecentOutputs] = useState<any[]>([]);
  const [categoryData, setCategoryData] = useState<any[]>([]);
  const [trendData, setTrendData] = useState<any[]>([]);
  const [systemStatus, setSystemStatus] = useState<any[]>([]);

  useEffect(() => {
    if (user) fetchDashboardData();
  }, [user]);

  const fetchDashboardData = async () => {
    setLoading(true);
    try {
      const today = new Date();
      const startOfToday = startOfDay(today);
      const articlesRef = collection(db, 'articles');

      // BUG-04 FIX: companyId 필터 추가 (superadmin은 전체 조회)
      const baseConstraints = companyId && !isSuperadmin
        ? [where('companyId', '==', companyId), where('collectedAt', '>=', startOfToday)]
        : [where('collectedAt', '>=', startOfToday)];

      const todayCollectedQuery = query(articlesRef, ...baseConstraints);
      const collectedSnap = await getCountFromServer(todayCollectedQuery);
      const todayCollected = collectedSnap.data().count;

      const passedConstraints = companyId && !isSuperadmin
        ? [where('companyId', '==', companyId), where('collectedAt', '>=', startOfToday), where('status', 'in', ['analyzed', 'published'])]
        : [where('collectedAt', '>=', startOfToday), where('status', 'in', ['analyzed', 'published'])];

      const todayPassedQuery = query(articlesRef, ...passedConstraints);
      const passedSnap = await getCountFromServer(todayPassedQuery);
      const todayPassed = passedSnap.data().count;

      setStats({
        todayCollected,
        todayPassed,
        successRate: todayCollected > 0 ? Math.round((todayPassed / todayCollected) * 100) : 0,
      });

      // BUG-04 FIX: outputs도 companyId 필터
      const outputsConstraints: any[] = [orderBy('createdAt', 'desc'), limit(5)];
      if (companyId && !isSuperadmin) outputsConstraints.unshift(where('companyId', '==', companyId));
      const outputsQuery = query(collection(db, 'outputs'), ...outputsConstraints);
      const outputsSnap = await getDocs(outputsQuery);
      const outputs = outputsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() as any }));
      setRecentOutputs(outputs);

      // Category distribution (last 30 days)
      const thirtyDaysAgo = subDays(today, 30);
      const catConstraints: any[] = [where('publishedAt', '>=', thirtyDaysAgo), where('status', '==', 'published')];
      if (companyId && !isSuperadmin) catConstraints.unshift(where('companyId', '==', companyId));
      const categorySnap = await getDocs(query(articlesRef, ...catConstraints));
      const categoryCount: Record<string, number> = {};
      categorySnap.docs.forEach(doc => {
        const cat = doc.data().category || 'other';
        categoryCount[cat] = (categoryCount[cat] || 0) + 1;
      });
      setCategoryData(
        Object.keys(categoryCount).map(key => ({ name: key, value: categoryCount[key] })).sort((a, b) => b.value - a.value)
      );

      // 7-day trend
      const last7DaysData = [];
      for (let i = 6; i >= 0; i--) {
        const d = subDays(today, i);
        const dayKey = format(d, 'yyyy-MM-dd');
        const output = outputs.find(item => {
          const createdAt = item.createdAt?.toDate ? format(item.createdAt.toDate(), 'yyyy-MM-dd') : '';
          return createdAt === dayKey;
        });
        last7DaysData.push({ name: format(d, 'MM/dd'), outputs: output ? output.articleCount || 0 : 0 });
      }
      setTrendData(last7DaysData);

      // Source status (company-scoped)
      const sourceConstraints: any[] = [];
      if (companyId && !isSuperadmin) sourceConstraints.push(where('companyId', '==', companyId));
      const sourcesSnap = await getDocs(
        sourceConstraints.length > 0
          ? query(collection(db, 'sources'), ...sourceConstraints)
          : collection(db, 'sources')
      );
      setSystemStatus(sourcesSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (err) {
      console.error('Dashboard load error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleRunPipeline = async () => {
    if (!companyId) {
      setPipelineMsg('No company assigned. Contact your administrator.');
      return;
    }
    setRunningPipeline(true);
    setPipelineMsg('');
    setPipelineRun(null);

    try {
      const runFn = httpsCallable(functions, 'runFullPipeline');
      const result = await runFn({ companyId }) as any;
      const pipelineId = result.data.pipelineId;

      if (pipelineId) {
        // Subscribe to real-time status
        const unsubscribeResult = onSnapshot(doc(db, 'pipelineRuns', pipelineId), (docSnap) => {
          if (docSnap.exists()) {
            const data = docSnap.data();
            setPipelineRun(data);
            if (data.status === 'completed' || data.status === 'failed') {
              setRunningPipeline(false);
              if (data.status === 'completed') fetchDashboardData();
              setTimeout(() => unsubscribeResult(), 10000); // Wait 10s before unsub
            }
          }
        });
      } else {
        setRunningPipeline(false);
        setPipelineMsg(result.data.success ? '✅ Pipeline completed' : '⚠️ Pipeline warn');
        await fetchDashboardData();
      }
    } catch (err: any) {
      setRunningPipeline(false);
      setPipelineMsg(`❌ Pipeline failed: ${err.message}`);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[500px]">
        <div className="w-8 h-8 border-4 border-[#1e3a5f] border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Dashboard</h1>
          <p className="text-gray-600 dark:text-gray-400 mt-1">Pipeline status and output summary.</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            onClick={handleRunPipeline}
            disabled={runningPipeline}
            className="flex items-center px-5 py-2.5 bg-[#1e3a5f] text-white rounded-lg font-medium hover:bg-[#2a4a73] transition-colors shadow-sm disabled:opacity-50"
          >
            {runningPipeline
              ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Running...</>
              : <><Play className="w-4 h-4 mr-2" />지금 즉시 분석 실행</>
            }
          </button>
          <p className="text-xs text-gray-500 dark:text-gray-400 mr-1 hidden sm:block">자동 분석 루틴은 매일 밤 10시에 실행됩니다.</p>
        </div>
      </div>

      {/* Pipeline Progress Monitor */}
      {(runningPipeline || pipelineRun) && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border-2 border-[#1e3a5f]/20 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-[#1e3a5f] dark:text-blue-400 flex items-center gap-2">
              <RefreshCw className={`w-4 h-4 ${pipelineRun?.status === 'running' ? 'animate-spin' : ''}`} />
              Pipeline Execution Progress
            </h3>
            <span className={`text-xs px-2 py-1 rounded-full font-bold uppercase ${
              pipelineRun?.status === 'completed' ? 'bg-green-100 text-green-700' :
              pipelineRun?.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'
            }`}>
              {pipelineRun?.status || 'Initiating...'}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {[
              { id: 'collection', label: 'Aggregation', icon: Database },
              { id: 'filtering', label: 'AI Filtering', icon: FilterIcon },
              { id: 'analysis', label: 'Deep Analysis', icon: Cpu },
              { id: 'output', label: 'Briefing Output', icon: FileText },
            ].map((step, idx) => {
              const stepData = pipelineRun?.steps?.[step.id];
              const isCompleted = stepData?.status === 'completed';
              const isRunning = stepData?.status === 'running';
              const isFailed = stepData?.status === 'failed';

              return (
                <div key={step.id} className={`relative flex flex-col items-center p-4 rounded-lg border transition-all ${isCompleted ? 'bg-green-50 border-green-200 dark:bg-green-900/10' : isRunning ? 'bg-blue-50 border-blue-200 dark:bg-blue-900/10 ring-2 ring-blue-500/20' : 'bg-gray-50 border-gray-100 dark:bg-gray-700/30'}`}>
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center mb-2 ${isCompleted ? 'bg-green-500 text-white' : isRunning ? 'bg-blue-500 text-white animate-pulse' : isFailed ? 'bg-red-500 text-white' : 'bg-gray-200 text-gray-400'}`}>
                    {isCompleted ? <CheckCircle className="w-6 h-6" /> : isFailed ? <XCircle className="w-6 h-6" /> : <step.icon className="w-5 h-5" />}
                  </div>
                  <span className="text-xs font-bold text-center">{step.label}</span>
                  {stepData?.result?.totalCollected !== undefined && (
                    <span className="text-[10px] text-green-600 font-bold mt-1">+{stepData.result.totalCollected} articles</span>
                  )}
                  {stepData?.duration && <span className="text-[8px] text-gray-400 mt-1">{Math.round(stepData.duration / 1000)}s</span>}
                </div>
              );
            })}
          </div>
          {pipelineRun?.error && (
            <div className="mt-4 p-3 bg-red-50 text-red-700 rounded-lg text-xs font-mono overflow-auto max-h-24">
              Error: {pipelineRun.error}
            </div>
          )}
          {pipelineMsg && <p className="mt-4 text-center text-sm font-medium text-gray-600">{pipelineMsg}</p>}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {[
          { label: 'Collected Today', value: stats.todayCollected, icon: LayoutDashboard, color: 'blue' },
          { label: 'AI Passed', value: stats.todayPassed, icon: CheckCircle, color: 'green' },
          { label: 'Useful Rate', value: `${stats.successRate}%`, icon: TrendingUp, color: 'gold' },
        ].map(item => (
          <div key={item.label} className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-100 dark:border-gray-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">{item.label}</p>
                <p className="text-3xl font-bold text-gray-900 dark:text-white mt-2">{item.value}</p>
              </div>
              <div className="w-12 h-12 bg-gray-100 dark:bg-gray-700 rounded-lg flex items-center justify-center">
                <item.icon className="w-6 h-6 text-[#1e3a5f] dark:text-blue-400" />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">7-day Output Trend</h2>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} />
                <YAxis axisLine={false} tickLine={false} />
                <Tooltip />
                <Bar dataKey="outputs" fill="#1e3a5f" radius={[4, 4, 0, 0]} barSize={30} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Category Distribution</h2>
          <div className="h-64 flex items-center justify-center">
            {categoryData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={categoryData} cx="50%" cy="50%" innerRadius={60} outerRadius={80} paddingAngle={5} dataKey="value">
                    {categoryData.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend verticalAlign="bottom" height={36} iconType="circle" />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-gray-400">No data</p>
            )}
          </div>
        </div>
      </div>

      {/* Recent outputs + Source status */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 lg:col-span-2">
          <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Recent Outputs</h2>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            {recentOutputs.length === 0 ? (
              <div className="px-6 py-8 text-center text-gray-400 text-sm">
                No outputs yet. Run the pipeline to generate outputs.
              </div>
            ) : recentOutputs.map(output => (
              <div
                key={output.id}
                className="flex items-center justify-between p-4 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer transition-colors"
                onClick={() => navigate(`/briefing?outputId=${output.id}`)}
              >
                <div className="flex flex-col">
                  <span className="font-medium text-gray-900 dark:text-white">{output.title || output.id}</span>
                  <span className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                    Articles: {output.articleCount || 0} ·{' '}
                    {output.createdAt?.toDate ? format(output.createdAt.toDate(), 'MM/dd HH:mm') : ''}
                  </span>
                </div>
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300">
                  {output.type || 'output'}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
          <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Source Status</h2>
            <Clock className="w-4 h-4 text-gray-400" />
          </div>
          <div className="p-4 space-y-3">
            {systemStatus.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">No sources configured</p>
            ) : systemStatus.map((source: any) => (
              <div key={source.id} className="flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-gray-900 dark:text-white">{source.name}</span>
                  <span className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {source.lastScrapedAt?.toDate ? format(source.lastScrapedAt.toDate(), 'MM/dd HH:mm') : 'Never'}
                  </span>
                </div>
                {source.lastStatus === 'error'
                  ? <AlertTriangle className="w-4 h-4 text-red-500" />
                  : source.lastStatus === 'success'
                    ? <CheckCircle className="w-4 h-4 text-green-500" />
                    : <span className="w-4 h-4 rounded-full bg-gray-200 dark:bg-gray-600 inline-block" />}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
