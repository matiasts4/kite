// Kite Code — Execute Spawn Subagent Action

import { appOperatorController } from '../../appOperatorController';
import type { ActionReceipt } from '../../contract';

export async function executeSpawnSubagentAction(
  args: { cli: string; task: string },
  actionIdx: number = 0
): Promise<ActionReceipt> {
  const cli = args.cli || 'grok';
  const task = args.task || 'tarea delegada';

  const res = await appOperatorController.spawnTerminals({
    count: 1,
    engine: cli,
    prompts: [task],
    titlePrefix: `[Subagente] ${cli}`,
  });

  return {
    actionIdx,
    type: 'spawn_subagent',
    ok: res.success,
    summaryEs: res.success
      ? `Inicié el subagente ${cli} para «${task}».`
      : `No pude iniciar el subagente: ${res.message}`,
    error: res.success ? undefined : res.message,
  };
}
