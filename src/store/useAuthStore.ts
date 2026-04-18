import { create } from 'zustand';
import { User, signInWithEmailAndPassword, signOut as firebaseSignOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';

export type AppUserRole = 'superadmin' | 'company_admin' | 'company_editor' | 'viewer';

export interface AppUser extends User {
  role?: AppUserRole;
  companyId?: string; // Add this missing property
  companyIds?: string[];
  managedCompanyIds?: string[];
  primaryCompanyId?: string | null;
}

interface AuthState {
  user: AppUser | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setUserWithProfile: (user: User | null) => Promise<void>;
}

// ─────────────────────────────────────────
// BUG-07 FIX: Firestore profile로 role/companyIds 병합하는 공통 함수
// onAuthStateChanged와 login 모두 이 함수를 사용
// ─────────────────────────────────────────
async function mergeUserProfile(firebaseUser: User): Promise<AppUser> {
  try {
    const userDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
    if (userDoc.exists()) {
      const profile = userDoc.data() as any;
      const companyIds = profile.companyIds || (profile.companyId ? [profile.companyId] : []);
      const managedCompanyIds = profile.managedCompanyIds || [];
      return {
        ...firebaseUser,
        role: profile.role,
        companyId: profile.companyId,
        companyIds,
        managedCompanyIds,
        primaryCompanyId: companyIds[0] || managedCompanyIds[0] || profile.companyId || null,
      } as AppUser;
    }
  } catch (err: any) {
    if (err.code === 'permission-denied') {
      console.error(`Missing or insufficient permissions reading user profile from /users/${firebaseUser.uid}. Please check Firestore Security Rules.`, err);
    } else {
      console.error('Unexpected error loading user profile:', err);
    }
  }
  // Firestore 문서 없거나 오류 시 Firebase Auth 유저만 반환
  return firebaseUser as AppUser;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: true, // 초기 로딩 상태
  error: null,

  setUserWithProfile: async (firebaseUser: User | null) => {
    if (!firebaseUser) {
      set({ user: null, loading: false });
      return;
    }
    set({ loading: true });
    const appUser = await mergeUserProfile(firebaseUser);
    set({ user: appUser, loading: false });
  },

  login: async (email: string, password: string) => {
    set({ loading: true, error: null });
    try {
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      const appUser = await mergeUserProfile(userCredential.user);
      set({ user: appUser, loading: false });
    } catch (error: any) {
      set({ error: error.message, loading: false });
      throw error;
    }
  },

  logout: async () => {
    set({ loading: true });
    try {
      await firebaseSignOut(auth);
      set({ user: null, loading: false });
    } catch (error: any) {
      set({ error: error.message, loading: false });
      throw error;
    }
  },
}));
