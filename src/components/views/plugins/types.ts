export type PluginCategory =
  | 'developer'
  | 'productivity'
  | 'creative'
  | 'marketing'
  | 'finance';

export type PluginAuthState =
  | 'preview'
  | 'oauthMCP'
  | 'apiKey'
  | 'oauthGoogle'
  | 'oauthMeta'
  | 'localMCP'
  | 'oauthIntuit';

export type PluginConnectionStatus = 'installed' | 'available' | 'disabled';

export type PluginLogo =
  | { onDark: string; onLight: string }
  | { file: string }
  | { template: string };

export interface OfficialPlugin {
  id: string;
  name: string;
  vendor: string;
  version: string;
  category: PluginCategory;
  summary: string;
  description: string;
  authentication: PluginAuthState;
  prefersDarkTile: boolean;
  logo: PluginLogo;
  fallbackIcon: 'bug' | 'send' | null;
  initialState: 'preview' | 'unavailable' | 'disconnected';
  permissions: string[];
  docUrl?: string;
}

export interface PluginConfig {
  apiKey?: string;
  endpoint?: string;
  readOnly?: boolean;
  account?: string;
  customPort?: number;
}

export interface ActivePlugin extends OfficialPlugin {
  status: PluginConnectionStatus;
  config?: PluginConfig;
  lastConnectedAt?: number | null;
}
