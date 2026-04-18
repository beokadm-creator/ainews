import { useState, useEffect, useCallback } from 'react';
import { getFunctions, httpsCallable } from 'firebase/functions';
import {
  Tags,
  Plus,
  Trash2,
  Save,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Search,
  Shield,
} from 'lucide-react';

interface KeywordConfig {
  titleKeywords: string[];
  trackedCompanies: string[];
}

// 딜 키워드 (엑셀 기준)
const DEAL_KEYWORDS = [
  '인수', '매각', '매물', '투자집행', '지분투자', '경영권투자',
  '인수금융', '바이아웃', '공동투자', 'exit', '엑시트', '회수',
  'IPO', '상장추진', '블록딜', 'PEF', '사모', 'M&A', 'PE',
];

export default function AdminKeywords() {
  const [config, setConfig] = useState<KeywordConfig>({ titleKeywords: [], trackedCompanies: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [newKeyword, setNewKeyword] = useState('');
  const [searchFilter, setSearchFilter] = useState('');
  const [newTrackedCompany, setNewTrackedCompany] = useState('');
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);

  const functions = getFunctions(undefined, 'us-central1');

  const loadKeywords = useCallback(async () => {
    setLoading(true);
    try {
      const fn = httpsCallable(functions, 'getGlobalKeywords');
      const result = await fn({});
      setConfig(result.data as KeywordConfig);
    } catch (err: any) {
      setMessage({ type: 'error', text: `로드 실패: ${err.message}` });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadKeywords(); }, [loadKeywords]);

  const saveKeywords = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const fn = httpsCallable(functions, 'saveGlobalKeywords');
      await fn({
        titleKeywords: config.titleKeywords,
        trackedCompanies: config.trackedCompanies,
      });
      setMessage({ type: 'success', text: `키워드 ${config.titleKeywords.length}개 저장 완료` });
    } catch (err: any) {
      setMessage({ type: 'error', text: `저장 실패: ${err.message}` });
    } finally {
      setSaving(false);
    }
  };

  const addKeyword = () => {
    const kw = newKeyword.trim();
    if (!kw || config.titleKeywords.includes(kw)) return;
    setConfig((prev) => ({ ...prev, titleKeywords: [...prev.titleKeywords, kw] }));
    setNewKeyword('');
  };

  const removeKeyword = (kw: string) => {
    setConfig((prev) => ({ ...prev, titleKeywords: prev.titleKeywords.filter((k) => k !== kw) }));
  };

  const addTrackedCompany = () => {
    const company = newTrackedCompany.trim();
    if (!company || config.trackedCompanies.includes(company)) return;
    setConfig((prev) => ({ ...prev, trackedCompanies: [...prev.trackedCompanies, company] }));
    setNewTrackedCompany('');
  };

  const removeTrackedCompany = (company: string) => {
    setConfig((prev) => ({ ...prev, trackedCompanies: prev.trackedCompanies.filter((item) => item !== company) }));
  };

  const handleResetAll = async () => {
    if (!resetConfirm) { setResetConfirm(true); return; }
    setResetting(true);
    setMessage(null);
    try {
      const { getAuth } = await import('firebase/auth');
      const auth = getAuth();
      const uid = auth.currentUser?.uid;
      if (!uid) throw new Error('로그인이 필요합니다');

      // Cloud Function 베이스 URL 가져오기 (us-central1)
      const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
      const url = `https://us-central1-${projectId}.cloudfunctions.net/resetAllArticlesHttp`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-uid': uid },
        body: JSON.stringify({ confirm: 'RESET_ALL_CONFIRMED' }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || '초기화 실패');
      setMessage({ type: 'success', text: data.message });
    } catch (err: any) {
      setMessage({ type: 'error', text: `초기화 실패: ${err.message}` });
    } finally {
      setResetting(false);
      setResetConfirm(false);
    }
  };

  const filteredKeywords = config.titleKeywords.filter((kw) =>
    !searchFilter || kw.toLowerCase().includes(searchFilter.toLowerCase())
  );

  const isDealKeyword = (kw: string) => DEAL_KEYWORDS.includes(kw);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-6 h-6 text-[#d4af37] animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Tags className="w-5 h-5 text-[#d4af37]" />
            글로벌 키워드 관리
          </h1>
          <p className="text-sm text-white/40 mt-1">
            기사 제목에 하나라도 포함되면(OR) 수집합니다. 우선 매체로 등록된 소스는 키워드 무관 전체 수집.
          </p>
        </div>
        <button
          onClick={saveKeywords}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-[#d4af37] text-gray-900 font-semibold text-sm rounded-lg hover:bg-[#e5c84b] disabled:opacity-50 transition-colors"
        >
          {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          저장
        </button>
      </div>

      {/* Message */}
      {message && (
        <div className={`flex items-center gap-2 px-4 py-3 rounded-lg text-sm font-medium ${
          message.type === 'success' ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'
        }`}>
          {message.type === 'success' ? <CheckCircle className="w-4 h-4 flex-shrink-0" /> : <AlertTriangle className="w-4 h-4 flex-shrink-0" />}
          {message.text}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-gray-900 border border-white/5 rounded-xl p-4">
          <p className="text-2xl font-bold text-white">{config.titleKeywords.length}</p>
          <p className="text-xs text-white/40 mt-1">전체 키워드</p>
        </div>
        <div className="bg-gray-900 border border-white/5 rounded-xl p-4">
          <p className="text-2xl font-bold text-[#d4af37]">{config.titleKeywords.filter(isDealKeyword).length}</p>
          <p className="text-xs text-white/40 mt-1">딜 키워드</p>
        </div>
        <div className="bg-gray-900 border border-white/5 rounded-xl p-4">
          <p className="text-2xl font-bold text-blue-400">{config.titleKeywords.filter((k) => !isDealKeyword(k)).length}</p>
          <p className="text-xs text-white/40 mt-1">PE하우스 키워드</p>
        </div>
      </div>

      {/* Add keyword */}
      <div className="bg-gray-900 border border-white/5 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-white mb-3">키워드 추가</h2>
        <div className="flex gap-2">
          <input
            value={newKeyword}
            onChange={(e) => setNewKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addKeyword()}
            placeholder="키워드 입력 후 Enter 또는 추가 버튼"
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/25 focus:outline-none focus:border-[#d4af37]/50"
          />
          <button
            onClick={addKeyword}
            className="flex items-center gap-1.5 px-3 py-2 bg-[#d4af37]/15 text-[#d4af37] border border-[#d4af37]/30 rounded-lg text-sm font-medium hover:bg-[#d4af37]/25 transition-colors"
          >
            <Plus className="w-4 h-4" />
            추가
          </button>
        </div>
      </div>

      {/* Keyword list */}
      <div className="bg-gray-900 border border-white/5 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-white">키워드 목록</h2>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30" />
            <input
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              placeholder="검색..."
              className="pl-8 pr-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs text-white placeholder-white/25 focus:outline-none focus:border-[#d4af37]/50 w-40"
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2 max-h-96 overflow-y-auto">
          {filteredKeywords.length === 0 && (
            <p className="text-sm text-white/30 py-4 w-full text-center">키워드가 없습니다</p>
          )}
          {filteredKeywords.map((kw) => (
            <span
              key={kw}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${
                isDealKeyword(kw)
                  ? 'bg-[#d4af37]/10 text-[#d4af37] border-[#d4af37]/25'
                  : 'bg-blue-500/10 text-blue-300 border-blue-500/20'
              }`}
            >
              {kw}
              <button
                onClick={() => removeKeyword(kw)}
                className="hover:opacity-70 transition-opacity"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>

        {searchFilter && (
          <p className="text-xs text-white/30 mt-3">
            {filteredKeywords.length}개 표시 (전체 {config.titleKeywords.length}개)
          </p>
        )}
      </div>

      <div className="bg-gray-900 border border-white/5 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-white mb-3">{'\uCD94\uC801 \uD68C\uC0AC \uBAA9\uB85D'}</h2>
        <div className="flex gap-2 mb-3">
          <input
            value={newTrackedCompany}
            onChange={(e) => setNewTrackedCompany(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addTrackedCompany()}
            placeholder={'\uD68C\uC0AC\uBA85 \uC785\uB825'}
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/25 focus:outline-none focus:border-[#d4af37]/50"
          />
          <button
            onClick={addTrackedCompany}
            className="flex items-center gap-1.5 px-3 py-2 bg-[#d4af37]/15 text-[#d4af37] border border-[#d4af37]/30 rounded-lg text-sm font-medium hover:bg-[#d4af37]/25 transition-colors"
          >
            <Plus className="w-4 h-4" />
            {'\uCD94\uAC00'}
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {(config.trackedCompanies || []).map((company) => (
            <span
              key={company}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border bg-purple-500/10 text-purple-300 border-purple-500/20"
            >
              {company}
              <button onClick={() => removeTrackedCompany(company)} className="hover:opacity-70 transition-opacity">
                <Trash2 className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* Danger zone: Reset all articles */}
      <div className="bg-red-900/10 border border-red-500/20 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-red-400 flex items-center gap-2 mb-2">
          <AlertTriangle className="w-4 h-4" />
          위험 구역 — 기사 전체 초기화
        </h2>
        <p className="text-xs text-white/40 mb-4">
          articles 컬렉션과 articleDedup 컬렉션을 전부 삭제합니다. 키워드 설정을 저장한 후에 실행하세요.
          이후 새 수집 사이클부터 키워드에 매칭된 기사만 저장됩니다.
        </p>
        {resetConfirm ? (
          <div className="flex gap-2">
            <button
              onClick={handleResetAll}
              disabled={resetting}
              className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white font-semibold text-sm rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
            >
              {resetting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              {resetting ? '초기화 중...' : '정말로 전체 삭제'}
            </button>
            <button
              onClick={() => setResetConfirm(false)}
              className="px-4 py-2 bg-white/5 text-white/60 text-sm rounded-lg hover:bg-white/10 transition-colors"
            >
              취소
            </button>
          </div>
        ) : (
          <button
            onClick={() => setResetConfirm(true)}
            className="flex items-center gap-2 px-4 py-2 border border-red-500/40 text-red-400 font-medium text-sm rounded-lg hover:bg-red-500/10 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            기사 전체 초기화 실행
          </button>
        )}
      </div>
    </div>
  );
}
