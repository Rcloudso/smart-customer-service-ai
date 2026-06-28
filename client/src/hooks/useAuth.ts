import { create } from 'zustand';
import * as adminApi from '../api/admin';

export interface AuthUser {
  id: string;
  username: string;
  role: string;
}

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  isAuthenticated: boolean;
  isInitialized: boolean;
  isLoading: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  loadFromStorage: () => void;
  clearError: () => void;
}

/** Synchronously read initial auth state from localStorage. */
function readInitialState(): { token: string | null; user: AuthUser | null; isAuthenticated: boolean; isInitialized: boolean } {
  try {
    const token = localStorage.getItem('auth_token');
    const userStr = localStorage.getItem('auth_user');
    if (token && userStr) {
      const user: AuthUser = JSON.parse(userStr);
      return { token, user, isAuthenticated: true, isInitialized: true };
    }
  } catch {
    // Invalid stored data — act as unauthenticated
  }
  return { token: null, user: null, isAuthenticated: false, isInitialized: true };
}

const initialState = readInitialState();

export const useAuth = create<AuthState>((set) => ({
  token: initialState.token,
  user: initialState.user,
  isAuthenticated: initialState.isAuthenticated,
  isInitialized: initialState.isInitialized,
  isLoading: false,
  error: null,

  login: async (username: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      const result = await adminApi.login(username, password);
      const token = result.token;
      const user: AuthUser = {
        id: result.user.id,
        username: result.user.username,
        role: result.user.role,
      };

      // Persist to localStorage
      try {
        localStorage.setItem('auth_token', token);
        localStorage.setItem('auth_user', JSON.stringify(user));
      } catch {
        // localStorage may be unavailable
      }

      set({
        token,
        user,
        isAuthenticated: true,
        isInitialized: true,
        isLoading: false,
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '登录失败';
      set({
        isLoading: false,
        error: message,
      });
      throw err;
    }
  },

  logout: () => {
    try {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('auth_user');
    } catch {
      // ignore
    }
    set({
      token: null,
      user: null,
      isAuthenticated: false,
      isInitialized: true,
      error: null,
    });
  },

  loadFromStorage: () => {
    try {
      const token = localStorage.getItem('auth_token');
      const userStr = localStorage.getItem('auth_user');

      if (token && userStr) {
        const user: AuthUser = JSON.parse(userStr);
        set({
          token,
          user,
          isAuthenticated: true,
          isInitialized: true,
        });
      } else {
        set({ isInitialized: true });
      }
    } catch {
      set({
        token: null,
        user: null,
        isAuthenticated: false,
        isInitialized: true,
      });
    }
  },

  clearError: () => {
    set({ error: null });
  },
}));
