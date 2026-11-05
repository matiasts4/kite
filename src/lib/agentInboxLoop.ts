/**
 * Polls .kite/inbox from the desktop backend.
 * spawn and inject files are traces. Delivery is kite dispatch.
 * agents still lists live terminals.
 */

import { invokeCommand } from './ipc';
import { getActiveAgentTerminals } from './terminalRegistry';
import {
  planHandoff,
  type HandoffRequest,
  type HandoffTerminalRow,
} from './agentHandoff';

export interface AgentInboxRequest extends HandoffRequest {
  cwd?: string;
}

export async function processAgentInboxRequest(request: AgentInboxRequest): Promise<{
  ok: boolean;
  message: string;
  sessionId?: string;
  agentName?: string;
  agents?: HandoffTerminalRow[];
}> {
  const cwd = request.cwd?.trim();
  if (!cwd) {
    return { ok: false, message: 'Falta cwd en la solicitud del buzón.' };
  }

  if (request.op === 'spawn' || request.op === 'inject') {
    return {
      ok: true,
      message: 'El buzón no abre terminales. La entrega es kite dispatch.',
    };
  }

  const terminals = getActiveAgentTerminals().map((t) => ({
    sessionId: t.sessionId,
    title: t.title,
    who: t.who,
    engine: t.engine,
    state: t.state,
  }));

  const plan = planHandoff(
    { ...request, cwd },
    {
      terminals,
      readTask: (path) => {
        throw new Error(`readTask síncrono no disponible para ${path}; use taskBody.`);
      },
    }
  );

  if (!plan.ok) {
    return { ok: false, message: plan.error };
  }

  if (plan.op === 'agents') {
    const lines = plan.agents.map(
      (agent) =>
        `${agent.who || agent.title} · ${agent.engine} · ${agent.state} · ${agent.sessionId}`
    );
    return {
      ok: true,
      message:
        lines.length > 0
          ? lines.join('\n')
          : 'No hay terminales de agente abiertas.',
      agents: plan.agents,
    };
  }

  return {
    ok: true,
    message: 'El buzón no abre terminales. La entrega es kite dispatch.',
  };
}

export function startAgentInboxPolling(getWorkspaceCwd: () => string | null | undefined): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  let busy = false;

  const tick = async () => {
    if (busy) return;
    const cwd = getWorkspaceCwd()?.trim();
    if (!cwd) return;

    busy = true;
    try {
      const polled = await invokeCommand<{ requests: AgentInboxRequest[] }>('poll_agent_inbox', {
        cwd,
      });
      const requests = polled?.requests ?? [];
      for (const req of requests) {
        const withCwd = { ...req, cwd: req.cwd || cwd };
        const outcome = await processAgentInboxRequest(withCwd);
        await invokeCommand('complete_agent_inbox', {
          cwd,
          id: req.id,
          ok: outcome.ok,
          message: outcome.message,
          sessionId: outcome.sessionId,
          agentName: outcome.agentName,
          agents: outcome.agents,
        }).catch((err) => console.warn('[agent-inbox] complete failed:', err));
      }
    } catch (err) {
      console.warn('[agent-inbox] poll failed:', err);
    } finally {
      busy = false;
    }
  };

  const intervalId = window.setInterval(() => {
    void tick();
  }, 500);

  void tick();

  return () => window.clearInterval(intervalId);
}
