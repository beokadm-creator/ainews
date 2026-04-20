import { handleError } from "@/utils/errorHandler";
import { useEffect, useMemo, useRef } from 'react';
import {
  ArrowLeft,
  Clock3,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  Mail,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { collection, doc, documentId, getDoc, getDocs, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import { db, functions } from '@/lib/firebase';
import { useAuthStore } from '@/store/useAuthStore';
import { sanitizeReportHtml } from '@/utils/sanitizeHtml';
import { ArticlePreviewModal } from '@/components/briefing/ArticlePreviewModal';
import { ReportList } from '@/components/briefing/ReportList';
import { ReportActionBar } from '@/components/briefing/ReportActionBar';
import { useReportClickHandler } from '@/hooks/useReportClickHandler';
import { useBriefingState } from '@/hooks/useBriefingState';

export default function Briefing() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const companyId = (user as any)?.primaryCompanyId || null;
  const isAdmin = ['company_admin', 'superadmin'].includes((user as any)?.role);

  const {
    state: {
      outputs,
      selectedOutput,
      articles,
      previewArticle,
      loading,
      sending,
      downloadingFormat,
      sharing,
      shareUrl,
      actionMessage,
      regenModalOpen,
      regenPrompt,
      regenerating,
      editMode,
      savingEdit,
      currentTemplates,
      settingTemplate,
      emailModalOpen,
      distGroups,
      selectedGroupIds,
      unsubscribes,
      emailSendStatus
    },
    updateState,
    setOutputs,
    setSelectedOutput,
    setArticles,
    setPreviewArticle,
    setLoading,
    setActionMessage
  } = useBriefingState();

  const editRef = useRef<HTMLDivElement>(null);

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
    updateState({ shareUrl: output.generatedOutput?.shareUrl || output.shareUrl || '' });

    // orderedArticleIds: GLM에 전달된 실제 순서 (각주 [1],[2],... 와 1:1 대응)
    // articleIds는 원래 선택 순서라 각주 번호와 불일치 → orderedArticleIds 우선 사용
    const effectiveArticleIds: string[] = output.generatedOutput?.orderedArticleIds || output.orderedArticleIds
      || output.generatedOutput?.articleIds || output.articleIds || [];
    if (effectiveArticleIds.length > 0) {
      const chunks: string[][] = [];
      for (let i = 0; i < effectiveArticleIds.length; i += 10) {
        chunks.push(effectiveArticleIds.slice(i, i + 10));
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
        if (snap.exists()) updateState({ currentTemplates: (snap.data() as any)?.styleTemplates || {} });
      })
      .catch(handleError);
  }, [companyId]);

  useEffect(() => {
    const outputId = searchParams.get('outputId');
    if (outputId) {
      updateState({ editMode: false });
      loadOutputDetail(outputId).catch(handleError);
    } else {
      setSelectedOutput(null);
      setArticles([]);
      updateState({ editMode: false });
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
    updateState({ actionMessage: null });
    try {
      const { httpsCallable } = await import('firebase/functions');
      const { functions } = await import('@/lib/firebase');
      await httpsCallable(functions, 'retryManagedReport')({ outputId: selectedOutput.id });
      updateState({ actionMessage: '리포트 재실행 요청을 보냈습니다.' });
      await loadOutputs();
      await loadOutputDetail(selectedOutput.id);
    } catch (error: any) {
      updateState({ actionMessage: `재실행 실패: ${error.message || '알 수 없는 오류'}` });
    }
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

    updateState({ savingEdit: true });
    setActionMessage(null);
    try {
      await httpsCallable(functions, 'updateReportContent')({ outputId: targetId, htmlContent: newHtml });
      updateState({ editMode: false });
      setActionMessage('리포트 내용이 저장되었습니다. 공유 링크에도 즉시 반영됩니다.');
      await loadOutputDetail(selectedOutput.id);
    } catch (error: any) {
      setActionMessage(error.message || '저장에 실패했습니다.');
    } finally {
      updateState({ savingEdit: false });
    }
  };

  const openRegenModal = () => {
    updateState({ regenPrompt: selectedOutput?.analysisPrompt || '', regenModalOpen: true });
  };

  const regenerateReport = async () => {
    if (!selectedOutput) return;
    updateState({ regenerating: true });
    setActionMessage(null);
    try {
      await httpsCallable(functions, 'regenerateReportContent')({
        outputId: selectedOutput.id,
        newPrompt: regenPrompt,
      });
      updateState({ regenModalOpen: false });
      setActionMessage('리포트 재생성을 시작했습니다. 완료되면 자동으로 업데이트됩니다.');
    } catch (error: any) {
      setActionMessage(error.message || '재발행에 실패했습니다.');
    } finally {
      updateState({ regenerating: false });
    }
  };

  const openEmailModal = async () => {
    if (!companyId) return;
    updateState({ emailSendStatus: '', selectedGroupIds: [] });
    // 배포 그룹 로드
    try {
      const snap = await getDocs(query(collection(db, 'distributionGroups'), where('companyId', '==', companyId)));
      updateState({ distGroups: snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) });
    } catch { updateState({ distGroups: [] }); }
    // 구독 취소 목록 로드
    try {
      const snap = await getDocs(collection(db, 'emailUnsubscribes', companyId, 'entries'));
      updateState({ unsubscribes: new Set(snap.docs.map((d) => ((d.data().email as string) || '').toLowerCase())) });
    } catch { updateState({ unsubscribes: new Set() }); }
    updateState({ emailModalOpen: true });
  };

  const sendEmail = async () => {
    if (!selectedOutput) return;
    updateState({ sending: true, emailSendStatus: '발송 중...' });
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
      updateState({ emailSendStatus: `발송 완료 (${allEmails.length > 0 ? allEmails.length + '명' : '기본 수신자'})` });
      setTimeout(() => updateState({ emailModalOpen: false }), 1500);
    } catch (err: any) {
      updateState({ emailSendStatus: `발송 실패: ${err?.message || '오류 발생'}` });
    } finally {
      updateState({ sending: false });
    }
  };

  const sendTelegram = async () => {
    if (!selectedOutput) return;
    updateState({ sending: true });
    try {
      const targetId = selectedOutput.generatedOutputId || selectedOutput.id;
      await httpsCallable(functions, 'triggerTelegramSend')({ id: targetId, companyId });
      updateState({ actionMessage: '텔레그램 발송을 완료했습니다.' });
    } catch (error: any) {
      updateState({ actionMessage: `텔레그램 발송 실패: ${error.message || '알 수 없는 오류'}` });
    } finally {
      updateState({ sending: false });
    }
  };

  const downloadAsset = async (format: 'pdf' | 'html') => {
    if (!selectedOutput) return;

    updateState({ downloadingFormat: format });
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
      updateState({ downloadingFormat: null });
    }
  };

  const createShareUrl = async (regenerate = false) => {
    if (!selectedOutput) return;

    updateState({ sharing: true });
    setActionMessage(null);
    try {
      const targetId = selectedOutput.generatedOutputId || selectedOutput.id;
      const fn = httpsCallable(functions, 'createReportShareLink');
      const result = await fn({ id: targetId, companyId, regenerate }) as any;
      const nextUrl = result.data?.shareUrl || '';
      updateState({ shareUrl: nextUrl });
      if (nextUrl) {
        await navigator.clipboard.writeText(nextUrl);
        setActionMessage('공유 링크를 생성하고 클립보드에 복사했습니다.');
      }
    } catch (error: any) {
      setActionMessage(error.message || '공유 링크 생성에 실패했습니다.');
    } finally {
      updateState({ sharing: false });
    }
  };

  const copyShareUrl = () => {
    navigator.clipboard.writeText(shareUrl).then(() => setActionMessage('링크가 복사되었습니다.'));
  };

  const setAsTemplate = async (mode: 'internal' | 'external', clear = false) => {
    if (!selectedOutput || !companyId) return;
    updateState({ settingTemplate: true, actionMessage: null });
    try {
      const targetId = selectedOutput.generatedOutputId || selectedOutput.id;
      await httpsCallable(functions, 'saveCompanyStyleTemplate')({
        companyId,
        mode,
        outputId: clear ? null : targetId,
      });
      const snap = await getDoc(doc(db, 'companySettings', companyId));
      updateState({ currentTemplates: snap.exists() ? ((snap.data() as any)?.styleTemplates || {}) : {} });
      setActionMessage(clear ? '템플릿이 해제되었습니다.' : '이 리포트를 스타일 템플릿으로 설정했습니다.');
    } catch (error: any) {
      setActionMessage(error.message || '템플릿 설정에 실패했습니다.');
    } finally {
      updateState({ settingTemplate: false });
    }
  };

  const renderHtml = useMemo(() => {
    return sanitizeReportHtml(
      selectedOutput?.generatedOutput?.htmlContent || selectedOutput?.htmlContent || selectedOutput?.rawOutput || ''
    );
  }, [selectedOutput?.generatedOutput?.htmlContent, selectedOutput?.htmlContent, selectedOutput?.rawOutput]);

  const handleReportClick = useReportClickHandler(articles, setPreviewArticle);

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
        <ReportList
          outputs={outputs}
          selectedOutputId={selectedOutput?.id || null}
          loading={loading}
          currentTemplates={currentTemplates}
          onSelect={(id) => navigate(`/briefing?outputId=${id}`)}
          onRefresh={loadOutputs}
        />

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
                  <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                    selectedOutput.status === 'failed'
                      ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                      : (selectedOutput.status === 'pending' || selectedOutput.status === 'processing')
                        ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                        : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                  }`}>
                    {selectedOutput.status === 'failed' ? '실패' : (selectedOutput.status === 'pending' || selectedOutput.status === 'processing') ? '생성중' : '완료'}
                  </span>
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

                <ReportActionBar
                  selectedOutput={selectedOutput}
                  isAdmin={isAdmin}
                  editMode={editMode}
                  renderHtml={renderHtml}
                  downloadingFormat={downloadingFormat}
                  sending={sending}
                  savingEdit={savingEdit}
                  settingTemplate={settingTemplate}
                  currentTemplates={currentTemplates}
                  onDownload={downloadAsset}
                  onRetry={retryOutput}
                  onEmail={openEmailModal}
                  onTelegram={sendTelegram}
                  onRegen={openRegenModal}
                  onEditToggle={(mode) => updateState({ editMode: mode })}
                  onSaveEdit={saveReportEdit}
                  onSetTemplate={setAsTemplate}
                />

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
                        onClick={handleReportClick}
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

      <ArticlePreviewModal
        article={previewArticle}
        onClose={() => setPreviewArticle(null)}
      />

      {/* 이메일 발송 모달 */}
      {emailModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm" onClick={() => !sending && updateState({ emailModalOpen: false })}>
          <div className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700/60 dark:bg-gray-900" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 dark:border-gray-700/40">
              <div>
                <h3 className="text-base font-bold text-gray-900 dark:text-white">이메일 발송</h3>
                <p className="mt-0.5 text-xs text-gray-400">발송할 배포 그룹을 선택하세요</p>
              </div>
              <button onClick={() => !sending && updateState({ emailModalOpen: false })} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4">
              {distGroups.length === 0 ? (
                <p className="py-4 text-center text-sm text-gray-400">등록된 배포 그룹이 없습니다.<br/>외부 메일링 센터에서 그룹을 먼저 만들어 주세요.</p>
              ) : (
                <div className="space-y-2">
                  <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-gray-100 px-3 py-2.5 hover:bg-gray-50 dark:border-gray-700/40 dark:hover:bg-white/5">
                    <input type="checkbox" checked={selectedGroupIds.length === distGroups.length} onChange={(e) => updateState({ selectedGroupIds: e.target.checked ? distGroups.map((g) => g.id) : [] })} className="rounded accent-[#1e3a5f]" />
                    <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">전체 그룹 선택</p>
                  </label>
                  <div className="border-t border-gray-100 pt-2 dark:border-gray-700/40" />
                  {distGroups.map((group) => {
                    const groupEmails: string[] = group.emails || [];
                    const activeCount = groupEmails.filter((e) => !unsubscribes.has(e.toLowerCase())).length;
                    const unsubCount = groupEmails.length - activeCount;
                    return (
                      <label key={group.id} className="flex cursor-pointer items-center gap-3 rounded-lg border border-gray-100 px-3 py-2.5 hover:bg-gray-50 dark:border-gray-700/40 dark:hover:bg-white/5">
                        <input type="checkbox" checked={selectedGroupIds.includes(group.id)} onChange={(e) => updateState({ selectedGroupIds: e.target.checked ? [...selectedGroupIds, group.id] : selectedGroupIds.filter((id) => id !== group.id) })} className="rounded accent-[#1e3a5f]" />
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
              <button onClick={() => !sending && updateState({ emailModalOpen: false })} className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400">취소</button>
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
          onClick={() => updateState({ regenModalOpen: false })}
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
                onClick={() => updateState({ regenModalOpen: false })}
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
                onChange={(e) => updateState({ regenPrompt: e.target.value })}
                rows={5}
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:border-[#1e3a5f] focus:outline-none focus:ring-1 focus:ring-[#1e3a5f] dark:border-gray-700/60 dark:bg-gray-800/60 dark:text-white"
                placeholder="분석 방향을 입력하세요. 예: 섹터별 PE 참여 현황과 밸류에이션 트렌드에 집중해서 분석해 주세요."
              />
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-gray-100 px-6 py-4 dark:border-gray-700/40">
              <button
                onClick={() => updateState({ regenModalOpen: false })}
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
