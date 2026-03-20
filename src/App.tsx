import { useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { useAuthStore } from '@/store/useAuthStore';

// Components
import Layout from '@/components/Layout';
import ProtectedRoute from '@/components/ProtectedRoute';

// Pages
import Login from '@/pages/Login';
import Dashboard from '@/pages/Dashboard';
import History from '@/pages/History';
import Briefing from '@/pages/Briefing';
import Settings from '@/pages/Settings';
import ManualEntry from '@/pages/ManualEntry';
import MediaAdmin from '@/pages/MediaAdmin';
import MediaSelector from '@/pages/MediaSelector';
import AdminManagement from '@/pages/AdminManagement';
import MarketInsight from '@/pages/MarketInsight';

export default function App() {
  // BUG-07 FIX: setUserWithProfile로 변경 (Firestore role/companyIds 포함 로드)
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
        {/* Public Routes */}
        <Route path="/login" element={<Login />} />

        {/* Protected Routes */}
        <Route path="/" element={<ProtectedRoute><Layout><Dashboard /></Layout></ProtectedRoute>} />
        <Route path="/history" element={<ProtectedRoute><Layout><History /></Layout></ProtectedRoute>} />
        <Route path="/briefing" element={<ProtectedRoute><Layout><Briefing /></Layout></ProtectedRoute>} />
        <Route path="/manual-entry" element={<ProtectedRoute><Layout><ManualEntry /></Layout></ProtectedRoute>} />
        <Route path="/media" element={<ProtectedRoute><Layout><MediaSelector /></Layout></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute><Layout><Settings /></Layout></ProtectedRoute>} />
        <Route path="/admin/media" element={<ProtectedRoute><Layout><MediaAdmin /></Layout></ProtectedRoute>} />
        <Route path="/admin/management" element={<ProtectedRoute><Layout><AdminManagement /></Layout></ProtectedRoute>} />
        <Route path="/admin/market-insight" element={<ProtectedRoute><Layout><MarketInsight /></Layout></ProtectedRoute>} />

        {/* Catch all */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
}
