import { handleError } from "@/utils/errorHandler";
import { useEffect, useMemo, useState } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  documentId,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import {
  AlertCircle,
  CalendarClock,
  ExternalLink,
  Eye,
  Loader2,
  Mail,
  RefreshCw,
  Save,
  Send,
  Sparkles,
  Trash2,
  UserCheck,
  Users,
  UserX,
} from 'lucide-react';
import { db, functions } from '@/lib/firebase';
import { useAuthStore } from '@/store/useAuthStore';
import { fetchSubscribedSources } from '@/lib/sourceSubscriptions';
import { sanitizeReportHtml } from '@/utils/sanitizeHtml';
import { useReportClickHandler } from '@/hooks/useReportClickHandler';
import { ArticlePreviewModal } from '@/components/briefing/ArticlePreviewModal';

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

export default function DeliveryCenter() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const companyId =
    (user as any)?.primaryCompanyId ||
    (user as any)?.companyId ||
    (user as any)?.companyIds?.[0] ||
    null;

  const [activeTab, setActiveTab] = useState<'groups' | 'send'>('groups');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sending, setSending] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [groups, setGroups] = useState<DeliveryGroup[]>([]);
  const [recentRuns, setRecentRuns] = useState<any[]>([]);

  // Group tab form state (수신자만)
  const [selectedId, setSelectedId] = useState<string>('new');
  const [name, setName] = useState('');
  const [emailsText, setEmailsText] = useState('');

  // Send tab state
  const [sendGroupId, setSendGroupId] = useState<string | null>(null);
  const [sendTitle, setSendTitle] = useState('');
  const [sendPrompt, setSendPrompt] = useState('');
  const [sendSourceIds, setSendSourceIds] = useState<string[]>([]);
  const [sendKeywordsText, setSendKeywordsText] = useState('');
  const [sendDatePreset, setSendDatePreset] = useState<DatePreset>('24h');
  const [sendAutoEnabled, setSendAutoEnabled] = useState(true);
  const [sendAutoTimeKst, setSendAutoTimeKst] = useState('08:00');
  const [reservedAt, setReservedAt] = useState('');
  const [useTemplate, setUseTemplate] = useState(false);

  const [message, setMessage] = useState('');
  const [defaultExternalPrompt, setDefaultExternalPrompt] = useState('');
  const [defaultReportTitle, setDefaultReportTitle] = useState('');
  const [externalTemplate, setExternalTemplate] = useState<{ id: string; title: string } | null>(null);

  const [previewRequestId, setPreviewRequestId] = useState<string | null>(null);
  const [previewOutput, setPreviewOutput] = useState<any | null>(null);
  const [previewArticles, setPreviewArticles] = useState<any[]>([]);
  const [previewArticle, setPreviewArticle] = useState<any | null>(null);
  const [unsubscribes, setUnsubscribes] = useState<Record<string, string>>({});
  const [subManageLoading, setSubManageLoading] = useState(false);

  const selectedGroup = useMemo(
    () => groups.find((g) => g.id === selectedId) || null,
    [groups, selectedId],
  );
  const sendGroup = useMemo(
    () => groups.find((g) => g.id === sendGroupId) || null,
    [groups, sendGroupId],
  );
  const sendSourceNames = useMemo(
    () => sources.filter((s) => sendSourceIds.includes(s.id)).map((s) => s.name),
    [sendSourceIds, sources],
  );
  const previewHtml = useMemo(
    () =>
      sanitizeReportHtml(
        previewOutput?.generatedOutput?.htmlContent ||
          previewOutput?.htmlContent ||
          previewOutput?.rawOutput ||
          '',
        previewArticles,
      ),
    [previewArticles, previewOutput],
  );

  const loadUnsubscribes = async () => {
    if (!companyId) return;
    try {
      const snap = await getDocs(collection(db, 'emailUnsubscribes', companyId, 'entries'));
      const map: Record<string, string> = {};
      snap.docs.forEach((d) => {
        const data = d.data();
        const email = (data.email || '').toLowerCase();
        if (email)
          map[email] = data.unsubscribedAt?.toDate
            ? data.unsubscribedAt.toDate().toLocaleString('ko-KR')
            : '구독 취소됨';
      });
      setUnsubscribes(map);
    } catch {
      setUnsubscribes({});
    }
  };

  const loadAll = async () => {
    if (!companyId) return;
    setLoading(true);
    try {
      const [settingsDoc, subDoc] = await Promise.all([
        getDoc(doc(db, 'companySettings', companyId)),
        getDoc(doc(db, 'companySourceSubscriptions', companyId)),
      ]);
      const subscribedIds: string[] = subDoc.exists()
        ? ((subDoc.data() as any).subscribedSourceIds || [])
        : [];
      const companySettings = settingsDoc.exists() ? (settingsDoc.data() as any) : {};
      const externalPrompt = `${companySettings.reportPrompts?.external || ''}`.trim();
      setDefaultExternalPrompt(externalPrompt);
      setDefaultReportTitle('이음M&A NEWS');

      const externalTemplateId = companySettings?.styleTemplates?.external;
      if (externalTemplateId) {
        getDoc(doc(db, 'outputs', externalTemplateId))
          .then((snap) => {
            if (snap.exists()) {
              const output = snap.data() as any;
              setExternalTemplate({ id: externalTemplateId, title: output.title || '스타일 템플릿' });
              setUseTemplate(true);
            }
          })
          .catch(handleError);
      } else {
        setExternalTemplate(null);
        setUseTemplate(false);
      }

      const [sourceSnap, groupSnap, outputSnap] = await Promise.all([
        Promise.resolve(await fetchSubscribedSources(companyId)),
        getDocs(query(collection(db, 'distributionGroups'), where('companyId', '==', companyId))),
        getDocs(
          query(
            collection(db, 'outputs'),
            where('companyId', '==', companyId),
            orderBy('createdAt', 'desc'),
            limit(10),
          ),
        ),
      ]);

      const availableSources = sourceSnap
        .filter((item) => subscribedIds.includes(item.id))
        .map((item) => ({ id: item.id, name: item.name }));

      setSources(availableSources);
      setGroups(
        groupSnap.docs
          .map((item) => ({ id: item.id, ...(item.data() as any) } as DeliveryGroup))
          .sort((a, b) => {
            const at = a.updatedAt?.toDate ? a.updatedAt.toDate().getTime() : 0;
            const bt = b.updatedAt?.toDate ? b.updatedAt.toDate().getTime() : 0;
            return bt - at;
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
    await loadUnsubscribes();
  };

  useEffect(() => {
    loadAll().catch(handleError);
  }, [companyId]);

  // 그룹 탭: 선택된 그룹에서 이름+이메일만 로드
  useEffect(() => {
    if (!selectedGroup) {
      setName('');
      setEmailsText('');
      return;
    }
    setName(selectedGroup.name || '');
    setEmailsText((selectedGroup.emails || []).join('\n'));
  }, [selectedGroup]);

  // 발송 탭: 선택된 그룹에서 발송 설정 로드
  useEffect(() => {
    if (!sendGroup) return;
    setSendTitle(sendGroup.reportTitle || defaultReportTitle);
    setSendPrompt(sendGroup.prompt || defaultExternalPrompt);
    setSendSourceIds(sendGroup.sourceIds || []);
    setSendKeywordsText((sendGroup.keywords || []).join(', '));
    setSendDatePreset(sendGroup.datePreset || '24h');
    setSendAutoEnabled(Boolean(sendGroup.autoEnabled));
    setSendAutoTimeKst(sendGroup.autoTimeKst || '08:00');
  }, [sendGroupId, defaultExternalPrompt, defaultReportTitle]);

  useEffect(() => {
    if (!previewRequestId) return undefined;
    const unsubscribe = onSnapshot(doc(db, 'outputs', previewRequestId), async (snap) => {
      if (!snap.exists()) return;
      let output = { id: snap.id, ...(snap.data() as any) };
      if (output.generatedOutputId) {
        const generatedDoc = await getDoc(doc(db, 'outputs', output.generatedOutputId));
        if (generatedDoc.exists()) {
          output = { ...output, generatedOutput: { id: generatedDoc.id, ...(generatedDoc.data() as any) } };
        }
      }
      setPreviewOutput(output);
      const effectiveArticleIds: string[] =
        output.generatedOutput?.orderedArticleIds ||
        output.orderedArticleIds ||
        output.generatedOutput?.articleIds ||
        output.articleIds ||
        [];
      if (effectiveArticleIds.length > 0) {
        const chunks: string[][] = [];
        for (let i = 0; i < effectiveArticleIds.length; i += 10) chunks.push(effectiveArticleIds.slice(i, i + 10));
        const snaps = await Promise.all(
          chunks.map((chunk) => getDocs(query(collection(db, 'articles'), where(documentId(), 'in', chunk)))),
        );
        const articleMap = new Map<string, any>();
        snaps.forEach((s) => s.docs.forEach((d) => articleMap.set(d.id, { id: d.id, ...(d.data() as any) })));
        setPreviewArticles(effectiveArticleIds.map((id) => articleMap.get(id)).filter(Boolean));
      } else {
        setPreviewArticles([]);
      }
    });
    return () => unsubscribe();
  }, [previewRequestId]);

  const handleReportClick = useReportClickHandler(previewArticles, setPreviewArticle);

  const toggleSendSource = (sourceId: string) => {
    setSendSourceIds((prev) =>
      prev.includes(sourceId) ? prev.filter((item) => item !== sourceId) : [...prev, sourceId],
    );
  };

  const selectGroup = (group: DeliveryGroup) => {
    setSendGroupId(group.id);
    setPreviewOutput(null);
    setPreviewRequestId(null);
    setPreviewArticles([]);
    setReservedAt('');
    setMessage('');
  };

  const deleteGroup = async (groupId: string) => {
    if (!window.confirm('이 그룹을 삭제하시겠습니까?')) return;
    setDeleting(true);
    setMessage('');
    try {
      await deleteDoc(doc(db, 'distributionGroups', groupId));
      if (selectedId === groupId) setSelectedId('new');
      if (sendGroupId === groupId) setSendGroupId(null);
      setMessage('그룹을 삭제했습니다.');
      await loadAll();
    } catch (err: any) {
      setMessage(`삭제 실패: ${err.message || '알 수 없는 오류'}`);
    } finally {
      setDeleting(false);
    }
  };

  // 그룹 저장: 이름 + 이메일만
  const saveGroup = async () => {
    if (!companyId) {
      setMessage('회사 정보를 불러올 수 없습니다. 새로고침해 주세요.');
      return;
    }
    if (!name.trim()) {
      setMessage('그룹 이름을 입력해 주세요.');
      return;
    }
    setSaving(true);
    setMessage('');
    try {
      const targetRef =
        selectedId !== 'new'
          ? doc(db, 'distributionGroups', selectedId)
          : doc(collection(db, 'distributionGroups'));
      const payload: any = {
        companyId,
        name: name.trim(),
        emails: parseLines(emailsText),
        active: true,
        updatedAt: serverTimestamp(),
      };
      if (selectedId === 'new') payload.createdAt = serverTimestamp();
      await setDoc(targetRef, payload, { merge: true });
      setSelectedId(targetRef.id);
      setMessage('메일링 그룹을 저장했습니다.');
    } catch (err: any) {
      console.error('Failed to save group:', err);
      setMessage(`저장 실패: ${err.message || '알 수 없는 오류'}`);
    } finally {
      setSaving(false);
    }
    loadAll().catch(handleError);
  };

  // 발송 설정을 그룹 기본값으로 저장
  const saveGroupDefaults = async () => {
    if (!companyId || !sendGroup) return;
    setSavingDefaults(true);
    setMessage('');
    try {
      await setDoc(
        doc(db, 'distributionGroups', sendGroup.id),
        {
          companyId,
          sourceIds: sendSourceIds,
          sourceNames: sendSourceNames,
          keywords: parseLines(sendKeywordsText),
          datePreset: sendDatePreset,
          prompt: sendPrompt.trim(),
          reportTitle: sendTitle.trim(),
          autoEnabled: sendAutoEnabled,
          autoTimeKst: sendAutoTimeKst,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      setMessage('발송 설정을 그룹 기본값으로 저장했습니다.');
    } catch (err: any) {
      setMessage(`저장 실패: ${err.message || '알 수 없는 오류'}`);
    } finally {
      setSavingDefaults(false);
    }
    loadAll().catch(handleError);
  };

  const requestReport = async (scheduledAt?: string | null) => {
    if (!companyId || !sendGroup) return;
    setSending(true);
    setMessage('');
    try {
      const fn = httpsCallable(functions, 'requestManagedReport');
      await fn({
        companyId,
        mode: 'external',
        reportTitle: sendTitle.trim() || sendGroup.name,
        prompt: sendPrompt.trim(),
        filters: {
          sourceIds: sendSourceIds,
          keywords: parseLines(sendKeywordsText),
          datePreset: sendDatePreset,
        },
        distributionGroupId: sendGroup.id,
        distributionGroupName: sendGroup.name,
        recipients: sendGroup.emails,
        sendNow: !scheduledAt,
        scheduledAt: scheduledAt || null,
        sourceNames: sendSourceNames,
        templateOutputId: useTemplate && externalTemplate ? externalTemplate.id : null,
      });
      setMessage(scheduledAt ? '예약 발송을 등록했습니다.' : '외부 메일 리포트 생성과 즉시 발송을 시작했습니다.');
      await loadAll();
    } catch (err: any) {
      console.error('Failed to request report:', err);
      setMessage(`요청 실패: ${err.message || '알 수 없는 오류'}`);
    } finally {
      setSending(false);
    }
  };

  const generatePreview = async () => {
    if (!companyId || !sendGroup) return;
    setPreviewing(true);
    setMessage('');
    try {
      const fn = httpsCallable(functions, 'requestManagedReport');
      const result = (await fn({
        companyId,
        mode: 'external',
        reportTitle: sendTitle.trim() || sendGroup.name,
        prompt: sendPrompt.trim(),
        filters: {
          sourceIds: sendSourceIds,
          keywords: parseLines(sendKeywordsText),
          datePreset: sendDatePreset,
        },
        distributionGroupId: sendGroup.id,
        distributionGroupName: sendGroup.name,
        recipients: [],
        sendNow: false,
        scheduledAt: null,
        sourceNames: sendSourceNames,
        previewOnly: true,
        templateOutputId: useTemplate && externalTemplate ? externalTemplate.id : null,
      })) as any;
      setPreviewRequestId(result.data?.outputId || null);
      setMessage('미리보기 리포트 생성을 시작했습니다. 완료되면 아래 미리보기 영역에 표시됩니다.');
      await loadAll();
    } catch (err: any) {
      console.error('Failed to generate preview:', err);
      setMessage(`미리보기 요청 실패: ${err.message || '알 수 없는 오류'}`);
    } finally {
      setPreviewing(false);
    }
  };

  const retryRun = async (outputId: string) => {
    try {
      const fn = httpsCallable(functions, 'retryManagedReport');
      await fn({ outputId });
      setMessage('실패한 외부 리포트를 다시 실행했습니다.');
      await loadAll();
    } catch (err: any) {
      setMessage(`재실행 요청 실패: ${err.message || '알 수 없는 오류'}`);
    }
  };

  const toggleSubscription = async (email: string, action: 'subscribe' | 'unsubscribe') => {
    setSubManageLoading(true);
    try {
      const fn = httpsCallable(functions, 'manageEmailSubscription');
      await fn({ email, companyId, action });
      await loadUnsubscribes();
    } catch (err: any) {
      setMessage(`구독 변경 실패: ${err?.message || '알 수 없는 오류'}`);
    } finally {
      setSubManageLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-[#1e3a5f] dark:text-gray-400" />
      </div>
    );
  }

  const FIELD =
    'w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none transition focus:border-[#1e3a5f] focus:ring-1 focus:ring-[#1e3a5f]/20 dark:border-gray-700/60 dark:bg-gray-900/40 dark:text-white dark:focus:border-blue-400';

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-12">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 border-b border-gray-200 pb-5 dark:border-gray-700/60">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">외부 메일링 센터</h1>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            수신자 그룹을 관리하고, 그룹을 선택해 AI 리포트를 발송하세요.
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

      {/* Tab navigation */}
      <div className="flex gap-1 rounded-xl border border-gray-200 bg-gray-50 p-1 dark:border-gray-700/60 dark:bg-gray-800/40">
        {([
          { key: 'groups' as const, label: '그룹 관리', Icon: Users },
          { key: 'send' as const, label: '메일 발송', Icon: Send },
        ] as const).map(({ key, label, Icon }) => (
          <button
            key={key}
            onClick={() => { setActiveTab(key); setMessage(''); }}
            className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-semibold transition ${
              activeTab === key
                ? 'bg-white text-[#1e3a5f] shadow-sm dark:bg-gray-700 dark:text-white'
                : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
            {key === 'send' && groups.length > 0 && (
              <span className="rounded-full bg-[#1e3a5f]/10 px-1.5 py-0.5 text-[10px] font-bold text-[#1e3a5f] dark:bg-blue-500/20 dark:text-blue-300">
                {groups.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {message && (
        <div className="rounded-lg border border-[#1e3a5f]/20 bg-[#1e3a5f]/5 px-4 py-3 text-xs text-[#1e3a5f] dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-300">
          {message}
        </div>
      )}

      {/* ── Tab 1: 그룹 관리 (수신자 그룹만) ── */}
      {activeTab === 'groups' && (
        <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
          {/* Sidebar */}
          <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-700/40">
              <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">메일링 그룹</span>
              <button
                onClick={() => setSelectedId('new')}
                className="text-xs font-semibold text-[#1e3a5f] hover:underline dark:text-blue-300"
              >
                새 그룹
              </button>
            </div>
            <div className="space-y-1 p-2">
              {groups.map((group) => (
                <button
                  key={group.id}
                  onClick={() => setSelectedId(group.id)}
                  className={`w-full rounded-lg px-3 py-2.5 text-left transition ${
                    selectedId === group.id
                      ? 'bg-[#1e3a5f]/8 text-[#1e3a5f] dark:bg-blue-500/10 dark:text-blue-300'
                      : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/5'
                  }`}
                >
                  <div className="text-sm font-medium">{group.name}</div>
                  <div className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">
                    {group.emails?.length || 0}명
                  </div>
                </button>
              ))}
              {groups.length === 0 && (
                <div className="px-3 py-8 text-center text-xs text-gray-400">
                  저장된 메일링 그룹이 없습니다.
                </div>
              )}
            </div>
          </div>

          {/* Group form — 이름 + 이메일만 */}
          <div className="space-y-5">
            <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
              <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-700/40">
                <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">
                  {selectedId === 'new' ? '새 그룹 만들기' : '그룹 편집'}
                </span>
                {selectedId !== 'new' && (
                  <button
                    onClick={() => deleteGroup(selectedId)}
                    disabled={deleting}
                    className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-700 disabled:opacity-50"
                  >
                    {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                    삭제
                  </button>
                )}
              </div>
              <div className="space-y-4 p-4">
                <div>
                  <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">그룹 이름</label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className={FIELD}
                    placeholder="예: 데일리 PE 메일링"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                    수신 이메일
                  </label>
                  <p className="mb-2 text-[11px] text-gray-400">한 줄에 이메일 하나씩 입력하세요.</p>
                  <textarea
                    value={emailsText}
                    onChange={(e) => setEmailsText(e.target.value)}
                    rows={8}
                    className={FIELD}
                    placeholder={'ceo@company.com\nir@company.com\nanalyst@fund.com'}
                  />
                  <p className="mt-1 text-[11px] text-gray-400">
                    현재 {parseLines(emailsText).length}개 이메일
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    onClick={saveGroup}
                    disabled={saving}
                    className="inline-flex items-center gap-2 rounded-xl bg-[#1e3a5f] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#24456f] disabled:opacity-50"
                  >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    {selectedId === 'new' ? '그룹 저장' : '저장'}
                  </button>
                  {selectedId !== 'new' && selectedGroup && (
                    <button
                      onClick={() => {
                        selectGroup(selectedGroup);
                        setActiveTab('send');
                      }}
                      className="inline-flex items-center gap-2 rounded-xl border border-[#1e3a5f] bg-white px-5 py-2.5 text-sm font-semibold text-[#1e3a5f] hover:bg-[#1e3a5f]/5 dark:border-blue-400 dark:bg-transparent dark:text-blue-300"
                    >
                      <Send className="h-4 w-4" />
                      이 그룹으로 발송
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Email count stat */}
            <div className="grid gap-3 md:grid-cols-2">
              {[
                { Icon: Mail, label: '수신 예정', value: parseLines(emailsText).length.toString(), sub: '현재 입력된 이메일 수' },
                { Icon: Users, label: '전체 그룹', value: groups.length.toString(), sub: '등록된 메일링 그룹 수' },
              ].map((stat) => (
                <div key={stat.label} className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700/60 dark:bg-gray-800/60">
                  <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <stat.Icon className="h-3.5 w-3.5" />{stat.label}
                  </div>
                  <p className="mt-2 text-2xl font-bold tabular-nums text-[#1e3a5f] dark:text-blue-400">{stat.value}</p>
                  <p className="mt-0.5 text-[11px] text-gray-400">{stat.sub}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Tab 2: 메일 발송 ── */}
      {activeTab === 'send' && (
        <div className="space-y-5">
          {/* Group selector cards */}
          <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
            <div className="border-b border-gray-100 px-4 py-3 dark:border-gray-700/40">
              <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">발송 그룹 선택</span>
              <p className="mt-1 text-[11px] text-gray-400">
                발송할 수신자 그룹을 선택하세요.
              </p>
            </div>
            {groups.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <Users className="mx-auto mb-2 h-5 w-5 text-gray-300 dark:text-gray-600" />
                <p className="text-xs text-gray-400">그룹 관리 탭에서 먼저 메일링 그룹을 만들어 주세요.</p>
                <button
                  onClick={() => setActiveTab('groups')}
                  className="mt-3 text-xs font-semibold text-[#1e3a5f] hover:underline dark:text-blue-300"
                >
                  그룹 만들기 →
                </button>
              </div>
            ) : (
              <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
                {groups.map((group) => (
                  <button
                    key={group.id}
                    onClick={() => selectGroup(group)}
                    className={`rounded-xl border p-4 text-left transition ${
                      sendGroupId === group.id
                        ? 'border-[#1e3a5f] bg-[#1e3a5f]/5 ring-1 ring-[#1e3a5f]/20 dark:border-blue-400 dark:bg-blue-500/10'
                        : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700/60 dark:bg-gray-800/40 dark:hover:bg-white/5'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-semibold text-gray-900 dark:text-white">{group.name}</p>
                      {sendGroupId === group.id && (
                        <span className="shrink-0 rounded-full bg-[#1e3a5f] px-2 py-0.5 text-[10px] font-bold text-white">선택됨</span>
                      )}
                    </div>
                    <div className="mt-2 flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
                      <Mail className="h-3 w-3" />{group.emails?.length || 0}명
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Send config — only when group selected */}
          {sendGroup && (
            <>
              {/* 콘텐츠 설정 */}
              <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
                <div className="border-b border-gray-100 px-4 py-3 dark:border-gray-700/40">
                  <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">콘텐츠 설정</span>
                  <p className="mt-1 text-[11px] text-gray-400">
                    어떤 기사로, 어떻게 리포트를 만들지 설정하세요.
                  </p>
                </div>
                <div className="space-y-4 p-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">리포트 제목</label>
                      <input
                        value={sendTitle}
                        onChange={(e) => setSendTitle(e.target.value)}
                        className={FIELD}
                        placeholder="이음M&A NEWS"
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">키워드</label>
                      <input
                        value={sendKeywordsText}
                        onChange={(e) => setSendKeywordsText(e.target.value)}
                        className={FIELD}
                        placeholder="PE, 인수금융, 구조조정"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">AI 분석 지시</label>
                    <textarea
                      value={sendPrompt}
                      onChange={(e) => setSendPrompt(e.target.value)}
                      rows={3}
                      className={FIELD}
                      placeholder="예: PE 관점에서 핵심 포인트와 체크포인트만 간결하게 정리"
                    />
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">기사 기간</label>
                      <select
                        value={sendDatePreset}
                        onChange={(e) => setSendDatePreset(e.target.value as DatePreset)}
                        className={FIELD}
                      >
                        {DATE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">자동발송 시간 (KST)</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="time"
                          value={sendAutoTimeKst}
                          onChange={(e) => setSendAutoTimeKst(e.target.value)}
                          disabled={!sendAutoEnabled}
                          className={`${FIELD} disabled:opacity-50`}
                        />
                        <label className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
                          <input
                            type="checkbox"
                            checked={sendAutoEnabled}
                            onChange={(e) => setSendAutoEnabled(e.target.checked)}
                          />
                          활성화
                        </label>
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <label className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">대상 매체</label>
                      <span className="text-[11px] text-gray-400">선택 {sendSourceIds.length}개</span>
                    </div>
                    <div className="rounded-lg border border-gray-100 bg-gray-50/60 p-3 dark:border-gray-700/40 dark:bg-white/5">
                      {sources.length === 0 ? (
                        <div className="flex items-center gap-4">
                          <p className="text-xs text-gray-500 dark:text-gray-400">아직 구독된 매체가 없습니다.</p>
                          <button
                            type="button"
                            onClick={() => navigate('/media')}
                            className="shrink-0 rounded-lg border border-[#1e3a5f] px-3 py-1.5 text-xs font-medium text-[#1e3a5f] hover:bg-[#1e3a5f]/5 dark:border-blue-400 dark:text-blue-300"
                          >
                            매체 구독으로 이동
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {sources.map((source) => (
                            <button
                              key={source.id}
                              type="button"
                              onClick={() => toggleSendSource(source.id)}
                              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
                                sendSourceIds.includes(source.id)
                                  ? 'border-[#1e3a5f] bg-[#1e3a5f] text-white'
                                  : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 dark:border-gray-700/60 dark:bg-gray-800 dark:text-gray-300'
                              }`}
                            >
                              {source.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {externalTemplate && (
                    <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                      <input
                        type="checkbox"
                        checked={useTemplate}
                        onChange={(e) => setUseTemplate(e.target.checked)}
                        className="rounded accent-[#d4af37]"
                      />
                      <Sparkles className="h-3 w-3 shrink-0 text-amber-500" />
                      스타일 템플릿 적용: <span className="truncate font-medium">{externalTemplate.title}</span>
                    </label>
                  )}

                  <button
                    onClick={saveGroupDefaults}
                    disabled={savingDefaults}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 disabled:opacity-50 dark:text-gray-400 dark:hover:text-gray-200"
                  >
                    {savingDefaults ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                    이 설정을 그룹 기본값으로 저장
                  </button>
                </div>
              </div>

              {/* 발송 */}
              <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
                <div className="border-b border-gray-100 px-4 py-3 dark:border-gray-700/40">
                  <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">발송</span>
                  <p className="mt-1 text-[11px] text-gray-400">
                    {sendGroup.name} · 수신자 {sendGroup.emails?.length || 0}명
                  </p>
                </div>
                <div className="space-y-4 p-4">
                  <div>
                    <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">예약 발송 시각 (KST)</label>
                    <input
                      type="datetime-local"
                      value={reservedAt}
                      onChange={(e) => setReservedAt(e.target.value)}
                      className={FIELD}
                    />
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={generatePreview}
                      disabled={previewing || sending}
                      className="inline-flex items-center gap-2 rounded-xl border border-[#1e3a5f] bg-white px-4 py-2.5 text-sm font-semibold text-[#1e3a5f] hover:bg-[#1e3a5f]/5 disabled:opacity-50 dark:border-blue-400 dark:bg-transparent dark:text-blue-300"
                    >
                      {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}미리보기
                    </button>
                    <button
                      onClick={() => requestReport(null)}
                      disabled={sending || previewing}
                      className="inline-flex items-center gap-2 rounded-xl bg-[#d4af37] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#c49e2c] disabled:opacity-50"
                    >
                      {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}즉시 발송
                    </button>
                    <button
                      onClick={() => requestReport(reservedAt || null)}
                      disabled={sending || previewing || !reservedAt}
                      className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700/60 dark:bg-transparent dark:text-gray-200"
                    >
                      <CalendarClock className="h-4 w-4" />예약 발송
                    </button>
                  </div>
                </div>
              </div>

              {/* Preview panel */}
              <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
                <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-700/40">
                  <div className="flex items-center gap-2">
                    <Eye className="h-3.5 w-3.5 text-[#1e3a5f] dark:text-blue-400" />
                    <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">리포트 미리보기</span>
                  </div>
                  {previewOutput && (
                    <button
                      onClick={() => navigate(`/briefing?outputId=${previewOutput.id}`)}
                      className="inline-flex items-center gap-1 text-xs text-[#1e3a5f] hover:underline dark:text-blue-300"
                    >
                      <ExternalLink className="h-3 w-3" />브리핑에서 열기
                    </button>
                  )}
                </div>
                <div className="p-4">
                  {!previewOutput ? (
                    <div className="rounded-lg border border-dashed border-gray-200 px-4 py-8 text-xs text-gray-400 dark:border-gray-700/60">
                      미리보기 버튼을 누르면 외부 메일 본문에 들어갈 리포트를 먼저 확인할 수 있습니다.
                    </div>
                  ) : previewOutput.status === 'pending' || previewOutput.status === 'processing' ? (
                    <div className="flex min-h-[200px] items-center justify-center rounded-lg border border-dashed border-gray-200 dark:border-gray-700/60">
                      <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                        <Loader2 className="h-4 w-4 animate-spin" />미리보기 리포트를 생성 중입니다.
                      </div>
                    </div>
                  ) : previewOutput.status === 'failed' ? (
                    <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-600 dark:border-red-900/40 dark:bg-red-500/10 dark:text-red-400">
                      {previewOutput.errorMessage || '미리보기 생성에 실패했습니다.'}
                    </div>
                  ) : (
                    <div>
                      <p className="mb-3 text-[11px] text-gray-400">{previewOutput.title || '미리보기 리포트'} · 참고 기사 {previewArticles.length}건</p>
                      <div className="max-h-[720px] overflow-y-auto rounded-lg border border-gray-200 p-4 dark:border-gray-700/60">
                        {previewHtml ? (
                          <div className="prose max-w-none dark:prose-invert" dangerouslySetInnerHTML={{ __html: previewHtml }} onClick={handleReportClick} />
                        ) : (
                          <p className="text-xs text-gray-400">생성된 미리보기 HTML이 아직 없습니다.</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Always visible: Subscription management ── */}
      {(() => {
        const allEmails = Array.from(new Set(groups.flatMap((g) => g.emails || []).map((e) => e.toLowerCase())));
        if (allEmails.length === 0)
          return (
            <div className="rounded-xl border border-dashed border-gray-200 p-5 text-center dark:border-gray-700/60">
              <Mail className="mx-auto mb-2 h-5 w-5 text-gray-300 dark:text-gray-600" />
              <p className="text-xs text-gray-400">그룹을 저장하면 수신자 구독 관리 목록이 여기에 표시됩니다.</p>
            </div>
          );
        return (
          <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
            <div className="border-b border-gray-100 px-4 py-3 dark:border-gray-700/40">
              <div className="flex items-center gap-2">
                <Mail className="h-3.5 w-3.5 text-[#1e3a5f] dark:text-blue-400" />
                <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">구독 관리</span>
              </div>
              <p className="mt-1 text-[11px] text-gray-400">
                수신자가 이메일 하단의 <strong>구독 취소</strong> 링크를 클릭하면 자동으로 목록에서 제외됩니다. 관리자도 아래에서 직접 토글할 수 있습니다.
              </p>
            </div>
            <ul className="divide-y divide-gray-100 dark:divide-gray-700/40">
              {allEmails.map((email) => {
                const unsubInfo = unsubscribes[email];
                const isUnsubscribed = Boolean(unsubInfo);
                return (
                  <li key={email} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <p className={`truncate text-sm font-medium ${isUnsubscribed ? 'text-gray-400 line-through dark:text-gray-500' : 'text-gray-800 dark:text-gray-200'}`}>{email}</p>
                      {isUnsubscribed && <p className="mt-0.5 text-[11px] text-red-400">{unsubInfo}</p>}
                    </div>
                    <button
                      type="button"
                      disabled={subManageLoading}
                      onClick={() => toggleSubscription(email, isUnsubscribed ? 'subscribe' : 'unsubscribe')}
                      className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition disabled:opacity-50 ${
                        isUnsubscribed
                          ? 'border-green-200 bg-green-50 text-green-700 hover:bg-green-100 dark:border-green-500/30 dark:bg-green-500/10 dark:text-green-400'
                          : 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400'
                      }`}
                    >
                      {isUnsubscribed ? <><UserCheck className="h-3 w-3" />재구독</> : <><UserX className="h-3 w-3" />구독 취소</>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })()}

      {/* ── Always visible: Recent runs ── */}
      <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
        <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3 dark:border-gray-700/40">
          <AlertCircle className="h-3.5 w-3.5 text-[#1e3a5f] dark:text-blue-400" />
          <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">최근 외부 리포트 실행</span>
        </div>
        <ul className="divide-y divide-gray-100 dark:divide-gray-700/40">
          {recentRuns.map((run) => (
            <li key={run.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-white">{run.title || '외부 리포트'}</p>
                  <p className="mt-0.5 text-[11px] text-gray-400">
                    {run.createdAt?.toDate ? format(run.createdAt.toDate(), 'yyyy.MM.dd HH:mm') : '—'} · {run.status || 'pending'}
                    {run.previewOnly ? ' · 미리보기' : ''}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => navigate(`/briefing?outputId=${run.id}`)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700/60 dark:text-gray-300 dark:hover:bg-white/5">보기</button>
                  {run.status === 'failed' && (
                    <button onClick={() => retryRun(run.id)} className="rounded-lg border border-amber-200 px-3 py-1.5 text-xs font-medium text-amber-600 hover:bg-amber-50 dark:border-amber-500/30 dark:text-amber-400 dark:hover:bg-amber-500/10">다시 실행</button>
                  )}
                </div>
              </div>
              {run.errorMessage && <p className="mt-1.5 text-[11px] text-red-500">{run.errorMessage}</p>}
            </li>
          ))}
          {recentRuns.length === 0 && (
            <li className="px-4 py-10 text-center text-xs text-gray-400">아직 외부 리포트 실행 이력이 없습니다.</li>
          )}
        </ul>
      </div>

      <ArticlePreviewModal article={previewArticle} onClose={() => setPreviewArticle(null)} />
    </div>
  );
}
