import { useEffect, Suspense, lazy } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { useAuthStore } from '@/store/useAuthStore';
import { ErrorBoundary } from 'react-error-boundary';
import { Toaster } from 'react-hot-toast';
import { GlobalErrorFallback } from '@/components/GlobalErrorFallback';

// Layouts
import Layout from '@/components/Layout';
import AdminLayout from '@/components/AdminLayout';
import ProtectedRoute from '@/components/ProtectedRoute';
import { Loader2 } from 'lucide-react';

// Loading Fallback
const PageLoader = () => (
  <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-900">
    <Loader2 className="h-8 w-8 animate-spin text-[#d4af37]" />
  </div>
);

// ─── Lazy loaded pages ────────────────────────────────────
const Login = lazy(() => import('@/pages/Login'));
const UserHome = lazy(() => import('@/pages/UserHome'));
const Articles = lazy(() => import('@/pages/Articles'));
const TrackedCompanies = lazy(() => import('@/pages/TrackedCompanies'));
const ReportNew = lazy(() => import('@/pages/ReportNew'));
const Briefing = lazy(() => import('@/pages/Briefing'));
const History = lazy(() => import('@/pages/History'));
const MediaSelector = lazy(() => import('@/pages/MediaSelector'));
const Team = lazy(() => import('@/pages/Team'));
const Settings = lazy(() => import('@/pages/Settings'));
const DeliveryCenter = lazy(() => import('@/pages/DeliveryCenter'));

// ─── Superadmin pages ──────────────────────────────────────
const AdminDashboard = lazy(() => import('@/pages/admin/AdminDashboard'));
const AdminArticles = lazy(() => import('@/pages/admin/AdminArticles'));
const AdminSettings = lazy(() => import('@/pages/admin/AdminSettings'));
const AdminKeywords = lazy(() => import('@/pages/admin/AdminKeywords'));
const AdminManagement = lazy(() => import('@/pages/AdminManagement'));
const MediaAdmin = lazy(() => import('@/pages/MediaAdmin'));
const NotFound = lazy(() => import('@/pages/NotFound'));

// ─── Role-based root redirect ──────────────────────────────
function RootRedirect() {
  const { user, loading } = useAuthStore();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  const role = (user as any)?.role;
  if (role === 'superadmin') return <Navigate to="/admin" replace />;
  return <Navigate to="/home" replace />;
}

export default function App() {
  const { setUserWithProfile } = useAuthStore();

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUserWithProfile(user);
    });
    return () => unsubscribe();
  }, [setUserWithProfile]);

  return (
    <ErrorBoundary FallbackComponent={GlobalErrorFallback} onReset={() => window.location.href = '/'}>
      <Router>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            {/* Public */}
            <Route path="/login" element={<Login />} />

        {/* Root redirect based on role */}
        <Route path="/" element={<RootRedirect />} />

        {/* ── Company user routes ──────────────────────────── */}
        <Route path="/home" element={
          <ProtectedRoute requiredRole={['company_admin', 'company_editor', 'viewer']}>
            <Layout><UserHome /></Layout>
          </ProtectedRoute>
        } />
        <Route path="/articles" element={
          <ProtectedRoute requiredRole={['company_admin', 'company_editor', 'viewer']}>
            <Layout><Articles /></Layout>
          </ProtectedRoute>
        } />
        <Route path="/tracked-companies" element={
          <ProtectedRoute requiredRole={['company_admin', 'company_editor', 'viewer']}>
            <Layout><TrackedCompanies /></Layout>
          </ProtectedRoute>
        } />
        <Route path="/reports/new" element={
          <ProtectedRoute requiredRole={['company_admin', 'company_editor']}>
            <Layout><ReportNew /></Layout>
          </ProtectedRoute>
        } />
        <Route path="/briefing" element={
          <ProtectedRoute requiredRole={['company_admin', 'company_editor', 'viewer']}>
            <Layout><Briefing /></Layout>
          </ProtectedRoute>
        } />
        <Route path="/history" element={
          <ProtectedRoute requiredRole={['company_admin', 'company_editor']}>
            <Layout><History /></Layout>
          </ProtectedRoute>
        } />
        <Route path="/media" element={
          <ProtectedRoute requiredRole={['company_admin']}>
            <Layout><MediaSelector /></Layout>
          </ProtectedRoute>
        } />
        <Route path="/delivery" element={
          <ProtectedRoute requiredRole={['company_admin']}>
            <Layout><DeliveryCenter /></Layout>
          </ProtectedRoute>
        } />
        <Route path="/team" element={
          <ProtectedRoute requiredRole={['company_admin']}>
            <Layout><Team /></Layout>
          </ProtectedRoute>
        } />
        <Route path="/settings" element={
          <ProtectedRoute requiredRole={['company_admin']}>
            <Layout><Settings /></Layout>
          </ProtectedRoute>
        } />

        {/* ── Superadmin routes ────────────────────────────── */}
        <Route path="/admin" element={
          <ProtectedRoute requiredRole="superadmin">
            <AdminLayout><AdminDashboard /></AdminLayout>
          </ProtectedRoute>
        } />
        <Route path="/admin/articles" element={
          <ProtectedRoute requiredRole="superadmin">
            <AdminLayout><AdminArticles /></AdminLayout>
          </ProtectedRoute>
        } />
        <Route path="/admin/sources" element={
          <ProtectedRoute requiredRole="superadmin">
            <AdminLayout><MediaAdmin /></AdminLayout>
          </ProtectedRoute>
        } />
        <Route path="/admin/companies" element={
          <ProtectedRoute requiredRole="superadmin">
            <AdminLayout><AdminManagement /></AdminLayout>
          </ProtectedRoute>
        } />
        <Route path="/admin/settings" element={
          <ProtectedRoute requiredRole="superadmin">
            <AdminLayout><AdminSettings /></AdminLayout>
          </ProtectedRoute>
        } />
        <Route path="/admin/keywords" element={
          <ProtectedRoute requiredRole="superadmin">
            <AdminLayout><AdminKeywords /></AdminLayout>
          </ProtectedRoute>
        } />
        {/* Catch all */}
        <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </Router>
      <Toaster 
        position="bottom-right"
        toastOptions={{
          duration: 4000,
          style: {
            background: '#333',
            color: '#fff',
            fontSize: '14px',
            borderRadius: '8px',
          },
          success: {
            iconTheme: {
              primary: '#10b981',
              secondary: '#fff',
            },
          },
          error: {
            iconTheme: {
              primary: '#ef4444',
              secondary: '#fff',
            },
            duration: 6000,
          },
        }}
      />
    </ErrorBoundary>
  );
}
