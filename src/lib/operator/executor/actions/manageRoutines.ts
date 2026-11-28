// Kite Code — Routines & Autonomous Schedules Control (`manage_routines`)
// Wired to `listRoutines`, `listAgentProfiles`, and `routines.rs` IPC commands
// (`create_routine`, `set_routine_enabled`, `run_routine_now`), honoring `allowAgentScheduling`
// and consultative `propose_task` confirmation for `create` or `permissionMode: 'fullAccess'`.

import * as ipc from '../../../ipc';
import type { AgentProfile, RoutineItem } from '../../../../types';
import type { ActionReceipt, ManageRoutinesAction, TurnContext } from '../../contract';
import { executeProposeTaskAction } from './peekWorkspace';

function hasTauriRuntime(): boolean {
  try {
    return typeof ipc.isTauriEnvironment === 'function' && ipc.isTauriEnvironment();
  } catch {
    return false;
  }
}

const MIN_INTERVAL_SECONDS = 900;

function generateRequestUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Deterministic RFC4122 v4 fallback when crypto.randomUUID is absent
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function resolveRoutineMatch(
  routines: RoutineItem[],
  routineId?: string,
  routineQuery?: string
): RoutineItem | null {
  if (routineId?.trim()) {
    const clean = routineId.trim().toLowerCase();
    const byId = routines.find((r) => r.id.toLowerCase() === clean);
    if (byId) return byId;
  }
  const q = (routineQuery || '').trim().toLowerCase();
  if (!q) return null;
  return (
    routines.find((r) => r.name.toLowerCase() === q) ||
    routines.find((r) => r.name.toLowerCase().includes(q)) ||
    null
  );
}

function resolveAgentMatch(
  agents: AgentProfile[],
  agentQuery?: string
): AgentProfile | null {
  if (agents.length === 0) return null;
  const q = (agentQuery || '').trim().toLowerCase();
  if (!q) return agents[0] ?? null;
  return (
    agents.find((a) => a.id.toLowerCase() === q || a.name.toLowerCase() === q) ||
    agents.find((a) => a.name.toLowerCase().includes(q)) ||
    null
  );
}

export async function executeManageRoutinesAction(
  action: ManageRoutinesAction,
  actionIdx: number = 0,
  context?: TurnContext
): Promise<ActionReceipt> {
  if (!hasTauriRuntime()) {
    const msg = 'La gestión de rutinas requiere el entorno nativo de Kite Code.';
    return {
      actionIdx,
      type: 'manage_routines',
      ok: false,
      summaryEs: msg,
      spokenSummaryEs: msg,
      error: 'tauri_unavailable',
    };
  }

  const collection = await ipc.listRoutines();
  const routines = collection?.routines || [];
  const revisions = collection?.agentRevisions || [];

  if (action.operation === 'list') {
    const items = routines.map((r) => ({
      id: r.id,
      name: r.name,
      agentId: r.agentId,
      enabled: r.enabled,
      permissionMode: (r as unknown as { permissionMode?: string }).permissionMode || 'readOnly',
      cadence: r.cadence,
    }));

    const spoken =
      items.length === 0
        ? 'No hay rutinas configuradas en este momento.'
        : `Hay ${items.length} rutina${items.length === 1 ? '' : 's'}: ${items
            .slice(0, 4)
            .map((r) => `${r.name} (${r.enabled ? 'activa' : 'pausada'})`)
            .join(', ')}.`;

    return {
      actionIdx,
      type: 'manage_routines',
      ok: true,
      summaryEs: spoken,
      spokenSummaryEs: spoken,
      data: { operation: 'list', count: items.length, routines: items },
    };
  }

  // Consultative gating for `create` or `permissionMode: 'fullAccess'`
  if (
    (action.operation === 'create' || action.permissionMode === 'fullAccess') &&
    !action.confirmed
  ) {
    const label = action.name || action.routineQuery || 'nueva rutina';
    const modeNote =
      action.permissionMode === 'fullAccess' ? ' con permiso fullAccess' : '';
    const proposalReceipt = await executeProposeTaskAction(
      {
        type: 'propose_task',
        targetKind: 'agent',
        title: `Rutina: ${label}${modeNote}`,
        taskBrief: (action.prompt || `Configurar rutina "${label}"`).trim(),
        role: action.agentQuery,
        questionForUser: `¿Confirmás que cree/actualice la rutina "${label}"${modeNote}?`,
      },
      actionIdx,
      context
    );
    return {
      ...proposalReceipt,
      type: 'manage_routines',
      data: {
        operation: action.operation,
        requiresConfirmation: true,
        proposal: proposalReceipt.data,
      },
    };
  }

  if (action.operation === 'create') {
    const name = (action.name || '').trim();
    const prompt = (action.prompt || '').trim();
    if (!name || !prompt) {
      return {
        actionIdx,
        type: 'manage_routines',
        ok: false,
        summaryEs: 'Falta el nombre o el prompt para crear la rutina.',
        spokenSummaryEs: 'Decime el nombre y qué prompt tiene que ejecutar la rutina.',
        error: 'missing_routine_fields',
      };
    }

    const agents = await ipc.listAgentProfiles();
    const agent = resolveAgentMatch(agents, action.agentQuery);
    if (!agent) {
      return {
        actionIdx,
        type: 'manage_routines',
        ok: false,
        summaryEs: 'No encontré un agente autónomo para asignar la rutina.',
        spokenSummaryEs: 'No encontré ese agente para crear la rutina.',
        error: 'agent_not_found',
      };
    }

    if (agent.allowAgentScheduling === false) {
      const spoken = `El agente ${agent.name} tiene deshabilitada la programación de rutinas (allowAgentScheduling).`;
      return {
        actionIdx,
        type: 'manage_routines',
        ok: false,
        summaryEs: spoken,
        spokenSummaryEs: spoken,
        error: 'agent_scheduling_disabled',
      };
    }

    const expectedRevision = revisions.find((r) => r.agentId === agent.id)?.revision;
    if (!expectedRevision) {
      return {
        actionIdx,
        type: 'manage_routines',
        ok: false,
        summaryEs: `No pude obtener la revisión actual de rutinas para ${agent.name}.`,
        error: 'missing_agent_revision',
      };
    }

    const seconds = Math.max(MIN_INTERVAL_SECONDS, Math.round(action.intervalSeconds ?? 3600));
    const permissionMode = action.permissionMode || 'readOnly';

    await ipc.invokeCommand('create_routine', {
      agentId: agent.id,
      expectedRevision,
      draft: {
        name,
        prompt,
        cadence: { kind: 'interval', seconds },
        workspaceId: context?.workspaceId || null,
        permissionMode,
      },
    });

    const spoken = `Creé la rutina "${name}" para ${agent.name} cada ${Math.round(seconds / 60)} minutos.`;
    return {
      actionIdx,
      type: 'manage_routines',
      ok: true,
      summaryEs: spoken,
      spokenSummaryEs: spoken,
      data: {
        operation: 'create',
        agentId: agent.id,
        agentName: agent.name,
        name,
        intervalSeconds: seconds,
        permissionMode,
      },
    };
  }

  // `toggle` or `run_now`
  const target = resolveRoutineMatch(routines, action.routineId, action.routineQuery || action.name);
  if (!target) {
    const label = action.routineId || action.routineQuery || action.name || 'indicada';
    const spoken = `No encontré la rutina "${label}".`;
    return {
      actionIdx,
      type: 'manage_routines',
      ok: false,
      summaryEs: spoken,
      spokenSummaryEs: spoken,
      error: 'routine_not_found',
    };
  }

  const expectedRevision = revisions.find((r) => r.agentId === target.agentId)?.revision;
  if (!expectedRevision) {
    return {
      actionIdx,
      type: 'manage_routines',
      ok: false,
      summaryEs: `No tengo revisión de concurrencia para la rutina "${target.name}".`,
      error: 'missing_agent_revision',
    };
  }

  if (action.operation === 'toggle') {
    const nextEnabled = action.enabled !== undefined ? action.enabled : !target.enabled;
    await ipc.invokeCommand('set_routine_enabled', {
      agentId: target.agentId,
      routineId: target.id,
      expectedRevision,
      enabled: nextEnabled,
    });
    const spoken = `${nextEnabled ? 'Activé' : 'Pausé'} la rutina "${target.name}".`;
    return {
      actionIdx,
      type: 'manage_routines',
      ok: true,
      summaryEs: spoken,
      spokenSummaryEs: spoken,
      data: {
        operation: 'toggle',
        routineId: target.id,
        name: target.name,
        enabled: nextEnabled,
      },
    };
  }

  // `run_now`
  const requestId = generateRequestUuid();
  const res = await ipc.invokeCommand<{
    started?: boolean;
    replayed?: boolean;
    threadId?: string;
    runId?: string;
  }>('run_routine_now', {
    agentId: target.agentId,
    routineId: target.id,
    expectedRevision,
    requestId,
  });

  const spoken = `Lancé la rutina "${target.name}" ahora mismo.`;
  return {
    actionIdx,
    type: 'manage_routines',
    ok: true,
    summaryEs: spoken,
    spokenSummaryEs: spoken,
    data: {
      operation: 'run_now',
      routineId: target.id,
      name: target.name,
      threadId: res?.threadId,
      runId: res?.runId,
    },
  };
}
