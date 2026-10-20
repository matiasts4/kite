/**
 * Polls .kite/inbox from the desktop backend and applies agent handoff plans.
 */

import { invokeCommand } from './ipc';
import { getActiveAgentTerminals } from './terminalRegistry';
import {
  applyHandoffPlan,
  planHandoff,
  type HandoffRequest,
  type HandoffTerminalRow,
} from './agentHandoff';

export interface AgentInboxRequest extends HandoffRequest {
  cwd?: string;
}

async function readTaskFileAtCwd(cwd: string, taskPath: string): Promise<string> {
  const res = await invokeCommand<{ ok: boolean; text?: string; error?: string }>(
    'read_cwd_relative_text',
    { cwd, path: taskPath }
  );
  if (!res?.ok || res.text === undefined) {
    throw new Error(res?.error || 'No se pudo leer el archivo de tarea.');
  }
  return res.text;
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

  let taskBody: string | undefined = request.taskBody;
  if (request.taskPath && taskBody === undefined) {
    try {
      taskBody = await readTaskFileAtCwd(cwd, request.taskPath);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, message };
    }
  }

  const terminals = getActiveAgentTerminals().map((t) => ({
    sessionId: t.sessionId,
    title: t.title,
    who: t.who,
    engine: t.engine,
    state: t.state,
  }));

  const plan = planHandoff(
    { ...request, taskBody, cwd },
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

  applyHandoffPlan(plan);

  if (plan.op === 'spawn') {
    return {
      ok: true,
      message: 'Terminal hija solicitada; el prompt se entregará por vía staged.',
      sessionId: plan.spawnDetail.sessionId,
    };
  }

  return {
    ok: true,
    message: 'Proyectil de prompt despachado a la terminal objetivo.',
    sessionId: plan.projectileDetail.targetSessionId,
    agentName: plan.projectileDetail.agentName,
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
