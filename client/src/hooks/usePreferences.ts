import { create } from 'zustand';
import { Language, translate } from '../i18n';

export type ThemeMode = 'light' | 'dark';

interface PreferencesState {
  language: Language;
  theme: ThemeMode;
  setLanguage: (language: Language) => void;
  setTheme: (theme: ThemeMode) => void;
  toggleLanguage: () => void;
  toggleTheme: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const STORAGE_KEY = 'app_preferences';

function readInitialPreferences(): Pick<PreferencesState, 'language' | 'theme'> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Pick<PreferencesState, 'language' | 'theme'>>;
      return {
        language: parsed.language === 'en' ? 'en' : 'zh',
        theme: parsed.theme === 'dark' ? 'dark' : 'light',
      };
    }
  } catch {
    // Fall back to defaults when localStorage is unavailable or corrupted.
  }
  return { language: 'zh', theme: 'light' };
}

function persistPreferences(language: Language, theme: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ language, theme }));
  } catch {
    // localStorage may be blocked in private or embedded browsing contexts.
  }
}

function applyDocumentPreferences(language: Language, theme: ThemeMode): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.setAttribute('theme-mode', theme);
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
}

const initialPreferences = readInitialPreferences();
applyDocumentPreferences(initialPreferences.language, initialPreferences.theme);

export const usePreferences = create<PreferencesState>((set, get) => ({
  language: initialPreferences.language,
  theme: initialPreferences.theme,

  setLanguage: (language: Language) => {
    const theme = get().theme;
    persistPreferences(language, theme);
    applyDocumentPreferences(language, theme);
    set({ language });
  },

  setTheme: (theme: ThemeMode) => {
    const language = get().language;
    persistPreferences(language, theme);
    applyDocumentPreferences(language, theme);
    set({ theme });
  },

  toggleLanguage: () => {
    get().setLanguage(get().language === 'zh' ? 'en' : 'zh');
  },

  toggleTheme: () => {
    get().setTheme(get().theme === 'light' ? 'dark' : 'light');
  },

  t: (key: string, params?: Record<string, string | number>) =>
    translate(get().language, key, params),
}));

export function useTranslation(): {
  language: Language;
  t: (key: string, params?: Record<string, string | number>) => string;
} {
  const language = usePreferences((state) => state.language);
  return {
    language,
    t: (key: string, params?: Record<string, string | number>) => translate(language, key, params),
  };
}
