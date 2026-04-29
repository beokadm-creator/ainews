import { handleError } from "@/utils/errorHandler";
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, FileText, Loader2, Sparkles, AlertTriangle } from 'lucide-react';
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

type DedupStep = 'idle' | 'checking' | 'reviewing' | 'applied';

interface DedupGroup {
  keepId: string;
  duplicateIds: string[];
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

  // AI dedup state
  const [dedupStep, setDedupStep] = useState<DedupStep>('idle');
  const [dedupGroups, setDedupGroups] = useState<DedupGroup[]>([]);
  // IDs the user has checked to exclude (initially all duplicateIds from AI response)
  const [pendingExcludeIds, setPendingExcludeIds] = useState<Set<string>>(new Set());
  const [appliedExcludeCount, setAppliedExcludeCount] = useState(0);

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

  const handleDedupCheck = async () => {
    setDedupStep('checking');
    setDedupGroups([]);
    setPendingExcludeIds(new Set());
    try {
      const fn = httpsCallable(functions, 'checkArticleDuplicates');
      const result = await fn({ companyId, articleIds: resolvedArticleIds }) as any;
      const groups: DedupGroup[] = result.data?.groups || [];
      setDedupGroups(groups);
      // Pre-check all duplicateIds for exclusion
      const allDupIds = new Set(groups.flatMap((g) => g.duplicateIds));
      setPendingExcludeIds(allDupIds);
      setDedupStep('reviewing');
    } catch (err: any) {
      console.error('Dedup check failed:', err);
      setDedupStep('idle');
    }
  };

  const handleApplyDedup = () => {
    if (pendingExcludeIds.size === 0) {
      setDedupStep('applied');
      setAppliedExcludeCount(0);
      return;
    }
    const filteredIds = resolvedArticleIds.filter((id) => !pendingExcludeIds.has(id));
    const filteredArticles = articles.filter((a) => !pendingExcludeIds.has(a.id));
    setResolvedArticleIds(filteredIds);
    setArticles(filteredArticles);
    setAppliedExcludeCount(pendingExcludeIds.size);
    setDedupGroups([]);
    setPendingExcludeIds(new Set());
    setDedupStep('applied');
  };

  const handleGenerate = async () => {
    if (!companyId || resolvedArticleIds.length === 0) return;

    setSubmitting(true);
    setErrorMsg(null);
    try {
      const fn = httpsCallable(functions, 'requestManagedReport');
      const result = await fn({
        companyId,
        mode: 'internal',
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

  const totalDuplicateCount = dedupGroups.reduce((sum, g) => sum + g.duplicateIds.length, 0);

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
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-500 dark:text-gray-400">선택 기사 {resolvedArticleIds.length}건</p>
              {dedupStep === 'applied' && appliedExcludeCount > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" />
                  중복 {appliedExcludeCount}건 제외됨
                </span>
              )}
              {dedupStep === 'applied' && appliedExcludeCount === 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" />
                  중복 없음
                </span>
              )}
            </div>
            <ul className="mt-3 divide-y divide-gray-100 rounded-lg border border-gray-100 dark:divide-gray-700/40 dark:border-gray-700/40">
              {articles.map((article, index) => (
                <li key={article.id} className="px-3 py-2.5">
                  <div className="text-[11px] text-gray-400">{index + 1}. {article.source}</div>
                  <div className="mt-0.5 text-sm font-medium text-gray-900 dark:text-white">{article.title}</div>
                </li>
              ))}
            </ul>

            {/* AI dedup section */}
            {dedupStep === 'idle' && resolvedArticleIds.length >= 2 && (
              <div className="mt-4 flex items-center gap-2">
                <button
                  onClick={handleDedupCheck}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#1e3a5f]/20 bg-[#1e3a5f]/5 px-3 py-1.5 text-xs font-medium text-[#1e3a5f] hover:bg-[#1e3a5f]/10 dark:border-blue-400/20 dark:bg-blue-400/5 dark:text-blue-400 dark:hover:bg-blue-400/10"
                >
                  <Sparkles className="h-3 w-3" />
                  AI 중복 검토
                </button>
                <span className="text-[10px] text-gray-400">리포트 생성 전 AI가 중복 기사를 확인합니다</span>
              </div>
            )}

            {dedupStep === 'checking' && (
              <div className="mt-4 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                AI가 중복 기사를 분석하고 있습니다…
              </div>
            )}

            {dedupStep === 'reviewing' && dedupGroups.length === 0 && (
              <div className="mt-4 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                중복 기사가 감지되지 않았습니다.
                <button
                  onClick={() => setDedupStep('applied')}
                  className="ml-auto font-semibold underline underline-offset-2"
                >
                  확인
                </button>
              </div>
            )}

            {dedupStep === 'reviewing' && dedupGroups.length > 0 && (
              <div className="mt-4 space-y-3">
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2.5 dark:border-amber-800/40 dark:bg-amber-900/20">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                  <p className="text-xs text-amber-800 dark:text-amber-300">
                    AI가 <span className="font-semibold">{totalDuplicateCount}건</span>의 중복 기사를 감지했습니다.
                    제외할 기사를 확인하고 적용하세요.
                  </p>
                </div>

                {dedupGroups.map((group) => {
                  const keepArticle = articles.find((a) => a.id === group.keepId);
                  return (
                    <div key={group.keepId} className="rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-700/40 dark:bg-gray-900/30">
                      <div className="border-b border-gray-100 px-3 py-2 dark:border-gray-700/30">
                        <div className="text-[10px] font-semibold uppercase tracking-widest text-emerald-600 dark:text-emerald-400">유지</div>
                        <div className="mt-0.5 text-xs font-medium text-gray-800 dark:text-gray-200">
                          {keepArticle?.title || group.keepId}
                        </div>
                        {keepArticle?.source && (
                          <div className="mt-0.5 text-[10px] text-gray-400">{keepArticle.source}</div>
                        )}
                      </div>
                      <div className="px-3 py-2">
                        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-red-500 dark:text-red-400">중복 (제외 대상)</div>
                        <div className="space-y-1.5">
                          {group.duplicateIds.map((dupId) => {
                            const dupArticle = articles.find((a) => a.id === dupId);
                            const isChecked = pendingExcludeIds.has(dupId);
                            return (
                              <label key={dupId} className="flex cursor-pointer items-start gap-2">
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={(e) => {
                                    setPendingExcludeIds((prev) => {
                                      const next = new Set(prev);
                                      if (e.target.checked) next.add(dupId);
                                      else next.delete(dupId);
                                      return next;
                                    });
                                  }}
                                  className="mt-0.5 accent-red-500"
                                />
                                <div className="min-w-0">
                                  <div className="text-xs text-gray-700 dark:text-gray-300">
                                    {dupArticle?.title || dupId}
                                  </div>
                                  {dupArticle?.source && (
                                    <div className="text-[10px] text-gray-400">{dupArticle.source}</div>
                                  )}
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  );
                })}

                <div className="flex items-center gap-2">
                  <button
                    onClick={handleApplyDedup}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#1e3a5f] px-4 py-2 text-xs font-semibold text-white hover:bg-[#24456f]"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    적용 ({pendingExcludeIds.size}건 제외)
                  </button>
                  <button
                    onClick={() => setDedupStep('idle')}
                    className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                  >
                    취소
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="p-4">
            <div className="flex items-center justify-between">
              <div className="rounded-lg border border-dashed border-gray-200 px-4 py-4 text-xs text-gray-500 dark:border-gray-700/60 dark:text-gray-400 flex-1">
                검색 조건 전체를 기준으로 리포트를 생성합니다.
                <div className="mt-2">키워드: {keywords.length > 0 ? keywords.join(', ') : '없음'}</div>
                <div className="mt-1">대상 매체 수: {sourceIds.length}</div>
                <div className="mt-1">확정 기사 수: {resolvedArticleIds.length}</div>
              </div>
              {dedupStep === 'applied' && appliedExcludeCount > 0 && (
                <span className="ml-3 inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" />
                  중복 {appliedExcludeCount}건 제외됨
                </span>
              )}
              {dedupStep === 'applied' && appliedExcludeCount === 0 && (
                <span className="ml-3 inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" />
                  중복 없음
                </span>
              )}
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

            {/* AI dedup section */}
            {dedupStep === 'idle' && resolvedArticleIds.length >= 2 && (
              <div className="mt-4 flex items-center gap-2">
                <button
                  onClick={handleDedupCheck}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#1e3a5f]/20 bg-[#1e3a5f]/5 px-3 py-1.5 text-xs font-medium text-[#1e3a5f] hover:bg-[#1e3a5f]/10 dark:border-blue-400/20 dark:bg-blue-400/5 dark:text-blue-400 dark:hover:bg-blue-400/10"
                >
                  <Sparkles className="h-3 w-3" />
                  AI 중복 검토
                </button>
                <span className="text-[10px] text-gray-400">리포트 생성 전 AI가 중복 기사를 확인합니다</span>
              </div>
            )}

            {dedupStep === 'checking' && (
              <div className="mt-4 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                AI가 중복 기사를 분석하고 있습니다…
              </div>
            )}

            {dedupStep === 'reviewing' && dedupGroups.length === 0 && (
              <div className="mt-4 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                중복 기사가 감지되지 않았습니다.
                <button
                  onClick={() => setDedupStep('applied')}
                  className="ml-auto font-semibold underline underline-offset-2"
                >
                  확인
                </button>
              </div>
            )}

            {dedupStep === 'reviewing' && dedupGroups.length > 0 && (
              <div className="mt-4 space-y-3">
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2.5 dark:border-amber-800/40 dark:bg-amber-900/20">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                  <p className="text-xs text-amber-800 dark:text-amber-300">
                    AI가 <span className="font-semibold">{totalDuplicateCount}건</span>의 중복 기사를 감지했습니다.
                    제외할 기사를 확인하고 적용하세요.
                  </p>
                </div>

                {dedupGroups.map((group) => {
                  const keepArticle = articles.find((a) => a.id === group.keepId);
                  return (
                    <div key={group.keepId} className="rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-700/40 dark:bg-gray-900/30">
                      <div className="border-b border-gray-100 px-3 py-2 dark:border-gray-700/30">
                        <div className="text-[10px] font-semibold uppercase tracking-widest text-emerald-600 dark:text-emerald-400">유지</div>
                        <div className="mt-0.5 text-xs font-medium text-gray-800 dark:text-gray-200">
                          {keepArticle?.title || group.keepId}
                        </div>
                        {keepArticle?.source && (
                          <div className="mt-0.5 text-[10px] text-gray-400">{keepArticle.source}</div>
                        )}
                      </div>
                      <div className="px-3 py-2">
                        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-red-500 dark:text-red-400">중복 (제외 대상)</div>
                        <div className="space-y-1.5">
                          {group.duplicateIds.map((dupId) => {
                            const dupArticle = articles.find((a) => a.id === dupId);
                            const isChecked = pendingExcludeIds.has(dupId);
                            return (
                              <label key={dupId} className="flex cursor-pointer items-start gap-2">
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={(e) => {
                                    setPendingExcludeIds((prev) => {
                                      const next = new Set(prev);
                                      if (e.target.checked) next.add(dupId);
                                      else next.delete(dupId);
                                      return next;
                                    });
                                  }}
                                  className="mt-0.5 accent-red-500"
                                />
                                <div className="min-w-0">
                                  <div className="text-xs text-gray-700 dark:text-gray-300">
                                    {dupArticle?.title || dupId}
                                  </div>
                                  {dupArticle?.source && (
                                    <div className="text-[10px] text-gray-400">{dupArticle.source}</div>
                                  )}
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  );
                })}

                <div className="flex items-center gap-2">
                  <button
                    onClick={handleApplyDedup}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#1e3a5f] px-4 py-2 text-xs font-semibold text-white hover:bg-[#24456f]"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    적용 ({pendingExcludeIds.size}건 제외)
                  </button>
                  <button
                    onClick={() => setDedupStep('idle')}
                    className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                  >
                    취소
                  </button>
                </div>
              </div>
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
          disabled={submitting || resolvedArticleIds.length === 0 || dedupStep === 'checking' || dedupStep === 'reviewing'}
          className="inline-flex items-center gap-2 rounded-xl bg-[#1e3a5f] px-6 py-2.5 text-sm font-semibold text-white hover:bg-[#24456f] disabled:opacity-50"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          내부 리포트 생성
        </button>
        {submitting && (
          <span className="text-xs text-gray-500 dark:text-gray-400">AI가 리포트를 생성하고 있습니다…</span>
        )}
        {(dedupStep === 'checking' || dedupStep === 'reviewing') && !submitting && (
          <span className="text-xs text-gray-500 dark:text-gray-400">중복 검토를 먼저 완료해주세요</span>
        )}
      </div>
    </div>
  );
}
