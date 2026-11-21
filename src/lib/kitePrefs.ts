export const KITE_PREF_NAMES = [
  'palette',
  'theme',
  'settingsTab',
  'terminalShell',
  'showPaneContext',
  'workMode',
  'agentActivityIndicator',
  'agentActivityIndicatorColor',
] as const;

export type KitePrefName = (typeof KITE_PREF_NAMES)[number];

export const AGENT_ACTIVITY_INDICATOR_STYLES = [
  'matrix-grid',
  'signal-bars',
  'pulse-aura',
  'kite-diamond',
  'matrix-3x3',
  'wave-dots',
  'radar-sweep',
  'chevron-flow',
] as const;

export type AgentActivityIndicatorStyle = (typeof AGENT_ACTIVITY_INDICATOR_STYLES)[number];

export const DEFAULT_AGENT_ACTIVITY_INDICATOR_STYLE: AgentActivityIndicatorStyle = 'matrix-grid';
export const AGENT_ACTIVITY_INDICATOR_EVENT = 'kite:agent-activity-indicator-changed';

export function isValidAgentActivityIndicatorStyle(
  value: unknown
): value is AgentActivityIndicatorStyle {
  return (
    typeof value === 'string' &&
    (AGENT_ACTIVITY_INDICATOR_STYLES as readonly string[]).includes(value)
  );
}

export function readAgentActivityIndicatorStyle(): AgentActivityIndicatorStyle {
  const saved = readKitePref('agentActivityIndicator');
  return isValidAgentActivityIndicatorStyle(saved)
    ? saved
    : DEFAULT_AGENT_ACTIVITY_INDICATOR_STYLE;
}

export function writeAgentActivityIndicatorStyle(style: AgentActivityIndicatorStyle): void {
  writeKitePref('agentActivityIndicator', style);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(AGENT_ACTIVITY_INDICATOR_EVENT, { detail: { style } })
    );
  }
}

export const AGENT_ACTIVITY_INDICATOR_COLOR_PRESETS = [
  'status',
  'accent',
  'cyan',
  'violet',
  'amber',
  'rose',
  'neutral',
] as const;

export type AgentActivityIndicatorColorPreset =
  (typeof AGENT_ACTIVITY_INDICATOR_COLOR_PRESETS)[number];
export type AgentActivityIndicatorColor = AgentActivityIndicatorColorPreset | `#${string}`;

export const DEFAULT_AGENT_ACTIVITY_INDICATOR_COLOR: AgentActivityIndicatorColor = 'status';
export const AGENT_ACTIVITY_INDICATOR_COLOR_EVENT = 'kite:agent-activity-indicator-color-changed';

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function isValidAgentActivityIndicatorColor(
  value: unknown
): value is AgentActivityIndicatorColor {
  if (typeof value !== 'string') return false;
  if ((AGENT_ACTIVITY_INDICATOR_COLOR_PRESETS as readonly string[]).includes(value)) return true;
  return HEX_COLOR_RE.test(value);
}

export function readAgentActivityIndicatorColor(): AgentActivityIndicatorColor {
  const saved = readKitePref('agentActivityIndicatorColor');
  return isValidAgentActivityIndicatorColor(saved)
    ? saved
    : DEFAULT_AGENT_ACTIVITY_INDICATOR_COLOR;
}

export function writeAgentActivityIndicatorColor(color: AgentActivityIndicatorColor): void {
  if (!isValidAgentActivityIndicatorColor(color)) return;
  writeKitePref('agentActivityIndicatorColor', color);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(AGENT_ACTIVITY_INDICATOR_COLOR_EVENT, { detail: { color } })
    );
  }
}

export function resolveAgentActivityIndicatorColorValue(
  color: AgentActivityIndicatorColor
): string | undefined {
  switch (color) {
    case 'status':
      return undefined;
    case 'accent':
      return 'var(--accent, #5c8fff)';
    case 'cyan':
      return '#38bdf8';
    case 'violet':
      return '#a78bfa';
    case 'amber':
      return '#fbbf24';
    case 'rose':
      return '#fb7185';
    case 'neutral':
      return 'var(--text-secondary, #a3a3a3)';
    default:
      return HEX_COLOR_RE.test(color) ? color : undefined;
  }
}

export const VALID_WORK_MODES = ['agent', 'code', 'chat'] as const;
export type PersistedWorkMode = (typeof VALID_WORK_MODES)[number];

export function isValidWorkMode(value: unknown): value is PersistedWorkMode {
  return value === 'agent' || value === 'code' || value === 'chat';
}

export function readSavedWorkMode(): PersistedWorkMode | null {
  const saved = readKitePref('workMode');
  return isValidWorkMode(saved) ? saved : null;
}

export function writeSavedWorkMode(mode: PersistedWorkMode): void {
  writeKitePref('workMode', mode);
}

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
