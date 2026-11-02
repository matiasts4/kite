// Kite Code — Operator Public API & Pipeline Coordinator
// Executes unified operator turns: Trace -> Plan -> Execute & Verify -> Compose Verified Reply -> TTS -> End Trace.

import {
  type OperatorPlan,
  type TurnContext,
  type ActionReceipt,
} from './contract';
import { emitTrace } from './trace/trace';
import { planTurnHeuristic } from './planner/heuristic';
import { planTurnLLM } from './planner/llm';
import { executePlan, composeReplyFromReceipts } from './executor';
import { ttsNarrator } from './ttsNarrator';
import { loadOperatorConfig } from './operatorConfig';
import { getActiveAgentTerminals } from '../terminalRegistry';
import type { PlannerProvider, ProviderMessage } from './providers/types';
import { resolvePlannerProvider } from './providers/resolvePlanner';

export { resolvePlannerProvider } from './providers/resolvePlanner';

export * from './contract';
export * from './trace/types';
export * from './trace/trace';
export * from './planner/heuristic';
export * from './planner/llm';
export * from './planner/sanitize';
export * from './planner/prompt';
export * from './executor';
export * from './verify/postconditions';
export * from './providers/types';
export * from './providers/local';
export * from './providers/openaiCompat';
export * from './providers/cli';

export interface RunOperatorTurnOptions {
  source?: 'texto' | 'voz' | 'sugerencia' | 'shortcut';
  provider?: PlannerProvider;
  workspaceId?: string | null;
  mode?: string;
  ttsEnabled?: boolean;
  muted?: boolean;
  turnId?: string;
  context?: TurnContext;
  /** Prior user and assistant messages from the operator run, oldest first. */
  history?: ProviderMessage[];
}

export interface OperatorTurnResult {
  turnId: string;
  plan: OperatorPlan;
  receipts: ActionReceipt[];
  reply: string;
  overallSuccess: boolean;
  durationMs: number;
  strategy: string;
  providerId?: string;
  model?: string;
  fallbackReason?: string;
}

export function captureCurrentTurnContext(mode?: string, workspaceId?: string | null): TurnContext {
  let terminals: any[] = [];
  try {
    terminals = getActiveAgentTerminals();
  } catch {
    terminals = [];
  }

  return {
    mode: mode || 'code',
    workspaceId: workspaceId || undefined,
    activeTerminals: terminals.map((t, idx) => ({
      sessionId: t.sessionId,
      engine: t.engine,
      title: t.title,
      who: t.who,
      idx: idx + 1,
    })),
  };
}

export async function runOperatorTurn(
  input: string,
  options: RunOperatorTurnOptions = {}
): Promise<OperatorTurnResult> {
  const startTime = Date.now();
  const turnId = options.turnId || `turn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const context = options.context || captureCurrentTurnContext(options.mode, options.workspaceId);

  emitTrace({
    turnId,
    ev: 'turn.start',
    input,
    source: options.source || 'texto',
    mode: context.mode,
    workspaceId: context.workspaceId,
  });

  const config = loadOperatorConfig();
  const provider = options.provider || resolvePlannerProvider(config);

  try {
    // 1. Plan turn with Fast-Path Heuristic (< 2ms)
    // If the heuristic detects deterministic action intent, execute immediately without 3-4s cloud delay
    let plan: OperatorPlan;
    let fastPlan = planTurnHeuristic(input);
    const hasDeterministicActions =
      fastPlan.strategy === 'heuristic' &&
      fastPlan.actions.length > 0;

    // Avoid LLM mis-plans (p. ej. abrir Grok) cuando claramente pidieron narrar/resumir.
    if (
      !hasDeterministicActions &&
      /resum(?:e|ir|en|o|a|i)\b|resumen\b|\bnarr(?:a|ame|ar)\b|com[eé]ntame|cu[eé]ntame|qu[eé]\s+hay|qu[eé]\s+hab[ií]a/i.test(
        input
      ) &&
      !/(?:abre|abrir|lanza|crea|inicia|pon|spawn)\s+(?:\d+|un|una|uno|dos|tres|\w+\s+)?(?:terminal|terminales|agente|agentes)\b/i.test(
        input.toLowerCase()
      )
    ) {
      fastPlan = {
        strategy: 'heuristic',
        actions: [{ type: 'narrate_summary', target: 'active' }],
        reply: 'Leyendo resumen de la terminal abierta.',
      };
    }

    const useFastPlan =
      fastPlan.strategy === 'heuristic' && fastPlan.actions.length > 0;

    if (provider.id === 'local' || useFastPlan) {
      plan = fastPlan;
      emitTrace({
        turnId,
        ev: 'plan.created',
        strategy: 'heuristic',
        actions: plan.actions,
      });
    } else {
      plan = await planTurnLLM(input, provider, context, turnId, options.history);
    }

    // 2. Execute actions and collect verified receipts
    const execution = await executePlan(plan, context, turnId);
    const receipts = execution.receipts;
    const reply = execution.reply || composeReplyFromReceipts(plan, receipts);
    const overallSuccess = execution.overallSuccess;

    // 3. Speak reply via TTS if requested and not muted
    if (options.ttsEnabled && !options.muted && reply) {
      try {
        ttsNarrator.speak(reply, {
          voiceName: config.persona?.voice || 'Ara',
          rate: config.ttsRate || 1.0,
          lang: config.persona?.language === 'en' ? 'en-US' : 'es-ES',
        });
        emitTrace({
          turnId,
          ev: 'tts.speak',
          text: reply,
          rate: config.ttsRate || 1.0,
        });
      } catch (ttsErr: any) {
        console.warn('[Operator] TTS speech failed:', ttsErr);
      }
    }

    const durationMs = Date.now() - startTime;

    emitTrace({
      turnId,
      ev: 'turn.end',
      overallSuccess,
      durationMs,
    });

    return {
      turnId,
      plan,
      receipts,
      reply,
      overallSuccess,
      durationMs,
      strategy: plan.strategy,
      providerId: provider.id,
      fallbackReason: plan.fallbackReason,
    };
  } catch (err: any) {
    const errorMsg = err?.message || 'Error inesperado durante la ejecución del turno';
    const durationMs = Date.now() - startTime;

    const fallbackReceipt: ActionReceipt = {
      actionIdx: 0,
      type: 'unknown',
      ok: false,
      error: errorMsg,
      summaryEs: `No se pudo completar la operación: ${errorMsg}`,
    };

    const fallbackPlan: OperatorPlan = {
      strategy: 'heuristic-fallback',
      fallbackReason: errorMsg,
      actions: [],
      reply: fallbackReceipt.summaryEs,
    };

    emitTrace({
      turnId,
      ev: 'turn.end',
      overallSuccess: false,
      durationMs,
      error: errorMsg,
    });

    return {
      turnId,
      plan: fallbackPlan,
      receipts: [fallbackReceipt],
      reply: fallbackReceipt.summaryEs,
      overallSuccess: false,
      durationMs,
      strategy: 'heuristic-fallback',
      fallbackReason: errorMsg,
    };
  }
}

/**
 * Backward compatibility adapter for legacy callers of dispatchOperatorCommand.
 */
export async function dispatchOperatorCommand(
  userInput: string,
  workspaceId?: string
): Promise<any> {
  const turn = await runOperatorTurn(userInput, {
    workspaceId,
    source: 'texto',
  });

  return {
    reply: turn.reply,
    actions: turn.plan.actions,
    provider: turn.strategy === 'llm' ? turn.providerId : 'local',
    model: turn.model || 'operator-v2',
    latencyMs: turn.durationMs,
    usedFallbackLocal: turn.strategy.includes('fallback') || turn.strategy === 'heuristic',
    rawContent: JSON.stringify(turn.plan),
    executionResults: turn.receipts.map((r) => ({
      actionType: r.type,
      description: r.summaryEs,
      status: r.ok ? 'success' : 'failed',
      error: r.error,
      data: r.data,
    })),
  };
}
