import { ReactNode, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Globe, FileSearch, Building2,
  Database, LogOut, Menu, X, Moon, Sun, ChevronRight
} from 'lucide-react';
import { useAuthStore } from '@/store/useAuthStore';
import { useThemeStore } from '@/store/useThemeStore';

interface AdminLayoutProps { children: ReactNode; }

const adminNav = [
  {
    label: '수집 모니터링',
    items: [
      { name: '수집 현황', href: '/admin', icon: LayoutDashboard, desc: '방식별 실시간 수집 상태' },
      { name: '매체 라이브러리', href: '/admin/sources', icon: Globe, desc: 'RSS / API / 스크래핑 / 로컬PC' },
      { name: '수집 기사 검증', href: '/admin/articles', icon: FileSearch, desc: '전체 기사 조회 & AI 검증 현황' },
    ]
  },
  {
    label: '관리',
    items: [
      { name: '회사 & 사용자', href: '/admin/companies', icon: Building2, desc: '고객사 및 계정 관리' },
      { name: '스크래핑 규칙', href: '/admin/scraping', icon: Database, desc: '로컬PC 수집 키워드/카테고리' },
    ]
  },
];

export default function AdminLayout({ children }: AdminLayoutProps) {
  const { user, logout } = useAuthStore();
  const { theme, toggleTheme } = useThemeStore();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    if (theme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, [theme]);

  const handleLogout = async () => { await logout(); navigate('/login'); };

  const isActive = (href: string) =>
    href === '/admin' ? location.pathname === '/admin' : location.pathname.startsWith(href);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 bg-black/60 z-20 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-30 w-64 bg-gray-900 border-r border-white/5 flex flex-col transform transition-transform duration-300 lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        {/* Logo */}
        <div className="h-16 px-5 flex items-center justify-between border-b border-white/5">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-[#d4af37] rounded-lg flex items-center justify-center">
              <span className="text-white font-black text-sm">E</span>
            </div>
            <div>
              <p className="text-white font-bold text-sm leading-none">EUM NEWS</p>
              <p className="text-yellow-400/70 text-[10px] font-semibold tracking-widest uppercase mt-0.5">Superadmin</p>
            </div>
          </div>
          <button onClick={() => setSidebarOpen(false)} className="lg:hidden text-white/40 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-5">
          {adminNav.map(group => (
            <div key={group.label}>
              <p className="px-2 mb-1.5 text-[10px] font-bold uppercase tracking-widest text-white/25">{group.label}</p>
              <div className="space-y-0.5">
                {group.items.map(item => {
                  const active = isActive(item.href);
                  return (
                    <Link
                      key={item.href}
                      to={item.href}
                      onClick={() => setSidebarOpen(false)}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all group ${
                        active
                          ? 'bg-[#d4af37]/15 border border-[#d4af37]/30'
                          : 'hover:bg-white/5 border border-transparent'
                      }`}
                    >
                      <item.icon className={`w-4 h-4 flex-shrink-0 ${active ? 'text-[#d4af37]' : 'text-white/40 group-hover:text-white/70'}`} />
                      <div className="min-w-0">
                        <p className={`text-sm font-medium leading-none ${active ? 'text-[#d4af37]' : 'text-white/70 group-hover:text-white'}`}>{item.name}</p>
                        <p className="text-[10px] text-white/25 mt-0.5 truncate">{item.desc}</p>
                      </div>
                      {active && <ChevronRight className="w-3.5 h-3.5 text-[#d4af37] ml-auto flex-shrink-0" />}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="p-3 border-t border-white/5">
          <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-white/5 mb-2">
            <div className="w-7 h-7 bg-[#d4af37] rounded-full flex items-center justify-center flex-shrink-0">
              <span className="text-white text-xs font-bold">{user?.email?.charAt(0).toUpperCase()}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-white truncate">{user?.email}</p>
              <p className="text-[10px] text-yellow-400/70 font-semibold">Superadmin</p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-white/40 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />로그아웃
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="lg:pl-64 min-h-screen flex flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-10 h-14 bg-gray-900/90 backdrop-blur border-b border-white/5 flex items-center justify-between px-4 lg:px-6">
          <button onClick={() => setSidebarOpen(true)} className="lg:hidden text-white/40 hover:text-white">
            <Menu className="w-5 h-5" />
          </button>
          {/* Breadcrumb */}
          <div className="hidden lg:flex items-center gap-2 text-sm">
            <span className="text-white/30">EUM NEWS</span>
            <ChevronRight className="w-3.5 h-3.5 text-white/20" />
            <span className="text-white/70 font-medium">
              {adminNav.flatMap(g => g.items).find(i => isActive(i.href))?.name || 'Superadmin'}
            </span>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <button onClick={toggleTheme} className="p-1.5 text-white/30 hover:text-white hover:bg-white/5 rounded-lg transition-colors">
              {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 lg:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
