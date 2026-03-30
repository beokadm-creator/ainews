import { ReactNode, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  History,
  Settings,
  LogOut,
  Menu,
  X,
  Moon,
  Sun,
  Library,
  Users,
  Search,
  Star,
  BookOpen,
  ShieldCheck,
  Database,
  Send,
} from 'lucide-react';
import { useAuthStore } from '@/store/useAuthStore';
import { useThemeStore } from '@/store/useThemeStore';

interface LayoutProps {
  children: ReactNode;
}

function getRoleLabel(role?: string) {
  switch (role) {
    case 'superadmin':
      return 'Superadmin';
    case 'company_admin':
      return 'Company Admin';
    case 'company_editor':
      return 'Company Editor';
    default:
      return 'Viewer';
  }
}

const NAV_LABELS = {
  home: '\uB300\uC2DC\uBCF4\uB4DC',
  articles: '\uAE30\uC0AC \uAC80\uC0C9',
  tracked: '\uAD00\uC2EC\uB4F1\uB85D\uD68C\uC0AC',
  briefing: '\uB0B4\uBD80 \uB9AC\uD3EC\uD2B8',
  history: '\uB9AC\uD3EC\uD2B8 \uC774\uB825',
  delivery: '\uC678\uBD80 \uBA54\uC77C\uB9DD',
  media: '\uB9E4\uCCB4 \uAD6C\uB3C5',
  team: '\uC0AC\uC6A9\uC790 \uAD00\uB9AC',
  settings: '\uD68C\uC0AC \uC124\uC815',
  admin: '\uAD00\uB9AC\uC790 \uAD6C\uC131',
  sources: '\uB9E4\uCCB4 \uB9C8\uC2A4\uD130',
  companies: '\uD68C\uC0AC \uAD00\uB9AC',
  logout: 'Logout',
} as const;

export default function Layout({ children }: LayoutProps) {
  const { user, logout } = useAuthStore();
  const { theme, toggleTheme } = useThemeStore();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const role = (user as any)?.role;
  const isSuperadmin = role === 'superadmin';
  const isAdminOrAbove = role === 'company_admin' || role === 'company_editor' || role === 'superadmin';

  useEffect(() => {
    if (theme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, [theme]);

  const navigation = [
    { name: NAV_LABELS.home, href: '/home', icon: LayoutDashboard, show: true },
    { name: NAV_LABELS.articles, href: '/articles', icon: Search, show: true },
    { name: NAV_LABELS.tracked, href: '/tracked-companies', icon: Star, show: true },
    { name: NAV_LABELS.briefing, href: '/briefing', icon: BookOpen, show: true },
    { name: NAV_LABELS.history, href: '/history', icon: History, show: isAdminOrAbove },
    { name: NAV_LABELS.delivery, href: '/delivery', icon: Send, show: role === 'company_admin' },
    { name: NAV_LABELS.media, href: '/media', icon: Library, show: role === 'company_admin' },
    { name: NAV_LABELS.team, href: '/team', icon: Users, show: role === 'company_admin' },
    { name: NAV_LABELS.settings, href: '/settings', icon: Settings, show: role === 'company_admin' },
    { name: NAV_LABELS.admin, href: '#', icon: ShieldCheck, show: isSuperadmin },
    { name: NAV_LABELS.sources, href: '/admin/sources', icon: Database, show: isSuperadmin },
    { name: NAV_LABELS.companies, href: '/admin/companies', icon: Users, show: isSuperadmin },
  ];

  const handleLogout = async () => {
    await logout();
  };

  const NavLink = ({ item }: { item: typeof navigation[0] }) => {
    const isActive = item.href === '/home'
      ? location.pathname === '/home' || location.pathname === '/'
      : location.pathname === item.href;

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
        <div
          className="fixed inset-0 bg-gray-600 bg-opacity-75 z-20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div
        className={`fixed inset-y-0 left-0 z-30 w-64 bg-[#1e3a5f] dark:bg-gray-950 transform transition-transform duration-300 ease-in-out lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex flex-col h-full">
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

          <nav className="flex-1 px-4 py-5 space-y-1 overflow-y-auto">
            {navigation.filter((item) => item.show).map((item) => (
              <NavLink key={item.name} item={item} />
            ))}
          </nav>

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
              {NAV_LABELS.logout}
            </button>
          </div>
        </div>
      </div>

      <div className="lg:pl-64">
        <div className="sticky top-0 z-10 h-16 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between px-4 lg:px-8 transition-colors duration-200">
          <button
            onClick={() => setSidebarOpen(true)}
            className="lg:hidden text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          >
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

        <main className="p-4 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
