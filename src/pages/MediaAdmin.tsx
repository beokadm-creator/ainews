import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Edit3,
  Globe,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Rss,
  Save,
  Search,
  Trash2,
  Workflow,
  Zap,
} from 'lucide-react';
import { httpsCallable } from 'firebase/functions';
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { formatDistanceToNow } from 'date-fns';
import { db, functions } from '@/lib/firebase';
import { dedupeSourceCatalog } from '@/lib/sourceCatalog';

type SourceType = 'rss' | 'api' | 'scraping' | 'puppeteer' | 'newsletter';
type SourceStatus = 'active' | 'inactive' | 'error' | 'testing';
type PricingTier = 'free' | 'paid' | 'requires_subscription';

interface GlobalSource {
  id?: string;
  name: string;
  url: string;
  description?: string;
  type: SourceType;
  category?: string;
  status: SourceStatus;
  pricingTier: PricingTier;
  language?: string;
  relevanceScore?: number;
  rssUrl?: string;
  apiType?: string;
  apiEndpoint?: string;
  localScraperId?: string;
  listSelector?: string;
  titleSelector?: string;
  linkSelector?: string;
  contentSelector?: string;
  dateSelector?: string;
  loginRequired?: boolean;
  defaultKeywords?: string[];
  allowedCompanyIds?: string[];
  lastStatus?: string | null;
  errorMessage?: string | null;
}

interface SourceRuntime {
  sourceId: string;
  collected24h: number;
  analyzed24h: number;
  lastCollectedAt: Date | null;
}

const BLANK_SOURCE: GlobalSource = {
  name: '',
  url: '',
  type: 'rss',
  status: 'inactive',
  pricingTier: 'free',
  category: 'domestic',
  language: 'ko',
  relevanceScore: 3,
  defaultKeywords: [],
  allowedCompanyIds: [],
  loginRequired: false,
};

const CATEGORY_OPTIONS = [
  { value: 'domestic', label: 'Domestic' },
  { value: 'asian', label: 'Asia' },
  { value: 'global', label: 'Global' },
  { value: 'tech', label: 'Tech' },
  { value: 'startup', label: 'Startup / VC / PE' },
  { value: 'M&A', label: 'M&A / Premium' },
];

const TYPE_OPTIONS: Array<{ value: SourceType; label: string }> = [
  { value: 'rss', label: 'RSS' },
  { value: 'api', label: 'API' },
  { value: 'scraping', label: 'Scraping' },
  { value: 'puppeteer', label: 'Puppeteer / Premium' },
  { value: 'newsletter', label: 'Newsletter' },
];

function toDate(value: any): Date | null {
  if (!value) return null;
  if (typeof value?.toDate === 'function') return value.toDate();
  if (typeof value?._seconds === 'number') return new Date(value._seconds * 1000);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function TypeIcon({ type }: { type: SourceType }) {
  if (type === 'rss') return <Rss className="h-4 w-4" />;
  if (type === 'api') return <Globe className="h-4 w-4" />;
  return <Workflow className="h-4 w-4" />;
}

function SourceEditor({
  initialValue,
  saving,
  onClose,
  onSave,
}: {
  initialValue: GlobalSource;
  saving: boolean;
  onClose: () => void;
  onSave: (value: GlobalSource) => void;
}) {
  const [form, setForm] = useState<GlobalSource>(initialValue);

  useEffect(() => {
    setForm(initialValue);
  }, [initialValue]);

  const setField = <K extends keyof GlobalSource>(key: K, value: GlobalSource[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm">
      <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-[28px] border border-white/10 bg-[#0f1728] p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-cyan-300/80">Master Source Editor</p>
            <h2 className="mt-2 text-2xl font-semibold text-white">{form.id ? '마스터 매체 수정' : '새 마스터 매체 추가'}</h2>
          </div>
          <button onClick={onClose} className="rounded-xl border border-white/10 px-3 py-2 text-sm text-white/65 transition hover:bg-white/5">
            Close
          </button>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <label className="space-y-2">
            <span className="text-xs uppercase tracking-[0.18em] text-white/40">Name</span>
            <input value={form.name} onChange={(e) => setField('name', e.target.value)} className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400/40" />
          </label>
          <label className="space-y-2">
            <span className="text-xs uppercase tracking-[0.18em] text-white/40">URL</span>
            <input value={form.url} onChange={(e) => setField('url', e.target.value)} className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400/40" />
          </label>
          <label className="space-y-2">
            <span className="text-xs uppercase tracking-[0.18em] text-white/40">Type</span>
            <select value={form.type} onChange={(e) => setField('type', e.target.value as SourceType)} className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none">
              {TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="space-y-2">
            <span className="text-xs uppercase tracking-[0.18em] text-white/40">Status</span>
            <select value={form.status} onChange={(e) => setField('status', e.target.value as SourceStatus)} className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none">
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="error">Error</option>
              <option value="testing">Testing</option>
            </select>
          </label>
          <label className="space-y-2">
            <span className="text-xs uppercase tracking-[0.18em] text-white/40">Category</span>
            <select value={form.category || 'domestic'} onChange={(e) => setField('category', e.target.value)} className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none">
              {CATEGORY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="space-y-2">
            <span className="text-xs uppercase tracking-[0.18em] text-white/40">Pricing Tier</span>
            <select value={form.pricingTier} onChange={(e) => setField('pricingTier', e.target.value as PricingTier)} className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none">
              <option value="free">Free</option>
              <option value="paid">Paid</option>
              <option value="requires_subscription">Requires Subscription</option>
            </select>
          </label>
          <label className="space-y-2 md:col-span-2">
            <span className="text-xs uppercase tracking-[0.18em] text-white/40">Description</span>
            <textarea value={form.description || ''} onChange={(e) => setField('description', e.target.value)} rows={3} className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400/40" />
          </label>
          {form.type === 'rss' ? (
            <label className="space-y-2 md:col-span-2">
              <span className="text-xs uppercase tracking-[0.18em] text-white/40">RSS URL</span>
              <input value={form.rssUrl || ''} onChange={(e) => setField('rssUrl', e.target.value)} className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400/40" />
            </label>
          ) : null}
          {(form.type === 'scraping' || form.type === 'puppeteer') ? (
            <>
              <label className="space-y-2">
                <span className="text-xs uppercase tracking-[0.18em] text-white/40">Local Scraper ID</span>
                <input value={form.localScraperId || ''} onChange={(e) => setField('localScraperId', e.target.value)} className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400/40" />
              </label>
              <label className="space-y-2">
                <span className="text-xs uppercase tracking-[0.18em] text-white/40">Login Required</span>
                <select value={form.loginRequired ? 'yes' : 'no'} onChange={(e) => setField('loginRequired', e.target.value === 'yes')} className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none">
                  <option value="no">No</option>
                  <option value="yes">Yes</option>
                </select>
              </label>
              <label className="space-y-2">
                <span className="text-xs uppercase tracking-[0.18em] text-white/40">List Selector</span>
                <input value={form.listSelector || ''} onChange={(e) => setField('listSelector', e.target.value)} className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400/40" />
              </label>
              <label className="space-y-2">
                <span className="text-xs uppercase tracking-[0.18em] text-white/40">Title Selector</span>
                <input value={form.titleSelector || ''} onChange={(e) => setField('titleSelector', e.target.value)} className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400/40" />
              </label>
              <label className="space-y-2">
                <span className="text-xs uppercase tracking-[0.18em] text-white/40">Link Selector</span>
                <input value={form.linkSelector || ''} onChange={(e) => setField('linkSelector', e.target.value)} className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400/40" />
              </label>
              <label className="space-y-2">
                <span className="text-xs uppercase tracking-[0.18em] text-white/40">Date Selector</span>
                <input value={form.dateSelector || ''} onChange={(e) => setField('dateSelector', e.target.value)} className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400/40" />
              </label>
            </>
          ) : null}
          <label className="space-y-2 md:col-span-2">
            <span className="text-xs uppercase tracking-[0.18em] text-white/40">Default Keywords</span>
            <input
              value={(form.defaultKeywords || []).join(', ')}
              onChange={(e) => setField('defaultKeywords', e.target.value.split(',').map((item) => item.trim()).filter(Boolean))}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400/40"
            />
          </label>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2 text-sm text-white/65 transition hover:bg-white/5">
            Cancel
          </button>
          <button
            onClick={() => onSave(form)}
            disabled={saving || !form.name || !form.url}
            className="inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save Source
          </button>
        </div>
      </div>
    </div>
  );
}

export default function MediaAdmin() {
  const [sources, setSources] = useState<GlobalSource[]>([]);
  const [runtimeMap, setRuntimeMap] = useState<Record<string, SourceRuntime>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<'all' | SourceType>('all');
  const [filterStatus, setFilterStatus] = useState<'all' | SourceStatus>('all');
  const [editorSource, setEditorSource] = useState<GlobalSource | null>(null);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadSources = useCallback(async () => {
    setLoading(true);
    try {
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [sourceSnap, articleSnap] = await Promise.all([
        getDocs(query(collection(db, 'globalSources'), orderBy('relevanceScore', 'desc'))),
        getDocs(query(collection(db, 'articles'), where('collectedAt', '>=', since24h), orderBy('collectedAt', 'desc'), limit(200))),
      ]);

      const sourceRows = dedupeSourceCatalog(sourceSnap.docs.map((item) => ({ id: item.id, ...(item.data() as any) }))) as GlobalSource[];
      const articleRows = articleSnap.docs.map((item) => ({ id: item.id, ...(item.data() as any) }));
      const nextRuntimeMap: Record<string, SourceRuntime> = {};

      sourceRows.forEach((source) => {
        const related = articleRows.filter((article) => article.globalSourceId === source.id || article.sourceId === source.id);
        nextRuntimeMap[source.id || ''] = {
          sourceId: source.id || '',
          collected24h: related.length,
          analyzed24h: related.filter((article) => article.status === 'analyzed' || article.status === 'published').length,
          lastCollectedAt: related.length > 0 ? toDate(related[0].collectedAt) : null,
        };
      });

      setSources(sourceRows);
      setRuntimeMap(nextRuntimeMap);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSources().catch(console.error);
  }, [loadSources]);

  const stats = useMemo(() => ({
    total: sources.length,
    active: sources.filter((source) => source.status === 'active').length,
    premium: sources.filter((source) => source.pricingTier !== 'free').length,
    puppeteer: sources.filter((source) => source.type === 'puppeteer').length,
    errors: sources.filter((source) => source.lastStatus === 'error' || source.status === 'error').length,
  }), [sources]);

  const filteredSources = useMemo(() => {
    return sources.filter((source) => {
      const matchesSearch = !search || source.name.toLowerCase().includes(search.toLowerCase()) || source.url.toLowerCase().includes(search.toLowerCase());
      const matchesType = filterType === 'all' || source.type === filterType;
      const matchesStatus = filterStatus === 'all' || source.status === filterStatus;
      return matchesSearch && matchesType && matchesStatus;
    });
  }, [filterStatus, filterType, search, sources]);

  const handleSave = async (source: GlobalSource) => {
    setSaving(true);
    try {
      const fn = httpsCallable(functions, 'upsertGlobalSource');
      await fn(source);
      setEditorSource(null);
      await loadSources();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id?: string) => {
    if (!id) return;
    if (!window.confirm('이 마스터 매체를 삭제하시겠습니까?')) return;
    setDeletingId(id);
    try {
      const fn = httpsCallable(functions, 'deleteGlobalSource');
      await fn({ id });
      await loadSources();
    } finally {
      setDeletingId(null);
    }
  };

  const handleTest = async (id?: string) => {
    if (!id) return;
    setTestingId(id);
    try {
      const fn = httpsCallable(functions, 'testGlobalSource');
      await fn({ sourceId: id });
      await loadSources();
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="space-y-6 pb-10">
      <div className="flex flex-col gap-4 rounded-[28px] border border-[#23304a] bg-[linear-gradient(135deg,#0f1728_0%,#13203a_100%)] px-6 py-6 text-white shadow-[0_28px_90px_rgba(0,0,0,0.25)] lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-3xl">
          <p className="text-xs uppercase tracking-[0.24em] text-cyan-300/80">Master Media Control</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">슈퍼어드민, 회사, 스태프가 공유하는 단일 마스터 매체 파이프</h1>
        </div>
        <div className="flex gap-2">
          <button onClick={() => loadSources().catch(console.error)} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-white/80 transition hover:bg-white/10">
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
          <button onClick={() => setEditorSource({ ...BLANK_SOURCE })} className="inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-400">
            <Plus className="h-4 w-4" />
            Add Source
          </button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <div className="rounded-2xl border border-white/10 bg-[#0f1728] p-5">
          <p className="text-xs uppercase tracking-[0.18em] text-white/35">Total</p>
          <p className="mt-3 text-3xl font-semibold text-white">{stats.total}</p>
          <p className="mt-2 text-sm text-white/45">마스터 매체 전체 수</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-[#0f1728] p-5">
          <p className="text-xs uppercase tracking-[0.18em] text-white/35">Active</p>
          <p className="mt-3 text-3xl font-semibold text-emerald-300">{stats.active}</p>
          <p className="mt-2 text-sm text-white/45">현재 수집 파이프라인 포함</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-[#0f1728] p-5">
          <p className="text-xs uppercase tracking-[0.18em] text-white/35">Premium</p>
          <p className="mt-3 text-3xl font-semibold text-amber-300">{stats.premium}</p>
          <p className="mt-2 text-sm text-white/45">유료 또는 구독 필요 매체</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-[#0f1728] p-5">
          <p className="text-xs uppercase tracking-[0.18em] text-white/35">Puppeteer</p>
          <p className="mt-3 text-3xl font-semibold text-violet-300">{stats.puppeteer}</p>
          <p className="mt-2 text-sm text-white/45">로그인/유료 수집용 소스</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-[#0f1728] p-5">
          <p className="text-xs uppercase tracking-[0.18em] text-white/35">Errors</p>
          <p className="mt-3 text-3xl font-semibold text-rose-300">{stats.errors}</p>
          <p className="mt-2 text-sm text-white/45">최근 점검이 필요한 매체</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search source name or url"
            className="w-72 rounded-xl border border-white/10 bg-[#0f1728] px-10 py-3 text-sm text-white outline-none placeholder:text-white/25 focus:border-cyan-400/40"
          />
        </div>
        <select value={filterType} onChange={(e) => setFilterType(e.target.value as 'all' | SourceType)} className="rounded-xl border border-white/10 bg-[#0f1728] px-4 py-3 text-sm text-white outline-none">
          <option value="all">All Types</option>
          {TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as 'all' | SourceStatus)} className="rounded-xl border border-white/10 bg-[#0f1728] px-4 py-3 text-sm text-white outline-none">
          <option value="all">All Statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="error">Error</option>
          <option value="testing">Testing</option>
        </select>
      </div>

      <div className="overflow-hidden rounded-3xl border border-white/10 bg-[#0f1728]">
        {loading ? (
          <div className="flex min-h-[280px] items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-cyan-300" />
          </div>
        ) : (
          <table className="w-full text-left">
            <thead className="bg-white/[0.03] text-xs uppercase tracking-[0.18em] text-white/35">
              <tr>
                <th className="px-5 py-4">Source</th>
                <th className="px-5 py-4">Type</th>
                <th className="px-5 py-4">Pipeline</th>
                <th className="px-5 py-4">24h Collected</th>
                <th className="px-5 py-4">24h Analyzed</th>
                <th className="px-5 py-4">Last Seen</th>
                <th className="px-5 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredSources.map((source) => {
                const runtime = runtimeMap[source.id || ''];
                const lastCollectedAt = runtime?.lastCollectedAt;
                return (
                  <tr key={source.id} className="border-t border-white/10 text-sm text-white/75">
                    <td className="px-5 py-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-white">{source.name}</p>
                          {source.pricingTier !== 'free' ? <Lock className="h-3.5 w-3.5 text-amber-300" /> : null}
                          {source.type === 'puppeteer' ? <span className="rounded-full border border-violet-400/20 px-2 py-0.5 text-[11px] text-violet-200">premium worker</span> : null}
                        </div>
                        <p className="mt-1 text-xs text-white/35">{source.url}</p>
                        {source.errorMessage ? <p className="mt-2 text-xs text-rose-200">{source.errorMessage}</p> : null}
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
                        <TypeIcon type={source.type} />
                        {source.type}
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <div className="space-y-1">
                        <div className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] ${
                          source.status === 'active'
                            ? 'bg-emerald-500/10 text-emerald-200'
                            : source.status === 'error'
                            ? 'bg-rose-500/10 text-rose-200'
                            : 'bg-white/5 text-white/55'
                        }`}>
                          {source.status === 'active' ? <CheckCircle2 className="h-3 w-3" /> : source.status === 'error' ? <AlertTriangle className="h-3 w-3" /> : <Workflow className="h-3 w-3" />}
                          {source.status}
                        </div>
                        <p className="text-xs text-white/35">{source.lastStatus || 'idle'}{source.pricingTier ? ` · ${source.pricingTier}` : ''}</p>
                      </div>
                    </td>
                    <td className="px-5 py-4 text-cyan-300">{runtime?.collected24h || 0}</td>
                    <td className="px-5 py-4 text-emerald-300">{runtime?.analyzed24h || 0}</td>
                    <td className="px-5 py-4 text-white/45">{lastCollectedAt ? formatDistanceToNow(lastCollectedAt, { addSuffix: true }) : '-'}</td>
                    <td className="px-5 py-4">
                      <div className="flex items-center justify-end gap-2">
                        <button onClick={() => handleTest(source.id)} disabled={testingId === source.id} className="rounded-xl border border-white/10 bg-white/5 p-2 text-white/70 transition hover:bg-white/10 disabled:opacity-50">
                          {testingId === source.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                        </button>
                        <button onClick={() => setEditorSource({ ...BLANK_SOURCE, ...source })} className="rounded-xl border border-white/10 bg-white/5 p-2 text-white/70 transition hover:bg-white/10">
                          <Edit3 className="h-4 w-4" />
                        </button>
                        <button onClick={() => handleDelete(source.id)} disabled={deletingId === source.id} className="rounded-xl border border-white/10 bg-white/5 p-2 text-white/70 transition hover:bg-white/10 disabled:opacity-50">
                          {deletingId === source.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {editorSource ? (
        <SourceEditor
          initialValue={editorSource}
          saving={saving}
          onClose={() => setEditorSource(null)}
          onSave={handleSave}
        />
      ) : null}
    </div>
  );
}
