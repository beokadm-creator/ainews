import { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDoc, getDocs, onSnapshot, orderBy, query, serverTimestamp, setDoc, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import {
  AlertCircle,
  CalendarClock,
  Clock3,
  ExternalLink,
  Eye,
  Loader2,
  Mail,
  RefreshCw,
  Save,
  Send,
  Sparkles,
} from 'lucide-react';
import { db, functions } from '@/lib/firebase';
import { useAuthStore } from '@/store/useAuthStore';

type DatePreset = '24h' | '3d' | '7d' | '15d' | '30d';

interface SourceItem {
  id: string;
  name: string;
}

interface DeliveryGroup {
  id: string;
  name: string;
  emails: string[];
  sourceIds: string[];
  sourceNames?: string[];
  keywords: string[];
  datePreset: DatePreset;
  prompt?: string;
  reportTitle?: string;
  autoEnabled?: boolean;
  autoTimeKst?: string;
  nextReservedSendAt?: any;
  active?: boolean;
  updatedAt?: any;
}

const DATE_OPTIONS: { value: DatePreset; label: string }[] = [
  { value: '24h', label: '최근 24시간' },
  { value: '3d', label: '최근 3일' },
  { value: '7d', label: '최근 7일' },
  { value: '15d', label: '최근 15일' },
  { value: '30d', label: '최근 30일' },
];

function parseLines(value: string) {
  return value
    .split(/[\n,;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sanitizeReportHtml(raw: string) {
  const trimmed = (raw || '').trim();
  let cleaned = trimmed;

  if (trimmed.startsWith('```')) {
    const fenceMatch = trimmed.match(/^```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```$/);
    cleaned = fenceMatch
      ? fenceMatch[1].trim()
      : trimmed.replace(/^```[a-zA-Z0-9_-]*\s*/, '').replace(/\s*```$/, '').trim();
  }

  const doctypeIdx = cleaned.search(/<!doctype\s+html/i);
  if (doctypeIdx >= 0) return cleaned.slice(doctypeIdx).trim();
  const htmlIdx = cleaned.search(/<html[\s>]/i);
  if (htmlIdx >= 0) return cleaned.slice(htmlIdx).trim();
  return cleaned;
}

export default function DeliveryCenter() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const companyId = (user as any)?.primaryCompanyId || (user as any)?.companyId || (user as any)?.companyIds?.[0] || null;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [groups, setGroups] = useState<DeliveryGroup[]>([]);
  const [recentRuns, setRecentRuns] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<string>('new');

  const [name, setName] = useState('');
  const [emailsText, setEmailsText] = useState('');
  const [keywordsText, setKeywordsText] = useState('');
  const [reportTitle, setReportTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [datePreset, setDatePreset] = useState<DatePreset>('24h');
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [autoEnabled, setAutoEnabled] = useState(true);
  const [autoTimeKst, setAutoTimeKst] = useState('08:00');
  const [reservedAt, setReservedAt] = useState('');
  const [message, setMessage] = useState('');
  const [defaultExternalPrompt, setDefaultExternalPrompt] = useState('');
  const [defaultReportTitle, setDefaultReportTitle] = useState('');

  const [previewRequestId, setPreviewRequestId] = useState<string | null>(null);
  const [previewOutput, setPreviewOutput] = useState<any | null>(null);
  const [previewArticles, setPreviewArticles] = useState<any[]>([]);
  const parsedKeywords = useMemo(() => parseLines(keywordsText), [keywordsText]);
  const selectedSourceNames = useMemo(
    () => sources.filter((item) => sourceIds.includes(item.id)).map((item) => item.name),
    [sourceIds, sources],
  );

  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedId) || null,
    [groups, selectedId],
  );

  const previewHtml = useMemo(
    () => sanitizeReportHtml(previewOutput?.generatedOutput?.htmlContent || previewOutput?.htmlContent || previewOutput?.rawOutput || ''),
    [previewOutput],
  );

  const loadAll = async () => {
    if (!companyId) return;

    setLoading(true);
    try {
      const [settingsDoc, subDoc] = await Promise.all([
        getDoc(doc(db, 'companySettings', companyId)),
        getDoc(doc(db, 'companySourceSubscriptions', companyId)),
      ]);
      const subscribedIds: string[] = subDoc.exists() ? ((subDoc.data() as any).subscribedSourceIds || []) : [];
      const companySettings = settingsDoc.exists() ? (settingsDoc.data() as any) : {};
      const externalPrompt = `${companySettings.reportPrompts?.external || ''}`.trim();
      const publisherName = `${companySettings.branding?.publisherName || companySettings.companyName || ''}`.trim();
      setDefaultExternalPrompt(externalPrompt);
      setDefaultReportTitle(publisherName ? `${publisherName} 외부 리포트` : '외부 메일링 리포트');

      const [sourceSnap, groupSnap, outputSnap] = await Promise.all([
        getDocs(collection(db, 'globalSources')),
        getDocs(query(collection(db, 'distributionGroups'), where('companyId', '==', companyId))),
        getDocs(query(collection(db, 'outputs'), where('companyId', '==', companyId), orderBy('createdAt', 'desc'))),
      ]);

      const availableSources = sourceSnap.docs
        .map((item) => ({ id: item.id, ...(item.data() as any) }))
        .filter((item) => subscribedIds.includes(item.id))
        .map((item) => ({ id: item.id, name: item.name }));

      setSources(availableSources);
      setGroups(
        groupSnap.docs
          .map((item) => ({ id: item.id, ...(item.data() as any) } as DeliveryGroup))
          .sort((left, right) => {
            const leftTime = left.updatedAt?.toDate ? left.updatedAt.toDate().getTime() : 0;
            const rightTime = right.updatedAt?.toDate ? right.updatedAt.toDate().getTime() : 0;
            return rightTime - leftTime;
          }),
      );
      setRecentRuns(
        outputSnap.docs
          .map((item) => ({ id: item.id, ...(item.data() as any) }))
          .filter((item) => item.serviceMode === 'external' || item.distributionGroupId)
          .slice(0, 10),
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll().catch(console.error);
  }, [companyId]);

  useEffect(() => {
    if (!selectedGroup) {
      setName('');
      setEmailsText('');
      setKeywordsText('');
      setReportTitle(defaultReportTitle);
      setPrompt(defaultExternalPrompt);
      setDatePreset('24h');
      setSourceIds([]);
      setAutoEnabled(true);
      setAutoTimeKst('08:00');
      setReservedAt('');
      return;
    }

    setName(selectedGroup.name || '');
    setEmailsText((selectedGroup.emails || []).join('\n'));
    setKeywordsText((selectedGroup.keywords || []).join(', '));
    setReportTitle(selectedGroup.reportTitle || '');
    setPrompt(selectedGroup.prompt || '');
    setDatePreset(selectedGroup.datePreset || '24h');
    setSourceIds(selectedGroup.sourceIds || []);
    setAutoEnabled(Boolean(selectedGroup.autoEnabled));
    setAutoTimeKst(selectedGroup.autoTimeKst || '08:00');
    const nextReserved = selectedGroup.nextReservedSendAt?.toDate
      ? selectedGroup.nextReservedSendAt.toDate()
      : (selectedGroup.nextReservedSendAt ? new Date(selectedGroup.nextReservedSendAt) : null);
    setReservedAt(nextReserved ? format(nextReserved, "yyyy-MM-dd'T'HH:mm") : '');
  }, [defaultExternalPrompt, defaultReportTitle, selectedGroup]);

  useEffect(() => {
    if (!previewRequestId) return undefined;

    const unsubscribe = onSnapshot(doc(db, 'outputs', previewRequestId), async (snap) => {
      if (!snap.exists()) return;

      let output = { id: snap.id, ...(snap.data() as any) };
      if (output.generatedOutputId) {
        const generatedDoc = await getDoc(doc(db, 'outputs', output.generatedOutputId));
        if (generatedDoc.exists()) {
          output = {
            ...output,
            generatedOutput: { id: generatedDoc.id, ...(generatedDoc.data() as any) },
          };
        }
      }

      setPreviewOutput(output);

      const effectiveArticleIds = output.generatedOutput?.articleIds || output.articleIds || [];
      if (effectiveArticleIds.length > 0) {
        const docs = await Promise.all(effectiveArticleIds.map((id: string) => getDoc(doc(db, 'articles', id))));
        setPreviewArticles(docs.filter((item) => item.exists()).map((item) => ({ id: item.id, ...(item.data() as any) })));
      } else {
        setPreviewArticles([]);
      }
    });

    return () => unsubscribe();
  }, [previewRequestId]);

  const toggleSource = (sourceId: string) => {
    setSourceIds((prev) => prev.includes(sourceId) ? prev.filter((item) => item !== sourceId) : [...prev, sourceId]);
  };

  const saveGroup = async () => {
    if (!companyId) return;
    if (!name.trim()) {
      setMessage('그룹 이름을 입력해 주세요.');
      return;
    }

    setSaving(true);
    setMessage('');
    try {
      const targetRef = selectedId !== 'new'
        ? doc(db, 'distributionGroups', selectedId)
        : doc(collection(db, 'distributionGroups'));
      const payload: any = {
        companyId,
        name: name.trim(),
        emails: parseLines(emailsText),
        sourceIds,
        sourceNames: selectedSourceNames,
        keywords: parseLines(keywordsText),
        datePreset,
        prompt: prompt.trim(),
        reportTitle: reportTitle.trim(),
        autoEnabled,
        autoTimeKst,
        nextReservedSendAt: reservedAt ? new Date(reservedAt) : null,
        active: true,
        updatedAt: serverTimestamp(),
      };
      if (selectedId === 'new') payload.createdAt = serverTimestamp();

      await setDoc(targetRef, payload, { merge: true });
      setSelectedId(targetRef.id);
      setMessage('메일링 그룹 설정을 저장했습니다.');
      await loadAll();
    } finally {
      setSaving(false);
    }
  };

  const requestReport = async (scheduledAt?: string | null) => {
    if (!companyId) return;

    setSending(true);
    setMessage('');
    try {
      const fn = httpsCallable(functions, 'requestManagedReport');
      await fn({
        companyId,
        mode: 'external',
        reportTitle: reportTitle.trim() || name.trim(),
        prompt: prompt.trim(),
        filters: {
          sourceIds,
          keywords: parseLines(keywordsText),
          datePreset,
        },
        distributionGroupId: selectedGroup?.id || null,
        distributionGroupName: name.trim(),
        recipients: parseLines(emailsText),
        sendNow: !scheduledAt,
        scheduledAt: scheduledAt || null,
        sourceNames: selectedSourceNames,
      });

      setMessage(scheduledAt ? '예약 발송을 등록했습니다.' : '외부 메일 리포트 생성과 즉시 발송을 시작했습니다.');
      await loadAll();
    } finally {
      setSending(false);
    }
  };

  const generatePreview = async () => {
    if (!companyId) return;

    setPreviewing(true);
    setMessage('');
    try {
      const fn = httpsCallable(functions, 'requestManagedReport');
      const result = await fn({
        companyId,
        mode: 'external',
        reportTitle: reportTitle.trim() || name.trim(),
        prompt: prompt.trim(),
        filters: {
          sourceIds,
          keywords: parseLines(keywordsText),
          datePreset,
        },
        distributionGroupId: selectedGroup?.id || null,
        distributionGroupName: name.trim(),
        recipients: [],
        sendNow: false,
        scheduledAt: null,
        sourceNames: selectedSourceNames,
        previewOnly: true,
      }) as any;

      setPreviewRequestId(result.data?.outputId || null);
      setMessage('미리보기 리포트 생성을 시작했습니다. 완료되면 아래 미리보기 영역에 표시됩니다.');
      await loadAll();
    } finally {
      setPreviewing(false);
    }
  };

  const retryRun = async (outputId: string) => {
    const fn = httpsCallable(functions, 'retryManagedReport');
    await fn({ outputId });
    setMessage('실패한 외부 리포트를 다시 실행했습니다.');
    await loadAll();
  };

  if (loading) {
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-[#1e3a5f]" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-12">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">외부 메일링 센터</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            수신자 그룹과 매체 조건을 저장하고, 외부용 AI 리포트를 미리 확인한 뒤 발송할 수 있습니다.
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

      {message && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700 dark:border-blue-900/40 dark:bg-blue-900/20 dark:text-blue-300">
          {message}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <div className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold text-gray-900 dark:text-white">메일링 그룹</h2>
            <button
              onClick={() => setSelectedId('new')}
              className="text-sm font-medium text-[#1e3a5f] dark:text-blue-300"
            >
              새 그룹
            </button>
          </div>
          <div className="space-y-2">
            {groups.map((group) => (
              <button
                key={group.id}
                onClick={() => setSelectedId(group.id)}
                className={`w-full rounded-xl border px-3 py-3 text-left transition ${
                  selectedId === group.id
                    ? 'border-[#1e3a5f] bg-[#1e3a5f]/5 dark:border-blue-400 dark:bg-blue-400/10'
                    : 'border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/50'
                }`}
              >
                <div className="font-medium text-gray-900 dark:text-white">{group.name}</div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {group.emails?.length || 0}명 · {group.sourceIds?.length || 0}개 매체
                </div>
              </button>
            ))}
            {groups.length === 0 && (
              <div className="rounded-xl border border-dashed border-gray-300 px-3 py-6 text-center text-sm text-gray-400 dark:border-gray-700">
                저장된 메일링 그룹이 없습니다.
              </div>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
            <div className="grid gap-5 md:grid-cols-2">
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-gray-500">그룹 이름</label>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none focus:border-[#1e3a5f] dark:border-gray-700 dark:bg-gray-900/40 dark:text-white"
                  placeholder="예: 데일리 PE 메일링"
                />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-gray-500">리포트 제목</label>
                <input
                  value={reportTitle}
                  onChange={(event) => setReportTitle(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none focus:border-[#1e3a5f] dark:border-gray-700 dark:bg-gray-900/40 dark:text-white"
                  placeholder="비워두면 그룹 이름을 사용합니다"
                />
              </div>
            </div>

            <div className="mt-5 grid gap-5 md:grid-cols-2">
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-gray-500">수신 이메일</label>
                <textarea
                  value={emailsText}
                  onChange={(event) => setEmailsText(event.target.value)}
                  className="mt-2 min-h-[140px] w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none focus:border-[#1e3a5f] dark:border-gray-700 dark:bg-gray-900/40 dark:text-white"
                  placeholder={'ceo@company.com\nir@company.com'}
                />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-gray-500">AI 분석 지시</label>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  className="mt-2 min-h-[140px] w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none focus:border-[#1e3a5f] dark:border-gray-700 dark:bg-gray-900/40 dark:text-white"
                  placeholder="예: PE 관점에서 핵심 포인트와 체크포인트만 간결하게 정리"
                />
              </div>
            </div>

            <div className="mt-5 grid gap-5 md:grid-cols-3">
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-gray-500">키워드</label>
                <input
                  value={keywordsText}
                  onChange={(event) => setKeywordsText(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none focus:border-[#1e3a5f] dark:border-gray-700 dark:bg-gray-900/40 dark:text-white"
                  placeholder="PE, 인수금융, 구조조정"
                />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-gray-500">기사 기간</label>
                <select
                  value={datePreset}
                  onChange={(event) => setDatePreset(event.target.value as DatePreset)}
                  className="mt-2 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none focus:border-[#1e3a5f] dark:border-gray-700 dark:bg-gray-900/40 dark:text-white"
                >
                  {DATE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-gray-500">자동발송 시간 (KST)</label>
                <input
                  type="time"
                  value={autoTimeKst}
                  onChange={(event) => setAutoTimeKst(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none focus:border-[#1e3a5f] dark:border-gray-700 dark:bg-gray-900/40 dark:text-white"
                />
              </div>
            </div>

            <div className="mt-5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold uppercase tracking-wider text-gray-500">대상 매체</label>
                <label className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                  <input type="checkbox" checked={autoEnabled} onChange={(event) => setAutoEnabled(event.target.checked)} />
                  자동발송 활성화
                </label>
              </div>
              <div className="mt-3 rounded-2xl border border-gray-200 bg-gray-50/80 p-4 dark:border-gray-700 dark:bg-gray-900/30">
                {sources.length === 0 ? (
                  <div className="space-y-3">
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      아직 구독된 매체가 없어 외부 메일링용 매체 선택이 비어 있습니다.
                    </p>
                    <button
                      type="button"
                      onClick={() => navigate('/media')}
                      className="inline-flex items-center rounded-xl border border-[#1e3a5f] px-3 py-2 text-sm font-medium text-[#1e3a5f] hover:bg-[#1e3a5f]/5 dark:border-blue-400 dark:text-blue-300"
                    >
                      매체 구독으로 이동
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="mb-3 text-sm font-medium text-gray-700 dark:text-gray-200">
                      선택된 매체 {selectedSourceNames.length}개
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {sources.map((source) => (
                        <button
                          key={source.id}
                          type="button"
                          onClick={() => toggleSource(source.id)}
                          className={`rounded-full border px-3 py-1.5 text-sm transition ${
                            sourceIds.includes(source.id)
                              ? 'border-[#1e3a5f] bg-[#1e3a5f] text-white'
                              : 'border-gray-200 bg-white text-gray-600 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300'
                          }`}
                        >
                          {source.name}
                        </button>
                      ))}
                    </div>
                    <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                      {selectedSourceNames.length > 0
                        ? `현재 선택: ${selectedSourceNames.join(', ')}`
                        : '매체를 하나 이상 선택하면 해당 매체 기사만 기준으로 외부 리포트를 생성합니다.'}
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="mt-5 grid gap-5 md:grid-cols-[1fr_auto] md:items-end">
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-gray-500">예약 발송 시각 (KST)</label>
                <input
                  type="datetime-local"
                  value={reservedAt}
                  onChange={(event) => setReservedAt(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none focus:border-[#1e3a5f] dark:border-gray-700 dark:bg-gray-900/40 dark:text-white"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={saveGroup}
                  disabled={saving}
                  className="inline-flex items-center gap-2 rounded-xl bg-[#1e3a5f] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#24456f] disabled:opacity-50"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  저장
                </button>
                <button
                  onClick={generatePreview}
                  disabled={previewing || sending}
                  className="inline-flex items-center gap-2 rounded-xl border border-[#1e3a5f] bg-white px-4 py-2.5 text-sm font-medium text-[#1e3a5f] hover:bg-[#1e3a5f]/5 disabled:opacity-50 dark:border-blue-400 dark:bg-gray-900/30 dark:text-blue-300"
                >
                  {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                  미리보기 생성
                </button>
                <button
                  onClick={() => requestReport(null)}
                  disabled={sending}
                  className="inline-flex items-center gap-2 rounded-xl border border-[#d4af37] bg-[#d4af37] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#c49e2c] disabled:opacity-50"
                >
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  즉시발송
                </button>
                <button
                  onClick={() => requestReport(reservedAt || null)}
                  disabled={sending || !reservedAt}
                  className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900/30 dark:text-gray-200"
                >
                  <CalendarClock className="h-4 w-4" />
                  예약 발송
                </button>
              </div>
            </div>

            <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
              `즉시발송`은 현재 키워드와 매체 조건으로 외부 리포트를 생성한 뒤 바로 메일까지 발송합니다. 먼저 `미리보기 생성`으로 내용을 확인한 뒤 발송하는 흐름을 권장합니다.
            </div>
            <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              현재 조건: 매체 {selectedSourceNames.length > 0 ? selectedSourceNames.join(', ') : '전체 구독 매체'} / 키워드 {parsedKeywords.length > 0 ? parsedKeywords.join(', ') : '없음'}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200">
                <Mail className="h-4 w-4 text-[#1e3a5f]" />
                수신 예정
              </div>
              <div className="mt-3 text-2xl font-bold text-gray-900 dark:text-white">{parseLines(emailsText).length}</div>
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">현재 입력된 이메일 수</div>
            </div>
            <div className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200">
                <Sparkles className="h-4 w-4 text-[#1e3a5f]" />
                선택 매체
              </div>
              <div className="mt-3 text-2xl font-bold text-gray-900 dark:text-white">{sourceIds.length}</div>
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">현재 그룹에 포함된 매체 수</div>
            </div>
            <div className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200">
                <Clock3 className="h-4 w-4 text-[#1e3a5f]" />
                자동발송
              </div>
              <div className="mt-3 text-2xl font-bold text-gray-900 dark:text-white">{autoEnabled ? autoTimeKst : 'OFF'}</div>
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">자동발송 설정 시각</div>
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
            <div className="mb-4 flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-[#1e3a5f]" />
              <h2 className="font-semibold text-gray-900 dark:text-white">최근 외부 리포트 실행</h2>
            </div>
            <div className="space-y-3">
              {recentRuns.map((run) => (
                <div key={run.id} className="rounded-xl border border-gray-200 px-4 py-3 dark:border-gray-700">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="font-medium text-gray-900 dark:text-white">{run.title || '외부 리포트'}</div>
                      <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        {run.createdAt?.toDate ? format(run.createdAt.toDate(), 'yyyy.MM.dd HH:mm') : '-'} · {run.status || 'pending'}
                        {run.previewOnly ? ' · 미리보기' : ''}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => navigate(`/briefing?outputId=${run.id}`)}
                        className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200"
                      >
                        보기
                      </button>
                      {run.status === 'failed' && (
                        <button
                          onClick={() => retryRun(run.id)}
                          className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200"
                        >
                          다시 실행
                        </button>
                      )}
                    </div>
                  </div>
                  {run.errorMessage && (
                    <div className="mt-2 text-xs text-red-500">{run.errorMessage}</div>
                  )}
                </div>
              ))}
              {recentRuns.length === 0 && (
                <div className="rounded-xl border border-dashed border-gray-300 px-3 py-8 text-center text-sm text-gray-400 dark:border-gray-700">
                  아직 외부 리포트 실행 이력이 없습니다.
                </div>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Eye className="h-4 w-4 text-[#1e3a5f]" />
                <h2 className="font-semibold text-gray-900 dark:text-white">리포트 미리보기</h2>
              </div>
              {previewOutput && (
                <button
                  onClick={() => navigate(`/briefing?outputId=${previewOutput.id}`)}
                  className="inline-flex items-center gap-1 text-sm text-[#1e3a5f] underline dark:text-blue-300"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  브리핑에서 열기
                </button>
              )}
            </div>

            {!previewOutput ? (
              <div className="mt-4 rounded-xl border border-dashed border-gray-300 px-4 py-8 text-sm text-gray-400 dark:border-gray-700">
                아직 생성된 미리보기가 없습니다. 현재 조건으로 `미리보기 생성`을 누르면 외부 메일 본문에 들어갈 리포트를 먼저 확인할 수 있습니다.
              </div>
            ) : previewOutput.status === 'pending' || previewOutput.status === 'processing' ? (
              <div className="mt-4 flex min-h-[220px] items-center justify-center rounded-xl border border-dashed border-gray-300 dark:border-gray-700">
                <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  미리보기 리포트를 생성 중입니다.
                </div>
              </div>
            ) : previewOutput.status === 'failed' ? (
              <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-600 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
                {previewOutput.errorMessage || '미리보기 생성에 실패했습니다.'}
              </div>
            ) : (
              <div className="mt-4">
                <div className="mb-3 text-xs text-gray-500 dark:text-gray-400">
                  {previewOutput.title || '미리보기 리포트'} · 참고 기사 {previewArticles.length}건
                </div>
                <div className="max-h-[720px] overflow-y-auto rounded-xl border border-gray-200 p-4 dark:border-gray-700">
                  {previewHtml ? (
                    <div className="prose max-w-none dark:prose-invert" dangerouslySetInnerHTML={{ __html: previewHtml }} />
                  ) : (
                    <div className="text-sm text-gray-400">생성된 미리보기 HTML이 아직 없습니다.</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
