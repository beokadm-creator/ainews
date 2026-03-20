import { Navigate } from 'react-router-dom';
import { useAuthStore } from '@/store/useAuthStore';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredRole?: string | string[];
}

export default function ProtectedRoute({ children, requiredRole }: ProtectedRouteProps) {
  const { user, loading } = useAuthStore();

  // C-01 FIX: Auth 초기화 중이면 로딩 표시 (새로고침 시 튕김 방지)
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-[#1e3a5f] border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-500 dark:text-gray-400">인증 확인 중...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // Role 기반 접근 제한 (선택적)
  if (requiredRole) {
    const role = (user as any)?.role;
    const allowed = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
    if (!allowed.includes(role)) {
      return (
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
          <div className="text-center">
            <p className="text-lg font-semibold text-gray-700 dark:text-gray-300">접근 권한이 없습니다</p>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">필요 역할: {allowed.join(', ')}</p>
          </div>
        </div>
      );
    }
  }

  return <>{children}</>;
}
