import { handleError } from "@/utils/errorHandler";
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Clock3,
  Copy,
  Download,
  Edit3,
  ExternalLink,
  Link2,
  Loader2,
  Mail,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import { collection, doc, documentId, getDoc, getDocs, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import { db, functions } from '@/lib/firebase';
import { useAuthStore } from '@/store/useAuthStore';
import { formatArticleContentParagraphs } from '@/lib/articleContent';
import { sanitizeReportHtml } from '@/utils/sanitizeHtml';

// URL로 articles 배열에서 article ID를 찾는 헬퍼
function resolveArticleIdByUrl(href: string, articles: any[]): string | null {
  if (!href || !articles.length) return null;
  try {
    const targetUrl = new URL(href);
    const targetPath = targetUrl.pathname;
    // Don't match blindly on just '/' unless the domain and everything perfectly matches
    if (targetPath === '/' && href.length < 15) return null;
    
    const match = articles.find((a) => {
      if (!a.url) return false;
      // Exact match is always safest
      if (a.url === href) return true;
      try { 
        const aUrl = new URL(a.url);
        // If they have meaningful paths, compare them. If not, require domain match too.
        if (targetPath !== '/' && aUrl.pathname === targetPath) return true;
        if (aUrl.hostname === targetUrl.hostname && aUrl.pathname === targetPath && aUrl.search === targetUrl.search) return true;
        return false;
      }
      catch { return a.url === href; }
    });
    return match?.id || null;
  } catch {
    return articles.find((a) => a.url === href)?.id || null;
  }
}

// 헤드라인 텍스트로 articles 배열에서 article ID를 찾는 헬퍼 (AI 재번호 매기기 대응)
function resolveArticleIdByHeadline(text: string, articles: any[]): string | null {
  if (!text || !articles.length) return null;
  // Remove all whitespace and punctuation for robust matching
  const normalize = (s: string) => s.replace(/[\s\p{P}]/gu, '').toLowerCase();
  
  const normalized = normalize(text);
  if (!normalized) return null;

  const exact = articles.find((a) => normalize(a.title || '') === normalized);
  if (exact) return exact.id || null;
  
  if (normalized.length < 2) return null;
  
  let bestMatch = null;
  let maxOverlap = 0;
  for (const a of articles) {
    const t = normalize(a.title || '');
    if (!t) continue;
    
    if (t.includes(normalized) || normalized.includes(t)) {
      const ratio = Math.min(t.length, normalized.length) / Math.max(t.length, normalized.length);
      if (ratio > maxOverlap) {
        maxOverlap = ratio;
        bestMatch = a;
      }
    } else {
      let matchCount = 0;
      const getBigrams = (str: string) => {
        const bigrams = new Set<string>();
        for (let i = 0; i < str.length - 1; i++) bigrams.add(str.slice(i, i + 2));
        return bigrams;
      };
      
      const bigrams1 = getBigrams(normalized);
      const bigrams2 = getBigrams(t);
      if (bigrams1.size === 0 || bigrams2.size === 0) continue;
      
      let intersection = 0;
      for (const b of bigrams1) {
        if (bigrams2.has(b)) intersection++;
      }
      
      const diceCoefficient = (2.0 * intersection) / (bigrams1.size + bigrams2.size);
      if (diceCoefficient > maxOverlap) {
        maxOverlap = diceCoefficient;
        bestMatch = a;
      }
    }
  }
  // Lower threshold to 0.2 to catch heavily shortened AI titles
  if (bestMatch && maxOverlap >= 0.2) return bestMatch.id || null;
  return null;
}

function formatArticleDate(value: any) {
  if (!value) return '';

  try {
    if (typeof value?.toDate === 'function') {
      return format(value.toDate(), 'yyyy.MM.dd HH:mm');
    }

    const converted = new Date(value);
    if (Number.isNaN(converted.getTime())) return '';
    return format(converted, 'yyyy.MM.dd HH:mm');
  } catch {
    return '';
  }
}

export default function Briefing() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const companyId = (user as any)?.primaryCompanyId || null;
  const isAdmin = ['company_admin', 'superadmin'].includes((user as any)?.role);

  const [outputs, setOutputs] = useState<any[]>([]);
  const [selectedOutput, setSelectedOutput] = useState<any | null>(null);
  const [articles, setArticles] = useState<any[]>([]);
  const [previewArticle, setPreviewArticle] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [downloadingFormat, setDownloadingFormat] = useState<'pdf' | 'html' | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [regenModalOpen, setRegenModalOpen] = useState(false);
  const [regenPrompt, setRegenPrompt] = useState('');
  const [regenerating, setRegenerating] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const editRef = useRef<HTMLDivElement>(null);
  const [currentTemplates, setCurrentTemplates] = useState<{ internal?: string; external?: string }>({});
  const [settingTemplate, setSettingTemplate] = useState(false);

  // 이메일 발송 모달
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [distGroups, setDistGroups] = useState<any[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [unsubscribes, setUnsubscribes] = useState<Set<string>>(new Set());
  const [emailSendStatus, setEmailSendStatus] = useState<string>('');

  const loadOutputs = async () => {
    if (!companyId) return;
    setLoading(true);
    try {
      const snap = await getDocs(
        query(collection(db, 'outputs'), where('companyId', '==', companyId), orderBy('createdAt', 'desc'), limit(20)),
      );
      setOutputs(
        snap.docs
          .map((item) => ({ id: item.id, ...(item.data() as any) }))
          .filter((item) => !item.parentRequestId),
      );
    } finally {
      setLoading(false);
    }
  };

  const loadOutputDetail = async (outputId: string) => {
    const outputDoc = await getDoc(doc(db, 'outputs', outputId));
    if (!outputDoc.exists()) return;

    let output = { id: outputDoc.id, ...(outputDoc.data() as any) };
    if (output.generatedOutputId) {
      const generatedDoc = await getDoc(doc(db, 'outputs', output.generatedOutputId));
      if (generatedDoc.exists()) {
        output = {
          ...output,
          generatedOutputId: generatedDoc.id,
          generatedOutput: { id: generatedDoc.id, ...(generatedDoc.data() as any) },
        };
      }
    }

    setSelectedOutput(output);
    setShareUrl(output.generatedOutput?.shareUrl || output.shareUrl || '');

    // orderedArticleIds: GLM에 전달된 실제 순서 (각주 [1],[2],... 와 1:1 대응)
    // articleIds는 원래 선택 순서라 각주 번호와 불일치 → orderedArticleIds 우선 사용
    const effectiveArticleIds: string[] = output.generatedOutput?.orderedArticleIds || output.orderedArticleIds
      || output.generatedOutput?.articleIds || output.articleIds || [];
    if (effectiveArticleIds.length > 0) {
      const chunks: string[][] = [];
      for (let i = 0; i < effectiveArticleIds.length; i += 30) {
        chunks.push(effectiveArticleIds.slice(i, i + 30));
      }
      const snaps = await Promise.all(
        chunks.map((chunk) => getDocs(query(collection(db, 'articles'), where(documentId(), 'in', chunk))))
      );
      const articleMap = new Map<string, any>();
      snaps.forEach((snap) => snap.docs.forEach((d) => articleMap.set(d.id, { id: d.id, ...(d.data() as any) })));
      setArticles(effectiveArticleIds.map((id) => articleMap.get(id)).filter(Boolean));
    } else {
      setArticles([]);
    }
  };

  useEffect(() => {
    loadOutputs().catch(handleError);
  }, [companyId]);

  useEffect(() => {
    if (!companyId) return;
    getDoc(doc(db, 'companySettings', companyId))
      .then((snap) => {
        if (snap.exists()) setCurrentTemplates((snap.data() as any)?.styleTemplates || {});
      })
      .catch(handleError);
  }, [companyId]);

  useEffect(() => {
    const outputId = searchParams.get('outputId');
    if (outputId) {
      setEditMode(false);
      loadOutputDetail(outputId).catch(handleError);
    } else {
      setSelectedOutput(null);
      setArticles([]);
      setEditMode(false);
    }
  }, [searchParams]);

  useEffect(() => {
    const outputId = searchParams.get('outputId');
    if (!outputId) return;

    const unsubscribe = onSnapshot(doc(db, 'outputs', outputId), (snap) => {
      if (!snap.exists()) return;

      const data = snap.data() as any;
      if (['pending', 'processing'].includes(data.status)) {
        loadOutputs().catch(handleError);
        loadOutputDetail(outputId).catch(handleError);
        return;
      }

      if (data.generatedOutputId || data.status === 'completed' || data.status === 'failed') {
        loadOutputs().catch(handleError);
        loadOutputDetail(outputId).catch(handleError);
      }
    });

    return () => unsubscribe();
  }, [companyId, searchParams]);

  // Initialize contenteditable with body content when entering edit mode
  useEffect(() => {
    if (editMode && editRef.current && renderHtml) {
      const bodyMatch = renderHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      editRef.current.innerHTML = bodyMatch ? bodyMatch[1] : renderHtml;
    }
  }, [editMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const retryOutput = async () => {
    if (!selectedOutput) return;
    await httpsCallable(functions, 'retryManagedReport')({ outputId: selectedOutput.id });
    await loadOutputs();
    await loadOutputDetail(selectedOutput.id);
  };

  const saveReportEdit = async () => {
    if (!selectedOutput || !editRef.current) return;
    const targetId = selectedOutput.generatedOutputId || selectedOutput.id;
    // Read edited content BEFORE any setState (React re-render would overwrite contenteditable)
    const editedBody = editRef.current.innerHTML;
    const currentHtml = selectedOutput?.generatedOutput?.htmlContent || selectedOutput?.htmlContent || selectedOutput?.rawOutput || '';
    
    let newHtml: string;
    const bodyStartMatch = currentHtml.match(/<body[^>]*>/i);
    const bodyEndMatch = currentHtml.match(/<\/body>/i);
    
    if (bodyStartMatch) {
      const endIdx = bodyEndMatch ? bodyEndMatch.index! : currentHtml.length;
      newHtml = currentHtml.substring(0, bodyStartMatch.index!) + `<body>\n${editedBody}\n</body>` + (bodyEndMatch ? currentHtml.substring(endIdx + 7) : '');
    } else {
      newHtml = editedBody;
    }

    setSavingEdit(true);
    setActionMessage(null);
    try {
      await httpsCallable(functions, 'updateReportContent')({ outputId: targetId, htmlContent: newHtml });
      setEditMode(false);
      setActionMessage('리포트 내용이 저장되었습니다. 공유 링크에도 즉시 반영됩니다.');
      await loadOutputDetail(selectedOutput.id);
    } catch (error: any) {
      setActionMessage(error.message || '저장에 실패했습니다.');
    } finally {
      setSavingEdit(false);
    }
  };

  const openRegenModal = () => {
    setRegenPrompt(selectedOutput?.analysisPrompt || '');
    setRegenModalOpen(true);
  };

  const regenerateReport = async () => {
    if (!selectedOutput) return;
    setRegenerating(true);
    setActionMessage(null);
    try {
      await httpsCallable(functions, 'regenerateReportContent')({
        outputId: selectedOutput.id,
        newPrompt: regenPrompt,
      });
      setRegenModalOpen(false);
      setActionMessage('리포트 재생성을 시작했습니다. 완료되면 자동으로 업데이트됩니다.');
    } catch (error: any) {
      setActionMessage(error.message || '재발행에 실패했습니다.');
    } finally {
      setRegenerating(false);
    }
  };

  const openEmailModal = async () => {
    if (!companyId) return;
    setEmailSendStatus('');
    setSelectedGroupIds([]);
    // 배포 그룹 로드
    try {
      const snap = await getDocs(query(collection(db, 'distributionGroups'), where('companyId', '==', companyId)));
      setDistGroups(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })));
    } catch { setDistGroups([]); }
    // 구독 취소 목록 로드
    try {
      const snap = await getDocs(collection(db, 'emailUnsubscribes', companyId, 'entries'));
      setUnsubscribes(new Set(snap.docs.map((d) => ((d.data().email as string) || '').toLowerCase())));
    } catch { setUnsubscribes(new Set()); }
    setEmailModalOpen(true);
  };

  const sendEmail = async () => {
    if (!selectedOutput) return;
    setSending(true);
    setEmailSendStatus('발송 중...');
    try {
      const targetId = selectedOutput.generatedOutputId || selectedOutput.id;
      // 선택된 그룹의 이메일 수집 (구독 취소 제외)
      const allEmails: string[] = [];
      if (selectedGroupIds.length > 0) {
        distGroups
          .filter((g) => selectedGroupIds.includes(g.id))
          .forEach((g) => (g.emails || []).forEach((e: string) => {
            const norm = e.toLowerCase();
            if (!unsubscribes.has(norm) && !allEmails.includes(norm)) allEmails.push(norm);
          }));
      }
      await httpsCallable(functions, 'triggerEmailSend')({
        id: targetId,
        companyId,
        recipients: allEmails.length > 0 ? allEmails : undefined,
      });
      setEmailSendStatus(`발송 완료 (${allEmails.length > 0 ? allEmails.length + '명' : '기본 수신자'})`);
      setTimeout(() => setEmailModalOpen(false), 1500);
    } catch (err: any) {
      setEmailSendStatus(`발송 실패: ${err?.message || '오류 발생'}`);
    } finally {
      setSending(false);
    }
  };

  const sendTelegram = async () => {
    if (!selectedOutput) return;
    setSending(true);
    try {
      const targetId = selectedOutput.generatedOutputId || selectedOutput.id;
      await httpsCallable(functions, 'triggerTelegramSend')({ id: targetId, companyId });
    } finally {
      setSending(false);
    }
  };

  const downloadAsset = async (format: 'pdf' | 'html') => {
    if (!selectedOutput) return;

    setDownloadingFormat(format);
    setActionMessage(null);
    try {
      const targetId = selectedOutput.generatedOutputId || selectedOutput.id;
      const fn = httpsCallable(functions, 'downloadReportAsset');
      const result = await fn({ id: targetId, companyId, format }) as any;
      const { base64, filename, mimeType } = result.data || {};
      if (!base64 || !filename || !mimeType) {
        throw new Error('다운로드 파일을 준비하지 못했습니다.');
      }

      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }

      const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error: any) {
      setActionMessage(error.message || `${format.toUpperCase()} 다운로드에 실패했습니다.`);
    } finally {
      setDownloadingFormat(null);
    }
  };

  const createShareUrl = async (regenerate = false) => {
    if (!selectedOutput) return;

    setSharing(true);
    setActionMessage(null);
    try {
      const targetId = selectedOutput.generatedOutputId || selectedOutput.id;
      const fn = httpsCallable(functions, 'createReportShareLink');
      const result = await fn({ id: targetId, companyId, regenerate }) as any;
      const nextUrl = result.data?.shareUrl || '';
      setShareUrl(nextUrl);
      if (nextUrl) {
        await navigator.clipboard.writeText(nextUrl);
        setActionMessage('공유 링크를 생성하고 클립보드에 복사했습니다.');
      }
    } catch (error: any) {
      setActionMessage(error.message || '공유 링크 생성에 실패했습니다.');
    } finally {
      setSharing(false);
    }
  };

  const copyShareUrl = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setActionMessage('공유 링크를 클립보드에 복사했습니다.');
  };

  const setAsTemplate = async (mode: 'internal' | 'external', clear = false) => {
    if (!selectedOutput || !companyId) return;
    setSettingTemplate(true);
    setActionMessage(null);
    try {
      const targetId = selectedOutput.generatedOutputId || selectedOutput.id;
      await httpsCallable(functions, 'saveCompanyStyleTemplate')({
        companyId,
        mode,
        outputId: clear ? null : targetId,
      });
      const snap = await getDoc(doc(db, 'companySettings', companyId));
      setCurrentTemplates(snap.exists() ? ((snap.data() as any)?.styleTemplates || {}) : {});
      setActionMessage(clear ? '템플릿이 해제되었습니다.' : '이 리포트를 스타일 템플릿으로 설정했습니다.');
    } catch (error: any) {
      setActionMessage(error.message || '템플릿 설정에 실패했습니다.');
    } finally {
      setSettingTemplate(false);
    }
  };

  const renderHtml = useMemo(() => {
    return sanitizeReportHtml(
      selectedOutput?.generatedOutput?.htmlContent || selectedOutput?.htmlContent || selectedOutput?.rawOutput || '',
      articles,
    );
  }, [selectedOutput?.generatedOutput?.htmlContent, selectedOutput?.htmlContent, selectedOutput?.rawOutput, articles]);

  const previewContentParagraphs = formatArticleContentParagraphs(previewArticle?.content || '');

  function StatusBadge({ status }: { status: string }) {
    if (status === 'failed') {
      return (
        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
          실패
        </span>
      );
    }
    if (status === 'pending' || status === 'processing') {
      return (
        <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
          생성중
        </span>
      );
    }
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
        완료
      </span>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-12">
      {/* Page header */}
      <div className="flex items-center justify-between gap-4 border-b border-gray-200 pb-4 dark:border-gray-700/60">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">내부 리포트</h1>
        <Link
          to="/articles"
          className="inline-flex items-center gap-2 rounded-xl bg-[#d4af37] px-4 py-2 text-sm font-semibold text-white hover:bg-[#c59f2c]"
        >
          <Search className="h-4 w-4" />
          새 리포트 생성
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        {/* Left: report list */}
        <div className="rounded-2xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-700/40">
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">최근 리포트</span>
            <button
              onClick={loadOutputs}
              className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-gray-300" />
            </div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-gray-700/40">
              {outputs.map((output) => {
                const isSelected = selectedOutput?.id === output.id;
                return (
                  <button
                    key={output.id}
                    onClick={() => navigate(`/briefing?outputId=${output.id}`)}
                    className={`group w-full px-4 py-3.5 text-left transition ${
                      isSelected
                        ? 'bg-[#1e3a5f]/5 dark:bg-[#1e3a5f]/20'
                        : 'hover:bg-gray-50 dark:hover:bg-gray-700/30'
                    }`}
                  >
                    {isSelected && (
                      <div className="absolute left-0 top-0 h-full w-0.5 rounded-full bg-[#1e3a5f] dark:bg-blue-400" style={{ position: 'relative', display: 'none' }} />
                    )}
                    <div className="flex items-start justify-between gap-2">
                      <p className={`text-sm font-medium leading-snug ${isSelected ? 'text-[#1e3a5f] dark:text-blue-300' : 'text-gray-900 dark:text-white'}`}>
                        {output.title || '리포트'}
                      </p>
                      <StatusBadge status={output.status || 'completed'} />
                    </div>
                    <div className="mt-1.5 flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
                      <span className={`rounded px-1 py-0.5 text-[10px] font-medium ${
                        output.serviceMode === 'external'
                          ? 'bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400'
                          : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
                      }`}>
                        {output.serviceMode === 'external' ? '외부' : '내부'}
                      </span>
                      {currentTemplates[output.serviceMode as 'internal' | 'external'] === output.id && (
                        <span className="rounded px-1 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                          TEMPLATE
                        </span>
                      )}
                      {output.createdAt?.toDate && (
                        <span className="inline-flex items-center gap-1">
                          <Clock3 className="h-3 w-3" />
                          {format(output.createdAt.toDate(), 'MM.dd HH:mm')}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
              {outputs.length === 0 && (
                <div className="px-4 py-12 text-center text-sm text-gray-400">
                  아직 생성된 리포트가 없습니다.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: detail panel */}
        <div className="rounded-2xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
          {!selectedOutput ? (
            <div className="flex min-h-[480px] flex-col items-center justify-center gap-3 text-center">
              <div className="rounded-2xl border border-dashed border-gray-200 p-5 dark:border-gray-700/60">
                <Sparkles className="h-8 w-8 text-gray-300 dark:text-gray-600" />
              </div>
              <p className="text-sm text-gray-400">왼쪽 목록에서 리포트를 선택해 주세요.</p>
            </div>
          ) : (
            <div>
              {/* Detail header */}
              <div className="border-b border-gray-100 px-6 py-5 dark:border-gray-700/40">
                <button
                  onClick={() => navigate('/briefing')}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-400 transition hover:text-gray-700 dark:hover:text-gray-200"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  목록으로
                </button>

                <div className="mt-3 flex flex-wrap items-start gap-2">
                  <h2 className="flex-1 text-xl font-bold leading-tight text-gray-900 dark:text-white">
                    {selectedOutput.title || '리포트'}
                  </h2>
                  <StatusBadge status={selectedOutput.status || 'completed'} />
                  <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                    selectedOutput.serviceMode === 'external'
                      ? 'bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400'
                      : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
                  }`}>
                    {selectedOutput.serviceMode === 'external' ? '외부 배포용' : '내부 분석용'}
                  </span>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-gray-400 dark:text-gray-500">
                  {selectedOutput.createdAt?.toDate && (
                    <span className="inline-flex items-center gap-1">
                      <Clock3 className="h-3.5 w-3.5" />
                      {format(selectedOutput.createdAt.toDate(), 'yyyy.MM.dd HH:mm')}
                    </span>
                  )}
                  <span>참고 기사 {articles.length}건</span>
                </div>

                {/* Action bar */}
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {/* Download group */}
                  <div className="flex items-center divide-x divide-gray-200 overflow-hidden rounded-lg border border-gray-200 dark:divide-gray-700/40 dark:border-gray-700/60">
                    <button
                      onClick={() => downloadAsset('pdf')}
                      disabled={downloadingFormat !== null}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-700/40"
                    >
                      {downloadingFormat === 'pdf' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                      PDF
                    </button>
                    <button
                      onClick={() => downloadAsset('html')}
                      disabled={downloadingFormat !== null}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-700/40"
                    >
                      {downloadingFormat === 'html' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                      HTML
                    </button>
                  </div>

                  {selectedOutput.status === 'failed' && (
                    <button
                      onClick={retryOutput}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700 transition hover:bg-amber-100 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-400"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      다시 시도
                    </button>
                  )}

                  {isAdmin && (
                    <>
                      <button
                        onClick={openEmailModal}
                        disabled={sending}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[#1e3a5f] px-3 py-2 text-xs font-medium text-white transition hover:bg-[#24456f] disabled:opacity-50"
                      >
                        {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}
                        이메일 발송
                      </button>
                      <button
                        onClick={sendTelegram}
                        disabled={sending}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-2 text-xs font-medium text-white transition hover:bg-sky-600 disabled:opacity-50"
                      >
                        {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                        텔레그램
                      </button>
                      {(selectedOutput?.htmlContent || selectedOutput?.rawOutput || selectedOutput?.generatedOutput?.htmlContent) && (
                        <button
                          onClick={openRegenModal}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-[#1e3a5f]/30 bg-[#1e3a5f]/10 px-3 py-2 text-xs font-medium text-[#1e3a5f] transition hover:bg-[#1e3a5f]/20 dark:border-blue-800/40 dark:bg-blue-900/15 dark:text-blue-300"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          리포트 재발행
                        </button>
                      )}
                    </>
                  )}
                  {renderHtml && !editMode && (
                    <button
                      onClick={() => setEditMode(true)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700 transition hover:bg-amber-100 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-400"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                      내용 편집
                    </button>
                  )}
                  {isAdmin && renderHtml && !editMode && (() => {
                    const mode = (selectedOutput?.serviceMode as 'internal' | 'external') || 'internal';
                    const targetId = selectedOutput?.generatedOutputId || selectedOutput?.id;
                    const isCurrentTemplate = currentTemplates[mode] === targetId;
                    return (
                      <button
                        onClick={() => setAsTemplate(mode, isCurrentTemplate)}
                        disabled={settingTemplate}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-500 transition hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700 disabled:opacity-50 dark:border-gray-700/60 dark:text-gray-400 dark:hover:border-amber-700/40 dark:hover:bg-amber-900/20 dark:hover:text-amber-400"
                      >
                        {settingTemplate ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                        {isCurrentTemplate ? '템플릿 해제' : '스타일 템플릿'}
                      </button>
                    );
                  })()}
                  {editMode && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={saveReportEdit}
                        disabled={savingEdit}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[#1e3a5f] px-3 py-2 text-xs font-semibold text-white transition hover:bg-[#24456f] disabled:opacity-50"
                      >
                        {savingEdit ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                        저장
                      </button>
                      <button
                        onClick={() => setEditMode(false)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 transition hover:bg-gray-50 dark:border-gray-700/60 dark:text-gray-300"
                      >
                        <X className="h-3.5 w-3.5" />
                        취소
                      </button>
                    </div>
                  )}
                </div>

                {selectedOutput.errorMessage && (
                  <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-600 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
                    {selectedOutput.errorMessage}
                  </div>
                )}
                {actionMessage && (
                  <div className="mt-3 rounded-xl border border-[#1e3a5f]/20 bg-[#1e3a5f]/5 px-4 py-2.5 text-sm text-[#1e3a5f] dark:border-blue-800/40 dark:bg-blue-900/15 dark:text-blue-300">
                    {actionMessage}
                  </div>
                )}
              </div>

              <div className="space-y-6 px-6 py-6">
                {/* Share link section (admin only) */}
                {isAdmin && (
                  <div className="rounded-xl border border-[#1e3a5f]/15 bg-[#1e3a5f]/[0.03] p-4 dark:border-[#1e3a5f]/30 dark:bg-[#1e3a5f]/10">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Link2 className="h-4 w-4 text-[#1e3a5f] dark:text-blue-400" />
                        <span className="text-sm font-semibold text-gray-900 dark:text-white">모바일 공유 링크</span>
                        <span className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider bg-[#1e3a5f]/10 text-[#1e3a5f] dark:bg-blue-900/30 dark:text-blue-300">
                          로그인 불필요
                        </span>
                      </div>
                    </div>

                    {shareUrl ? (
                      <div className="mt-3 rounded-lg border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
                        <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2 dark:border-gray-700/40">
                          <span className="flex-1 truncate font-mono text-xs text-gray-500 dark:text-gray-400">
                            {shareUrl}
                          </span>
                          <a
                            href={shareUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 rounded p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        </div>
                        <div className="flex items-center divide-x divide-gray-100 dark:divide-gray-700/40">
                          <button
                            onClick={copyShareUrl}
                            className="flex flex-1 items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-gray-600 transition hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700/40"
                          >
                            <Copy className="h-3.5 w-3.5" />
                            복사
                          </button>
                          <button
                            onClick={() => createShareUrl(true)}
                            disabled={sharing}
                            className="flex flex-1 items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-700/40"
                          >
                            {sharing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                            새 링크 발급
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-3 flex items-center justify-between gap-3">
                        <p className="text-xs text-gray-400 dark:text-gray-500">
                          아직 생성된 공유 링크가 없습니다.
                        </p>
                        <button
                          onClick={() => createShareUrl(false)}
                          disabled={sharing}
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[#1e3a5f] px-3 py-2 text-xs font-medium text-white transition hover:bg-[#24456f] disabled:opacity-50"
                        >
                          {sharing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
                          URL 생성
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Report HTML content */}
                {renderHtml ? (
                  <>
                    {/* Report rendering styles: accordion, hero override, mobile */}
                    <style>{`
                      .report-html-body sup { cursor: pointer; color: #1e3a5f; font-weight: 700; }
                      .report-html-body sup:hover { text-decoration: underline; }
                      .report-edit-mode [contenteditable="true"] { outline: 2px dashed #d4af37; border-radius: 4px; min-height: 200px; padding: 4px; }
                      .report-edit-mode [contenteditable="true"]:focus { outline: 2px solid #d4af37; }

                      /* ── Accordion: article-block as details/summary ── */
                      .report-html-body details.article-block {
                        margin-bottom: 20px;
                        padding-bottom: 16px;
                        border-bottom: 1px solid #e8e8e8;
                      }
                      .report-html-body details.article-block > summary.article-summary-row {
                        display: flex;
                        align-items: flex-start;
                        gap: 10px;
                        cursor: pointer;
                        list-style: none;
                        padding: 6px 0;
                        user-select: none;
                      }
                      .report-html-body details.article-block > summary.article-summary-row::-webkit-details-marker { display: none; }

                      /* 펼치기/접기 pill 버튼 (summary 우측 끝) */
                      .report-html-body details.article-block > summary.article-summary-row::after {
                        content: '펼치기 ▸';
                        flex-shrink: 0;
                        margin-left: auto;
                        align-self: center;
                        font-size: 10px;
                        font-weight: 600;
                        color: #1e3a5f;
                        background: #eef3fa;
                        border: 1px solid #c7d8ef;
                        border-radius: 20px;
                        padding: 2px 10px;
                        white-space: nowrap;
                        transition: background 0.15s;
                      }
                      .report-html-body details.article-block > summary.article-summary-row:hover::after {
                        background: #dde8f7;
                      }
                      .report-html-body details.article-block[open] > summary.article-summary-row::after {
                        content: '접기 ▾';
                        color: #6b7280;
                        background: #f3f4f6;
                        border-color: #e5e7eb;
                      }
                      .report-html-body details.article-block > .article-body {
                        padding-top: 12px;
                        padding-left: 2px;
                      }

                      /* ── 원문 보기 button ── */
                      .report-html-body .article-source-btn {
                        display: inline-block;
                        margin-top: 12px;
                        padding: 5px 14px;
                        background: #1e3a5f;
                        color: #fff !important;
                        font-size: 11px;
                        font-weight: 600;
                        border-radius: 6px;
                        text-decoration: none !important;
                        cursor: pointer;
                      }
                      .report-html-body .article-source-btn:hover { background: #24456f; }

                      /* ── 참고 기사 목록 헤드라인 버튼 ── */
                      .report-html-body .ref-headline-btn {
                        background: none;
                        border: none;
                        padding: 0;
                        color: #1a6fa8;
                        font: inherit;
                        font-size: 9pt;
                        cursor: pointer;
                        text-align: left;
                        text-decoration: underline;
                      }
                      .report-html-body .ref-headline-btn:hover { color: #1e3a5f; }

                      /* ── Hero 다크 배경 오버라이드 ── */
                      .report-html-body .hero,
                      .report-html-body .hero-header,
                      .report-html-body .hero-section,
                      .report-html-body .report-hero,
                      .report-html-body [class*="hero"] {
                        background: transparent !important;
                        background-image: none !important;
                        background-color: transparent !important;
                        box-shadow: none !important;
                        border: none !important;
                      }
                      .report-html-body .hero *,
                      .report-html-body .hero-header *,
                      .report-html-body [class*="hero"] * { color: #111827 !important; }

                      /* ── 모바일 최적화 ── */
                      @media (max-width: 640px) {
                        .report-html-body { padding: 12px !important; }
                        .report-html-body .report-header { flex-direction: column !important; gap: 8px !important; }
                        .report-html-body .report-title { font-size: 20px !important; }
                        .report-html-body .report-date-block { text-align: left !important; }
                        .report-html-body .part-title { font-size: 10pt !important; margin: 24px 0 14px !important; }
                        .report-html-body .article-title { font-size: 10pt !important; }
                        .report-html-body .article-sector { float: none !important; display: inline-block; margin-top: 4px; }
                        .report-html-body .article-meta-block { font-size: 8pt !important; padding: 6px 8px !important; }
                        .report-html-body table.ref-table { font-size: 8pt !important; display: block; overflow-x: auto; }
                        .report-html-body table.ref-table th:nth-child(4),
                        .report-html-body table.ref-table td:nth-child(4),
                        .report-html-body table.ref-table th:nth-child(6),
                        .report-html-body table.ref-table td:nth-child(6) { display: none !important; }
                      }
                    `}</style>
                    {editMode ? (
                      <div className="report-edit-mode">
                        <div className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-400">
                          편집 모드: 텍스트를 직접 수정하거나 불필요한 내용을 선택 후 삭제하세요. 완료 후 저장 버튼을 누르세요.
                        </div>
                        <div
                          ref={editRef}
                          contentEditable
                          suppressContentEditableWarning
                          className="report-html-body prose max-w-none overflow-x-auto rounded-lg border border-amber-200 p-3 dark:border-amber-700/40"
                        />
                      </div>
                    ) : (
                      <div
                        className="report-html-body prose max-w-none overflow-x-auto"
                        dangerouslySetInnerHTML={{ __html: renderHtml }}
                        onClick={(e) => {
                          const target = e.target as HTMLElement;
                          if (!articles.length) return;

                          // 공통 헬퍼: data-article-id → 직접 ID 조회 (배열 순서 무관)
                          const findByDataId = (el: HTMLElement): any | null => {
                            const id = el.getAttribute('data-article-id');
                            if (!id) return null;
                            // 만약 AI가 UUID 대신 "1", "2" 와 같이 번호만 넣은 경우를 완벽하게 처리합니다.
                            const numId = parseInt(id, 10);
                            if (!isNaN(numId) && String(numId) === id) {
                              // AI가 준 번호는 1-based index (e.g. 1, 2, 3...)
                              if (numId >= 1 && numId <= articles.length) {
                                return articles[numId - 1];
                              }
                            }
                            return articles.find((a) => a.id === id) || null;
                          };

                          // 1. ref-table 헤드라인 버튼: data-article-id 우선
                          const refEl = target.closest('[data-article-ref]') as HTMLElement | null;
                          if (refEl) {
                            e.preventDefault();
                            const byId = findByDataId(refEl);
                            if (byId) { setPreviewArticle(byId); return; }
                            
                            // 폴백: 텍스트 매칭
                            const linkText = (refEl.textContent || '').trim();
                            if (linkText.length > 1) {
                              const resolvedId = resolveArticleIdByHeadline(linkText, articles);
                              if (resolvedId) {
                                const byTitle = articles.find(a => a.id === resolvedId);
                                if (byTitle) { setPreviewArticle(byTitle); return; }
                              }
                            }
                            return;
                          }

                          // 2. <a> 링크 (원문 보기 버튼 포함)
                          const anchor = (target.tagName === 'A' ? target : target.closest('a')) as HTMLAnchorElement | null;
                          if (anchor) {
                            const isModalTrigger = anchor.classList.contains('article-source-btn') || anchor.classList.contains('ref-headline-btn');
                            
                            // 이음 M&A 뉴스 양식에서는 링크가 .article-title 내부에 있고 부모 .article-block에 ID가 있음
                            const eumArticleBlock = anchor.closest('.article-block');
                            const hasParentId = eumArticleBlock && eumArticleBlock.getAttribute('data-article-id');

                            if (isModalTrigger || hasParentId) {
                              e.preventDefault();
                              
                              // 2-a. data-article-id (자신 또는 부모에서 탐색)
                              const byId = findByDataId(anchor as HTMLElement) || (hasParentId ? findByDataId(eumArticleBlock as HTMLElement) : null);
                              if (byId) { setPreviewArticle(byId); return; }
                              
                              // 2-c. 폴백: URL 매칭
                              const href = anchor.href || '';
                              const urlResolvedId = resolveArticleIdByUrl(href, articles);
                              if (urlResolvedId) {
                                const byUrl = articles.find((a) => a.id === urlResolvedId);
                                if (byUrl) { setPreviewArticle(byUrl); return; }
                              }
                              
                              // 2-d. 폴백: 제목 텍스트 매칭
                              const linkText = (anchor.textContent || '').trim();
                              if (linkText.length > 1) {
                                const resolvedId = resolveArticleIdByHeadline(linkText, articles);
                                if (resolvedId) {
                                  const byTitle = articles.find(a => a.id === resolvedId);
                                  if (byTitle) { setPreviewArticle(byTitle); return; }
                                }
                              }
                            }
                            
                            // 모달 트리거가 아니거나 매칭에 실패한 일반 링크는 새 창에서 열기
                            const href = anchor.href || '';
                            if (href && !href.startsWith('javascript')) {
                              window.open(href, '_blank');
                            }
                            return;
                          }

                          // 3. <sup>[N]</sup> 각주 (1-based, AI 생성 패턴)
                          const sup = (target.tagName === 'SUP' ? target : target.closest('sup')) as HTMLElement | null;
                          if (sup) {
                            const text = (sup.textContent || '').trim();
                            const match = text.match(/\[?(\d+)\]?/);
                            if (match) {
                              const num = parseInt(match[1], 10);
                              if (num >= 1 && num <= articles.length) {
                                e.preventDefault();
                                setPreviewArticle(articles[num - 1]);
                              }
                            }
                          }
                        }}
                      />
                    )}
                  </>
                ) : (
                  <div className="rounded-xl border border-dashed border-gray-200 px-4 py-10 text-center text-sm text-gray-400 dark:border-gray-700/60">
                    생성된 HTML 리포트가 아직 없습니다.
                  </div>
                )}

                {/* Article count summary only */}
                {articles.length > 0 && (
                  <div className="flex items-center gap-2 pt-1">
                    <span className="text-xs text-gray-400 dark:text-gray-500">참고 기사</span>
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                      {articles.length}건
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Article preview modal */}
      {previewArticle && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
          onClick={() => setPreviewArticle(null)}
        >
          <div
            className="flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700/60 dark:bg-gray-900"
            onClick={(event) => event.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-6 py-4 dark:border-gray-700/40">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                    {previewArticle.source}
                  </span>
                  {formatArticleDate(previewArticle.publishedAt) && (
                    <span className="text-[11px] text-gray-400">
                      {formatArticleDate(previewArticle.publishedAt)}
                    </span>
                  )}
                </div>
                <h3 className="mt-2 text-base font-bold leading-snug text-gray-900 dark:text-white">
                  {previewArticle.title}
                </h3>
              </div>
              <button
                onClick={() => setPreviewArticle(null)}
                className="shrink-0 rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Modal body */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
              {previewArticle.summary?.length > 0 && (
                <div className="rounded-xl border border-[#1e3a5f]/15 bg-[#1e3a5f]/[0.04] px-4 py-4 dark:border-[#1e3a5f]/30 dark:bg-[#1e3a5f]/10">
                  <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-[#1e3a5f]/70 dark:text-blue-400">
                    AI 요약
                  </p>
                  <div className="space-y-1.5">
                    {previewArticle.summary.map((line: string, index: number) => (
                      <p key={index} className="flex gap-2 text-sm leading-relaxed text-gray-700 dark:text-gray-300">
                        <span className="mt-0.5 shrink-0 text-[#1e3a5f]/40 dark:text-blue-400/60">—</span>
                        {line}
                      </p>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-gray-400">기사 원문</p>
                <div className="space-y-4">
                  {previewContentParagraphs.length > 0 ? (
                    previewContentParagraphs.map((paragraph: string, index: number) => (
                      <p key={`${previewArticle.id}-paragraph-${index}`} className="text-sm leading-7 text-gray-700 dark:text-gray-300">
                        {paragraph}
                      </p>
                    ))
                  ) : (
                    <p className="text-sm leading-7 text-gray-400">원문 전문이 저장되지 않은 기사입니다.</p>
                  )}
                </div>
              </div>
            </div>

            {/* Modal footer */}
            {previewArticle.url && (
              <div className="border-t border-gray-100 px-6 py-3 dark:border-gray-700/40">
                <a
                  href={previewArticle.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-xs font-medium text-[#1e3a5f] transition hover:underline dark:text-blue-300"
                  onClick={(e) => {
                    e.stopPropagation();
                    // 명시적 window.open — 이벤트 인터셉트 우회
                    e.preventDefault();
                    window.open(previewArticle.url, '_blank', 'noopener,noreferrer');
                  }}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  원문 링크 열기
                </a>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 이메일 발송 모달 */}
      {emailModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm" onClick={() => !sending && setEmailModalOpen(false)}>
          <div className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700/60 dark:bg-gray-900" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 dark:border-gray-700/40">
              <div>
                <h3 className="text-base font-bold text-gray-900 dark:text-white">이메일 발송</h3>
                <p className="mt-0.5 text-xs text-gray-400">발송할 배포 그룹을 선택하세요</p>
              </div>
              <button onClick={() => !sending && setEmailModalOpen(false)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4">
              {distGroups.length === 0 ? (
                <p className="py-4 text-center text-sm text-gray-400">등록된 배포 그룹이 없습니다.<br/>외부 메일링 센터에서 그룹을 먼저 만들어 주세요.</p>
              ) : (
                <div className="space-y-2">
                  <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-gray-100 px-3 py-2.5 hover:bg-gray-50 dark:border-gray-700/40 dark:hover:bg-white/5">
                    <input type="checkbox" checked={selectedGroupIds.length === distGroups.length} onChange={(e) => setSelectedGroupIds(e.target.checked ? distGroups.map((g) => g.id) : [])} className="rounded accent-[#1e3a5f]" />
                    <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">전체 그룹 선택</p>
                  </label>
                  <div className="border-t border-gray-100 pt-2 dark:border-gray-700/40" />
                  {distGroups.map((group) => {
                    const groupEmails: string[] = group.emails || [];
                    const activeCount = groupEmails.filter((e) => !unsubscribes.has(e.toLowerCase())).length;
                    const unsubCount = groupEmails.length - activeCount;
                    return (
                      <label key={group.id} className="flex cursor-pointer items-center gap-3 rounded-lg border border-gray-100 px-3 py-2.5 hover:bg-gray-50 dark:border-gray-700/40 dark:hover:bg-white/5">
                        <input type="checkbox" checked={selectedGroupIds.includes(group.id)} onChange={(e) => setSelectedGroupIds((prev) => e.target.checked ? [...prev, group.id] : prev.filter((id) => id !== group.id))} className="rounded accent-[#1e3a5f]" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{group.name}</p>
                          <p className="text-[11px] text-gray-400">
                            수신 {activeCount}명
                            {unsubCount > 0 && <span className="ml-1 text-red-400">· 구독취소 {unsubCount}명 제외</span>}
                          </p>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
              {selectedGroupIds.length > 0 && (() => {
                const allEmails = new Set<string>();
                distGroups.filter((g) => selectedGroupIds.includes(g.id)).forEach((g) => (g.emails || []).forEach((e: string) => { const n = e.toLowerCase(); if (!unsubscribes.has(n)) allEmails.add(n); }));
                return <div className="mt-3 rounded-lg bg-[#1e3a5f]/5 px-3 py-2 text-xs text-[#1e3a5f] dark:bg-blue-500/10 dark:text-blue-300">총 {allEmails.size}명에게 발송됩니다</div>;
              })()}
              {emailSendStatus && (
                <div className={`mt-3 rounded-lg px-3 py-2 text-xs ${emailSendStatus.startsWith('발송 실패') ? 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400' : 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'}`}>
                  {emailSendStatus}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-gray-100 px-6 py-4 dark:border-gray-700/40">
              <button onClick={() => !sending && setEmailModalOpen(false)} className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400">취소</button>
              <button onClick={sendEmail} disabled={sending || distGroups.length === 0} className="inline-flex items-center gap-2 rounded-lg bg-[#1e3a5f] px-4 py-2 text-sm font-semibold text-white hover:bg-[#24456f] disabled:opacity-50">
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                {selectedGroupIds.length > 0 ? '선택 그룹 발송' : '기본 수신자 발송'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Report re-publish modal */}
      {regenModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
          onClick={() => setRegenModalOpen(false)}
        >
          <div
            className="flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700/60 dark:bg-gray-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-6 py-4 dark:border-gray-700/40">
              <div>
                <h3 className="text-base font-bold text-gray-900 dark:text-white">리포트 재발행</h3>
                <p className="mt-1 text-xs text-gray-400">
                  동일한 기사를 사용하여 새로운 분석 방향으로 리포트를 재생성합니다.
                </p>
              </div>
              <button
                onClick={() => setRegenModalOpen(false)}
                className="shrink-0 rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="px-6 py-5">
              <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
                분석 방향 / 프롬프트
              </label>
              <textarea
                value={regenPrompt}
                onChange={(e) => setRegenPrompt(e.target.value)}
                rows={5}
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:border-[#1e3a5f] focus:outline-none focus:ring-1 focus:ring-[#1e3a5f] dark:border-gray-700/60 dark:bg-gray-800/60 dark:text-white"
                placeholder="분석 방향을 입력하세요. 예: 섹터별 PE 참여 현황과 밸류에이션 트렌드에 집중해서 분석해 주세요."
              />
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-gray-100 px-6 py-4 dark:border-gray-700/40">
              <button
                onClick={() => setRegenModalOpen(false)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 transition hover:text-gray-700 dark:text-gray-400"
              >
                취소
              </button>
              <button
                onClick={regenerateReport}
                disabled={regenerating}
                className="inline-flex items-center gap-2 rounded-lg bg-[#1e3a5f] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#24456f] disabled:opacity-50"
              >
                {regenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                재발행 시작
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
