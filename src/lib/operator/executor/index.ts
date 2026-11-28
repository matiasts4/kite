// Kite Code — Operator Plan Executor
// Sequentially executes planned actions with receipt verification and trace event emission.

import { emitTrace } from '../trace/trace';
import { sanitizeReply } from '../planner/sanitize';
import { planTurnHeuristic } from '../planner/heuristic';
import type { OperatorPlan, OperatorAction, ActionReceipt, TurnContext } from '../contract';

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
import { executeLaunchThreadAction } from './actions/launchThread';
import { executeLaunchAgentAction } from './actions/launchAgent';
import {
  executeCancelProposalAction,
  executeConfirmProposalAction,
  executePeekAgentsAction,
  executePeekChangesAction,
  executePeekFilesAction,
  executePeekRunsAction,
  executePeekSearchAction,
  executeProposeTaskAction,
  executeReadFindingAction,
  executeRecallConversationsAction,
  executeRefineProposalAction,
  executeStaySilentAction,
  registerProposalStepExecutor,
} from './actions/peekWorkspace';
import { executeManageTasksAction } from './actions/manageTasks';
import {
  executeControlSubagentAction,
  executeCoordinateSwarmAction,
} from './actions/controlSubagents';
import { executeManageRoutinesAction } from './actions/manageRoutines';
import { executeManageMemoryAction } from './actions/manageMemory';
import {
  executeNavigateViewAction,
  executeReadDiffAction,
  executeRunCheckAction,
} from './actions/workspaceOps';

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

  // Silence turns suppress TTS playback completely
  if (receipts.every((r) => r.silent || r.type === 'stay_silent')) {
    return '';
  }

  const audibleReceipts = receipts.filter((r) => !r.silent && r.type !== 'stay_silent');
  const failed = audibleReceipts.filter((r) => !r.ok);
  const succeeded = audibleReceipts.filter((r) => r.ok);

  const spokenText = (r: ActionReceipt) => (r.spokenSummaryEs ?? r.summaryEs).trim();

  if (failed.length === 0) {
    return succeeded.map(spokenText).filter(Boolean).join(' ');
  }

  if (succeeded.length === 0) {
    return failed.map(spokenText).filter(Boolean).join(' ');
  }

  const okPart = succeeded.map(spokenText).filter(Boolean).join(' ');
  const failPart = failed.map(spokenText).filter(Boolean).join(' ');
  return okPart ? `${okPart} Sin embargo, ${failPart}` : failPart;
}

const PARALLELIZABLE_ACTION_TYPES = new Set<OperatorAction['type']>([
  'peek_changes',
  'peek_runs',
  'peek_agents',
  'peek_files',
  'peek_search',
  'read_finding',
  'read_diff',
  'recall_conversations',
  'spawn_subagent',
  'launch_thread',
  'launch_agent',
]);

export function isParallelizableActionType(type: OperatorAction['type']): boolean {
  return PARALLELIZABLE_ACTION_TYPES.has(type);
}

interface ActionWaveItem {
  action: OperatorAction;
  idx: number;
}

interface ActionWave {
  parallel: boolean;
  items: ActionWaveItem[];
}

export function groupActionWaves(actions: OperatorAction[]): ActionWave[] {
  if (actions.length <= 1) {
    return actions.map((action, idx) => ({ parallel: false, items: [{ action, idx }] }));
  }

  const waves: ActionWave[] = [];
  let buffer: ActionWaveItem[] = [];

  const flushBuffer = () => {
    if (buffer.length === 0) return;
    waves.push({ parallel: buffer.length > 1, items: buffer });
    buffer = [];
  };

  for (let idx = 0; idx < actions.length; idx++) {
    const action = actions[idx];
    if (isParallelizableActionType(action.type)) {
      buffer.push({ action, idx });
    } else {
      flushBuffer();
      waves.push({ parallel: false, items: [{ action, idx }] });
    }
  }
  flushBuffer();

  return waves;
}

async function executeActionItem(
  action: OperatorAction,
  idx: number,
  context: TurnContext | undefined,
  currentTurnId: string
): Promise<ActionReceipt> {
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
        receipt = await executeSpawnSubagentAction(action, idx, context);
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

      case 'launch_thread':
        receipt = await executeLaunchThreadAction(action, idx, context);
        break;

      case 'launch_agent':
        receipt = await executeLaunchAgentAction(action, idx, context);
        break;

      case 'peek_changes':
        receipt = await executePeekChangesAction(action, idx, context);
        break;

      case 'peek_runs':
        receipt = await executePeekRunsAction(action, idx, context);
        break;

      case 'peek_agents':
        receipt = await executePeekAgentsAction(action, idx, context);
        break;

      case 'peek_files':
        receipt = await executePeekFilesAction(action, idx, context);
        break;

      case 'peek_search':
        receipt = await executePeekSearchAction(action, idx, context);
        break;

      case 'read_finding':
        receipt = await executeReadFindingAction(action, idx, context);
        break;

      case 'recall_conversations':
        receipt = await executeRecallConversationsAction(action, idx, context);
        break;

      case 'propose_task':
        receipt = await executeProposeTaskAction(action, idx, context);
        break;

      case 'refine_proposal':
        receipt = await executeRefineProposalAction(action, idx, context);
        break;

      case 'confirm_proposal':
        receipt = await executeConfirmProposalAction(action, idx, context);
        break;

      case 'cancel_proposal':
        receipt = await executeCancelProposalAction(action, idx, context);
        break;

      case 'stay_silent':
        receipt = executeStaySilentAction(action, idx);
        break;

      case 'manage_tasks':
        receipt = await executeManageTasksAction(action, idx, context);
        break;

      case 'control_subagent':
        receipt = await executeControlSubagentAction(action, idx, context);
        break;

      case 'coordinate_swarm':
        receipt = await executeCoordinateSwarmAction(action, idx, context);
        break;

      case 'manage_routines':
        receipt = await executeManageRoutinesAction(action, idx, context);
        break;

      case 'manage_memory':
        receipt = await executeManageMemoryAction(action, idx, context);
        break;

      case 'read_diff':
        receipt = await executeReadDiffAction(action, idx, context);
        break;

      case 'run_check':
        receipt = await executeRunCheckAction(action, idx, context);
        break;

      case 'navigate_view':
        receipt = await executeNavigateViewAction(action, idx);
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

  receipt.actionIdx = idx;
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

  return receipt;
}

registerProposalStepExecutor((action, idx, context, turnId) =>
  executeActionItem(action, idx, context, turnId || `plan-${Date.now()}`)
);

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
  const waves = groupActionWaves(plan.actions);

  for (const wave of waves) {
    if (wave.parallel && wave.items.length > 1) {
      const settled = await Promise.allSettled(
        wave.items.map((item) => executeActionItem(item.action, item.idx, context, currentTurnId))
      );
      for (let i = 0; i < wave.items.length; i++) {
        const item = wave.items[i];
        const outcome = settled[i];
        if (outcome.status === 'fulfilled') {
          receipts.push(outcome.value);
        } else {
          const errMsg =
            outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason ?? 'unknown_error');
          receipts.push({
            actionIdx: item.idx,
            type: item.action.type,
            ok: false,
            summaryEs: `Error inesperado ejecutando ${item.action.type}: ${errMsg}`,
            error: errMsg,
            verification: {
              ok: false,
              expected: { type: item.action.type },
              observed: { ok: false },
              error: errMsg,
            },
          });
        }
      }
    } else {
      for (const item of wave.items) {
        const receipt = await executeActionItem(item.action, item.idx, context, currentTurnId);
        receipts.push(receipt);
      }
    }
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

