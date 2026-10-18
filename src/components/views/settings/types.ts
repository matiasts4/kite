import type React from 'react';
import type { IconProps } from './icons';

export type SvgIconComponent = React.FC<IconProps>;

export type SettingsTabId =
  | 'general'
  | 'appearance'
  | 'customizations'
  | 'voice'
  | 'models'
  | 'keybindings'
  | 'about'
  | 'changelog'
  | 'telemetry'
  | 'terminal'
  | 'notifications'
  | 'bridge'
  | 'agents'
  | 'plugins'
  | 'remote'
  | 'import'
  | 'account'
  | 'quotas'
  | 'routines';

export interface SettingsTabConfig {
  id: SettingsTabId;
  label: string;
  blurb: string;
  icon: SvgIconComponent;
  hasDividerBefore?: boolean;
}

export interface ThemeItem {
  id: string;
  name: string;
  mode: 'dark' | 'light';
  blurb: string;
}

export const DARK_THEMES: ThemeItem[] = [
  { id: 'kite-dark', name: 'Kite Dark', mode: 'dark', blurb: 'The house palette, tuned for night' },
  { id: 'tokyo-night', name: 'Tokyo Night', mode: 'dark', blurb: 'Neon blues on deep indigo' },
  { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', mode: 'dark', blurb: 'Pastel accents on warm charcoal' },
  { id: 'nord', name: 'Nord', mode: 'dark', blurb: 'Frosted blues from the Arctic' },
  { id: 'dracula', name: 'Dracula', mode: 'dark', blurb: 'Vivid pinks on vampire purple' },
];

export const LIGHT_THEMES: ThemeItem[] = [
  { id: 'kite-light', name: 'Kite Light', mode: 'light', blurb: 'The house palette, in daylight' },
  { id: 'catppuccin-latte', name: 'Catppuccin Latte', mode: 'light', blurb: 'Pastel accents on soft cream' },
  { id: 'solarized-light', name: 'Solarized Light', mode: 'light', blurb: 'Balanced tones on warm paper' },
  { id: 'github-light', name: 'GitHub Light', mode: 'light', blurb: 'The pull-request page you know' },
];

export interface TelemetryPrefs {
  diagnostics: boolean;
  analytics: boolean;
}

export interface TelemetryIdentity {
  revision: number;
  ready: boolean;
  id: string | null;
}

export interface UpdateCheckResult {
  available: boolean;
  version: string | null;
  notes: string | null;
  current_version?: string | null;
}

export interface DictationEngine {
  id: 'whisper' | 'parakeet' | string;
  label: string;
  available: boolean;
  detail: string;
}

export interface DictationAvailability {
  schemaVersion?: number;
  state?: 'ready' | 'permissionRequired' | 'permissionDenied' | 'noSafeDevice' | 'unavailable' | string;
  canRequestPermission?: boolean;
  canStart: boolean;
  guidance?: string;
  localEngines?: DictationEngine[];
  supported?: boolean;
  engine?: string | null;
}

export interface DictationSettings {
  schemaVersion?: number;
  mode: 'cloud' | 'local';
  localEngine?: 'whisper' | 'parakeet' | null;
  language?: string;
  deviceId?: string | null;
  cuesEnabled: boolean;
  shortcut: {
    kind: string;
  };
}

export interface DictationInputDevice {
  id: string;
  name: string;
  isBluetooth: boolean;
}

export interface DictationDeviceList {
  schemaVersion: number;
  devices: DictationInputDevice[];
  selectedId: string | null;
}

export interface ReleaseItem {
  kind: 'added' | 'changed' | 'fixed' | 'security';
  description: string;
}

export interface ReleaseVersion {
  version: string;
  date: string;
  items: ReleaseItem[];
}
