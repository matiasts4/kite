import type {
  LatencyRecord,
  OperatorProviderId,
  OperatorProviderConfig,
  ProviderLatencySummary,
  TaskLatencySummaryRow,
  OperatorTaskType,
} from './types';
import { loadOperatorConfig } from './storage';

const LATENCY_STORAGE_KEY = 'kite.operator.latencyRecords.v2';
const MAX_LATENCY_RECORDS = 150;

export function loadLatencyRecords(): LatencyRecord[] {
  try {
    const raw = localStorage.getItem(LATENCY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const getLatencyHistory = loadLatencyRecords;

export function saveLatencyRecords(records: LatencyRecord[]): void {
  try {
    localStorage.setItem(LATENCY_STORAGE_KEY, JSON.stringify(records.slice(0, MAX_LATENCY_RECORDS)));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kite:operator-latency-updated'));
    }
  } catch {
    // ignore storage errors
  }
}

export function recordOperatorLatency(entry: Omit<LatencyRecord, 'id' | 'timestamp'>): LatencyRecord {
  const fullRecord: LatencyRecord = {
    ...entry,
    id: `lat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
  };
  try {
    const existing = loadLatencyRecords();
    const updated = [fullRecord, ...existing].slice(0, MAX_LATENCY_RECORDS);
    localStorage.setItem(LATENCY_STORAGE_KEY, JSON.stringify(updated));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kite:operator-latency-updated', { detail: fullRecord }));
    }
  } catch {
    // ignore storage errors
  }
  return fullRecord;
}

export function recordProviderLatency(input: {
  providerId: OperatorProviderId;
  taskType: string;
  latencyMs: number;
  ok: boolean;
  modelLabel?: string;
}): LatencyRecord {
  const config = loadOperatorConfig();
  return recordOperatorLatency({
    provider: input.providerId,
    model: input.modelLabel || getActiveModelForProvider(config, input.providerId),
    taskType: input.taskType,
    latencyMs: input.latencyMs,
    success: input.ok,
  });
}

export function recordLatencyMetric(input: {
  provider: OperatorProviderId;
  model: string;
  command?: string;
  taskType?: OperatorTaskType | string;
  latencyMs: number;
  success: boolean;
  error?: string;
}): LatencyRecord {
  return recordOperatorLatency({
    provider: input.provider,
    model: input.model,
    taskType: input.taskType || 'chat_response',
    latencyMs: input.latencyMs,
    success: input.success,
    notes: input.error || input.command,
  });
}

export function clearLatencyRecords(): void {
  try {
    localStorage.removeItem(LATENCY_STORAGE_KEY);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kite:operator-latency-updated'));
    }
  } catch {
    // ignore
  }
}

export const clearLatencyHistory = clearLatencyRecords;

export function getActiveModelForProvider(
  config: OperatorProviderConfig,
  provider: OperatorProviderId = config.activeProvider
): string {
  switch (provider) {
    case 'opencode':
      return config.opencodeModel || 'deepseek-v4.1-flash';
    case 'vercel':
      return config.vercelModel || 'deepseek/deepseek-chat';
    case 'cloudflare':
      return config.cloudflareModel || '@cf/meta/llama-3.1-8b-instruct-fp8';
    case 'antigravity':
      return config.antigravityModel || 'gemini-3.8-flash';
    case 'grok':
      return config.grokModel || 'grok-4.7';
    case 'local':
      return 'local-heuristic-v1';
  }
}

export function computeLatencySummaries(
  records: LatencyRecord[] = loadLatencyRecords()
): TaskLatencySummaryRow[] {
  const groups = new Map<string, LatencyRecord[]>();

  for (const r of records) {
    const key = `${r.provider}::${r.taskType}`;
    const list = groups.get(key);
    if (list) {
      list.push(r);
    } else {
      groups.set(key, [r]);
    }
  }

  const rows: TaskLatencySummaryRow[] = [];
  for (const [, list] of groups.entries()) {
    const first = list[0];
    const latencies = list.map((item) => item.latencyMs);
    const sum = latencies.reduce((acc, v) => acc + v, 0);
    const okCount = list.filter((item) => item.success).length;
    rows.push({
      providerId: first.provider,
      taskType: String(first.taskType),
      count: list.length,
      lastMs: Math.round(first.latencyMs),
      avgMs: Math.round(sum / list.length),
      minMs: Math.round(Math.min(...latencies)),
      maxMs: Math.round(Math.max(...latencies)),
      successRate: okCount / list.length,
    });
  }

  return rows;
}

export function getProviderLatencyStats(
  config: OperatorProviderConfig = loadOperatorConfig()
): Record<OperatorProviderId, ProviderLatencySummary> {
  const records = loadLatencyRecords();
  const providers: OperatorProviderId[] = ['opencode', 'vercel', 'cloudflare', 'antigravity', 'grok', 'local'];

  const result = {} as Record<OperatorProviderId, ProviderLatencySummary>;

  for (const provider of providers) {
    const providerRecords = records.filter((r) => r.provider === provider);
    const successful = providerRecords.filter((r) => r.success);

    if (providerRecords.length === 0) {
      result[provider] = {
        provider,
        model: getActiveModelForProvider(config, provider),
        sampleCount: 0,
        avgMs: 0,
        minMs: 0,
        maxMs: 0,
        lastMs: 0,
        successRate: 100,
        byTask: {},
      };
      continue;
    }

    const latencies = providerRecords.map((r) => r.latencyMs);
    const sum = latencies.reduce((acc, v) => acc + v, 0);
    const avgMs = Math.round(sum / latencies.length);
    const minMs = Math.round(Math.min(...latencies));
    const maxMs = Math.round(Math.max(...latencies));
    const lastMs = Math.round(providerRecords[0].latencyMs);
    const successRate = Math.round((successful.length / providerRecords.length) * 100);

    const byTask: ProviderLatencySummary['byTask'] = {};
    for (const rec of providerRecords) {
      const taskKey = String(rec.taskType);
      const prev = byTask[taskKey];
      if (!prev) {
        byTask[taskKey] = {
          count: 1,
          avgMs: Math.round(rec.latencyMs),
          lastMs: Math.round(rec.latencyMs),
        };
      } else {
        const nextCount = prev.count + 1;
        byTask[taskKey] = {
          count: nextCount,
          avgMs: Math.round((prev.avgMs * prev.count + rec.latencyMs) / nextCount),
          lastMs: prev.lastMs,
        };
      }
    }

    result[provider] = {
      provider,
      model: providerRecords[0].model || getActiveModelForProvider(config, provider),
      sampleCount: providerRecords.length,
      avgMs,
      minMs,
      maxMs,
      lastMs,
      successRate,
      byTask,
    };
  }

  return result;
}
