// Kite Code — Execute Stop Speaking Action

import { ttsNarrator } from '../../ttsNarrator';
import type { ActionReceipt } from '../../contract';

export function executeStopSpeakingAction(actionIdx: number = 0): ActionReceipt {
  ttsNarrator.stop();
  return {
    actionIdx,
    type: 'stop_speaking',
    ok: true,
    summaryEs: 'Lectura en voz alta detenida.',
  };
}
