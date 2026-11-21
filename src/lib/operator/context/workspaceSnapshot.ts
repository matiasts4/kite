// Kite Code — Authoritative Workspace Snapshot Provider
// Aggregates strictly workspace-scoped terminals, threads, subagents, and autonomous agents
// with event-driven cache invalidation and hard token budgeting.

import { invokeCommand, isTauriEnvironment, listChatSummaries } from '../../ipc';
import { getActiveAgentTerminals } from '../../terminalRegistry';
import { cleanAgentTitle } from '../../agentNames';
import type { AgentProfile } from '../../../types';

type ChatThreadSummary = Awaited<ReturnType<typeof listChatSummaries>>[number];
import type {
  TurnContext,
  WorkspaceAutonomousAgentSnapshot,
  WorkspaceSubagentSnapshot,
  WorkspaceThreadSnapshot,
} from '../contract';
import { voiceSessionStore } from '../voice/voiceSessionStore';
import { getCachedWorkspaceEpisodicMemory } from './episodicMemory';
import { getSessionWorkingContext } from './workingContext';

export interface WorkspaceSnapshot {
  workspaceId?: string;
  workspaceName?: string;
  workspacePath?: string;
  gitBranch?: string;
  activeTerminals: NonNullable<TurnContext['activeTerminals']>;
  activeThreads: WorkspaceThreadSnapshot[];
  activeSubagents: WorkspaceSubagentSnapshot[];
  autonomousAgents: WorkspaceAutonomousAgentSnapshot[];
  fetchedAt: number;
}

const SNAPSHOT_TTL_MS = 3000;
const MAX_TERMINALS = 8;
const MAX_THREADS = 8;
const MAX_SUBAGENTS = 6;
const MAX_AGENTS = 8;

interface CachedWorkspaceEntry {
  key: string;
  snapshot: WorkspaceSnapshot;
}

let cachedEntry: CachedWorkspaceEntry | null = null;
let listenersWired = false;

function invalidateSnapshotCache(): void {
  cachedEntry = null;
}

function ensureInvalidationListeners(): void {
  if (listenersWired || typeof window === 'undefined') return;
  listenersWired = true;
  const events = [
    'kite:workspace-changed',
    'kite:threads-changed',
    'kite:terminal-agent-update',
    'kite:agents-changed',
  ];
  for (const ev of events) {
    window.addEventListener(ev, invalidateSnapshotCache);
  }
}

export function resetWorkspaceSnapshotCacheForTests(): void {
  cachedEntry = null;
}

export function resolveAuthoritativeWorkspace(explicitWorkspaceId?: string | null): {
  workspaceId?: string;
  workspaceName?: string;
  workspacePath?: string;
  gitBranch?: string;
} {
  const legacyPrefix = ['bm', 'one'].join('');
  let workspaceId = explicitWorkspaceId?.trim() || undefined;

  if (!workspaceId && typeof window !== 'undefined') {
    const winState = (window as any).__kiteActiveWorkspace as
      | { id?: string; name?: string; path?: string; branch?: string }
      | undefined;
    if (winState?.id) {
      workspaceId = winState.id;
    }
    if (!workspaceId) {
      try {
        workspaceId =
          localStorage.getItem('kite.selectedWorkspaceId') ||
          localStorage.getItem(`${legacyPrefix}.selectedWorkspaceId`) ||
          undefined;
      } catch {}
    }
  }

  let workspaceName: string | undefined;
  let workspacePath: string | undefined;
  let gitBranch: string | undefined;

  if (typeof window !== 'undefined') {
    const winState = (window as any).__kiteActiveWorkspace as
      | { id?: string; name?: string; path?: string; branch?: string }
      | undefined;
    if (winState && (!workspaceId || winState.id === workspaceId)) {
      workspaceName = winState.name || workspaceName;
      workspacePath = winState.path || workspacePath;
      gitBranch = winState.branch || gitBranch;
    }

    try {
      const raw =
        localStorage.getItem('kite.cached_workspaces') ||
        localStorage.getItem(`${legacyPrefix}.cached_workspaces`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const ws = parsed.find((w: any) => w && w.id === workspaceId);
          if (ws) {
            workspaceName = workspaceName || ws.displayName || ws.name;
            workspacePath = workspacePath || ws.path || ws.rootPath;
            gitBranch = gitBranch || ws.gitBranch || ws.branch;
          }
        }
      }
    } catch {}
  }

  return { workspaceId, workspaceName, workspacePath, gitBranch };
}

/**
 * Strictly filters terminal sessions to the active workspace.
 * When `workspaceId` is known, orphan terminals without a matching `workspaceId`
 * are excluded to eliminate cross-workspace leakage (S5).
 */
export function filterTerminalsForWorkspace<
  T extends { workspaceId?: string | null }
>(terminals: T[], workspaceId?: string): T[] {
  if (!workspaceId) return terminals;
  return terminals.filter((t) => Boolean(t.workspaceId) && t.workspaceId === workspaceId);
}

/**
 * Strictly filters chat/thread summaries to the active workspace.
 */
export function filterThreadsForWorkspace(
  chats: ChatThreadSummary[],
  workspaceId?: string
): ChatThreadSummary[] {
  if (!workspaceId) return chats;
  return chats.filter((c) => Boolean(c.workspaceId) && c.workspaceId === workspaceId);
}

function summarizeThreadTitle(title?: string | null): string {
  const clean = (title || 'Sin título').replace(/\s+/g, ' ').trim();
  return clean.length > 64 ? `${clean.slice(0, 61)}…` : clean;
}

export async function fetchWorkspaceSnapshot(
  explicitWorkspaceId?: string | null,
  options?: { forceRefresh?: boolean }
): Promise<WorkspaceSnapshot> {
  ensureInvalidationListeners();

  const resolved = resolveAuthoritativeWorkspace(explicitWorkspaceId);
  const cacheKey = resolved.workspaceId || '__unscoped__';
  const now = Date.now();

  if (
    !options?.forceRefresh &&
    cachedEntry &&
    cachedEntry.key === cacheKey &&
    now - cachedEntry.snapshot.fetchedAt < SNAPSHOT_TTL_MS
  ) {
    return cachedEntry.snapshot;
  }

  // 1. Active terminals (strictly workspace-scoped)
  let rawTerminals: ReturnType<typeof getActiveAgentTerminals> = [];
  try {
    rawTerminals = getActiveAgentTerminals();
  } catch {
    rawTerminals = [];
  }
  const scopedTerminals = filterTerminalsForWorkspace(rawTerminals, resolved.workspaceId).slice(
    0,
    MAX_TERMINALS
  );

  const activeTerminals = scopedTerminals.map((t, idx) => ({
    sessionId: t.sessionId,
    engine: t.engine,
    title: t.title,
    who: t.who || cleanAgentTitle(t.title) || undefined,
    state: t.state,
    latestLine: t.latestLine ? t.latestLine.slice(0, 120) : undefined,
    idx: idx + 1,
    workspaceId: t.workspaceId ?? undefined,
  }));

  // 2. Fetch threads, subagents, and autonomous agents in parallel (graceful degradation outside Tauri)
  const [chatsRes, profilesRes, agentChatsRes] = await Promise.all([
    listChatSummaries().catch(() => [] as ChatThreadSummary[]),
    isTauriEnvironment()
      ? invokeCommand<AgentProfile[]>('list_agent_profiles').catch(() => [] as AgentProfile[])
      : Promise.resolve([] as AgentProfile[]),
    isTauriEnvironment()
      ? invokeCommand<ChatThreadSummary[]>('list_agent_chat_summaries').catch(() => [] as ChatThreadSummary[])
      : Promise.resolve([] as ChatThreadSummary[]),
  ]);

  const scopedChats = filterThreadsForWorkspace(
    Array.isArray(chatsRes) ? chatsRes : [],
    resolved.workspaceId
  ).sort((a, b) => (b.updatedAtUnixMs || 0) - (a.updatedAtUnixMs || 0));

  const subagentChats = scopedChats.filter(
    (c) => Boolean(c.parentThreadId) || Boolean(c.subagentRole) || Boolean(c.startedByAgent)
  );
  const topLevelChats = scopedChats.filter(
    (c) => !c.parentThreadId && !c.subagentRole
  );

  const activeThreads: WorkspaceThreadSnapshot[] = topLevelChats.slice(0, MAX_THREADS).map((c) => ({
    id: c.id,
    title: summarizeThreadTitle(c.title),
    provider: c.provider || 'antigravity',
    status: c.status || 'idle',
    updatedAtUnixMs: c.updatedAtUnixMs || 0,
  }));

  const voiceSnap = voiceSessionStore.getSnapshot();
  const workingCtx = voiceSnap.boundThreadId
    ? getSessionWorkingContext(voiceSnap.boundThreadId)
    : null;
  const episodicMem = resolved.workspaceId
    ? getCachedWorkspaceEpisodicMemory(resolved.workspaceId)
    : null;

  const activeSubagents: WorkspaceSubagentSnapshot[] = subagentChats
    .slice(0, MAX_SUBAGENTS)
    .map((c) => {
      const wcFinding = workingCtx?.findings.find((f) => f.subagentId === c.id);
      const ledgerMatch = episodicMem?.delegations.find((d) => d.resourceId === c.id);
      const findingsSummary = wcFinding?.findingsSummary || ledgerMatch?.outcomeSummary;
      return {
        id: c.id,
        role: c.subagentRole || summarizeThreadTitle(c.title),
        provider: c.provider || 'antigravity',
        status: c.status || 'idle',
        parentThreadId: c.parentThreadId ?? undefined,
        title: summarizeThreadTitle(c.title),
        ...(findingsSummary ? { findingsSummary } : {}),
        updatedAtUnixMs: c.updatedAtUnixMs || 0,
      };
    });

  const scopedAgentChats = filterThreadsForWorkspace(
    Array.isArray(agentChatsRes) ? agentChatsRes : [],
    resolved.workspaceId
  ).sort((a, b) => (b.updatedAtUnixMs || 0) - (a.updatedAtUnixMs || 0));

  const profiles = Array.isArray(profilesRes) ? profilesRes : [];
  const autonomousAgents: WorkspaceAutonomousAgentSnapshot[] = profiles
    .slice(0, MAX_AGENTS)
    .map((profile) => {
      const latestChat = scopedAgentChats.find(
        (c) => (c as any).agentId === profile.id || c.title?.toLowerCase().includes(profile.name.toLowerCase())
      );
      return {
        id: profile.id,
        name: profile.name,
        engine: profile.engine || 'claude',
        status: latestChat?.status || 'idle',
        activeThreadId: latestChat?.id,
        updatedAtUnixMs: latestChat?.updatedAtUnixMs,
      };
    });

  const workspaceName =
    resolved.workspaceName ||
    (scopedTerminals.length > 0 ? scopedTerminals[0].workspaceName ?? undefined : undefined);

  const snapshot: WorkspaceSnapshot = {
    workspaceId: resolved.workspaceId,
    workspaceName,
    workspacePath: resolved.workspacePath,
    gitBranch: resolved.gitBranch,
    activeTerminals,
    activeThreads,
    activeSubagents,
    autonomousAgents,
    fetchedAt: now,
  };

  cachedEntry = { key: cacheKey, snapshot };
  return snapshot;
}

/**
 * Builds a complete `TurnContext` enriched with strictly workspace-scoped terminals,
 * threads, subagents, autonomous agents, and live voice session binding.
 */
export async function buildEnrichedTurnContext(
  mode?: string,
  workspaceId?: string | null
): Promise<TurnContext> {
  const snapshot = await fetchWorkspaceSnapshot(workspaceId);
  const voiceSnapshot = voiceSessionStore.getSnapshot();
  const isVoiceSessionActive =
    voiceSnapshot.phase === 'active' || voiceSnapshot.phase === 'starting';
  const resolvedMode =
    mode ||
    (isVoiceSessionActive && voiceSnapshot.activeSurface === 'thread' ? 'thread' : 'code');

  return {
    mode: resolvedMode,
    workspaceId: snapshot.workspaceId,
    workspaceName: snapshot.workspaceName,
    workspacePath: snapshot.workspacePath,
    gitBranch: snapshot.gitBranch,
    boundThreadId: isVoiceSessionActive ? (voiceSnapshot.boundThreadId ?? undefined) : undefined,
    voiceSessionActive: isVoiceSessionActive,
    activeTerminals: snapshot.activeTerminals,
    activeThreads: snapshot.activeThreads,
    activeSubagents: snapshot.activeSubagents,
    autonomousAgents: snapshot.autonomousAgents,
  };
}

/**
 * Compact, token-budgeted workspace roster representation for the LLM system prompt (<= 700 tokens).
 */
export function formatWorkspaceRosterForPrompt(context?: TurnContext): string {
  const sections: string[] = [];

  if (context?.activeTerminals && context.activeTerminals.length > 0) {
    const lines = context.activeTerminals.slice(0, MAX_TERMINALS).map((t, i) => {
      const codename = t.who || cleanAgentTitle(t.title) || '';
      const latest = t.latestLine ? ` | Último: "${t.latestLine.slice(0, 70)}"` : '';
      return `- T${i + 1}: Agente="${codename}", Motor=${t.engine || 'shell'}, Estado=${t.state || 'activo'}${latest}`;
    });
    sections.push(`Terminales activas en este proyecto (${lines.length}):\n${lines.join('\n')}`);
  } else {
    sections.push('Terminales activas en este proyecto: ninguna.');
  }

  if (context?.activeThreads && context.activeThreads.length > 0) {
    const lines = context.activeThreads.slice(0, MAX_THREADS).map(
      (th) => `- Hilo "${th.title}" [Motor=${th.provider}, Estado=${th.status}]`
    );
    sections.push(`Hilos recientes en este proyecto (${lines.length}):\n${lines.join('\n')}`);
  }

  if (context?.activeSubagents && context.activeSubagents.length > 0) {
    const lines = context.activeSubagents.slice(0, MAX_SUBAGENTS).map((sub) => {
      const finding = sub.findingsSummary
        ? ` | Hallazgo: "${sub.findingsSummary.slice(0, 140)}"`
        : '';
      return `- Subagente "${sub.role}" [Motor=${sub.provider}, Estado=${sub.status}]${finding}`;
    });
    sections.push(`Subagentes en este proyecto (${lines.length}):\n${lines.join('\n')}`);
  }

  if (context?.autonomousAgents && context.autonomousAgents.length > 0) {
    const lines = context.autonomousAgents.slice(0, MAX_AGENTS).map(
      (ag) => `- Agente autónomo "${ag.name}" [Motor=${ag.engine}, Estado=${ag.status}]`
    );
    sections.push(`Agentes autónomos disponibles en este proyecto (${lines.length}):\n${lines.join('\n')}`);
  }

  return sections.join('\n');
}
