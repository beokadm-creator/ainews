import { useState, useEffect } from 'react';
import { Users, UserPlus, Trash2, Loader2, ShieldAlert, Mail, X, Eye, EyeOff } from 'lucide-react';
import { functions } from '@/lib/firebase';
import { httpsCallable } from 'firebase/functions';
import { useAuthStore } from '@/store/useAuthStore';

interface TeamMember {
  uid: string;
  email: string;
  role: 'company_admin' | 'company_editor' | 'viewer';
  createdAt?: any;
}

const ROLE_LABELS: Record<string, string> = {
  company_admin: '관리자',
  company_editor: '스테프',
  viewer: '뷰어',
};

const ROLE_COLORS: Record<string, string> = {
  company_admin: 'bg-[#1e3a5f]/10 text-[#1e3a5f] dark:bg-blue-500/10 dark:text-blue-300',
  company_editor: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  viewer: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
};

export default function Team() {
  const { user: currentUser } = useAuthStore();
  const role = (currentUser as any)?.role;
  const companyId = (currentUser as any)?.companyId || (currentUser as any)?.companyIds?.[0];
  const isAdmin = role === 'company_admin';

  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [newRole, setNewRole] = useState<'company_editor' | 'viewer'>('company_editor');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (companyId) loadMembers();
  }, [companyId]);

  const loadMembers = async () => {
    setLoading(true);
    try {
      const fn = httpsCallable(functions, 'getCompanyUsers');
      const result = await fn({ companyId }) as any;
      setMembers(result.data);
    } catch (err: any) {
      console.error('Failed to load team:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password || !companyId) return;
    setSubmitting(true);
    setError('');
    try {
      const fn = httpsCallable(functions, 'adminCreateUser');
      await fn({ email, password, role: newRole, companyId });
      setEmail('');
      setPassword('');
      setNewRole('company_editor');
      setShowModal(false);
      loadMembers();
    } catch (err: any) {
      setError(err.message || '계정 생성에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (uid: string, memberEmail: string) => {
    if (!confirm(`"${memberEmail}" 계정을 삭제하시겠습니까?\n삭제 후 복구할 수 없습니다.`)) return;
    setDeleting(uid);
    try {
      const fn = httpsCallable(functions, 'deleteCompanyUser');
      await fn({ uid });
      setMembers(prev => prev.filter(m => m.uid !== uid));
    } catch (err: any) {
      alert('삭제 실패: ' + (err.message || '알 수 없는 오류'));
    } finally {
      setDeleting(null);
    }
  };

  if (!isAdmin) {
    return (
      <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 text-center">
        <ShieldAlert className="h-10 w-10 text-gray-200 dark:text-gray-700" />
        <p className="text-sm font-medium text-gray-500 dark:text-gray-400">접근 권한이 없습니다.</p>
        <p className="text-xs text-gray-400">회사 관리자 계정으로 로그인해야 합니다.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-12">
      {/* Header */}
      <div className="flex items-start justify-between border-b border-gray-200 pb-5 dark:border-gray-700/60">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">팀 관리</h1>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">스테프 계정을 등록하고 관리합니다.</p>
        </div>
        <button
          onClick={() => { setShowModal(true); setError(''); }}
          className="inline-flex items-center gap-2 rounded-xl bg-[#1e3a5f] px-4 py-2 text-sm font-semibold text-white hover:bg-[#24456f]"
        >
          <UserPlus className="h-4 w-4" />
          스테프 추가
        </button>
      </div>

      {/* Members table */}
      <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/60">
        <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3 dark:border-gray-700/40">
          <Users className="h-3.5 w-3.5 text-gray-400" />
          <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">팀원 목록</span>
          {!loading && (
            <span className="ml-auto text-[11px] text-gray-400">{members.length}명</span>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-gray-300 dark:text-gray-600" />
          </div>
        ) : members.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <Users className="h-8 w-8 text-gray-200 dark:text-gray-700" />
            <p className="text-sm text-gray-400">등록된 팀원이 없습니다.</p>
            <p className="text-xs text-gray-400">스테프 추가 버튼으로 계정을 만들어주세요.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/60 dark:border-gray-700/40 dark:bg-white/5">
                <th className="px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">이메일</th>
                <th className="px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">권한</th>
                <th className="px-4 py-2.5 text-right text-[10px] font-semibold uppercase tracking-widest text-gray-400">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700/40">
              {members.map(member => {
                const isMe = member.uid === (currentUser as any)?.uid;
                const isProtected = member.role === 'company_admin' || (member.role as string) === 'superadmin';
                return (
                  <tr key={member.uid} className="transition-colors hover:bg-gray-50 dark:hover:bg-white/5">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#1e3a5f]/10 text-xs font-semibold text-[#1e3a5f] dark:bg-blue-500/10 dark:text-blue-300">
                          {member.email[0].toUpperCase()}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-900 dark:text-white">{member.email}</p>
                          {isMe && <p className="text-[10px] text-gray-400">본인</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-semibold ${ROLE_COLORS[member.role] || ROLE_COLORS.viewer}`}>
                        {ROLE_LABELS[member.role] || member.role}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {!isMe && !isProtected && (
                        <button
                          onClick={() => handleDelete(member.uid, member.email)}
                          disabled={deleting === member.uid}
                          className="rounded-lg p-1.5 text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500 dark:text-gray-600 dark:hover:bg-red-500/10 dark:hover:text-red-400 disabled:opacity-50"
                          title="계정 삭제"
                        >
                          {deleting === member.uid
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <Trash2 className="h-4 w-4" />
                          }
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Role guide */}
      <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-4 dark:border-gray-700/60 dark:bg-white/5">
        <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">권한 안내</p>
        <div className="space-y-2 text-xs text-gray-600 dark:text-gray-400">
          {[
            { r: 'company_admin', desc: '매체 설정, AI 키 관리, 스테프 등록/삭제 가능' },
            { r: 'company_editor', desc: '파이프라인 실행, 브리핑 열람, 기사 조회 가능' },
            { r: 'viewer', desc: '브리핑 및 기사 열람만 가능 (실행 불가)' },
          ].map(({ r, desc }) => (
            <div key={r} className="flex items-start gap-3">
              <span className={`inline-flex shrink-0 items-center rounded px-2 py-0.5 text-[11px] font-semibold ${ROLE_COLORS[r]}`}>{ROLE_LABELS[r]}</span>
              <span>{desc}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Add member modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700/60 dark:bg-gray-900">
            <form onSubmit={handleAdd}>
              <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-gray-700/40">
                <div>
                  <h3 className="text-base font-bold text-gray-900 dark:text-white">스테프 추가</h3>
                  <p className="mt-0.5 text-xs text-gray-500">새 팀원 계정을 생성합니다.</p>
                </div>
                <button type="button" onClick={() => setShowModal(false)} className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/10 dark:hover:text-gray-200">
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="space-y-4 p-5">
                {error && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-600 dark:border-red-800/40 dark:bg-red-500/10 dark:text-red-400">
                    {error}
                  </div>
                )}

                <div>
                  <label className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                    <Mail className="h-3 w-3" />이메일
                  </label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="staff@company.com"
                    className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-[#1e3a5f] focus:ring-1 focus:ring-[#1e3a5f]/20 dark:border-gray-700/60 dark:bg-gray-800 dark:text-white dark:focus:border-blue-400"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">임시 비밀번호</label>
                  <div className="relative">
                    <input
                      type={showPw ? 'text' : 'password'}
                      required
                      minLength={8}
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="최소 8자 이상"
                      className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 pr-10 text-sm text-gray-900 outline-none transition focus:border-[#1e3a5f] focus:ring-1 focus:ring-[#1e3a5f]/20 dark:border-gray-700/60 dark:bg-gray-800 dark:text-white dark:focus:border-blue-400"
                    />
                    <button type="button" onClick={() => setShowPw(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                      {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">권한</label>
                  <div className="grid grid-cols-2 gap-2">
                    {(['company_editor', 'viewer'] as const).map(r => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setNewRole(r)}
                        className={`rounded-lg border px-4 py-2.5 text-left text-sm font-medium transition-all ${
                          newRole === r
                            ? 'border-[#1e3a5f] bg-[#1e3a5f]/5 text-[#1e3a5f] dark:border-blue-400 dark:bg-blue-500/10 dark:text-blue-300'
                            : 'border-gray-200 text-gray-600 hover:border-gray-300 dark:border-gray-700/60 dark:text-gray-400 dark:hover:border-gray-500'
                        }`}
                      >
                        <div className="font-semibold">{ROLE_LABELS[r]}</div>
                        <div className="mt-0.5 text-[11px] opacity-70">
                          {r === 'company_editor' ? '파이프라인 실행 가능' : '열람만 가능'}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-3 border-t border-gray-100 px-5 py-4 dark:border-gray-700/40">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
                  취소
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex items-center gap-2 rounded-xl bg-[#1e3a5f] px-5 py-2 text-sm font-semibold text-white hover:bg-[#24456f] disabled:opacity-50"
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                  계정 생성
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
