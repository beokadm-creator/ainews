import { useState, useEffect, useRef } from 'react';
import { Download, Calendar, Loader2, Mail, Send, Clock } from 'lucide-react';
import { db, functions } from '@/lib/firebase';
import { collection, query, where, getDocs, doc, getDoc, orderBy, limit } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { useSearchParams, Link } from 'react-router-dom';
import html2pdf from 'html2pdf.js';
import { useAuthStore } from '@/store/useAuthStore';

const SECTION_TABS = [
  { key: 'all', label: '전체' },
  { key: 'domestic', label: '🇰🇷 국내' },
  { key: 'asian', label: '🌏 아시아' },
  { key: 'global', label: '🌐 글로벌' },
  { key: 'tech', label: '💻 테크' },
  { key: 'startup', label: '🚀 스타트업/PE·VC' },
];

export default function Briefing() {
  const [searchParams] = useSearchParams();
  const [output, setOutput] = useState<any>(null);
  const [recentOutputs, setRecentOutputs] = useState<any[]>([]);
  const [articles, setArticles] = useState<any[]>([]);
  const [sectionFilter, setSectionFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const pdfRef = useRef<HTMLDivElement>(null);
  const { user } = useAuthStore();
  const companyId = (user as any)?.primaryCompanyId || null;

  const fetchOutput = async (outputId: string) => {
    setLoading(true);
    setOutput(null);
    setArticles([]);

    try {
      const docRef = doc(db, 'outputs', outputId);
      const docSnap = await getDoc(docRef);
      if (!docSnap.exists()) return;

      const data = docSnap.data();
      setOutput({ id: docSnap.id, ...data });

      const articlesQuery = query(
        collection(db, 'articles'),
        where('publishedInOutputId', '==', outputId)
      );
      const articlesSnap = await getDocs(articlesQuery);
      setArticles(articlesSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    } finally {
      setLoading(false);
    }
  };

  // M-01 FIX: outputId 없이 접속 시 최신 output 목록 자동 로드
  const fetchRecentOutputs = async () => {
    if (!companyId) { setLoading(false); return; }
    setLoading(true);
    try {
      const q = query(
        collection(db, 'outputs'),
        where('companyId', '==', companyId),
        orderBy('createdAt', 'desc'),
        limit(5)
      );
      const snap = await getDocs(q);
      const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setRecentOutputs(items);
      // 가장 최신 output 자동 로드
      if (items.length > 0) {
        await fetchOutput(items[0].id);
        return;
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const outputId = searchParams.get('outputId');
    if (outputId) {
      fetchOutput(outputId);
    } else {
      fetchRecentOutputs();
    }
  }, [searchParams, companyId]);

  const downloadPDF = () => {
    if (!pdfRef.current || !output) return;

    html2pdf().from(pdfRef.current).set({
      margin: 10,
      filename: `output_${output.id}.pdf`,
      image: { type: 'jpeg' as const, quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm' as const, format: 'a4' as const, orientation: 'portrait' as const }
    }).save();
  };

  const handleSendEmail = async () => {
    if (!output) return;
    setSending(true);
    try {
      const sendEmailFn = httpsCallable(functions, 'triggerEmailSend');
      await sendEmailFn({ id: output.id, companyId: output.companyId });
      alert('Email queued.');
    } finally {
      setSending(false);
    }
  };

  const handleSendTelegram = async () => {
    if (!output) return;
    setSending(true);
    try {
      const sendTelegramFn = httpsCallable(functions, 'triggerTelegramSend');
      await sendTelegramFn({ id: output.id, companyId: output.companyId });
      alert('Telegram sent.');
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-[#1e3a5f]" />
      </div>
    );
  }

  if (!output) {
    return (
      <div className="space-y-4 max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Output</h1>
        {recentOutputs.length > 0 ? (
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
            <p className="px-6 py-4 text-sm font-semibold text-gray-500 dark:text-gray-400">최근 Output 목록</p>
            {recentOutputs.map(o => (
              <Link
                key={o.id}
                to={`/briefing?outputId=${o.id}`}
                className="flex items-center justify-between px-6 py-4 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
              >
                <div>
                  <p className="font-medium text-gray-900 dark:text-white">{o.title || 'Pipeline Output'}</p>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                    {o.createdAt?.toDate ? o.createdAt.toDate().toLocaleString('ko-KR') : o.id}
                    {o.articleCount ? ` · ${o.articleCount}건` : ''}
                  </p>
                </div>
                <Clock className="w-4 h-4 text-gray-400" />
              </Link>
            ))}
          </div>
        ) : (
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-12 text-center text-gray-500">
            <Clock className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">생성된 Output이 없습니다.</p>
            <p className="text-sm mt-1">Dashboard에서 파이프라인을 실행하면 여기에 결과가 표시됩니다.</p>
            <Link to="/" className="inline-block mt-4 px-4 py-2 bg-[#1e3a5f] text-white rounded-lg text-sm font-medium hover:bg-[#2a4a73] transition-colors">
              Dashboard로 이동
            </Link>
          </div>
        )}
      </div>
    );
  }

  const structured = output.structuredOutput || {};
  const highlights = structured.highlights || [];
  const trends = structured.trends || []; // ★ Added
  const themes = structured.themes || [];
  const risks = structured.risks || [];
  const opportunities = structured.opportunities || [];
  const nextSteps = structured.nextSteps || [];
  const visibleArticles = sectionFilter === 'all' ? articles : articles.filter(a => a.sourceCategory === sectionFilter);

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{output.title || 'Pipeline Output'}</h1>
          <p className="text-gray-600 mt-1">Generated output from the company-specific AI pipeline.</p>
        </div>

        <div className="flex items-center px-4 py-2 font-medium text-gray-800 bg-white rounded-lg border border-gray-200">
          <Calendar className="w-4 h-4 mr-2" />
          {output.createdAt?.toDate ? output.createdAt.toDate().toLocaleString() : output.id}
        </div>
      </div>

      <div className="flex flex-wrap gap-3 justify-end">
        <button onClick={downloadPDF} className="flex items-center px-4 py-2 bg-white border border-gray-300 rounded-lg shadow-sm text-sm font-medium text-gray-700 hover:bg-gray-50">
          <Download className="w-4 h-4 mr-2" /> PDF Download
        </button>
        <button onClick={handleSendEmail} disabled={sending} className="flex items-center px-4 py-2 bg-[#1e3a5f] text-white rounded-lg shadow-sm text-sm font-medium hover:bg-[#2a4a73] disabled:opacity-50">
          <Mail className="w-4 h-4 mr-2" /> Email
        </button>
        <button onClick={handleSendTelegram} disabled={sending} className="flex items-center px-4 py-2 bg-[#2CA5E0] text-white rounded-lg shadow-sm text-sm font-medium hover:bg-[#1f8cbf] disabled:opacity-50">
          <Send className="w-4 h-4 mr-2" /> Telegram
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div ref={pdfRef} className="p-8 bg-white space-y-10">
          <div className="text-center pb-8 border-b-2 border-[#1e3a5f]">
            <h1 className="text-3xl font-bold text-[#1e3a5f] mb-2">{output.title || 'AI Output'}</h1>
            <p className="text-lg text-gray-600 font-medium">{output.type}</p>
          </div>

          {structured.summary && (
            <section>
              <h2 className="text-xl font-bold text-[#1e3a5f] border-l-4 border-[#1e3a5f] pl-3 mb-4">핵심 요약 (Executive Summary)</h2>
              <p className="text-gray-700 whitespace-pre-wrap leading-relaxed">{structured.summary}</p>
            </section>
          )}

          {highlights.length > 0 && (
            <section>
              <h2 className="text-xl font-bold text-[#1e3a5f] border-l-4 border-[#1e3a5f] pl-3 mb-4">주요 뉴스 (Highlights)</h2>
              <div className="space-y-4">
                {highlights.map((highlight: any, index: number) => (
                  <div key={index} className="bg-gray-50 p-4 rounded-lg border border-gray-200">
                    <div className="flex justify-between items-start mb-2">
                      <h3 className="font-bold text-gray-900">{highlight.title}</h3>
                      {highlight.articleIndex && (
                        <a 
                          href={`#article-${highlight.articleIndex}`} 
                          className="text-[10px] bg-[#1e3a5f] text-white px-2 py-0.5 rounded hover:bg-[#2a4a73]"
                        >
                          Source [{highlight.articleIndex}]
                        </a>
                      )}
                    </div>
                    <p className="text-gray-700 text-sm leading-relaxed">{highlight.description}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {trends.length > 0 && (
            <section>
              <h2 className="text-xl font-bold text-[#1e3a5f] border-l-4 border-[#1e3a5f] pl-3 mb-4">최신 시장 동향 (Market Trends)</h2>
              <div className="space-y-4">
                {trends.map((trend: any, index: number) => (
                  <div key={index} className="bg-blue-50/30 p-4 rounded-lg border border-blue-100 dark:border-blue-900/20">
                    <div className="flex justify-between items-start mb-2">
                      <h3 className="font-bold text-blue-900">{trend.topic}</h3>
                      <div className="flex gap-1">
                        {(trend.relatedArticles || []).map((idx: number) => (
                          <a key={idx} href={`#article-${idx}`} className="text-[10px] bg-blue-600 text-white px-1.5 py-0.5 rounded hover:bg-blue-700">
                             [{idx}]
                          </a>
                        ))}
                      </div>
                    </div>
                    <p className="text-sm text-gray-700 leading-relaxed">{trend.description}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {themes.length > 0 && (
            <section>
              <h2 className="text-xl font-bold text-[#1e3a5f] border-l-4 border-[#1e3a5f] pl-3 mb-4">주요 테마 (Key Themes)</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {themes.map((theme: any, index: number) => (
                  <div key={index} className="border border-gray-200 p-4 rounded-lg">
                    <h3 className="font-bold text-[#1e3a5f] mb-2">{theme.name}</h3>
                    <p className="text-sm text-gray-600 leading-relaxed">{theme.description}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {(risks.length > 0 || opportunities.length > 0 || nextSteps.length > 0) && (
            <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[
                ['리스크 (Risks)', risks], 
                ['기회 요인 (Opportunities)', opportunities], 
                ['향후 전략 (Next Steps)', nextSteps]
              ].map(([title, items]: any) => (
                <div key={title} className="border border-gray-200 rounded-lg p-4">
                  <h3 className="font-bold text-[#1e3a5f] mb-3">{title}</h3>
                  <ul className="list-disc pl-5 space-y-2 text-sm text-gray-700">
                    {items.map((item: string, index: number) => <li key={index}>{item}</li>)}
                  </ul>
                </div>
              ))}
            </section>
          )}

          <section>
            <h2 className="text-xl font-bold text-[#1e3a5f] border-l-4 border-[#1e3a5f] pl-3 mb-4">참고 기사 전문 (Reference Articles)</h2>
            {articles.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-4 border-b border-gray-200 dark:border-gray-700 pb-3">
                {SECTION_TABS.filter(tab => tab.key === 'all' || articles.some(a => a.sourceCategory === tab.key)).map(tab => (
                  <button
                    key={tab.key}
                    onClick={() => setSectionFilter(tab.key)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                      sectionFilter === tab.key
                        ? 'bg-[#1e3a5f] text-white dark:bg-blue-600'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                    }`}
                  >
                    {tab.label} {tab.key !== 'all' ? `(${articles.filter(a => a.sourceCategory === tab.key).length})` : `(${articles.length})`}
                  </button>
                ))}
              </div>
            )}
            <div className="space-y-6">
              {visibleArticles.map((article: any, index: number) => (
                <div key={article.id} id={`article-${index + 1}`} className="border-b border-gray-100 pb-6 last:border-0 scroll-mt-20">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="inline-block px-1.5 py-0.5 bg-[#1e3a5f] text-white text-[10px] font-bold rounded">
                          [{index + 1}]
                        </span>
                        <span className="inline-block px-2 py-0.5 bg-gray-100 text-gray-600 text-[10px] rounded">
                          {article.category || '기타'}
                        </span>
                        <span className="text-[10px] text-gray-500">{article.source}</span>
                      </div>
                      <h3 className="text-base font-bold text-gray-900 mb-2">
                        <a href={article.url} target="_blank" rel="noreferrer" className="hover:text-[#1e3a5f] hover:underline">
                          {article.title}
                        </a>
                      </h3>
                      <ul className="list-disc pl-5 space-y-1 text-sm text-gray-700">
                        {(article.summary || []).map((line: string, idx: number) => (
                          <li key={idx}>{line}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
