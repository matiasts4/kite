import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_TERMINAL_APPEARANCE_PREFS,
  TERMINAL_APPEARANCE_CHANGED_EVENT,
  TERMINAL_APPEARANCE_STORAGE_KEY,
  clampTerminalFontSize,
  clampTerminalLineHeight,
  getTerminalAppearancePrefs,
  resetTerminalAppearancePrefs,
  resolveTerminalFontFamily,
  sanitizeTerminalAppearancePrefs,
  setTerminalAppearancePrefs,
} from './terminalAppearancePrefs';

describe('terminalAppearancePrefs', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('returns default preferences when localStorage is empty', () => {
    const prefs = getTerminalAppearancePrefs();
    expect(prefs).toEqual(DEFAULT_TERMINAL_APPEARANCE_PREFS);
    expect(prefs.renderer).toBe('dom');
    expect(prefs.fontFamilyId).toBe('cascadia');
    expect(prefs.fontSize).toBe(13);
    expect(prefs.lineHeight).toBe(1.16);
    expect(prefs.cursorStyle).toBe('bar');
    expect(prefs.cursorBlink).toBe(false);
  });

  it('returns default preferences when localStorage has corrupted JSON', () => {
    localStorage.setItem(TERMINAL_APPEARANCE_STORAGE_KEY, 'not-valid-json{{{');
    const prefs = getTerminalAppearancePrefs();
    expect(prefs).toEqual(DEFAULT_TERMINAL_APPEARANCE_PREFS);
  });

  it('clamps font sizes correctly within range [10, 22]', () => {
    expect(clampTerminalFontSize(5)).toBe(10);
    expect(clampTerminalFontSize(13.4)).toBe(13);
    expect(clampTerminalFontSize(14.6)).toBe(15);
    expect(clampTerminalFontSize(25)).toBe(22);
    expect(clampTerminalFontSize(NaN)).toBe(13);
  });

  it('clamps line heights correctly within range [1.0, 1.4]', () => {
    expect(clampTerminalLineHeight(0.8)).toBe(1.0);
    expect(clampTerminalLineHeight(1.16)).toBe(1.16);
    expect(clampTerminalLineHeight(1.083)).toBe(1.08);
    expect(clampTerminalLineHeight(1.85)).toBe(1.4);
    expect(clampTerminalLineHeight(NaN)).toBe(1.16);
  });

  it('sanitizes unknown properties and invalid enums gracefully', () => {
    const sanitized = sanitizeTerminalAppearancePrefs({
      renderer: 'unknown-engine',
      fontFamilyId: 'comic-sans',
      fontSize: 999,
      lineHeight: 0.1,
      cursorStyle: 'invalid-style',
      cursorBlink: 'yes',
    });

    expect(sanitized.renderer).toBe('dom');
    expect(sanitized.fontFamilyId).toBe('cascadia');
    expect(sanitized.fontSize).toBe(22);
    expect(sanitized.lineHeight).toBe(1.0);
    expect(sanitized.cursorStyle).toBe('bar');
    expect(sanitized.cursorBlink).toBe(false);
  });

  it('resolves font family stacks properly', () => {
    expect(resolveTerminalFontFamily('cascadia')).toContain('Cascadia Mono');
    expect(resolveTerminalFontFamily('jetbrains')).toContain('JetBrains Mono');
    expect(resolveTerminalFontFamily('geist')).toContain('Geist Mono');
    expect(resolveTerminalFontFamily('fira')).toContain('Fira Code');
    expect(resolveTerminalFontFamily('consolas')).toContain('Consolas');
    expect(resolveTerminalFontFamily('non-existent' as any)).toContain('Cascadia Mono');
  });

  it('persists updates and broadcasts change event', () => {
    const handler = vi.fn();
    window.addEventListener(TERMINAL_APPEARANCE_CHANGED_EVENT, handler);

    const updated = setTerminalAppearancePrefs({
      renderer: 'webgl',
      fontSize: 16,
      lineHeight: 1.08,
      cursorStyle: 'block',
      cursorBlink: true,
      fontFamilyId: 'jetbrains',
    });

    expect(updated).toEqual({
      renderer: 'webgl',
      fontFamilyId: 'jetbrains',
      fontSize: 16,
      lineHeight: 1.08,
      cursorStyle: 'block',
      cursorBlink: true,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual(updated);

    // Verify localStorage reflection
    const reloaded = getTerminalAppearancePrefs();
    expect(reloaded).toEqual(updated);

    window.removeEventListener(TERMINAL_APPEARANCE_CHANGED_EVENT, handler);
  });

  it('resets to defaults cleanly', () => {
    setTerminalAppearancePrefs({
      renderer: 'webgl',
      fontSize: 20,
      lineHeight: 1.0,
      cursorStyle: 'underline',
    });

    const reset = resetTerminalAppearancePrefs();
    expect(reset).toEqual(DEFAULT_TERMINAL_APPEARANCE_PREFS);

    const stored = getTerminalAppearancePrefs();
    expect(stored).toEqual(DEFAULT_TERMINAL_APPEARANCE_PREFS);
  });
});
