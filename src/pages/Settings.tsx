import { useState, useEffect } from 'react';
import { CheckCircle2, Loader2, Database, RefreshCw, Plus, Trash2, Mail, ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import { db, functions } from '@/lib/firebase';
import { httpsCallable } from 'firebase/functions';
import { collection, getDocs, doc, updateDoc, setDoc, getDoc } from 'firebase/firestore';
import { useAuthStore } from '@/store/useAuthStore';

export default function Settings() {
  const { user } = useAuthStore();
  const companyId = (user as any)?.primaryCompanyId || null;
  const userRole = (user as any)?.role;
  const canEdit = userRole === 'superadmin' || userRole === 'company_admin';

  const [loading, setLoading] = useState(true);

  // Sources state (subscribed only, read-only display)
  const [subscribedSources, setSubscribedSources] = useState<{ id: string; name: string; type: string; pricingTier: string }[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);

  // Notification state
  const [subscriberEmails, setSubscriberEmails] = useState<string[]>([]);
  const [newEmail, setNewEmail] = useState('');
  const [telegramConfig, setTelegramConfig] = useState({ botToken: '', chatId: '' });
  const [savingNotifications, setSavingNotifications] = useState(false);

  // Relevance prompt state
  const [relevancePrompt, setRelevancePrompt] = useState('');
  const [savingPrompt, setSavingPrompt] = useState(false);

  useEffect(() => {
    if (companyId) {
      loadCompanySettings();
      loadSources();
    } else {
      setLoading(false);
    }
  }, [companyId]);

  const loadCompanySettings = async () => {
    setLoading(true);
    try {
      const settingsDoc = await getDoc(doc(db, 'companySettings', companyId));
      if (settingsDoc.exists()) {
        const data = settingsDoc.data() as any;
        setSubscriberEmails(data.subscriberEmails || []);
        setTelegramConfig(data.notifications?.telegram || { botToken: '', chatId: '' });
        setRelevancePrompt(data.ai?.relevancePrompt || '');
      }
    } catch (err) {
      console.error('Failed to load company settings:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadSources = async () => {
    if (!companyId) return;
    setSourcesLoading(true);
    try {
      const subDoc = await getDoc(doc(db, 'companySourceSubscriptions', companyId));
      const subscribedIds: string[] = subDoc.exists() ? (subDoc.data() as any).subscribedSourceIds || [] : [];
      if (subscribedIds.length === 0) {
        setSubscribedSources([]);
        return;
      }
      const snap = await getDocs(collection(db, 'globalSources'));
      const all = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
      setSubscribedSources(
        all
          .filter(s => subscribedIds.includes(s.id))
          .map(s => ({ id: s.id, name: s.name, type: s.type, pricingTier: s.pricingTier || 'free' }))
      );
    } catch (err) {
      console.error('Failed to load sources:', err);
    } finally {
      setSourcesLoading(false);
    }
  };

  const handleSaveNotifications = async () => {
    if (!companyId) return;
    setSavingNotifications(true);
    try {
      await httpsCallable(functions, 'updateNotificationSettings')({
        companyId,
        emails: subscriberEmails,
        telegram: telegramConfig,
      });
      alert('알림 설정이 저장되었습니다.');
    } catch (err: any) {
      alert('저장 실패: ' + err.message);
    } finally {
      setSavingNotifications(false);
    }
  };

  const handleSaveRelevancePrompt = async () => {
    if (!companyId) return;
    setSavingPrompt(true);
    try {
      const ref = doc(db, 'companySettings', companyId);
      try {
        await updateDoc(ref, { 'ai.relevancePrompt': relevancePrompt });
      } catch (e: any) {
        if (e.code === 'not-found') {
          await setDoc(ref, { ai: { relevancePrompt } }, { merge: true });
        } else {
          throw e;
        }
      }
      alert('판단 기준 프롬프트가 저장되었습니다.');
    } catch (err: any) {
      alert('저장 실패: ' + err.message);
    } finally {
      setSavingPrompt(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-[#1e3a5f]" />
      </div>
    );
  }

  if (!companyId) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-12 text-center text-gray-500">
        <p>No company assigned. Contact your superadmin to be assigned to a company.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">설정</h1>
        <p className="text-gray-600 dark:text-gray-400 mt-1">AI 판단 기준, 매체 구독, 알림 수신자를 관리합니다.</p>
      </div>

      {/* ─── AI 기사 적합성 판단 기준 ─── */}
      <section className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-5 border-b border-gray-100 dark:border-gray-700 flex items-center gap-2">
          <RefreshCw className="w-5 h-5 text-[#1e3a5f] dark:text-blue-400" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">AI 기사 적합성 판단 기준 (커스텀 프롬프트)</h2>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            AI가 수집된 기사를 분석 리포트에 포함시킬지 결정하는 '판단 기준'을 직접 수정할 수 있습니다.
            내용이 구체적일수록 원하는 기사만 정확하게 골라낼 수 있습니다.
          </p>
          <textarea
            value={relevancePrompt}
            onChange={e => setRelevancePrompt(e.target.value)}
            placeholder="예: 당신은 전문 투자 분석가입니다. 기사가 'M&A', '스타트업 투자', 'IPO'와 직접 관련 있는지 판단하세요. 단순 인물 동정이나 광고성 기사는 제외하세요."
            className="w-full h-32 px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-900/50 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-[#1e3a5f] resize-none"
          />
          <div className="flex justify-end">
            <button
              onClick={handleSaveRelevancePrompt}
              disabled={savingPrompt || !canEdit}
              className="flex items-center px-6 py-2 bg-[#1e3a5f] text-white rounded-lg font-medium hover:bg-[#2a4a73] transition-colors shadow-sm disabled:opacity-50 text-sm"
            >
              {savingPrompt ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
              판단 기준 저장
            </button>
          </div>
        </div>
      </section>

      {/* ─── 구독 매체 ─── */}
      <section className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Database className="w-5 h-5 text-[#1e3a5f] dark:text-blue-400" />
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">구독 매체</h2>
            {!sourcesLoading && (
              <span className="text-xs bg-[#1e3a5f] text-white px-2.5 py-1 rounded-full">{subscribedSources.length}개</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={loadSources} disabled={sourcesLoading} className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
              <RefreshCw className={`w-4 h-4 ${sourcesLoading ? 'animate-spin' : ''}`} />
            </button>
            <Link
              to="/media"
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1e3a5f] hover:bg-[#2a4a73] text-white rounded-lg text-sm font-medium transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              매체 구독 관리
            </Link>
          </div>
        </div>
        <div className="p-6">
          {sourcesLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            </div>
          ) : subscribedSources.length === 0 ? (
            <div className="text-center py-8 text-gray-400 text-sm">
              <p>구독 중인 매체가 없습니다.</p>
              <Link to="/media" className="mt-2 inline-flex items-center gap-1 text-[#1e3a5f] dark:text-blue-400 hover:underline font-medium">
                매체 구독 선택하러 가기 <ExternalLink className="w-3.5 h-3.5" />
              </Link>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {subscribedSources.map(s => (
                <span
                  key={s.id}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border ${
                    s.pricingTier === 'paid'
                      ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-400'
                      : s.pricingTier === 'requires_subscription'
                      ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400'
                      : 'bg-gray-100 dark:bg-gray-700 border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300'
                  }`}
                >
                  {s.name}
                  {s.pricingTier === 'paid' && <span className="text-[10px] font-bold bg-red-500 text-white px-1 rounded">유료</span>}
                  {s.pricingTier === 'requires_subscription' && <span className="text-[10px] font-bold bg-amber-500 text-white px-1 rounded">구독</span>}
                </span>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ─── 알림 설정 ─── */}
      <section className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Mail className="w-5 h-5 text-[#1e3a5f] dark:text-blue-400" />
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">보고서 알림 설정</h2>
          </div>
          <button
            onClick={handleSaveNotifications}
            disabled={savingNotifications || !canEdit}
            className="flex items-center px-4 py-1.5 bg-[#1e3a5f] text-white rounded-lg text-sm font-medium hover:bg-[#2a4a73] transition-colors disabled:opacity-50"
          >
            {savingNotifications ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <CheckCircle2 className="w-3 h-3 mr-1" />}
            설정 저장
          </button>
        </div>

        <div className="p-6 space-y-8">
          {/* 이메일 */}
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-gray-500 uppercase tracking-wider">이메일 수신인</h3>
            <div className="space-y-3">
              {subscriberEmails.map((email, idx) => (
                <div key={idx} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-700">
                  <span className="text-sm text-gray-800 dark:text-gray-200 font-medium">{email}</span>
                  {canEdit && (
                    <button
                      onClick={() => setSubscriberEmails(prev => prev.filter((_, i) => i !== idx))}
                      className="text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {canEdit && (
              <div className="flex gap-2">
                <input
                  type="email"
                  value={newEmail}
                  onChange={e => setNewEmail(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newEmail.trim()) {
                      setSubscriberEmails(prev => [...prev, newEmail.trim()]);
                      setNewEmail('');
                    }
                  }}
                  placeholder="이메일 주소 추가..."
                  className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-[#1e3a5f]"
                />
                <button
                  onClick={() => {
                    if (newEmail.trim()) {
                      setSubscriberEmails(prev => [...prev, newEmail.trim()]);
                      setNewEmail('');
                    }
                  }}
                  className="px-3 py-2 bg-[#1e3a5f] text-white rounded-lg hover:bg-[#2a4a73] transition-colors"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>

          {/* Telegram */}
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-gray-500 uppercase tracking-wider">텔레그램 알림</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5 uppercase">Bot Token</label>
                <input
                  type="password"
                  value={telegramConfig.botToken || ''}
                  onChange={e => setTelegramConfig(prev => ({ ...prev, botToken: e.target.value }))}
                  placeholder="1234567890:AAF..."
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-[#1e3a5f]"
                  disabled={!canEdit}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5 uppercase">Channel/Chat ID</label>
                <input
                  type="text"
                  value={telegramConfig.chatId || ''}
                  onChange={e => setTelegramConfig(prev => ({ ...prev, chatId: e.target.value }))}
                  placeholder="@your_channel_id or -100123456789"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-[#1e3a5f]"
                  disabled={!canEdit}
                />
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
