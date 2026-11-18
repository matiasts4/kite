import { useState, useEffect, useCallback, useRef } from 'react';
import {
  DEFAULT_THEME_CUSTOMIZATIONS,
  applyThemeCustomizationsToDocument,
  getActivePaletteForState,
  isDarkThemeId,
  isLightThemeId,
  readThemeCustomizations,
  resolveThemeMode,
  sanitizeThemeCustomizations,
  writeThemeCustomizations,
  type AppearanceMode,
  type KiteThemeCustomizations,
  type ResolvedThemeMode,
} from '../../lib/themeCustomizations';

export interface UseAppThemeReturn {
  appearance: ResolvedThemeMode;
  appearanceMode: AppearanceMode;
  palette: string;
  customizations: KiteThemeCustomizations;
  applyTheme: (nextTheme: ResolvedThemeMode, nextPalette?: string) => void;
  handleToggleAppearance: () => void;
  handleToggleMode: (newMode: AppearanceMode) => void;
  handleSelectTheme: (paletteId: string, themeMode?: ResolvedThemeMode) => void;
  updateCustomizations: (patch: Partial<KiteThemeCustomizations>) => void;
  resetThemeOverrides: () => void;
  resetAllCustomizations: () => void;
}

function persistThemeToBackend(state: KiteThemeCustomizations): void {
  try {
    const tauriWindow = window as unknown as {
      __TAURI_INTERNALS__?: {
        invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
    };
    const invoke = tauriWindow.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke === 'function') {
      void invoke('save_theme_preferences', { preferences: state }).catch(() => {});
    }
  } catch {
    // Non-Tauri environment or test runner.
  }
}

export function useAppTheme(): UseAppThemeReturn {
  const [customizations, setCustomizations] = useState<KiteThemeCustomizations>(() =>
    readThemeCustomizations()
  );

  const [appearance, setAppearance] = useState<ResolvedThemeMode>(() =>
    resolveThemeMode(customizations.appearanceMode)
  );

  const [palette, setPalette] = useState<string>(() =>
    getActivePaletteForState(customizations, resolveThemeMode(customizations.appearanceMode))
  );

  const customizationsRef = useRef<KiteThemeCustomizations>(customizations);
  customizationsRef.current = customizations;

  const commitState = useCallback((nextRaw: KiteThemeCustomizations, broadcast = true) => {
    const nextState = sanitizeThemeCustomizations(nextRaw);
    customizationsRef.current = nextState;
    setCustomizations(nextState);

    writeThemeCustomizations(nextState);
    const applied = applyThemeCustomizationsToDocument(nextState);
    setAppearance(applied.resolvedMode);
    setPalette(applied.activePalette);
    persistThemeToBackend(nextState);

    if (broadcast) {
      window.dispatchEvent(
        new CustomEvent('kite:theme-changed', {
          detail: {
            theme: applied.resolvedMode,
            palette: applied.activePalette,
            appearanceMode: nextState.appearanceMode,
            customizations: nextState,
          },
        })
      );
    }
  }, []);

  useEffect(() => {
    const applied = applyThemeCustomizationsToDocument(customizationsRef.current);
    setAppearance(applied.resolvedMode);
    setPalette(applied.activePalette);
  }, []);

  useEffect(() => {
    if (customizations.appearanceMode !== 'system') return;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    if (!mql) return;

    const handleSystemChange = () => {
      const applied = applyThemeCustomizationsToDocument(customizationsRef.current);
      setAppearance(applied.resolvedMode);
      setPalette(applied.activePalette);
      window.dispatchEvent(
        new CustomEvent('kite:theme-changed', {
          detail: {
            theme: applied.resolvedMode,
            palette: applied.activePalette,
            appearanceMode: customizationsRef.current.appearanceMode,
            customizations: customizationsRef.current,
          },
        })
      );
    };

    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handleSystemChange);
      return () => mql.removeEventListener('change', handleSystemChange);
    }
    return undefined;
  }, [customizations.appearanceMode]);

  useEffect(() => {
    const handleThemeEvent = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          theme?: ResolvedThemeMode;
          palette?: string;
          customizations?: KiteThemeCustomizations;
        }>
      ).detail;

      if (detail?.customizations) {
        const synced = sanitizeThemeCustomizations(detail.customizations);
        customizationsRef.current = synced;
        setCustomizations(synced);
        const resolved = resolveThemeMode(synced.appearanceMode);
        setAppearance(resolved);
        setPalette(getActivePaletteForState(synced, resolved));
        return;
      }

      if (detail?.theme && (detail.theme === 'dark' || detail.theme === 'light')) {
        const current = customizationsRef.current;
        const nextPalette =
          detail.palette ??
          (detail.theme === 'light' ? current.lightThemeId : current.darkThemeId);
        const nextState = sanitizeThemeCustomizations({
          ...current,
          appearanceMode: detail.theme,
          darkThemeId:
            detail.theme === 'dark' && isDarkThemeId(nextPalette)
              ? nextPalette
              : current.darkThemeId,
          lightThemeId:
            detail.theme === 'light' && isLightThemeId(nextPalette)
              ? nextPalette
              : current.lightThemeId,
        });
        customizationsRef.current = nextState;
        setCustomizations(nextState);
        setAppearance(detail.theme);
        setPalette(nextPalette);
      }
    };

    window.addEventListener('kite:theme-changed', handleThemeEvent);
    return () => window.removeEventListener('kite:theme-changed', handleThemeEvent);
  }, []);

  const applyTheme = useCallback(
    (nextTheme: ResolvedThemeMode, nextPalette?: string) => {
      const current = customizationsRef.current;
      const effectivePalette =
        nextPalette ?? (nextTheme === 'light' ? current.lightThemeId : current.darkThemeId);

      const nextState: KiteThemeCustomizations = {
        ...current,
        appearanceMode: nextTheme,
        darkThemeId:
          nextTheme === 'dark' && isDarkThemeId(effectivePalette)
            ? effectivePalette
            : current.darkThemeId,
        lightThemeId:
          nextTheme === 'light' && isLightThemeId(effectivePalette)
            ? effectivePalette
            : current.lightThemeId,
      };
      commitState(nextState);
    },
    [commitState]
  );

  const handleToggleAppearance = useCallback(() => {
    const current = customizationsRef.current;
    const currentResolved = resolveThemeMode(current.appearanceMode);
    const nextMode: ResolvedThemeMode = currentResolved === 'dark' ? 'light' : 'dark';
    const rememberedPalette =
      nextMode === 'dark' ? current.darkThemeId : current.lightThemeId;
    applyTheme(nextMode, rememberedPalette);
  }, [applyTheme]);

  const handleToggleMode = useCallback(
    (newMode: AppearanceMode) => {
      const current = customizationsRef.current;
      commitState({
        ...current,
        appearanceMode: newMode,
      });
    },
    [commitState]
  );

  const handleSelectTheme = useCallback(
    (paletteId: string, themeMode?: ResolvedThemeMode) => {
      const current = customizationsRef.current;
      const inferredMode: ResolvedThemeMode =
        themeMode ??
        (isLightThemeId(paletteId)
          ? 'light'
          : isDarkThemeId(paletteId)
            ? 'dark'
            : resolveThemeMode(current.appearanceMode));

      commitState({
        ...current,
        appearanceMode: inferredMode,
        darkThemeId: inferredMode === 'dark' ? paletteId : current.darkThemeId,
        lightThemeId: inferredMode === 'light' ? paletteId : current.lightThemeId,
      });
    },
    [commitState]
  );

  const updateCustomizations = useCallback(
    (patch: Partial<KiteThemeCustomizations>) => {
      const current = customizationsRef.current;
      commitState({
        ...current,
        ...patch,
        backdrop: patch.backdrop
          ? { ...current.backdrop, ...patch.backdrop }
          : current.backdrop,
        figure: patch.figure ? { ...current.figure, ...patch.figure } : current.figure,
        surface: patch.surface
          ? { ...current.surface, ...patch.surface }
          : current.surface,
        overrides: patch.overrides
          ? { ...current.overrides, ...patch.overrides }
          : current.overrides,
      });
    },
    [commitState]
  );

  const resetThemeOverrides = useCallback(() => {
    const current = customizationsRef.current;
    commitState({
      ...current,
      overrides: { ...DEFAULT_THEME_CUSTOMIZATIONS.overrides },
    });
  }, [commitState]);

  const resetAllCustomizations = useCallback(() => {
    commitState({ ...DEFAULT_THEME_CUSTOMIZATIONS });
  }, [commitState]);

  return {
    appearance,
    appearanceMode: customizations.appearanceMode,
    palette,
    customizations,
    applyTheme,
    handleToggleAppearance,
    handleToggleMode,
    handleSelectTheme,
    updateCustomizations,
    resetThemeOverrides,
    resetAllCustomizations,
  };
}
