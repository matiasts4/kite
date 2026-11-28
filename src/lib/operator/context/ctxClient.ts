// Kite Code — `kite-ctx` TypeScript Client
// Wraps Tauri IPC commands (`ctx_pack_voice_context`, `ctx_kv_plan`, `ctx_share_put`,
// `ctx_share_get`, `ctx_ccr_retrieve`, `ctx_read_compact`) with safe in-memory fallbacks
// for browser/Vitest environments.

import * as ipc from '../../ipc';

function hasTauriRuntime(): boolean {
  try {
    return typeof ipc.isTauriEnvironment === 'function' && ipc.isTauriEnvironment();
  } catch {
    return (
      typeof window !== 'undefined' &&
      Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)
    );
  }
}

export interface VoiceContextPackInput {
  workspaceId?: string;
  workspaceName?: string;
  workspacePath?: string;
  gitBranch?: string;
  mode?: string;
  boundThreadId?: string;
  voiceSessionActive?: boolean;
  terminalsSummary?: string;
  threadsSummary?: string;
  subagentsSummary?: string;
  agentsSummary?: string;
  workingContextSummary?: string;
  draftProposalSummary?: string;
  maxTokens?: number;
}

export interface VoiceContextPackResult {
  packedText: string;
  estimatedTokens: number;
  source: 'tauri' | 'fallback';
}

export interface KvPlanInput {
  staticPrefix: string;
  dynamicTail: string;
}

export interface KvPlanResult {
  stablePrefix: string;
  dynamicTail: string;
  prefixHash: string;
  volatileTokensScrubbed: number;
  source: 'tauri' | 'fallback';
}

export interface CtxShareEntry {
  key: string;
  value: string;
  updatedAt: number;
  ttlMs?: number;
}

export interface CtxReadCompactOptions {
  mode?: 'signatures' | 'map' | 'lines' | 'full';
  startLine?: number;
  endLine?: number;
  workspaceId?: string;
}

export interface CtxReadCompactResult {
  path: string;
  mode: string;
  content: string;
  source: 'tauri' | 'fallback';
}

const DEFAULT_VOICE_MAX_TOKENS = 240;
const APPROX_CHARS_PER_TOKEN = 4;
const VOLATILE_TIMESTAMP_RE = /\b(?:hace\s+\d+\s*[smhd]|(?:\d+\s*[smhd]\s+ago))\b/gi;

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function compressVoiceLines(lines: string[], maxTokens: number): string {
  const maxChars = Math.max(160, maxTokens * APPROX_CHARS_PER_TOKEN);
  const filtered = lines.map((l) => l.trim()).filter(Boolean);
  const joined = filtered.join('\n');
  if (joined.length <= maxChars) return joined;

  // Keep 70% head + 25% tail to match CrusherConfig::voice()
  const headBudget = Math.floor(maxChars * 0.7);
  const tailBudget = Math.floor(maxChars * 0.25);
  const head = joined.slice(0, headBudget).trimEnd();
  const tail = joined.slice(joined.length - tailBudget).trimStart();
  return `${head}\n…\n${tail}`;
}

export class CtxClient {
  private shareStore = new Map<string, CtxShareEntry>();
  private ccrStore = new Map<string, string>();
  private compactFileFallbackStore = new Map<string, string>();

  public getInMemoryShareMap(): ReadonlyMap<string, CtxShareEntry> {
    return this.shareStore;
  }

  public getInMemoryCcrMap(): ReadonlyMap<string, string> {
    return this.ccrStore;
  }

  public registerFallbackFileContent(path: string, content: string): void {
    const normalized = path.replace(/\\/g, '/').trim();
    if (!normalized) return;
    this.compactFileFallbackStore.set(normalized, content);
  }

  public ccrStoreLocal(content: string): string {
    const clean = (content || '').trim();
    const hash = stableHash(clean);
    this.ccrStore.set(hash, clean);
    return hash;
  }

  public packVoiceContextSync(input: VoiceContextPackInput): VoiceContextPackResult {
    const maxTokens = input.maxTokens ?? DEFAULT_VOICE_MAX_TOKENS;
    const lines: string[] = [];

    const projParts: string[] = [];
    if (input.workspaceName) projParts.push(`Proyecto="${input.workspaceName}"`);
    if (input.gitBranch) projParts.push(`Rama=${input.gitBranch}`);
    if (input.mode) projParts.push(`Modo=${input.mode}`);
    if (input.voiceSessionActive) {
      projParts.push(
        input.boundThreadId ? `Voz=activa(${input.boundThreadId})` : 'Voz=activa'
      );
    }
    if (projParts.length > 0) lines.push(projParts.join(' | '));
    if (input.draftProposalSummary) lines.push(`Propuesta: ${input.draftProposalSummary}`);
    if (input.workingContextSummary) lines.push(`Sesión: ${input.workingContextSummary}`);
    if (input.subagentsSummary) lines.push(`Subagentes: ${input.subagentsSummary}`);
    if (input.terminalsSummary) lines.push(`Terminales: ${input.terminalsSummary}`);
    if (input.threadsSummary) lines.push(`Hilos: ${input.threadsSummary}`);
    if (input.agentsSummary) lines.push(`Agentes: ${input.agentsSummary}`);

    const packedText = compressVoiceLines(lines, maxTokens);
    return {
      packedText,
      estimatedTokens: estimateTokens(packedText),
      source: 'fallback',
    };
  }

  public async packVoiceContext(input: VoiceContextPackInput): Promise<VoiceContextPackResult> {
    const syncFallback = this.packVoiceContextSync(input);
    if (hasTauriRuntime()) {
      try {
        const res = await ipc.invokeCommand<{
          text?: string;
          packedText?: string;
          packed_text?: string;
          compressedTokens?: number;
          estimatedTokens?: number;
          estimated_tokens?: number;
        }>('ctx_pack_voice_context', {
          text: syncFallback.packedText,
          max_tokens: input.maxTokens ?? DEFAULT_VOICE_MAX_TOKENS,
          ...input,
        });
        const text = (res?.text ?? res?.packedText ?? res?.packed_text ?? '').trim();
        if (text) {
          return {
            packedText: text,
            estimatedTokens:
              res?.compressedTokens ??
              res?.estimatedTokens ??
              res?.estimated_tokens ??
              estimateTokens(text),
            source: 'tauri',
          };
        }
      } catch {
        // Fallback to deterministic local voice packing
      }
    }
    return syncFallback;
  }

  public kvPlanSync(input: KvPlanInput): KvPlanResult {
    let volatileCount = 0;
    const stablePrefix = (input.staticPrefix || '').replace(VOLATILE_TIMESTAMP_RE, () => {
      volatileCount += 1;
      return '[tiempo-relativo]';
    });
    return {
      stablePrefix,
      dynamicTail: input.dynamicTail || '',
      prefixHash: stableHash(stablePrefix),
      volatileTokensScrubbed: volatileCount,
      source: 'fallback',
    };
  }

  public async kvPlan(input: KvPlanInput): Promise<KvPlanResult> {
    if (hasTauriRuntime()) {
      try {
        const res = await ipc.invokeCommand<{
          stablePrefix?: string;
          stable_prefix?: string;
          dynamicTail?: string;
          dynamic_tail?: string;
          prefixHash?: string;
          prefix_hash?: string;
          volatileTokensScrubbed?: number;
          volatile_tokens_scrubbed?: number;
          staticPrefixClean?: boolean;
          volatileFindings?: unknown[];
        }>('ctx_kv_plan', {
          provider: 'argos',
          static_prefix: input.staticPrefix,
          turn_texts: input.dynamicTail ? [input.dynamicTail] : [],
          staticPrefix: input.staticPrefix,
          dynamicTail: input.dynamicTail,
        });
        const stablePrefix = res?.stablePrefix ?? res?.stable_prefix;
        if (typeof stablePrefix === 'string' && stablePrefix.length > 0) {
          return {
            stablePrefix,
            dynamicTail: res?.dynamicTail ?? res?.dynamic_tail ?? input.dynamicTail,
            prefixHash: res?.prefixHash ?? res?.prefix_hash ?? stableHash(stablePrefix),
            volatileTokensScrubbed: res?.volatileTokensScrubbed ?? res?.volatile_tokens_scrubbed ?? 0,
            source: 'tauri',
          };
        }
        if (typeof res?.staticPrefixClean === 'boolean') {
          const localPlan = this.kvPlanSync(input);
          return {
            ...localPlan,
            volatileTokensScrubbed: Array.isArray(res.volatileFindings)
              ? res.volatileFindings.length
              : localPlan.volatileTokensScrubbed,
            source: 'tauri',
          };
        }
      } catch {
        // Fall through to deterministic KV plan
      }
    }
    return this.kvPlanSync(input);
  }

  public async sharePut(key: string, value: string, ttlMs?: number): Promise<boolean> {
    const cleanKey = (key || '').trim();
    if (!cleanKey) return false;
    this.shareStore.set(cleanKey, {
      key: cleanKey,
      value,
      updatedAt: Date.now(),
      ...(typeof ttlMs === 'number' ? { ttlMs } : {}),
    });

    if (hasTauriRuntime()) {
      try {
        await ipc.invokeCommand('ctx_share_put', {
          key: cleanKey,
          content: value,
          value,
          ...(typeof ttlMs === 'number' ? { ttlMs } : {}),
        });
      } catch {
        // In-memory store remains populated
      }
    }
    return true;
  }

  public async shareGet(key: string, nowMs: number = Date.now()): Promise<string | null> {
    const cleanKey = (key || '').trim();
    if (!cleanKey) return null;

    if (hasTauriRuntime()) {
      try {
        const res = await ipc.invokeCommand<{ value?: string | null; content?: string | null; found?: boolean } | string | null>('ctx_share_get', {
          key: cleanKey,
          full: true,
        });
        if (typeof res === 'string') return res;
        if (res && typeof res === 'object') {
          const text = res.content ?? res.value;
          if (typeof text === 'string') return text;
        }
      } catch {
        // Fallback to in-memory share store
      }
    }

    const entry = this.shareStore.get(cleanKey);
    if (!entry) return null;
    if (typeof entry.ttlMs === 'number' && entry.ttlMs > 0 && nowMs - entry.updatedAt > entry.ttlMs) {
      this.shareStore.delete(cleanKey);
      return null;
    }
    return entry.value;
  }

  public async ccrRetrieve(
    hash: string,
    opts?: { lines?: string; search?: string }
  ): Promise<string | null> {
    const cleanHash = (hash || '').trim().replace(/^<<ccr:/i, '').replace(/>>$/, '');
    if (!cleanHash) return null;

    if (hasTauriRuntime()) {
      try {
        const res = await ipc.invokeCommand<{ content?: string | null; text?: string | null } | string | null>(
          'ctx_ccr_retrieve',
          {
            hash: cleanHash,
            ...(opts?.lines ? { lines: opts.lines } : {}),
            ...(opts?.search ? { search: opts.search } : {}),
          }
        );
        if (typeof res === 'string') return res;
        const val = res?.content ?? res?.text;
        if (typeof val === 'string') return val;
      } catch {
        // Fallback to local CCR map
      }
    }

    const local = this.ccrStore.get(cleanHash);
    if (!local) return null;
    if (opts?.search) {
      const needle = opts.search.toLowerCase();
      const matchingLines = local
        .split(/\r?\n/)
        .filter((l) => l.toLowerCase().includes(needle));
      return matchingLines.join('\n') || local;
    }
    return local;
  }

  public async readCompact(
    path: string,
    opts: CtxReadCompactOptions = {}
  ): Promise<CtxReadCompactResult> {
    const cleanPath = (path || '').trim();
    const mode = opts.mode || 'signatures';

    if (hasTauriRuntime() && cleanPath) {
      try {
        const res = await ipc.invokeCommand<{ content?: string; text?: string } | string>('ctx_read_compact', {
          path: cleanPath,
          mode,
          ...(typeof opts.startLine === 'number' ? { startLine: opts.startLine } : {}),
          ...(typeof opts.endLine === 'number' ? { endLine: opts.endLine } : {}),
          ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
        });
        const content =
          typeof res === 'string'
            ? res
            : typeof res?.content === 'string'
              ? res.content
              : typeof res?.text === 'string'
                ? res.text
                : '';
        if (content) {
          return {
            path: cleanPath,
            mode,
            content,
            source: 'tauri',
          };
        }
      } catch {
        // Fall back to in-memory / empty safe response
      }
    }

    const normalizedPath = cleanPath.replace(/\\/g, '/');
    const localContent = this.compactFileFallbackStore.get(normalizedPath) || '';
    if (localContent && mode === 'lines' && opts.startLine) {
      const lines = localContent.split(/\r?\n/);
      const start = Math.max(0, opts.startLine - 1);
      const end = opts.endLine ? Math.min(lines.length, opts.endLine) : Math.min(lines.length, start + 60);
      return {
        path: cleanPath,
        mode,
        content: lines.slice(start, end).join('\n'),
        source: 'fallback',
      };
    }

    return {
      path: cleanPath,
      mode,
      content: localContent,
      source: 'fallback',
    };
  }

  public resetForTests(): void {
    this.shareStore.clear();
    this.ccrStore.clear();
    this.compactFileFallbackStore.clear();
  }
}

export const ctxClient = new CtxClient();
