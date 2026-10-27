// Kite Code — Operator Plan Executor
// Sequentially executes planned actions with receipt verification and trace event emission.

import { emitTrace } from '../trace/trace';
import { sanitizeReply } from '../planner/sanitize';
import { planTurnHeuristic } from '../planner/heuristic';
import type { OperatorPlan, ActionReceipt, TurnContext } from '../contract';

import { executeOpenTerminalsAction } from './actions/openTerminals';
import { executeCloseTerminalsAction } from './actions/closeTerminals';
import { executeInjectPromptAction } from './actions/injectPrompt';
import { executeOpenBrowserAction } from './actions/openBrowser';
import { executeNarrateAction } from './actions/narrate';
import { executeSpawnSubagentAction } from './actions/spawnSubagent';
import { executeStopSpeakingAction } from './actions/stopSpeaking';
import { executeHandoffToAgentAction } from './actions/handoffToAgent';
import { executeManagePaneLayoutAction } from './actions/managePaneLayout';
import { executeSwitchWorkspaceAction } from './actions/switchWorkspace';

export function composeReplyFromReceipts(
  plan: OperatorPlan,
  receipts: ActionReceipt[]
): string {
  if (receipts.length === 0) {
    if (plan.answer) {
      return sanitizeReply(plan.answer);
    }
    if (plan.reply) {
      return sanitizeReply(plan.reply);
    }
    return 'No reconocí una acción concreta para ejecutar en el sistema.';
  }

  const failed = receipts.filter((r) => !r.ok);
  const succeeded = receipts.filter((r) => r.ok);

  if (failed.length === 0) {
    return succeeded.map((r) => r.summaryEs).join(' ');
  }

  if (succeeded.length === 0) {
    return failed.map((r) => r.summaryEs).join(' ');
  }

  return `${succeeded.map((r) => r.summaryEs).join(' ')} Sin embargo, ${failed.map((r) => r.summaryEs).join(' ')}`;
}

export async function executePlan(
  plan: OperatorPlan,
  context?: TurnContext,
  turnId?: string
): Promise<{
  receipts: ActionReceipt[];
  reply: string;
  overallSuccess: boolean;
}> {
  const currentTurnId = turnId || `turn-${Date.now()}`;
  const receipts: ActionReceipt[] = [];

  for (let idx = 0; idx < plan.actions.length; idx++) {
    const action = plan.actions[idx];
    const actionStartMs = Date.now();

    emitTrace({
      turnId: currentTurnId,
      ev: 'action.start',
      actionIdx: idx,
      type: action.type,
      args: action as unknown as Record<string, unknown>,
    });

    let receipt: ActionReceipt;

    try {
      switch (action.type) {
        case 'open_terminals':
          receipt = await executeOpenTerminalsAction(action, context, currentTurnId, idx);
          break;

        case 'close_terminals':
          receipt = await executeCloseTerminalsAction(action, idx, context);
          break;

        case 'inject_prompt':
          receipt = await executeInjectPromptAction(action, idx, context);
          break;

        case 'open_browser':
          receipt = await executeOpenBrowserAction(action, idx);
          break;

        case 'narrate_summary':
          receipt = await executeNarrateAction(action, idx, context);
          break;

        case 'spawn_subagent':
          receipt = await executeSpawnSubagentAction(action, idx);
          break;

        case 'stop_speaking':
          receipt = executeStopSpeakingAction(idx);
          break;

        case 'handoff_to_agent':
          receipt = await executeHandoffToAgentAction(action, idx, context);
          break;

        case 'manage_pane_layout':
          receipt = await executeManagePaneLayoutAction(action, idx, context);
          break;

        case 'switch_workspace':
          receipt = await executeSwitchWorkspaceAction(action, idx, context);
          break;

        default:
          receipt = {
            actionIdx: idx,
            type: (action as any).type || 'unknown',
            ok: false,
            summaryEs: `Acción desconocida: ${(action as any).type}`,
            error: 'unsupported-action',
          };
          break;
      }
    } catch (err: any) {
      receipt = {
        actionIdx: idx,
        type: action.type,
        ok: false,
        summaryEs: `Error inesperado ejecutando ${action.type}: ${err?.message || String(err)}`,
        error: err?.message || String(err),
      };
    }

    receipt.durationMs = Date.now() - actionStartMs;

    // S1: every executed action is verified, even when the executor reports no
    // postcondition probe of its own. The synthesized verification mirrors the
    // receipt outcome so `trace.receipts` never shows an unverified action.
    if (!receipt.verification) {
      receipt.verification = {
        ok: receipt.ok,
        expected: { type: action.type },
        observed: { ok: receipt.ok },
        error: receipt.error,
      };
    }

    emitTrace({
      turnId: currentTurnId,
      ev: 'action.verify',
      actionIdx: idx,
      expected: receipt.verification.expected,
      observed: receipt.verification.observed,
      ok: receipt.verification.ok,
      error: receipt.verification.error,
    });

    emitTrace({
      turnId: currentTurnId,
      ev: 'action.end',
      actionIdx: idx,
      type: receipt.type,
      status: receipt.ok ? 'success' : 'failed',
      error: receipt.error,
      ms: receipt.durationMs,
    });

    receipts.push(receipt);
  }

  // S1: a plan whose actions were stripped by a safety guard must never claim success.
  const overallSuccess =
    plan.actions.length === 0
      ? plan.fallbackReason !== 'filtered-unsafe-close' &&
        Boolean(plan.reply || plan.answer) &&
        !receipts.some((r) => !r.ok)
      : receipts.length > 0 && receipts.every((r) => r.ok);

  const reply = composeReplyFromReceipts(plan, receipts);

  emitTrace({
    turnId: currentTurnId,
    ev: 'reply.composed',
    text: reply,
    source: receipts.length > 0 ? 'receipts' : 'answer',
  });

  return {
    receipts,
    reply,
    overallSuccess,
  };
}

/**
 * Direct command executor adapter.
 */
export async function executeOperatorCommand(
  userInput: string,
  workspaceId?: string
): Promise<{ success: boolean; message: string; data?: any }> {
  const plan = planTurnHeuristic(userInput);
  const execution = await executePlan(plan, { workspaceId, mode: 'code' });
  return {
    success: execution.overallSuccess,
    message: execution.reply,
    data: execution.receipts,
  };
}

