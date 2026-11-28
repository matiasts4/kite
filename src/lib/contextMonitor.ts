import { invokeCommand, isTauriEnvironment } from './ipc';
import {
  formatMs,
  formatPercent,
  formatTokenCount,
  formatUsd,
} from './headroomMonitor';

export { formatMs, formatPercent, formatTokenCount, formatUsd };

export const CONTEXT_OFFLINE_MESSAGE = 'El motor de contexto aún no registra actividad.';

export interface ContextTotals {
  requests: number;
  rawTokens: number;
  compressedTokens: number;
  tokensSaved: number;
  savingsPercent: number;
  cacheHits: number;
  cacheHitRate: number;
  estimatedUsdSaved: number;
  grossTokensSaved: number;
  ccrRetrievedTokens: number;
  ccrRetrieveCalls: number;
}

export interface ContextAgentRow {
  agent: string;
  requests: number;
  tokensSaved: number;
  savingsPercent: number;
  cacheHits: number;
}

export interface ContextModelRow {
  model: string;
  requests: number;
  tokensSaved: number;
  savingsUsd: number;
  savingsPercent: number;
}

export interface ContextCategoryRow {
  category: string;
  requests: number;
  tokensSaved: number;
  savingsPercent: number;
}

export interface ContextFeatureRow {
  feature: string;
  category: string;
  requests: number;
  rawTokens: number;
  compressedTokens: number;
  tokensSaved: number;
  savingsPercent: number;
  cacheHits: number;
  avgOverheadMs: number;
}

export interface QuotaPreservationView {
  savedTokens30d: number;
  proEquivalentPct: number;
  tier5xPct: number;
  tier20xPct: number;
}

export interface ContextDiscoverCandidate {
  command: string;
  count: number;
  estimatedMissedTokens: number;
}

export interface ContextDiscoveryView {
  scannedCommands: number;
  alreadyOptimized: number;
  missedCommands: number;
  estimatedMissedTokens: number;
  topCandidates: ContextDiscoverCandidate[];
}

export interface ContextAuditFinding {
  kind: string;
  agent: string;
  path: string;
  label: string;
  wastedTokens: number;
  fixable: boolean;
  detail: string;
}

export interface ContextPromptAuditView {
  totalFiles: number;
  totalTokens: number;
  wastedTokens: number;
  duplicateBlocks: number;
  staleBlocks: number;
  oversizedFiles: number;
  findings: ContextAuditFinding[];
}

export interface ContextMonitorView {
  engineVersion: string | null;
  activeSessionId: string | null;
  lifetime: ContextTotals;
  session: ContextTotals;
  agents: ContextAgentRow[];
  models: ContextModelRow[];
  categories: ContextCategoryRow[];
  features: ContextFeatureRow[];
  discovery: ContextDiscoveryView;
  audit: ContextPromptAuditView;
  sparkline: number[];
  avgOverheadMs: number;
  ccrEntries: number;
  ccrRetrieveCalls: number;
  ccrRetrieveTokens: number;
  sharedEntries: number;
  readRecords: number;
  kvSessions: number;
  kvPrefixHits: number;
  toolCacheEntries: number;
  quotaPreservation: QuotaPreservationView;
}

export function formatContextCategoryLabel(category: string): string {
  switch (category.trim()) {
    case 'read':
      return 'Lectura';
    case 'exec':
    case 'cmd':
      return 'Comandos CLI';
    case 'compress':
      return 'Compresión';
    case 'share':
      return 'Handoffs compartidos';
    case 'ccr':
      return 'Recuperación CCR';
    case 'mcp':
      return 'Respuestas MCP';
    case 'runtime':
      return 'Runtime in-process';
    case 'browser':
      return 'Navegador';
    default:
      return category;
  }
}

export function formatContextFeatureLabel(feature: string): string {
  const f = feature.trim();
  if (f === 'read:dedup' || f === 'read:stub') return 'Lectura · Deduplicación (caché)';
  if (f === 'read:signatures') return 'Lectura · Firmas (signatures)';
  if (f === 'read:map') return 'Lectura · Mapa estructural';
  if (f === 'read:diff') return 'Lectura · Delta diff';
  if (f === 'read:lines' || f.startsWith('read:lines:')) return 'Lectura · Rango de líneas';
  if (f === 'read:auto') return 'Lectura · Auto';
  if (f === 'read:full') return 'Lectura · Completa';
  if (f === 'stage1_tabular') return 'Compresor JSON · Tabular + Diccionario';
  if (f === 'stage2_crushed') return 'Compresor JSON · Anclas + CCR';
  if (f === 'exec:json_crusher') return 'Compresor JSON · CLI';
  if (f.startsWith('cache:')) return `Caché de comandos · ${f.slice('cache:'.length)}`;
  if (f.startsWith('lossless:')) return `Compresión lossless · ${f.slice('lossless:'.length)}`;
  if (f === 'share:put') return 'Handoff compartido · Escritura';
  if (f === 'share:get') return 'Handoff compartido · Lectura';
  if (f === 'share:get_full') return 'Handoff compartido · Completo';
  if (f === 'ccr:retrieve') return 'Recuperación selectiva (CCR)';
  if (f === 'runtime:thread_history') return 'Runtime · Historial de hilo';
  if (f === 'runtime:subagent_handoff') return 'Runtime · Handoff de subagente';
  if (f.startsWith('runtime:')) return `Runtime · ${f.slice('runtime:'.length)}`;
  if (f === 'browser:snapshot_stub') return 'Browser · Snapshot sin cambios (caché)';
  if (f === 'browser:ax_diff') return 'Browser · Delta AX semántico';
  if (f === 'browser:chrome_strip') return 'Browser · Chrome por origen';
  if (f === 'browser:network_crush') return 'Browser · Red y consola comprimidas';
  if (f === 'browser:screenshot_dedup') return 'Browser · Deduplicación de capturas';
  if (f === 'browser:recipe_replay') return 'Browser · Replay determinístico (0 tokens)';
  if (f.startsWith('browser:')) return `Browser · ${f.slice('browser:'.length)}`;
  if (f.startsWith('mcp:')) return `Proxy MCP · ${f.slice('mcp:'.length)}`;
  if (f.startsWith('exec:')) return `Filtro CLI · ${f.slice('exec:'.length)}`;
  return f;
}

export type ContextMonitorState =
  | { status: 'online'; view: ContextMonitorView }
  | { status: 'offline'; message: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function parseTotals(raw: Record<string, unknown> | null): ContextTotals {
  const tokensSaved = num(raw?.tokens_saved);
  return {
    requests: num(raw?.requests),
    rawTokens: num(raw?.raw_tokens),
    compressedTokens: num(raw?.compressed_tokens),
    tokensSaved,
    savingsPercent: num(raw?.savings_percent),
    cacheHits: num(raw?.cache_hits),
    cacheHitRate: num(raw?.cache_hit_rate),
    estimatedUsdSaved: num(raw?.estimated_usd_saved),
    grossTokensSaved:
      raw?.gross_tokens_saved !== undefined && raw?.gross_tokens_saved !== null
        ? num(raw.gross_tokens_saved, tokensSaved)
        : tokensSaved,
    ccrRetrievedTokens: num(raw?.ccr_retrieved_tokens),
    ccrRetrieveCalls: num(raw?.ccr_retrieve_calls),
  };
}

export function parseContextMonitorEnvelope(payload: unknown): ContextMonitorState {
  const root = asRecord(payload);
  if (!root || root.ok !== true) {
    return { status: 'offline', message: CONTEXT_OFFLINE_MESSAGE };
  }

  const lifetime = parseTotals(asRecord(root.lifetime));
  const session = parseTotals(asRecord(root.session));

  const agents = Array.isArray(root.agents)
    ? root.agents
        .map((item) => {
          const row = asRecord(item);
          const agent = text(row?.agent);
          if (!row || !agent) return null;
          return {
            agent,
            requests: num(row.requests),
            tokensSaved: num(row.tokens_saved),
            savingsPercent: num(row.savings_percent),
            cacheHits: num(row.cache_hits),
          };
        })
        .filter((r): r is ContextAgentRow => r != null)
    : [];

  const models = Array.isArray(root.models)
    ? root.models
        .map((item) => {
          const row = asRecord(item);
          const model = text(row?.model);
          if (!row || !model) return null;
          return {
            model,
            requests: num(row.requests),
            tokensSaved: num(row.tokens_saved),
            savingsUsd: num(row.savings_usd),
            savingsPercent: num(row.savings_percent),
          };
        })
        .filter((r): r is ContextModelRow => r != null)
    : [];

  const categories = Array.isArray(root.categories)
    ? root.categories
        .map((item) => {
          const row = asRecord(item);
          const category = text(row?.category);
          if (!row || !category) return null;
          return {
            category,
            requests: num(row.requests),
            tokensSaved: num(row.tokens_saved),
            savingsPercent: num(row.savings_percent),
          };
        })
        .filter((r): r is ContextCategoryRow => r != null)
    : [];

  const features = Array.isArray(root.features)
    ? root.features
        .map((item) => {
          const row = asRecord(item);
          const feature = text(row?.feature);
          if (!row || !feature) return null;
          return {
            feature,
            category: text(row.category) ?? 'other',
            requests: num(row.requests),
            rawTokens: num(row.raw_tokens),
            compressedTokens: num(row.compressed_tokens),
            tokensSaved: num(row.tokens_saved),
            savingsPercent: num(row.savings_percent),
            cacheHits: num(row.cache_hits),
            avgOverheadMs: num(row.avg_overhead_ms),
          };
        })
        .filter((r): r is ContextFeatureRow => r != null)
    : [];

  const sparkline = Array.isArray(root.recent_sparkline)
    ? root.recent_sparkline
        .map((v) => num(v, -1))
        .filter((v) => v >= 0)
    : [];

  const quotaRaw = asRecord(root.quota_preservation);
  const discoveryRaw = asRecord(root.discovery);
  const topCandidates = Array.isArray(discoveryRaw?.top_candidates)
    ? discoveryRaw.top_candidates
        .map((item) => {
          const row = asRecord(item);
          const command = text(row?.command);
          if (!row || !command) return null;
          return {
            command,
            count: num(row.count),
            estimatedMissedTokens: num(row.estimated_missed_tokens),
          };
        })
        .filter((r): r is ContextDiscoverCandidate => r != null)
    : [];

  const auditRaw = asRecord(root.audit);
  const auditFindings = Array.isArray(auditRaw?.findings)
    ? auditRaw.findings
        .map((item) => {
          const row = asRecord(item);
          const kind = text(row?.kind);
          if (!row || !kind) return null;
          return {
            kind,
            agent: text(row.agent) ?? 'host',
            path: text(row.path) ?? '',
            label: text(row.label) ?? kind,
            wastedTokens: num(row.wasted_tokens),
            fixable: bool(row.fixable),
            detail: text(row.detail) ?? '',
          };
        })
        .filter((r): r is ContextAuditFinding => r != null)
    : [];

  const ccrRetrieveCalls = num(root.ccr_retrieve_calls, lifetime.ccrRetrieveCalls);
  const ccrRetrieveTokens = num(root.ccr_retrieve_tokens, lifetime.ccrRetrievedTokens);

  return {
    status: 'online',
    view: {
      engineVersion: text(root.engine_version),
      activeSessionId: text(root.active_session_id),
      lifetime,
      session,
      agents,
      models,
      categories,
      features,
      discovery: {
        scannedCommands: num(discoveryRaw?.scanned_commands),
        alreadyOptimized: num(discoveryRaw?.already_optimized),
        missedCommands: num(discoveryRaw?.missed_commands),
        estimatedMissedTokens: num(discoveryRaw?.estimated_missed_tokens),
        topCandidates,
      },
      audit: {
        totalFiles: num(auditRaw?.total_files),
        totalTokens: num(auditRaw?.total_tokens),
        wastedTokens: num(auditRaw?.wasted_tokens),
        duplicateBlocks: num(auditRaw?.duplicate_blocks),
        staleBlocks: num(auditRaw?.stale_blocks),
        oversizedFiles: num(auditRaw?.oversized_files),
        findings: auditFindings,
      },
      sparkline,
      avgOverheadMs: num(root.avg_overhead_ms),
      ccrEntries: num(root.ccr_entries),
      ccrRetrieveCalls,
      ccrRetrieveTokens,
      sharedEntries: num(root.shared_entries),
      readRecords: num(root.read_records),
      kvSessions: num(root.kv_sessions),
      kvPrefixHits: num(root.kv_prefix_hits),
      toolCacheEntries: num(root.tool_cache_entries),
      quotaPreservation: {
        savedTokens30d: num(quotaRaw?.saved_tokens_30d),
        proEquivalentPct: num(quotaRaw?.pro_equivalent_pct),
        tier5xPct: num(quotaRaw?.tier_5x_pct),
        tier20xPct: num(quotaRaw?.tier_20x_pct),
      },
    },
  };
}

export async function loadContextMonitor(): Promise<ContextMonitorState> {
  if (!isTauriEnvironment()) {
    return { status: 'offline', message: CONTEXT_OFFLINE_MESSAGE };
  }
  try {
    const raw = await invokeCommand<unknown>('fetch_context_monitor');
    return parseContextMonitorEnvelope(raw);
  } catch {
    return { status: 'offline', message: CONTEXT_OFFLINE_MESSAGE };
  }
}

export async function refreshContextMonitor(): Promise<ContextMonitorState> {
  if (!isTauriEnvironment()) {
    return { status: 'offline', message: CONTEXT_OFFLINE_MESSAGE };
  }
  try {
    const raw = await invokeCommand<unknown>('refresh_context_monitor');
    return parseContextMonitorEnvelope(raw);
  } catch {
    return { status: 'offline', message: CONTEXT_OFFLINE_MESSAGE };
  }
}

export async function resetContextMonitorStats(): Promise<boolean> {
  if (!isTauriEnvironment()) return false;
  try {
    const res = asRecord(await invokeCommand<unknown>('reset_context_monitor'));
    return res?.ok === true;
  } catch {
    return false;
  }
}
