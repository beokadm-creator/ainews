import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, FileText, Loader2, Sparkles } from 'lucide-react';
import { doc, getDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '@/lib/firebase';
import { useAuthStore } from '@/store/useAuthStore';

interface ArticlePreview {
  id: string;
  title: string;
  source: string;
  publishedAt?: any;
  category?: string;
}

export default function ReportNew() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const companyId = (user as any)?.primaryCompanyId || (user as any)?.companyIds?.[0] || null;

  const articleIds = useMemo(
    () => (searchParams.get('articleIds') || '').split(',').filter(Boolean),
    [searchParams],
  );
  const keywords = useMemo(
    () => (searchParams.get('keywords') || '').split(',').map((item) => item.trim()).filter(Boolean),
    [searchParams],
  );
  const sourceIds = useMemo(
    () => (searchParams.get('sourceIds') || '').split(',').map((item) => item.trim()).filter(Boolean),
    [searchParams],
  );
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');

  const [articles, setArticles] = useState<ArticlePreview[]>([]);
  const [loadingArticles, setLoadingArticles] = useState(false);
  const [reportTitle, setReportTitle] = useState('');
  const [analysisPrompt, setAnalysisPrompt] = useState(
    '팩트 기반으로만 요약하고, PE 업계에서 놓치면 안 되는 포인트와 체크포인트 중심으로 정리해주세요. 의견이나 제언은 제외합니다.',
  );
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ outputId: string } | null>(null);

  useEffect(() => {
    if (articleIds.length === 0) return;
    const loadArticles = async () => {
      setLoadingArticles(true);
      try {
        const docs = await Promise.all(articleIds.map((articleId) => getDoc(doc(db, 'articles', articleId))));
        setArticles(docs.filter((item) => item.exists()).map((item) => ({ id: item.id, ...(item.data() as any) })));
      } finally {
        setLoadingArticles(false);
      }
    };
    loadArticles().catch(console.error);
  }, [articleIds]);

  const handleGenerate = async () => {
    if (!companyId) return;
    setSubmitting(true);
    try {
      const fn = httpsCallable(functions, 'requestManagedReport');
      const result = await fn({
        companyId,
        mode: 'internal',
        articleIds,
        filters: articleIds.length > 0 ? undefined : {
          sourceIds,
          keywords,
          startDate,
          endDate,
        },
        reportTitle: reportTitle.trim() || undefined,
        prompt: analysisPrompt.trim(),
      }) as any;

      setDone({ outputId: result.data.outputId });
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="mx-auto max-w-2xl py-20 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
          <CheckCircle2 className="h-8 w-8 text-green-600 dark:text-green-400" />
        </div>
        <h1 className="mt-6 text-2xl font-bold text-gray-900 dark:text-white">내부 리포트 생성을 시작했습니다.</h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          AI가 기사 묶음을 분석하고 있습니다. 완료되면 내부 리포트 목록에서 확인할 수 있습니다.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <button
            onClick={() => navigate(`/briefing?outputId=${done.outputId}`)}
            className="rounded-xl bg-[#1e3a5f] px-5 py-3 text-sm font-semibold text-white hover:bg-[#24456f]"
          >
            리포트 보기
          </button>
          <button
            onClick={() => navigate('/articles')}
            className="rounded-xl border border-gray-200 px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700/40"
          >
            기사 검색으로 돌아가기
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-12">
      <div>
        <button
          onClick={() => navigate('/articles')}
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <ArrowLeft className="h-4 w-4" />
          기사 검색으로 돌아가기
        </button>
        <h1 className="mt-3 text-2xl font-bold text-gray-900 dark:text-white">내부 리포트 생성</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          사실 중심의 내부 분석 리포트를 생성합니다. AI의 추가 견해나 투자 제언은 제외됩니다.
        </p>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
          <FileText className="h-4 w-4 text-[#1e3a5f]" />
          리포트 대상
        </div>

        {articleIds.length > 0 ? (
          <div className="mt-4">
            <p className="text-sm text-gray-500 dark:text-gray-400">선택 기사 {articleIds.length}건</p>
            <div className="mt-3 divide-y divide-gray-100 rounded-xl border border-gray-100 dark:divide-gray-700 dark:border-gray-700">
              {loadingArticles ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="h-5 w-5 animate-spin text-gray-300" />
                </div>
              ) : (
                articles.map((article, index) => (
                  <div key={article.id} className="px-4 py-3">
                    <div className="text-xs text-gray-500 dark:text-gray-400">{index + 1}. {article.source}</div>
                    <div className="mt-1 text-sm font-medium text-gray-900 dark:text-white">{article.title}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-dashed border-gray-300 px-4 py-4 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
            검색 조건 전체를 기준으로 리포트를 생성합니다.
            <div className="mt-2">키워드: {keywords.length > 0 ? keywords.join(', ') : '없음'}</div>
            <div className="mt-1">매체 수: {sourceIds.length}</div>
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
          <Sparkles className="h-4 w-4 text-[#d4af37]" />
          분석 설정
        </div>

        <div className="mt-4 space-y-4">
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-gray-500">리포트 제목</label>
            <input
              value={reportTitle}
              onChange={(event) => setReportTitle(event.target.value)}
              className="mt-2 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none focus:border-[#1e3a5f] dark:border-gray-700 dark:bg-gray-900/30 dark:text-white"
              placeholder="미입력 시 AI가 생성합니다."
            />
          </div>

          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-gray-500">분석 지시</label>
            <textarea
              value={analysisPrompt}
              onChange={(event) => setAnalysisPrompt(event.target.value)}
              rows={6}
              className="mt-2 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none focus:border-[#1e3a5f] dark:border-gray-700 dark:bg-gray-900/30 dark:text-white"
            />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleGenerate}
          disabled={submitting}
          className="inline-flex items-center gap-2 rounded-xl bg-[#1e3a5f] px-6 py-3 text-sm font-semibold text-white hover:bg-[#24456f] disabled:opacity-50"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          내부 리포트 생성
        </button>
        {submitting && (
          <span className="text-sm text-gray-500 dark:text-gray-400">AI가 리포트를 생성하고 있습니다.</span>
        )}
      </div>
    </div>
  );
}
