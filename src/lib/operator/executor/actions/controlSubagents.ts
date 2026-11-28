// Kite Code — Active Subagent Lifecycle & Swarm Coordination (`control_subagent`, `coordinate_swarm`)
// Steers/cancels/reads findings of running subagents via canonical Tauri IPC and `CcrStore`,
// rejecting messages to killed/settled children per `dispatch/hook.rs` invariants.

import * as ipc from '../../../ipc';
import { ctxClient } from '../../context/ctxClient';
import type {
  ActionReceipt,
  ControlSubagentAction,
  CoordinateSwarmAction,
  TurnContext,
} from '../../contract';
import { executeReadFindingAction } from './peekWorkspace';

function hasTauriRuntime(): boolean {
  try {
    return typeof ipc.isTauriEnvironment === 'function' && ipc.isTauriEnvironment();
  } catch {
    return false;
  }
}

const SETTLED_SUBAGENT_STATUSES = new Set([
  'killed',
  'stopped',
  'cancelled',
  'canceled',
  'completed',
  'done',
  'succeeded',
  'failed',
  'error',
]);

interface ResolvedSubagent {
  subagentId: string;
  childThreadId?: string;
  parentThreadId: string;
  role: string;
  status: string;
  provider?: string;
}

async function resolveTargetSubagent(
  target: string | number,
  context?: TurnContext
): Promise<ResolvedSubagent | null> {
  const candidates: ResolvedSubagent[] = [];

  if (hasTauriRuntime()) {
    try {
      const snap = await ipc.listAllSubagentRuns({
        workspaceId: context?.workspaceId ?? null,
        limit: 40,
      });
      for (const entry of snap?.runs || []) {
        candidates.push({
          subagentId: entry.run.subagentId,
          childThreadId: entry.run.childThreadId || undefined,
          parentThreadId: entry.run.parentThreadId || entry.threadId,
          role: entry.run.role || entry.threadTitle || 'Subagent',
          status: (entry.run.status || 'running').toLowerCase(),
          provider: entry.run.provider || undefined,
        });
      }
    } catch {
      // Fallback to TurnContext below
    }
  }

  for (const s of context?.activeSubagents || []) {
    const already = candidates.some(
      (c) => c.subagentId === s.id || (c.childThreadId && c.childThreadId === s.id)
    );
    if (!already) {
      candidates.push({
        subagentId: s.id,
        childThreadId: s.id,
        parentThreadId: s.parentThreadId || context?.boundThreadId || '',
        role: s.role,
        status: (s.status || 'running').toLowerCase(),
        provider: s.provider,
      });
    }
  }

  if (candidates.length === 0) return null;

  if (typeof target === 'number') {
    const idx = Math.max(0, Math.floor(target) - 1);
    return candidates[idx] ?? null;
  }

  const clean = String(target || '').trim().toLowerCase();
  if (!clean) return candidates[0] ?? null;

  if (/^\d+$/.test(clean)) {
    const idx = Math.max(0, Number(clean) - 1);
    return candidates[idx] ?? null;
  }

  return (
    candidates.find(
      (c) =>
        c.subagentId.toLowerCase() === clean ||
        (c.childThreadId && c.childThreadId.toLowerCase() === clean) ||
        `thread:${c.childThreadId || ''}`.toLowerCase() === clean
    ) ||
    candidates.find((c) => c.role.toLowerCase() === clean) ||
    candidates.find((c) => c.role.toLowerCase().includes(clean)) ||
    null
  );
}

export async function executeControlSubagentAction(
  action: ControlSubagentAction,
  actionIdx: number = 0,
  context?: TurnContext
): Promise<ActionReceipt> {
  if (action.operation === 'read_finding') {
    const rawTarget = String(action.target ?? '').trim();
    if (!rawTarget) {
      return {
        actionIdx,
        type: 'control_subagent',
        ok: false,
        summaryEs: 'Necesito saber qué subagente o hash CCR querés leer.',
        spokenSummaryEs: 'Decime de qué subagente querés que lea el hallazgo.',
        error: 'missing_target',
      };
    }

    const isCcrOrThread =
      /^<<ccr:/i.test(rawTarget) ||
      /^[a-f0-9]{6,64}$/i.test(rawTarget) ||
      rawTarget.startsWith('thread:');
    let ref = rawTarget;
    if (!isCcrOrThread) {
      const resolved = await resolveTargetSubagent(action.target, context);
      if (resolved) {
        ref = resolved.childThreadId || resolved.subagentId;
        if (hasTauriRuntime() && resolved.parentThreadId) {
          try {
            const detail = await ipc.getThreadSubagentDetail(
              resolved.parentThreadId,
              resolved.subagentId
            );
            const lastText = detail?.items
              ?.map((it: any) => it?.text || it?.content || '')
              .filter(Boolean)
              .join('\n')
              .trim();
            if (lastText) {
              const ccrHash = ctxClient.ccrStoreLocal(lastText);
              const spoken = `Leí el resultado de ${resolved.role}.`;
              return {
                actionIdx,
                type: 'control_subagent',
                ok: true,
                summaryEs: `Hallazgo de ${resolved.role} (${lastText.length} caracteres).`,
                spokenSummaryEs: spoken,
                data: {
                  operation: 'read_finding',
                  subagentId: resolved.subagentId,
                  role: resolved.role,
                  ccrHash,
                  content: lastText,
                },
              };
            }
          } catch {
            // Fall through to executeReadFindingAction
          }
        }
      }
    }

    const findingReceipt = await executeReadFindingAction(
      {
        type: 'read_finding',
        hashOrThreadId: ref,
        ...(action.lines ? { lines: action.lines } : {}),
      },
      actionIdx,
      context
    );
    return {
      ...findingReceipt,
      type: 'control_subagent',
    };
  }

  const resolved = await resolveTargetSubagent(action.target, context);
  if (!resolved) {
    const msg = `No encontré ningún subagente que coincida con "${String(action.target)}".`;
    return {
      actionIdx,
      type: 'control_subagent',
      ok: false,
      summaryEs: msg,
      spokenSummaryEs: msg,
      error: 'subagent_not_found',
    };
  }

  const parentThreadId = resolved.parentThreadId || context?.boundThreadId || '';
  if (!parentThreadId && !hasTauriRuntime()) {
    return {
      actionIdx,
      type: 'control_subagent',
      ok: false,
      summaryEs: 'No hay un hilo activo asociado al subagente.',
      error: 'missing_parent_thread',
    };
  }

  if (action.operation === 'send') {
    if (SETTLED_SUBAGENT_STATUSES.has(resolved.status)) {
      const spoken = 'Ese subagente ya finalizó o fue detenido; ¿querés que lance uno nuevo?';
      return {
        actionIdx,
        type: 'control_subagent',
        ok: false,
        summaryEs: `El subagente ${resolved.role} está en estado "${resolved.status}" y no admite nuevos mensajes.`,
        spokenSummaryEs: spoken,
        error: 'subagent_already_settled',
        data: { subagentId: resolved.subagentId, status: resolved.status },
      };
    }

    const msgText = (action.message || '').trim();
    if (!msgText) {
      return {
        actionIdx,
        type: 'control_subagent',
        ok: false,
        summaryEs: 'Falta el mensaje para enviar al subagente.',
        spokenSummaryEs: 'Decime qué instrucción querés enviarle al subagente.',
        error: 'missing_message',
      };
    }

    if (!hasTauriRuntime()) {
      return {
        actionIdx,
        type: 'control_subagent',
        ok: false,
        summaryEs: 'El envío de mensajes a subagentes requiere Tauri.',
        error: 'tauri_unavailable',
      };
    }

    await ipc.sendSubagentMessage(parentThreadId, resolved.subagentId, msgText);
    const spoken = `Envié tu indicación al subagente ${resolved.role}.`;
    return {
      actionIdx,
      type: 'control_subagent',
      ok: true,
      summaryEs: spoken,
      spokenSummaryEs: spoken,
      data: {
        operation: 'send',
        parentThreadId,
        subagentId: resolved.subagentId,
        role: resolved.role,
      },
    };
  }

  // `cancel`
  if (!hasTauriRuntime()) {
    return {
      actionIdx,
      type: 'control_subagent',
      ok: false,
      summaryEs: 'La cancelación de subagentes requiere Tauri.',
      error: 'tauri_unavailable',
    };
  }

  try {
    await ipc.stopSubagentRun(parentThreadId, resolved.subagentId);
  } catch {
    await ipc.invokeCommand('dispatch_kill', {
      target: resolved.childThreadId ? `thread:${resolved.childThreadId}` : resolved.subagentId,
    });
  }

  const spoken = `Detuve al subagente ${resolved.role}.`;
  return {
    actionIdx,
    type: 'control_subagent',
    ok: true,
    summaryEs: spoken,
    spokenSummaryEs: spoken,
    data: {
      operation: 'cancel',
      parentThreadId,
      subagentId: resolved.subagentId,
      role: resolved.role,
    },
  };
}

export async function executeCoordinateSwarmAction(
  action: CoordinateSwarmAction,
  actionIdx: number = 0,
  context?: TurnContext
): Promise<ActionReceipt> {
  const threadId = context?.boundThreadId || '';
  if (!hasTauriRuntime()) {
    const msg = 'La coordinación de Swarms requiere el entorno nativo de Kite Code.';
    return {
      actionIdx,
      type: 'coordinate_swarm',
      ok: false,
      summaryEs: msg,
      spokenSummaryEs: msg,
      error: 'tauri_unavailable',
    };
  }

  if (action.operation === 'status') {
    if (!threadId) {
      return {
        actionIdx,
        type: 'coordinate_swarm',
        ok: false,
        summaryEs: 'No hay un hilo activo para consultar el estado del Swarm.',
        error: 'missing_thread',
      };
    }
    const state = await ipc.getThreadSwarmState(threadId);
    if (!state) {
      const msg = 'No hay ningún Swarm activo en este hilo.';
      return {
        actionIdx,
        type: 'coordinate_swarm',
        ok: true,
        summaryEs: msg,
        spokenSummaryEs: msg,
        data: { operation: 'status', active: false },
      };
    }
    const title = state.title || 'Swarm activo';
    const members = Array.isArray(state.members) ? state.members : [];
    const summaryEs = `Swarm "${title}" con ${members.length} miembro${members.length === 1 ? '' : 's'}.`;
    return {
      actionIdx,
      type: 'coordinate_swarm',
      ok: true,
      summaryEs,
      spokenSummaryEs: summaryEs,
      data: {
        operation: 'status',
        active: true,
        title,
        members,
      },
    };
  }

  if (action.operation === 'title') {
    const title = (action.swarmName || '').trim();
    if (!title) {
      return {
        actionIdx,
        type: 'coordinate_swarm',
        ok: false,
        summaryEs: 'Falta el nombre para titular el Swarm.',
        error: 'missing_swarm_name',
      };
    }
    await ctxClient.sharePut(`swarm:title:${threadId || 'default'}`, title);
    if (threadId) {
      await ipc.swarmPostFromUi(threadId, `[Swarm título]: ${title}`, action.channel ?? null).catch(() => {});
    }
    const spoken = `Swarm nombrado "${title}".`;
    return {
      actionIdx,
      type: 'coordinate_swarm',
      ok: true,
      summaryEs: spoken,
      spokenSummaryEs: spoken,
      data: { operation: 'title', swarmName: title },
    };
  }

  if (action.operation === 'add') {
    const members = action.members || [];
    if (members.length === 0) {
      return {
        actionIdx,
        type: 'coordinate_swarm',
        ok: false,
        summaryEs: 'Necesito al menos un miembro para agregar al Swarm.',
        spokenSummaryEs: 'Decime qué roles o proveedores querés agregar al Swarm.',
        error: 'missing_members',
      };
    }

    const spawned: Array<{ name: string; role: string; threadId?: string }> = [];
    for (const member of members) {
      const role = (member.role || member.name || 'Worker').trim();
      const brief = (member.brief || action.message || `Trabajar como ${member.name} en el Swarm`).trim();
      const res = await ipc.invokeCommand<{ threadId?: string; address?: string }>('dispatch_run', {
        via: 'thread',
        role,
        ...(member.provider ? { provider: member.provider } : {}),
        workspaceMode: member.workspace || 'inherit',
        task: brief,
        wait: false,
        caller: 'agent',
        ...(threadId ? { from: `thread:${threadId}`, parent: `thread:${threadId}` } : {}),
      });
      const tid =
        res?.threadId ||
        (res?.address?.startsWith('thread:') ? res.address.slice(7) : res?.address);
      spawned.push({ name: member.name, role, ...(tid ? { threadId: tid } : {}) });
    }

    const spoken = `Agregué ${spawned.length} miembro${spawned.length === 1 ? '' : 's'} al Swarm${action.swarmName ? ` "${action.swarmName}"` : ''}.`;
    return {
      actionIdx,
      type: 'coordinate_swarm',
      ok: true,
      summaryEs: spoken,
      spokenSummaryEs: spoken,
      data: {
        operation: 'add',
        swarmName: action.swarmName,
        members: spawned,
      },
    };
  }

  if (!threadId) {
    return {
      actionIdx,
      type: 'coordinate_swarm',
      ok: false,
      summaryEs: 'No hay un hilo activo para operar el Swarm.',
      error: 'missing_thread',
    };
  }

  if (action.operation === 'post') {
    const msg = (action.message || '').trim();
    if (!msg) {
      return {
        actionIdx,
        type: 'coordinate_swarm',
        ok: false,
        summaryEs: 'Falta el mensaje para publicar en el tablero del Swarm.',
        error: 'missing_message',
      };
    }
    const res = await ipc.swarmPostFromUi(threadId, msg, action.channel ?? null);
    const spoken = `Publiqué el mensaje en el Swarm.`;
    return {
      actionIdx,
      type: 'coordinate_swarm',
      ok: Boolean(res?.ok),
      summaryEs: spoken,
      spokenSummaryEs: spoken,
      data: { operation: 'post', swarmState: res?.swarmState ?? null },
    };
  }

  // `kill`
  const memberName = (action.targetMember || '').trim();
  if (!memberName) {
    return {
      actionIdx,
      type: 'coordinate_swarm',
      ok: false,
      summaryEs: 'Necesito el nombre del worker del Swarm a detener.',
      error: 'missing_target_member',
    };
  }
  const res = await ipc.swarmKillWorkerFromUi(threadId, memberName);
  const spoken = `Detuve al miembro "${memberName}" del Swarm.`;
  return {
    actionIdx,
    type: 'coordinate_swarm',
    ok: Boolean(res?.ok),
    summaryEs: spoken,
    spokenSummaryEs: spoken,
    data: { operation: 'kill', targetMember: memberName, swarmState: res?.swarmState ?? null },
  };
}
