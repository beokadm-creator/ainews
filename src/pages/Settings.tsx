import { useEffect, useState } from 'react';
import {
  BarChart3,
  Building2,
  CheckCircle2,
  Database,
  Image as ImageIcon,
  Loader2,
  Mail,
  RefreshCw,
  Save,
  Sparkles,
} from 'lucide-react';
import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '@/lib/firebase';
import { useAuthStore } from '@/store/useAuthStore';
import { dedupeSourceCatalog } from '@/lib/sourceCatalog';

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function Settings() {
  const { user } = useAuthStore();
  const companyId = (user as any)?.primaryCompanyId || (user as any)?.companyId || (user as any)?.companyIds?.[0] || null;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sources, setSources] = useState<{ id: string; name: string }[]>([]);
  const [internalPrompt, setInternalPrompt] = useState('기사 기반으로 요약하고, PE 관점에서 중요 포인트와 체크포인트를 정리합니다.');
  const [externalPrompt, setExternalPrompt] = useState('외부 메일링용으로 간결하게 요약하되 핵심 사실과 시사점만 전달합니다.');
  const [publisherName, setPublisherName] = useState('이음프라이빗에쿼티');
  const [logoDataUrl, setLogoDataUrl] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [smtpFrom, setSmtpFrom] = useState('');
  const [usage, setUsage] = useState<any>(null);

  const loadAll = async () => {
    if (!companyId) return;
    setLoading(true);
    try {
      const [settingsDoc, subDoc, sourceSnap, usageResult] = await Promise.all([
        getDoc(doc(db, 'companySettings', companyId)),
        getDoc(doc(db, 'companySourceSubscriptions', companyId)),
        getDocs(collection(db, 'globalSources')),
        httpsCallable(functions, 'getAiUsageSummary')({ companyId }).catch(() => ({ data: null }) as any),
      ]);

      const settings = settingsDoc.exists() ? (settingsDoc.data() as any) : {};
      setInternalPrompt(settings.reportPrompts?.internal || internalPrompt);
      setExternalPrompt(settings.reportPrompts?.external || externalPrompt);
      setPublisherName(settings.branding?.publisherName || settings.companyName || '이음프라이빗에쿼티');
      setLogoDataUrl(settings.branding?.logoDataUrl || '');
      setSmtpHost(settings.smtp?.host || '');
      setSmtpPort(`${settings.smtp?.port || 587}`);
      setSmtpSecure(Boolean(settings.smtp?.secure));
      setSmtpUser(settings.smtp?.user || '');
      setSmtpPass(settings.smtp?.pass || '');
      setSmtpFrom(settings.smtp?.from || '');

      const subscribedIds: string[] = subDoc.exists() ? ((subDoc.data() as any).subscribedSourceIds || []) : [];
      setSources(
        dedupeSourceCatalog(
          sourceSnap.docs
            .map((item) => ({ id: item.id, ...(item.data() as any) }))
            .filter((item) => subscribedIds.includes(item.id)),
        ).map((item) => ({ id: item.id, name: item.name })),
      );

      setUsage((usageResult as any)?.data || null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll().catch(console.error);
  }, [companyId]);

  const saveSettings = async () => {
    if (!companyId) return;
    setSaving(true);
    try {
      const fn = httpsCallable(functions, 'saveCompanySettings');
      await fn({
        companyId,
        companyName: publisherName.trim(),
        publisherName: publisherName.trim(),
        internalPrompt: internalPrompt.trim(),
        externalPrompt: externalPrompt.trim(),
        logoDataUrl: logoDataUrl || null,
        smtp: {
          host: smtpHost.trim(),
          port: Number(smtpPort || 587),
          secure: smtpSecure,
          user: smtpUser.trim(),
          pass: smtpPass.trim(),
          from: smtpFrom.trim(),
        },
      });
    } finally {
      setSaving(false);
    }
  };

  const handleLogoChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const dataUrl = await readFileAsDataUrl(file);
    setLogoDataUrl(dataUrl);
  };

  if (loading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-[#1e3a5f]" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-12">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">회사 설정</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            리포트 브랜드 정보, 프롬프트, AI 사용량을 관리합니다.
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
          { label: '최근 7일', value: usage?.last7d?.totalTokens || 0, sub: `$${Number(usage?.last7d?.totalCostUSD || 0).toFixed(2)}` },
          { label: '최근 30일', value: usage?.last30d?.totalTokens || 0, sub: `$${Number(usage?.last30d?.totalCostUSD || 0).toFixed(2)}` },
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
          <Building2 className="h-4 w-4 text-[#1e3a5f]" />
          리포트 브랜드
        </div>
        <div className="mt-4 grid gap-5 md:grid-cols-[1fr_220px]">
          <div className="space-y-4">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-gray-500">발행 회사명</label>
              <input
                value={publisherName}
                onChange={(event) => setPublisherName(event.target.value)}
                className="mt-2 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none focus:border-[#1e3a5f] dark:border-gray-700 dark:bg-gray-900/30 dark:text-white"
                placeholder="이음프라이빗에쿼티"
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-gray-500">로고 이미지</label>
              <label className="mt-2 flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-gray-300 bg-gray-50 px-3 py-3 text-sm text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900/30 dark:text-gray-300">
                <ImageIcon className="h-4 w-4" />
                로고 파일 선택
                <input type="file" accept="image/*" className="hidden" onChange={handleLogoChange} />
              </label>
              <div className="mt-2 text-xs text-gray-400">
                업로드한 로고와 회사명은 HTML/PDF 리포트와 메일 첨부 PDF 상단에 공통 반영됩니다.
              </div>
            </div>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/30">
            <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">미리보기</div>
            <div className="mt-4 flex min-h-[160px] flex-col items-center justify-center rounded-xl bg-white p-4 text-center dark:bg-gray-800">
              {logoDataUrl ? (
                <img src={logoDataUrl} alt="브랜드 로고" className="max-h-20 max-w-full object-contain" />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#1e3a5f] text-xl font-bold text-white">
                  {(publisherName || '이').slice(0, 1)}
                </div>
              )}
              <div className="mt-3 text-sm font-semibold text-gray-900 dark:text-white">{publisherName || '이음프라이빗에쿼티'}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
          <Sparkles className="h-4 w-4 text-[#d4af37]" />
          리포트 프롬프트
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
            onClick={saveSettings}
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
          <Mail className="h-4 w-4 text-[#1e3a5f]" />
          SMTP / ?? ??
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="SMTP Host" className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none focus:border-[#1e3a5f] dark:border-gray-700 dark:bg-gray-900/30 dark:text-white" />
          <input value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} placeholder="Port" className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none focus:border-[#1e3a5f] dark:border-gray-700 dark:bg-gray-900/30 dark:text-white" />
          <input value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} placeholder="SMTP User" className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none focus:border-[#1e3a5f] dark:border-gray-700 dark:bg-gray-900/30 dark:text-white" />
          <input value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} placeholder="SMTP Password" className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none focus:border-[#1e3a5f] dark:border-gray-700 dark:bg-gray-900/30 dark:text-white" />
          <input value={smtpFrom} onChange={(e) => setSmtpFrom(e.target.value)} placeholder='From (e.g. "EUM" <noreply@domain.com>)' className="md:col-span-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none focus:border-[#1e3a5f] dark:border-gray-700 dark:bg-gray-900/30 dark:text-white" />
          <label className="md:col-span-2 inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
            <input type="checkbox" checked={smtpSecure} onChange={(e) => setSmtpSecure(e.target.checked)} />
            Use SMTPS (secure)
          </label>
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
            <div className="text-sm text-gray-400">
              최근 토큰 사용 기록이 없습니다. 새 리포트 생성 이후부터 사용량이 누적됩니다.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
