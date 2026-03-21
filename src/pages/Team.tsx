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
  company_admin: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300',
  company_editor: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  viewer: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
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

  // Form state
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
      <div className="p-12 text-center text-gray-500">
        <ShieldAlert className="w-12 h-12 mx-auto mb-4 opacity-20" />
        <p className="font-medium">접근 권한이 없습니다.</p>
        <p className="text-sm mt-1">회사 관리자 계정으로 로그인해야 합니다.</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-20">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">팀 관리</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1 text-sm">스테프 계정을 등록하고 관리합니다.</p>
        </div>
        <button
          onClick={() => { setShowModal(true); setError(''); }}
          className="flex items-center px-4 py-2 bg-[#1e3a5f] text-white rounded-lg text-sm font-medium hover:bg-[#2a4a73] transition-colors"
        >
          <UserPlus className="w-4 h-4 mr-2" />
          스테프 추가
        </button>
      </div>

      {/* Members table */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center gap-2">
          <Users className="w-4 h-4 text-gray-400" />
          <span className="text-sm font-semibold text-gray-900 dark:text-white">
            팀원 목록
          </span>
          {!loading && (
            <span className="ml-auto text-xs text-gray-400">{members.length}명</span>
          )}
        </div>

        {loading ? (
          <div className="py-20 text-center">
            <Loader2 className="w-6 h-6 animate-spin mx-auto text-gray-300" />
          </div>
        ) : members.length === 0 ? (
          <div className="py-20 text-center">
            <Users className="w-10 h-10 mx-auto mb-3 text-gray-200 dark:text-gray-700" />
            <p className="text-sm text-gray-400">등록된 팀원이 없습니다.</p>
            <p className="text-xs text-gray-400 mt-1">스테프 추가 버튼으로 계정을 만들어주세요.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-700/50 text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
              <tr>
                <th className="px-6 py-3 text-left font-medium">이메일</th>
                <th className="px-6 py-3 text-left font-medium">권한</th>
                <th className="px-6 py-3 text-right font-medium">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {members.map(member => {
                const isMe = member.uid === (currentUser as any)?.uid;
                const isProtected = member.role === 'company_admin' || (member.role as string) === 'superadmin';
                return (
                  <tr key={member.uid} className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-[#1e3a5f]/10 dark:bg-[#1e3a5f]/30 flex items-center justify-center text-[#1e3a5f] dark:text-blue-300 font-semibold text-sm flex-shrink-0">
                          {member.email[0].toUpperCase()}
                        </div>
                        <div>
                          <p className="font-medium text-gray-900 dark:text-white">{member.email}</p>
                          {isMe && <p className="text-[10px] text-gray-400">(본인)</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded text-[11px] font-bold uppercase tracking-wide ${ROLE_COLORS[member.role] || ROLE_COLORS.viewer}`}>
                        {ROLE_LABELS[member.role] || member.role}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      {!isMe && !isProtected && (
                        <button
                          onClick={() => handleDelete(member.uid, member.email)}
                          disabled={deleting === member.uid}
                          className="p-1.5 text-gray-300 hover:text-red-500 dark:text-gray-600 dark:hover:text-red-400 transition-colors disabled:opacity-50"
                          title="계정 삭제"
                        >
                          {deleting === member.uid
                            ? <Loader2 className="w-4 h-4 animate-spin" />
                            : <Trash2 className="w-4 h-4" />
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
      <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl border border-gray-100 dark:border-gray-700 p-5">
        <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">권한 안내</p>
        <div className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
          <div className="flex items-start gap-3">
            <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wide flex-shrink-0 ${ROLE_COLORS.company_admin}`}>관리자</span>
            <span>매체 설정, AI 키 관리, 스테프 등록/삭제 가능</span>
          </div>
          <div className="flex items-start gap-3">
            <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wide flex-shrink-0 ${ROLE_COLORS.company_editor}`}>스테프</span>
            <span>파이프라인 실행, 브리핑 열람, 기사 조회 가능</span>
          </div>
          <div className="flex items-start gap-3">
            <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wide flex-shrink-0 ${ROLE_COLORS.viewer}`}>뷰어</span>
            <span>브리핑 및 기사 열람만 가능 (실행 불가)</span>
          </div>
        </div>
      </div>

      {/* Add member modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl max-w-md w-full shadow-2xl">
            <form onSubmit={handleAdd}>
              <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-bold text-gray-900 dark:text-white">스테프 추가</h3>
                  <p className="text-xs text-gray-500 mt-0.5">새 팀원 계정을 생성합니다.</p>
                </div>
                <button type="button" onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-6 space-y-4">
                {error && (
                  <div className="flex items-center gap-2 px-4 py-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-600 dark:text-red-400">
                    <span>{error}</span>
                  </div>
                )}

                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1.5">
                    <Mail className="inline w-3.5 h-3.5 mr-1" />이메일
                  </label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="staff@company.com"
                    className="w-full px-4 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-[#1e3a5f] transition-all"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1.5">임시 비밀번호</label>
                  <div className="relative">
                    <input
                      type={showPw ? 'text' : 'password'}
                      required
                      minLength={8}
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="최소 8자 이상"
                      className="w-full px-4 py-2 pr-10 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-[#1e3a5f] transition-all"
                    />
                    <button type="button" onClick={() => setShowPw(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                      {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1.5">권한</label>
                  <div className="grid grid-cols-2 gap-2">
                    {(['company_editor', 'viewer'] as const).map(r => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setNewRole(r)}
                        className={`px-4 py-2.5 rounded-lg text-sm font-medium border transition-all text-left ${
                          newRole === r
                            ? 'border-[#1e3a5f] bg-[#1e3a5f]/5 text-[#1e3a5f] dark:bg-[#1e3a5f]/20 dark:text-blue-300'
                            : 'border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-gray-300'
                        }`}
                      >
                        <div className="font-semibold">{ROLE_LABELS[r]}</div>
                        <div className="text-[11px] mt-0.5 opacity-70">
                          {r === 'company_editor' ? '파이프라인 실행 가능' : '열람만 가능'}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="px-6 py-4 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-100 dark:border-gray-700 flex justify-end gap-3">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors">
                  취소
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex items-center px-5 py-2 bg-[#1e3a5f] text-white rounded-lg text-sm font-medium hover:bg-[#2a4a73] transition-colors disabled:opacity-50"
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <UserPlus className="w-4 h-4 mr-2" />}
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
