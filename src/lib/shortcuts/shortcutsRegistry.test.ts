import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getShortcuts,
  getActiveShortcutKeys,
  matchesEvent,
  formatKeyCombination,
  eventToKeyCombination,
  validateShortcut,
  saveShortcut,
  resetShortcut,
  resetAllShortcuts,
  adaptDefaultKeysForPlatform,
  SHORTCUTS_STORAGE_KEY,
  SHORTCUTS_CHANGED_EVENT,
} from './shortcutsRegistry';
import { checkOsReservedShortcut, checkModifierRequirement } from './reservedKeys';

describe('shortcutsRegistry & reservedKeys', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('retrieves default shortcuts when localStorage is empty', () => {
    expect(SHORTCUTS_STORAGE_KEY).toBe('kite.shortcuts.v1');
    const list = getShortcuts('windows');
    expect(list.length).toBeGreaterThan(10);
    const sidebar = list.find((s) => s.id === 'toggle-sidebar');
    expect(sidebar).toBeDefined();
    expect(sidebar?.defaultKeys).toEqual(['Ctrl', 'B']);
    expect(sidebar?.customKeys).toBeUndefined();
  });

  it('adapts Ctrl to Cmd on macOS for default shortcuts', () => {
    const adapted = adaptDefaultKeysForPlatform(['Ctrl', 'Shift', 'B'], 'macos');
    expect(adapted).toEqual(['Cmd', 'Shift', 'B']);

    const macList = getShortcuts('macos');
    const sidebar = macList.find((s) => s.id === 'toggle-sidebar');
    expect(sidebar?.defaultKeys).toEqual(['Cmd', 'B']);
  });

  it('formats key combination correctly for display', () => {
    expect(formatKeyCombination(['Ctrl', 'Shift', 'B'], 'windows')).toBe('Ctrl+Shift+B');
    expect(formatKeyCombination(['Cmd', 'Shift', 'B'], 'macos')).toBe('⌘⇧B');
    expect(formatKeyCombination(['Esc'], 'windows')).toBe('Esc');
  });

  describe('matchesEvent', () => {
    it('matches Ctrl+B on Windows', () => {
      const event = new KeyboardEvent('keydown', {
        key: 'b',
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
      });
      expect(matchesEvent(['Ctrl', 'B'], event, 'windows')).toBe(true);
      expect(matchesEvent(['Ctrl', 'K'], event, 'windows')).toBe(false);
    });

    it('matches Cmd+B on macOS', () => {
      const event = new KeyboardEvent('keydown', {
        key: 'b',
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
      });
      expect(matchesEvent(['Cmd', 'B'], event, 'macos')).toBe(true);
      expect(matchesEvent(['Ctrl', 'B'], event, 'macos')).toBe(false);
    });

    it('matches Escape without modifiers', () => {
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
      });
      expect(matchesEvent(['Esc'], event, 'windows')).toBe(true);
    });

    it('matches digits like Ctrl+1', () => {
      const event = new KeyboardEvent('keydown', {
        key: '1',
        ctrlKey: true,
      });
      expect(matchesEvent(['Ctrl', '1'], event, 'windows')).toBe(true);
    });
  });

  describe('eventToKeyCombination', () => {
    it('extracts keys cleanly from KeyboardEvent on Windows', () => {
      const event = new KeyboardEvent('keydown', {
        key: 'k',
        ctrlKey: true,
        shiftKey: true,
      });
      const keys = eventToKeyCombination(event, 'windows');
      expect(keys).toEqual(['Ctrl', 'Shift', 'K']);
    });

    it('extracts Cmd on macOS', () => {
      const event = new KeyboardEvent('keydown', {
        key: 'p',
        metaKey: true,
      });
      const keys = eventToKeyCombination(event, 'macos');
      expect(keys).toEqual(['Cmd', 'P']);
    });
  });

  describe('OS Reserved Shortcuts detection', () => {
    it('detects Alt+F4 on Windows as reserved', () => {
      const check = checkOsReservedShortcut(['Alt', 'F4'], 'windows');
      expect(check.isReserved).toBe(true);
      expect(check.osName).toBe('Windows');
    });

    it('detects Ctrl+Alt+Del on Windows as reserved', () => {
      const check = checkOsReservedShortcut(['Ctrl', 'Alt', 'Del'], 'windows');
      expect(check.isReserved).toBe(true);
    });

    it('detects any Win key shortcut on Windows as reserved', () => {
      const check = checkOsReservedShortcut(['Meta', 'L'], 'windows');
      expect(check.isReserved).toBe(true);
    });

    it('detects Cmd+Q on macOS as reserved', () => {
      const check = checkOsReservedShortcut(['Meta', 'Q'], 'macos');
      expect(check.isReserved).toBe(true);
      expect(check.osName).toBe('macOS');
    });

    it('detects Ctrl+Alt+T on Linux as reserved', () => {
      const check = checkOsReservedShortcut(['Ctrl', 'Alt', 'T'], 'linux');
      expect(check.isReserved).toBe(true);
      expect(check.osName).toBe('Linux');
    });

    it('detects F5 / Ctrl+R reload on all platforms as reserved', () => {
      expect(checkOsReservedShortcut(['F5'], 'windows').isReserved).toBe(true);
      expect(checkOsReservedShortcut(['Ctrl', 'R'], 'windows').isReserved).toBe(true);
      expect(checkOsReservedShortcut(['Meta', 'R'], 'macos').isReserved).toBe(true);
    });
  });

  describe('Modifier requirement', () => {
    it('rejects single alphanumeric keys without modifiers', () => {
      const check = checkModifierRequirement(['A']);
      expect(check.valid).toBe(false);
      expect(check.error).toContain('modificadora');
    });

    it('allows Esc or F-keys without modifiers', () => {
      expect(checkModifierRequirement(['Esc']).valid).toBe(true);
      expect(checkModifierRequirement(['F1']).valid).toBe(true);
      expect(checkModifierRequirement(['F12']).valid).toBe(true);
    });

    it('allows single key when allowNoModifier is true', () => {
      expect(checkModifierRequirement(['Esc'], true).valid).toBe(true);
    });

    it('rejects combinations with only modifiers and no main key', () => {
      expect(checkModifierRequirement(['Ctrl', 'Shift']).valid).toBe(false);
    });
  });

  describe('validateShortcut & collision handling', () => {
    it('detects collision with existing Kite shortcut', () => {
      // 'toggle-sidebar' is ['Ctrl', 'B'] by default
      const res = validateShortcut(['Ctrl', 'B'], 'open-settings', 'windows');
      expect(res.valid).toBe(false);
      expect(res.conflictWith?.id).toBe('toggle-sidebar');
      expect(res.error).toContain('Conflicto');
    });

    it('allows setting the same shortcut for itself (no collision)', () => {
      const res = validateShortcut(['Ctrl', 'B'], 'toggle-sidebar', 'windows');
      expect(res.valid).toBe(true);
    });

    it('flags reserved OS shortcut when validating', () => {
      const res = validateShortcut(['Alt', 'F4'], 'toggle-sidebar', 'windows');
      expect(res.valid).toBe(false);
      expect(res.isReservedByOs).toBe(true);
    });
  });

  describe('persistence and resetting', () => {
    it('saves custom shortcut to localStorage and dispatches event', () => {
      const spyDispatch = vi.spyOn(window, 'dispatchEvent');

      const saveRes = saveShortcut('toggle-sidebar', ['Ctrl', 'Shift', 'X'], 'windows');
      expect(saveRes.success).toBe(true);

      const active = getActiveShortcutKeys('toggle-sidebar', 'windows');
      expect(active).toEqual(['Ctrl', 'Shift', 'X']);

      expect(spyDispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: SHORTCUTS_CHANGED_EVENT })
      );
    });

    it('resets a single shortcut back to default', () => {
      saveShortcut('toggle-sidebar', ['Ctrl', 'Shift', 'X'], 'windows');
      expect(getActiveShortcutKeys('toggle-sidebar', 'windows')).toEqual(['Ctrl', 'Shift', 'X']);

      resetShortcut('toggle-sidebar');
      expect(getActiveShortcutKeys('toggle-sidebar', 'windows')).toEqual(['Ctrl', 'B']);
    });

    it('resets all shortcuts back to defaults', () => {
      saveShortcut('toggle-sidebar', ['Ctrl', 'Shift', 'X'], 'windows');
      saveShortcut('open-settings', ['Ctrl', 'Shift', 'Y'], 'windows');

      resetAllShortcuts();
      expect(getActiveShortcutKeys('toggle-sidebar', 'windows')).toEqual(['Ctrl', 'B']);
      expect(getActiveShortcutKeys('open-settings', 'windows')).toEqual(['Ctrl', ',']);
    });
  });
});
