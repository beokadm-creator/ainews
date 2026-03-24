import { useEffect, useState } from 'react';
import { BarChart3, CheckCircle2, Database, Loader2, RefreshCw, Save, Sparkles } from 'lucide-react';
import { collection, doc, getDoc, getDocs, setDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '@/lib/firebase';
import { useAuthStore } from '@/store/useAuthStore';

export default function Settings() {
  const { user } = useAuthStore();
  const companyId = (user as any)?.primaryCompanyId || null;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sources, setSources] = useState<{ id: string; name: string }[]>([]);
  const [internalPrompt, setInternalPrompt] = useState(
    '팩트 기반으로 요약하고, PE 업계에서 놓치면 안 되는 체크포인트를 정리합니다. 제언과 의견은 제외합니다.',
  );
  const [externalPrompt, setExternalPrompt] = useState(
    '외부 메일링용으로 간결하게 요약하되 사실과 변화 포인트만 전달합니다. 의견이나 투자 판단은 제외합니다.',
  );
  const [usage, setUsage] = useState<any>(null);

  const loadAll = async () => {
    if (!companyId) return;
    setLoading(true);
    try {
      const [settingsDoc, subDoc, sourceSnap, usageResult] = await Promise.all([
        getDoc(doc(db, 'companySettings', companyId)),
        getDoc(doc(db, 'companySourceSubscriptions', companyId)),
        getDocs(collection(db, 'globalSources')),
        httpsCallable(functions, 'getAiUsageSummary')({ companyId }),
      ]);

      const settings = settingsDoc.exists() ? (settingsDoc.data() as any) : {};
      setInternalPrompt(settings.reportPrompts?.internal || internalPrompt);
      setExternalPrompt(settings.reportPrompts?.external || externalPrompt);

      const subscribedIds: string[] = subDoc.exists() ? ((subDoc.data() as any).subscribedSourceIds || []) : [];
      setSources(
        sourceSnap.docs
          .map((item) => ({ id: item.id, ...(item.data() as any) }))
          .filter((item) => subscribedIds.includes(item.id))
          .map((item) => ({ id: item.id, name: item.name })),
      );

      setUsage((usageResult as any).data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll().catch(console.error);
  }, [companyId]);

  const savePrompts = async () => {
    if (!companyId) return;
    setSaving(true);
    try {
      await setDoc(doc(db, 'companySettings', companyId), {
        reportPrompts: {
          internal: internalPrompt.trim(),
          external: externalPrompt.trim(),
        },
      }, { merge: true });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-[#1e3a5f]" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">회사 설정</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            내부/외부 리포트 프롬프트와 회사의 AI 토큰 사용량을 관리합니다.
          </p>
        </div>
        <button
          onClick={loadAll}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
        >
          <RefreshCw className="h-4 w-4" />
          새로고침
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {[
          { label: '최근 24시간', value: usage?.last24h?.totalTokens || 0, sub: `${usage?.last24h?.requests || 0}회 호출` },
          { label: '최근 7일', value: usage?.last7d?.totalTokens || 0, sub: `$${(usage?.last7d?.totalCostUSD || 0).toFixed(2)}` },
          { label: '최근 30일', value: usage?.last30d?.totalTokens || 0, sub: `$${(usage?.last30d?.totalCostUSD || 0).toFixed(2)}` },
        ].map((item) => (
          <div key={item.label} className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300">
              <BarChart3 className="h-4 w-4 text-[#1e3a5f]" />
              {item.label}
            </div>
            <div className="mt-3 text-2xl font-bold text-gray-900 dark:text-white">{Number(item.value).toLocaleString()}</div>
            <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{item.sub}</div>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
          <Sparkles className="h-4 w-4 text-[#d4af37]" />
          리포트 프롬프트 정책
        </div>
        <div className="mt-4 grid gap-5 md:grid-cols-2">
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-gray-500">내부 리포트 프롬프트</label>
            <textarea
              value={internalPrompt}
              onChange={(event) => setInternalPrompt(event.target.value)}
              rows={8}
              className="mt-2 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none focus:border-[#1e3a5f] dark:border-gray-700 dark:bg-gray-900/30 dark:text-white"
            />
          </div>
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-gray-500">외부 리포트 프롬프트</label>
            <textarea
              value={externalPrompt}
              onChange={(event) => setExternalPrompt(event.target.value)}
              rows={8}
              className="mt-2 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none focus:border-[#1e3a5f] dark:border-gray-700 dark:bg-gray-900/30 dark:text-white"
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            onClick={savePrompts}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-xl bg-[#1e3a5f] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#24456f] disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            저장
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
          <Database className="h-4 w-4 text-[#1e3a5f]" />
          구독 매체
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {sources.map((source) => (
            <span key={source.id} className="rounded-full bg-gray-100 px-3 py-1.5 text-sm text-gray-700 dark:bg-gray-700 dark:text-gray-200">
              {source.name}
            </span>
          ))}
          {sources.length === 0 && (
            <div className="text-sm text-gray-400">구독한 매체가 없습니다.</div>
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
          <CheckCircle2 className="h-4 w-4 text-[#1e3a5f]" />
          최근 AI 호출
        </div>
        <div className="mt-4 space-y-3">
          {(usage?.recent || []).map((item: any) => (
            <div key={item.id} className="rounded-xl border border-gray-200 px-4 py-3 text-sm dark:border-gray-700">
              <div className="font-medium text-gray-900 dark:text-white">{item.stage}</div>
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {item.provider} / {item.model} / {Number(item.totalTokens || 0).toLocaleString()} tokens
              </div>
            </div>
          ))}
          {(usage?.recent || []).length === 0 && (
            <div className="text-sm text-gray-400">최근 토큰 사용 기록이 없습니다.</div>
          )}
        </div>
      </div>
    </div>
  );
}
