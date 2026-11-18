import { useEffect, useState } from 'react';
import {
  readThemeCustomizations,
  resolveActiveDiffColors,
  resolveThemeMode,
  type KiteThemeCustomizations,
} from '../themeCustomizations';

export type KiteThemeMode = 'dark' | 'light';

export interface KiteThemeVisualState {
  mode: KiteThemeMode;
  palette: string;
  darkThemeId: string;
  lightThemeId: string;
  daltonized: boolean;
  diffAdded: string | null;
  diffRemoved: string | null;
  codeFont: string | null;
}

export function readKiteThemeMode(): KiteThemeMode {
  if (typeof document === 'undefined') {
    return 'dark';
  }
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function readKiteThemeVisualState(
  overrideCustomizations?: KiteThemeCustomizations
): KiteThemeVisualState {
  const state = overrideCustomizations ?? readThemeCustomizations();
  const hasDom = typeof document !== 'undefined';
  const domTheme = hasDom ? document.documentElement.getAttribute('data-theme') : null;
  const domPalette = hasDom ? document.documentElement.getAttribute('data-palette') : null;
  const domDaltonized = hasDom
    ? document.documentElement.getAttribute('data-daltonized-diffs')
    : null;

  const mode: KiteThemeMode =
    overrideCustomizations
      ? resolveThemeMode(state.appearanceMode)
      : domTheme === 'light' || domTheme === 'dark'
        ? domTheme
        : resolveThemeMode(state.appearanceMode);

  const palette =
    overrideCustomizations || !domPalette
      ? mode === 'light'
        ? state.lightThemeId
        : state.darkThemeId
      : domPalette;

  const daltonized = overrideCustomizations
    ? state.overrides.daltonizedDiffs
    : domDaltonized !== null
      ? domDaltonized === 'true'
      : state.overrides.daltonizedDiffs;

  const diffColors = resolveActiveDiffColors(
    {
      ...state,
      overrides: {
        ...state.overrides,
        daltonizedDiffs: daltonized,
      },
    },
    mode
  );

  return {
    mode,
    palette,
    darkThemeId: mode === 'dark' ? palette : state.darkThemeId,
    lightThemeId: mode === 'light' ? palette : state.lightThemeId,
    daltonized,
    diffAdded: diffColors.hasCustomDiffColors ? diffColors.diffAdded : null,
    diffRemoved: diffColors.hasCustomDiffColors ? diffColors.diffRemoved : null,
    codeFont: state.overrides.codeFont,
  };
}

export function subscribeKiteThemeMode(
  listener: (customizations?: KiteThemeCustomizations) => void
): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }

  const handleThemeEvent = (e: Event) => {
    const detail = (e as CustomEvent<{ customizations?: KiteThemeCustomizations }>).detail;
    listener(detail?.customizations);
  };

  window.addEventListener('kite:theme-changed', handleThemeEvent);

  const observer =
    typeof MutationObserver !== 'undefined'
      ? new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            if (
              mutation.attributeName === 'data-theme' ||
              mutation.attributeName === 'data-palette' ||
              mutation.attributeName === 'data-daltonized-diffs'
            ) {
              listener();
              break;
            }
          }
        })
      : null;

  observer?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-palette', 'data-daltonized-diffs'],
  });

  return () => {
    window.removeEventListener('kite:theme-changed', handleThemeEvent);
    observer?.disconnect();
  };
}

/** Reactively tracks Kite's active dark/light appearance mode. */
export function useKiteThemeMode(): KiteThemeMode {
  const [mode, setMode] = useState<KiteThemeMode>(readKiteThemeMode);

  useEffect(() => {
    setMode(readKiteThemeMode());
    return subscribeKiteThemeMode(() => {
      setMode(readKiteThemeMode());
    });
  }, []);

  return mode;
}

/** Reactively tracks active theme mode, palette, daltonized mode, and diff token overrides. */
export function useKiteThemeVisualState(): KiteThemeVisualState {
  const [visualState, setVisualState] = useState<KiteThemeVisualState>(() =>
    readKiteThemeVisualState()
  );

  useEffect(() => {
    setVisualState(readKiteThemeVisualState());
    return subscribeKiteThemeMode((customizations) => {
      setVisualState(readKiteThemeVisualState(customizations));
    });
  }, []);

  return visualState;
}
