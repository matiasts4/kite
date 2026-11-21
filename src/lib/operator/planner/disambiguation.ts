// Kite Code — Active Disambiguation Guard (S8: Max 1 Concrete Question Before Delegating)
// Prevents destructive guesses or empty delegations by holding a structured PendingDisambiguation
// slot and resolving it cleanly on the next turn without ever looping.

import type { OperatorClarification, OperatorPlan, TurnContext } from '../contract';
import type { PendingDisambiguationState } from '../voice/voiceSessionStore';

const CANCELLATION_RE =
  /^(?:cancel(?:a|ar)?|d[eé]jalo(?:\s+as[ií])?|olv[ií]dalo|mejor\s+no|nada|no\s+importa|no\s+hagas\s+nada|olvida\s+eso|ya\s+no)[.!?]*$/i;

const AMBIGUOUS_DEICTIC_TARGET_RE = /^(?:esa|ese|eso|esta|este|aquella|aquel|una|uno)$/i;
const PLACEHOLDER_TASK_RE = /^(?:tarea\s+delegada|esto|eso|algo|pendiente)?$/i;

export function isDisambiguationCancellation(input: string): boolean {
  return CANCELLATION_RE.test((input || '').trim());
}

/**
 * Evaluates whether a planned action is missing a critical slot or has an ambiguous target
 * in the active workspace. Returns a single concrete Spanish clarification question when needed,
 * or `null` when safe to execute directly (or when a clarification question was ALREADY asked).
 */
export function detectPreExecutionDisambiguation(
  rawInput: string,
  plan: OperatorPlan,
  context?: TurnContext,
  existingPending?: PendingDisambiguationState | null
): OperatorClarification | null {
  // Anti-loop rule (S8): never ask a second consecutive question for the same intent.
  if (existingPending) return null;
  if (plan.clarification) return plan.clarification;
  if (!plan.actions || plan.actions.length === 0) return null;

  for (const action of plan.actions) {
    // 1. Ambiguous destructive close ("cierra esa" when >1 active terminal exists)
    if (action.type === 'close_terminals') {
      const targetStr = typeof action.target === 'string' ? action.target.trim().toLowerCase() : '';
      const activeTerminals = context?.activeTerminals || [];
      if (AMBIGUOUS_DEICTIC_TARGET_RE.test(targetStr) && activeTerminals.length > 1) {
        const candidates = activeTerminals
          .slice(0, 3)
          .map((t, i) => t.who || `Terminal ${i + 1}`);
        return {
          question: `¿Cuál quieres cerrar: ${candidates.join(' o ')}?`,
          missingSlot: 'target',
          candidates,
          draftAction: { ...action },
        };
      }
    }

    // 2. Subagent delegation with missing/empty concrete task
    if (action.type === 'spawn_subagent') {
      const task = (action.task || '').trim();
      if (PLACEHOLDER_TASK_RE.test(task) || task.length < 4) {
        return {
          question: '¿Qué tarea concreta quieres que delegue al subagente?',
          missingSlot: 'task',
          draftAction: { ...action },
        };
      }
    }

    // 3. Autonomous agent delegation when no agent was named and >1 profile exists in workspace
    if (action.type === 'launch_agent') {
      const query = (action.agentQuery || '').trim();
      const agents = context?.autonomousAgents || [];
      if (!query && agents.length > 1) {
        const candidates = agents.slice(0, 3).map((a) => a.name);
        return {
          question: `¿A qué agente se lo delego: ${candidates.join(' o ')}?`,
          missingSlot: 'target',
          candidates,
          draftAction: { ...action },
        };
      }
      const body = (action.body || '').trim();
      if (PLACEHOLDER_TASK_RE.test(body) || body.length < 4) {
        return {
          question: '¿Qué instrucción concreta quieres que le envíe al agente?',
          missingSlot: 'task',
          draftAction: { ...action },
        };
      }
    }
  }

  // 4. Utterance mentions a vague delegation ("delega esto", "mándaselo al agente") with no resolved target
  const lower = (rawInput || '').trim().toLowerCase();
  if (/^(?:delega|manda|env[ií]a)\s+(?:esto|eso)\b/i.test(lower) && plan.actions.length === 0) {
    return {
      question: '¿Quieres que lo delegue a un hilo, un subagente o un agente específico?',
      missingSlot: 'surface',
      candidates: ['Hilo', 'Subagente', 'Agente autónomo'],
    };
  }

  return null;
}

export function buildPendingDisambiguationState(
  originalInput: string,
  clarification: OperatorClarification
): PendingDisambiguationState {
  return {
    question: clarification.question,
    missingSlot: clarification.missingSlot,
    originalInput,
    candidates: clarification.candidates,
    draftAction: clarification.draftAction,
    createdAt: Date.now(),
    remainingTurns: 1,
  };
}
