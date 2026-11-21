// Kite Code — Workspace-Scoped Episodic Memory & Delegation Ledger
// Persists session decisions, delegated tasks, and reconciled agent status per workspace
// so SETH accurately answers "¿qué está haciendo Nova?" and "continúa lo de ayer" across sessions.

import { invokeCommand, isTauriEnvironment } from '../../ipc';
import type { ActionReceipt, TurnContext } from '../contract';
import { loadOperatorConfig } from '../operatorConfig';
import { voiceSessionStore, type VoiceTurnRecord } from '../voice/voiceSessionStore';
import { resolveAuthoritativeWorkspace } from './workspaceSnapshot';
import { getSessionWorkingContext } from './workingContext';

export type DelegationEntityKind = 'terminal' | 'thread' | 'subagent' | 'agent';
export type DelegationLifecycleStatus = 'running' | 'waiting' | 'completed' | 'failed';

export interface DelegationRecord {
  id: string;
  workspaceId: string;
  kind: DelegationEntityKind;
  name: string;
  role?: string;
  provider?: string;
  resourceId?: string;
  taskSummary: string;
  status: DelegationLifecycleStatus;
  outcomeSummary?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionMemoryRecord {
  sessionId: string;
  workspaceId: string;
  endedAt: number;
  summary: string;
  decisions: string[];
  openTasks: string[];
}

export interface WorkspaceEpisodicMemory {
  workspaceId: string;
  delegations: DelegationRecord[];
  sessions: SessionMemoryRecord[];
}

const LOCAL_STORAGE_PREFIX = 'kite.operator.episodicMemory.v1.';
const MAX_DELEGATIONS_PER_WS = 24;
const MAX_SESSIONS_PER_WS = 12;

const memoryCache = new Map<string, WorkspaceEpisodicMemory>();

function normalizeWorkspaceKey(workspaceId?: string | null): string {
  return (workspaceId || '').trim() || '__default__';
}

function emptyMemory(workspaceId: string): WorkspaceEpisodicMemory {
  return { workspaceId, delegations: [], sessions: [] };
}

function readLocalMemory(wsKey: string): WorkspaceEpisodicMemory {
  if (typeof localStorage === 'undefined') return emptyMemory(wsKey);
  try {
    const raw = localStorage.getItem(`${LOCAL_STORAGE_PREFIX}${wsKey}`);
    if (!raw) return emptyMemory(wsKey);
    const parsed = JSON.parse(raw) as Partial<WorkspaceEpisodicMemory>;
    return {
      workspaceId: wsKey,
      delegations: Array.isArray(parsed.delegations) ? parsed.delegations : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    return emptyMemory(wsKey);
  }
}

function writeLocalMemory(wsKey: string, mem: WorkspaceEpisodicMemory): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(`${LOCAL_STORAGE_PREFIX}${wsKey}`, JSON.stringify(mem));
  } catch {}
}

export async function loadWorkspaceEpisodicMemory(
  workspaceId?: string | null
): Promise<WorkspaceEpisodicMemory> {
  const wsKey = normalizeWorkspaceKey(workspaceId);
  const cached = memoryCache.get(wsKey);
  if (cached) return cached;

  let loaded: WorkspaceEpisodicMemory | null = null;
  if (isTauriEnvironment()) {
    try {
      const res = await invokeCommand<Partial<WorkspaceEpisodicMemory>>('operator_memory_load', {
        workspaceId: wsKey,
      });
      if (res && typeof res === 'object') {
        loaded = {
          workspaceId: wsKey,
          delegations: Array.isArray(res.delegations) ? res.delegations : [],
          sessions: Array.isArray(res.sessions) ? res.sessions : [],
        };
      }
    } catch {
      loaded = null;
    }
  }

  const finalMem = loaded ?? readLocalMemory(wsKey);
  memoryCache.set(wsKey, finalMem);
  return finalMem;
}

export function getCachedWorkspaceEpisodicMemory(
  workspaceId?: string | null
): WorkspaceEpisodicMemory {
  const wsKey = normalizeWorkspaceKey(workspaceId);
  const cached = memoryCache.get(wsKey);
  if (cached) return cached;
  const local = readLocalMemory(wsKey);
  memoryCache.set(wsKey, local);
  return local;
}

async function persistWorkspaceEpisodicMemory(
  wsKey: string,
  mem: WorkspaceEpisodicMemory
): Promise<void> {
  const bounded: WorkspaceEpisodicMemory = {
    workspaceId: wsKey,
    delegations: mem.delegations.slice(-MAX_DELEGATIONS_PER_WS),
    sessions: mem.sessions.slice(-MAX_SESSIONS_PER_WS),
  };
  memoryCache.set(wsKey, bounded);
  writeLocalMemory(wsKey, bounded);

  if (isTauriEnvironment()) {
    try {
      await invokeCommand('operator_memory_save', {
        workspaceId: wsKey,
        data: bounded,
      });
    } catch {
      // Local fallback already persisted
    }
  }
}

export async function recordDelegation(
  workspaceId: string | null | undefined,
  entry: Omit<DelegationRecord, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt'> & {
    id?: string;
    createdAt?: number;
    updatedAt?: number;
  }
): Promise<DelegationRecord> {
  const wsKey = normalizeWorkspaceKey(workspaceId);
  const mem = await loadWorkspaceEpisodicMemory(wsKey);
  const now = Date.now();
  const record: DelegationRecord = {
    id: entry.id || `del-${now}-${Math.random().toString(36).slice(2, 6)}`,
    workspaceId: wsKey,
    kind: entry.kind,
    name: entry.name,
    role: entry.role,
    provider: entry.provider,
    resourceId: entry.resourceId,
    taskSummary: entry.taskSummary.slice(0, 180),
    status: entry.status,
    outcomeSummary: entry.outcomeSummary?.slice(0, 340),
    createdAt: entry.createdAt ?? now,
    updatedAt: entry.updatedAt ?? now,
  };

  const filtered = mem.delegations.filter(
    (d) =>
      d.id !== record.id &&
      !(record.resourceId && d.resourceId && d.resourceId === record.resourceId)
  );
  mem.delegations = [...filtered, record];
  await persistWorkspaceEpisodicMemory(wsKey, mem);
  return record;
}

/**
 * Extracts and persists delegation ledger records from verified action receipts.
 */
export async function recordDelegationsFromReceipts(
  workspaceId: string | null | undefined,
  receipts: ActionReceipt[]
): Promise<void> {
  if (!receipts || receipts.length === 0) return;
  for (const r of receipts) {
    if (!r.ok) continue;
    const data = (r.data || {}) as Record<string, any>;
    if (r.type === 'launch_thread') {
      await recordDelegation(workspaceId, {
        kind: 'thread',
        name: String(data.title || 'Hilo delegado'),
        provider: typeof data.provider === 'string' ? data.provider : undefined,
        resourceId: typeof data.threadId === 'string' ? data.threadId : undefined,
        taskSummary: r.summaryEs,
        status: 'running',
      });
    } else if (r.type === 'spawn_subagent') {
      await recordDelegation(workspaceId, {
        kind: 'subagent',
        name: String(data.role || 'Subagente'),
        role: typeof data.role === 'string' ? data.role : undefined,
        provider: typeof data.provider === 'string' ? data.provider : undefined,
        resourceId: typeof data.threadId === 'string' ? data.threadId : undefined,
        taskSummary: r.summaryEs,
        status: 'running',
      });
    } else if (r.type === 'launch_agent') {
      await recordDelegation(workspaceId, {
        kind: 'agent',
        name: String(data.agentName || 'Agente autónomo'),
        provider: typeof data.provider === 'string' ? data.provider : undefined,
        resourceId: typeof data.threadId === 'string' ? data.threadId : undefined,
        taskSummary: r.summaryEs,
        status: 'running',
      });
    } else if (r.type === 'open_terminals') {
      const names = Array.isArray(data.assignedNames) ? data.assignedNames : [];
      const ids = Array.isArray(data.sessionIds) ? data.sessionIds : [];
      for (let i = 0; i < Math.max(names.length, ids.length); i++) {
        await recordDelegation(workspaceId, {
          kind: 'terminal',
          name: String(names[i] || data.engine || `Terminal ${i + 1}`),
          provider: typeof data.engine === 'string' ? data.engine : undefined,
          resourceId: typeof ids[i] === 'string' ? ids[i] : undefined,
          taskSummary: r.summaryEs,
          status: 'running',
        });
      }
    }
  }
}

/**
 * Reconciles persisted delegations against live workspace entities so SETH never mistakes
 * a finished or closed task for an actively running one.
 */
export function reconcileDelegationsWithContext(
  delegations: DelegationRecord[],
  context?: TurnContext
): DelegationRecord[] {
  if (!context || delegations.length === 0) return delegations;

  const terminals = context.activeTerminals || [];
  const threads = context.activeThreads || [];
  const subagents = context.activeSubagents || [];
  const agents = context.autonomousAgents || [];

  return delegations.map((d) => {
    if (d.kind === 'terminal') {
      const live = terminals.find(
        (t) =>
          (d.resourceId && t.sessionId === d.resourceId) ||
          (t.who && t.who.toLowerCase() === d.name.toLowerCase())
      );
      if (live) {
        const status: DelegationLifecycleStatus =
          live.state === 'waitingForYou'
            ? 'waiting'
            : live.state === 'done' || live.state === 'exited'
              ? 'completed'
              : 'running';
        return {
          ...d,
          status,
          outcomeSummary: live.latestLine || d.outcomeSummary,
        };
      }
      return d.status === 'running' ? { ...d, status: 'completed' } : d;
    }

    if (d.kind === 'subagent') {
      const live = subagents.find(
        (s) =>
          (d.resourceId && s.id === d.resourceId) ||
          s.role.toLowerCase() === d.name.toLowerCase()
      );
      if (live) {
        const status: DelegationLifecycleStatus =
          live.status === 'error'
            ? 'failed'
            : live.status === 'waiting'
              ? 'waiting'
              : live.status === 'running'
                ? 'running'
                : 'completed';
        return { ...d, status };
      }
    }

    if (d.kind === 'thread') {
      const live = threads.find(
        (th) =>
          (d.resourceId && th.id === d.resourceId) ||
          th.title.toLowerCase() === d.name.toLowerCase()
      );
      if (live) {
        const status: DelegationLifecycleStatus =
          live.status === 'error'
            ? 'failed'
            : live.status === 'waiting'
              ? 'waiting'
              : live.status === 'running'
                ? 'running'
                : 'completed';
        return { ...d, status };
      }
    }

    if (d.kind === 'agent') {
      const live = agents.find(
        (ag) =>
          (d.resourceId && ag.activeThreadId === d.resourceId) ||
          ag.name.toLowerCase() === d.name.toLowerCase()
      );
      if (live) {
        const status: DelegationLifecycleStatus =
          live.status === 'error'
            ? 'failed'
            : live.status === 'waiting'
              ? 'waiting'
              : live.status === 'running'
                ? 'running'
                : 'completed';
        return { ...d, status };
      }
    }

    return d;
  });
}

function formatRelativeSpanishTime(ts: number, nowMs: number = Date.now()): string {
  const diffMs = Math.max(0, nowMs - ts);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 2) return 'recién';
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 20) return `hace ${hours} h`;
  if (hours < 44) return 'ayer';
  const days = Math.floor(hours / 24);
  return `hace ${days} días`;
}

/**
 * Formats reconciled workspace episodic memory (recent delegations + session decisions)
 * into a concise prompt section (<= 6 entries) scoped strictly to the active workspace.
 */
export function formatEpisodicMemoryForPrompt(
  memory: WorkspaceEpisodicMemory,
  context?: TurnContext,
  nowMs: number = Date.now()
): string {
  const reconciled = reconcileDelegationsWithContext(memory.delegations, context);
  const recentDelegations = [...reconciled]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 4);
  const recentSessions = [...memory.sessions]
    .sort((a, b) => b.endedAt - a.endedAt)
    .slice(0, 2);

  if (recentDelegations.length === 0 && recentSessions.length === 0) {
    return '';
  }

  const lines: string[] = [];
  for (const d of recentDelegations) {
    const when = formatRelativeSpanishTime(d.updatedAt, nowMs);
    const outcome = d.outcomeSummary ? ` (${d.outcomeSummary.slice(0, 80)})` : '';
    lines.push(
      `- [${d.kind}] ${d.name} (${d.status}, ${when}): ${d.taskSummary.slice(0, 100)}${outcome}`
    );
  }

  for (const s of recentSessions) {
    const when = formatRelativeSpanishTime(s.endedAt, nowMs);
    const decs = s.decisions.length > 0 ? ` Decisiones: ${s.decisions.slice(0, 2).join('; ')}.` : '';
    lines.push(`- [sesión previa, ${when}] ${s.summary.slice(0, 130)}${decs}`);
  }

  return `\n\nMEMORIA EPISÓDICA DEL PROYECTO ACTUAL:\n${lines.join('\n')}`;
}

export async function saveSessionClosureSummary(
  workspaceId: string | null | undefined,
  sessionId: string,
  turns: VoiceTurnRecord[]
): Promise<SessionMemoryRecord | null> {
  if (!turns || turns.length === 0) return null;
  try {
    const config = loadOperatorConfig();
    if (config.persona && config.persona.rememberBetweenCalls === false) {
      return null;
    }
    if (config.persona?.afterCallMode === 'nothing') {
      return null;
    }
  } catch {}

  const validTurns = turns.filter(
    (t) => t.userPrompt && !t.userPrompt.startsWith('[captura de voz descartada')
  );
  if (validTurns.length === 0) return null;

  const decisions: string[] = [];
  const openTasks: string[] = [];

  for (const t of validTurns) {
    for (const r of t.receipts || []) {
      if (r.ok && r.summaryEs) {
        decisions.push(r.summaryEs.slice(0, 110));
        if (['launch_thread', 'spawn_subagent', 'launch_agent'].includes(r.type)) {
          openTasks.push(r.summaryEs.slice(0, 110));
        }
      }
    }
  }

  const workingCtx = getSessionWorkingContext(sessionId);
  for (const dec of workingCtx.decisions) {
    if (dec && !decisions.includes(dec)) {
      decisions.push(dec.slice(0, 120));
    }
  }
  for (const f of workingCtx.findings) {
    if (f.status === 'running' || f.status === 'waiting') {
      openTasks.push(`Subagente ${f.role}: ${f.taskSummary}`.slice(0, 110));
    } else if (f.findingsSummary) {
      decisions.push(`${f.role}: ${f.findingsSummary}`.slice(0, 120));
    }
  }

  const lastTurn = validTurns[validTurns.length - 1];
  const topicAnchor = workingCtx.currentTopic || lastTurn.userPrompt;
  const summary =
    decisions.length > 0
      ? `Se trabajaron ${validTurns.length} turnos sobre "${topicAnchor.slice(0, 90)}".`
      : `Conversación de ${validTurns.length} turnos sobre: "${topicAnchor.slice(0, 110)}".`;

  const wsKey = normalizeWorkspaceKey(workspaceId);
  const mem = await loadWorkspaceEpisodicMemory(wsKey);
  const record: SessionMemoryRecord = {
    sessionId,
    workspaceId: wsKey,
    endedAt: Date.now(),
    summary,
    decisions: decisions.slice(-4),
    openTasks: openTasks.slice(-4),
  };
  mem.sessions = [...mem.sessions.filter((s) => s.sessionId !== sessionId), record];
  await persistWorkspaceEpisodicMemory(wsKey, mem);
  return record;
}

let sessionClosureHookRegistered = false;

/**
 * Registers the automatic `afterCallMode` session summary writer on `voiceSessionStore`.
 */
export function ensureEpisodicSessionHook(): void {
  if (sessionClosureHookRegistered) return;
  sessionClosureHookRegistered = true;
  voiceSessionStore.onSessionEnded(({ threadId, turns }) => {
    if (!turns || turns.length === 0) return;
    const wsId = resolveAuthoritativeWorkspace().workspaceId;
    const sid = threadId || `session-${Date.now()}`;
    void saveSessionClosureSummary(wsId, sid, turns).catch(() => {});
  });
}

export function resetEpisodicMemoryCacheForTests(): void {
  memoryCache.clear();
}
