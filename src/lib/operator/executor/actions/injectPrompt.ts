// Kite Code — Execute Inject Prompt Action

import { appOperatorController } from '../../appOperatorController';
import { getActiveAgentTerminals } from '../../../terminalRegistry';
import { cleanAgentTitle } from '../../../agentNames';
import type { ActionReceipt } from '../../contract';

export async function executeInjectPromptAction(
  args: { target: string | number; prompt: string },
  actionIdx: number = 0
): Promise<ActionReceipt> {
  const terminals = getActiveAgentTerminals();
  let targetSessionId: string | undefined;

  if (typeof args.target === 'number') {
    const idx = args.target - 1;
    targetSessionId = terminals[idx]?.sessionId;
  } else {
    const norm = String(args.target).trim().toLowerCase();
    if (['active', 'current', 'abierta', 'actual', 'last', 'ultima', 'última'].includes(norm)) {
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
    }
  }

  if (!targetSessionId) {
    return {
      actionIdx,
      type: 'inject_prompt',
      ok: false,
      summaryEs: terminals.length === 0
        ? 'No hay ninguna terminal abierta en este momento para ejecutar la acción.'
        : `No encontré la terminal ${args.target} para inyectar la instrucción.`,
      error: 'terminal-not-found',
    };
  }

  const res = await appOperatorController.injectPrompt(targetSessionId, args.prompt);

  const targetLabel = ['active', 'current', 'abierta', 'actual'].includes(String(args.target).toLowerCase())
    ? 'la terminal abierta'
    : `la terminal ${args.target}`;

  return {
    actionIdx,
    type: 'inject_prompt',
    ok: res.success,
    summaryEs: res.success
      ? `Inyecté «${args.prompt}» en ${targetLabel}.`
      : `No pude inyectar la instrucción: ${res.message}`,
    error: res.success ? undefined : res.message,
  };
}
