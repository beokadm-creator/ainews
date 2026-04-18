import { handleError } from "@/utils/errorHandler";
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
import { DEFAULT_TRACKED_COMPANIES } from '@/lib/trackedCompanies';
import { fetchSubscribedSources } from '@/lib/sourceSubscriptions';

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const FIELD_CLASS = 'w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none transition focus:border-[#1e3a5f] focus:ring-1 focus:ring-[#1e3a5f]/20 dark:border-gray-700/60 dark:bg-gray-900/40 dark:text-white dark:focus:border-blue-400';

function SectionCard({ icon: Icon, title, children }: { icon: any; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
      <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3 dark:border-gray-700/40">
        <Icon className="h-3.5 w-3.5 text-[#1e3a5f] dark:text-blue-400" />
        <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">{title}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
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
  const [trackingCompaniesText, setTrackingCompaniesText] = useState(DEFAULT_TRACKED_COMPANIES.join('\n'));
  const [usage, setUsage] = useState<any>(null);
  const [styleTemplates, setStyleTemplates] = useState<{ internal?: string; external?: string }>({});
  const [clearingTemplate, setClearingTemplate] = useState<'internal' | 'external' | null>(null);

  const loadAll = async () => {
    if (!companyId) return;
    setLoading(true);
    try {
      const [settingsDoc, subDoc, sourceList, usageResult, trackedCompaniesResult] = await Promise.all([
        getDoc(doc(db, 'companySettings', companyId)),
        getDoc(doc(db, 'companySourceSubscriptions', companyId)),
        fetchSubscribedSources(companyId),
        httpsCallable(functions, 'getAiUsageSummary')({ companyId }).catch(() => ({ data: null }) as any),
        httpsCallable(functions, 'getTrackedCompanies')({ companyId }).catch(() => ({ data: { trackedCompanies: DEFAULT_TRACKED_COMPANIES } }) as any),
      ]);

      const settings = settingsDoc.exists() ? (settingsDoc.data() as any) : {};
      setInternalPrompt(settings.reportPrompts?.internal || internalPrompt);
      setExternalPrompt(settings.reportPrompts?.external || externalPrompt);
      setStyleTemplates(settings.styleTemplates || {});
      setPublisherName(settings.branding?.publisherName || settings.companyName || '이음프라이빗에쿼티');
      setLogoDataUrl(settings.branding?.logoDataUrl || '');
      setSmtpHost(settings.smtp?.host || '');
      setSmtpPort(`${settings.smtp?.port || 587}`);
      setSmtpSecure(Boolean(settings.smtp?.secure));
      setSmtpUser(settings.smtp?.user || '');
      setSmtpPass(settings.smtp?.pass || '');
      setSmtpFrom(settings.smtp?.from || '');
      setTrackingCompaniesText(
        Array.isArray((trackedCompaniesResult as any)?.data?.trackedCompanies) && (trackedCompaniesResult as any).data.trackedCompanies.length > 0
          ? (trackedCompaniesResult as any).data.trackedCompanies.join('\n')
          : DEFAULT_TRACKED_COMPANIES.join('\n'),
      );

      const subscribedIds: string[] = subDoc.exists() ? ((subDoc.data() as any).subscribedSourceIds || []) : [];
      setSources(
        dedupeSourceCatalog(
          sourceList
            .filter((item) => subscribedIds.includes(item.id)),
        ).map((item) => ({ id: item.id, name: item.name })),
      );

      setUsage((usageResult as any)?.data || null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll().catch(handleError);
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
        <Loader2 className="h-6 w-6 animate-spin text-[#1e3a5f] dark:text-gray-400" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-12">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 border-b border-gray-200 pb-5 dark:border-gray-700/60">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">회사 설정</h1>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            리포트 브랜드 정보, 프롬프트, AI 사용량을 관리합니다.
          </p>
        </div>
        <button
          onClick={loadAll}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700/60 dark:bg-gray-800/60 dark:text-gray-300 dark:hover:bg-white/5"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          새로고침
        </button>
      </div>

      {/* AI usage stat cards */}
      <div>
        <div className="mb-3 flex items-center gap-3">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">AI 사용량</span>
          <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700/60" />
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {[
            { label: '최근 24시간', value: usage?.last24h?.totalTokens || 0, sub: `${usage?.last24h?.requests || 0}회 호출` },
            { label: '최근 7일', value: usage?.last7d?.totalTokens || 0, sub: `$${Number(usage?.last7d?.totalCostUSD || 0).toFixed(2)}` },
            { label: '최근 30일', value: usage?.last30d?.totalTokens || 0, sub: `$${Number(usage?.last30d?.totalCostUSD || 0).toFixed(2)}` },
          ].map((item) => (
            <div key={item.label} className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700/60 dark:bg-gray-800/60">
              <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                <BarChart3 className="h-3.5 w-3.5" />
                {item.label}
              </div>
              <p className="mt-2 text-2xl font-bold tabular-nums text-[#1e3a5f] dark:text-blue-400">{Number(item.value).toLocaleString()}</p>
              <p className="mt-0.5 text-xs text-gray-400">{item.sub}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Brand */}
      <SectionCard icon={Building2} title="리포트 브랜드">
        <div className="grid gap-5 md:grid-cols-[1fr_200px]">
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">발행 회사명</label>
              <input value={publisherName} onChange={(e) => setPublisherName(e.target.value)} className={FIELD_CLASS} placeholder="이음프라이빗에쿼티" />
            </div>
            <div>
              <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">로고 이미지</label>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-gray-200 bg-gray-50 px-3 py-3 text-xs text-gray-500 hover:bg-gray-100 dark:border-gray-700/60 dark:bg-gray-900/40 dark:text-gray-400 dark:hover:bg-white/5">
                <ImageIcon className="h-4 w-4" />
                로고 파일 선택
                <input type="file" accept="image/*" className="hidden" onChange={handleLogoChange} />
              </label>
              <p className="mt-2 text-[11px] text-gray-400">업로드한 로고와 회사명은 HTML/PDF 리포트와 메일 첨부 PDF 상단에 공통 반영됩니다.</p>
            </div>
          </div>
          <div className="rounded-lg border border-gray-100 bg-gray-50 p-3 dark:border-gray-700/40 dark:bg-gray-900/30">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-400">미리보기</p>
            <div className="flex min-h-[120px] flex-col items-center justify-center rounded-lg bg-white p-3 text-center dark:bg-gray-800">
              {logoDataUrl ? (
                <img src={logoDataUrl} alt="브랜드 로고" className="max-h-16 max-w-full object-contain" />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#1e3a5f] text-lg font-bold text-white">
                  {(publisherName || '이').slice(0, 1)}
                </div>
              )}
              <p className="mt-2 text-xs font-semibold text-gray-900 dark:text-white">{publisherName || '이음프라이빗에쿼티'}</p>
            </div>
          </div>
        </div>
      </SectionCard>

      {/* Prompts */}
      <SectionCard icon={Sparkles} title="리포트 프롬프트">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">내부 리포트</label>
            <textarea value={internalPrompt} onChange={(e) => setInternalPrompt(e.target.value)} rows={8} className={FIELD_CLASS} />
          </div>
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">외부 리포트</label>
            <textarea value={externalPrompt} onChange={(e) => setExternalPrompt(e.target.value)} rows={8} className={FIELD_CLASS} />
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            onClick={saveSettings}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-xl bg-[#1e3a5f] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#24456f] disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            저장
          </button>
        </div>
      </SectionCard>

      {/* Style Templates */}
      <SectionCard icon={Sparkles} title="스타일 템플릿">
        <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
          리포트 생성 시 참고할 구조 및 톤앤매너 템플릿입니다. Briefing 페이지에서 원하는 리포트를 스타일 템플릿으로 지정할 수 있습니다.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          {(['internal', 'external'] as const).map((mode) => (
            <div key={mode} className="rounded-lg border border-gray-100 p-3 dark:border-gray-700/40">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                {mode === 'internal' ? '내부 리포트 템플릿' : '외부 리포트 템플릿'}
              </div>
              {styleTemplates[mode] ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs text-gray-600 dark:text-gray-300">
                    {styleTemplates[mode]}
                  </span>
                  <button
                    onClick={async () => {
                      if (!companyId) return;
                      setClearingTemplate(mode);
                      try {
                        await httpsCallable(functions, 'saveCompanyStyleTemplate')({ companyId, mode, outputId: null });
                        setStyleTemplates((prev) => {
                          const next = { ...prev };
                          delete next[mode];
                          return next;
                        });
                      } finally {
                        setClearingTemplate(null);
                      }
                    }}
                    disabled={clearingTemplate === mode}
                    className="shrink-0 text-xs text-red-500 transition hover:text-red-700 disabled:opacity-50"
                  >
                    {clearingTemplate === mode ? <Loader2 className="h-3.5 w-3.5 animate-spin inline" /> : '해제'}
                  </button>
                </div>
              ) : (
                <p className="text-xs text-gray-400">설정된 템플릿 없음 — Briefing에서 리포트를 선택 후 설정하세요.</p>
              )}
            </div>
          ))}
        </div>
      </SectionCard>

      {/* Tracked companies */}
      <SectionCard icon={Building2} title="관심등록회사">
        <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">회사명을 한 줄에 하나씩 입력</label>
        <textarea
          value={trackingCompaniesText}
          rows={8}
          readOnly
          className={FIELD_CLASS}
        />
        <p className="mt-2 text-[11px] text-gray-400">
          이 목록은 슈퍼어드민 키워드 관리에서 동기화되며, 관심등록회사 메뉴와 필터 기준에 같이 사용됩니다.
        </p>
      </SectionCard>

      {/* SMTP */}
      <SectionCard icon={Mail} title="SMTP / 메일 설정">
        <div className="grid gap-3 md:grid-cols-2">
          <input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="SMTP Host" className={FIELD_CLASS} />
          <input value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} placeholder="Port (예: 587)" className={FIELD_CLASS} />
          <input value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} placeholder="SMTP User" className={FIELD_CLASS} />
          <input type="password" value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} placeholder="SMTP Password" className={FIELD_CLASS} />
          <input value={smtpFrom} onChange={(e) => setSmtpFrom(e.target.value)} placeholder='From (예: "EUM" <noreply@domain.com>)' className={`md:col-span-2 ${FIELD_CLASS}`} />
          <label className="md:col-span-2 inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
            <input type="checkbox" checked={smtpSecure} onChange={(e) => setSmtpSecure(e.target.checked)} className="rounded" />
            Use SMTPS (secure)
          </label>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            onClick={saveSettings}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-xl bg-[#1e3a5f] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#24456f] disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            저장
          </button>
        </div>
      </SectionCard>

      {/* Subscribed sources */}
      <SectionCard icon={Database} title="구독 매체">
        <div className="flex flex-wrap gap-2">
          {sources.map((source) => (
            <span key={source.id} className="rounded-md bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
              {source.name}
            </span>
          ))}
          {sources.length === 0 && <p className="text-sm text-gray-400">구독한 매체가 없습니다.</p>}
        </div>
      </SectionCard>

      {/* Recent AI calls */}
      <SectionCard icon={CheckCircle2} title="최근 AI 호출">
        <div className="space-y-2">
          {(usage?.recent || []).map((item: any) => (
            <div key={item.id} className="rounded-lg border border-gray-100 px-3 py-2.5 dark:border-gray-700/40">
              <p className="text-sm font-medium text-gray-900 dark:text-white">{item.stage}</p>
              <p className="mt-0.5 text-xs text-gray-400">
                {item.provider} / {item.model} / {Number(item.totalTokens || 0).toLocaleString()} tokens
              </p>
            </div>
          ))}
          {(usage?.recent || []).length === 0 && (
            <p className="text-sm text-gray-400">최근 토큰 사용 기록이 없습니다. 새 리포트 생성 이후부터 사용량이 누적됩니다.</p>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
