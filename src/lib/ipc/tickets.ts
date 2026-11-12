import type {
  TicketSnapshot,
  TaskExecutionSnapshot,
  AutopilotDecision,
} from '../../components/views/tickets/types';
import { invokeCommand } from './core';

export async function getTicketSnapshot(): Promise<TicketSnapshot> {
  return invokeCommand<TicketSnapshot>('ticket_snapshot');
}

export async function getTaskExecutionSnapshot(): Promise<TaskExecutionSnapshot> {
  return invokeCommand<TaskExecutionSnapshot>('task_execution_snapshot');
}

export async function autopilotNext(ticketId?: string): Promise<AutopilotDecision> {
  return invokeCommand<AutopilotDecision>('autopilot_next', { ticketId });
}

export async function cancelAutopilot(): Promise<{ ok: boolean }> {
  return invokeCommand<{ ok: boolean }>('cancel_autopilot');
}

export async function ticketCall(
  action: string,
  payload: Record<string, unknown> = {}
): Promise<{ ok: boolean; result?: unknown }> {
  return invokeCommand<{ ok: boolean; result?: unknown }>('ticket_call', {
    tool: action,
    arguments: payload,
    action,
    ...payload,
  });
}

export async function ticketConnect(
  name: string,
  readOnly: boolean
): Promise<Record<string, unknown>> {
  try {
    return await invokeCommand<Record<string, unknown>>('ticket_connect', { name, readOnly });
  } catch {
    return {
      mcpServers: {
        'kite-tasks': {
          command: 'kite-code',
          args: [
            'mcp',
            'tasks',
            ...(readOnly ? ['--read-only'] : []),
            '--connection',
            name.trim() || 'My coding agent',
          ],
        },
      },
    };
  }
}

export async function ticketConfiguration(id: string): Promise<Record<string, unknown>> {
  try {
    return await invokeCommand<Record<string, unknown>>('ticket_configuration', { id });
  } catch {
    return {
      mcpServers: {
        'kite-tasks': {
          command: 'kite-code',
          args: ['mcp', 'tasks', '--connection-id', id],
        },
      },
    };
  }
}

export async function ticketRevoke(id: string): Promise<void> {
  try {
    await invokeCommand<void>('ticket_revoke', { id });
  } catch {
    // Fallback handled in local state
  }
}

export async function ticketRecover(): Promise<void> {
  try {
    await invokeCommand<void>('ticket_recover');
  } catch {
    // Fallback handled in local state
  }
}
