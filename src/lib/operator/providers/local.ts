// Kite Code — Local Heuristic Planner Provider

import { planTurnHeuristic } from '../planner/heuristic';
import type { PlannerProvider, ProviderMessage, PlannerProviderResult } from './types';

export class LocalPlannerProvider implements PlannerProvider {
  public readonly id = 'local';

  public async plan(
    messages: ProviderMessage[]
  ): Promise<PlannerProviderResult> {
    const startTime = Date.now();
    const userMessage = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
    const plan = planTurnHeuristic(userMessage);

    const json = JSON.stringify({
      reply: plan.reply || 'Acción procesada localmente.',
      actions: plan.actions,
      answer: plan.answer,
    });

    return {
      rawText: json,
      latencyMs: Date.now() - startTime,
      model: 'local-heuristic-v1',
    };
  }
}
