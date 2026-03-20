import { useState, useEffect } from 'react';
import { 
  Building2, 
  UserPlus, 
  Users, 
  Plus, 
  Loader2, 
  CheckCircle2, 
  XCircle, 
  ChevronRight, 
  Mail, 
  Shield, 
  ShieldAlert, 
  Settings,
  Trash2,
  Lock,
  Search
} from 'lucide-react';
import { db, functions } from '@/lib/firebase';
import { httpsCallable } from 'firebase/functions';
import { collection, query, orderBy, getDocs, doc, deleteDoc } from 'firebase/firestore';
import { useAuthStore } from '@/store/useAuthStore';

interface Company {
  id: string;
  name: string;
  active: boolean;
  createdAt?: any;
}

interface UserProfile {
  uid: string;
  email: string;
  role: 'superadmin' | 'company_admin' | 'company_editor' | 'viewer';
  companyId?: string;
  createdAt?: any;
}

export default function AdminManagement() {
  const { user: currentUser } = useAuthStore();
  const isSuper = (currentUser as any)?.role === 'superadmin';

  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [companyUsers, setCompanyUsers] = useState<UserProfile[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);

  // Modals
  const [showCompanyModal, setShowCompanyModal] = useState(false);
  const [showUserModal, setShowUserModal] = useState(false);

  // Form states
  const [newCompanyName, setNewCompanyName] = useState('');
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [newUserRole, setNewUserRole] = useState<'company_admin' | 'company_editor' | 'viewer'>('company_admin');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isSuper) {
      loadCompanies();
    }
  }, [isSuper]);

  const loadCompanies = async () => {
    setLoading(true);
    try {
      const fn = httpsCallable(functions, 'getCompanies');
      const result = await fn() as any;
      setCompanies(result.data);
    } catch (err) {
      console.error('Failed to load companies:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadCompanyUsers = async (companyId: string) => {
    setSelectedCompanyId(companyId);
    setUsersLoading(true);
    try {
      const fn = httpsCallable(functions, 'getCompanyUsers');
      const result = await fn({ companyId }) as any;
      setCompanyUsers(result.data);
    } catch (err) {
      console.error('Failed to load users:', err);
    } finally {
      setUsersLoading(false);
    }
  };

  const handleCreateCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCompanyName.trim()) return;
    setSubmitting(true);
    try {
      const fn = httpsCallable(functions, 'upsertCompany');
      await fn({ name: newCompanyName.trim(), active: true });
      setNewCompanyName('');
      setShowCompanyModal(false);
      loadCompanies();
    } catch (err: any) {
      alert('Failed: ' + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUserEmail || !newUserPassword || !selectedCompanyId) return;
    setSubmitting(true);
    try {
      const fn = httpsCallable(functions, 'adminCreateUser');
      await fn({
        email: newUserEmail,
        password: newUserPassword,
        role: newUserRole,
        companyId: selectedCompanyId
      });
      setNewUserEmail('');
      setNewUserPassword('');
      setShowUserModal(false);
      loadCompanyUsers(selectedCompanyId);
    } catch (err: any) {
      alert('Failed: ' + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!isSuper) {
    return (
      <div className="p-12 text-center text-gray-500">
        <ShieldAlert className="w-12 h-12 mx-auto mb-4 opacity-20" />
        <p>Access Denied. Superadmin required.</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-20">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Management</h1>
          <p className="text-gray-600 dark:text-gray-400 mt-1">Register companies and manage user accounts.</p>
        </div>
        <button
          onClick={() => setShowCompanyModal(true)}
          className="flex items-center px-4 py-2 bg-[#1e3a5f] text-white rounded-lg text-sm font-medium hover:bg-[#2a4a73] transition-colors"
        >
          <Plus className="w-4 h-4 mr-2" />
          Add Company
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Companies List */}
        <div className="lg:col-span-1 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <Building2 className="w-4 h-4" /> Companies
            </h2>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-700 max-h-[600px] overflow-y-auto">
            {loading ? (
              <div className="p-8 text-center"><Loader2 className="w-6 h-6 animate-spin mx-auto text-gray-300" /></div>
            ) : companies.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-400">No companies registered.</div>
            ) : (
              companies.map(company => (
                <button
                  key={company.id}
                  onClick={() => loadCompanyUsers(company.id)}
                  className={`w-full text-left px-6 py-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors ${
                    selectedCompanyId === company.id ? 'bg-blue-50/50 dark:bg-blue-900/10 border-r-4 border-[#1e3a5f]' : ''
                  }`}
                >
                  <div>
                    <p className="font-medium text-gray-900 dark:text-white">{company.name}</p>
                    <p className="text-xs text-gray-500 mt-1">ID: {company.id}</p>
                  </div>
                  <ChevronRight className={`w-4 h-4 text-gray-300 transition-transform ${selectedCompanyId === company.id ? 'translate-x-1 text-[#1e3a5f]' : ''}`} />
                </button>
              ))
            )}
          </div>
        </div>

        {/* Users List for Selected Company */}
        <div className="lg:col-span-2 space-y-4">
          {!selectedCompanyId ? (
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-12 text-center text-gray-500">
              <Users className="w-12 h-12 mx-auto mb-4 opacity-10" />
              <p>Select a company to manage users.</p>
            </div>
          ) : (
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden min-h-[400px]">
              <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
                    {companies.find(c => c.id === selectedCompanyId)?.name} Users
                  </h2>
                  <p className="text-xs text-gray-500 mt-0.5">{companyUsers.length} total staff members</p>
                </div>
                <button
                  onClick={() => setShowUserModal(true)}
                  className="flex items-center px-3 py-1.5 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-lg text-xs font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                >
                  <UserPlus className="w-3.5 h-3.5 mr-1.5" />
                  Add User
                </button>
              </div>
              
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-gray-50 dark:bg-gray-700/50 text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
                    <tr>
                      <th className="px-6 py-3 font-medium">User</th>
                      <th className="px-6 py-3 font-medium">Role</th>
                      <th className="px-6 py-3 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {usersLoading ? (
                      <tr><td colSpan={3} className="px-6 py-12 text-center"><Loader2 className="w-6 h-6 animate-spin mx-auto text-gray-300" /></td></tr>
                    ) : companyUsers.length === 0 ? (
                      <tr><td colSpan={3} className="px-6 py-12 text-center text-gray-400">No users found for this company.</td></tr>
                    ) : (
                      companyUsers.map(u => (
                        <tr key={u.uid} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-gray-500 font-medium">
                                {u.email[0].toUpperCase()}
                              </div>
                              <div className="min-w-0">
                                <p className="font-medium text-gray-900 dark:text-white truncate">{u.email}</p>
                                <p className="text-[10px] text-gray-500 font-mono">UID: {u.uid}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                              u.role === 'company_admin' ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300' :
                              u.role === 'company_editor' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' :
                              'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                            }`}>
                              {u.role.replace('_', ' ')}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-right">
                            <button className="p-1.5 text-gray-400 hover:text-red-500 transition-colors">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Company Modal */}
      {showCompanyModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl max-w-md w-full shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200">
            <form onSubmit={handleCreateCompany}>
              <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                <h3 className="text-lg font-bold text-gray-900 dark:text-white">Register New Company</h3>
              </div>
              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1.5">Company Name</label>
                  <input
                    type="text"
                    required
                    value={newCompanyName}
                    onChange={e => setNewCompanyName(e.target.value)}
                    placeholder="e.g. Acme Corp"
                    className="w-full px-4 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-[#1e3a5f] transition-all"
                  />
                </div>
              </div>
              <div className="px-6 py-4 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-100 dark:border-gray-700 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowCompanyModal(false)}
                  className="px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-5 py-2 bg-[#1e3a5f] text-white rounded-lg text-sm font-medium hover:bg-[#2a4a73] transition-colors disabled:opacity-50"
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Register'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* User Modal */}
      {showUserModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl max-w-md w-full shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200">
            <form onSubmit={handleCreateUser}>
              <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                <h3 className="text-lg font-bold text-gray-900 dark:text-white">Add New User</h3>
                <p className="text-xs text-gray-500 mt-1">Assign admin or editor to {companies.find(c => c.id === selectedCompanyId)?.name}</p>
              </div>
              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1.5">Email Address</label>
                  <input
                    type="email"
                    required
                    value={newUserEmail}
                    onChange={e => setNewUserEmail(e.target.value)}
                    placeholder="user@example.com"
                    className="w-full px-4 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-[#1e3a5f] transition-all"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1.5">Password</label>
                  <input
                    type="password"
                    required
                    value={newUserPassword}
                    onChange={e => setNewUserPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full px-4 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-[#1e3a5f] transition-all"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1.5">Role</label>
                  <select
                    value={newUserRole}
                    onChange={e => setNewUserRole(e.target.value as any)}
                    className="w-full px-4 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-[#1e3a5f] transition-all"
                  >
                    <option value="company_admin">Company Admin (Full Settings)</option>
                    <option value="company_editor">Company Editor (Review Only)</option>
                    <option value="viewer">Viewer (Read Only)</option>
                  </select>
                </div>
              </div>
              <div className="px-6 py-4 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-100 dark:border-gray-700 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowUserModal(false)}
                  className="px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-5 py-2 bg-[#1e3a5f] text-white rounded-lg text-sm font-medium hover:bg-[#2a4a73] transition-colors disabled:opacity-50"
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Create Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
