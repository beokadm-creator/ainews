import { useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { useAuthStore } from '@/store/useAuthStore';

// Layouts
import Layout from '@/components/Layout';
import AdminLayout from '@/components/AdminLayout';
import ProtectedRoute from '@/components/ProtectedRoute';

// ─── Company user pages ────────────────────────────────────
import Login from '@/pages/Login';
import UserHome from '@/pages/UserHome';
import Articles from '@/pages/Articles';
import TrackedCompanies from '@/pages/TrackedCompanies';
import ReportNew from '@/pages/ReportNew';
import Briefing from '@/pages/Briefing';
import History from '@/pages/History';
import MediaSelector from '@/pages/MediaSelector';
import Team from '@/pages/Team';
import Settings from '@/pages/Settings';
import DeliveryCenter from '@/pages/DeliveryCenter';

// ─── Superadmin pages ──────────────────────────────────────
import AdminDashboard from '@/pages/admin/AdminDashboard';
import AdminArticles from '@/pages/admin/AdminArticles';
import AdminSettings from '@/pages/admin/AdminSettings';
import AdminKeywords from '@/pages/admin/AdminKeywords';
import AdminManagement from '@/pages/AdminManagement';
import MediaAdmin from '@/pages/MediaAdmin';
import NotFound from '@/pages/NotFound';

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
    <Router>
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
    </Router>
  );
}
