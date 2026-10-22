// Kite Code — Operator Run Ledger & Observability
// Provides stable runId correlation, timestamps, redaction of secrets,
// bounded terminal output, durable persistence, query filters, and p50/p95 latency aggregation.

import { invokeCommand } from '../ipc';

export type RunLedgerEventType =
  | 'run_start'
  | 'provider_request'
  | 'provider_first_token'
  | 'provider_response'
  | 'tool_emission'
  | 'tool_start'
  | 'tool_end'
  | 'terminal_exec'
  | 'terminal_output'
  | 'run_complete'
  | 'run_timeout'
  | 'run_cancelled';

export interface RunLedgerEvent {
  runId: string;
  seq: number;
  timestamp: number;
  type: RunLedgerEventType;
  payload: Record<string, unknown>;
}

export interface RunToolCall {
  name: string;
  argumentsHash: string;
  arguments?: Record<string, unknown>;
  durationMs?: number;
  exitCode?: number;
  errorCategory?: string;
  ok?: boolean;
}

export interface RunTerminalOutput {
  terminalId?: string;
  excerpt: string;
  exitCode?: number;
}

export interface RunRecord {
  runId: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  input: string;
  provider?: string;
  model?: string;
  reasoningSetting?: string;
  taskType?: string;
  outcome?: 'success' | 'failure' | 'timeout' | 'cancelled';
  errorCategory?: string;
  exitCode?: number;
  tokenCounts?: {
    prompt?: number;
    completion?: number;
    cache?: number;
  };
  timestamps: {
    input?: number;
    providerRequest?: number;
    firstToken?: number;
    toolCallEmission?: number;
    toolStart?: number;
    toolEnd?: number;
    finalResponse?: number;
    terminalExecution?: number;
  };
  toolCalls: RunToolCall[];
  terminalOutputs: RunTerminalOutput[];
  events: RunLedgerEvent[];
  reply?: string;
}

export interface RunLedgerFilter {
  runId?: string;
  provider?: string;
  model?: string;
  taskType?: string;
  outcome?: 'success' | 'failure' | 'timeout' | 'cancelled';
  success?: boolean;
  minLatencyMs?: number;
  maxLatencyMs?: number;
  startDate?: string | number | Date;
  endDate?: string | number | Date;
}

const DEFAULT_STORAGE_KEY = 'kite.operator.run_ledger.v1';
const MAX_STORED_RUNS = 250;
const MAX_TERMINAL_OUTPUT_CHARS = 500;

/**
 * Redacts secrets, API keys, passwords, and authorization tokens.
 */
export function redactSecrets(text: string): string {
  if (!text || typeof text !== 'string') return text;

  let redacted = text;

  // Bearer tokens
  redacted = redacted.replace(/Bearer\s+[A-Za-z0-9_\-\.~+/]+=*/gi, 'Bearer [REDACTED_SECRET]');

  // Common API key patterns (OpenAI, Anthropic, xAI, GitHub, etc.)
  redacted = redacted.replace(/sk-(?:proj-|ant-|admin-)?[a-zA-Z0-9_\-]{16,}/gi, '[REDACTED_SECRET]');
  redacted = redacted.replace(/xai-[a-zA-Z0-9_\-]{16,}/gi, '[REDACTED_SECRET]');
  redacted = redacted.replace(/gh[pousr]_[a-zA-Z0-9]{20,}/gi, '[REDACTED_SECRET]');

  // Generic key/password/secret pairs in JSON or key-value format
  redacted = redacted.replace(
    /("(?:api[_-]?key|password|secret|token|auth)"\s*:\s*")[^"]+(")/gi,
    '$1[REDACTED_SECRET]$2'
  );
  redacted = redacted.replace(
    /('(?:api[_-]?key|password|secret|token|auth)'\s*:\s*')[^']+(')/gi,
    '$1[REDACTED_SECRET]$2'
  );
  redacted = redacted.replace(
    /(?:api[_-]?key|password|secret|auth_token)\s*=\s*['"]?[a-zA-Z0-9_\-\.!@#$%^&*]{8,}['"]?/gi,
    'secret=[REDACTED_SECRET]'
  );

  return redacted;
}

/**
 * Deep redaction for structured objects.
 */
export function redactDeep<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return redactSecrets(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item)) as unknown as T;
  }
  if (typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const lower = k.toLowerCase();
      if (
        lower.includes('secret') ||
        lower.includes('apikey') ||
        lower.includes('api_key') ||
        lower.includes('password') ||
        lower.includes('token')
      ) {
        copy[k] = '[REDACTED_SECRET]';
      } else {
        copy[k] = redactDeep(v);
      }
    }
    return copy as T;
  }
  return value;
}

/**
 * Bounds terminal output to prevent unbounded PTY/log storage.
 */
export function boundTerminalOutput(text: string, maxLen = MAX_TERMINAL_OUTPUT_CHARS): string {
  if (!text || typeof text !== 'string') return text || '';
  if (text.length <= maxLen) return text;
  const truncatedChars = text.length - maxLen;
  return `${text.slice(0, maxLen)}... [TRUNCATED ${truncatedChars} chars]`;
}

/**
 * Produces a stable deterministic hash for tool arguments.
 */
export function hashToolArguments(args: unknown): string {
  if (args === undefined || args === null) return 'none';

  function canonicalStringify(val: unknown): string {
    if (val === null || typeof val !== 'object') {
      return JSON.stringify(val);
    }
    if (Array.isArray(val)) {
      return `[${val.map(canonicalStringify).join(',')}]`;
    }
    const keys = Object.keys(val as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify((val as Record<string, unknown>)[k])}`).join(',')}}`;
  }

  const str = canonicalStringify(args);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(12, '0');
}

/**
 * Calculates accurate percentile value from a numeric list.
 */
export function calculatePercentile(values: number[], percentile: number): number {
  if (!values || values.length === 0) return 0;
  if (values.length === 1) return values[0];

  const sorted = [...values].sort((a, b) => a - b);
  const p = Math.max(0, Math.min(100, percentile));
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  return Math.round(sorted[lower] * (1 - weight) + sorted[upper] * weight);
}

export interface RunLedgerOptions {
  storageKey?: string;
  maxStoredRuns?: number;
}

export class RunLedger {
  private storageKey: string;
  private maxStoredRuns: number;
  private runs = new Map<string, RunRecord>();
  private runOrder: string[] = [];
  private eventSeq = new Map<string, number>();
  private listeners = new Set<(event: RunLedgerEvent) => void>();
  private initialized = false;

  constructor(options: RunLedgerOptions = {}) {
    this.storageKey = options.storageKey || DEFAULT_STORAGE_KEY;
    this.maxStoredRuns = options.maxStoredRuns || MAX_STORED_RUNS;
    this.loadFromStorage();
  }

  private loadFromStorage(): void {
    if (this.initialized || typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && item.runId) {
              this.runs.set(item.runId, item);
              this.runOrder.push(item.runId);
            }
          }
        }
      }
    } catch (e) {
      console.warn('[RunLedger] Error loading persisted history:', e);
    } finally {
      this.initialized = true;
    }
  }

  private persistToStorage(): void {
    if (typeof window === 'undefined') return;
    try {
      const records = this.runOrder
        .map((id) => this.runs.get(id))
        .filter((r): r is RunRecord => Boolean(r));
      localStorage.setItem(this.storageKey, JSON.stringify(records.slice(-this.maxStoredRuns)));
    } catch (e) {
      console.warn('[RunLedger] Error persisting history:', e);
    }
  }

  private appendDurableTrace(event: RunLedgerEvent): void {
    try {
      if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
        invokeCommand('operator_trace_append', { line: JSON.stringify(event) }).catch(() => {});
      }
    } catch {
      // ignore
    }
  }

  private addEvent(runId: string, type: RunLedgerEventType, payload: Record<string, unknown>): RunLedgerEvent {
    const seq = (this.eventSeq.get(runId) || 0) + 1;
    this.eventSeq.set(runId, seq);

    const event: RunLedgerEvent = {
      runId,
      seq,
      timestamp: Date.now(),
      type,
      payload: redactDeep(payload),
    };

    const run = this.runs.get(runId);
    if (run) {
      run.events.push(event);
    }

    this.appendDurableTrace(event);

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[RunLedger] Listener error:', err);
      }
    }

    return event;
  }

  public startRun(
    input: string,
    options: { runId?: string; taskType?: string; metadata?: Record<string, unknown> } = {}
  ): string {
    const runId = options.runId || `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const now = Date.now();
    const redactedInput = redactSecrets(input);

    const record: RunRecord = {
      runId,
      startedAt: now,
      input: redactedInput,
      taskType: options.taskType || 'chat_response',
      timestamps: {
        input: now,
      },
      toolCalls: [],
      terminalOutputs: [],
      events: [],
    };

    this.runs.set(runId, record);
    this.runOrder.push(runId);
    if (this.runOrder.length > this.maxStoredRuns) {
      const oldest = this.runOrder.shift();
      if (oldest) this.runs.delete(oldest);
    }

    this.addEvent(runId, 'run_start', {
      input: redactedInput,
      taskType: options.taskType,
      metadata: options.metadata,
    });

    this.persistToStorage();
    return runId;
  }

  public recordProviderRequest(
    runId: string,
    details: { provider: string; model: string; reasoningSetting?: string }
  ): void {
    const now = Date.now();
    const run = this.runs.get(runId);
    if (run) {
      run.provider = details.provider;
      run.model = details.model;
      run.reasoningSetting = details.reasoningSetting;
      run.timestamps.providerRequest = now;
    }

    this.addEvent(runId, 'provider_request', {
      provider: details.provider,
      model: details.model,
      reasoningSetting: details.reasoningSetting,
    });
  }

  public recordFirstToken(runId: string, timestamp?: number): void {
    const ts = timestamp || Date.now();
    const run = this.runs.get(runId);
    if (run && !run.timestamps.firstToken) {
      run.timestamps.firstToken = ts;
    }

    this.addEvent(runId, 'provider_first_token', { timestamp: ts });
  }

  public recordProviderResponse(
    runId: string,
    details: {
      latencyMs: number;
      tokenCounts?: { prompt?: number; completion?: number; cache?: number };
      rawText?: string;
    }
  ): void {
    const now = Date.now();
    const run = this.runs.get(runId);
    if (run) {
      if (details.tokenCounts) {
        run.tokenCounts = details.tokenCounts;
      }
      run.timestamps.finalResponse = now;
    }

    this.addEvent(runId, 'provider_response', {
      latencyMs: details.latencyMs,
      tokenCounts: details.tokenCounts,
      rawTextTruncated: details.rawText ? boundTerminalOutput(redactSecrets(details.rawText), 400) : undefined,
    });
  }

  public recordToolEmission(
    runId: string,
    details: { name: string; arguments?: Record<string, unknown> | string }
  ): void {
    const now = Date.now();
    const run = this.runs.get(runId);
    const args =
      typeof details.arguments === 'string'
        ? (() => {
            try {
              return JSON.parse(details.arguments);
            } catch {
              return { raw: details.arguments };
            }
          })()
        : details.arguments;

    const hash = hashToolArguments(args);
    const redactedArgs = redactDeep(args);

    if (run) {
      run.timestamps.toolCallEmission = run.timestamps.toolCallEmission || now;
      run.toolCalls.push({
        name: details.name,
        argumentsHash: hash,
        arguments: redactedArgs,
      });
    }

    this.addEvent(runId, 'tool_emission', {
      name: details.name,
      argumentsHash: hash,
      arguments: redactedArgs,
    });
  }

  public recordToolStart(runId: string, details: { name: string; actionIdx?: number }): void {
    const now = Date.now();
    const run = this.runs.get(runId);
    if (run) {
      if (!run.timestamps.toolStart) {
        run.timestamps.toolStart = now;
      }
      let tc = run.toolCalls.find((t) => t.name === details.name && t.ok === undefined);
      if (!tc) {
        tc = {
          name: details.name,
          argumentsHash: hashToolArguments(null),
        };
        run.toolCalls.push(tc);
      }
    }

    this.addEvent(runId, 'tool_start', {
      name: details.name,
      actionIdx: details.actionIdx,
    });
  }

  public recordToolEnd(
    runId: string,
    details: {
      name: string;
      ok: boolean;
      durationMs?: number;
      exitCode?: number;
      errorCategory?: string;
      error?: string;
    }
  ): void {
    const now = Date.now();
    const run = this.runs.get(runId);
    if (run) {
      run.timestamps.toolEnd = now;
      const tc = run.toolCalls.find((t) => t.name === details.name && t.ok === undefined);
      if (tc) {
        tc.ok = details.ok;
        tc.durationMs = details.durationMs;
        tc.exitCode = details.exitCode;
        tc.errorCategory = details.errorCategory;
      }
    }

    this.addEvent(runId, 'tool_end', {
      name: details.name,
      ok: details.ok,
      durationMs: details.durationMs,
      exitCode: details.exitCode,
      errorCategory: details.errorCategory,
      error: details.error ? redactSecrets(details.error) : undefined,
    });
  }

  public recordTerminalExec(
    runId: string,
    details: { terminalId?: string; command?: string; exitCode?: number }
  ): void {
    const now = Date.now();
    const run = this.runs.get(runId);
    if (run) {
      run.timestamps.terminalExecution = now;
      if (details.exitCode !== undefined) {
        run.exitCode = details.exitCode;
      }
    }

    this.addEvent(runId, 'terminal_exec', {
      terminalId: details.terminalId,
      command: details.command ? redactSecrets(details.command) : undefined,
      exitCode: details.exitCode,
    });
  }

  public recordTerminalOutput(
    runId: string,
    details: { terminalId?: string; output: string; exitCode?: number }
  ): void {
    const redactedBounded = boundTerminalOutput(redactSecrets(details.output));
    const run = this.runs.get(runId);
    if (run) {
      run.terminalOutputs.push({
        terminalId: details.terminalId,
        excerpt: redactedBounded,
        exitCode: details.exitCode,
      });
      if (details.exitCode !== undefined) {
        run.exitCode = details.exitCode;
      }
    }

    this.addEvent(runId, 'terminal_output', {
      terminalId: details.terminalId,
      excerpt: redactedBounded,
      exitCode: details.exitCode,
    });
  }

  public recordTimeout(
    runId: string,
    details: { errorCategory?: string; message?: string } = {}
  ): void {
    const now = Date.now();
    const run = this.runs.get(runId);
    if (run) {
      run.outcome = 'timeout';
      run.errorCategory = details.errorCategory || 'gateway_timeout';
      run.completedAt = now;
      run.durationMs = now - run.startedAt;
    }

    this.addEvent(runId, 'run_timeout', {
      errorCategory: details.errorCategory || 'gateway_timeout',
      message: details.message ? redactSecrets(details.message) : undefined,
    });

    this.persistToStorage();
  }

  public recordCancellation(
    runId: string,
    details: { reason?: string } = {}
  ): void {
    const now = Date.now();
    const run = this.runs.get(runId);
    if (run) {
      run.outcome = 'cancelled';
      run.errorCategory = 'user_cancelled';
      run.completedAt = now;
      run.durationMs = now - run.startedAt;
    }

    this.addEvent(runId, 'run_cancelled', {
      reason: details.reason ? redactSecrets(details.reason) : undefined,
    });

    this.persistToStorage();
  }

  public completeRun(
    runId: string,
    details: {
      reply?: string;
      outcome?: 'success' | 'failure' | 'timeout' | 'cancelled';
      errorCategory?: string;
    } = {}
  ): RunRecord | undefined {
    const now = Date.now();
    const run = this.runs.get(runId);
    if (!run) return undefined;

    const redactedReply = details.reply ? redactSecrets(details.reply) : undefined;
    run.completedAt = now;
    run.durationMs = now - run.startedAt;
    run.outcome = details.outcome || (run.outcome ?? 'success');
    if (details.errorCategory) {
      run.errorCategory = details.errorCategory;
    }
    if (redactedReply) {
      run.reply = redactedReply;
      run.timestamps.finalResponse = run.timestamps.finalResponse || now;
    }

    this.addEvent(runId, 'run_complete', {
      outcome: run.outcome,
      durationMs: run.durationMs,
      reply: redactedReply,
      errorCategory: run.errorCategory,
    });

    this.persistToStorage();
    return run;
  }

  public getRun(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  public getRuns(filter: RunLedgerFilter = {}): RunRecord[] {
    let result = this.runOrder
      .map((id) => this.runs.get(id))
      .filter((r): r is RunRecord => Boolean(r));

    if (filter.runId) {
      const q = filter.runId.toLowerCase();
      result = result.filter((r) => r.runId.toLowerCase().includes(q));
    }

    if (filter.provider) {
      const p = filter.provider.toLowerCase();
      result = result.filter((r) => r.provider && r.provider.toLowerCase().includes(p));
    }

    if (filter.model) {
      const m = filter.model.toLowerCase();
      result = result.filter((r) => r.model && r.model.toLowerCase().includes(m));
    }

    if (filter.taskType) {
      const tt = filter.taskType.toLowerCase();
      result = result.filter((r) => r.taskType && r.taskType.toLowerCase().includes(tt));
    }

    if (filter.outcome) {
      result = result.filter((r) => r.outcome === filter.outcome);
    }

    if (filter.success !== undefined) {
      result = result.filter((r) => (filter.success ? r.outcome === 'success' : r.outcome !== 'success'));
    }

    if (filter.minLatencyMs !== undefined) {
      result = result.filter((r) => (r.durationMs || 0) >= filter.minLatencyMs!);
    }

    if (filter.maxLatencyMs !== undefined) {
      result = result.filter((r) => (r.durationMs || 0) <= filter.maxLatencyMs!);
    }

    if (filter.startDate !== undefined) {
      const startMs = new Date(filter.startDate).getTime();
      result = result.filter((r) => r.startedAt >= startMs);
    }

    if (filter.endDate !== undefined) {
      const endMs = new Date(filter.endDate).getTime();
      result = result.filter((r) => r.startedAt <= endMs);
    }

    return result;
  }

  public getLatencyPercentiles(
    source?: RunLedgerFilter | RunRecord[]
  ): { p50: number; p95: number; count: number; avg: number; min: number; max: number } {
    const list = Array.isArray(source) ? source : this.getRuns(source);
    const latencies = list.map((r) => r.durationMs || 0).filter((ms) => ms > 0);

    if (latencies.length === 0) {
      return { p50: 0, p95: 0, count: 0, avg: 0, min: 0, max: 0 };
    }

    const count = latencies.length;
    const sum = latencies.reduce((acc, v) => acc + v, 0);
    const avg = Math.round(sum / count);
    const min = Math.min(...latencies);
    const max = Math.max(...latencies);
    const p50 = calculatePercentile(latencies, 50);
    const p95 = calculatePercentile(latencies, 95);

    return { p50, p95, count, avg, min, max };
  }

  public clearHistory(): void {
    this.runs.clear();
    this.runOrder = [];
    this.eventSeq.clear();
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(this.storageKey, '[]');
      } catch {
        // ignore
      }
    }
  }

  public exportHistory(format: 'json' | 'jsonl' = 'json'): string {
    const records = this.runOrder
      .map((id) => this.runs.get(id))
      .filter((r): r is RunRecord => Boolean(r));

    if (format === 'jsonl') {
      return records.map((r) => JSON.stringify(r)).join('\n');
    }
    return JSON.stringify(records, null, 2);
  }

  public subscribe(listener: (event: RunLedgerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const runLedger = new RunLedger();
