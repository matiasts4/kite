// Kite Code — Execute Close Terminals Action
// Closes terminals matching target and verifies with postconditions.

import { appOperatorController } from '../../appOperatorController';
import { verifyCloseTerminals } from '../../verify/postconditions';
import type { ActionReceipt } from '../../contract';

export async function executeCloseTerminalsAction(
  args: { target: string | number },
  actionIdx: number = 0
): Promise<ActionReceipt> {
  const target = args.target || 'finished';

  const res = await appOperatorController.closeTerminals(target as any);

  if (!res.success) {
    return {
      actionIdx,
      type: 'close_terminals',
      ok: false,
      summaryEs: res.message || `No pude cerrar las terminales solicitadas (${target}).`,
      error: res.message,
    };
  }

  const closedSessionIds: string[] = res.data?.closedSessionIds || [];

  if (closedSessionIds.length === 0) {
    return {
      actionIdx,
      type: 'close_terminals',
      ok: true,
      summaryEs: res.message || `No se encontraron terminales para cerrar con el criterio «${target}».`,
      data: { closedCount: 0 },
    };
  }

  const verification = await verifyCloseTerminals(closedSessionIds, 2500);

  return {
    actionIdx,
    type: 'close_terminals',
    ok: verification.ok,
    summaryEs: verification.ok
      ? res.message || `Cerré ${closedSessionIds.length} ${closedSessionIds.length === 1 ? 'terminal' : 'terminales'}.`
      : `Hubo un problema cerrando las terminales: ${verification.error}`,
    data: { closedSessionIds, closedCount: closedSessionIds.length },
    verification,
    error: verification.error,
  };
}
