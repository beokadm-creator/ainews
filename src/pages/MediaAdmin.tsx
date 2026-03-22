import { useState, useEffect, useCallback } from 'react';
import {
  Globe, Plus, Edit2, Trash2, RefreshCw, CheckCircle2, XCircle, AlertTriangle,
  Loader2, Rss, Code2, Cpu, Mail, Star, Search, Activity,
  ChevronDown, ChevronUp, Zap, Clock, BarChart2, Lock, Unlock
} from 'lucide-react';
import { httpsCallable } from 'firebase/functions';
import { collection, getDocs, orderBy, query, getCountFromServer, where, limit } from 'firebase/firestore';
import { functions, db } from '@/lib/firebase';
import { useAuthStore } from '@/store/useAuthStore';
import { getAuth } from 'firebase/auth';
import { format } from 'date-fns';

// ─── Types ──────────────────────────────────────────────────────
type SourceType = 'rss' | 'scraping' | 'puppeteer' | 'api' | 'newsletter';
type PricingTier = 'free' | 'paid' | 'requires_subscription';
type SourceStatus = 'active' | 'inactive' | 'error' | 'testing';
type TabId = 'all' | 'health' | 'errors';

interface GlobalSource {
  id: string;
  name: string;
  description?: string;
  url: string;
  type: SourceType;
  language: 'ko' | 'en' | 'ja' | 'zh';
  relevanceScore: 1 | 2 | 3 | 4 | 5;
  category: string;
  rssUrl?: string;
  apiEndpoint?: string;
  apiType?: 'naver' | 'newsapi' | 'custom';
  apiKeyRequired?: boolean;
  listSelector?: string;
  titleSelector?: string;
  linkSelector?: string;
  contentSelector?: string;
  dateSelector?: string;
  loginRequired?: boolean;
  defaultKeywords: string[];
  status: SourceStatus;
  lastTestedAt?: any;
  lastTestResult?: {
    success: boolean;
    message: string;
    articlesFound?: number;
    latencyMs?: number;
  };
  notes?: string;
  pricingTier: PricingTier;
  allowedCompanyIds?: string[];
  localScraperId?: string;
}

interface SourceHealth {
  sourceId: string;
  todayCount: number;
  lastCollectedAt: any;
  status: 'ok' | 'idle' | 'error';
}

// ─── Constants ──────────────────────────────────────────────────
const TYPE_META: Record<SourceType, { label: string; icon: any; color: string; bg: string }> = {
  rss:        { label: 'RSS',        icon: Rss,    color: 'text-orange-500',  bg: 'bg-orange-500/10' },
  scraping:   { label: 'Scraping',   icon: Code2,  color: 'text-purple-500',  bg: 'bg-purple-500/10' },
  puppeteer:  { label: 'Puppeteer',  icon: Cpu,    color: 'text-indigo-400',  bg: 'bg-indigo-500/10' },
  api:        { label: 'API',        icon: Globe,  color: 'text-blue-400',    bg: 'bg-blue-500/10' },
  newsletter: { label: 'Newsletter', icon: Mail,   color: 'text-green-400',   bg: 'bg-green-500/10' },
};

const STATUS_META: Record<SourceStatus, { label: string; color: string; dot: string }> = {
  active:   { label: '활성',    color: 'text-green-400',  dot: 'bg-green-400' },
  inactive: { label: '비활성',  color: 'text-gray-400',   dot: 'bg-gray-500' },
  error:    { label: '오류',    color: 'text-red-400',    dot: 'bg-red-400' },
  testing:  { label: '테스트중', color: 'text-yellow-400', dot: 'bg-yellow-400' },
};

const CATEGORY_OPTIONS = [
  { value: 'all',      label: '전체 분야' },
  { value: 'domestic', label: '국내' },
  { value: 'asian',    label: '아시아' },
  { value: 'global',   label: '글로벌' },
  { value: 'tech',     label: '테크' },
  { value: 'startup',  label: '스타트업/PE·VC' },
  { value: 'M&A',      label: 'M&A / 유료 매체' },
];

const BLANK_SOURCE: Partial<GlobalSource> = {
  type: 'rss',
  language: 'ko',
  relevanceScore: 3,
  category: 'domestic',
  status: 'inactive',
  pricingTier: 'free',
  defaultKeywords: ['M&A', '인수', '합병'],
  loginRequired: false,
};

// ─── Sub-components ─────────────────────────────────────────────
function TypeBadge({ type }: { type: SourceType }) {
  const m = TYPE_META[type] || TYPE_META.rss;
  const Icon = m.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold ${m.color} ${m.bg}`}>
      <Icon className="w-2.5 h-2.5" />{m.label}
    </span>
  );
}

function StatusDot({ status }: { status: SourceStatus }) {
  const m = STATUS_META[status] || STATUS_META.inactive;
  return (
    <span className="flex items-center gap-1.5">
      <span className={`w-1.5 h-1.5 rounded-full ${m.dot}`} />
      <span className={`text-xs ${m.color}`}>{m.label}</span>
    </span>
  );
}

function HealthBadge({ health }: { health?: SourceHealth }) {
  if (!health) return <span className="text-xs text-white/30">—</span>;
  const color = health.status === 'ok' ? 'text-green-400' : health.status === 'error' ? 'text-red-400' : 'text-yellow-400';
  const lastStr = health.lastCollectedAt?.toDate
    ? format(health.lastCollectedAt.toDate(), 'MM/dd HH:mm')
    : health.lastCollectedAt?._seconds
      ? format(new Date(health.lastCollectedAt._seconds * 1000), 'MM/dd HH:mm')
      : '—';
  return (
    <div className="text-xs">
      <span className={`font-semibold ${color}`}>{health.todayCount}건</span>
      <span className="text-white/30 ml-1">{lastStr}</span>
    </div>
  );
}

// ─── Source Edit Modal ──────────────────────────────────────────
function SourceModal({
  source, onSave, onClose, saving
}: {
  source: Partial<GlobalSource>;
  onSave: (s: Partial<GlobalSource>) => void;
  onClose: () => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<Partial<GlobalSource>>(source);
  const set = (k: keyof GlobalSource, v: any) => setForm(p => ({ ...p, [k]: v }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-[#141c2e] border border-white/10 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b border-white/10">
          <h2 className="text-lg font-bold text-white">{form.id ? '매체 편집' : '새 매체 추가'}</h2>
        </div>
        <div className="p-6 space-y-4">
          {/* Row 1 */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-white/50 mb-1">매체명 *</label>
              <input value={form.name || ''} onChange={e => set('name', e.target.value)}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-blue-500/50" />
            </div>
            <div>
              <label className="block text-xs text-white/50 mb-1">수집 방식 *</label>
              <select value={form.type || 'rss'} onChange={e => set('type', e.target.value)}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none">
                {Object.entries(TYPE_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
              </select>
            </div>
          </div>
          {/* Row 2 */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-white/50 mb-1">분야</label>
              <select value={form.category || 'domestic'} onChange={e => set('category', e.target.value)}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none">
                {CATEGORY_OPTIONS.filter(o => o.value !== 'all').map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-white/50 mb-1">상태</label>
              <select value={form.status || 'inactive'} onChange={e => set('status', e.target.value as SourceStatus)}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none">
                <option value="active">활성</option>
                <option value="inactive">비활성</option>
                <option value="error">오류</option>
              </select>
            </div>
          </div>
          {/* URLs */}
          <div>
            <label className="block text-xs text-white/50 mb-1">사이트 URL *</label>
            <input value={form.url || ''} onChange={e => set('url', e.target.value)}
              placeholder="https://..."
              className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-blue-500/50" />
          </div>
          {(form.type === 'rss') && (
            <div>
              <label className="block text-xs text-white/50 mb-1">RSS URL</label>
              <input value={form.rssUrl || ''} onChange={e => set('rssUrl', e.target.value)}
                placeholder="https://.../feed"
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-blue-500/50" />
            </div>
          )}
          {(form.type === 'api') && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-white/50 mb-1">API 종류</label>
                <select value={(form as any).apiType || ''} onChange={e => set('apiType', e.target.value)}
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-blue-500/50">
                  <option value="">선택...</option>
                  <option value="naver">네이버 뉴스 검색 API</option>
                  <option value="newsapi">NewsAPI.org</option>
                  <option value="custom">커스텀 엔드포인트</option>
                </select>
              </div>
              {(form as any).apiType !== 'naver' && (
                <div>
                  <label className="block text-xs text-white/50 mb-1">API 엔드포인트</label>
                  <input value={form.apiEndpoint || ''} onChange={e => set('apiEndpoint', e.target.value)}
                    placeholder="https://api..."
                    className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-blue-500/50" />
                </div>
              )}
              {(form as any).apiType === 'naver' && (
                <p className="text-xs text-blue-300/70 bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2">
                  네이버 API 자격증명은 슈퍼어드민 → AI 설정 → 네이버 탭에서 설정합니다.
                  아래 "기본 키워드"에 검색할 키워드를 입력하세요 (쉼표 구분).
                </p>
              )}
            </div>
          )}
          {(form.type === 'scraping' || form.type === 'puppeteer') && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-white/50 mb-1">목록 셀렉터</label>
                <input value={form.listSelector || ''} onChange={e => set('listSelector', e.target.value)}
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none" />
              </div>
              <div>
                <label className="block text-xs text-white/50 mb-1">제목 셀렉터</label>
                <input value={form.titleSelector || ''} onChange={e => set('titleSelector', e.target.value)}
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none" />
              </div>
              <div>
                <label className="block text-xs text-white/50 mb-1">링크 셀렉터</label>
                <input value={form.linkSelector || ''} onChange={e => set('linkSelector', e.target.value)}
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none" />
              </div>
              <div>
                <label className="block text-xs text-white/50 mb-1">날짜 셀렉터</label>
                <input value={form.dateSelector || ''} onChange={e => set('dateSelector', e.target.value)}
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none" />
              </div>
            </div>
          )}
          {/* Meta */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-white/50 mb-1">언어</label>
              <select value={form.language || 'ko'} onChange={e => set('language', e.target.value)}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none">
                <option value="ko">한국어</option><option value="en">영어</option>
                <option value="ja">일본어</option><option value="zh">중국어</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-white/50 mb-1">요금</label>
              <select value={form.pricingTier || 'free'} onChange={e => set('pricingTier', e.target.value as PricingTier)}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none">
                <option value="free">무료</option>
                <option value="paid">유료</option>
                <option value="requires_subscription">구독 필요</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-white/50 mb-1">중요도</label>
              <select value={form.relevanceScore || 3} onChange={e => set('relevanceScore', Number(e.target.value))}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none">
                {[1,2,3,4,5].map(n => <option key={n} value={n}>{'★'.repeat(n)}</option>)}
              </select>
            </div>
          </div>
          {/* Description */}
          <div>
            <label className="block text-xs text-white/50 mb-1">설명</label>
            <textarea value={form.description || ''} onChange={e => set('description', e.target.value)} rows={2}
              className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none resize-none" />
          </div>
          {/* Keywords */}
          <div>
            <label className="block text-xs text-white/50 mb-1">기본 키워드 (쉼표 구분)</label>
            <input
              value={(form.defaultKeywords || []).join(', ')}
              onChange={e => set('defaultKeywords', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
              className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none" />
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="loginRequired" checked={!!form.loginRequired}
              onChange={e => set('loginRequired', e.target.checked)} className="rounded" />
            <label htmlFor="loginRequired" className="text-sm text-white/70">로그인 필요 (유료/구독)</label>
          </div>
          {(form.pricingTier === 'paid' || form.pricingTier === 'requires_subscription') && (
            <div>
              <label className="block text-xs text-white/50 mb-1">허용 고객사 ID (쉼표 구분, 비워두면 전체 유료 회사)</label>
              <input
                value={(form.allowedCompanyIds || []).join(', ')}
                onChange={e => set('allowedCompanyIds', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
                placeholder="company-id-1, company-id-2"
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-amber-500/50"
              />
              <p className="text-[10px] text-white/30 mt-1">여기 등록된 고객사만 /media 구독 화면에서 이 매체를 볼 수 있습니다.</p>
            </div>
          )}
        </div>
        <div className="p-6 border-t border-white/10 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-white/60 hover:text-white transition-colors">취소</button>
          <button
            onClick={() => onSave(form)}
            disabled={saving || !form.name || !form.url}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────
export default function MediaAdmin() {
  const { user } = useAuthStore();

  const [sources, setSources] = useState<GlobalSource[]>([]);
  const [health, setHealth] = useState<Record<string, SourceHealth>>({});
  const [loading, setLoading] = useState(true);
  const [healthLoading, setHealthLoading] = useState(false);

  const [tab, setTab] = useState<TabId>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState<SourceType | 'all'>('all');
  const [filterCategory, setFilterCategory] = useState('all');
  const [filterStatus, setFilterStatus] = useState<SourceStatus | 'all'>('all');

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [editingSource, setEditingSource] = useState<Partial<GlobalSource> | null>(null);
  const [savingSource, setSavingSource] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // ─── Load sources ──────────────────────────────────────────
  const loadSources = useCallback(async () => {
    setLoading(true);
    try {
      const q = query(collection(db, 'globalSources'), orderBy('relevanceScore', 'desc'));
      const snap = await getDocs(q);
      setSources(snap.docs.map(d => ({ id: d.id, ...d.data() } as GlobalSource)));
    } catch (err) {
      console.error('Failed to load sources:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // ─── Load health data ──────────────────────────────────────
  const loadHealthSimple = useCallback(async (srcs: GlobalSource[]) => {
    if (srcs.length === 0) return;
    setHealthLoading(true);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const map: Record<string, SourceHealth> = {};

    await Promise.all(srcs.map(async src => {
      try {
        const [recentSnap, todaySnap] = await Promise.all([
          getDocs(query(collection(db, 'articles'), where('sourceId', '==', src.id), orderBy('collectedAt', 'desc'), limit(1))),
          getCountFromServer(query(collection(db, 'articles'), where('sourceId', '==', src.id), where('collectedAt', '>=', today))),
        ]);
        const last = recentSnap.docs[0]?.data()?.collectedAt ?? null;
        const lastDate = last?.toDate ? last.toDate() : last?._seconds ? new Date(last._seconds * 1000) : null;
        const isRecent = lastDate && (Date.now() - lastDate.getTime()) < 6 * 3600000;
        map[src.id] = {
          sourceId: src.id,
          todayCount: todaySnap.data().count,
          lastCollectedAt: last,
          status: (isRecent ? 'ok' : 'idle') as 'ok' | 'idle' | 'error',
        };
      } catch {
        map[src.id] = { sourceId: src.id, todayCount: 0, lastCollectedAt: null, status: 'idle' };
      }
    }));
    setHealth(map);
    setHealthLoading(false);
  }, []);

  useEffect(() => { loadSources(); }, [loadSources]);
  useEffect(() => { if (sources.length > 0) loadHealthSimple(sources); }, [sources, loadHealthSimple]);

  // ─── Test source ───────────────────────────────────────────
  const handleTest = async (source: GlobalSource) => {
    setTestingId(source.id);
    try {
      const token = await getAuth().currentUser?.getIdToken();
      if (!token) throw new Error('Not authenticated');
      const res = await fetch(
        'https://us-central1-eumnews-9a99c.cloudfunctions.net/testSourceConnectionHttp',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ sourceId: source.id }),
        }
      );
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Test failed');
      }
      await loadSources();
    } catch (err: any) {
      console.error('Test failed:', err);
    } finally {
      setTestingId(null);
    }
  };

  // ─── Save source ───────────────────────────────────────────
  const handleSave = async (form: Partial<GlobalSource>) => {
    if (!form.name || !form.url || !form.type) return;
    setSavingSource(true);
    try {
      const fn = httpsCallable(functions, 'upsertGlobalSource');
      await fn(form);
      await loadSources();
      setEditingSource(null);
    } catch (err: any) {
      alert('저장 실패: ' + err.message);
    } finally {
      setSavingSource(false);
    }
  };

  // ─── Delete source ─────────────────────────────────────────
  const handleDelete = async (id: string) => {
    if (!confirm('이 매체를 삭제하시겠습니까?')) return;
    setDeletingId(id);
    try {
      const fn = httpsCallable(functions, 'deleteGlobalSource');
      await fn({ id });
      setSources(prev => prev.filter(s => s.id !== id));
    } catch (err: any) {
      alert('삭제 실패: ' + err.message);
    } finally {
      setDeletingId(null);
    }
  };

  // ─── Filter logic ──────────────────────────────────────────
  const filtered = sources.filter(s => {
    if (tab === 'errors' && s.status !== 'error' && !(s.lastTestResult && !s.lastTestResult.success)) return false;
    if (tab === 'health') {
      // Health tab: show active sources only
      if (s.status !== 'active') return false;
    }
    const matchSearch = !searchTerm || s.name.toLowerCase().includes(searchTerm.toLowerCase()) || (s.url || '').toLowerCase().includes(searchTerm.toLowerCase());
    const matchType = filterType === 'all' || s.type === filterType;
    const matchCat = filterCategory === 'all' || s.category === filterCategory;
    const matchStatus = filterStatus === 'all' || s.status === filterStatus;
    return matchSearch && matchType && matchCat && matchStatus;
  });

  // ─── Stats ─────────────────────────────────────────────────
  const stats = {
    total: sources.length,
    active: sources.filter(s => s.status === 'active').length,
    rss: sources.filter(s => s.type === 'rss').length,
    api: sources.filter(s => s.type === 'api').length,
    scraping: sources.filter(s => s.type === 'scraping' || s.type === 'puppeteer').length,
    errors: sources.filter(s => s.status === 'error' || (s.lastTestResult && !s.lastTestResult.success)).length,
  };

  const TABS: { id: TabId; label: string; count?: number }[] = [
    { id: 'all',    label: '전체 매체',  count: stats.total },
    { id: 'health', label: '수집 현황',  count: stats.active },
    { id: 'errors', label: '오류/알림',  count: stats.errors },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-400" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">마스터 매체 관리</h1>
          <p className="text-white/40 text-sm mt-0.5">모든 수집 매체를 통합 관리합니다</p>
        </div>
        <button
          onClick={() => setEditingSource({ ...BLANK_SOURCE })}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <Plus className="w-4 h-4" /> 매체 추가
        </button>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
        {[
          { label: '전체',    value: stats.total,    color: 'text-white' },
          { label: '활성',    value: stats.active,   color: 'text-green-400' },
          { label: 'RSS',     value: stats.rss,      color: 'text-orange-400' },
          { label: 'API',     value: stats.api,      color: 'text-blue-400' },
          { label: '스크래핑', value: stats.scraping, color: 'text-purple-400' },
          { label: '오류',    value: stats.errors,   color: stats.errors > 0 ? 'text-red-400' : 'text-white/30' },
        ].map(s => (
          <div key={s.label} className="bg-white/5 border border-white/8 rounded-xl p-3 text-center">
            <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
            <div className="text-xs text-white/40 mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-white/5 border border-white/8 rounded-xl p-1 w-fit">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              tab === t.id
                ? 'bg-white/10 text-white'
                : 'text-white/40 hover:text-white/70'
            }`}
          >
            {t.label}
            {t.count != null && (
              <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${
                tab === t.id ? 'bg-white/15 text-white' : 'bg-white/5 text-white/30'
              }`}>{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30" />
          <input
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="매체 검색..."
            className="pl-8 pr-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-white/30 outline-none focus:border-blue-500/40 w-48"
          />
        </div>
        <select value={filterType} onChange={e => setFilterType(e.target.value as SourceType | 'all')}
          className="px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none">
          <option value="all">모든 방식</option>
          {Object.entries(TYPE_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
        </select>
        <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)}
          className="px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none">
          {CATEGORY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {tab === 'all' && (
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as SourceStatus | 'all')}
            className="px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none">
            <option value="all">모든 상태</option>
            <option value="active">활성</option>
            <option value="inactive">비활성</option>
            <option value="error">오류</option>
          </select>
        )}
        <button onClick={() => { loadSources(); }} className="ml-auto p-2 text-white/40 hover:text-white transition-colors">
          <RefreshCw className="w-4 h-4" />
        </button>
        {healthLoading && <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />}
      </div>

      {/* Source table */}
      <div className="bg-white/3 border border-white/8 rounded-xl overflow-hidden">
        {filtered.length === 0 ? (
          <div className="text-center py-16 text-white/30">
            <Globe className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>조건에 맞는 매체가 없습니다.</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/5 text-xs text-white/30 uppercase tracking-wider">
                <th className="px-4 py-3 text-left">매체명</th>
                <th className="px-4 py-3 text-left">방식</th>
                <th className="px-4 py-3 text-left">분야</th>
                <th className="px-4 py-3 text-left">상태</th>
                <th className="px-4 py-3 text-left">수집 현황</th>
                <th className="px-4 py-3 text-left">마지막 테스트</th>
                <th className="px-4 py-3 text-right">액션</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(source => {
                const h = health[source.id];
                const isExpanded = expandedId === source.id;
                const isTesting = testingId === source.id;
                const catLabel = CATEGORY_OPTIONS.find(o => o.value === source.category)?.label || source.category;
                return (
                  <>
                    <tr
                      key={source.id}
                      className="border-b border-white/5 hover:bg-white/3 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setExpandedId(isExpanded ? null : source.id)}
                            className="text-left"
                          >
                            <div className="font-medium text-sm text-white flex items-center gap-1.5">
                              {source.name}
                              {source.loginRequired && <Lock className="w-3 h-3 text-amber-400" />}
                              {source.pricingTier === 'paid' && (
                                <span className="text-[9px] px-1 py-0 bg-red-500/20 text-red-400 rounded font-bold">유료</span>
                              )}
                            </div>
                            <div className="text-xs text-white/30 truncate max-w-[180px]">{source.url}</div>
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <TypeBadge type={source.type} />
                      </td>
                      <td className="px-4 py-3 text-xs text-white/50">{catLabel}</td>
                      <td className="px-4 py-3">
                        <StatusDot status={source.status} />
                      </td>
                      <td className="px-4 py-3">
                        <HealthBadge health={h} />
                      </td>
                      <td className="px-4 py-3">
                        {source.lastTestResult ? (
                          <div className="flex items-center gap-1">
                            {source.lastTestResult.success
                              ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
                              : <XCircle className="w-3.5 h-3.5 text-red-400" />}
                            <span className={`text-xs ${source.lastTestResult.success ? 'text-green-400' : 'text-red-400'}`}>
                              {source.lastTestResult.success
                                ? `${source.lastTestResult.articlesFound || 0}건`
                                : '실패'}
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs text-white/20">미테스트</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => handleTest(source)}
                            disabled={isTesting}
                            title="연결 테스트"
                            className="p-1.5 text-white/40 hover:text-blue-400 transition-colors disabled:opacity-40"
                          >
                            {isTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                          </button>
                          <button
                            onClick={() => setExpandedId(isExpanded ? null : source.id)}
                            title="상세 보기"
                            className="p-1.5 text-white/40 hover:text-white transition-colors"
                          >
                            {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                          </button>
                          <button
                            onClick={() => setEditingSource({ ...source })}
                            title="편집"
                            className="p-1.5 text-white/40 hover:text-white transition-colors"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleDelete(source.id)}
                            disabled={deletingId === source.id}
                            title="삭제"
                            className="p-1.5 text-white/40 hover:text-red-400 transition-colors disabled:opacity-40"
                          >
                            {deletingId === source.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </td>
                    </tr>

                    {/* Expanded detail row */}
                    {isExpanded && (
                      <tr key={`${source.id}-detail`} className="border-b border-white/5 bg-white/2">
                        <td colSpan={7} className="px-6 py-4">
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs text-white/60">
                            {source.rssUrl && (
                              <div>
                                <span className="text-white/30 block mb-0.5">RSS URL</span>
                                <span className="text-white/70 break-all">{source.rssUrl}</span>
                              </div>
                            )}
                            {source.apiEndpoint && (
                              <div>
                                <span className="text-white/30 block mb-0.5">API 엔드포인트</span>
                                <span className="text-white/70 break-all">{source.apiEndpoint}</span>
                              </div>
                            )}
                            {source.listSelector && (
                              <div>
                                <span className="text-white/30 block mb-0.5">목록 셀렉터</span>
                                <code className="text-purple-300">{source.listSelector}</code>
                              </div>
                            )}
                            <div>
                              <span className="text-white/30 block mb-0.5">기본 키워드</span>
                              <span className="text-white/70">{(source.defaultKeywords || []).join(', ') || '—'}</span>
                            </div>
                            <div>
                              <span className="text-white/30 block mb-0.5">언어</span>
                              <span className="text-white/70">{source.language?.toUpperCase() || '—'}</span>
                            </div>
                            <div>
                              <span className="text-white/30 block mb-0.5">중요도</span>
                              <span className="text-yellow-400">{'★'.repeat(source.relevanceScore || 3)}</span>
                            </div>
                            {source.localScraperId && (
                              <div>
                                <span className="text-white/30 block mb-0.5">로컬 스크래퍼 ID</span>
                                <span className="text-indigo-300">{source.localScraperId}</span>
                              </div>
                            )}
                            {source.notes && (
                              <div className="col-span-2">
                                <span className="text-white/30 block mb-0.5">메모</span>
                                <span className="text-white/70">{source.notes}</span>
                              </div>
                            )}
                            {source.lastTestResult?.message && (
                              <div className="col-span-2">
                                <span className="text-white/30 block mb-0.5">마지막 테스트 메시지</span>
                                <span className={source.lastTestResult.success ? 'text-green-300' : 'text-red-300'}>
                                  {source.lastTestResult.message}
                                </span>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Edit modal */}
      {editingSource && (
        <SourceModal
          source={editingSource}
          onSave={handleSave}
          onClose={() => setEditingSource(null)}
          saving={savingSource}
        />
      )}
    </div>
  );
}
