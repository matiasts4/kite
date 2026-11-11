import { invokeCommand, isTauriEnvironment } from './ipc';

export const HEADROOM_OFFLINE_MESSAGE = 'Headroom no responde.';
const DEFAULT_BASE = 'http://127.0.0.1:8787';

export interface HeadroomLifetime {
  requests: number;
  tokensSaved: number;
  savingsUsd: number;
  cacheReadTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  estimatedUsd: boolean;
}

export interface HeadroomSession {
  requests: number;
  tokensSaved: number;
  savingsUsd: number;
  savingsPercent: number;
  inputTokens: number;
}

export interface HeadroomAgentRow {
  label: string;
  requests: number;
  tokensSaved: number;
  savingsPercent: number;
}

export interface HeadroomModelRow {
  model: string;
  requests: number;
  tokensSaved: number;
  savingsUsd: number;
  savingsPercent: number;
}

export interface HeadroomMonitorView {
  version: string | null;
  uptimeSeconds: number | null;
  mode: string | null;
  lifetime: HeadroomLifetime;
  session: HeadroomSession;
  agents: HeadroomAgentRow[];
  models: HeadroomModelRow[];
  sparkline: number[];
  overheadMs: number | null;
  latencyMs: number | null;
  requestsFailed: number;
  requestsCached: number;
}

export type HeadroomMonitorState =
  | { status: 'online'; view: HeadroomMonitorView }
  | { status: 'offline'; message: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function numOrZero(value: unknown): number {
  return num(value) ?? 0;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function savingsDeltas(history: unknown): number[] {
  if (!Array.isArray(history)) return [];
  const totals = history
    .map((point) => num(asRecord(point)?.total_tokens_saved))
    .filter((value): value is number => value != null);
  const deltas: number[] = [];
  for (let index = 1; index < totals.length; index += 1) {
    deltas.push(Math.max(0, totals[index] - totals[index - 1]));
  }
  return deltas.slice(-24);
}

export function formatTokenCount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const compact = (value / 1_000_000).toLocaleString('es', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${compact} M`;
  }
  return Math.round(value).toLocaleString('es');
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat('es', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatPercent(value: number): string {
  return `${value.toLocaleString('es', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
}

export function formatUptimeMinutes(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}

export function formatMs(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toLocaleString('es', { maximumFractionDigits: 1 })} s`;
  }
  return `${Math.round(value).toLocaleString('es')} ms`;
}

function offline(): HeadroomMonitorState {
  return { status: 'offline', message: HEADROOM_OFFLINE_MESSAGE };
}

export function parseHeadroomEnvelope(payload: unknown): HeadroomMonitorState {
  const envelope = asRecord(payload);
  if (!envelope || envelope.ok !== true) return offline();

  const stats = asRecord(envelope.stats);
  const persistent = asRecord(stats?.persistent_savings);
  const lifetimeRaw = asRecord(persistent?.lifetime);
  if (!stats || !lifetimeRaw) return offline();

  const health = asRecord(envelope.health);
  const summary = asRecord(stats.summary);
  const sessionRaw = asRecord(persistent?.display_session) ?? asRecord(stats.display_session);
  const requests = asRecord(stats.requests);
  const basis = text(lifetimeRaw.savings_basis);

  const agents = Array.isArray(asRecord(stats.agent_usage)?.agents)
    ? (asRecord(stats.agent_usage)?.agents as unknown[])
        .map((row) => {
          const agent = asRecord(row);
          if (!agent) return null;
          const label = text(agent.label) ?? text(agent.agent);
          if (!label) return null;
          return {
            label,
            requests: numOrZero(agent.requests),
            tokensSaved: numOrZero(agent.tokens_saved),
            savingsPercent: numOrZero(agent.savings_percent),
          };
        })
        .filter((row): row is HeadroomAgentRow => row != null)
    : [];

  const models = Object.entries(asRecord(persistent?.by_model) ?? {})
    .map(([model, raw]) => {
      const row = asRecord(raw);
      if (!row) return null;
      return {
        model,
        requests: numOrZero(row.requests),
        tokensSaved: numOrZero(row.tokens_saved ?? row.headline_tokens_saved),
        savingsUsd: numOrZero(row.compression_savings_usd),
        savingsPercent: numOrZero(row.savings_percent),
      };
    })
    .filter((row): row is HeadroomModelRow => row != null)
    .sort((left, right) => right.tokensSaved - left.tokensSaved);

  return {
    status: 'online',
    view: {
      version: text(health?.version),
      uptimeSeconds: num(health?.uptime_seconds),
      mode: text(summary?.mode),
      lifetime: {
        requests: numOrZero(lifetimeRaw.requests),
        tokensSaved: numOrZero(lifetimeRaw.tokens_saved),
        savingsUsd: numOrZero(lifetimeRaw.compression_savings_usd),
        cacheReadTokens: numOrZero(lifetimeRaw.cache_read_tokens),
        inputCostUsd: numOrZero(lifetimeRaw.total_input_cost_usd),
        outputCostUsd: numOrZero(lifetimeRaw.total_output_cost_usd),
        estimatedUsd: basis !== 'measured',
      },
      session: {
        requests: numOrZero(sessionRaw?.requests),
        tokensSaved: numOrZero(sessionRaw?.tokens_saved),
        savingsUsd: numOrZero(sessionRaw?.compression_savings_usd),
        savingsPercent: numOrZero(sessionRaw?.savings_percent),
        inputTokens: numOrZero(sessionRaw?.total_input_tokens),
      },
      agents,
      models,
      sparkline: savingsDeltas(persistent?.recent_history),
      overheadMs: num(asRecord(stats.overhead)?.average_ms),
      latencyMs: num(asRecord(stats.latency)?.average_ms),
      requestsFailed: numOrZero(requests?.failed),
      requestsCached: numOrZero(requests?.cached),
    },
  };
}

async function loadFromLoopback(): Promise<HeadroomMonitorState> {
  try {
    const [healthResponse, statsResponse] = await Promise.all([
      fetch(`${DEFAULT_BASE}/health`),
      fetch(`${DEFAULT_BASE}/stats`),
    ]);
    if (!statsResponse.ok) return offline();
    const stats = await statsResponse.json();
    const health = healthResponse.ok ? await healthResponse.json() : null;
    return parseHeadroomEnvelope({ ok: true, health, stats });
  } catch {
    return offline();
  }
}

export async function loadHeadroomMonitor(): Promise<HeadroomMonitorState> {
  if (isTauriEnvironment()) {
    try {
      const state = parseHeadroomEnvelope(await invokeCommand<unknown>('fetch_headroom_monitor'));
      if (state.status === 'online') return state;
    } catch {
      // The running shell may not expose the command yet.
    }
  }
  return loadFromLoopback();
}
