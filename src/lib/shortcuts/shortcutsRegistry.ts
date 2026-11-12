import { ShortcutItem, ShortcutValidationResult, SupportedPlatform } from './types';
import {
  checkModifierRequirement,
  checkOsReservedShortcut,
  normalizeKeysForComparison,
} from './reservedKeys';

export const SHORTCUTS_STORAGE_KEY = 'kite.shortcuts.v1';
export const SHORTCUTS_CHANGED_EVENT = 'kite:shortcuts-changed';

export function getPlatform(): SupportedPlatform {
  if (typeof navigator === 'undefined') return 'windows';
  const ua = (navigator.userAgent || '').toLowerCase();
  const plat = (navigator.platform || '').toLowerCase();
  if (plat.includes('mac') || ua.includes('macintosh') || ua.includes('mac os')) return 'macos';
  if (plat.includes('linux') || ua.includes('linux')) return 'linux';
  return 'windows';
}

export const DEFAULT_SHORTCUTS: ShortcutItem[] = [
  // --- NAVIGATION ---
  {
    id: 'toggle-sidebar',
    category: 'Navigation',
    action: 'Toggle lateral sidebar',
    description: 'Show or hide the primary left navigation sidebar.',
    defaultKeys: ['Ctrl', 'B'],
  },
  {
    id: 'open-settings',
    category: 'Navigation',
    action: 'Open application settings',
    description: 'Open the settings dashboard.',
    defaultKeys: ['Ctrl', ','],
  },
  {
    id: 'command-palette',
    category: 'Navigation',
    action: 'Open command palette',
    description: 'Quickly run commands and access views across Kite.',
    defaultKeys: ['Ctrl', 'P'],
  },
  {
    id: 'quick-switcher',
    category: 'Navigation',
    action: 'Quick switcher',
    description: 'Jump between workspaces, agents and active sessions.',
    defaultKeys: ['Ctrl', 'K'],
  },
  {
    id: 'back-esc',
    category: 'Navigation',
    action: 'Dismiss modal / Return',
    description: 'Close active popovers, overlays, or return to previous view.',
    defaultKeys: ['Esc'],
    allowNoModifier: true,
  },

  // --- MODES ---
  {
    id: 'mode-agent',
    category: 'Modes',
    action: 'Switch to Agent mode',
    description: 'Navigate to autonomous Agent orchestrator workspace.',
    defaultKeys: ['Ctrl', '1'],
  },
  {
    id: 'mode-code',
    category: 'Modes',
    action: 'Switch to Code Workspace mode',
    description: 'Navigate to multi-pane code workspace and terminals.',
    defaultKeys: ['Ctrl', '2'],
  },
  {
    id: 'mode-chat',
    category: 'Modes',
    action: 'Switch to Chat mode',
    description: 'Navigate to conversational thread view.',
    defaultKeys: ['Ctrl', '3'],
  },
  {
    id: 'toggle-dock',
    category: 'Modes',
    action: 'Toggle right dock / browser',
    description: 'Expand or collapse the auxiliary side panel and web dock.',
    defaultKeys: ['Ctrl', 'Shift', 'B'],
  },
  {
    id: 'toggle-diffs',
    category: 'Modes',
    action: 'Toggle diffs viewer',
    description: 'Open or focus the Git diffs review panel in the right dock.',
    defaultKeys: ['Ctrl', 'Alt', 'D'],
  },

  // --- TERMINAL & CODE ---
  {
    id: 'new-terminal',
    category: 'Terminal & Code',
    action: 'Open new terminal',
    description: 'Spawn a new command terminal session in the current tab.',
    defaultKeys: ['Ctrl', 'Shift', '`'],
  },
  {
    id: 'split-vertical',
    category: 'Terminal & Code',
    action: 'Split pane vertically',
    description: 'Split the currently focused workspace pane side-by-side.',
    defaultKeys: ['Ctrl', '\\'],
  },
  {
    id: 'split-horizontal',
    category: 'Terminal & Code',
    action: 'Split pane horizontally',
    description: 'Split the currently focused workspace pane top-and-bottom.',
    defaultKeys: ['Ctrl', 'Shift', '\\'],
  },
  {
    id: 'close-pane',
    category: 'Terminal & Code',
    action: 'Close focused pane',
    description: 'Close the active terminal or editor pane.',
    defaultKeys: ['Ctrl', 'W'],
  },
  {
    id: 'save-file',
    category: 'Terminal & Code',
    action: 'Save active file',
    description: 'Write editor changes to disk in the file previewer.',
    defaultKeys: ['Ctrl', 'S'],
  },

  // --- VOICE & ASSISTANT ---
  {
    id: 'toggle-operator',
    category: 'Voice',
    action: 'Toggle Zed Assistant',
    description: 'Summon or dismiss the floating Zed voice and assistant bar.',
    defaultKeys: ['Ctrl', 'Shift', 'K'],
  },
  {
    id: 'dictation-toggle',
    category: 'Voice',
    action: 'Start / Stop voice dictation',
    description: 'Toggle real-time voice recording and speech transcription.',
    defaultKeys: ['Ctrl', 'Shift', 'V'],
  },
];

/**
 * Returns the effective keys for default shortcuts taking into account macOS Cmd substitution.
 */
export function adaptDefaultKeysForPlatform(keys: string[], platform: SupportedPlatform): string[] {
  if (platform !== 'macos') return keys;
  return keys.map((k) => (k.toLowerCase() === 'ctrl' ? 'Cmd' : k));
}

/**
 * Reads custom user keybindings from localStorage.
 */
export function getCustomKeybindingsMap(): Record<string, string[]> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(SHORTCUTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, string[]>;
    }
  } catch (err) {
    console.warn('Failed to parse stored shortcuts:', err);
  }
  return {};
}

/**
 * Retrieves all registered shortcuts with their custom overrides.
 */
export function getShortcuts(platform: SupportedPlatform = getPlatform()): ShortcutItem[] {
  const customMap = getCustomKeybindingsMap();

  return DEFAULT_SHORTCUTS.map((item) => {
    const defaultKeys = adaptDefaultKeysForPlatform(item.defaultKeys, platform);
    const custom = customMap[item.id];
    return {
      ...item,
      defaultKeys,
      customKeys: Array.isArray(custom) && custom.length > 0 ? custom : undefined,
    };
  });
}

/**
 * Returns the active keys for a specific shortcut ID.
 */
export function getActiveShortcutKeys(id: string, platform: SupportedPlatform = getPlatform()): string[] {
  const shortcuts = getShortcuts(platform);
  const found = shortcuts.find((s) => s.id === id);
  if (!found) return [];
  return found.customKeys || found.defaultKeys;
}

/**
 * Formats a key combination for human-readable display.
 */
export function formatKeyCombination(keys: string[], platform: SupportedPlatform = getPlatform()): string {
  if (!keys || keys.length === 0) return '';
  const isMac = platform === 'macos';

  return keys
    .map((k) => {
      const lower = k.toLowerCase();
      if (lower === 'ctrl' || lower === 'control') return isMac ? '⌃' : 'Ctrl';
      if (lower === 'cmd' || lower === 'meta') return isMac ? '⌘' : 'Win';
      if (lower === 'alt' || lower === 'option') return isMac ? '⌥' : 'Alt';
      if (lower === 'shift') return isMac ? '⇧' : 'Shift';
      if (lower === 'esc' || lower === 'escape') return 'Esc';
      if (lower === ' ') return 'Space';
      if (lower === 'backquote') return '`';
      if (lower === 'backslash') return '\\';
      return k.toUpperCase();
    })
    .join(isMac ? '' : '+');
}

/**
 * Checks whether a KeyboardEvent matches a given keys array.
 */
export function matchesEvent(
  keys: string[],
  event: KeyboardEvent,
  platform: SupportedPlatform = getPlatform()
): boolean {
  if (!keys || keys.length === 0) return false;

  const normalized = normalizeKeysForComparison(keys);
  const isMac = platform === 'macos';

  // Has modifiers in keys:
  const expectsCtrl = normalized.includes('Ctrl');
  const expectsMeta = normalized.includes('Meta');
  const expectsAlt = normalized.includes('Alt');
  const expectsShift = normalized.includes('Shift');

  // Match modifiers
  // On Mac, Cmd is Meta. If keys specified 'Ctrl' on Mac, check if event has ctrl.
  // When matching adapted shortcuts on Mac, Cmd = event.metaKey.
  const hasCtrl = event.ctrlKey;
  const hasMeta = event.metaKey;
  const hasAlt = event.altKey;
  const hasShift = event.shiftKey;

  // Primary modifier match:
  if (isMac) {
    if (expectsMeta !== hasMeta) return false;
    if (expectsCtrl !== hasCtrl) return false;
  } else {
    // Windows/Linux: Ctrl is event.ctrlKey.
    // In case user assigned 'Meta' on Windows (Win key), check event.metaKey.
    if (expectsCtrl !== hasCtrl) return false;
    if (expectsMeta !== hasMeta) return false;
  }

  if (expectsAlt !== hasAlt) return false;
  if (expectsShift !== hasShift) return false;

  // Main key
  const mainKeys = normalized.filter((k) => !['Ctrl', 'Alt', 'Shift', 'Meta'].includes(k));
  if (mainKeys.length === 0) return false;

  const expectedMain = mainKeys[0].toLowerCase();
  const eventKey = (event.key || '').toLowerCase();
  const eventCode = (event.code || '').toLowerCase();

  // Escape special match
  if (expectedMain === 'esc' || expectedMain === 'escape') {
    return eventKey === 'escape' || eventKey === 'esc';
  }

  // Backquote match
  if (expectedMain === '`') {
    return eventKey === '`' || eventCode === 'backquote';
  }

  // Backslash match
  if (expectedMain === '\\') {
    return eventKey === '\\' || eventCode === 'backslash';
  }

  // Comma match
  if (expectedMain === ',') {
    return eventKey === ',' || eventCode === 'comma';
  }

  // Space match
  if (expectedMain === 'space' || expectedMain === ' ') {
    return eventKey === ' ' || eventKey === 'spacebar' || eventCode === 'space';
  }

  // Digits (1-9)
  if (/^[0-9]$/.test(expectedMain)) {
    return eventKey === expectedMain || eventCode === `digit${expectedMain}` || eventCode === `numpad${expectedMain}`;
  }

  // Standard characters
  return eventKey === expectedMain;
}

/**
 * Extracts key combination from an active KeyboardEvent during recording.
 */
export function eventToKeyCombination(
  event: KeyboardEvent,
  platform: SupportedPlatform = getPlatform()
): string[] {
  const result: string[] = [];
  const isMac = platform === 'macos';

  if (isMac) {
    if (event.metaKey) result.push('Cmd');
    if (event.ctrlKey) result.push('Ctrl');
    if (event.altKey) result.push('Alt');
    if (event.shiftKey) result.push('Shift');
  } else {
    if (event.ctrlKey) result.push('Ctrl');
    if (event.altKey) result.push('Alt');
    if (event.shiftKey) result.push('Shift');
    if (event.metaKey) result.push('Meta');
  }

  const rawKey = event.key;
  if (
    rawKey &&
    !['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock'].includes(rawKey)
  ) {
    if (rawKey === 'Escape') {
      result.push('Esc');
    } else if (rawKey === ' ') {
      result.push('Space');
    } else if (rawKey.length === 1) {
      result.push(rawKey.toUpperCase());
    } else {
      result.push(rawKey);
    }
  }

  return result;
}

/**
 * Full validation of a proposed key combination:
 * 1. Checks modifier requirement (single-letter keys without modifiers will be blocked)
 * 2. Checks OS / Webview reserved combinations (Alt+F4, Win+L, Cmd+Q, etc.)
 * 3. Checks collision against all other registered Kite shortcuts
 */
export function validateShortcut(
  keys: string[],
  targetId?: string,
  platform: SupportedPlatform = getPlatform()
): ShortcutValidationResult {
  const currentShortcuts = getShortcuts(platform);
  const targetItem = targetId ? currentShortcuts.find((s) => s.id === targetId) : undefined;
  const allowNoModifier = targetItem?.allowNoModifier ?? false;

  // 1. Modifier check
  const modCheck = checkModifierRequirement(keys, allowNoModifier);
  if (!modCheck.valid) {
    return {
      valid: false,
      error: modCheck.error,
    };
  }

  // 2. OS reserved check
  const osCheck = checkOsReservedShortcut(keys, platform);
  if (osCheck.isReserved) {
    return {
      valid: false,
      isReservedByOs: true,
      osName: osCheck.osName,
      error: `Atajo reservado por el sistema (${osCheck.osName}): ${osCheck.reason}`,
    };
  }

  // 3. Collision with existing Kite shortcuts
  const targetNorm = normalizeKeysForComparison(keys).join('+').toLowerCase();

  for (const item of currentShortcuts) {
    if (targetId && item.id === targetId) continue;

    const activeKeys = item.customKeys || item.defaultKeys;
    const activeNorm = normalizeKeysForComparison(activeKeys).join('+').toLowerCase();

    if (activeNorm === targetNorm) {
      return {
        valid: false,
        conflictWith: {
          id: item.id,
          action: item.action,
        },
        error: `Conflicto: Esta combinación ya está asignada a "${item.action}".`,
      };
    }
  }

  return { valid: true };
}

/**
 * Saves a custom shortcut key combination to localStorage.
 */
export function saveShortcut(
  id: string,
  keys: string[],
  platform: SupportedPlatform = getPlatform()
): { success: boolean; error?: string } {
  const validation = validateShortcut(keys, id, platform);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  try {
    const map = getCustomKeybindingsMap();
    map[id] = keys;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(map));
    }
    window.dispatchEvent(new CustomEvent(SHORTCUTS_CHANGED_EVENT, { detail: { id, keys } }));
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Error guardando atajo en almacenamiento local.' };
  }
}

/**
 * Resets a single shortcut to its default key combination.
 */
export function resetShortcut(id: string): void {
  try {
    const map = getCustomKeybindingsMap();
    delete map[id];
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(map));
    }
    window.dispatchEvent(new CustomEvent(SHORTCUTS_CHANGED_EVENT, { detail: { id } }));
  } catch (err) {
    console.warn('Failed to reset shortcut:', err);
  }
}

/**
 * Resets all shortcuts to defaults.
 */
export function resetAllShortcuts(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(SHORTCUTS_STORAGE_KEY);
    }
    window.dispatchEvent(new CustomEvent(SHORTCUTS_CHANGED_EVENT, { detail: {} }));
  } catch (err) {
    console.warn('Failed to reset all shortcuts:', err);
  }
}
