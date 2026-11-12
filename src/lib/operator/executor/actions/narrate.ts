// Kite Code — Execute Narrate Summary Action

import { appOperatorController } from '../../appOperatorController';
import { getActiveAgentTerminals } from '../../../terminalRegistry';
import { cleanAgentTitle } from '../../../agentNames';
import type { ActionReceipt, TurnContext } from '../../contract';

export async function executeNarrateAction(
  args: { target?: string | number },
  actionIdx: number = 0,
  context?: TurnContext
): Promise<ActionReceipt> {
  const allTerminals = getActiveAgentTerminals();
  const terminals = context?.workspaceId
    ? allTerminals.filter((t) => !t.workspaceId || t.workspaceId === context.workspaceId)
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
        summaryEs: `No encontré la terminal ${args.target}. Hay ${terminals.length} terminales activas.`,
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
          summaryEs: 'No hay ninguna terminal abierta.',
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
        const summaryEs =
          terminals.length === 0
            ? 'No hay ninguna terminal abierta.'
            : `No encontré ningún agente ni terminal con el nombre «${args.target}». Hay ${terminals.length} terminales activas.`;
        return {
          actionIdx,
          type: 'narrate_summary',
          ok: terminals.length === 0,
          summaryEs,
          error: terminals.length === 0 ? undefined : 'target-not-found',
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
