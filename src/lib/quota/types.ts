export interface QuotaWindow {
  name: string;
  usagePercent: number;
  remainingFraction: number;
  resetsAt: string | null;
  timeUntilResetMs: number | null;
  isExhausted: boolean;
}

export interface ProviderQuotaStatus {
  providerId: string;
  displayName: string;
  isAvailable: boolean;
  isAuth: boolean;
  primaryUsagePercent: number;
  primaryRemainingPercent: number;
  primaryResetAt: string | null;
  timeUntilResetMs: number | null;
  windows: QuotaWindow[];
  metadata?: Record<string, any>;
  lastUpdatedMs: number;
  error?: string | null;
}

export const PROVIDERS = {
  ANTIGRAVITY: 'antigravity',
  QODER: 'qoder',
  CLAUDE: 'claude',
  CODEX: 'codex',
  OPENCODE: 'opencode',
  GROK: 'grok',
  GEMINI: 'gemini',
  CURSOR: 'cursor',
  DROID: 'droid',
  COPILOT: 'copilot',
  DEEPSEEK: 'deepseek',
  KIMI: 'kimi',
} as const;

export type ProviderId = (typeof PROVIDERS)[keyof typeof PROVIDERS];

export const PROVIDER_LABELS: Record<string, string> = {
  [PROVIDERS.ANTIGRAVITY]: 'Antigravity',
  [PROVIDERS.QODER]: 'Qoder',
  [PROVIDERS.CLAUDE]: 'Claude Code',
  [PROVIDERS.CODEX]: 'Codex',
  [PROVIDERS.OPENCODE]: 'OpenCode',
  [PROVIDERS.GROK]: 'Grok Build',
  [PROVIDERS.GEMINI]: 'Gemini CLI',
  [PROVIDERS.CURSOR]: 'Cursor',
  [PROVIDERS.DROID]: 'Droid',
  [PROVIDERS.COPILOT]: 'GitHub Copilot',
  [PROVIDERS.DEEPSEEK]: 'DeepSeek',
  [PROVIDERS.KIMI]: 'Kimi Code',
};

export const SHORT_PROVIDER_LABELS: Record<string, string> = {
  [PROVIDERS.ANTIGRAVITY]: 'Antigravity',
  [PROVIDERS.QODER]: 'Qoder',
  [PROVIDERS.CLAUDE]: 'Claude',
  [PROVIDERS.CODEX]: 'Codex',
  [PROVIDERS.OPENCODE]: 'OpenCode',
  [PROVIDERS.GROK]: 'Grok',
  [PROVIDERS.GEMINI]: 'Gemini',
  [PROVIDERS.CURSOR]: 'Cursor',
  [PROVIDERS.DROID]: 'Droid',
  [PROVIDERS.COPILOT]: 'Copilot',
  [PROVIDERS.DEEPSEEK]: 'DeepSeek',
  [PROVIDERS.KIMI]: 'Kimi',
};

export const PROVIDER_ICONS: Record<string, string> = {
  [PROVIDERS.ANTIGRAVITY]: '/assets/logos/agent-antigravity.png',
  [PROVIDERS.QODER]: '/assets/logos/agent-qoder.png',
  [PROVIDERS.CLAUDE]: '/assets/logos/agent-claude.png',
  [PROVIDERS.CODEX]: '/assets/logos/agent-codex-onDark.png',
  [PROVIDERS.OPENCODE]: '/assets/logos/agent-opencode-onDark.png',
  [PROVIDERS.GROK]: '/assets/logos/agent-grok-onDark.png',
  [PROVIDERS.GEMINI]: '/assets/logos/agent-gemini-onDark.png',
  [PROVIDERS.CURSOR]: '/assets/logos/agent-cursor-onDark.png',
  [PROVIDERS.DROID]: '/assets/logos/agent-droid-onDark.png',
  [PROVIDERS.COPILOT]: '/assets/logos/agent-copilot-onDark.png',
  [PROVIDERS.DEEPSEEK]: '/assets/logos/agent-deepseek.png',
  [PROVIDERS.KIMI]: '/assets/logos/agent-kimi-onDark.png',
};

export interface QuotaPreferences {
  enabled: boolean;
  pinnedProvider: string | null;
  autoDetectActive: boolean;
  providerOrder: string[];
  enabledProviders: string[];
  displayMode: 'percent_remaining' | 'percent_used' | 'compact';
  /**
   * 1 = legacy install where every supported provider was enabled implicitly.
   * 2 = explicit onboarding: only providers the user added are enabled.
   */
  setupVersion?: number;
}

export const QUOTA_SETUP_VERSION = 2;

export const ALL_SUPPORTED_PROVIDERS: string[] = [
  PROVIDERS.ANTIGRAVITY,
  PROVIDERS.QODER,
  PROVIDERS.CLAUDE,
  PROVIDERS.CODEX,
  PROVIDERS.OPENCODE,
  PROVIDERS.GROK,
  PROVIDERS.GEMINI,
  PROVIDERS.CURSOR,
  PROVIDERS.DROID,
  PROVIDERS.COPILOT,
  PROVIDERS.DEEPSEEK,
  PROVIDERS.KIMI,
];

export const DEFAULT_QUOTA_PREFERENCES: QuotaPreferences = {
  enabled: true,
  pinnedProvider: null,
  autoDetectActive: true,
  providerOrder: [...ALL_SUPPORTED_PROVIDERS],
  enabledProviders: [],
  displayMode: 'percent_remaining',
  setupVersion: QUOTA_SETUP_VERSION,
};

/** Keeps only supported provider ids, preserving the given order. */
export function normalizeProviderIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !ALL_SUPPORTED_PROVIDERS.includes(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** Full catalog order: stored order first, then any provider missing from it. */
export function normalizeProviderOrder(order: unknown): string[] {
  const known = normalizeProviderIds(order);
  const missing = ALL_SUPPORTED_PROVIDERS.filter((id) => !known.includes(id));
  return [...known, ...missing];
}

/** Providers the user explicitly added, in the order their tabs should appear. */
export function resolveEnabledProviderIds(
  prefs: Pick<QuotaPreferences, 'enabledProviders' | 'providerOrder'>
): string[] {
  const enabled = new Set(normalizeProviderIds(prefs.enabledProviders));
  if (enabled.size === 0) return [];
  return normalizeProviderOrder(prefs.providerOrder).filter((id) => enabled.has(id));
}
