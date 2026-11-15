/**
 * Typed access to the theme switch that static/index.html installs as window.CutlineTheme.
 * The helper lives in the page head so the theme is applied before the first paint; this file
 * only reads and changes it from the bundle.
 */

/** What the user chose. 'system' follows the operating system; 'custom' is the legacy colour picker. */
export type ThemeChoice = 'system' | 'light' | 'dark' | 'custom';
/** The theme in effect (written to <html data-theme>). */
export type ThemeName = 'light' | 'dark' | 'custom';

interface CutlineThemeApi {
  get(): ThemeChoice;
  resolved(): ThemeName;
  set(choice: ThemeChoice): void;
}

declare global {
  interface Window {
    CutlineTheme?: CutlineThemeApi;
  }
}

/** The order "Switch theme" steps through. */
export const THEME_CYCLE: ThemeChoice[] = ['system', 'light', 'dark'];

export const THEME_LABELS: Record<ThemeChoice, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
  custom: 'Custom',
};

/** The stored choice ('system' when nothing is stored or the page has no theme helper). */
export function getThemeChoice(): ThemeChoice {
  return window.CutlineTheme?.get() ?? 'system';
}

/** The theme in effect right now. */
export function getResolvedTheme(): ThemeName {
  const w = window.CutlineTheme;
  if (w) return w.resolved();
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/** Store and apply a choice. */
export function setThemeChoice(choice: ThemeChoice): void {
  if (window.CutlineTheme) window.CutlineTheme.set(choice);
  else document.documentElement.setAttribute('data-theme', choice === 'light' ? 'light' : 'dark');
}

/** The choice after `choice` in the cycle System, Light, Dark (Custom goes to System). */
export function nextThemeChoice(choice: ThemeChoice): ThemeChoice {
  const i = THEME_CYCLE.indexOf(choice);
  return THEME_CYCLE[(i + 1) % THEME_CYCLE.length]!;
}

/** Step to the next choice and return it. */
export function cycleTheme(): ThemeChoice {
  const next = nextThemeChoice(getThemeChoice());
  setThemeChoice(next);
  return next;
}

/** Subscribe to theme changes (from any caller); returns an unsubscribe function. */
export function onThemeChange(listener: () => void): () => void {
  window.addEventListener('cutline-theme', listener);
  return () => window.removeEventListener('cutline-theme', listener);
}
