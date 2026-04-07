import { ReactNode, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  History,
  Settings,
  LogOut,
  Menu,
  X,
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
  const { theme } = useThemeStore();
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

  const mainNav = navigation.filter((item) => item.show && !['관리자 구성', '매체 마스터', '회사 관리'].includes(item.name));
  const adminNav = navigation.filter((item) => item.show && ['관리자 구성', '매체 마스터', '회사 관리'].includes(item.name));

  const NavLink = ({ item }: { item: typeof navigation[0] }) => {
    const isActive = item.href === '/home'
      ? location.pathname === '/home' || location.pathname === '/'
      : location.pathname === item.href;

    return (
      <Link
        to={item.href}
        className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
          isActive
            ? 'bg-white/12 text-white border-l-2 border-[#d4af37] pl-[10px]'
            : 'text-white/70 hover:bg-white/8 hover:text-white border-l-2 border-transparent pl-[10px]'
        }`}
        onClick={() => setSidebarOpen(false)}
      >
        <item.icon className="h-4 w-4 shrink-0" />
        {item.name}
      </Link>
    );
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div
        className={`fixed inset-y-0 left-0 z-30 flex w-64 flex-col bg-[#1e3a5f] transition-transform duration-300 ease-in-out lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Logo */}
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 px-5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#d4af37]">
              <span className="text-sm font-black text-white">E</span>
            </div>
            <span className="text-sm font-bold tracking-wide text-white">EUM NEWS</span>
          </div>
          <button onClick={() => setSidebarOpen(false)} className="rounded-lg p-1 text-white/50 transition hover:bg-white/10 hover:text-white lg:hidden">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Main nav */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <div className="space-y-0.5">
            {mainNav.map((item) => (
              <NavLink key={item.name} item={item} />
            ))}
          </div>

          {adminNav.length > 0 && (
            <div className="mt-6">
              <div className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-widest text-white/30">
                Admin
              </div>
              <div className="space-y-0.5">
                {adminNav.map((item) => (
                  <NavLink key={item.name} item={item} />
                ))}
              </div>
            </div>
          )}
        </nav>

        {/* User section */}
        <div className="shrink-0 border-t border-white/10 p-3">
          <div className="flex items-center gap-3 rounded-lg px-2 py-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#d4af37] text-sm font-semibold text-white">
              {user?.email?.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-white">{user?.email}</p>
              <p className="text-[10px] text-white/40">{getRoleLabel(role)}</p>
            </div>
            <button
              onClick={handleLogout}
              className="shrink-0 rounded-lg p-1.5 text-white/40 transition hover:bg-white/10 hover:text-white"
              title="로그아웃"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="lg:pl-64">
        <button
          onClick={() => setSidebarOpen(true)}
          className="fixed top-3 left-3 z-10 rounded-lg p-1.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>

        <main className="p-4 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
