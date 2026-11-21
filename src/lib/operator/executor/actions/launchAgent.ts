// Kite Code — Execute Launch Autonomous Agent Action
// Finds a configured Autonomous Agent profile, opens/creates its chat thread, and dispatches a task.

import { invokeCommand } from '../../../ipc';
import type { AgentProfile } from '../../../../types';
import type { ActionReceipt, TurnContext } from '../../contract';
import { voiceSessionStore } from '../../voice/voiceSessionStore';
import { formatDelegatedTask } from './oddBrief';

export interface LaunchAgentActionPayload {
  type: 'launch_agent';
  agentQuery?: string;
  provider?: string;
  body: string;
  oddMode?: boolean;
  focusAgent?: boolean;
}

function normalizeProvider(raw?: string): string | undefined {
  if (!raw) return undefined;
  const lower = raw.trim().toLowerCase();
  if (!lower || lower === 'powershell') return undefined;
  if (lower === 'open-code') return 'opencode';
  return lower;
}

function matchAgentProfile(profiles: AgentProfile[], query?: string): AgentProfile | null {
  if (profiles.length === 0) return null;
  const clean = (query || '').trim().toLowerCase();
  if (!clean) {
    return profiles.find((p) => p.pinned) ?? profiles[0];
  }
  const exact = profiles.find(
    (p) => p.id.toLowerCase() === clean || p.name.toLowerCase() === clean
  );
  if (exact) return exact;

  const partial = profiles.find(
    (p) => p.name.toLowerCase().includes(clean) || clean.includes(p.name.toLowerCase())
  );
  return partial ?? null;
}

export async function executeLaunchAgentAction(
  action: LaunchAgentActionPayload,
  actionIdx: number,
  context?: TurnContext
): Promise<ActionReceipt> {
  const rawBody = (action.body || '').trim();
  if (!rawBody) {
    return {
      actionIdx,
      type: 'launch_agent',
      ok: false,
      summaryEs: 'Necesito una instrucción concreta para delegar al agente autónomo.',
      error: 'empty_body',
    };
  }

  let profiles: AgentProfile[] = [];
  try {
    const res = await invokeCommand<AgentProfile[]>('list_agent_profiles');
    if (Array.isArray(res)) profiles = res;
  } catch (err: any) {
    return {
      actionIdx,
      type: 'launch_agent',
      ok: false,
      summaryEs: `No pude consultar los agentes configurados: ${err?.message || String(err)}`,
      error: err?.message || String(err),
    };
  }

  const matched = matchAgentProfile(profiles, action.agentQuery);
  if (!matched) {
    const hint = action.agentQuery
      ? `No encontré un agente autónomo llamado «${action.agentQuery}».`
      : 'No hay agentes autónomos configurados todavía.';
    return {
      actionIdx,
      type: 'launch_agent',
      ok: false,
      summaryEs: `${hint} Puedo lanzar un hilo o subagente en su lugar si querés.`,
      error: 'agent_not_found',
    };
  }

  const provider = normalizeProvider(action.provider) ?? normalizeProvider(matched.engine) ?? 'claude';
  const taskBody = formatDelegatedTask(rawBody, {
    oddMode: action.oddMode,
    targetKind: 'agent',
  });

  let threadId: string | undefined;
  try {
    const created = await invokeCommand<{ id?: string }>('create_agent_chat', {
      agentId: matched.id,
      workspaceId: context?.workspaceId,
      provider,
    });
    if (!created?.id) {
      return {
        actionIdx,
        type: 'launch_agent',
        ok: false,
        summaryEs: `No pude abrir el chat del agente ${matched.name}.`,
        error: 'create_agent_chat_failed',
      };
    }
    threadId = created.id;
  } catch (err: any) {
    return {
      actionIdx,
      type: 'launch_agent',
      ok: false,
      summaryEs: `No pude crear la sesión del agente ${matched.name}: ${err?.message || String(err)}`,
      error: err?.message || String(err),
    };
  }

  try {
    await invokeCommand('start_agent_chat_turn', {
      agentId: matched.id,
      threadId,
      prompt: taskBody,
      mode: 'agent',
      provider,
      attachments: [],
    });
  } catch (err: any) {
    return {
      actionIdx,
      type: 'launch_agent',
      ok: false,
      summaryEs: `Abrí la sesión de ${matched.name}, pero falló al iniciar el turno: ${err?.message || String(err)}`,
      error: err?.message || String(err),
      data: { agentId: matched.id, agentName: matched.name, threadId, provider },
    };
  }

  const vs = voiceSessionStore.getSnapshot();
  const stayInVoiceMode =
    !action.focusAgent &&
    ((vs.phase === 'active' && vs.activeSurface === 'thread') ||
      (context?.voiceSessionActive && context?.mode === 'thread'));

  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent('kite:threads-changed'));
      if (!stayInVoiceMode && action.focusAgent) {
        window.dispatchEvent(
          new CustomEvent('kite:navigate-mode', { detail: { mode: 'agents' } })
        );
      }
    } catch {}
  }

  const oddLabel = action.oddMode ? ' con enfoque ODD' : '';
  const summaryEs = `Delegué la tarea al agente ${matched.name} (${provider})${oddLabel}.`;
  const spokenSummaryEs = stayInVoiceMode
    ? `Delegué esa tarea al agente ${matched.name}${oddLabel}.`
    : summaryEs;

  return {
    actionIdx,
    type: 'launch_agent',
    ok: true,
    summaryEs,
    spokenSummaryEs,
    data: {
      agentId: matched.id,
      agentName: matched.name,
      threadId,
      provider,
      oddMode: Boolean(action.oddMode),
    },
  };
}
