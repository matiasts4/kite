// Kite Code — LLM Turn Planner
// Validates model output with Zod, handles 1 correction retry, detects echo, supports native tool calls,
// emits durable run ledger events, and falls back gracefully with explicit reasons.

import { buildOperatorSystemPrompt } from './prompt';
import { planTurnHeuristic, isNegatedTerminalImperative } from './heuristic';
import { detectPromptEcho, isPredominantlyEnglish, sanitizeReply } from './sanitize';
import { ActionSchema, type OperatorPlan, type TurnContext, type OperatorContractAction } from '../contract';
import type { PlannerProvider, ProviderMessage } from '../providers/types';
import { emitTrace } from '../trace/trace';
import { runLedger } from '../runLedger';

const EXPLICIT_CLOSE_REASON = 'filtered-unsafe-close';

// Explicit close verbs the user must have written before any close action is allowed.
const EXPLICIT_CLOSE_VERB_RE =
  /(?<![a-záéíóúñ])(?:cierra|cerrar|cierre|cierres|cierren|ci[eé]rral[ao]s?|ci[eé]rrenl[ao]s?|ci[eé]rrel[ao]s?|ci[eé]rrame|cerr[aá]l[ao]s?|cerr[aá]me|sierra|serrar|sierre|sierres|sierren|si[eé]rral[ao]s?|close|kill|mata|matar|mates|maten|m[aá]tal[ao]s?|m[aá]tenl[ao]s?|termina|terminar|termines|terminen|term[ií]nal[ao]s?|elimina|eliminar|elimines|eliminen|elim[ií]nal[ao]s?|apaga|apagar|apagues|apaguen|ap[aá]gal[ao]s?|borra|borrar|borres|borren)(?![a-záéíóúñ])/i;

/**
 * A close action is only allowed when the user explicitly asked to close something
 * and did not negate the order ("no cierres las terminales").
 */
function allowsCloseAction(userInput?: string): boolean {
  if (!userInput) return true;
  if (isNegatedTerminalImperative(userInput)) return false;
  return EXPLICIT_CLOSE_VERB_RE.test(userInput);
}

function logFilteredClose(userInput?: string): void {
  console.warn(
    `[Operator Safety] Acción destructiva 'close_terminals' bloqueada: el prompt ("${userInput}") no contiene una orden explícita de cierre.`
  );
}

function extractJsonFromModelOutput(raw: string): any {
  if (!raw || !raw.trim()) return null;

  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  const jsonSlice = cleaned.slice(firstBrace, lastBrace + 1);
  return JSON.parse(jsonSlice);
}

const MAX_PRIOR_TURNS = 14;

function buildPlannerMessages(
  systemPrompt: string,
  input: string,
  history?: ProviderMessage[]
): ProviderMessage[] {
  const priorTurns = history ? history.slice(-MAX_PRIOR_TURNS) : [];

  return [
    { role: 'system', content: systemPrompt },
    ...priorTurns,
    { role: 'user', content: input },
  ];
}

function parseAndValidateModelPlan(
  rawText: string,
  systemPrompt: string,
  userInput?: string
): {
  plan: OperatorPlan;
  actions: OperatorContractAction[];
  reply: string;
} {
  const lowerRaw = rawText.toLowerCase();
  const promptInstructionLeaks = [
    'reglas críticas',
    'reglas criticas',
    'esquema json permitido',
    'eres el asistente operador',
    'eres el operador de kite code',
    'user request:',
    'contexto actual del sistema',
    'responde siempre con un único objeto json',
    'responde siempre con un unico objeto json',
  ];

  for (const leak of promptInstructionLeaks) {
    if (lowerRaw.includes(leak)) {
      throw new Error('Detección de eco o fuga de prompt del sistema en la salida del modelo.');
    }
  }

  const parsed = extractJsonFromModelOutput(rawText);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('La salida del modelo no contiene un objeto JSON parseable.');
  }

  const candidateReply = typeof parsed.reply === 'string' ? parsed.reply : '';
  if (detectPromptEcho(candidateReply, systemPrompt)) {
    throw new Error('Detección de eco o fuga de prompt en el campo reply.');
  }

  if (isPredominantlyEnglish(candidateReply)) {
    throw new Error('La respuesta del modelo vino predominantemente en inglés.');
  }

  // Validate actions array
  const rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];
  const validatedActions: OperatorContractAction[] = [];

  const closeAllowed = allowsCloseAction(userInput);
  let filteredUnsafeClose = false;

  for (const act of rawActions) {
    const validated = ActionSchema.parse(act);
    // Defense-in-depth safety guardrail:
    if (validated.type === 'close_terminals' && !closeAllowed) {
      filteredUnsafeClose = true;
      logFilteredClose(userInput);
      continue;
    }
    validatedActions.push(validated);
  }

  const reply = sanitizeReply(
    filteredUnsafeClose && validatedActions.length === 0
      ? 'No ejecuté el cierre porque la orden no lo pedía explícitamente.'
      : candidateReply,
    'Acción planificada con éxito.'
  );

  const plan: OperatorPlan = {
    strategy: 'llm',
    actions: validatedActions,
    reply,
    answer: typeof parsed.answer === 'string' ? parsed.answer : undefined,
    ...(filteredUnsafeClose ? { fallbackReason: EXPLICIT_CLOSE_REASON } : {}),
  };

  return { plan, actions: validatedActions, reply };
}

export async function planTurnLLM(
  input: string,
  provider: PlannerProvider,
  context?: TurnContext,
  turnId?: string,
  history?: ProviderMessage[]
): Promise<OperatorPlan> {
  const currentTurnId = turnId || `turn-${Date.now()}`;
  if (!runLedger.getRun(currentTurnId)) {
    runLedger.startRun(input, { runId: currentTurnId, taskType: 'llm_plan' });
  }

  const systemPrompt = buildOperatorSystemPrompt(context);

  const messages = buildPlannerMessages(systemPrompt, input, history);

  let rawOutput = '';
  let latencyMs = 0;
  let modelName = 'unknown';

  try {
    console.info(`[Zed] Planificando con ${provider.id}…`);
    runLedger.recordProviderRequest(currentTurnId, {
      provider: provider.id,
      model: modelName,
      reasoningSetting: 'low',
    });

    // Attempt 1: primary call with streaming & native tool-call listening
    let firstTokenSeen = false;
    const res = await provider.plan(messages, {
      stream: true,
      reasoning: 'low',
      onFirstToken: (ts) => {
        if (!firstTokenSeen) {
          firstTokenSeen = true;
          runLedger.recordFirstToken(currentTurnId, ts);
        }
      },
      onToolCall: (tc) => {
        runLedger.recordToolEmission(currentTurnId, {
          name: tc.name,
          arguments: tc.arguments,
        });
      },
    });

    rawOutput = res.rawText;
    latencyMs = res.latencyMs;
    modelName = res.model || 'unknown';

    runLedger.recordProviderResponse(currentTurnId, {
      latencyMs,
      tokenCounts: res.tokenCounts,
      rawText: rawOutput,
    });

    // If native tool calls were returned, validate and construct plan directly
    if (res.toolCalls && res.toolCalls.length > 0) {
      const closeAllowed = allowsCloseAction(input);
      const validatedActions: OperatorContractAction[] = [];
      let filteredUnsafeClose = false;

      for (const tc of res.toolCalls) {
        const candidate = {
          type: tc.name,
          ...(typeof tc.arguments === 'object' && tc.arguments !== null ? tc.arguments : {}),
        };
        const validated = ActionSchema.parse(candidate);
        // Native tool calls must not bypass the close safety guard.
        if (validated.type === 'close_terminals' && !closeAllowed) {
          filteredUnsafeClose = true;
          logFilteredClose(input);
          continue;
        }
        validatedActions.push(validated);
      }

      const plan: OperatorPlan = {
        strategy: 'llm',
        actions: validatedActions,
        reply: sanitizeReply(
          filteredUnsafeClose && validatedActions.length === 0
            ? 'No ejecuté el cierre porque la orden no lo pedía explícitamente.'
            : res.rawText || 'Acción planificada con éxito.'
        ),
        ...(filteredUnsafeClose ? { fallbackReason: EXPLICIT_CLOSE_REASON } : {}),
      };

      emitTrace({
        turnId: currentTurnId,
        ev: 'plan.created',
        strategy: 'llm',
        provider: provider.id,
        model: modelName,
        latencyMs,
        actions: validatedActions,
        fallbackReason: plan.fallbackReason,
        rawModelOutputTruncated: rawOutput.slice(0, 2000),
      });

      return plan;
    }

    try {
      const validated = parseAndValidateModelPlan(rawOutput, systemPrompt, input);

      emitTrace({
        turnId: currentTurnId,
        ev: 'plan.created',
        strategy: 'llm',
        provider: provider.id,
        model: modelName,
        latencyMs,
        actions: validated.actions,
        rawModelOutputTruncated: rawOutput.slice(0, 2000),
      });

      for (const act of validated.actions) {
        runLedger.recordToolEmission(currentTurnId, {
          name: act.type,
          arguments: act as unknown as Record<string, unknown>,
        });
      }

      return validated.plan;
    } catch (parseErr: any) {
      // Attempt 2: one correction retry
      const correctionMessages: ProviderMessage[] = [
        ...messages,
        { role: 'assistant', content: rawOutput },
        {
          role: 'user',
          content:
            'Tu respuesta anterior no cumplió el esquema JSON requerido. Por favor responde ÚNICAMENTE con el objeto JSON válido con campos "reply" y "actions".',
        },
      ];

      const retryRes = await provider.plan(correctionMessages);
      rawOutput = retryRes.rawText;
      latencyMs += retryRes.latencyMs;

      const retryValidated = parseAndValidateModelPlan(rawOutput, systemPrompt, input);

      emitTrace({
        turnId: currentTurnId,
        ev: 'plan.created',
        strategy: 'llm',
        provider: provider.id,
        model: modelName,
        latencyMs,
        actions: retryValidated.actions,
        rawModelOutputTruncated: rawOutput.slice(0, 2000),
      });

      for (const act of retryValidated.actions) {
        runLedger.recordToolEmission(currentTurnId, {
          name: act.type,
          arguments: act as unknown as Record<string, unknown>,
        });
      }

      return retryValidated.plan;
    }
  } catch (err: any) {
    // Check if error was timeout or cancellation
    const isTimeout = err?.errorCategory === 'timeout' || /timed out/i.test(err?.message || '');
    const isCancellation = err?.name === 'AbortError' || /aborted/i.test(err?.message || '');

    if (isTimeout) {
      runLedger.recordTimeout(currentTurnId, {
        errorCategory: 'gateway_timeout',
        message: err.message,
      });
    } else if (isCancellation) {
      runLedger.recordCancellation(currentTurnId, {
        reason: err.message,
      });
    }

    // Graceful fallback to heuristic
    const fallbackReason = err?.message || 'Error invocando proveedor LLM';
    const heuristicPlan = planTurnHeuristic(input);

    heuristicPlan.strategy = 'heuristic-fallback';
    heuristicPlan.fallbackReason = fallbackReason;

    emitTrace({
      turnId: currentTurnId,
      ev: 'plan.created',
      strategy: 'heuristic-fallback',
      fallbackReason,
      provider: provider.id,
      model: modelName,
      latencyMs,
      actions: heuristicPlan.actions,
      rawModelOutputTruncated: rawOutput ? rawOutput.slice(0, 2000) : undefined,
    });

    return heuristicPlan;
  }
}
