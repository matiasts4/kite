// Kite Code — Execute Narrate Summary / Unified Entity Inspection Action
// Resolves status & findings queries ("¿qué está haciendo Nova?", "¿qué encontró el subagente?")
// across all active workspace surfaces: PTY Terminals -> Subagents (with real `dispatch_read`) ->
// Autonomous Agents -> Workspace Threads -> Reconciled Delegation Ledger.

import { appOperatorController } from '../../appOperatorController';
import { getActiveAgentTerminals } from '../../../terminalRegistry';
import { cleanAgentTitle } from '../../../agentNames';
import {
  getCachedWorkspaceEpisodicMemory,
  reconcileDelegationsWithContext,
  recordDelegation,
} from '../../context/episodicMemory';
import {
  findSubagentFindingInWorkingContext,
  upsertSubagentFinding,
} from '../../context/workingContext';
import {
  readThreadFinalOutput,
  summarizeSubagentFindingsForVoice,
} from '../../subagentReturnWatcher';
import type { ActionReceipt, TurnContext } from '../../contract';

const STATUS_ES: Record<string, string> = {
  running: 'está trabajando activamente',
  working: 'está trabajando activamente',
  waiting: 'está esperando tu confirmación',
  waitingForYou: 'está esperando tu confirmación',
  idle: 'está en espera',
  completed: 'ya terminó su tarea',
  done: 'ya terminó su tarea',
  error: 'se detuvo con un error',
  failed: 'se detuvo con un error',
};

const GENERIC_SUBAGENT_TARGET_RE =
  /^(?:el\s+)?(?:[uú]ltimo\s+)?(?:subagente|subagent|explorador|explorer)$/i;

async function resolveFindingsForThread(
  threadId: string | undefined,
  cachedSummary?: string
): Promise<string> {
  if (threadId) {
    const raw = await readThreadFinalOutput(threadId);
    const summarized = summarizeSubagentFindingsForVoice(raw, 340);
    if (summarized) {
      return summarized;
    }
  }
  return cachedSummary ? summarizeSubagentFindingsForVoice(cachedSummary, 340) : '';
}

async function describeNonTerminalTarget(
  target: string,
  context?: TurnContext
): Promise<{ summaryEs: string; spokenSummaryEs: string } | null> {
  const norm = target.trim().toLowerCase();
  if (!norm) return null;

  // 1. Subagents in the active workspace (exact/partial match or generic "subagente"/"explorador")
  const subagents = context?.activeSubagents || [];
  let subagent = subagents.find(
    (s) =>
      s.id.toLowerCase() === norm ||
      s.role.toLowerCase() === norm ||
      s.role.toLowerCase().includes(norm) ||
      (s.title && s.title.toLowerCase().includes(norm))
  );

  if (!subagent && GENERIC_SUBAGENT_TARGET_RE.test(norm) && subagents.length > 0) {
    const bound = context?.boundThreadId;
    const anchored = bound ? subagents.filter((s) => s.parentThreadId === bound) : [];
    const pool = anchored.length > 0 ? anchored : subagents;
    subagent = [...pool].sort((a, b) => (b.updatedAtUnixMs || 0) - (a.updatedAtUnixMs || 0))[0];
  }

  if (subagent) {
    const stateDesc = STATUS_ES[subagent.status] || subagent.status;
    const wcMatch = findSubagentFindingInWorkingContext(context?.boundThreadId, subagent.id) ??
      findSubagentFindingInWorkingContext(context?.boundThreadId, subagent.role);
    const findings = await resolveFindingsForThread(
      subagent.id,
      subagent.findingsSummary || wcMatch?.findingsSummary
    );

    if (findings) {
      if (context?.boundThreadId) {
        upsertSubagentFinding(context.boundThreadId, {
          subagentId: subagent.id,
          role: subagent.role,
          provider: subagent.provider,
          status:
            subagent.status === 'error' || subagent.status === 'failed'
              ? 'failed'
              : subagent.status === 'waiting'
                ? 'waiting'
                : subagent.status === 'running'
                  ? 'running'
                  : 'completed',
          taskSummary: subagent.title || subagent.role,
          findingsSummary: findings,
        });
      }
      if (context?.workspaceId) {
        void recordDelegation(context.workspaceId, {
          kind: 'subagent',
          name: subagent.role,
          role: subagent.role,
          provider: subagent.provider,
          resourceId: subagent.id,
          taskSummary: subagent.title || subagent.role,
          status:
            subagent.status === 'error' || subagent.status === 'failed'
              ? 'failed'
              : subagent.status === 'waiting'
                ? 'waiting'
                : subagent.status === 'running'
                  ? 'running'
                  : 'completed',
          outcomeSummary: findings,
        }).catch(() => {});
      }
      const text = `El subagente ${subagent.role} (${subagent.provider}) ${stateDesc}. Encontró lo siguiente: ${findings}`;
      return { summaryEs: text, spokenSummaryEs: text };
    }

    const fallback = `El subagente ${subagent.role} (${subagent.provider}) ${stateDesc}.`;
    return { summaryEs: fallback, spokenSummaryEs: fallback };
  }

  // 1b. Subagent finding cached in active voice thread Working Context (even if not yet in activeSubagents)
  const wcFinding = findSubagentFindingInWorkingContext(
    context?.boundThreadId,
    GENERIC_SUBAGENT_TARGET_RE.test(norm) ? undefined : target
  );
  if (wcFinding) {
    const stateDesc = STATUS_ES[wcFinding.status] || wcFinding.status;
    const findings = await resolveFindingsForThread(wcFinding.subagentId, wcFinding.findingsSummary);
    const text = findings
      ? `El subagente ${wcFinding.role} ${stateDesc}. Encontró lo siguiente: ${findings}`
      : `El subagente ${wcFinding.role} ${stateDesc}.`;
    return { summaryEs: text, spokenSummaryEs: text };
  }

  // 2. Autonomous Agents in the active workspace
  const agent = context?.autonomousAgents?.find(
    (a) =>
      a.id.toLowerCase() === norm ||
      a.name.toLowerCase() === norm ||
      a.name.toLowerCase().includes(norm)
  );
  if (agent) {
    const stateDesc = STATUS_ES[agent.status] || agent.status;
    const findings = await resolveFindingsForThread(agent.activeThreadId);
    const text = findings
      ? `El agente autónomo ${agent.name} (${agent.engine}) ${stateDesc} en este proyecto. Último resultado: ${findings}`
      : `El agente autónomo ${agent.name} (${agent.engine}) ${stateDesc} en este proyecto.`;
    return { summaryEs: text, spokenSummaryEs: text };
  }

  // 3. Threads in the active workspace
  const thread = context?.activeThreads?.find(
    (th) =>
      th.id.toLowerCase() === norm ||
      th.title.toLowerCase() === norm ||
      th.title.toLowerCase().includes(norm)
  );
  if (thread) {
    const stateDesc = STATUS_ES[thread.status] || thread.status;
    const findings = await resolveFindingsForThread(thread.id);
    const text = findings
      ? `El hilo ${thread.title} con ${thread.provider} ${stateDesc}. Último resultado: ${findings}`
      : `El hilo ${thread.title} con ${thread.provider} ${stateDesc}.`;
    return { summaryEs: text, spokenSummaryEs: text };
  }

  // 4. Reconciled episodic delegation ledger for the active workspace
  if (context?.workspaceId) {
    const mem = getCachedWorkspaceEpisodicMemory(context.workspaceId);
    const reconciled = reconcileDelegationsWithContext(mem.delegations, context);
    const match = [...reconciled]
      .reverse()
      .find(
        (d) =>
          d.name.toLowerCase() === norm ||
          d.name.toLowerCase().includes(norm) ||
          (d.role && d.role.toLowerCase().includes(norm))
      );
    if (match) {
      const stateDesc = STATUS_ES[match.status] || match.status;
      const findings =
        match.kind !== 'terminal'
          ? await resolveFindingsForThread(match.resourceId, match.outcomeSummary)
          : match.outcomeSummary || '';
      const detail = findings
        ? ` Último detalle: ${findings}`
        : match.taskSummary
          ? ` Tarea registrada: ${match.taskSummary}.`
          : '';
      const text = `${match.name} (${match.kind}) ${stateDesc}.${detail}`;
      return { summaryEs: text, spokenSummaryEs: text };
    }
  }

  return null;
}

export async function executeNarrateAction(
  args: { target?: string | number },
  actionIdx: number = 0,
  context?: TurnContext
): Promise<ActionReceipt> {
  const allTerminals = getActiveAgentTerminals();
  // S5: strictly isolate terminals to the active workspace when workspaceId is known.
  const terminals = context?.workspaceId
    ? allTerminals.filter((t) => Boolean(t.workspaceId) && t.workspaceId === context.workspaceId)
    : allTerminals;
  let targetSessionId: string | undefined;

  if (typeof args.target === 'number') {
    const idx = args.target - 1;
    targetSessionId = terminals[idx]?.sessionId;
    if (!targetSessionId) {
      return {
        actionIdx,
        type: 'narrate_summary',
        ok: false,
        summaryEs: `No encontré la terminal ${args.target}. Hay ${terminals.length} terminales activas en este proyecto.`,
        error: 'terminal-index-out-of-range',
      };
    }
  } else if (typeof args.target === 'string' && args.target.trim()) {
    const norm = args.target.trim().toLowerCase();
    if (['active', 'current', 'abierta', 'actual', 'last', 'ultima', 'última'].includes(norm)) {
      if (terminals.length === 0) {
        return {
          actionIdx,
          type: 'narrate_summary',
          ok: false,
          summaryEs: 'No hay ninguna terminal abierta en este proyecto.',
          error: 'no-active-terminals',
        };
      }
      targetSessionId = terminals[terminals.length - 1]?.sessionId;
    } else {
      const match = terminals.find(
        (t) =>
          t.sessionId === args.target ||
          t.who?.toLowerCase() === norm ||
          (t.title && cleanAgentTitle(t.title).toLowerCase() === norm) ||
          t.title?.toLowerCase().includes(norm)
      );
      targetSessionId = match?.sessionId;
      if (!targetSessionId) {
        // S3/S5/S6: Before failing, inspect subagents (via dispatch_read), autonomous agents, threads, and delegation ledger.
        const nonTerminalStatus = await describeNonTerminalTarget(args.target, context);
        if (nonTerminalStatus) {
          return {
            actionIdx,
            type: 'narrate_summary',
            ok: true,
            summaryEs: nonTerminalStatus.summaryEs,
            spokenSummaryEs: nonTerminalStatus.spokenSummaryEs,
          };
        }

        const summaryEs =
          terminals.length === 0
            ? `No encontré a ${args.target} entre las terminales, hilos o agentes de este proyecto.`
            : `No encontré ningún agente, hilo ni terminal con el nombre ${args.target} en este proyecto. Hay ${terminals.length} terminales activas.`;
        return {
          actionIdx,
          type: 'narrate_summary',
          ok: false,
          summaryEs,
          error: 'target-not-found',
        };
      }
    }
  }

  const res = await appOperatorController.narrateSummary(targetSessionId, 'es', context?.workspaceId);

  return {
    actionIdx,
    type: 'narrate_summary',
    ok: res.success,
    summaryEs: res.message,
    error: res.success ? undefined : res.message,
  };
}
