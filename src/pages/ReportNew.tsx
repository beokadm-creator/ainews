import { handleError } from "@/utils/errorHandler";
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
  const [resolvedArticleIds, setResolvedArticleIds] = useState<string[]>([]);
  const [loadingArticles, setLoadingArticles] = useState(false);
  const [reportTitle, setReportTitle] = useState('');
  const [analysisPrompt, setAnalysisPrompt] = useState(
    '팩트 중심으로만 요약하고, PE 업계에서 놓치면 안 되는 체크포인트를 정리해주세요. AI 의견이나 추가 제언은 제외해주세요.',
  );
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [done, setDone] = useState<{ outputId: string } | null>(null);
  const [availableTemplate, setAvailableTemplate] = useState<{ id: string; title: string } | null>(null);
  const [useTemplate, setUseTemplate] = useState(false);
  const [reportMode, setReportMode] = useState<'internal' | 'eum_daily'>('internal');

  useEffect(() => {
    const loadArticles = async () => {
      setLoadingArticles(true);
      setErrorMsg(null);
      try {
        if (articleIds.length > 0) {
          const docs = await Promise.all(articleIds.map((articleId) => getDoc(doc(db, 'articles', articleId))));
          const nextArticles = docs
            .filter((item) => item.exists())
            .map((item) => ({ id: item.id, ...(item.data() as any) }));

          setArticles(nextArticles);
          setResolvedArticleIds(nextArticles.map((article) => article.id));
          return;
        }

        if (!companyId) {
          setArticles([]);
          setResolvedArticleIds([]);
          return;
        }

        const fn = httpsCallable(functions, 'searchArticles');
        const result = await fn({
          companyId,
          keywords,
          startDate,
          endDate,
          sourceIds,
          statuses: ['analyzed', 'published'],
          limit: 500,
          offset: 0,
        }) as any;

        const nextArticles = result.data?.articles || [];
        setArticles(nextArticles);
        setResolvedArticleIds(nextArticles.map((article: ArticlePreview) => article.id));
      } catch (err: any) {
        console.error('Failed to load articles:', err);
        setErrorMsg(`기사 로드 중 오류가 발생했습니다: ${err.message || '알 수 없는 오류'}`);
      } finally {
        setLoadingArticles(false);
      }
    };

    loadArticles();
  }, [articleIds, companyId, endDate, keywords, sourceIds, startDate]);

  useEffect(() => {
    const loadCompanyPrompt = async () => {
      if (!companyId) return;
      const settingsDoc = await getDoc(doc(db, 'companySettings', companyId));
      if (!settingsDoc.exists()) return;
      const settings = settingsDoc.data() as any;
      const companyPrompt = `${settings?.reportPrompts?.internal || ''}`.trim();
      if (companyPrompt) {
        setAnalysisPrompt(companyPrompt);
      }
      // Load internal style template if set
      const internalTemplateId = settings?.styleTemplates?.internal;
      if (internalTemplateId) {
        const outputDoc = await getDoc(doc(db, 'outputs', internalTemplateId));
        if (outputDoc.exists()) {
          const output = outputDoc.data() as any;
          setAvailableTemplate({ id: internalTemplateId, title: output.title || '스타일 템플릿' });
          setUseTemplate(true);
        }
      }
    };

    loadCompanyPrompt().catch(handleError);
  }, [companyId]);

  const handleGenerate = async () => {
    if (!companyId || resolvedArticleIds.length === 0) return;

    setSubmitting(true);
    setErrorMsg(null);
    try {
      const fn = httpsCallable(functions, 'requestManagedReport');
      const result = await fn({
        companyId,
        mode: reportMode,
        articleIds: resolvedArticleIds,
        filters: articleIds.length > 0
          ? undefined
          : {
              sourceIds,
              keywords,
              startDate,
              endDate,
            },
        reportTitle: reportTitle.trim() || undefined,
        prompt: analysisPrompt.trim(),
        templateOutputId: useTemplate && availableTemplate ? availableTemplate.id : null,
      }) as any;

      if (result.data?.outputId) {
        setDone({ outputId: result.data.outputId });
      } else {
        throw new Error('Failed to start report generation (no outputId returned)');
      }
    } catch (err: any) {
      console.error('Failed to generate report:', err);
      setErrorMsg(`리포트 생성 요청에 실패했습니다: ${err.message || '알 수 없는 오류'}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="mx-auto max-w-2xl py-20 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-emerald-50 dark:bg-emerald-500/10">
          <CheckCircle2 className="h-7 w-7 text-emerald-600 dark:text-emerald-400" />
        </div>
        <h1 className="mt-5 text-xl font-bold text-gray-900 dark:text-white">내부 리포트 생성이 시작되었습니다.</h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          AI가 선택된 기사 묶음을 기준으로 분석 중입니다. 완료되면 내부 리포트 목록에서 바로 확인할 수 있습니다.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <button
            onClick={() => navigate(`/briefing?outputId=${done.outputId}`)}
            className="rounded-xl bg-[#1e3a5f] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#24456f]"
          >
            리포트 보기
          </button>
          <button
            onClick={() => navigate('/articles')}
            className="rounded-xl border border-gray-200 px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700/60 dark:text-gray-200 dark:hover:bg-white/5"
          >
            기사 검색으로 돌아가기
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-12">
      <div className="border-b border-gray-200 pb-5 dark:border-gray-700/60">
        <button
          onClick={() => navigate('/articles')}
          className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          기사 검색으로 돌아가기
        </button>
        <h1 className="mt-3 text-xl font-bold text-gray-900 dark:text-white">내부 리포트 생성</h1>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          검색 결과와 동일한 기사 집합을 기준으로 내부 분석 리포트를 생성합니다.
        </p>
      </div>

      {errorMsg && (
        <div className="rounded-xl bg-red-50 p-4 text-sm text-red-800 dark:bg-red-900/30 dark:text-red-400 border border-red-200 dark:border-red-800/30">
          <p className="font-semibold mb-1">오류가 발생했습니다</p>
          <p>{errorMsg}</p>
        </div>
      )}

      <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
        <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3 dark:border-gray-700/40">
          <FileText className="h-3.5 w-3.5 text-[#1e3a5f] dark:text-blue-400" />
          <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">리포트 대상</span>
        </div>

        {loadingArticles ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-gray-300 dark:text-gray-600" />
          </div>
        ) : articleIds.length > 0 ? (
          <div className="p-4">
            <p className="text-xs text-gray-500 dark:text-gray-400">선택 기사 {resolvedArticleIds.length}건</p>
            <ul className="mt-3 divide-y divide-gray-100 rounded-lg border border-gray-100 dark:divide-gray-700/40 dark:border-gray-700/40">
              {articles.map((article, index) => (
                <li key={article.id} className="px-3 py-2.5">
                  <div className="text-[11px] text-gray-400">{index + 1}. {article.source}</div>
                  <div className="mt-0.5 text-sm font-medium text-gray-900 dark:text-white">{article.title}</div>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="p-4">
            <div className="rounded-lg border border-dashed border-gray-200 px-4 py-4 text-xs text-gray-500 dark:border-gray-700/60 dark:text-gray-400">
              검색 조건 전체를 기준으로 리포트를 생성합니다.
              <div className="mt-2">키워드: {keywords.length > 0 ? keywords.join(', ') : '없음'}</div>
              <div className="mt-1">대상 매체 수: {sourceIds.length}</div>
              <div className="mt-1">확정 기사 수: {resolvedArticleIds.length}</div>
            </div>
            {articles.length > 0 && (
              <ul className="mt-3 divide-y divide-gray-100 rounded-lg border border-gray-100 dark:divide-gray-700/40 dark:border-gray-700/40">
                {articles.slice(0, 12).map((article, index) => (
                  <li key={article.id} className="px-3 py-2.5">
                    <div className="text-[11px] text-gray-400">{index + 1}. {article.source}</div>
                    <div className="mt-0.5 text-sm font-medium text-gray-900 dark:text-white">{article.title}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
        <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3 dark:border-gray-700/40">
          <Sparkles className="h-3.5 w-3.5 text-[#d4af37]" />
          <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">분석 설정</span>
        </div>

        <div className="space-y-4 p-4">
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">
              리포트 양식 선택
            </label>
            <div className="mt-2 flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input 
                  type="radio" 
                  name="reportMode" 
                  value="internal" 
                  checked={reportMode === 'internal'} 
                  onChange={() => setReportMode('internal')}
                  className="accent-[#1e3a5f]"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">기본 분석 리포트 (기존 방식)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input 
                  type="radio" 
                  name="reportMode" 
                  value="eum_daily" 
                  checked={reportMode === 'eum_daily'} 
                  onChange={() => setReportMode('eum_daily')}
                  className="accent-[#1e3a5f]"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">이음 M&A 뉴스 양식</span>
              </label>
            </div>
          </div>

          <div>
            <label className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">리포트 제목</label>
            <input
              value={reportTitle}
              onChange={(event) => setReportTitle(event.target.value)}
              className="mt-2 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none transition focus:border-[#1e3a5f] focus:ring-1 focus:ring-[#1e3a5f]/20 dark:border-gray-700/60 dark:bg-gray-900/40 dark:text-white dark:focus:border-blue-400"
              placeholder="비워두면 AI가 생성합니다."
            />
          </div>

          <div>
            <label className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">분석 지시</label>
            <textarea
              value={analysisPrompt}
              onChange={(event) => setAnalysisPrompt(event.target.value)}
              rows={6}
              className="mt-2 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none transition focus:border-[#1e3a5f] focus:ring-1 focus:ring-[#1e3a5f]/20 dark:border-gray-700/60 dark:bg-gray-900/40 dark:text-white dark:focus:border-blue-400"
            />
          </div>

          {availableTemplate && (
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2.5 transition hover:bg-amber-50 dark:border-amber-800/40 dark:bg-amber-900/15">
              <input
                type="checkbox"
                checked={useTemplate}
                onChange={(e) => setUseTemplate(e.target.checked)}
                className="rounded accent-[#d4af37]"
              />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
                  <Sparkles className="h-3 w-3 shrink-0" />
                  스타일 템플릿 적용
                </div>
                <div className="mt-0.5 truncate text-[11px] text-amber-600/80 dark:text-amber-500/80">
                  {availableTemplate.title}
                </div>
              </div>
            </label>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleGenerate}
          disabled={submitting || resolvedArticleIds.length === 0}
          className="inline-flex items-center gap-2 rounded-xl bg-[#1e3a5f] px-6 py-2.5 text-sm font-semibold text-white hover:bg-[#24456f] disabled:opacity-50"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          내부 리포트 생성
        </button>
        {submitting && (
          <span className="text-xs text-gray-500 dark:text-gray-400">AI가 리포트를 생성하고 있습니다…</span>
        )}
      </div>
    </div>
  );
}
