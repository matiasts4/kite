// Kite Code — Native Kite Tasks Operator Action (`manage_tasks`)
// Wired to `getTicketSnapshot()` and `ticketCall('save_issue', ...)` (`src/lib/ipc/tickets.ts`).
// Stamps `sourceAgent: 'Argos'` and `sourceThreadId` on creation, avoids raw UUIDs in spoken
// summaries, and requires consultative `propose_task` confirmation for bulk mutations.

import * as ipc from '../../../ipc';
import type { TicketIssue, TicketState } from '../../../../components/views/tickets/types';
import type { ActionReceipt, ManageTasksAction, TurnContext } from '../../contract';
import { executeProposeTaskAction } from './peekWorkspace';

function hasTauriRuntime(): boolean {
  try {
    return typeof ipc.isTauriEnvironment === 'function' && ipc.isTauriEnvironment();
  } catch {
    return false;
  }
}

export function normalizeTicketState(raw?: string): TicketState | undefined {
  if (!raw) return undefined;
  const lower = raw.trim().toLowerCase();
  if (lower === 'backlog' || lower === 'todo' || lower === 'to do' || lower === 'to_do') {
    return 'To Do';
  }
  if (lower === 'in progress' || lower === 'in_progress' || lower === 'doing') {
    return 'In Progress';
  }
  if (lower === 'review' || lower === 'in review') {
    return 'Review';
  }
  if (lower === 'done' || lower === 'completed' || lower === 'closed') {
    return 'Done';
  }
  return undefined;
}

function formatIssueSpoken(issue: Pick<TicketIssue, 'id' | 'title' | 'state'>): string {
  return `${issue.id} (${issue.title}, ${issue.state})`;
}

function resolveTargetIssue(
  issues: TicketIssue[],
  taskId?: string,
  query?: string
): { issue?: TicketIssue; ambiguous?: TicketIssue[]; notFound?: boolean } {
  const cleanId = (taskId || '').trim();
  if (cleanId) {
    const byId = issues.find(
      (i) => i.id.toLowerCase() === cleanId.toLowerCase() && !i.archivedAt
    );
    if (byId) return { issue: byId };
    return { notFound: true };
  }

  const cleanQuery = (query || '').trim().toLowerCase();
  if (!cleanQuery) return { notFound: true };

  const active = issues.filter((i) => !i.archivedAt);
  const exact = active.find(
    (i) => i.id.toLowerCase() === cleanQuery || i.title.trim().toLowerCase() === cleanQuery
  );
  if (exact) return { issue: exact };

  const matches = active.filter((i) => i.title.toLowerCase().includes(cleanQuery));
  if (matches.length === 1) return { issue: matches[0] };
  if (matches.length > 1) return { ambiguous: matches.slice(0, 5) };
  return { notFound: true };
}

export async function executeManageTasksAction(
  action: ManageTasksAction,
  actionIdx: number = 0,
  context?: TurnContext
): Promise<ActionReceipt> {
  if (!hasTauriRuntime()) {
    const msg = 'La gestión de Kite Tasks requiere el entorno nativo de Kite Code.';
    return {
      actionIdx,
      type: 'manage_tasks',
      ok: false,
      summaryEs: msg,
      spokenSummaryEs: msg,
      error: 'tauri_unavailable',
    };
  }

  if (action.operation === 'list') {
    const snapshot = await ipc.getTicketSnapshot();
    const stateTarget = normalizeTicketState(action.stateFilter);
    const queryLower = (action.query || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(20, action.limit ?? 10));

    const filtered = (snapshot?.issues || [])
      .filter((issue) => !issue.archivedAt)
      .filter((issue) => (!stateTarget ? true : issue.state === stateTarget))
      .filter((issue) =>
        !queryLower
          ? true
          : issue.title.toLowerCase().includes(queryLower) ||
            issue.id.toLowerCase().includes(queryLower) ||
            (issue.description || '').toLowerCase().includes(queryLower)
      )
      .slice(0, limit);

    const sanitized = filtered.map((i) => ({
      id: i.id,
      title: i.title,
      state: i.state,
      priority: i.priority,
      oddPath: i.oddPath ?? null,
    }));

    const summaryEs =
      sanitized.length === 0
        ? `No hay tareas${stateTarget ? ` en estado ${stateTarget}` : ''} que coincidan.`
        : `Hay ${sanitized.length} tarea${sanitized.length === 1 ? '' : 's'}${stateTarget ? ` en ${stateTarget}` : ''}: ${sanitized
            .slice(0, 4)
            .map(formatIssueSpoken)
            .join('; ')}.`;

    return {
      actionIdx,
      type: 'manage_tasks',
      ok: true,
      summaryEs,
      spokenSummaryEs: summaryEs,
      data: {
        operation: 'list',
        count: sanitized.length,
        issues: sanitized,
      },
    };
  }

  if (action.operation === 'create') {
    const title = (action.title || '').trim();
    if (!title) {
      return {
        actionIdx,
        type: 'manage_tasks',
        ok: false,
        summaryEs: 'Falta el título para crear la tarea en Kite Tasks.',
        spokenSummaryEs: 'Decime el título de la tarea que querés crear.',
        error: 'missing_title',
      };
    }

    const nextState = normalizeTicketState(action.state) ?? 'To Do';
    const payload: Record<string, unknown> = {
      title,
      description: (action.description || '').trim(),
      state: nextState,
      priority: action.priority || 'Medium',
      sourceAgent: 'Argos',
      ...(context?.boundThreadId ? { sourceThreadId: context.boundThreadId } : {}),
      ...(action.oddPath?.trim() ? { oddPath: action.oddPath.trim() } : {}),
    };

    const res = await ipc.ticketCall('save_issue', payload);
    const created = (res?.result || {}) as Partial<TicketIssue>;
    const createdId = created.id || 'nueva tarea';
    const createdTitle = created.title || title;

    if (!res?.ok) {
      const msg = `No pude crear la tarea "${title}" en Kite Tasks.`;
      return {
        actionIdx,
        type: 'manage_tasks',
        ok: false,
        summaryEs: msg,
        spokenSummaryEs: msg,
        error: 'ticket_create_failed',
      };
    }

    const spoken = `Creé la tarea ${createdId}: ${createdTitle} en ${nextState}.`;
    return {
      actionIdx,
      type: 'manage_tasks',
      ok: true,
      summaryEs: spoken,
      spokenSummaryEs: spoken,
      data: {
        operation: 'create',
        id: created.id,
        title: createdTitle,
        state: created.state || nextState,
        sourceAgent: 'Argos',
        sourceThreadId: context?.boundThreadId,
      },
    };
  }

  // `update` or `move_state`
  const bulkIds = (action.taskIds || []).filter((id) => Boolean(id && id.trim()));
  if (bulkIds.length > 1 && !action.confirmed) {
    const targetState = normalizeTicketState(action.state) || 'Done';
    const proposalReceipt = await executeProposeTaskAction(
      {
        type: 'propose_task',
        targetKind: 'agent',
        title: `Actualizar ${bulkIds.length} tareas (${bulkIds.join(', ')}) a ${targetState}`,
        taskBrief: `Mover ${bulkIds.join(', ')} a estado ${targetState}`,
        questionForUser: `Vas a mover ${bulkIds.length} tareas (${bulkIds.join(', ')}) a ${targetState}. ¿Confirmás que lo ejecute?`,
      },
      actionIdx,
      context
    );
    return {
      ...proposalReceipt,
      type: 'manage_tasks',
      data: {
        operation: action.operation,
        requiresConfirmation: true,
        taskIds: bulkIds,
        proposal: proposalReceipt.data,
      },
    };
  }

  const snapshot = await ipc.getTicketSnapshot();
  const resolved = resolveTargetIssue(
    snapshot?.issues || [],
    action.taskId || bulkIds[0],
    action.query || action.title
  );

  if (resolved.ambiguous) {
    const options = resolved.ambiguous.map((i) => `${i.id} (${i.title})`).join(', ');
    const spoken = `Encontré varias tareas parecidas: ${options}. ¿Cuál querés actualizar?`;
    return {
      actionIdx,
      type: 'manage_tasks',
      ok: false,
      summaryEs: spoken,
      spokenSummaryEs: spoken,
      error: 'ambiguous_task_target',
      data: {
        candidates: resolved.ambiguous.map((i) => ({ id: i.id, title: i.title, state: i.state })),
      },
    };
  }

  if (!resolved.issue) {
    const refLabel = action.taskId || action.query || action.title || 'indicada';
    const spoken = `No encontré la tarea "${refLabel}" en Kite Tasks.`;
    return {
      actionIdx,
      type: 'manage_tasks',
      ok: false,
      summaryEs: spoken,
      spokenSummaryEs: spoken,
      error: 'task_not_found',
    };
  }

  const nextState = normalizeTicketState(action.state);
  if (action.operation === 'move_state' && !nextState) {
    return {
      actionIdx,
      type: 'manage_tasks',
      ok: false,
      summaryEs: 'Necesito un estado válido (To Do, In Progress, Review o Done).',
      spokenSummaryEs: 'Decime a qué estado querés mover la tarea: To Do, In Progress, Review o Done.',
      error: 'invalid_state',
    };
  }

  const updatePayload: Record<string, unknown> = {
    id: resolved.issue.id,
    ...(nextState ? { state: nextState } : {}),
    ...(action.operation === 'update' && action.title?.trim()
      ? { title: action.title.trim() }
      : {}),
    ...(action.description !== undefined ? { description: action.description } : {}),
    ...(action.priority ? { priority: action.priority } : {}),
    ...(action.oddPath?.trim() ? { oddPath: action.oddPath.trim() } : {}),
  };

  const updateRes = await ipc.ticketCall('save_issue', updatePayload);
  if (!updateRes?.ok) {
    const msg = `No pude actualizar la tarea ${resolved.issue.id}.`;
    return {
      actionIdx,
      type: 'manage_tasks',
      ok: false,
      summaryEs: msg,
      spokenSummaryEs: msg,
      error: 'ticket_update_failed',
    };
  }

  const finalState = nextState || resolved.issue.state;
  const finalTitle =
    action.operation === 'update' && action.title?.trim()
      ? action.title.trim()
      : resolved.issue.title;

  const spoken =
    action.operation === 'move_state'
      ? `Moví ${resolved.issue.id} (${finalTitle}) a ${finalState}.`
      : `Actualicé la tarea ${resolved.issue.id} (${finalTitle}).`;

  return {
    actionIdx,
    type: 'manage_tasks',
    ok: true,
    summaryEs: spoken,
    spokenSummaryEs: spoken,
    data: {
      operation: action.operation,
      id: resolved.issue.id,
      title: finalTitle,
      state: finalState,
    },
  };
}
