// src/pages/ManualEntry.tsx
import { useState } from 'react';
import { Send, FileText, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { ArticleCategory } from '@/types';
import { db, functions } from '@/lib/firebase';
import { httpsCallable } from 'firebase/functions';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { useAuthStore } from '@/store/useAuthStore';

export default function ManualEntry() {
  const { user } = useAuthStore();
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [source, setSource] = useState('수동입력');
  
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleAnalyze = async () => {
    if (!title.trim() || !content.trim()) {
      setError('제목과 본문을 모두 입력해주세요.');
      return;
    }

    setIsAnalyzing(true);
    setError('');
    setAnalysisResult(null);

    try {
      // Call Firebase Function for immediate AI analysis
      const analyzeArticleCallable = httpsCallable(functions, 'analyzeManualArticle');
      const result = await analyzeArticleCallable({
        title,
        content,
        url,
        source,
        publishedAt: new Date().toISOString(),
        companyId: (user as any)?.primaryCompanyId || null
      });

      const data = result.data as any;
      if (data.success) {
        setAnalysisResult(data.analysis);
      } else {
        setError(data.error || '분석 중 오류가 발생했습니다.');
      }
    } catch (err: any) {
      console.error('Analysis error:', err);
      setError('서버 연결 오류 또는 분석 실패: ' + err.message);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleSaveToBriefing = async () => {
    if (!analysisResult) return;

    try {
      const articleData = {
        title,
        url: url || `manual-${Date.now()}`,
        source,
        sourceId: 'manual',
        companyId: (user as any)?.primaryCompanyId || null,
        pipelineRunId: null,
        content,
        publishedAt: new Date(),
        collectedAt: serverTimestamp(),
        status: 'analyzed',
        summary: analysisResult.summary || [],
        category: analysisResult.category || '기타',
        companies: analysisResult.companies || { acquiror: null, target: null, financialSponsor: null },
        deal: analysisResult.deal || { type: '기타', amount: '비공개', stake: null },
        insights: analysisResult.insights || null,
        tags: analysisResult.tags || [],
        editedBy: user?.uid,
        publishedInOutputId: null,
      };

      await addDoc(collection(db, 'articles'), articleData);
      
      setSuccess('성공적으로 브리핑 큐에 추가되었습니다!');
      
      // Reset form after 2 seconds
      setTimeout(() => {
        setSuccess('');
        setTitle('');
        setContent('');
        setUrl('');
        setAnalysisResult(null);
      }, 2000);
      
    } catch (err: any) {
      console.error('Save error:', err);
      setError('저장 중 오류가 발생했습니다: ' + err.message);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">수동 기사 입력</h1>
        <p className="text-gray-600 dark:text-gray-400 mt-1">자동 수집이 어려운 기사를 직접 입력하고 AI 분석을 받으세요.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Input Form */}
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center">
            <FileText className="w-5 h-5 mr-2 text-[#1e3a5f] dark:text-blue-400" />
            기사 원문 입력
          </h2>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">제목 *</label>
              <input 
                type="text" 
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-[#1e3a5f] outline-none bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                placeholder="기사 제목을 입력하세요"
              />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">매체명</label>
                <input 
                  type="text" 
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-[#1e3a5f] outline-none bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  placeholder="예: 더벨"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">URL (선택)</label>
                <input 
                  type="url" 
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-[#1e3a5f] outline-none bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  placeholder="https://..."
                />
              </div>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">기사 본문 *</label>
              <textarea 
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-[#1e3a5f] outline-none h-64 resize-none bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                placeholder="기사 본문을 붙여넣으세요..."
              />
            </div>
            
            <button 
              onClick={handleAnalyze}
              disabled={isAnalyzing}
              className="w-full bg-[#1e3a5f] text-white py-3 rounded-lg font-medium hover:bg-[#2a4a73] transition-colors flex items-center justify-center disabled:opacity-50"
            >
              {isAnalyzing ? (
                <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> AI 분석 중...</>
              ) : (
                <><Send className="w-5 h-5 mr-2" /> 즉시 분석하기</>
              )}
            </button>
            
            {error && (
              <div className="p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800/30 rounded-lg flex items-start">
                <AlertCircle className="w-5 h-5 mr-2 flex-shrink-0 mt-0.5" />
                <span className="text-sm">{error}</span>
              </div>
            )}
          </div>
        </div>

        {/* Right: Analysis Result & Editor */}
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6 flex flex-col">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center">
            <CheckCircle2 className="w-5 h-5 mr-2 text-green-600 dark:text-green-400" />
            AI 분석 결과 및 수정
          </h2>
          
          {!analysisResult && !isAnalyzing && (
            <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500 border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-lg">
              좌측에서 기사를 입력하고 분석을 실행해주세요.
            </div>
          )}
          
          {isAnalyzing && (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-500 dark:text-gray-400 border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-lg">
              <Loader2 className="w-8 h-8 animate-spin mb-4 text-[#1e3a5f] dark:text-blue-400" />
              <p>AI 모델이 기사를 분석하고 있습니다...</p>
              <p className="text-sm mt-2">약 5~10초 정도 소요됩니다.</p>
            </div>
          )}
          
          {analysisResult && (
            <div className="space-y-4 flex-1 overflow-y-auto pr-2 custom-scrollbar">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">카테고리</label>
                <select 
                  value={analysisResult.category}
                  onChange={(e) => setAnalysisResult({...analysisResult, category: e.target.value as ArticleCategory})}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg outline-none bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                >
                  <option value="M&A 동향">M&A 동향</option>
                  <option value="PEF 동향">PEF 동향</option>
                  <option value="VC 투자">VC 투자</option>
                  <option value="펀드 레이징">펀드 레이징</option>
                  <option value="엑시트/IPO">엑시트/IPO</option>
                  <option value="규제/정책">규제/정책</option>
                  <option value="인물/기타">인물/기타</option>
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">3줄 요약</label>
                <textarea 
                  value={analysisResult.summary?.join('\n') || ''}
                  onChange={(e) => setAnalysisResult({...analysisResult, summary: e.target.value.split('\n')})}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg outline-none h-24 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">거래 규모</label>
                  <input 
                    type="text" 
                    value={analysisResult.deal?.amount || ''}
                    onChange={(e) => setAnalysisResult({...analysisResult, deal: {...analysisResult.deal, amount: e.target.value}})}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg outline-none bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">거래 유형</label>
                  <input 
                    type="text" 
                    value={analysisResult.deal?.type || ''}
                    onChange={(e) => setAnalysisResult({...analysisResult, deal: {...analysisResult.deal, type: e.target.value}})}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg outline-none bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  />
                </div>
              </div>
              
              <div className="space-y-2 border border-gray-200 dark:border-gray-700 p-3 rounded-lg bg-gray-50 dark:bg-gray-900">
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">관련 기업 정보</p>
                <div className="grid grid-cols-1 gap-2">
                  <input type="text" placeholder="인수자" value={analysisResult.companies?.acquiror || ''} onChange={(e) => setAnalysisResult({...analysisResult, companies: {...analysisResult.companies, acquiror: e.target.value}})} className="px-3 py-1.5 border dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                  <input type="text" placeholder="피인수자" value={analysisResult.companies?.target || ''} onChange={(e) => setAnalysisResult({...analysisResult, companies: {...analysisResult.companies, target: e.target.value}})} className="px-3 py-1.5 border dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                  <input type="text" placeholder="재무적 투자자" value={analysisResult.companies?.financialSponsor || ''} onChange={(e) => setAnalysisResult({...analysisResult, companies: {...analysisResult.companies, financialSponsor: e.target.value}})} className="px-3 py-1.5 border dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                </div>
              </div>
              
              <div className="pt-4 mt-4 border-t border-gray-100 dark:border-gray-700">
                {success && (
                  <div className="mb-3 p-3 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800/30 rounded-lg text-sm text-center">
                    {success}
                  </div>
                )}
                <button 
                  onClick={handleSaveToBriefing}
                  className="w-full bg-[#d4af37] text-white py-3 rounded-lg font-medium hover:bg-[#c19b26] transition-colors shadow-sm"
                >
                  수정 완료 및 데일리 브리핑에 추가
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
