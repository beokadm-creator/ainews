import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Download, Calendar, Loader2, Mail, Send, Clock,
  ArrowLeft, Tag, Newspaper, FileText, X, ChevronRight,
  Eye, ExternalLink, Search
} from 'lucide-react';
import { db, functions } from '@/lib/firebase';
import {
  collection, query, where, getDocs, doc, getDoc, orderBy, limit
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { useSearchParams, Link, useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { useAuthStore } from '@/store/useAuthStore';

// html2pdf.js 동적 임포트 (타입 선언)
declare const html2pdf: any;

// ─────────────────────────────────────────
// 기사 원문 팝업 컴포넌트
// ─────────────────────────────────────────
interface ArticleModalProps {
  article: any;
  refNumber: number;
  onClose: () => void;
}

function ArticleModal({ article, refNumber, onClose }: ArticleModalProps) {
  const formatDate = (ts: any) => {
    if (!ts) return '';
    try {
      const d = ts?.toDate ? ts.toDate() : new Date(ts);
      return format(d, 'yyyy.MM.dd HH:mm');
    } catch { return ''; }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[80vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-start justify-between bg-gray-50 dark:bg-gray-900/50">
          <div className="flex-1 min-w-0 pr-4">
            <div className="flex items-center gap-2 mb-1">
              <span className="w-6 h-6 rounded-full bg-[#1e3a5f] text-white text-xs font-bold flex items-center justify-center flex-shrink-0">
                {refNumber}
              </span>
              <span className="text-xs font-semibold text-gray-500 dark:text-gray-400">{article.source}</span>
              <span className="text-xs text-gray-400">{formatDate(article.publishedAt)}</span>
              {article.category && (
                <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 rounded">
                  {article.category}
                </span>
              )}
            </div>
            <h3 className="font-bold text-gray-900 dark:text-white text-sm leading-snug line-clamp-2">
              {article.title}
            </h3>
          </div>
          <button onClick={onClose} className="flex-shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 ml-2">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {(article.summary || []).length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">AI 요약</p>
              <ul className="space-y-1.5 pl-2">
                {article.summary.map((s: string, i: number) => (
                  <li key={i} className="text-sm text-gray-700 dark:text-gray-300 flex items-start gap-1.5">
                    <span className="text-gray-400 mt-0.5">·</span>{s}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {article.content && (
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">기사 원문</p>
              <div className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4 max-h-64 overflow-y-auto">
                {article.content}
              </div>
            </div>
          )}
          {!article.content && (!article.summary || article.summary.length === 0) && (
            <p className="text-sm text-gray-400 text-center py-4">원문 내용이 없습니다.</p>
          )}
        </div>

        {article.url && (
          <div className="px-6 py-3 border-t border-gray-100 dark:border-gray-700 flex items-center gap-3">
            <a
              href={article.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-[#1e3a5f] dark:text-blue-400 hover:underline"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              원문 링크
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────
// HTML 보고서 렌더러 컴포넌트
// ─────────────────────────────────────────
interface HtmlReportRendererProps {
  htmlContent: string;
  articles: any[];
  onFootnoteClick: (refNum: number) => void;
}

function HtmlReportRenderer({ htmlContent, articles, onFootnoteClick }: HtmlReportRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    // 각주 링크에 클릭 핸들러 주입
    const links = containerRef.current.querySelectorAll('a[data-ref], a.footnote-ref');
    links.forEach(link => {
      const refNum = parseInt((link as HTMLElement).dataset.ref || link.getAttribute('href')?.replace('#ref-', '') || '0');
      if (refNum > 0 && articles[refNum - 1]) {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          onFootnoteClick(refNum);
        });
        (link as HTMLElement).style.cursor = 'pointer';
      }
    });

    // ref-N id를 가진 anchor 클릭도 처리
    const refAnchors = containerRef.current.querySelectorAll('[id^="ref-"]');
    refAnchors.forEach(anchor => {
      const refNum = parseInt(anchor.id.replace('ref-', '') || '0');
      if (refNum > 0 && articles[refNum - 1]) {
        anchor.addEventListener('click', (e) => {
          e.preventDefault();
          onFootnoteClick(refNum);
        });
        (anchor as HTMLElement).style.cursor = 'pointer';
      }
    });
  }, [htmlContent, articles, onFootnoteClick]);

  // HTML에서 <body> 내부 또는 <article> 태그 내용만 추출
  const extractBody = (html: string) => {
    if (!html) return '';
    // 마크다운 코드 블록 태그 제거 (예: ```html ... ```)
    let cleaned = html.replace(/^```html\s*/i, '').replace(/```\s*$/i, '').trim();

    const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) return bodyMatch[1];
    const articleMatch = cleaned.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    if (articleMatch) return articleMatch[0];
    return cleaned;
  };

  return (
    <div
      ref={containerRef}
      className="report-html-content prose prose-gray dark:prose-invert max-w-none"
      dangerouslySetInnerHTML={{ __html: extractBody(htmlContent) }}
    />
  );
}

// ─────────────────────────────────────────
// 구조화 출력 보고서 (기존 형식)
// ─────────────────────────────────────────
function StructuredReport({ output, articles }: { output: any; articles: any[] }) {
  const structured = output.structuredOutput || {};
  const highlights = structured.highlights || [];
  const trends = structured.trends || [];
  const themes = structured.themes || [];
  const risks = structured.risks || [];
  const opportunities = structured.opportunities || [];
  const nextSteps = structured.nextSteps || [];

  const [articleModal, setArticleModal] = useState<{ article: any; refNum: number } | null>(null);

  const openRef = (idx: number) => {
    const article = articles[idx - 1];
    if (article) setArticleModal({ article, refNum: idx });
  };

  return (
    <div className="space-y-8">
      {articleModal && (
        <ArticleModal
          article={articleModal.article}
          refNumber={articleModal.refNum}
          onClose={() => setArticleModal(null)}
        />
      )}

      {structured.summary && (
        <section>
          <h2 className="text-xl font-bold text-[#1e3a5f] border-l-4 border-[#1e3a5f] pl-3 mb-4">핵심 요약</h2>
          <p className="text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">{structured.summary}</p>
        </section>
      )}

      {highlights.length > 0 && (
        <section>
          <h2 className="text-xl font-bold text-[#1e3a5f] border-l-4 border-[#1e3a5f] pl-3 mb-4">주요 이슈</h2>
          <div className="space-y-4">
            {highlights.map((h: any, i: number) => (
              <div key={i} className="bg-gray-50 dark:bg-gray-700/30 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                <div className="flex justify-between items-start mb-2">
                  <h3 className="font-bold text-gray-900 dark:text-white">{h.title}</h3>
                  {h.articleIndex && articles[h.articleIndex - 1] && (
                    <button
                      onClick={() => openRef(h.articleIndex)}
                      className="text-[10px] bg-[#1e3a5f] text-white px-2 py-0.5 rounded hover:bg-[#2a4a73] flex-shrink-0 ml-2"
                    >
                      [{h.articleIndex}]
                    </button>
                  )}
                </div>
                <p className="text-gray-700 dark:text-gray-300 text-sm leading-relaxed">{h.description}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {trends.length > 0 && (
        <section>
          <h2 className="text-xl font-bold text-[#1e3a5f] border-l-4 border-[#1e3a5f] pl-3 mb-4">시장 동향</h2>
          <div className="space-y-4">
            {trends.map((t: any, i: number) => (
              <div key={i} className="bg-blue-50/30 dark:bg-blue-900/10 p-4 rounded-lg border border-blue-100 dark:border-blue-900/20">
                <div className="flex justify-between items-start mb-2">
                  <h3 className="font-bold text-blue-900 dark:text-blue-300">{t.topic}</h3>
                  <div className="flex gap-1 ml-2">
                    {(t.relatedArticles || []).map((idx: number) => articles[idx - 1] ? (
                      <button key={idx} onClick={() => openRef(idx)}
                        className="text-[10px] bg-blue-600 text-white px-1.5 py-0.5 rounded hover:bg-blue-700">
                        [{idx}]
                      </button>
                    ) : null)}
                  </div>
                </div>
                <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">{t.description}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {themes.length > 0 && (
        <section>
          <h2 className="text-xl font-bold text-[#1e3a5f] border-l-4 border-[#1e3a5f] pl-3 mb-4">주요 테마</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {themes.map((t: any, i: number) => (
              <div key={i} className="border border-gray-200 dark:border-gray-700 p-4 rounded-lg">
                <h3 className="font-bold text-[#1e3a5f] dark:text-blue-400 mb-2">{t.name}</h3>
                <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">{t.description}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {(risks.length > 0 || opportunities.length > 0 || nextSteps.length > 0) && (
        <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            ['리스크', risks, 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-900/30'],
            ['기회요인', opportunities, 'bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-900/30'],
            ['향후 전망', nextSteps, 'bg-blue-50 dark:bg-blue-900/10 border-blue-200 dark:border-blue-900/30'],
          ].map(([title, items, cls]: any) => items.length > 0 ? (
            <div key={title} className={`border rounded-lg p-4 ${cls}`}>
              <h3 className="font-bold text-gray-800 dark:text-gray-200 mb-3">{title}</h3>
              <ul className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
                {items.map((item: string, i: number) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <span className="text-gray-400 mt-0.5">·</span>{item}
                  </li>
                ))}
              </ul>
            </div>
          ) : null)}
        </section>
      )}

      {/* 참고 기사 */}
      {articles.length > 0 && (
        <section>
          <h2 className="text-xl font-bold text-[#1e3a5f] border-l-4 border-[#1e3a5f] pl-3 mb-4">참고 기사</h2>
          <div className="space-y-3">
            {articles.map((article: any, idx: number) => (
              <div key={article.id} id={`article-${idx + 1}`}
                className="flex items-start gap-3 p-4 border border-gray-200 dark:border-gray-700 rounded-lg scroll-mt-20 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
                <span className="w-7 h-7 rounded-full bg-[#1e3a5f] text-white text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                  {idx + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <span className="text-xs font-semibold text-gray-600 dark:text-gray-400">{article.source}</span>
                    {article.category && (
                      <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-500 rounded">
                        {article.category}
                      </span>
                    )}
                    {article.publishedAt && (
                      <span className="text-xs text-gray-400">
                        {format(article.publishedAt?.toDate ? article.publishedAt.toDate() : new Date(article.publishedAt), 'yyyy.MM.dd')}
                      </span>
                    )}
                  </div>
                  <h4 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">{article.title}</h4>
                  {(article.summary || []).slice(0, 2).map((s: string, i: number) => (
                    <p key={i} className="text-xs text-gray-500 dark:text-gray-400 line-clamp-1">· {s}</p>
                  ))}
                </div>
                <button
                  onClick={() => openRef(idx + 1)}
                  className="flex-shrink-0 text-xs text-[#1e3a5f] dark:text-blue-400 border border-[#1e3a5f]/30 dark:border-blue-400/30 px-2.5 py-1 rounded hover:bg-[#1e3a5f]/5 transition-colors"
                >
                  원문 보기
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─────────────────────────────────────────
// 메인 Briefing 컴포넌트
// ─────────────────────────────────────────
export default function Briefing() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [output, setOutput] = useState<any>(null);
  const [recentOutputs, setRecentOutputs] = useState<any[]>([]);
  const [articles, setArticles] = useState<any[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [sending, setSending] = useState(false);
  const pdfRef = useRef<HTMLDivElement>(null);
  const { user } = useAuthStore();
  const companyId = (user as any)?.primaryCompanyId || null;
  const isSuperadmin = (user as any)?.role === 'superadmin';

  // 각주 팝업 상태
  const [activeRefArticle, setActiveRefArticle] = useState<{ article: any; refNum: number } | null>(null);

  const handleFootnoteClick = useCallback((refNum: number) => {
    const article = articles[refNum - 1];
    if (article) setActiveRefArticle({ article, refNum });
  }, [articles]);

  const fetchOutput = async (outputId: string) => {
    setLoadingDetail(true);
    setOutput(null);
    setArticles([]);
    try {
      const docSnap = await getDoc(doc(db, 'outputs', outputId));
      if (!docSnap.exists()) { setLoadingDetail(false); return; }
      const data = docSnap.data();
      setOutput({ id: docSnap.id, ...data });

      // 기사 로드: articleIds로 직접 조회 (custom_report) 또는 publishedInOutputId로 조회
      if (data.articleIds && data.articleIds.length > 0) {
        const articleDocs = await Promise.all(
          data.articleIds.map((id: string) => getDoc(doc(db, 'articles', id)))
        );
        setArticles(articleDocs.filter(d => d.exists()).map(d => ({ id: d.id, ...d.data() })));
      } else {
        const q = query(
          collection(db, 'articles'),
          where('publishedInOutputId', '==', outputId),
          ...(!isSuperadmin && companyId ? [where('companyId', '==', companyId)] : [])
        );
        const snap = await getDocs(q);
        setArticles(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      }
    } finally {
      setLoadingDetail(false);
    }
  };

  const fetchRecentOutputs = async () => {
    if (!companyId) { setLoadingList(false); return; }
    setLoadingList(true);
    try {
      const q = query(
        collection(db, 'outputs'),
        where('companyId', '==', companyId),
        orderBy('createdAt', 'desc'),
        limit(10)
      );
      const snap = await getDocs(q);
      const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setRecentOutputs(items);
    } finally {
      setLoadingList(false);
    }
  };

  useEffect(() => {
    fetchRecentOutputs();
  }, [companyId]);

  useEffect(() => {
    const outputId = searchParams.get('outputId');
    if (outputId) {
      fetchOutput(outputId);
    }
  }, [searchParams]);

  const downloadPDF = async () => {
    if (!pdfRef.current || !output) return;
    // html2pdf.js 동적 로드
    if (typeof html2pdf === 'undefined') {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
      document.head.appendChild(script);
      await new Promise(resolve => { script.onload = resolve; });
    }
    const title = output.title || 'report';
    html2pdf().from(pdfRef.current).set({
      margin: [10, 10, 10, 10],
      filename: `${title}_${format(new Date(), 'yyyyMMdd')}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    }).save();
  };

  const handleSendEmail = async () => {
    if (!output) return;
    setSending(true);
    try {
      await httpsCallable(functions, 'triggerEmailSend')({ id: output.id, companyId: output.companyId });
      alert('이메일 발송이 요청되었습니다.');
    } catch (err: any) {
      alert('이메일 발송 실패: ' + err.message);
    } finally {
      setSending(false);
    }
  };

  const handleSendTelegram = async () => {
    if (!output) return;
    setSending(true);
    try {
      await httpsCallable(functions, 'triggerTelegramSend')({ id: output.id, companyId: output.companyId });
      alert('텔레그램 발송이 완료되었습니다.');
    } catch (err: any) {
      alert('텔레그램 발송 실패: ' + err.message);
    } finally {
      setSending(false);
    }
  };

  const isHtmlReport = output?.type === 'custom_report' || (output?.htmlContent && output.htmlContent.length > 100);

  if (loadingList) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-[#1e3a5f]" />
      </div>
    );
  }

  // 보고서 목록 섹션 (항상 표시)
  const listSection = (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">보고서</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">생성된 분석 보고서 목록</p>
        </div>
        <Link
          to="/articles"
          className="flex items-center gap-2 px-4 py-2 bg-[#d4af37] text-white rounded-lg font-semibold text-sm hover:bg-[#b8942d] transition-colors"
        >
          <Search className="w-4 h-4" />
          기사 검색 · 새 보고서
        </Link>
      </div>

      {recentOutputs.length > 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
          {recentOutputs.map(o => (
            <button
              key={o.id}
              onClick={() => navigate(`/briefing?outputId=${o.id}`)}
              className="w-full text-left flex flex-col gap-2.5 px-6 py-4 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-gray-900 dark:text-white truncate">{o.title || '분석 보고서'}</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {o.createdAt?.toDate ? format(o.createdAt.toDate(), 'yyyy.MM.dd HH:mm') : ''}
                  </p>
                </div>
                {output?.id === o.id && <ChevronRight className="w-4 h-4 text-[#1e3a5f] flex-shrink-0" />}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {o.articleCount && (
                  <span className="text-xs text-gray-500 dark:text-gray-400">기사 {o.articleCount}건</span>
                )}
                {o.type && (
                  <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 rounded">
                    {o.type === 'custom_report' ? 'AI 분석' : o.type}
                  </span>
                )}
                {(o.keywords || []).slice(0, 2).map((k: string) => (
                  <span key={k} className="text-[10px] px-1.5 py-0.5 bg-[#1e3a5f]/10 dark:bg-[#1e3a5f]/30 text-[#1e3a5f] dark:text-blue-300 rounded">
                    {k}
                  </span>
                ))}
              </div>

              {o.analysisPrompt && (
                <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-1">분석 방향: {o.analysisPrompt}</p>
              )}

              {o.requestedBy && (
                <p className="text-xs text-gray-400 dark:text-gray-500">작성자: {o.requestedBy}</p>
              )}
            </button>
          ))}
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-12 text-center">
          <FileText className="w-10 h-10 mx-auto mb-3 text-gray-300 dark:text-gray-600" />
          <p className="font-medium text-gray-500 dark:text-gray-400">생성된 보고서가 없습니다.</p>
          <p className="text-sm text-gray-400 mt-1">기사를 검색하고 선택하여 첫 보고서를 만들어보세요.</p>
          <Link
            to="/articles"
            className="inline-flex items-center gap-2 mt-4 px-5 py-2.5 bg-[#1e3a5f] text-white rounded-lg text-sm font-medium hover:bg-[#2a4a73] transition-colors"
          >
            <Search className="w-4 h-4" />
            기사 검색하기
          </Link>
        </div>
      )}
    </div>
  );

  // 보고서 없음 → 목록만 표시
  if (!output) {
    return (
      <div className="max-w-5xl mx-auto">
        {listSection}
      </div>
    );
  }

  // 보고서 상세 섹션과 목록 함께 표시
  return (
    <div className="space-y-5 max-w-5xl mx-auto">
      {/* 목록 섹션 */}
      {listSection}

      {loadingDetail ? (
        <div className="flex items-center justify-center h-64 bg-white dark:bg-gray-800 rounded-xl">
          <Loader2 className="w-8 h-8 animate-spin text-[#1e3a5f]" />
        </div>
      ) : (
        <>
          {/* 각주 팝업 */}
          {activeRefArticle && (
            <ArticleModal
              article={activeRefArticle.article}
              refNumber={activeRefArticle.refNum}
              onClose={() => setActiveRefArticle(null)}
            />
          )}

          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
            <div>
              <button
                onClick={() => navigate('/briefing')}
                className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 mb-2"
              >
                <ArrowLeft className="w-4 h-4" />목록으로 돌아가기
              </button>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white leading-snug">
            {output.title || '분석 보고서'}
          </h1>
          <div className="flex flex-wrap items-center gap-2 mt-1.5">
            <span className="flex items-center gap-1 text-xs text-gray-400">
              <Calendar className="w-3.5 h-3.5" />
              {output.createdAt?.toDate ? format(output.createdAt.toDate(), 'yyyy.MM.dd HH:mm') : ''}
            </span>
            <span className="text-xs text-gray-400">· 기사 {articles.length}건</span>
            {(output.keywords || []).map((k: string) => (
              <span key={k} className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 bg-[#1e3a5f]/10 dark:bg-[#1e3a5f]/30 text-[#1e3a5f] dark:text-blue-300 rounded">
                <Tag className="w-2.5 h-2.5" />{k}
              </span>
            ))}
          </div>
          {output.analysisPrompt && (
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1 italic line-clamp-1">
              분석 방향: {output.analysisPrompt}
            </p>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={downloadPDF}
            className="flex items-center gap-1.5 px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
          >
            <Download className="w-4 h-4" />PDF
          </button>
          <button
            onClick={handleSendEmail}
            disabled={sending}
            className="flex items-center gap-1.5 px-3 py-2 bg-[#1e3a5f] text-white rounded-lg text-sm font-medium hover:bg-[#2a4a73] disabled:opacity-50 transition-colors"
          >
            <Mail className="w-4 h-4" />이메일
          </button>
          <button
            onClick={handleSendTelegram}
            disabled={sending}
            className="flex items-center gap-1.5 px-3 py-2 bg-[#2CA5E0] text-white rounded-lg text-sm font-medium hover:bg-[#1f8cbf] disabled:opacity-50 transition-colors"
          >
            <Send className="w-4 h-4" />텔레그램
          </button>
          <Link
            to="/articles"
            className="flex items-center gap-1.5 px-3 py-2 bg-[#d4af37] text-white rounded-lg text-sm font-medium hover:bg-[#b8942d] transition-colors"
          >
            <Search className="w-4 h-4" />새 보고서
          </Link>
        </div>
      </div>

      {/* 보고서 본문 */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div ref={pdfRef} className="p-6 sm:p-10 space-y-2">
          {/* PDF 헤더 */}
          <div className="text-center pb-6 border-b-2 border-[#1e3a5f] mb-8 print-only hidden">
            <h1 className="text-2xl font-bold text-[#1e3a5f]">{output.title || '분석 보고서'}</h1>
            <p className="text-gray-500 text-sm mt-1">
              생성일: {output.createdAt?.toDate ? format(output.createdAt.toDate(), 'yyyy.MM.dd HH:mm') : ''}
              {articles.length > 0 ? ` · 참고 기사 ${articles.length}건` : ''}
            </p>
          </div>

          {isHtmlReport ? (
            <>
              {/* 보고서 스타일 */}
              <style>{`
                .report-html-content { font-family: 'Inter', -apple-system, blinkmacsystemfont, sans-serif; color: #1e293b; line-height: 1.8; font-size: 1.05rem; }
                .report-html-content h1 { font-size: 2.25rem; font-weight: 800; background: linear-gradient(135deg, #1e3a8a, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 2.5rem; letter-spacing: -0.025em; border-bottom: 2px solid #f1f5f9; padding-bottom: 1.5rem; text-align: center; }
                .report-html-content h2 { font-size: 1.5rem; font-weight: 800; color: #0f172a; display: flex; align-items: center; margin: 3.5rem 0 1.5rem; padding-bottom: 0.75rem; border-bottom: 1px solid #e2e8f0; letter-spacing: -0.015em; }
                .report-html-content h2::before { content: ''; display: inline-block; width: 6px; height: 26px; background: linear-gradient(to bottom, #d4af37, #fde047); border-radius: 4px; margin-right: 14px; box-shadow: 0 0 10px rgba(212, 175, 55, 0.3); }
                .report-html-content h3 { font-size: 1.25rem; font-weight: 700; color: #1e293b; margin: 1.5rem 0 0.75rem; }
                .report-html-content p { color: #475569; margin-bottom: 1.25rem; }
                .report-html-content ul { padding-left: 0; list-style: none; }
                .report-html-content li { position: relative; padding-left: 1.7rem; margin-bottom: 0.85rem; color: #475569; }
                .report-html-content li::before { content: '✧'; position: absolute; left: 0; color: #d4af37; font-size: 1.1rem; top: 0; line-height: 1.6; }
                .report-html-content strong { color: #0f172a; font-weight: 700; }
                
                /* Summary Section (Glassmorphism & Gradients) */
                .report-html-content .section-summary { background: linear-gradient(145deg, #ffffff, #f8fafc); padding: 2.5rem; border-radius: 24px; box-shadow: 0 10px 40px -10px rgba(30, 58, 138, 0.08), inset 0 1px 0 rgba(255,255,255,1); border: 1px solid #e2e8f0; margin-bottom: 4rem; position: relative; overflow: hidden; }
                .report-html-content .section-summary::before { content: 'SUMMARY'; position: absolute; top: -15px; right: -15px; font-size: 8rem; font-weight: 900; color: rgba(59, 130, 246, 0.03); z-index: 0; pointer-events: none; letter-spacing: -0.05em; }
                .report-html-content .section-summary p { font-size: 1.15rem; color: #334155; font-weight: 500; position: relative; z-index: 1; line-height: 2; margin-bottom: 0; }

                /* Card items (Hover micro-animations) */
                .report-html-content .section-highlights > div, .report-html-content .section-trends > div, .report-html-content .section-risks > div, .report-html-content .section-outlook > div,
                .report-html-content .section-highlights > ul > li, .report-html-content .section-trends > ul > li, .report-html-content .section-risks > ul > li, .report-html-content .section-outlook > ul > li,
                .report-html-content .highlight-item, .report-html-content .trend-item {
                  background: white; border: 1px solid #e2e8f0; border-radius: 20px; padding: 2rem; margin-bottom: 1.5rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.02); transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
                }
                .report-html-content .section-highlights > ul > li::before, .report-html-content .section-trends > ul > li::before, .report-html-content .section-risks > ul > li::before, .report-html-content .section-outlook > ul > li::before { display: none; }
                .report-html-content .section-highlights > ul > li, .report-html-content .section-trends > ul > li, .report-html-content .section-risks > ul > li, .report-html-content .section-outlook > ul > li { padding-left: 2rem; }
                
                .report-html-content .section-highlights > div:hover, .report-html-content .section-trends > div:hover, .report-html-content .section-highlights > ul > li:hover, .report-html-content .section-trends > ul > li:hover, .report-html-content .highlight-item:hover, .report-html-content .trend-item:hover {
                  transform: translateY(-5px) scale(1.01); box-shadow: 0 20px 40px -10px rgba(0, 0, 0, 0.08); border-color: #cbd5e1;
                }

                .report-html-content .section-highlights > div, .report-html-content .section-highlights > ul > li, .report-html-content .highlight-item { border-left: 6px solid #3b82f6; }
                .report-html-content .section-trends > div, .report-html-content .section-trends > ul > li, .report-html-content .trend-item { border-left: 6px solid #8b5cf6; }
                .report-html-content .section-risks > div, .report-html-content .section-risks > ul > li, .report-html-content .risk-item { border-left: 6px solid #ef4444; background: #fef2f2; }
                .report-html-content .section-outlook > div, .report-html-content .section-outlook > ul > li, .report-html-content .outlook-item { border-left: 6px solid #10b981; }

                /* References */
                .report-html-content .section-references .reference-item, .report-html-content .section-references > div { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 16px; padding: 1.75rem; margin-bottom: 1.25rem; font-size: 0.95rem; transition: all 0.3s; }
                .report-html-content .section-references .reference-item:hover, .report-html-content .section-references > div:hover { background: #f1f5f9; box-shadow: 0 10px 20px -5px rgba(0,0,0,0.03); }

                /* Footnotes (Sleek pill badges) */
                .report-html-content a.footnote-ref, .report-html-content sup a {
                  display: inline-flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #1e3a8a, #2563eb); color: white !important; font-size: 0.75rem; font-weight: 700; padding: 0.2rem 0.65rem; border-radius: 999px; margin-left: 0.5rem; text-decoration: none; cursor: pointer; vertical-align: super; box-shadow: 0 4px 10px rgba(37, 99, 235, 0.3); transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); border: 1px solid rgba(255,255,255,0.1);
                }
                .report-html-content a.footnote-ref:hover, .report-html-content sup a:hover { transform: translateY(-3px) scale(1.05); box-shadow: 0 6px 15px rgba(37, 99, 235, 0.5); background: linear-gradient(135deg, #2563eb, #3b82f6); }

                /* Dark Mode Overrides for Premium Aesthetic */
                .dark .report-html-content { color: #e2e8f0; }
                .dark .report-html-content h1 { background: linear-gradient(135deg, #93c5fd, #bfdbfe); -webkit-background-clip: text; border-bottom-color: #1e293b; }
                .dark .report-html-content h2 { color: #f8fafc; border-bottom-color: #334155; }
                .dark .report-html-content h3, .dark .report-html-content strong { color: #f1f5f9; }
                .dark .report-html-content p, .dark .report-html-content li { color: #94a3b8; }
                .dark .report-html-content .section-summary { background: linear-gradient(145deg, #0f172a, #1e293b); border-color: #334155; box-shadow: 0 15px 35px -10px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05); }
                .dark .report-html-content .section-summary p { color: #e2e8f0; }
                
                .dark .report-html-content .section-highlights > div, .dark .report-html-content .section-trends > div, .dark .report-html-content .section-risks > div, .dark .report-html-content .section-outlook > div,
                .dark .report-html-content .section-highlights > ul > li, .dark .report-html-content .section-trends > ul > li, .dark .report-html-content .section-risks > ul > li, .dark .report-html-content .section-outlook > ul > li,
                .dark .report-html-content .highlight-item, .dark .report-html-content .trend-item {
                  background: #1e293b; border-color: #334155; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.2);
                }
                .dark .report-html-content .section-risks > div, .dark .report-html-content .section-risks > ul > li, .dark .report-html-content .risk-item { background: rgba(239, 68, 68, 0.05); border-color: rgba(239, 68, 68, 0.2); }
                .dark .report-html-content .section-references .reference-item, .dark .report-html-content .section-references > div { background: #1e293b; border-color: #334155; }
                .dark .report-html-content .section-references .reference-item:hover, .dark .report-html-content .section-references > div:hover { background: #334155; }
                .dark .report-html-content .section-highlights > div:hover, .dark .report-html-content .section-trends > div:hover, .dark .report-html-content .section-highlights > ul > li:hover, .dark .report-html-content .section-trends > ul > li:hover, .dark .report-html-content .highlight-item:hover, .dark .report-html-content .trend-item:hover { border-color: #60a5fa; box-shadow: 0 20px 40px -10px rgba(0, 0, 0, 0.4); }
                .dark .report-html-content a.footnote-ref, .dark .report-html-content sup a { background: linear-gradient(135deg, #3b82f6, #60a5fa); box-shadow: 0 4px 10px rgba(96, 165, 250, 0.2); }
              `}</style>
              <HtmlReportRenderer
                htmlContent={output.htmlContent || output.rawOutput || ''}
                articles={articles}
                onFootnoteClick={handleFootnoteClick}
              />
            </>
          ) : (
            <StructuredReport output={output} articles={articles} />
          )}
        </div>
      </div>

      {/* 관련 보고서 히스토리 */}
      {recentOutputs.filter(o => o.id !== output.id).length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
          <div className="px-5 py-3.5 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
            <span className="font-semibold text-sm text-gray-900 dark:text-white flex items-center gap-2">
              <Clock className="w-4 h-4 text-gray-400" />다른 보고서
            </span>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            {recentOutputs.filter(o => o.id !== output.id).slice(0, 5).map(o => (
              <Link
                key={o.id}
                to={`/briefing?outputId=${o.id}`}
                className="flex items-center justify-between px-5 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{o.title || '보고서'}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {o.createdAt?.toDate ? format(o.createdAt.toDate(), 'yyyy.MM.dd') : ''} · {o.articleCount || 0}건
                  </p>
                </div>
                <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0 ml-2" />
              </Link>
            ))}
          </div>
        </div>
      )}
        </>
      )}
    </div>
  );
}
