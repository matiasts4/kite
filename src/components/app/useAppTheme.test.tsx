import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAppTheme } from './useAppTheme';

describe('useAppTheme hook', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-palette');
  });

  it('remembers separate dark and light themes when toggling between dark, light, and system modes', () => {
    const { result } = renderHook(() => useAppTheme());

    act(() => {
      result.current.handleSelectTheme('tokyo-night', 'dark');
    });
    expect(result.current.appearance).toBe('dark');
    expect(result.current.palette).toBe('tokyo-night');

    act(() => {
      result.current.handleSelectTheme('solarized-light', 'light');
    });
    expect(result.current.appearance).toBe('light');
    expect(result.current.palette).toBe('solarized-light');

    // Switching back to dark MUST restore tokyo-night, NOT reset to kite-dark
    act(() => {
      result.current.handleToggleMode('dark');
    });
    expect(result.current.appearance).toBe('dark');
    expect(result.current.palette).toBe('tokyo-night');

    // Switching back to light MUST restore solarized-light, NOT reset to kite-light
    act(() => {
      result.current.handleToggleAppearance();
    });
    expect(result.current.appearance).toBe('light');
    expect(result.current.palette).toBe('solarized-light');
  });

  it('updates rich customizations (backdrop, figure, surface glass, overrides) and resets overrides cleanly', () => {
    const { result } = renderHook(() => useAppTheme());

    act(() => {
      result.current.updateCustomizations({
        backdrop: {
          ...result.current.customizations.backdrop,
          preset: 'aurora-mesh',
          grain: true,
        },
        figure: {
          ...result.current.customizations.figure,
          style: 'pixel-companion',
        },
        overrides: {
          ...result.current.customizations.overrides,
          accent: '#f97316',
        },
      });
    });

    expect(result.current.customizations.backdrop.preset).toBe('aurora-mesh');
    expect(result.current.customizations.figure.style).toBe('pixel-companion');
    expect(result.current.customizations.overrides.accent).toBe('#f97316');
    expect(document.documentElement.getAttribute('data-backdrop')).toBe('aurora-mesh');
    expect(document.documentElement.getAttribute('data-figure')).toBe('pixel-companion');

    act(() => {
      result.current.resetThemeOverrides();
    });
    expect(result.current.customizations.overrides.accent).toBeNull();
  });
});
