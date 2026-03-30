export type ArticleReasonBasis =
  | 'keyword_reject'
  | 'ai'
  | 'priority_source_override'
  | 'priority_source_fallback'
  | 'priority_source_bypass'
  | 'keyword_prefilter';

export interface ArticleReasonSource {
  relevanceBasis?: ArticleReasonBasis;
  relevanceReason?: string | null;
  aiRelevanceReason?: string | null;
  keywordPrefilterReason?: string | null;
  priorityAnalysisReason?: string | null;
}

function normalizeReasonText(value?: string | null) {
  return `${value || ''}`.replace(/\s+/g, ' ').trim();
}

function isInternalExclusionReason(value?: string | null) {
  const normalized = normalizeReasonText(value).toLowerCase();
  if (!normalized) return false;

  return [
    'sports context article',
    'contains excluded keyword',
    'missing required keyword',
    'company admin',
    'managed company',
    'does not belong to company',
  ].some((token) => normalized.includes(token));
}

export function getAnalysisBasisLabel(basis?: ArticleReasonBasis) {
  switch (basis) {
    case 'ai':
      return '전문 AI 관련성 검토 통과';
    case 'priority_source_override':
      return '우선 매체 예외로 분석 진행';
    case 'priority_source_fallback':
      return '우선 매체 예외 보류 통과로 분석 진행';
    case 'priority_source_bypass':
      return '우선 매체로 바로 분석 대상 반영';
    case 'keyword_prefilter':
      return '키워드 사전 필터 통과';
    case 'keyword_reject':
      return '';
    default:
      return '분석 단계 진행';
  }
}

export function getArticleReasonDetails(article: ArticleReasonSource) {
  const candidates = [
    article.aiRelevanceReason,
    article.relevanceReason,
    article.keywordPrefilterReason,
    article.priorityAnalysisReason,
  ].map(normalizeReasonText);

  const analysisReason = candidates.find((value) => value && !isInternalExclusionReason(value)) || '';
  const analysisBasisLabel = getAnalysisBasisLabel(article.relevanceBasis);

  return {
    analysisReason,
    analysisBasisLabel,
  };
}
