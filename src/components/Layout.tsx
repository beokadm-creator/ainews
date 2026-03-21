import { ReactNode, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  History,
  FileText,
  Settings,
  LogOut,
  Menu,
  X,
  Moon,
  Sun,
  Library,
  Newspaper,
  ShieldCheck,
  TrendingUp,
  Database
} from 'lucide-react';
import { useAuthStore } from '@/store/useAuthStore';
import { useThemeStore } from '@/store/useThemeStore';

interface LayoutProps {
  children: ReactNode;
}

function getRoleLabel(role?: string) {
  switch (role) {
    case 'superadmin': return 'Superadmin';
    case 'company_admin': return 'Company Admin';
    case 'company_editor': return 'Company Editor';
    default: return 'Viewer';
  }
}

export default function Layout({ children }: LayoutProps) {
  const { user, logout } = useAuthStore();
  const { theme, toggleTheme } = useThemeStore();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const role = (user as any)?.role;
  const isSuperadmin = role === 'superadmin';
  const isAdminOrAbove = isSuperadmin || role === 'company_admin';

  useEffect(() => {
    if (theme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, [theme]);

  // ─────────────────────────────────────────
  // Navigation: role-aware
  // ─────────────────────────────────────────
  const navigation = [
    { name: 'Dashboard', href: '/', icon: LayoutDashboard, show: true },
    { name: 'History', href: '/history', icon: History, show: true },
    { name: 'Output', href: '/briefing', icon: FileText, show: true },
    { name: 'Manual Entry', href: '/manual-entry', icon: Newspaper, show: true },
    // company_admin & above: 매체 구독 선택
    { name: '매체 구독', href: '/media', icon: Library, show: isAdminOrAbove },
    // Settings: company_admin & above
    { name: 'Settings', href: '/settings', icon: Settings, show: isAdminOrAbove },
  ];

  // Superadmin-only section
  const superadminNav = [
    { name: 'Media Library', href: '/admin/media', icon: ShieldCheck },
    { name: 'Company & Users', href: '/admin/management', icon: ShieldCheck },
    { name: 'Scraping Rules', href: '/admin/scraping', icon: Database },
  ];

  const handleLogout = async () => {
    await logout();
  };

  const NavLink = ({ item }: { item: typeof navigation[0] }) => {
    const isActive = location.pathname === item.href;
    return (
      <Link
        key={item.name}
        to={item.href}
        className={`flex items-center px-4 py-2.5 text-sm font-medium rounded-lg transition-colors ${
          isActive ? 'bg-[#d4af37] text-white' : 'text-gray-300 hover:bg-white/10 hover:text-white'
        }`}
        onClick={() => setSidebarOpen(false)}
      >
        <item.icon className="w-4 h-4 mr-3" />
        {item.name}
      </Link>
    );
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 transition-colors duration-200">
      {sidebarOpen && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-75 z-20 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <div className={`fixed inset-y-0 left-0 z-30 w-64 bg-[#1e3a5f] dark:bg-gray-950 transform transition-transform duration-300 ease-in-out lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex flex-col h-full">
          {/* Logo */}
          <div className="flex items-center justify-between h-16 px-6 border-b border-white/10 flex-shrink-0">
            <div className="flex items-center">
              <div className="w-8 h-8 bg-[#d4af37] rounded flex items-center justify-center mr-3">
                <span className="text-white font-bold text-lg">E</span>
              </div>
              <span className="text-white font-semibold text-lg">NEWS</span>
            </div>
            <button onClick={() => setSidebarOpen(false)} className="lg:hidden text-gray-400 hover:text-white">
              <X className="w-6 h-6" />
            </button>
          </div>

          {/* Navigation */}
          <nav className="flex-1 px-4 py-5 space-y-1 overflow-y-auto">
            {navigation.filter(i => i.show).map(item => <NavLink key={item.name} item={item} />)}

            {/* Superadmin section */}
            {isSuperadmin && (
              <>
                <div className="pt-4 pb-2">
                  <p className="px-4 text-xs font-semibold text-white/40 uppercase tracking-wider">Superadmin</p>
                </div>
                {superadminNav.map(item => {
                  const isActive = location.pathname === item.href;
                  return (
                    <Link
                      key={item.name}
                      to={item.href}
                      className={`flex items-center px-4 py-2.5 text-sm font-medium rounded-lg transition-colors ${
                        isActive ? 'bg-[#d4af37] text-white' : 'text-yellow-300/70 hover:bg-white/10 hover:text-yellow-300'
                      }`}
                      onClick={() => setSidebarOpen(false)}
                    >
                      <item.icon className="w-4 h-4 mr-3" />
                      {item.name}
                    </Link>
                  );
                })}
              </>
            )}
          </nav>

          {/* User info */}
          <div className="p-4 border-t border-white/10 flex-shrink-0">
            <div className="flex items-center mb-3">
              <div className="w-8 h-8 bg-[#d4af37] rounded-full flex items-center justify-center mr-3 flex-shrink-0">
                <span className="text-white text-sm font-medium">{user?.email?.charAt(0).toUpperCase()}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white truncate">{user?.email}</p>
                <p className="text-xs text-gray-400">{getRoleLabel(role)}</p>
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="w-full flex items-center justify-center px-4 py-2 text-sm font-medium text-gray-300 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
            >
              <LogOut className="w-4 h-4 mr-2" />
              Logout
            </button>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="lg:pl-64">
        {/* Top bar */}
        <div className="sticky top-0 z-10 h-16 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between px-4 lg:px-8 transition-colors duration-200">
          <button onClick={() => setSidebarOpen(true)} className="lg:hidden text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
            <Menu className="w-6 h-6" />
          </button>
          <div className="flex-1" />
          <button
            onClick={toggleTheme}
            className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors"
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>
        </div>

        <main className="p-4 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
