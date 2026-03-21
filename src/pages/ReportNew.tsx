import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  FileText, Tag, AlignLeft, Loader2, CheckCircle,
  ArrowLeft, X, Newspaper, Calendar, Sparkles, Info
} from 'lucide-react';
import { functions, db } from '@/lib/firebase';
import { httpsCallable } from 'firebase/functions';
import { doc, getDoc } from 'firebase/firestore';
import { format } from 'date-fns';
import { useAuthStore } from '@/store/useAuthStore';

const PROMPT_TEMPLATES = [
  {
    label: 'M&A 동향 분석',
    keywords: ['M&A', '인수합병', '지분매각'],
    prompt: '최근 M&A 및 인수합병 거래 동향을 분석하고, 주요 딜의 전략적 의미와 시장에 미치는 영향을 심층적으로 분석해주세요. PE(사모펀드)와 전략적 투자자의 움직임을 구분하여 분석하고, 향후 유사 거래 가능성도 전망해주세요.',
  },
  {
    label: 'VC/스타트업 투자 동향',
    keywords: ['VC', '스타트업', '투자', '시리즈'],
    prompt: '국내외 벤처캐피털 투자 동향과 주목할 스타트업 펀딩 현황을 분석해주세요. 주요 투자 섹터, 투자 규모 트렌드, 주목받는 기업들의 특징을 분석하고, 투자 시장의 온도계를 진단해주세요.',
  },
  {
    label: 'IPO·엑시트 전략 분석',
    keywords: ['IPO', '상장', '엑시트', '회수'],
    prompt: '최근 IPO 준비 기업과 PE 엑시트 사례를 분석해주세요. 상장 추진 배경, 시장 환경, 밸류에이션 수준 등을 분석하고, 투자자 관점에서의 수익률과 향후 시장 영향을 전망해주세요.',
  },
  {
    label: '펀드레이징 & 기관투자 동향',
    keywords: ['펀드', '블라인드펀드', 'LP', '기관투자자'],
    prompt: '최근 PE/VC 펀드 조성 현황과 기관투자자 동향을 분석해주세요. 주요 GP들의 펀드레이징 전략과 LP 구성 변화, 시장 분위기를 분석하고, 자금 흐름이 향후 투자 시장에 미치는 영향을 분석해주세요.',
  },
  {
    label: '자유 형식',
    keywords: [],
    prompt: '',
  },
];

interface ArticlePreview {
  id: string;
  title: string;
  source: string;
  publishedAt: any;
  status: string;
  summary: string[];
  category: string;
}

export default function ReportNew() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const companyId = (user as any)?.primaryCompanyId || (user as any)?.companyIds?.[0] || null;

  const articleIdsParam = searchParams.get('articleIds') || '';
  const articleIds = articleIdsParam ? articleIdsParam.split(',').filter(Boolean) : [];

  const [articles, setArticles] = useState<ArticlePreview[]>([]);
  const [loadingArticles, setLoadingArticles] = useState(false);

  const [reportTitle, setReportTitle] = useState('');
  const [keywords, setKeywords] = useState<string[]>([]);
  const [keywordInput, setKeywordInput] = useState('');
  const [analysisPrompt, setAnalysisPrompt] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<number | null>(null);

  const [generating, setGenerating] = useState(false);
  const [done, setDone] = useState(false);
  const [outputId, setOutputId] = useState('');

  useEffect(() => {
    if (articleIds.length > 0) loadArticles();
  }, [articleIdsParam]);

  const loadArticles = async () => {
    setLoadingArticles(true);
    try {
      const docs = await Promise.all(
        articleIds.map(id => getDoc(doc(db, 'articles', id)))
      );
      setArticles(
        docs
          .filter(d => d.exists())
          .map(d => ({ id: d.id, ...d.data() as any }))
      );
    } catch (err) {
      console.error('loadArticles error:', err);
    } finally {
      setLoadingArticles(false);
    }
  };

  const addKeyword = () => {
    const v = keywordInput.trim();
    if (v && !keywords.includes(v)) setKeywords(prev => [...prev, v]);
    setKeywordInput('');
  };

  const applyTemplate = (idx: number) => {
    const t = PROMPT_TEMPLATES[idx];
    setSelectedTemplate(idx);
    if (t.keywords.length > 0) setKeywords(t.keywords);
    setAnalysisPrompt(t.prompt);
  };

  const handleGenerate = async () => {
    if (articleIds.length === 0) {
      alert('기사를 선택해주세요.');
      return;
    }
    if (!companyId) {
      alert('회사 정보가 없습니다.');
      return;
    }

    setGenerating(true);
    try {
      const fn = httpsCallable(functions, 'generateReport');
      const result = await fn({
        companyId,
        articleIds,
        keywords,
        analysisPrompt,
        reportTitle: reportTitle || undefined,
      }) as any;

      if (result.data?.success) {
        setOutputId(result.data.outputId);
        setDone(true);
      } else {
        throw new Error('보고서 생성 실패');
      }
    } catch (err: any) {
      console.error('generateReport error:', err);
      alert('보고서 생성 실패: ' + (err.message || '알 수 없는 오류'));
    } finally {
      setGenerating(false);
    }
  };

  const formatDate = (ts: any) => {
    if (!ts) return '';
    try {
      const d = ts?.toDate ? ts.toDate() : new Date(ts);
      return format(d, 'yyyy.MM.dd');
    } catch { return ''; }
  };

  if (done) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center space-y-5">
        <div className="w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto">
          <CheckCircle className="w-8 h-8 text-green-600 dark:text-green-400" />
        </div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">보고서 생성 완료!</h2>
        <p className="text-gray-500 dark:text-gray-400">AI가 분석 보고서를 성공적으로 작성했습니다.</p>
        <div className="flex items-center justify-center gap-3 pt-2">
          <button
            onClick={() => navigate(`/briefing?outputId=${outputId}`)}
            className="flex items-center gap-2 px-6 py-3 bg-[#1e3a5f] text-white rounded-xl font-semibold hover:bg-[#2a4a73] transition-colors"
          >
            <FileText className="w-5 h-5" />
            보고서 보기
          </button>
          <button
            onClick={() => navigate('/articles')}
            className="px-5 py-3 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-xl font-medium hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            새 보고서 만들기
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-12">
      {/* Header */}
      <div>
        <button
          onClick={() => navigate('/articles')}
          className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 mb-3"
        >
          <ArrowLeft className="w-4 h-4" /> 기사 검색으로
        </button>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">분석 보고서 생성</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          선택한 기사를 바탕으로 AI가 전문 분석 보고서를 작성합니다.
        </p>
      </div>

      {/* 선택된 기사 목록 */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Newspaper className="w-4 h-4 text-[#1e3a5f] dark:text-blue-400" />
            <span className="font-semibold text-sm text-gray-900 dark:text-white">
              선택된 기사 ({articleIds.length}건)
            </span>
          </div>
          <button
            onClick={() => navigate('/articles')}
            className="text-xs text-[#1e3a5f] dark:text-blue-400 hover:underline"
          >
            기사 변경
          </button>
        </div>

        {loadingArticles ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-gray-300" />
          </div>
        ) : articles.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-gray-400">
            <p>선택된 기사가 없습니다.</p>
            <button onClick={() => navigate('/articles')} className="mt-2 text-[#1e3a5f] dark:text-blue-400 underline">기사 검색으로 이동</button>
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-700 max-h-60 overflow-y-auto">
            {articles.map((article, idx) => (
              <div key={article.id} className="flex items-start gap-3 px-5 py-3">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[#1e3a5f] text-white text-[10px] font-bold flex items-center justify-center mt-0.5">
                  {idx + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-white line-clamp-1">{article.title}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    <span className="font-medium text-gray-500">{article.source}</span>
                    {article.publishedAt && ` · ${formatDate(article.publishedAt)}`}
                    {article.category && ` · ${article.category}`}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 프롬프트 템플릿 */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-[#d4af37]" />
          <h2 className="font-semibold text-sm text-gray-900 dark:text-white">분석 템플릿 (선택)</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          {PROMPT_TEMPLATES.map((t, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => applyTemplate(idx)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                selectedTemplate === idx
                  ? 'bg-[#1e3a5f] text-white border-[#1e3a5f]'
                  : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600 hover:border-gray-400'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* 보고서 설정 */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-5 space-y-5">
        <h2 className="font-semibold text-sm text-gray-900 dark:text-white flex items-center gap-2">
          <FileText className="w-4 h-4 text-[#1e3a5f] dark:text-blue-400" />
          보고서 설정
        </h2>

        {/* 보고서 제목 */}
        <div>
          <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5">
            보고서 제목 (선택, 미입력 시 AI가 자동 생성)
          </label>
          <input
            type="text"
            value={reportTitle}
            onChange={e => setReportTitle(e.target.value)}
            placeholder="예: 2026년 1분기 국내 M&A 동향 분석"
            className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm outline-none focus:ring-2 focus:ring-[#1e3a5f] text-gray-900 dark:text-white placeholder-gray-400"
          />
        </div>

        {/* 핵심 키워드 */}
        <div>
          <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5">
            <Tag className="inline w-3.5 h-3.5 mr-1" />핵심 분석 키워드
          </label>
          <div className="flex flex-wrap items-center gap-1.5 min-h-[40px] px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg">
            {keywords.map(k => (
              <span key={k} className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#1e3a5f]/10 dark:bg-[#1e3a5f]/30 text-[#1e3a5f] dark:text-blue-300 rounded text-xs font-medium">
                {k}
                <button type="button" onClick={() => setKeywords(prev => prev.filter(x => x !== k))}>
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
            <input
              value={keywordInput}
              onChange={e => setKeywordInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addKeyword(); } }}
              placeholder={keywords.length === 0 ? '키워드 입력 후 Enter...' : ''}
              className="flex-1 min-w-[120px] outline-none text-sm bg-transparent text-gray-900 dark:text-white placeholder-gray-400"
            />
          </div>
          <p className="text-xs text-gray-400 mt-1">AI가 이 키워드를 중심으로 분석 방향을 잡습니다.</p>
        </div>

        {/* 분석 방향 */}
        <div>
          <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5">
            <AlignLeft className="inline w-3.5 h-3.5 mr-1" />분석 방향 및 요청사항
          </label>
          <textarea
            value={analysisPrompt}
            onChange={e => setAnalysisPrompt(e.target.value)}
            rows={5}
            placeholder="예: M&A 거래 규모와 밸류에이션 수준을 집중 분석해주세요. PE 투자자 관점에서의 리스크와 기회요인을 중점적으로 다뤄주세요. 특히 최근 금리 환경이 딜 구조에 미치는 영향도 포함해주세요."
            className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm outline-none focus:ring-2 focus:ring-[#1e3a5f] text-gray-900 dark:text-white placeholder-gray-400 resize-none"
          />
          <div className="flex items-start gap-1.5 mt-2">
            <Info className="w-3.5 h-3.5 text-blue-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-gray-400">
              자연어로 자유롭게 작성하세요. AI가 이 지시사항을 바탕으로 분석 보고서를 작성합니다.
              비워두면 AI가 선택한 기사에서 가장 중요한 인사이트를 자동으로 도출합니다.
            </p>
          </div>
        </div>
      </div>

      {/* 생성 버튼 */}
      <div className="flex items-center gap-4">
        <button
          onClick={handleGenerate}
          disabled={generating || articleIds.length === 0}
          className="flex items-center gap-2.5 px-8 py-3.5 bg-[#1e3a5f] text-white rounded-xl font-bold text-sm hover:bg-[#2a4a73] transition-colors disabled:opacity-50 shadow-md"
        >
          {generating ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              AI 보고서 작성 중... (1~3분 소요)
            </>
          ) : (
            <>
              <Sparkles className="w-5 h-5" />
              분석 보고서 생성하기
            </>
          )}
        </button>
        {generating && (
          <p className="text-sm text-gray-400">
            선택한 {articleIds.length}건의 기사를 AI가 분석하고 있습니다.
          </p>
        )}
      </div>

      {generating && (
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <Loader2 className="w-5 h-5 animate-spin text-blue-500 flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-blue-800 dark:text-blue-300">보고서 생성 중...</p>
              <p className="text-xs text-blue-600 dark:text-blue-400 mt-0.5">
                AI가 {articleIds.length}건의 기사를 분석하고 전문 보고서를 작성하고 있습니다.
                보통 1~3분 정도 소요됩니다. 이 페이지를 벗어나지 마세요.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
