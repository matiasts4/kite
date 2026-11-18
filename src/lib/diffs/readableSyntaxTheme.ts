import { registerCustomTheme } from '@pierre/diffs';
import type { Theme, ThemeSyntaxSettings } from '@pierre/highlights';
import { VISUAL_THEME_PACKS } from '../themeCustomizations';
import type { KiteThemeMode } from './useKiteThemeMode';

export const KITE_DARK_SYNTAX_THEME = 'pierre-dark' as const;
export const KITE_LIGHT_SYNTAX_THEME = 'kite-light' as const;

export const KITE_DIFF_THEMES = {
  dark: KITE_DARK_SYNTAX_THEME,
  light: KITE_LIGHT_SYNTAX_THEME,
} as const;

const LIGHT_SYNTAX_OVERRIDES: Record<string, string | ThemeSyntaxSettings> = {
  comment: { color: '#52525b' },
  'comment.doc': { color: '#475569' },
  punctuation: { color: '#3f3f46' },
  'punctuation.bracket': { color: '#3f3f46' },
  'punctuation.delimiter': { color: '#52525b' },
  'punctuation.list_marker': { color: '#9a3412' },
  'punctuation.special': { color: '#9a3412' },
  operator: { color: '#0369a1' },
  'keyword.operator': { color: '#0369a1' },
  string: { color: '#15803d' },
  'string.escape': { color: '#0f766e' },
  'string.regex': { color: '#0e7490' },
  'string.special': { color: '#0f766e' },
  'string.special.symbol': { color: '#b45309' },
  constant: { color: '#b45309' },
  number: { color: '#0284c7' },
  boolean: { color: '#0284c7' },
};

let lightThemeRegistered = false;

/** Builds a contrast-adjusted light syntax theme derived from pierre-light. */
export function buildReadableLightTheme(baseTheme: Theme): Theme {
  return {
    ...baseTheme,
    name: KITE_LIGHT_SYNTAX_THEME,
    appearance: 'light',
    style: {
      ...baseTheme.style,
      syntax: {
        ...baseTheme.style.syntax,
        ...LIGHT_SYNTAX_OVERRIDES,
      },
    },
  };
}

/** Idempotently registers Kite's readable light theme with `@pierre/diffs`. */
export function ensureReadableLightDiffTheme(): void {
  if (lightThemeRegistered) return;
  lightThemeRegistered = true;

  registerCustomTheme(
    KITE_LIGHT_SYNTAX_THEME,
    async () => {
      const mod = await import('@pierre/highlights/themes/pierre-light');
      return buildReadableLightTheme(mod.default);
    },
    'zed'
  );
}

export function resolveDiffThemeName(mode: KiteThemeMode, paletteId?: string): string {
  if (paletteId) {
    const matched = VISUAL_THEME_PACKS.find((pack) => pack.id === paletteId);
    if (matched && matched.mode === mode) {
      return matched.syntaxTheme;
    }
  }
  return mode === 'light' ? KITE_LIGHT_SYNTAX_THEME : KITE_DARK_SYNTAX_THEME;
}

export function resolveKiteDiffThemes(
  darkPaletteId?: string,
  lightPaletteId?: string
): { dark: string; light: string } {
  return {
    dark: resolveDiffThemeName('dark', darkPaletteId),
    light: resolveDiffThemeName('light', lightPaletteId),
  };
}
