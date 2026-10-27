// Kite Code — Execute Manage Pane Layout Action (S8)
// Requests spatial control of the pane grid: equalize, split, focus or zoom.

import type { ActionReceipt, ManagePaneLayoutAction, PaneLayoutOperation, TurnContext } from '../../contract';

const SUMMARY_BY_OPERATION: Record<PaneLayoutOperation, string> = {
  equalize: 'Autoajusté las dimensiones de todas las terminales en partes iguales.',
  'split-horizontal': 'Dividí el panel activo en horizontal.',
  'split-vertical': 'Dividí el panel activo en vertical.',
  focus: 'Enfoqué el panel solicitado.',
  zoom: 'Alterné el zoom del panel solicitado.',
};

export async function executeManagePaneLayoutAction(
  args: ManagePaneLayoutAction,
  actionIdx: number = 0,
  context?: TurnContext
): Promise<ActionReceipt> {
  const operation = args.operation || 'equalize';

  if (typeof window === 'undefined') {
    return {
      actionIdx,
      type: 'manage_pane_layout',
      ok: false,
      summaryEs: 'No pude reacomodar los paneles: no hay una ventana activa.',
      error: 'no-window',
    };
  }

  window.dispatchEvent(
    new CustomEvent('kite:operator-pane-layout', {
      detail: {
        operation,
        target: args.target,
        workspaceId: context?.workspaceId,
      },
    })
  );

  return {
    actionIdx,
    type: 'manage_pane_layout',
    ok: true,
    summaryEs: SUMMARY_BY_OPERATION[operation],
    data: { operation, target: args.target },
  };
}
