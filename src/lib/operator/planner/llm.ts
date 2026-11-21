// Kite Code — LLM Turn Planner
// Validates model output with Zod, handles 1 correction retry, detects echo, supports native tool calls,
// emits durable run ledger events, and falls back gracefully with explicit reasons.

import { buildOperatorSystemPrompt } from './prompt';
import { planTurnHeuristic } from './heuristic';
import { analyzeClausePolarity } from './clausePolarity';
import { normalizeSpanishVoiceStt } from './voiceNormalizer';
import { detectPromptEcho, isPredominantlyEnglish, sanitizeReply } from './sanitize';
import {
  ActionSchema,
  ClarificationSchema,
  type OperatorPlan,
  type TurnContext,
  type OperatorContractAction,
} from '../contract';
import type { PlannerProvider, ProviderMessage } from '../providers/types';
import { emitTrace } from '../trace/trace';
import { runLedger } from '../runLedger';
import {
  consultChats,
  fetchLiveChatCatalog,
  liveChatReader,
  type ConsultChatsResult,
} from '../chatIndex';
import { StreamingJsonReplyExtractor } from '../voice/speechProsody';
import type { PendingDisambiguationState } from '../voice/voiceSessionStore';

const EXPLICIT_CLOSE_REASON = 'filtered-unsafe-close';

/**
 * A close action is only allowed when at least one non-negated, non-subordinate clause
 * explicitly requests closing ("no cierres las terminales, abre un hilo" => false;
 * "no abras terminales, cierra Orion" => true).
 */
function allowsCloseAction(userInput?: string): boolean {
  if (!userInput) return true;
  const normalized = normalizeSpanishVoiceStt(userInput).normalized;
  return analyzeClausePolarity(normalized).allowsClose;
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

  const parsedClarification = parsed.clarification
    ? ClarificationSchema.safeParse(parsed.clarification)
    : null;
  const clarification = parsedClarification?.success ? parsedClarification.data : undefined;

  const fallbackText = clarification?.question || 'Acción planificada con éxito.';
  const reply = sanitizeReply(
    filteredUnsafeClose && validatedActions.length === 0
      ? 'No ejecuté el cierre porque la orden no lo pedía explícitamente.'
      : candidateReply || (typeof parsed.answer === 'string' ? parsed.answer : ''),
    fallbackText
  );

  const plan: OperatorPlan = {
    strategy: 'llm',
    actions: clarification ? [] : validatedActions,
    reply,
    answer:
      typeof parsed.answer === 'string'
        ? parsed.answer
        : clarification
          ? clarification.question
          : undefined,
    ...(clarification ? { clarification } : {}),
    ...(filteredUnsafeClose ? { fallbackReason: EXPLICIT_CLOSE_REASON } : {}),
  };

  return { plan, actions: validatedActions, reply };
}

export interface PlanTurnLLMOptions {
  onStreamSentence?: (sentence: string) => void;
  pendingDisambiguation?: PendingDisambiguationState | null;
}

export async function planTurnLLM(
  input: string,
  provider: PlannerProvider,
  context?: TurnContext,
  turnId?: string,
  history?: ProviderMessage[],
  planOptions?: PlanTurnLLMOptions
): Promise<OperatorPlan> {
  const currentTurnId = turnId || `turn-${Date.now()}`;
  if (!runLedger.getRun(currentTurnId)) {
    runLedger.startRun(input, { runId: currentTurnId, taskType: 'llm_plan' });
  }

  let chatReach: ConsultChatsResult | undefined;
  try {
    const catalog = await fetchLiveChatCatalog(context?.workspaceId);
    if (catalog.entries.length > 0) {
      chatReach = await consultChats(input, catalog, liveChatReader);
    }
  } catch (chatErr) {
    console.warn('[Zed] Error consultando índice de chats:', chatErr);
  }

  const chatReachTraceFields =
    chatReach && (chatReach.kind === 'read' || chatReach.kind === 'index')
      ? {
          chatReachKind: chatReach.kind,
          chatReachText: chatReach.text,
        }
      : {};

  const systemPrompt = buildOperatorSystemPrompt(context, chatReach, {
    pendingDisambiguation: planOptions?.pendingDisambiguation,
  });

  const messages = buildPlannerMessages(systemPrompt, input, history);

  let rawOutput = '';
  let latencyMs = 0;
  let modelName = 'unknown';

  try {
    console.info(`[Zed] Planificando con ${provider.id}…`);
    const requestStartedAt = Date.now();
    runLedger.recordProviderRequest(currentTurnId, {
      provider: provider.id,
      model: modelName,
      reasoningSetting: 'low',
    });

    // Attempt 1: primary call with streaming & native tool-call listening
    let firstTokenSeen = false;
    let firstSentenceEmitted = false;
    // Stream only `"answer"` (conversational / clarification turns with actions: [])
    // so we never speak unverified confirmations for mutating actions before execution.
    const sentenceExtractor = planOptions?.onStreamSentence
      ? new StreamingJsonReplyExtractor(['answer'])
      : null;

    const emitStreamedSentences = (sentences: string[]) => {
      if (!planOptions?.onStreamSentence) return;
      for (const s of sentences) {
        if (!firstSentenceEmitted) {
          firstSentenceEmitted = true;
          emitTrace({
            turnId: currentTurnId,
            ev: 'tts.first_sentence',
            chars: s.length,
            streamed: true,
          });
        }
        planOptions.onStreamSentence(s);
      }
    };

    const res = await provider.plan(messages, {
      stream: true,
      reasoning: 'low',
      onFirstToken: (ts) => {
        if (!firstTokenSeen) {
          firstTokenSeen = true;
          runLedger.recordFirstToken(currentTurnId, ts);
          emitTrace({
            turnId: currentTurnId,
            ev: 'llm.first_token',
            ts,
            provider: provider.id,
            firstTokenMs: Math.max(0, ts - requestStartedAt),
          });
        }
      },
      onDelta: sentenceExtractor
        ? (delta) => {
            const ready = sentenceExtractor.pushDelta(delta);
            if (ready.length > 0) {
              emitStreamedSentences(ready);
            }
          }
        : undefined,
      onToolCall: (tc) => {
        runLedger.recordToolEmission(currentTurnId, {
          name: tc.name,
          arguments: tc.arguments,
        });
      },
    });

    if (sentenceExtractor && firstSentenceEmitted) {
      const remaining = sentenceExtractor.finish();
      if (remaining.length > 0) {
        emitStreamedSentences(remaining);
      }
    }

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
        ...chatReachTraceFields,
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
        ...chatReachTraceFields,
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
        ...chatReachTraceFields,
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
