// Kite Code — Execute Spawn Subagent Action
// Defaults to real Kite Thread Subagent dispatch (`dispatch_run --via thread`), anchored to the
// active voice thread (`parent: thread:<boundThreadId>`), distinguishing read-only `explore`
// from `odd` and `execute` modes, and registering the child run with `subagentReturnWatcher`.

import { invokeCommand } from '../../../ipc';
import { appOperatorController } from '../../appOperatorController';
import { ctxClient } from '../../context/ctxClient';
import type { ActionReceipt, SubagentDelegationMode, TurnContext } from '../../contract';
import { trackDelegatedSubagent } from '../../subagentReturnWatcher';
import { voiceSessionStore } from '../../voice/voiceSessionStore';
import { formatDelegatedTask, resolveDelegationMode } from './oddBrief';

export interface SpawnSubagentActionPayload {
  type?: 'spawn_subagent';
  cli?: string;
  provider?: string;
  role?: string;
  workspace?: 'inherit' | 'share' | 'branch';
  via?: 'thread' | 'terminal';
  mode?: SubagentDelegationMode;
  oddMode?: boolean;
  task: string;
  alreadyAnnounced?: boolean;
}

function normalizeThreadProvider(raw?: string): string | undefined {
  if (!raw) return undefined;
  const lower = raw.trim().toLowerCase();
  if (!lower || lower === 'powershell') return undefined;
  if (lower === 'open-code') return 'opencode';
  return lower;
}

function extractThreadId(address?: string, fallbackId?: string): string | undefined {
  if (fallbackId && fallbackId.trim()) return fallbackId.trim();
  if (!address) return undefined;
  return address.startsWith('thread:') ? address.slice('thread:'.length) : address;
}

export async function executeSpawnSubagentAction(
  args: SpawnSubagentActionPayload,
  actionIdx: number = 0,
  context?: TurnContext
): Promise<ActionReceipt> {
  const rawTask = (args.task || '').trim() || 'tarea delegada';
  const effectiveMode = resolveDelegationMode({
    mode: args.mode,
    oddMode: args.oddMode,
    targetKind: 'subagent',
  });
  const effectiveOddMode =
    effectiveMode === 'odd' || (args.oddMode === true && args.mode !== 'explore');

  const taskBody = formatDelegatedTask(rawTask, {
    mode: effectiveMode,
    oddMode: effectiveOddMode,
    targetKind: 'subagent',
  });
  const provider = normalizeThreadProvider(args.provider ?? args.cli);
  const role =
    (args.role || '').trim() ||
    (effectiveOddMode ? 'ODD Planner' : effectiveMode === 'explore' ? 'Explorer' : 'Subagent');
  const workspaceMode = args.workspace || 'inherit';

  if (args.via === 'terminal') {
    const cli = provider || args.cli || 'grok';
    const res = await appOperatorController.spawnTerminals({
      count: 1,
      engine: cli,
      prompts: [taskBody],
      titlePrefix: `[Subagente] ${cli}`,
    });

    const summaryEs = res.success
      ? `Inicié el subagente ${cli} en terminal para la tarea delegada.`
      : `No pude iniciar el subagente en terminal: ${res.message}`;

    return {
      actionIdx,
      type: 'spawn_subagent',
      ok: res.success,
      summaryEs,
      spokenSummaryEs: summaryEs,
      error: res.success ? undefined : res.message,
      data: { via: 'terminal', cli, role, mode: effectiveMode, oddMode: effectiveOddMode },
    };
  }

  // Default: dispatch a genuine Thread Subagent via Kite dispatch (`dispatch_run`)
  const vs = voiceSessionStore.getSnapshot();
  const parentThreadId = context?.boundThreadId || vs.boundThreadId || undefined;

  const payload: Record<string, unknown> = {
    via: 'thread',
    role,
    workspaceMode,
    task: taskBody,
    wait: false,
    caller: 'agent',
  };
  if (provider) {
    payload.provider = provider;
  }
  if (parentThreadId) {
    payload.from = `thread:${parentThreadId}`;
    payload.parent = `thread:${parentThreadId}`;
  }

  try {
    const res = await invokeCommand<{
      status?: string;
      address?: string;
      threadId?: string;
      error?: string;
      message?: string;
    }>('dispatch_run', payload);

    if (res?.status === 'rejected' || res?.status === 'failed' || res?.error) {
      const errMsg = res?.error || res?.message || res?.status || 'dispatch_rejected';
      return {
        actionIdx,
        type: 'spawn_subagent',
        ok: false,
        summaryEs: `No pude lanzar el subagente (${role}): ${errMsg}`,
        error: errMsg,
      };
    }

    const threadId = extractThreadId(res?.address, res?.threadId);

    // S2.3: Persist agreed task brief in SharedContextStore (`brief:<role>`) for fast subagent handoff
    void ctxClient.sharePut(`brief:${role}`, taskBody).catch(() => {});

    // S2: Register child subagent with the closed-loop return watcher so its findings
    // are read via `dispatch_read`, stored in Working Context, and spoken on completion.
    if (threadId) {
      trackDelegatedSubagent({
        childThreadId: threadId,
        parentThreadId,
        role,
        provider,
        mode: effectiveMode,
        task: rawTask,
        workspaceId: context?.workspaceId,
      });
    }

    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('kite:threads-changed'));
      } catch {}
    }

    const providerLabel = provider ? ` con ${provider.charAt(0).toUpperCase() + provider.slice(1)}` : '';
    const oddLabel = effectiveOddMode ? ' con enfoque ODD' : '';
    const modeLabel = effectiveMode === 'explore' ? ' (solo lectura)' : oddLabel;
    const summaryEs = `Subagente «${role}»${providerLabel}${modeLabel} iniciado en segundo plano.`;
    const spokenSummaryEs = args.alreadyAnnounced
      ? ''
      : effectiveMode === 'explore'
        ? `Mandé un subagente explorador${providerLabel} a revisar eso en segundo plano; apenas vuelva te cuento qué encontró.`
        : `Lancé el subagente ${role}${providerLabel}${oddLabel} en segundo plano; apenas termine te aviso con el resultado.`;

    return {
      actionIdx,
      type: 'spawn_subagent',
      ok: true,
      summaryEs,
      spokenSummaryEs,
      data: {
        via: 'thread',
        role,
        mode: effectiveMode,
        workspace: workspaceMode,
        ...(args.alreadyAnnounced ? { alreadyAnnounced: true } : {}),
        ...(provider ? { provider } : {}),
        ...(res?.address ? { address: res.address } : {}),
        ...(threadId ? { threadId } : {}),
        ...(parentThreadId ? { parentThreadId } : {}),
        oddMode: effectiveOddMode,
      },
    };
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    return {
      actionIdx,
      type: 'spawn_subagent',
      ok: false,
      summaryEs: `No pude lanzar el subagente (${role}): ${errMsg}`,
      error: errMsg,
    };
  }
}
