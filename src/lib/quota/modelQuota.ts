import { type ProviderQuotaStatus, type QuotaWindow, PROVIDERS } from './types';

const EFFORT_SUFFIX_RE = /-(?:xhigh|high|medium|low|max|minimal|ultra|fast)$/i;
const STOP_TOKENS = new Set([
  'model',
  'models',
  'limit',
  'weekly',
  'five',
  'hour',
  '5h',
  '7d',
  'remaining',
  'credits',
  'credit',
  'quota',
  'usage',
  'window',
  'session',
  'thinking',
  'high',
  'medium',
  'low',
  'and',
  'or',
  'for',
  'the',
]);

export function canonicalQuotaProviderId(provider: string | null | undefined): string {
  const norm = (provider || '').trim().toLowerCase();
  if (norm === 'agy') return PROVIDERS.ANTIGRAVITY;
  if (norm === 'claude-code') return PROVIDERS.CLAUDE;
  if (norm === 'open-code') return PROVIDERS.OPENCODE;
  return norm;
}

export function isWindowExhausted(win: QuotaWindow | null | undefined): boolean {
  if (!win) return false;
  return Boolean(win.isExhausted || win.remainingFraction <= 0 || win.usagePercent >= 100);
}

export function getWindowRemainingPercent(win: QuotaWindow): number {
  const pct = Math.round((win.remainingFraction ?? 0) * 100);
  return Math.max(0, Math.min(100, pct));
}

export function isWindowLow(win: QuotaWindow | null | undefined, thresholdPercent = 10): boolean {
  if (!win || isWindowExhausted(win)) return false;
  return getWindowRemainingPercent(win) <= thresholdPercent;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((tok) => tok.length > 0 && !STOP_TOKENS.has(tok));
}

function normalizeModelBase(modelId: string): string {
  let base = modelId.trim();
  while (EFFORT_SUFFIX_RE.test(base)) {
    base = base.replace(EFFORT_SUFFIX_RE, '');
  }
  return base;
}

function modelFamilyOf(tokens: string[]): 'gemini' | 'claude_gpt' | null {
  if (tokens.includes('gemini')) return 'gemini';
  if (
    tokens.includes('claude') ||
    tokens.includes('gpt') ||
    tokens.includes('openai') ||
    tokens.some((t) => /^o[134]$/.test(t))
  ) {
    return 'claude_gpt';
  }
  return null;
}

function windowFamilyOf(windowName: string): 'gemini' | 'claude_gpt' | null {
  const lower = windowName.toLowerCase();
  if (lower.includes('gemini')) return 'gemini';
  if (lower.includes('claude') || lower.includes('gpt')) return 'claude_gpt';
  return null;
}

function pickMostConstrainedWindow(windows: QuotaWindow[]): QuotaWindow | null {
  if (windows.length === 0) return null;
  let best = windows[0]!;
  for (let i = 1; i < windows.length; i += 1) {
    const candidate = windows[i]!;
    const candExhausted = isWindowExhausted(candidate);
    const bestExhausted = isWindowExhausted(best);
    if (candExhausted !== bestExhausted) {
      if (candExhausted) best = candidate;
      continue;
    }
    if (candidate.remainingFraction < best.remainingFraction) {
      best = candidate;
    }
  }
  return best;
}

export function resolveModelQuotaWindow(
  providerId: string | null | undefined,
  modelId: string | null | undefined,
  status: ProviderQuotaStatus | null | undefined,
  modelLabel?: string | null
): QuotaWindow | null {
  const cleanModel = (modelId || '').trim();
  if (!cleanModel || cleanModel === 'automatic' || !status || !status.isAvailable) {
    return null;
  }

  const windows = status.windows ?? [];
  if (windows.length === 0) {
    if (status.primaryRemainingPercent <= 0) {
      return {
        name: status.displayName || canonicalQuotaProviderId(providerId) || 'Quota',
        usagePercent: 100,
        remainingFraction: 0,
        resetsAt: status.primaryResetAt,
        timeUntilResetMs: status.timeUntilResetMs,
        isExhausted: true,
      };
    }
    return null;
  }

  const baseModel = normalizeModelBase(cleanModel);
  const modelTokens = new Set([
    ...tokenize(baseModel),
    ...(modelLabel ? tokenize(modelLabel) : []),
  ]);

  // Pass 1: Specific dedicated model/variant windows (e.g., "Gemini 4 Argon (...)", "Gemini 3.8 Flash")
  const specificMatches: QuotaWindow[] = [];
  for (const win of windows) {
    const lower = win.name.toLowerCase();
    if (lower.includes('models')) continue;
    const head = win.name.split('(')[0] ?? win.name;
    const winDistinctive = tokenize(head).filter(
      (tok) => tok !== 'gemini' && tok !== 'claude' && tok !== 'gpt'
    );
    if (
      winDistinctive.length > 0 &&
      winDistinctive.every((tok) => modelTokens.has(tok))
    ) {
      specificMatches.push(win);
    }
  }
  if (specificMatches.length > 0) {
    return pickMostConstrainedWindow(specificMatches);
  }

  // Pass 2: Shared family pool windows (e.g., "Gemini Models", "Claude and GPT models")
  const modelFamily = modelFamilyOf(Array.from(modelTokens));
  if (modelFamily) {
    const poolMatches = windows.filter((win) => {
      const lower = win.name.toLowerCase();
      if (!lower.includes('models')) return false;
      return windowFamilyOf(win.name) === modelFamily;
    });
    if (poolMatches.length > 0) {
      return pickMostConstrainedWindow(poolMatches);
    }
  }

  // Pass 3: Generic provider-wide windows without conflicting family tags
  const genericMatches = windows.filter((win) => {
    const winFamily = windowFamilyOf(win.name);
    if (!winFamily) return true;
    return modelFamily !== null && winFamily === modelFamily;
  });
  return pickMostConstrainedWindow(genericMatches);
}

export interface ExhaustedModelWindow {
  providerId: string;
  displayName: string;
  window: QuotaWindow;
}

export function collectExhaustedModelWindows(
  quotas: Record<string, ProviderQuotaStatus>
): ExhaustedModelWindow[] {
  const hits: ExhaustedModelWindow[] = [];
  for (const status of Object.values(quotas)) {
    if (!status?.isAvailable || !status.isAuth) continue;
    for (const win of status.windows ?? []) {
      if (isWindowExhausted(win)) {
        hits.push({
          providerId: status.providerId,
          displayName: status.displayName || status.providerId,
          window: win,
        });
      }
    }
  }
  return hits;
}
