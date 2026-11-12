import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useAppTheme } from './useAppTheme';

describe('useAppTheme Hook', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-palette');
  });

  it('initializes with default dark theme and applies attributes', () => {
    const { result } = renderHook(() => useAppTheme());
    expect(result.current.appearance).toBe('dark');
    expect(result.current.palette).toBe('kite-dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-palette')).toBe('kite-dark');
  });

  it('toggles appearance between dark and light', () => {
    const { result } = renderHook(() => useAppTheme());

    act(() => {
      result.current.handleToggleAppearance();
    });

    expect(result.current.appearance).toBe('light');
    expect(result.current.palette).toBe('kite-light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    act(() => {
      result.current.handleToggleAppearance();
    });

    expect(result.current.appearance).toBe('dark');
    expect(result.current.palette).toBe('kite-dark');
  });

  it('selects explicit theme and palette', () => {
    const { result } = renderHook(() => useAppTheme());

    act(() => {
      result.current.handleSelectTheme('tokyo-night', 'dark');
    });

    expect(result.current.palette).toBe('tokyo-night');
    expect(result.current.appearance).toBe('dark');
    expect(document.documentElement.getAttribute('data-palette')).toBe('tokyo-night');
  });
});
