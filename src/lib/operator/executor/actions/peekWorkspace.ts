// Kite Code — Consultative Argos Actions: Fast Read-Only `peek_*` & Proposal Lifecycle
// Implements `<= 450ms` read-only workspace inspection (`peek_changes`, `peek_runs`,
// `peek_agents`, `peek_files`, `recall_conversations`) and the consultative multi-turn
// `DraftTaskProposal` lifecycle (`propose_task`, `refine_proposal`, `confirm_proposal`,
// `cancel_proposal`, `stay_silent`).

import * as ipc from '../../../ipc';
import type { WorkspaceChanges, WorkspaceFileDiff } from '../../../ipc';

function hasTauriRuntime(): boolean {
  try {
    return typeof ipc.isTauriEnvironment === 'function' && ipc.isTauriEnvironment();
  } catch {
    return false;
  }
}
import { consultChats, fetchLiveChatCatalog, liveChatReader } from '../../chatIndex';
import { ctxClient } from '../../context/ctxClient';
import {
  findSubagentFindingInWorkingContext,
  getSessionWorkingContext,
} from '../../context/workingContext';
import {
  ActionSchema,
  type ActionReceipt,
  type CancelProposalAction,
  type ConfirmProposalAction,
  type DraftStepInput,
  type Engine,
  type OperatorContractAction,
  type PeekAgentsAction,
  type PeekChangesAction,
  type PeekFilesAction,
  type PeekRunsAction,
  type PeekSearchAction,
  type ProposeTaskAction,
  type ReadFindingAction,
  type RecallConversationsAction,
  type RefineProposalAction,
  type StaySilentAction,
  type SubagentDelegationMode,
  type TurnContext,
} from '../../contract';
import { runLedger } from '../../runLedger';
import {
  voiceSessionStore,
  type DraftExecutionStep,
  type DraftTaskProposal,
} from '../../voice/voiceSessionStore';
import { executeLaunchAgentAction } from './launchAgent';
import { executeLaunchThreadAction } from './launchThread';
import { executeOpenTerminalsAction } from './openTerminals';
import { executeSpawnSubagentAction } from './spawnSubagent';

export const PEEK_TIMEOUT_MS = 450;
export const HANDS_FREE_REPLY_WINDOW_MS = 12_000;

export const PEEK_ACTION_TYPES = new Set([
  'peek_changes',
  'peek_runs',
  'peek_agents',
  'peek_files',
  'peek_search',
  'read_finding',
  'recall_conversations',
]);

export function isPeekActionType(type: string): boolean {
  return PEEK_ACTION_TYPES.has(type);
}

export async function withPeekTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = PEEK_TIMEOUT_MS,
  fallbackValue: T
): Promise<{ value: T; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const raced = await Promise.race([
      promise.then((value) => ({ value, timedOut: false })),
      new Promise<{ value: T; timedOut: boolean }>((resolve) => {
        timer = setTimeout(() => resolve({ value: fallbackValue, timedOut: true }), timeoutMs);
      }),
    ]);
    return raced;
  } catch {
    return { value: fallbackValue, timedOut: false };
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

function resolveProposalScope(context?: TurnContext): string {
  return context?.boundThreadId || context?.workspaceId || '__default__';
}

function basenameOf(rawPath: string): string {
  const parts = rawPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || rawPath;
}

export async function executePeekChangesAction(
  action: PeekChangesAction,
  actionIdx: number = 0,
  context?: TurnContext
): Promise<ActionReceipt> {
  const workspaceId = action.workspaceId || context?.workspaceId;

  if (!workspaceId || !hasTauriRuntime()) {
    const branchLabel = context?.gitBranch ? ` en la rama ${context.gitBranch}` : '';
    const summaryEs = workspaceId
      ? `Sin cambios locales disponibles para inspeccionar${branchLabel}.`
      : 'No hay un workspace activo para consultar cambios de git.';
    return {
      actionIdx,
      type: 'peek_changes',
      ok: true,
      summaryEs,
      spokenSummaryEs: summaryEs,
      data: {
        isRepo: Boolean(context?.gitBranch),
        branch: context?.gitBranch || null,
        files: [],
        timedOut: false,
      },
    };
  }

  const { value: changes, timedOut } = await withPeekTimeout<WorkspaceChanges | null>(
    ipc.readWorkspaceChanges(workspaceId),
    PEEK_TIMEOUT_MS,
    null
  );

  if (timedOut || !changes) {
    const summaryEs = timedOut
      ? 'La consulta rápida de cambios superó el tiempo límite; sigo con el contexto actual.'
      : 'No pude leer cambios de git en este momento.';
    return {
      actionIdx,
      type: 'peek_changes',
      ok: true,
      summaryEs,
      spokenSummaryEs: summaryEs,
      data: { timedOut, files: [] },
    };
  }

  const files = changes.files || [];
  const branchText = changes.branch ? ` en la rama ${changes.branch}` : '';
  const sampleNames = files
    .slice(0, 4)
    .map((f) => basenameOf(f.path))
    .join(', ');

  let diffs: Array<{
    path: string;
    added: number;
    removed: number;
    hunks: string[];
    preview: string;
    truncated?: boolean;
  }> = [];

  if (action.includeDiff && files.length > 0) {
    const pathFilter = (action.path || '').trim().toLowerCase();
    const candidates = pathFilter
      ? files.filter(
          (f) =>
            f.path.toLowerCase() === pathFilter ||
            f.path.toLowerCase().endsWith(pathFilter) ||
            basenameOf(f.path).toLowerCase() === pathFilter
        )
      : files;
    const targets = (candidates.length > 0 ? candidates : files).slice(0, 2);

    const diffResults = await Promise.all(
      targets.map(async (f) => {
        const { value: diffRes, timedOut: diffTimedOut } =
          await withPeekTimeout<WorkspaceFileDiff | null>(
            ipc.readWorkspaceFileDiff(workspaceId, f.path, f.status === 'untracked'),
            PEEK_TIMEOUT_MS,
            null
          );
        if (diffTimedOut || !diffRes) return null;
        const lines = diffRes.lines || [];
        let added = 0;
        let removed = 0;
        const hunks: string[] = [];
        const previewLines: string[] = [];
        for (const l of lines) {
          if (l.kind === 'added') {
            added += 1;
            if (previewLines.length < 18) previewLines.push(`+ ${l.text}`);
          } else if (l.kind === 'removed') {
            removed += 1;
            if (previewLines.length < 18) previewLines.push(`- ${l.text}`);
          } else if (l.kind === 'hunk') {
            if (hunks.length < 4) hunks.push(l.text);
            if (previewLines.length < 18) previewLines.push(l.text);
          }
        }
        return {
          path: f.path,
          added,
          removed,
          hunks,
          preview: previewLines.join('\n').slice(0, 700),
          ...(diffRes.truncated ? { truncated: true } : {}),
        };
      })
    );
    diffs = diffResults.filter((d): d is NonNullable<typeof d> => d !== null);
  }

  const diffTail =
    diffs.length > 0
      ? ` Diff inspeccionado en ${diffs.map((d) => `${basenameOf(d.path)} (+${d.added}/-${d.removed})`).join(', ')}.`
      : '';

  const summaryEs =
    files.length === 0
      ? `El repositorio${branchText} está limpio, sin archivos modificados.`
      : `Hay ${files.length} archivo${files.length === 1 ? '' : 's'} modificado${files.length === 1 ? '' : 's'}${branchText}${sampleNames ? `: ${sampleNames}` : ''}.${diffTail}`;

  return {
    actionIdx,
    type: 'peek_changes',
    ok: true,
    summaryEs,
    spokenSummaryEs: summaryEs,
    data: {
      isRepo: changes.isRepo,
      branch: changes.branch,
      count: files.length,
      files: files.slice(0, 12).map((f) => ({ path: f.path, status: f.status, staged: f.staged })),
      ...(diffs.length > 0 ? { diffs } : {}),
    },
  };
}

export async function executePeekRunsAction(
  action: PeekRunsAction,
  actionIdx: number = 0,
  context?: TurnContext
): Promise<ActionReceipt> {
  const limit = action.limit ?? 5;
  const filterStatus = action.filterStatus ?? 'all';
  const allRuns = runLedger.getRecentRunSummaries(limit * 2);
  const filteredRuns = allRuns
    .filter((r) => {
      if (filterStatus === 'all') return true;
      if (filterStatus === 'running') return !r.outcome;
      if (filterStatus === 'completed') return r.outcome === 'success';
      if (filterStatus === 'failed') return r.outcome === 'failure' || r.outcome === 'timeout';
      return true;
    })
    .slice(0, limit);

  const activeTerminals = context?.activeTerminals || [];
  const activeSubagents = context?.activeSubagents || [];

  const summaryEs = `Hay ${filteredRuns.length} ejecuciones recientes en el registro, ${activeTerminals.length} terminales y ${activeSubagents.length} subagentes en contexto.`;
  return {
    actionIdx,
    type: 'peek_runs',
    ok: true,
    summaryEs,
    spokenSummaryEs: summaryEs,
    data: {
      runs: filteredRuns,
      activeTerminalsCount: activeTerminals.length,
      activeSubagentsCount: activeSubagents.length,
    },
  };
}

export async function executePeekAgentsAction(
  action: PeekAgentsAction,
  actionIdx: number = 0,
  context?: TurnContext
): Promise<ActionReceipt> {
  const scope = action.scope ?? 'all';
  let subagents = context?.activeSubagents || [];
  const terminals = context?.activeTerminals || [];
  const threads = context?.activeThreads || [];
  let autonomous = context?.autonomousAgents || [];
  let routines: Array<{ id: string; name: string; enabled: boolean; agentId?: string }> = [];
  let swarmTitle: string | undefined;
  let swarmMembersCount = 0;
  let liveRefreshed = false;

  if (hasTauriRuntime()) {
    const [subRes, agentsRes, routinesRes, swarmRes] = await Promise.all([
      scope === 'all' || scope === 'subagents'
        ? withPeekTimeout(
            ipc.listAllSubagentRuns({ workspaceId: context?.workspaceId ?? null, limit: 24 }),
            PEEK_TIMEOUT_MS,
            null
          )
        : Promise.resolve({ value: null, timedOut: false }),
      scope === 'all' || scope === 'autonomous'
        ? withPeekTimeout(ipc.listAgentProfiles(), PEEK_TIMEOUT_MS, null)
        : Promise.resolve({ value: null, timedOut: false }),
      scope === 'all' || scope === 'autonomous'
        ? withPeekTimeout(ipc.listRoutines(), PEEK_TIMEOUT_MS, null)
        : Promise.resolve({ value: null, timedOut: false }),
      (scope === 'all' || scope === 'subagents') && context?.boundThreadId
        ? withPeekTimeout(ipc.getThreadSwarmState(context.boundThreadId), PEEK_TIMEOUT_MS, null)
        : Promise.resolve({ value: null, timedOut: false }),
    ]);

    if (!subRes.timedOut && subRes.value && Array.isArray(subRes.value.runs)) {
      liveRefreshed = true;
      subagents = subRes.value.runs.map((entry) => ({
        id: entry.run.childThreadId || entry.run.subagentId,
        role: entry.run.role || entry.threadTitle || 'Subagent',
        provider: entry.run.provider || 'claude',
        status: entry.run.status || 'running',
        parentThreadId: entry.run.parentThreadId || entry.threadId,
        title: entry.threadTitle,
        latestActivity: entry.run.latestActivity || entry.run.prompt || undefined,
        updatedAtUnixMs: entry.run.updatedAtUnixMs || Date.now(),
      }));
    }

    if (!agentsRes.timedOut && Array.isArray(agentsRes.value)) {
      liveRefreshed = true;
      autonomous = agentsRes.value.map((ag: any) => ({
        id: String(ag.id),
        name: String(ag.name || ag.id),
        engine: String(ag.engine || 'claude'),
        status: String(ag.status || 'idle'),
        activeThreadId: typeof ag.activeThreadId === 'string' ? ag.activeThreadId : undefined,
      }));
    }

    if (!routinesRes.timedOut && routinesRes.value && Array.isArray((routinesRes.value as any).routines)) {
      liveRefreshed = true;
      routines = (routinesRes.value as any).routines.map((r: any) => ({
        id: String(r.id),
        name: String(r.name || r.id),
        enabled: Boolean(r.enabled),
        agentId: typeof r.agentId === 'string' ? r.agentId : undefined,
      }));
    }

    if (!swarmRes.timedOut && swarmRes.value && typeof swarmRes.value === 'object') {
      liveRefreshed = true;
      const sv = swarmRes.value as any;
      if (typeof sv.title === 'string' && sv.title.trim()) {
        swarmTitle = sv.title.trim();
      }
      if (Array.isArray(sv.members)) {
        swarmMembersCount = sv.members.length;
      }
    }
  }

  const wc = context?.boundThreadId ? getSessionWorkingContext(context.boundThreadId) : null;

  const parts: string[] = [];
  if (scope === 'all' || scope === 'subagents') {
    parts.push(`${subagents.length} subagentes`);
  }
  if (scope === 'all' || scope === 'terminals') {
    parts.push(`${terminals.length} terminales`);
  }
  if (scope === 'all' || scope === 'threads') {
    parts.push(`${threads.length} hilos`);
  }
  if (scope === 'all' || scope === 'autonomous') {
    parts.push(`${autonomous.length} agentes autónomos`);
    if (routines.length > 0) {
      parts.push(`${routines.length} rutinas`);
    }
  }
  if (swarmTitle) {
    parts.push(`swarm "${swarmTitle}" (${swarmMembersCount} miembros)`);
  }

  const summaryEs = `Estado actual del workspace: ${parts.join(', ')}.`;
  return {
    actionIdx,
    type: 'peek_agents',
    ok: true,
    summaryEs,
    spokenSummaryEs: summaryEs,
    data: {
      scope,
      liveRefreshed,
      subagents,
      terminals,
      threads,
      autonomousAgents: autonomous,
      routinesCount: routines.length,
      routines: routines.slice(0, 8),
      ...(swarmTitle ? { swarmTitle, swarmMembersCount } : {}),
      findingsCount: wc?.findings.length ?? 0,
    },
  };
}

export async function executePeekFilesAction(
  action: PeekFilesAction,
  actionIdx: number = 0,
  context?: TurnContext
): Promise<ActionReceipt> {
  const mode = action.mode || 'signatures';
  const { value: compact, timedOut } = await withPeekTimeout(
    ctxClient.readCompact(action.path, {
      mode,
      startLine: action.startLine,
      endLine: action.endLine,
      workspaceId: context?.workspaceId,
    }),
    PEEK_TIMEOUT_MS,
    { path: action.path, mode, content: '', source: 'fallback' as const }
  );

  const fileLabel = basenameOf(action.path);
  if (timedOut) {
    const msg = `La lectura rápida de ${fileLabel} excedió el presupuesto de tiempo.`;
    return {
      actionIdx,
      type: 'peek_files',
      ok: true,
      summaryEs: msg,
      spokenSummaryEs: msg,
      data: { path: action.path, mode, content: '', timedOut: true },
    };
  }

  const hasContent = Boolean(compact.content && compact.content.trim().length > 0);
  const summaryEs = hasContent
    ? `Inspeccioné ${fileLabel} en modo ${mode} (${compact.content.length} caracteres).`
    : `No encontré contenido compacto disponible para ${fileLabel}.`;
  const spokenSummaryEs = hasContent
    ? `Ya revisé ${fileLabel} en modo ${mode}.`
    : `No pude leer detalles de ${fileLabel} en este entorno.`;

  return {
    actionIdx,
    type: 'peek_files',
    ok: true,
    summaryEs,
    spokenSummaryEs,
    data: compact,
  };
}

export async function executePeekSearchAction(
  action: PeekSearchAction,
  actionIdx: number = 0,
  context?: TurnContext
): Promise<ActionReceipt> {
  const query = (action.query || '').trim();
  const kind = action.kind || 'text';
  const limit = Math.max(1, Math.min(30, action.limit ?? 10));

  if (!query) {
    return {
      actionIdx,
      type: 'peek_search',
      ok: false,
      summaryEs: 'Necesito un texto o símbolo para buscar.',
      spokenSummaryEs: 'Decime qué texto o símbolo querés que busque.',
      error: 'missing_query',
    };
  }

  let matches: Array<{ path: string; line?: number; snippet?: string }> = [];
  let source: 'tauri' | 'fallback' = 'fallback';
  let timedOut = false;

  if (hasTauriRuntime()) {
    const res = await withPeekTimeout<{
      matches?: Array<{ path?: string; file?: string; line?: number; snippet?: string; text?: string }>;
      results?: Array<{ path?: string; file?: string; line?: number; snippet?: string; text?: string }>;
    } | null>(
      ipc.invokeCommand('ctx_search', {
        query,
        ...(action.path ? { path: action.path } : {}),
        kind,
        limit,
        ...(context?.workspaceId ? { workspaceId: context.workspaceId } : {}),
      }),
      PEEK_TIMEOUT_MS,
      null
    );
    timedOut = res.timedOut;
    const rawList = res.value?.matches ?? res.value?.results;
    if (Array.isArray(rawList)) {
      source = 'tauri';
      matches = rawList.slice(0, limit).map((item) => ({
        path: String(item.path || item.file || ''),
        ...(typeof item.line === 'number' ? { line: item.line } : {}),
        ...(typeof (item.snippet ?? item.text) === 'string'
          ? { snippet: String(item.snippet ?? item.text).trim().slice(0, 180) }
          : {}),
      }));
    }
  }

  if (matches.length === 0 && !timedOut) {
    const fallbackStore = (ctxClient as unknown as { compactFileFallbackStore?: Map<string, string> })
      .compactFileFallbackStore;
    if (fallbackStore && fallbackStore instanceof Map) {
      const needle = query.toLowerCase();
      for (const [filePath, body] of fallbackStore.entries()) {
        if (action.path && !filePath.toLowerCase().includes(action.path.toLowerCase())) {
          continue;
        }
        const lines = body.split(/\r?\n/);
        for (let idx = 0; idx < lines.length; idx++) {
          if (lines[idx].toLowerCase().includes(needle)) {
            matches.push({
              path: filePath,
              line: idx + 1,
              snippet: lines[idx].trim().slice(0, 180),
            });
            if (matches.length >= limit) break;
          }
        }
        if (matches.length >= limit) break;
      }
    }
    if (matches.length === 0 && action.path) {
      const compact = await ctxClient.readCompact(action.path, {
        mode: 'full',
        workspaceId: context?.workspaceId,
      });
      if (compact.content) {
        const needle = query.toLowerCase();
        const lines = compact.content.split(/\r?\n/);
        for (let idx = 0; idx < lines.length; idx++) {
          if (lines[idx].toLowerCase().includes(needle)) {
            matches.push({
              path: action.path,
              line: idx + 1,
              snippet: lines[idx].trim().slice(0, 180),
            });
            if (matches.length >= limit) break;
          }
        }
      }
    }
  }

  const summaryEs = timedOut
    ? `La búsqueda rápida de "${query}" superó el tiempo límite.`
    : matches.length > 0
      ? `Encontré ${matches.length} coincidencia${matches.length === 1 ? '' : 's'} para "${query}".`
      : `No encontré coincidencias para "${query}".`;

  return {
    actionIdx,
    type: 'peek_search',
    ok: true,
    summaryEs,
    spokenSummaryEs: summaryEs,
    data: {
      query,
      kind,
      source,
      timedOut,
      count: matches.length,
      matches,
    },
  };
}

export async function executeReadFindingAction(
  action: ReadFindingAction,
  actionIdx: number = 0,
  context?: TurnContext
): Promise<ActionReceipt> {
  const rawRef = (action.hashOrThreadId || '').trim();
  if (!rawRef) {
    return {
      actionIdx,
      type: 'read_finding',
      ok: false,
      summaryEs: 'Falta el identificador o hash CCR del hallazgo.',
      spokenSummaryEs: 'Decime qué hallazgo o subagente querés que lea.',
      error: 'missing_reference',
    };
  }

  const normalizedHash = rawRef.replace(/^<<ccr:/i, '').replace(/>>$/, '');
  const looksLikeCcr = /^<<ccr:/i.test(rawRef) || /^[a-f0-9]{6,64}$/i.test(normalizedHash);

  let content: string | null = null;
  let source: 'ccr' | 'share' | 'working_context' | 'dispatch' | 'none' = 'none';

  if (looksLikeCcr) {
    content = await ctxClient.ccrRetrieve(normalizedHash, {
      ...(action.lines ? { lines: action.lines } : {}),
      ...(action.search ? { search: action.search } : {}),
    });
    if (content) source = 'ccr';
  }

  if (!content) {
    const shareCandidates = [
      rawRef.startsWith('finding:') ? rawRef : `finding:${rawRef}`,
      rawRef,
    ];
    for (const key of shareCandidates) {
      const found = await ctxClient.shareGet(key);
      if (found) {
        content = found;
        source = 'share';
        break;
      }
    }
  }

  if (!content && context?.boundThreadId) {
    const wcMatch = findSubagentFindingInWorkingContext(context.boundThreadId, rawRef);
    if (wcMatch?.findingsSummary || wcMatch?.taskSummary) {
      content = wcMatch.findingsSummary || wcMatch.taskSummary;
      source = 'working_context';
    }
  }

  if (!content && hasTauriRuntime()) {
    const res = await withPeekTimeout<{
      content?: string;
      text?: string;
      output?: string;
      messages?: Array<{ content?: string }>;
    } | null>(
      ipc.invokeCommand('dispatch_read', {
        target: rawRef.startsWith('thread:') ? rawRef : `thread:${rawRef}`,
        ...(action.lines ? { lines: action.lines } : {}),
      }),
      PEEK_TIMEOUT_MS,
      null
    );
    const val = res.value;
    if (val) {
      const text =
        val.content ??
        val.text ??
        val.output ??
        (Array.isArray(val.messages)
          ? val.messages
              .map((m) => m.content || '')
              .filter(Boolean)
              .join('\n')
          : '');
      if (text && text.trim()) {
        content = text.trim();
        source = 'dispatch';
      }
    }
  }

  if (!content) {
    const msg = `No encontré hallazgos almacenados para "${rawRef}".`;
    return {
      actionIdx,
      type: 'read_finding',
      ok: false,
      summaryEs: msg,
      spokenSummaryEs: msg,
      error: 'finding_not_found',
      data: { hashOrThreadId: rawRef, source: 'none' },
    };
  }

  const ccrHash = source === 'ccr' ? normalizedHash : ctxClient.ccrStoreLocal(content);
  const summaryEs = `Recuperé el hallazgo de "${rawRef}" (${content.length} caracteres).`;
  const spokenSummaryEs = `Leí el hallazgo completo de ${rawRef}.`;

  return {
    actionIdx,
    type: 'read_finding',
    ok: true,
    summaryEs,
    spokenSummaryEs,
    data: {
      hashOrThreadId: rawRef,
      source,
      ccrHash,
      content,
    },
  };
}

export async function executeRecallConversationsAction(
  action: RecallConversationsAction,
  actionIdx: number = 0,
  context?: TurnContext
): Promise<ActionReceipt> {
  const limit = action.limit ?? 5;
  const query = (action.query || '').trim();

  const { value: catalog, timedOut } = await withPeekTimeout(
    fetchLiveChatCatalog(context?.workspaceId),
    PEEK_TIMEOUT_MS,
    { entries: [] }
  );

  if (timedOut || catalog.entries.length === 0) {
    const summaryEs = timedOut
      ? 'La búsqueda de conversaciones previas superó el tiempo límite.'
      : 'No hay conversaciones previas registradas en este proyecto.';
    return {
      actionIdx,
      type: 'recall_conversations',
      ok: true,
      summaryEs,
      spokenSummaryEs: summaryEs,
      data: { entries: [], timedOut },
    };
  }

  const boundedCatalog = { entries: catalog.entries.slice(0, limit) };
  const result = await withPeekTimeout(
    consultChats(query || 'conversaciones recientes', boundedCatalog, liveChatReader),
    PEEK_TIMEOUT_MS,
    { kind: 'index' as const, entries: boundedCatalog.entries, text: '' }
  );

  const chatResult = result.value;
  let summaryEs = 'Revisé las conversaciones recientes del proyecto.';
  if (chatResult.kind === 'read') {
    summaryEs = `Encontré la conversación "${chatResult.entry.title}" (${chatResult.entry.cli}).`;
  } else if (chatResult.kind === 'index') {
    summaryEs = `Encontré ${chatResult.entries.length} conversaciones recientes en este proyecto.`;
  } else if (chatResult.kind === 'miss') {
    summaryEs = `No encontré ninguna conversación que coincida con "${chatResult.named}".`;
  }

  return {
    actionIdx,
    type: 'recall_conversations',
    ok: true,
    summaryEs,
    spokenSummaryEs: summaryEs,
    data: chatResult,
  };
}

export type ProposalStepRunner = (
  action: OperatorContractAction,
  idx: number,
  context?: TurnContext,
  turnId?: string
) => Promise<ActionReceipt>;

let registeredStepRunner: ProposalStepRunner | null = null;

export function registerProposalStepExecutor(runner: ProposalStepRunner): void {
  registeredStepRunner = runner;
}

function normalizeDraftSteps(rawSteps?: DraftStepInput[]): DraftExecutionStep[] | undefined {
  if (!rawSteps || rawSteps.length === 0) return undefined;
  return rawSteps.slice(0, 5).map((s, idx) => ({
    stepId: s.stepId?.trim() || `step-${idx + 1}`,
    title: s.title.trim(),
    action: s.action,
    ...(Array.isArray(s.dependsOn) && s.dependsOn.length > 0 ? { dependsOn: s.dependsOn } : {}),
    enabled: s.enabled !== false,
    status: 'pending',
  }));
}

export async function executeProposeTaskAction(
  action: ProposeTaskAction,
  actionIdx: number = 0,
  context?: TurnContext
): Promise<ActionReceipt> {
  const scopeKey = resolveProposalScope(context);
  const now = Date.now();
  const normalizedSteps = normalizeDraftSteps(action.steps);
  const proposal: DraftTaskProposal = {
    proposalId: `prop-${now}-${Math.random().toString(36).slice(2, 6)}`,
    status: 'awaiting_confirmation',
    targetKind: action.targetKind || 'subagent',
    title: action.title.trim(),
    taskBrief: action.taskBrief.trim(),
    ...(action.role ? { role: action.role } : {}),
    ...(action.provider ? { provider: action.provider } : {}),
    ...(action.mode ? { mode: action.mode } : {}),
    ...(action.oddMode !== undefined ? { oddMode: action.oddMode } : {}),
    ...(action.workspaceMode ? { workspaceMode: action.workspaceMode } : {}),
    ...(action.questionForUser ? { questionForUser: action.questionForUser } : {}),
    ...(action.contextRefs ? { contextRefs: action.contextRefs } : {}),
    ...(normalizedSteps ? { steps: normalizedSteps } : {}),
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };

  voiceSessionStore.setDraftProposal(scopeKey, proposal);
  voiceSessionStore.setHandsFreeReplyWindow(HANDS_FREE_REPLY_WINDOW_MS, now);
  void ctxClient.sharePut(`proposal:${proposal.proposalId}`, JSON.stringify(proposal)).catch(() => {});

  const stepsTail = normalizedSteps
    ? ` (${normalizedSteps.length} pasos)`
    : '';
  const questionTail = action.questionForUser?.trim()
    ? action.questionForUser.trim()
    : '¿Confirmás que lo lance así o querés ajustar algo?';
  const spokenSummaryEs = `Propongo ${proposal.title}${stepsTail}. ${questionTail}`;

  return {
    actionIdx,
    type: 'propose_task',
    ok: true,
    summaryEs: `Propuesta creada (${proposal.proposalId}): ${proposal.title}`,
    spokenSummaryEs,
    data: proposal,
  };
}

export async function executeRefineProposalAction(
  action: RefineProposalAction,
  actionIdx: number = 0,
  context?: TurnContext
): Promise<ActionReceipt> {
  const scopeKey = resolveProposalScope(context);
  const existing = voiceSessionStore.getDraftProposal(scopeKey);
  if (!existing) {
    if (action.title && action.taskBrief) {
      return executeProposeTaskAction(
        {
          type: 'propose_task',
          targetKind: action.targetKind || 'subagent',
          title: action.title,
          taskBrief: action.taskBrief,
          role: action.role,
          provider: action.provider,
          mode: action.mode,
          oddMode: action.oddMode,
          workspaceMode: action.workspaceMode,
          questionForUser: action.questionForUser,
          contextRefs: action.contextRefs,
          ...(action.steps ? { steps: action.steps } : {}),
        },
        actionIdx,
        context
      );
    }
    return {
      actionIdx,
      type: 'refine_proposal',
      ok: false,
      summaryEs: 'No hay ninguna propuesta activa para refinar.',
      spokenSummaryEs: 'No tengo ninguna propuesta activa en este momento. ¿Qué tarea querés armar?',
      error: 'no_active_proposal',
    };
  }

  let nextSteps = existing.steps ? [...existing.steps] : undefined;
  if (action.steps) {
    nextSteps = normalizeDraftSteps(action.steps);
  } else if (
    nextSteps &&
    (action.stepIndex !== undefined ||
      action.stepId !== undefined ||
      action.stepEnabled !== undefined ||
      action.stepTitle !== undefined ||
      action.stepActionPatch !== undefined)
  ) {
    const targetIdx =
      action.stepId !== undefined
        ? nextSteps.findIndex((s) => s.stepId === action.stepId)
        : action.stepIndex !== undefined
          ? action.stepIndex - 1
          : -1;

    if (targetIdx < 0 || targetIdx >= nextSteps.length) {
      return {
        actionIdx,
        type: 'refine_proposal',
        ok: false,
        summaryEs: `No encontré ese paso en el plan actual (${nextSteps.length} pasos).`,
        spokenSummaryEs: `No encontré ese número de paso; el plan tiene ${nextSteps.length} pasos.`,
        error: 'step_not_found',
      };
    }

    const currentStep = nextSteps[targetIdx];
    nextSteps[targetIdx] = {
      ...currentStep,
      ...(action.stepEnabled !== undefined ? { enabled: action.stepEnabled } : {}),
      ...(action.stepTitle?.trim() ? { title: action.stepTitle.trim() } : {}),
      ...(action.stepActionPatch
        ? { action: { ...currentStep.action, ...action.stepActionPatch } }
        : {}),
    };
  }

  const patch: Partial<DraftTaskProposal> = {
    status: 'awaiting_confirmation',
    ...(action.targetKind ? { targetKind: action.targetKind } : {}),
    ...(action.title ? { title: action.title.trim() } : {}),
    ...(action.taskBrief ? { taskBrief: action.taskBrief.trim() } : {}),
    ...(action.role !== undefined ? { role: action.role } : {}),
    ...(action.provider !== undefined ? { provider: action.provider } : {}),
    ...(action.mode !== undefined ? { mode: action.mode } : {}),
    ...(action.oddMode !== undefined ? { oddMode: action.oddMode } : {}),
    ...(action.workspaceMode !== undefined ? { workspaceMode: action.workspaceMode } : {}),
    ...(action.questionForUser !== undefined ? { questionForUser: action.questionForUser } : {}),
    ...(action.contextRefs !== undefined ? { contextRefs: action.contextRefs } : {}),
    ...(nextSteps !== undefined ? { steps: nextSteps } : {}),
  };

  const updated = voiceSessionStore.updateDraftProposal(scopeKey, patch);
  voiceSessionStore.setHandsFreeReplyWindow(HANDS_FREE_REPLY_WINDOW_MS);

  if (!updated) {
    return {
      actionIdx,
      type: 'refine_proposal',
      ok: false,
      summaryEs: 'No pude actualizar la propuesta activa.',
      error: 'refine_failed',
    };
  }

  void ctxClient.sharePut(`proposal:${updated.proposalId}`, JSON.stringify(updated)).catch(() => {});

  const questionTail = updated.questionForUser?.trim() || '¿Lo confirmamos así?';
  const spokenSummaryEs = `Actualicé la propuesta para ${updated.title}. ${questionTail}`;

  return {
    actionIdx,
    type: 'refine_proposal',
    ok: true,
    summaryEs: `Propuesta actualizada (rev ${updated.revision}): ${updated.title}`,
    spokenSummaryEs,
    data: updated,
  };
}

async function executeMultiStepPlanProposal(
  proposal: DraftTaskProposal,
  scopeKey: string,
  actionIdx: number,
  context?: TurnContext
): Promise<ActionReceipt> {
  const runner = registeredStepRunner;
  if (!runner) {
    voiceSessionStore.clearDraftProposal(scopeKey);
    return {
      actionIdx,
      type: 'confirm_proposal',
      ok: false,
      summaryEs: 'El ejecutor de pasos del plan no está inicializado.',
      error: 'step_runner_unregistered',
    };
  }

  const initialSteps = (proposal.steps || []).map((s) => ({ ...s }));
  const enabledCount = initialSteps.filter((s) => s.enabled).length;
  if (enabledCount === 0) {
    return {
      actionIdx,
      type: 'confirm_proposal',
      ok: false,
      summaryEs: 'No hay ningún paso habilitado para ejecutar en el plan.',
      spokenSummaryEs: 'Todos los pasos del plan están desactivados; habilitá al menos uno o cancelalo.',
      error: 'no_enabled_steps',
    };
  }

  voiceSessionStore.updateDraftProposal(scopeKey, {
    status: 'executing',
    steps: initialSteps,
  });

  const stepMap = new Map<string, DraftExecutionStep>();
  for (const s of initialSteps) {
    if (!s.enabled) {
      s.status = 'skipped';
      voiceSessionStore.updateDraftProposalStep(scopeKey, s.stepId, { status: 'skipped' });
    }
    stepMap.set(s.stepId, s);
  }

  const turnId = `plan-${proposal.proposalId}`;
  const remaining = new Set(initialSteps.filter((s) => s.enabled).map((s) => s.stepId));
  let anyFailed = false;

  while (remaining.size > 0) {
    const ready: DraftExecutionStep[] = [];
    const blockedByFailure: DraftExecutionStep[] = [];

    for (const stepId of remaining) {
      const step = stepMap.get(stepId)!;
      const deps = step.dependsOn || [];
      let hasFailedDep = false;
      let allDepsSettled = true;

      for (const depId of deps) {
        const dep = stepMap.get(depId);
        if (!dep) continue;
        if (dep.status === 'failed') {
          hasFailedDep = true;
          break;
        }
        if (dep.status === 'pending' || dep.status === 'running') {
          allDepsSettled = false;
          break;
        }
      }

      if (hasFailedDep) {
        blockedByFailure.push(step);
      } else if (allDepsSettled) {
        ready.push(step);
      }
    }

    for (const skipped of blockedByFailure) {
      remaining.delete(skipped.stepId);
      skipped.status = 'skipped';
      skipped.error = 'dependency_failed';
      voiceSessionStore.updateDraftProposalStep(scopeKey, skipped.stepId, {
        status: 'skipped',
        error: 'dependency_failed',
      });
    }

    if (ready.length === 0) {
      if (remaining.size > 0) {
        anyFailed = true;
        for (const cyclicId of remaining) {
          const cyc = stepMap.get(cyclicId)!;
          cyc.status = 'failed';
          cyc.error = 'cyclic_dependency';
          voiceSessionStore.updateDraftProposalStep(scopeKey, cyc.stepId, {
            status: 'failed',
            error: 'cyclic_dependency',
          });
        }
        remaining.clear();
      }
      break;
    }

    for (const step of ready) {
      remaining.delete(step.stepId);
      step.status = 'running';
      voiceSessionStore.updateDraftProposalStep(scopeKey, step.stepId, { status: 'running' });
    }

    const waveResults = await Promise.allSettled(
      ready.map(async (step, waveIdx) => {
        const parsed = ActionSchema.safeParse(step.action);
        if (!parsed.success) {
          return {
            step,
            receipt: {
              actionIdx: waveIdx,
              type: String(step.action?.type || 'unknown'),
              ok: false,
              summaryEs: `Acción inválida en paso "${step.title}".`,
              error: 'invalid_step_action',
            } as ActionReceipt,
          };
        }
        const receipt = await runner(parsed.data, waveIdx, context, turnId);
        return { step, receipt };
      })
    );

    for (let i = 0; i < ready.length; i++) {
      const step = ready[i];
      const settled = waveResults[i];
      if (settled.status === 'fulfilled' && settled.value.receipt.ok) {
        step.status = 'done';
        step.summaryEs = settled.value.receipt.summaryEs;
        voiceSessionStore.updateDraftProposalStep(scopeKey, step.stepId, {
          status: 'done',
          summaryEs: step.summaryEs,
        });
      } else {
        anyFailed = true;
        const errMsg =
          settled.status === 'fulfilled'
            ? settled.value.receipt.error || settled.value.receipt.summaryEs
            : settled.reason instanceof Error
              ? settled.reason.message
              : String(settled.reason || 'step_error');
        step.status = 'failed';
        step.error = errMsg;
        voiceSessionStore.updateDraftProposalStep(scopeKey, step.stepId, {
          status: 'failed',
          error: errMsg,
        });
      }
    }
  }

  const finalSteps = initialSteps.map((s) => stepMap.get(s.stepId)!);
  const doneCount = finalSteps.filter((s) => s.status === 'done').length;
  const failedCount = finalSteps.filter((s) => s.status === 'failed').length;

  voiceSessionStore.updateDraftProposal(scopeKey, {
    status: 'confirmed',
    steps: finalSteps,
  });
  voiceSessionStore.clearDraftProposal(scopeKey);

  const ok = !anyFailed && failedCount === 0;
  const spokenSummaryEs = ok
    ? `Completé el plan "${proposal.title}": ${doneCount} de ${enabledCount} pasos ejecutados.`
    : `El plan "${proposal.title}" terminó con ${failedCount} error${failedCount === 1 ? '' : 'es'} (${doneCount} de ${enabledCount} pasos completados).`;

  return {
    actionIdx,
    type: 'confirm_proposal',
    ok,
    summaryEs: spokenSummaryEs,
    spokenSummaryEs,
    ...(ok ? {} : { error: 'multi_step_partial_failure' }),
    data: {
      proposalId: proposal.proposalId,
      targetKind: proposal.targetKind,
      multiStep: true,
      stepResults: finalSteps,
    },
  };
}

export async function executeConfirmProposalAction(
  _action: ConfirmProposalAction,
  actionIdx: number = 0,
  context?: TurnContext
): Promise<ActionReceipt> {
  const scopeKey = resolveProposalScope(context);
  const proposal = voiceSessionStore.getDraftProposal(scopeKey);
  if (!proposal) {
    return {
      actionIdx,
      type: 'confirm_proposal',
      ok: false,
      summaryEs: 'No hay ninguna propuesta pendiente para confirmar.',
      spokenSummaryEs: 'No hay ninguna propuesta pendiente para confirmar.',
      error: 'no_active_proposal',
    };
  }

  if (proposal.steps && proposal.steps.length > 0) {
    return executeMultiStepPlanProposal(proposal, scopeKey, actionIdx, context);
  }

  voiceSessionStore.updateDraftProposal(scopeKey, { status: 'confirmed' });
  voiceSessionStore.clearDraftProposal(scopeKey);

  let delegatedReceipt: ActionReceipt;
  if (proposal.targetKind === 'thread') {
    delegatedReceipt = await executeLaunchThreadAction(
      {
        type: 'launch_thread',
        provider: proposal.provider as Engine | undefined,
        title: proposal.title,
        body: proposal.taskBrief,
        oddMode: proposal.oddMode,
      },
      actionIdx,
      context
    );
  } else if (proposal.targetKind === 'agent') {
    delegatedReceipt = await executeLaunchAgentAction(
      {
        type: 'launch_agent',
        agentQuery: proposal.role || proposal.title,
        provider: proposal.provider as Engine | undefined,
        body: proposal.taskBrief,
        oddMode: proposal.oddMode,
      },
      actionIdx,
      context
    );
  } else if (proposal.targetKind === 'terminal') {
    delegatedReceipt = await executeOpenTerminalsAction(
      {
        count: 1,
        engine: (proposal.provider as Engine | undefined) || 'powershell',
        prompts: [proposal.taskBrief],
      },
      context,
      undefined,
      actionIdx
    );
  } else {
    delegatedReceipt = await executeSpawnSubagentAction(
      {
        type: 'spawn_subagent',
        provider: proposal.provider as Engine | undefined,
        role: proposal.role,
        workspace: proposal.workspaceMode,
        via: 'thread',
        mode: (proposal.mode as SubagentDelegationMode | undefined) || (proposal.oddMode ? 'odd' : 'explore'),
        oddMode: proposal.oddMode,
        task: proposal.taskBrief,
        alreadyAnnounced: true,
      },
      actionIdx,
      context
    );
  }

  if (!delegatedReceipt.ok) {
    return {
      actionIdx,
      type: 'confirm_proposal',
      ok: false,
      summaryEs: delegatedReceipt.summaryEs,
      spokenSummaryEs: delegatedReceipt.spokenSummaryEs ?? delegatedReceipt.summaryEs,
      error: delegatedReceipt.error,
      data: {
        proposalId: proposal.proposalId,
        targetKind: proposal.targetKind,
        delegatedReceipt,
      },
    };
  }

  const spokenSummaryEs = `Confirmado, ya lancé ${proposal.title} en segundo plano.`;
  return {
    actionIdx,
    type: 'confirm_proposal',
    ok: true,
    summaryEs: `Propuesta confirmada (${proposal.proposalId}): ${delegatedReceipt.summaryEs}`,
    spokenSummaryEs,
    data: {
      proposalId: proposal.proposalId,
      targetKind: proposal.targetKind,
      delegatedReceipt,
    },
  };
}

export async function executeCancelProposalAction(
  action: CancelProposalAction,
  actionIdx: number = 0,
  context?: TurnContext
): Promise<ActionReceipt> {
  const scopeKey = resolveProposalScope(context);
  const existing = voiceSessionStore.getDraftProposal(scopeKey);
  voiceSessionStore.clearDraftProposal(scopeKey);

  return {
    actionIdx,
    type: 'cancel_proposal',
    ok: true,
    summaryEs: existing
      ? `Propuesta "${existing.title}" cancelada.`
      : 'Propuesta cancelada.',
    spokenSummaryEs: 'Entendido, dejo esa propuesta cancelada.',
    data: {
      proposalId: action.proposalId || existing?.proposalId,
      reason: action.reason,
    },
  };
}

export function executeStaySilentAction(
  action: StaySilentAction,
  actionIdx: number = 0
): ActionReceipt {
  return {
    actionIdx,
    type: 'stay_silent',
    ok: true,
    silent: true,
    summaryEs: '',
    spokenSummaryEs: '',
    data: {
      silent: true,
      ...(action.reason ? { reason: action.reason } : {}),
    },
  };
}
