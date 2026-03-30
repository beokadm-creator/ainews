import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  Link2,
  Loader2,
  Mail,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import { collection, doc, getDoc, getDocs, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import { db, functions } from '@/lib/firebase';
import { useAuthStore } from '@/store/useAuthStore';
import { formatArticleContentParagraphs } from '@/lib/articleContent';

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
    const effectiveArticleIds = output.generatedOutput?.orderedArticleIds || output.orderedArticleIds
      || output.generatedOutput?.articleIds || output.articleIds || [];
    if (effectiveArticleIds.length > 0) {
      const docs = await Promise.all(effectiveArticleIds.map((id: string) => getDoc(doc(db, 'articles', id))));
      setArticles(docs.filter((item) => item.exists()).map((item) => ({ id: item.id, ...(item.data() as any) })));
    } else {
      setArticles([]);
    }
  };

  useEffect(() => {
    loadOutputs().catch(console.error);
  }, [companyId]);

  useEffect(() => {
    const outputId = searchParams.get('outputId');
    if (outputId) {
      loadOutputDetail(outputId).catch(console.error);
    } else {
      setSelectedOutput(null);
      setArticles([]);
    }
  }, [searchParams]);

  useEffect(() => {
    const outputId = searchParams.get('outputId');
    if (!outputId) return;

    const unsubscribe = onSnapshot(doc(db, 'outputs', outputId), (snap) => {
      if (!snap.exists()) return;

      const data = snap.data() as any;
      if (['pending', 'processing'].includes(data.status)) {
        loadOutputs().catch(console.error);
        loadOutputDetail(outputId).catch(console.error);
        return;
      }

      if (data.generatedOutputId || data.status === 'completed' || data.status === 'failed') {
        loadOutputs().catch(console.error);
        loadOutputDetail(outputId).catch(console.error);
      }
    });

    return () => unsubscribe();
  }, [companyId, searchParams]);

  const retryOutput = async () => {
    if (!selectedOutput) return;
    await httpsCallable(functions, 'retryManagedReport')({ outputId: selectedOutput.id });
    await loadOutputs();
    await loadOutputDetail(selectedOutput.id);
  };

  const sendEmail = async () => {
    if (!selectedOutput) return;
    setSending(true);
    try {
      const targetId = selectedOutput.generatedOutputId || selectedOutput.id;
      await httpsCallable(functions, 'triggerEmailSend')({ id: targetId, companyId });
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

  const renderHtml = sanitizeReportHtml(
    selectedOutput?.generatedOutput?.htmlContent || selectedOutput?.htmlContent || selectedOutput?.rawOutput || '',
  );
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
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">내부 리포트</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            생성된 분석 리포트를 확인하고, 실패한 작업은 재시도하거나 바로 발송할 수 있습니다.
          </p>
        </div>
        <Link
          to="/articles"
          className="inline-flex items-center gap-2 rounded-xl bg-[#d4af37] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#c59f2c]"
        >
          <Search className="h-4 w-4" />
          새 리포트 생성
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        {/* Left: report list */}
        <div className="rounded-2xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-700">
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
            <div className="divide-y divide-gray-100 dark:divide-gray-700/60">
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
        <div className="rounded-2xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
          {!selectedOutput ? (
            <div className="flex min-h-[480px] flex-col items-center justify-center gap-3 text-center">
              <div className="rounded-2xl border border-dashed border-gray-200 p-5 dark:border-gray-700">
                <Sparkles className="h-8 w-8 text-gray-300 dark:text-gray-600" />
              </div>
              <p className="text-sm text-gray-400">왼쪽 목록에서 리포트를 선택해 주세요.</p>
            </div>
          ) : (
            <div>
              {/* Detail header */}
              <div className="border-b border-gray-100 px-6 py-5 dark:border-gray-700">
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
                  <div className="flex items-center divide-x divide-gray-200 overflow-hidden rounded-lg border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
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
                        onClick={sendEmail}
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
                    </>
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
                      <div className="mt-3 rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
                        <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2 dark:border-gray-700">
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
                        <div className="flex items-center divide-x divide-gray-100 dark:divide-gray-700">
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
                  <div className="prose max-w-none dark:prose-invert" dangerouslySetInnerHTML={{ __html: renderHtml }} />
                ) : (
                  <div className="rounded-xl border border-dashed border-gray-200 px-4 py-10 text-center text-sm text-gray-400 dark:border-gray-700">
                    생성된 HTML 리포트가 아직 없습니다.
                  </div>
                )}

                {/* Reference articles */}
                <div>
                  <div className="mb-3 flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">참고 기사</span>
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                      {articles.length}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {articles.map((article, index) => (
                      <div
                        key={article.id}
                        className="group rounded-xl border border-gray-200 px-4 py-3 transition hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600"
                      >
                        <div className="flex items-start gap-3">
                          <span className="mt-0.5 shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-gray-400 dark:bg-gray-700 dark:text-gray-500">
                            {index + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="text-[11px] font-medium text-gray-400 dark:text-gray-500">{article.source}</div>
                            <div className="mt-0.5 text-sm font-medium leading-snug text-gray-900 dark:text-white">{article.title}</div>
                            <div className="mt-2 flex flex-wrap gap-3">
                              <button
                                type="button"
                                onClick={() => setPreviewArticle(article)}
                                className="inline-flex items-center gap-1 text-xs font-medium text-[#1e3a5f] transition hover:underline dark:text-blue-300"
                              >
                                원문 보기
                              </button>
                              {article.url && (
                                <a
                                  href={article.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-xs font-medium text-[#1e3a5f] transition hover:underline dark:text-blue-300"
                                >
                                  <ExternalLink className="h-3 w-3" />
                                  원문 링크
                                </a>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                    {articles.length === 0 && (
                      <div className="rounded-xl border border-dashed border-gray-200 py-6 text-center text-sm text-gray-400 dark:border-gray-700">
                        참고 기사 정보가 없습니다.
                      </div>
                    )}
                  </div>
                </div>
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
            className="flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900"
            onClick={(event) => event.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-6 py-4 dark:border-gray-700">
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
              <div className="border-t border-gray-100 px-6 py-3 dark:border-gray-700">
                <a
                  href={previewArticle.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-xs font-medium text-[#1e3a5f] transition hover:underline dark:text-blue-300"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  원문 링크 열기
                </a>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
