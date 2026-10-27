// Kite Code — Execute Handoff To Agent Action (S7)
// Pipes the ODD document (or the tail of the output) produced in one terminal into
// another agent terminal, spawning the requested engine when needed.

import { appOperatorController } from '../../appOperatorController';
import {
  getActiveAgentTerminals,
  getTerminalRollingBuffer,
  type ActiveAgentTerminal,
} from '../../../terminalRegistry';
import { cleanAgentTitle } from '../../../agentNames';
import { detectEngineFromText } from '../../planner/heuristic';
import type { ActionReceipt, HandoffToAgentAction, TurnContext } from '../../contract';

/** Matches `odd/tasks/<slug>.md` and `.kite/tasks/<slug>.md` paths inside a terminal buffer. */
const ODD_PATH_RE = /(?:odd|\.kite)\/tasks\/[a-zA-Z0-9._-]+\.md/;

const BUFFER_TAIL_CHARS = 600;

function workspaceTerminals(context?: TurnContext): ActiveAgentTerminal[] {
  const all = getActiveAgentTerminals();
  return context?.workspaceId
    ? all.filter((t) => !t.workspaceId || t.workspaceId === context.workspaceId)
    : all;
}

function matchesTerminal(terminal: ActiveAgentTerminal, query: string): boolean {
  const norm = query.trim().toLowerCase();
  if (!norm) return false;
  if (terminal.sessionId.toLowerCase() === norm) return true;
  if (terminal.who && terminal.who.toLowerCase().includes(norm)) return true;
  if (terminal.title) {
    if (terminal.title.toLowerCase().includes(norm)) return true;
    if (cleanAgentTitle(terminal.title).toLowerCase().includes(norm)) return true;
  }
  if (terminal.engine && terminal.engine.toLowerCase() === norm) return true;
  const engineFromQuery = detectEngineFromText(norm);
  return Boolean(engineFromQuery && terminal.engine === engineFromQuery);
}

/** Resolves a 1-based index, engine name, codename or title to one active terminal. */
function resolveTerminal(
  terminals: ActiveAgentTerminal[],
  target: string | number | undefined
): ActiveAgentTerminal | undefined {
  if (target === undefined || target === null) return terminals[0];

  if (typeof target === 'number') {
    return terminals[Math.floor(target) - 1];
  }

  const trimmed = String(target).trim();
  if (/^\d+$/.test(trimmed)) {
    return terminals[parseInt(trimmed, 10) - 1];
  }

  const engine = detectEngineFromText(trimmed);
  if (engine) {
    const byEngine = terminals.find((t) => t.engine === engine);
    if (byEngine) return byEngine;
  }

  const exact = terminals.find((t) => matchesTerminal(t, trimmed));
  if (exact) return exact;

  const engineOnly = trimmed.match(/^(?:de|del)\s+(.+)$/i);
  if (engineOnly) {
    return terminals.find((t) => matchesTerminal(t, engineOnly[1]));
  }

  return undefined;
}

function readBuffer(terminal: ActiveAgentTerminal): string {
  try {
    return getTerminalRollingBuffer(terminal.sessionId) || '';
  } catch {
    return '';
  }
}

export async function executeHandoffToAgentAction(
  args: HandoffToAgentAction,
  actionIdx: number = 0,
  context?: TurnContext
): Promise<ActionReceipt> {
  const startedAt = Date.now();
  const terminals = workspaceTerminals(context);
  const source = resolveTerminal(terminals, args.sourceTarget);

  if (!source) {
    return {
      actionIdx,
      type: 'handoff_to_agent',
      ok: false,
      summaryEs: 'No encontré la terminal de origen para transferir la tarea.',
      error: 'source_terminal_not_found',
      durationMs: Date.now() - startedAt,
    };
  }

  const bufferText = readBuffer(source);
  const normalizedBuffer = bufferText.replace(/\\/g, '/');
  const oddPath = normalizedBuffer.match(ODD_PATH_RE)?.[0];
  const sourceLabel = source.who || cleanAgentTitle(source.title || '') || source.sessionId;

  const handoffPrompt = oddPath
    ? args.customPrompt
      ? `${args.customPrompt} (${oddPath})`
      : `Lee e implementa el documento ODD en ${oddPath} siguiendo todas sus especificaciones y verificando los tests.`
    : args.customPrompt ||
      `Continúa e implementa lo trabajado en la terminal ${sourceLabel}: ${(
        bufferText ||
        source.latestLine ||
        ''
      )
        .slice(-BUFFER_TAIL_CHARS)
        .trim()}`;

  const targetEngine = args.targetEngine || 'claude';
  const label = oddPath
    ? `⚡ ${oddPath.split('/').pop()} → ${targetEngine}`
    : `⚡ Handoff → ${targetEngine}`;

  // Existing target terminal: pipe the artifact without spawning anything new.
  if (args.spawnNew === false && args.targetSession !== undefined) {
    const target = resolveTerminal(terminals, args.targetSession);
    if (target) {
      const res = await appOperatorController.injectPrompt(target.sessionId, handoffPrompt, {
        sourceSessionId: source.sessionId,
        label,
      });

      return {
        actionIdx,
        type: 'handoff_to_agent',
        ok: res.success,
        summaryEs: res.success
          ? `Transferí ${oddPath ? `el ODD ${oddPath.split('/').pop()}` : 'la tarea'} de ${sourceLabel} a ${target.who || cleanAgentTitle(target.title || '') || target.sessionId}.`
          : `No pude transferir la tarea a la terminal destino: ${res.message}`,
        data: {
          sourceSessionId: source.sessionId,
          targetSessionId: target.sessionId,
          oddPath,
          handoffPrompt,
        },
        error: res.success ? undefined : res.message,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  const spawn = await appOperatorController.spawnTerminals({
    count: 1,
    engine: targetEngine,
    prompts: [handoffPrompt],
    workspaceId: context?.workspaceId,
    sourceSessionId: source.sessionId,
    projectileLabel: label,
  });

  if (!spawn.success) {
    return {
      actionIdx,
      type: 'handoff_to_agent',
      ok: false,
      summaryEs: `No pude abrir el agente ${targetEngine} para recibir la tarea: ${spawn.message}`,
      error: spawn.message || 'handoff-spawn-failed',
      durationMs: Date.now() - startedAt,
    };
  }

  const spawnedSessionId = (spawn.data as { sessionIds?: string[] } | undefined)?.sessionIds?.[0];

  return {
    actionIdx,
    type: 'handoff_to_agent',
    ok: true,
    summaryEs: oddPath
      ? `Transferí el ODD de ${sourceLabel} a un nuevo agente de ${targetEngine}.`
      : `Transferí el trabajo de ${sourceLabel} a un nuevo agente de ${targetEngine}.`,
    data: {
      sourceSessionId: source.sessionId,
      targetSessionId: spawnedSessionId,
      targetEngine,
      oddPath,
      handoffPrompt,
      label,
    },
    durationMs: Date.now() - startedAt,
  };
}
