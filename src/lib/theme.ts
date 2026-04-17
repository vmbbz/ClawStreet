/**
 * theme.ts — Light/dark mode management
 * Persists in localStorage. Default: dark.
 */

export type Theme = 'dark' | 'light';

const KEY = 'cs-theme';
const DEFAULT: Theme = 'dark';

function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

export function initTheme(): Theme {
  const stored = (localStorage.getItem(KEY) as Theme | null) ?? DEFAULT;
  apply(stored);
  return stored;
}

export function getTheme(): Theme {
  return (document.documentElement.dataset.theme as Theme) ?? DEFAULT;
}

export function setTheme(theme: Theme) {
  localStorage.setItem(KEY, theme);
  apply(theme);
  // Dispatch event so React can sync
  window.dispatchEvent(new CustomEvent('cs-theme-change', { detail: theme }));
}

export function toggleTheme(): Theme {
  const next = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}
