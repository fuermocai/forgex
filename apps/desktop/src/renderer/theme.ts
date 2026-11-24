export const THEME_STORAGE_KEY = 'forgex.desktop.theme';

export const THEME_IDS = ['graphite', 'paper', 'harbor'] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export function isThemeId(value: string | null): value is ThemeId {
  return value !== null && THEME_IDS.some((themeId) => themeId === value);
}

export function readSavedTheme(): ThemeId {
  try {
    const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeId(savedTheme) ? savedTheme : 'graphite';
  } catch {
    return 'graphite';
  }
}

export function applyTheme(themeId: ThemeId): void {
  document.documentElement.dataset.theme = themeId;
}

export function saveTheme(themeId: ThemeId): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, themeId);
  } catch {
    // The theme stays active for this session when local storage is unavailable.
  }
}
