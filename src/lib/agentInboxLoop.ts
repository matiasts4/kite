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

export interface AgentInboxPollingOptions {
  /** Returns false when CodeWorkspace is inactive/hidden so idle polling pauses. */
  isActive?: () => boolean;
  /** Returns true when at least one agent is active; pauses idle polling when false. */
  hasActiveAgents?: () => boolean;
  /** Base interval when active (default 500ms). */
  baseIntervalMs?: number;
  /** Maximum backed-off interval during empty active polls (default 2000ms). */
  maxIntervalMs?: number;
}

export function startAgentInboxPolling(
  getWorkspaceCwd: () => string | null | undefined,
  options?: AgentInboxPollingOptions
): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const baseIntervalMs = options?.baseIntervalMs ?? 500;
  const maxIntervalMs = options?.maxIntervalMs ?? 2000;
  let stopped = false;
  let busy = false;
  let timerId: number | null = null;
  let emptyPolls = 0;

  const shouldPollNow = (): boolean => {
    if (stopped) return false;
    if (typeof document !== 'undefined' && document.hidden) return false;
    if (options?.isActive && !options.isActive()) return false;
    if (options?.hasActiveAgents && !options.hasActiveAgents()) return false;
    return Boolean(getWorkspaceCwd()?.trim());
  };

  const clearTimer = () => {
    if (timerId !== null) {
      window.clearTimeout(timerId);
      timerId = null;
    }
  };

  const scheduleNext = (delayMs: number) => {
    clearTimer();
    if (stopped) return;
    if (!shouldPollNow()) return;
    timerId = window.setTimeout(() => {
      timerId = null;
      void tick();
    }, delayMs);
  };

  const tick = async () => {
    if (stopped || busy) return;
    if (!shouldPollNow()) {
      clearTimer();
      return;
    }
    const cwd = getWorkspaceCwd()?.trim();
    if (!cwd) return;

    busy = true;
    let handledAny = false;
    try {
      const polled = await invokeCommand<{ requests: AgentInboxRequest[] }>('poll_agent_inbox', {
        cwd,
      });
      const requests = polled?.requests ?? [];
      handledAny = requests.length > 0;
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
      if (handledAny) {
        emptyPolls = 0;
        scheduleNext(baseIntervalMs);
      } else {
        emptyPolls = Math.min(emptyPolls + 1, 6);
        const nextDelay = Math.min(
          maxIntervalMs,
          baseIntervalMs * (emptyPolls >= 3 ? 4 : emptyPolls >= 1 ? 2 : 1)
        );
        scheduleNext(nextDelay);
      }
    }
  };

  const wake = () => {
    if (stopped) return;
    emptyPolls = 0;
    if (shouldPollNow()) {
      clearTimer();
      void tick();
    } else {
      clearTimer();
    }
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', wake);
  }
  window.addEventListener('kite:terminal-agent-update', wake);
  window.addEventListener('kite:agent-inbox-wake', wake);
  window.addEventListener('resize', wake);

  void tick();

  return () => {
    stopped = true;
    clearTimer();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', wake);
    }
    window.removeEventListener('kite:terminal-agent-update', wake);
    window.removeEventListener('kite:agent-inbox-wake', wake);
    window.removeEventListener('resize', wake);
  };
}
