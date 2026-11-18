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
  | 'chat'
  | 'subagents'
  | 'zed'
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

import {
  VISUAL_THEME_PACKS,
  type BackdropPresetId,
  type HeroFigureId,
} from '../../../lib/themeCustomizations';

export interface ThemeItem {
  id: string;
  name: string;
  mode: 'dark' | 'light';
  blurb: string;
  badge?: string;
  defaultBackdrop?: Exclude<BackdropPresetId, 'theme-default' | 'custom-image'>;
  defaultFigure?: Exclude<HeroFigureId, 'theme-default'>;
  defaultTranslucent?: boolean;
}

export const DARK_THEMES: ThemeItem[] = VISUAL_THEME_PACKS.filter(
  (pack) => pack.mode === 'dark'
).map((pack) => ({
  id: pack.id,
  name: pack.name,
  mode: pack.mode,
  blurb: pack.blurb,
  badge: pack.badge,
  defaultBackdrop: pack.defaultBackdrop,
  defaultFigure: pack.defaultFigure,
  defaultTranslucent: pack.defaultTranslucent,
}));

export const LIGHT_THEMES: ThemeItem[] = VISUAL_THEME_PACKS.filter(
  (pack) => pack.mode === 'light'
).map((pack) => ({
  id: pack.id,
  name: pack.name,
  mode: pack.mode,
  blurb: pack.blurb,
  badge: pack.badge,
  defaultBackdrop: pack.defaultBackdrop,
  defaultFigure: pack.defaultFigure,
  defaultTranslucent: pack.defaultTranslucent,
}));

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
