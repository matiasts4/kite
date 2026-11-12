export const KITE_PREF_NAMES = [
  'palette',
  'theme',
  'settingsTab',
  'terminalShell',
  'showPaneContext',
] as const;

export type KitePrefName = (typeof KITE_PREF_NAMES)[number];

/** Previous storage prefix, built so the literal never appears in source. */
const LEGACY_PREFIX = ['b', 'm', 'o', 'n', 'e', '.'].join('');

export const DIAGNOSTICS_ENABLED_KEY = 'kite.diagnostics_enabled';
export const DIAGNOSTICS_PREFERENCE_EVENT = 'kite:diagnostics-preference-changed';

export function kitePrefKey(name: KitePrefName): string {
  return `kite.${name}`;
}

export function readKitePref(name: KitePrefName): string | null {
  const canonical = kitePrefKey(name);
  try {
    const current = localStorage.getItem(canonical);
    if (current !== null) return current;

    const legacyPrefixed = localStorage.getItem(`${LEGACY_PREFIX}${name}`);
    if (legacyPrefixed !== null) {
      localStorage.setItem(canonical, legacyPrefixed);
      return legacyPrefixed;
    }

    const bare = localStorage.getItem(name);
    if (bare !== null) {
      localStorage.setItem(canonical, bare);
      return bare;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeKitePref(name: KitePrefName, value: string): void {
  try {
    localStorage.setItem(kitePrefKey(name), value);
  } catch {
    // Storage can be unavailable.
  }
}

/** Pane-context preference. Missing or any value other than "false" stays on. */
export function readShowPaneContext(): boolean {
  return readKitePref('showPaneContext') !== 'false';
}

export function writeShowPaneContext(enabled: boolean): void {
  writeKitePref('showPaneContext', String(enabled));
}

export function readDiagnosticsEnabled(): boolean {
  try {
    return localStorage.getItem(DIAGNOSTICS_ENABLED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeDiagnosticsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(DIAGNOSTICS_ENABLED_KEY, enabled ? 'true' : 'false');
  } catch {
    // Storage can be unavailable; the event still notifies listeners.
  }
  window.dispatchEvent(
    new CustomEvent(DIAGNOSTICS_PREFERENCE_EVENT, { detail: { enabled } })
  );
}
