import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Theme engine. A theme is a named set of design tokens; tokens map 1:1 to
 * the CSS variables declared in styles.css. Built-in presets cover light,
 * dark and popular palettes; users can build, save, export and import
 * unlimited custom themes (persisted in this browser's localStorage).
 */

export const TOKEN_DEFS = [
  { key: 'bg', cssVar: '--bg', label: 'Page background' },
  { key: 'surface', cssVar: '--surface', label: 'Cards & panels' },
  { key: 'surface2', cssVar: '--surface-2', label: 'Hover / subtle fills' },
  { key: 'border', cssVar: '--border', label: 'Borders' },
  { key: 'text', cssVar: '--text', label: 'Text' },
  { key: 'muted', cssVar: '--muted', label: 'Secondary text' },
  { key: 'primary', cssVar: '--primary', label: 'Primary / buttons' },
  { key: 'primaryContrast', cssVar: '--primary-contrast', label: 'Text on primary' },
  { key: 'success', cssVar: '--success', label: 'Success' },
  { key: 'danger', cssVar: '--danger', label: 'Danger / errors' },
  { key: 'warning', cssVar: '--warning', label: 'Warning' },
  { key: 'info', cssVar: '--info', label: 'Info / legends' },
] as const;

export type TokenKey = (typeof TOKEN_DEFS)[number]['key'];
export type ThemeTokens = Record<TokenKey, string>;

export interface Theme {
  id: string;
  name: string;
  dark: boolean;
  radius: number; // px
  tokens: ThemeTokens;
}

const t = (tokens: ThemeTokens) => tokens;

export const PRESETS: Theme[] = [
  {
    id: 'light', name: 'Light', dark: false, radius: 8,
    tokens: t({
      bg: '#f4f6fa', surface: '#ffffff', surface2: '#eef1f6', border: '#d8dee9',
      text: '#1d2433', muted: '#66708a', primary: '#3355dd', primaryContrast: '#ffffff',
      success: '#1d9d5f', danger: '#d3382f', warning: '#c77d0a', info: '#7a5fd0',
    }),
  },
  {
    id: 'dark', name: 'Dark', dark: true, radius: 8,
    tokens: t({
      bg: '#14171f', surface: '#1c2029', surface2: '#252a36', border: '#343b4c',
      text: '#e6e9f2', muted: '#8a93ab', primary: '#6c8cff', primaryContrast: '#0b0e16',
      success: '#3ecf8e', danger: '#ff6b5e', warning: '#f0a63a', info: '#a08aff',
    }),
  },
  {
    id: 'midnight', name: 'Midnight', dark: true, radius: 8,
    tokens: t({
      bg: '#0a0e14', surface: '#10151f', surface2: '#182030', border: '#223047',
      text: '#d8e2f0', muted: '#7185a0', primary: '#38bdf8', primaryContrast: '#06121d',
      success: '#34d399', danger: '#f87171', warning: '#fbbf24', info: '#818cf8',
    }),
  },
  {
    id: 'nord', name: 'Nord', dark: true, radius: 8,
    tokens: t({
      bg: '#2e3440', surface: '#3b4252', surface2: '#434c5e', border: '#4c566a',
      text: '#eceff4', muted: '#a3b1c2', primary: '#88c0d0', primaryContrast: '#2e3440',
      success: '#a3be8c', danger: '#bf616a', warning: '#ebcb8b', info: '#b48ead',
    }),
  },
  {
    id: 'dracula', name: 'Dracula', dark: true, radius: 8,
    tokens: t({
      bg: '#282a36', surface: '#2f3140', surface2: '#44475a', border: '#565869',
      text: '#f8f8f2', muted: '#9ea8c7', primary: '#bd93f9', primaryContrast: '#282a36',
      success: '#50fa7b', danger: '#ff5555', warning: '#f1fa8c', info: '#8be9fd',
    }),
  },
  {
    id: 'solarized-light', name: 'Solarized Light', dark: false, radius: 8,
    tokens: t({
      bg: '#eee8d5', surface: '#fdf6e3', surface2: '#f3edda', border: '#d9d2bc',
      text: '#405b66', muted: '#93a1a1', primary: '#268bd2', primaryContrast: '#fdf6e3',
      success: '#859900', danger: '#dc322f', warning: '#b58900', info: '#6c71c4',
    }),
  },
  {
    id: 'sepia', name: 'Sepia', dark: false, radius: 10,
    tokens: t({
      bg: '#f4ecd8', surface: '#fbf5e6', surface2: '#efe5cd', border: '#d8c9a3',
      text: '#433422', muted: '#8a7a5e', primary: '#a05e2c', primaryContrast: '#fbf5e6',
      success: '#5f7d3a', danger: '#b3402e', warning: '#a97b12', info: '#7a6aa0',
    }),
  },
  {
    id: 'high-contrast', name: 'High Contrast', dark: true, radius: 4,
    tokens: t({
      bg: '#000000', surface: '#0a0a0a', surface2: '#161616', border: '#6e6e6e',
      text: '#ffffff', muted: '#c8c8c8', primary: '#ffd400', primaryContrast: '#000000',
      success: '#00e676', danger: '#ff1744', warning: '#ff9100', info: '#40c4ff',
    }),
  },
];

const SELECTION_KEY = 'ats.theme';
const CUSTOM_KEY = 'ats.customThemes';
export const SYSTEM = 'system';

function loadCustom(): Theme[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(isTheme) : [];
  } catch {
    return [];
  }
}

export function isTheme(x: any): x is Theme {
  return x && typeof x.id === 'string' && typeof x.name === 'string' && typeof x.dark === 'boolean'
    && typeof x.radius === 'number' && x.tokens && TOKEN_DEFS.every((d) => typeof x.tokens[d.key] === 'string');
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  for (const def of TOKEN_DEFS) root.style.setProperty(def.cssVar, theme.tokens[def.key]);
  root.style.setProperty('--radius', `${theme.radius}px`);
  root.style.colorScheme = theme.dark ? 'dark' : 'light';
  root.dataset.theme = theme.id;
}

interface ThemeCtx {
  selection: string; // SYSTEM or theme id
  setSelection: (id: string) => void;
  customThemes: Theme[];
  saveCustom: (theme: Theme) => void;
  deleteCustom: (id: string) => void;
  /** Theme currently painted (resolves SYSTEM, selection and live preview). */
  active: Theme;
  /** While non-null, this theme is painted instead of the selection (builder live preview). */
  setPreview: (theme: Theme | null) => void;
  allThemes: Theme[];
}

const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [selection, setSelectionState] = useState(() => localStorage.getItem(SELECTION_KEY) || SYSTEM);
  const [customThemes, setCustomThemes] = useState<Theme[]>(loadCustom);
  const [preview, setPreview] = useState<Theme | null>(null);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const fn = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);

  const allThemes = useMemo(() => [...PRESETS, ...customThemes], [customThemes]);

  const active = useMemo(() => {
    if (preview) return preview;
    if (selection === SYSTEM) return PRESETS[systemDark ? 1 : 0];
    return allThemes.find((th) => th.id === selection) || PRESETS[0];
  }, [preview, selection, systemDark, allThemes]);

  useEffect(() => applyTheme(active), [active]);

  const setSelection = (id: string) => {
    setSelectionState(id);
    localStorage.setItem(SELECTION_KEY, id);
  };

  const saveCustom = (theme: Theme) => {
    setCustomThemes((list) => {
      const next = [...list.filter((x) => x.id !== theme.id), theme];
      localStorage.setItem(CUSTOM_KEY, JSON.stringify(next));
      return next;
    });
  };

  const deleteCustom = (id: string) => {
    setCustomThemes((list) => {
      const next = list.filter((x) => x.id !== id);
      localStorage.setItem(CUSTOM_KEY, JSON.stringify(next));
      return next;
    });
    if (selection === id) setSelection(SYSTEM);
  };

  return (
    <Ctx.Provider value={{ selection, setSelection, customThemes, saveCustom, deleteCustom, active, setPreview, allThemes }}>
      {children}
    </Ctx.Provider>
  );
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTheme outside ThemeProvider');
  return ctx;
}
