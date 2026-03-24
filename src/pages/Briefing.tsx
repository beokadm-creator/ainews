import { useEffect, useState } from 'react';
import { ArrowLeft, Clock3, ExternalLink, Loader2, Mail, RefreshCw, RotateCcw, Search, Send, Sparkles } from 'lucide-react';
import { collection, doc, getDoc, getDocs, limit, orderBy, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import { db, functions } from '@/lib/firebase';
import { useAuthStore } from '@/store/useAuthStore';

function sanitizeReportHtml(raw: string) {
  const trimmed = (raw || '').trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  const fenceMatch = trimmed.match(/^```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```$/);
  if (!fenceMatch) {
    return trimmed.replace(/^```[a-zA-Z0-9_-]*\s*/, '').replace(/\s*```$/, '').trim();
  }

  return fenceMatch[1].trim();
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
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

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

    const effectiveArticleIds = output.generatedOutput?.articleIds || output.articleIds || [];
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

  const retryOutput = async () => {
    if (!selectedOutput) return;
    const isManaged = selectedOutput.type === 'managed_report';
    const fn = httpsCallable(functions, isManaged ? 'retryManagedReport' : 'retryManagedReport');
    await fn({ outputId: selectedOutput.id });
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

  const renderHtml = sanitizeReportHtml(
    selectedOutput?.generatedOutput?.htmlContent || selectedOutput?.htmlContent || selectedOutput?.rawOutput || '',
  );

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">내부 리포트</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            내부 분석용과 외부 배포용 리포트를 함께 확인하고, 실패한 작업은 재시도할 수 있습니다.
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

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="rounded-2xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-700">
            <div className="font-semibold text-gray-900 dark:text-white">최근 리포트</div>
            <button onClick={loadOutputs} className="text-gray-500 dark:text-gray-300">
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-gray-300" />
            </div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-gray-700">
              {outputs.map((output) => (
                <button
                  key={output.id}
                  onClick={() => navigate(`/briefing?outputId=${output.id}`)}
                  className={`w-full px-4 py-4 text-left transition hover:bg-gray-50 dark:hover:bg-gray-700/40 ${
                    selectedOutput?.id === output.id ? 'bg-blue-50/50 dark:bg-blue-900/10' : ''
                  }`}
                >
                  <div className="text-sm font-medium text-gray-900 dark:text-white">{output.title || '리포트'}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <span>{output.serviceMode === 'external' ? '외부' : '내부'}</span>
                    <span>{output.status || 'completed'}</span>
                    <span>{output.createdAt?.toDate ? format(output.createdAt.toDate(), 'MM.dd HH:mm') : ''}</span>
                  </div>
                </button>
              ))}
              {outputs.length === 0 && (
                <div className="px-4 py-10 text-sm text-gray-400">아직 생성된 리포트가 없습니다.</div>
              )}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
          {!selectedOutput ? (
            <div className="flex min-h-[420px] flex-col items-center justify-center text-center">
              <Sparkles className="h-10 w-10 text-gray-300" />
              <p className="mt-3 text-sm text-gray-400">왼쪽 목록에서 리포트를 선택해주세요.</p>
            </div>
          ) : (
            <div>
              <div className="border-b border-gray-100 px-6 py-5 dark:border-gray-700">
                <button
                  onClick={() => navigate('/briefing')}
                  className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                >
                  <ArrowLeft className="h-4 w-4" />
                  목록으로
                </button>
                <h2 className="mt-3 text-xl font-bold text-gray-900 dark:text-white">{selectedOutput.title || '리포트'}</h2>
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
                  <span>{selectedOutput.serviceMode === 'external' ? '외부 배포용' : '내부 분석용'}</span>
                  <span>{selectedOutput.status || 'completed'}</span>
                  <span className="inline-flex items-center gap-1">
                    <Clock3 className="h-3.5 w-3.5" />
                    {selectedOutput.createdAt?.toDate ? format(selectedOutput.createdAt.toDate(), 'yyyy.MM.dd HH:mm') : ''}
                  </span>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {selectedOutput.status === 'failed' && (
                    <button
                      onClick={retryOutput}
                      className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700/40"
                    >
                      <RotateCcw className="h-4 w-4" />
                      재시도
                    </button>
                  )}
                  {isAdmin && (
                    <>
                      <button
                        onClick={sendEmail}
                        disabled={sending}
                        className="inline-flex items-center gap-2 rounded-lg bg-[#1e3a5f] px-3 py-2 text-sm text-white hover:bg-[#24456f] disabled:opacity-50"
                      >
                        <Mail className="h-4 w-4" />
                        이메일 발송
                      </button>
                      <button
                        onClick={sendTelegram}
                        disabled={sending}
                        className="inline-flex items-center gap-2 rounded-lg bg-sky-500 px-3 py-2 text-sm text-white hover:bg-sky-600 disabled:opacity-50"
                      >
                        <Send className="h-4 w-4" />
                        텔레그램 발송
                      </button>
                    </>
                  )}
                </div>
                {selectedOutput.errorMessage && (
                  <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
                    {selectedOutput.errorMessage}
                  </div>
                )}
              </div>

              <div className="space-y-6 px-6 py-6">
                {renderHtml ? (
                  <div
                    className="prose max-w-none dark:prose-invert"
                    dangerouslySetInnerHTML={{ __html: renderHtml }}
                  />
                ) : (
                  <div className="rounded-xl border border-dashed border-gray-300 px-4 py-8 text-sm text-gray-400 dark:border-gray-700">
                    생성된 HTML 리포트가 아직 없습니다.
                  </div>
                )}

                <div>
                  <div className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">참고 기사</div>
                  <div className="space-y-3">
                    {articles.map((article, index) => (
                      <div key={article.id} className="rounded-xl border border-gray-200 px-4 py-3 dark:border-gray-700">
                        <div className="text-xs text-gray-500 dark:text-gray-400">{index + 1}. {article.source}</div>
                        <div className="mt-1 text-sm font-medium text-gray-900 dark:text-white">{article.title}</div>
                        {article.url && (
                          <a
                            href={article.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-2 inline-flex items-center gap-1 text-xs text-[#1e3a5f] underline dark:text-blue-300"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            원문 링크
                          </a>
                        )}
                      </div>
                    ))}
                    {articles.length === 0 && (
                      <div className="text-sm text-gray-400">참고 기사 정보가 없습니다.</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
