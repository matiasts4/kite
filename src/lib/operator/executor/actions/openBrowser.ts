// Kite Code — Execute Open Browser Action

import { appOperatorController } from '../../appOperatorController';
import type { ActionReceipt } from '../../contract';

export async function executeOpenBrowserAction(
  args: { url: string },
  actionIdx: number = 0
): Promise<ActionReceipt> {
  const url = args.url || 'https://google.com';
  const res = await appOperatorController.openBrowser(url);

  return {
    actionIdx,
    type: 'open_browser',
    ok: res.success,
    summaryEs: res.success
      ? `Abrí el navegador en ${url}.`
      : `No pude abrir el navegador: ${res.message}`,
    data: { url },
    error: res.success ? undefined : res.message,
  };
}
