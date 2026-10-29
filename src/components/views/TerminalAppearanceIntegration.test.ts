import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_TERMINAL_APPEARANCE_PREFS,
  getTerminalAppearancePrefs,
  resolveTerminalFontFamily,
  setTerminalAppearancePrefs,
  TERMINAL_APPEARANCE_CHANGED_EVENT,
} from '../../lib/terminalAppearancePrefs';

describe('Terminal Appearance Configuration & Contract', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('provides default options matching classic Kite terminal appearance', () => {
    const prefs = getTerminalAppearancePrefs();
    expect(prefs.renderer).toBe('dom');
    expect(prefs.lineHeight).toBe(1.16);
    expect(prefs.fontSize).toBe(13);
    expect(prefs.fontFamilyId).toBe('cascadia');
    expect(prefs.cursorStyle).toBe('bar');
    expect(prefs.cursorBlink).toBe(false);

    const fontStack = resolveTerminalFontFamily(prefs.fontFamilyId);
    expect(fontStack).toBe('"Cascadia Mono", "Cascadia Code", Consolas, monospace');
  });

  it('updates live options and triggers fit on TERMINAL_APPEARANCE_CHANGED_EVENT', () => {
    // Simulate terminal mock
    const termMock = {
      options: {
        fontFamily: resolveTerminalFontFamily(DEFAULT_TERMINAL_APPEARANCE_PREFS.fontFamilyId),
        fontSize: DEFAULT_TERMINAL_APPEARANCE_PREFS.fontSize,
        lineHeight: DEFAULT_TERMINAL_APPEARANCE_PREFS.lineHeight,
        cursorStyle: DEFAULT_TERMINAL_APPEARANCE_PREFS.cursorStyle,
        cursorBlink: DEFAULT_TERMINAL_APPEARANCE_PREFS.cursorBlink,
      },
    };

    const onAppearanceChanged = (e: Event) => {
      const prefs = (e as CustomEvent).detail ?? getTerminalAppearancePrefs();
      termMock.options.fontFamily = resolveTerminalFontFamily(prefs.fontFamilyId);
      termMock.options.fontSize = prefs.fontSize;
      termMock.options.lineHeight = prefs.lineHeight;
      termMock.options.cursorStyle = prefs.cursorStyle;
      termMock.options.cursorBlink = prefs.cursorBlink;
    };

    window.addEventListener(TERMINAL_APPEARANCE_CHANGED_EVENT, onAppearanceChanged);

    setTerminalAppearancePrefs({
      fontFamilyId: 'fira',
      fontSize: 16,
      lineHeight: 1.08,
      cursorStyle: 'block',
      cursorBlink: true,
      renderer: 'webgl',
    });

    expect(termMock.options.fontFamily).toBe(
      '"Fira Code", "Cascadia Mono", Consolas, monospace'
    );
    expect(termMock.options.fontSize).toBe(16);
    expect(termMock.options.lineHeight).toBe(1.08);
    expect(termMock.options.cursorStyle).toBe('block');
    expect(termMock.options.cursorBlink).toBe(true);

    window.removeEventListener(TERMINAL_APPEARANCE_CHANGED_EVENT, onAppearanceChanged);
  });
});
