import { useState, useEffect, useCallback } from 'react';
import { readKitePref, writeKitePref } from '../../lib/kitePrefs';

export interface UseAppThemeReturn {
  appearance: 'dark' | 'light';
  palette: string;
  applyTheme: (nextTheme: 'dark' | 'light', nextPalette?: string) => void;
  handleToggleAppearance: () => void;
  handleToggleMode: (newMode: 'dark' | 'light') => void;
  handleSelectTheme: (paletteId: string, themeMode?: 'dark' | 'light') => void;
}

export function useAppTheme(): UseAppThemeReturn {
  const [appearance, setAppearance] = useState<'dark' | 'light'>(() => {
    try {
      const saved = readKitePref('theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch {}
    return 'dark';
  });

  const [palette, setPalette] = useState<string>(() => {
    try {
      const saved = readKitePref('palette');
      if (saved) return saved;
    } catch {}
    return 'kite-dark';
  });

  const applyTheme = useCallback((nextTheme: 'dark' | 'light', nextPalette?: string) => {
    const effectivePalette =
      nextPalette ?? (nextTheme === 'light' ? 'kite-light' : 'kite-dark');
    setAppearance(nextTheme);
    setPalette(effectivePalette);

    try {
      writeKitePref('theme', nextTheme);
      writeKitePref('palette', effectivePalette);
    } catch {}

    document.documentElement.setAttribute('data-theme', nextTheme);
    document.documentElement.setAttribute('data-palette', effectivePalette);
    document.documentElement.classList.toggle('dark', nextTheme === 'dark');
    document.documentElement.classList.toggle('light', nextTheme === 'light');

    const appFrame = document.querySelector('.app-frame');
    if (appFrame) {
      appFrame.setAttribute('data-theme', nextTheme);
      appFrame.setAttribute('data-palette', effectivePalette);
    }

    const zoomViewport = document.querySelector('.zoom-viewport');
    if (zoomViewport) {
      zoomViewport.setAttribute('data-theme', nextTheme);
      zoomViewport.setAttribute('data-palette', effectivePalette);
    }

    window.dispatchEvent(
      new CustomEvent('kite:theme-changed', {
        detail: { theme: nextTheme, palette: effectivePalette },
      })
    );
  }, []);

  useEffect(() => {
    applyTheme(appearance, palette);
  }, []);

  useEffect(() => {
    const handleThemeEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ theme?: 'dark' | 'light'; palette?: string }>).detail;
      if (detail?.theme && (detail.theme === 'dark' || detail.theme === 'light')) {
        setAppearance(detail.theme);
        if (detail.palette) setPalette(detail.palette);
      }
    };
    window.addEventListener('kite:theme-changed', handleThemeEvent);
    return () => window.removeEventListener('kite:theme-changed', handleThemeEvent);
  }, []);

  const handleToggleAppearance = useCallback(() => {
    const next = appearance === 'dark' ? 'light' : 'dark';
    const nextPalette = next === 'dark' ? 'kite-dark' : 'kite-light';
    applyTheme(next, nextPalette);
  }, [appearance, applyTheme]);

  const handleToggleMode = useCallback((newMode: 'dark' | 'light') => {
    const nextPalette = newMode === 'dark' ? 'kite-dark' : 'kite-light';
    applyTheme(newMode, nextPalette);
  }, [applyTheme]);

  const handleSelectTheme = useCallback((paletteId: string, themeMode?: 'dark' | 'light') => {
    const nextMode = themeMode ?? appearance;
    applyTheme(nextMode, paletteId);
  }, [appearance, applyTheme]);

  return {
    appearance,
    palette,
    applyTheme,
    handleToggleAppearance,
    handleToggleMode,
    handleSelectTheme,
  };
}
