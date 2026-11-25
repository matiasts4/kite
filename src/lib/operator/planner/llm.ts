// Kite Code — LLM Turn Planner
// Validates model output with Zod, handles 1 correction retry, detects echo, supports native tool calls,
// emits durable run ledger events, and falls back gracefully with explicit reasons.

import { buildOperatorPromptPartsAsync } from './prompt';
import { planTurnHeuristic } from './heuristic';
import { analyzeClausePolarity } from './clausePolarity';
import { normalizeSpanishVoiceStt } from './voiceNormalizer';
import { detectPromptEcho, isPredominantlyEnglish, sanitizeReply } from './sanitize';
import { classifyIntentSuites } from './toolSuites';
import {
  ActionSchema,
  ClarificationSchema,
  OPERATOR_NATIVE_TOOLS,
  type OperatorPlan,
  type TurnContext,
  type OperatorContractAction,
} from '../contract';
import type { PlannerProvider, ProviderMessage } from '../providers/types';
import { emitTrace } from '../trace/trace';
import { runLedger } from '../runLedger';
import {
  consultChats,
  liveChatReader,
  type ConsultChatsResult,
} from '../chatIndex';
import { getCachedLiveChatCatalog } from '../voice/sessionPrewarm';
import { ctxClient } from '../context/ctxClient';
import { StreamingJsonReplyExtractor } from '../voice/speechProsody';
import {
  voiceSessionStore,
  type DraftTaskProposal,
  type PendingDisambiguationState,
} from '../voice/voiceSessionStore';

const EXPLICIT_CLOSE_REASON = 'filtered-unsafe-close';
const REFERENCES_PAST_CONVERSATIONS_RE =
  /\b(?:chat|chats|hilo|hilos|thread|threads|conversaci[oó]n|conversaciones|ayer|anoche|sesi[oó]n\s+anterior|[uú]ltima\s+sesi[oó]n|lo\s+[uú]ltimo\s+que|pendiente|hablamos|delegamos|memoria|recuerda|acuerdas)\b/i;

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

const MAX_VERBATIM_PRIOR_TURNS = 4;
const MAX_VERBATIM_MESSAGES = MAX_VERBATIM_PRIOR_TURNS * 2;
const MAX_ROLLING_SUMMARY_CHARS = 480; // ~120 tokens

function estimateTokensApprox(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function compressRolledOffHistory(olderMessages: ProviderMessage[]): string | null {
  if (!olderMessages || olderMessages.length === 0) return null;
  const snippets = olderMessages.map((msg) => {
    const roleLabel = msg.role === 'user' ? 'U' : 'A';
    const compact = msg.content.replace(/\s+/g, ' ').trim().slice(0, 56);
    return `${roleLabel}: ${compact}`;
  });
  const packed = ctxClient.packVoiceContextSync({
    workingContextSummary: snippets.join(' | '),
    maxTokens: 110,
  }).packedText;
  const cleaned = packed.replace(/^Sesión:\s*/i, '').trim();
  const body = `RESUMEN DE TURNOS PREVIOS (${Math.ceil(olderMessages.length / 2)} turnos): ${cleaned}`;
  return body.length > MAX_ROLLING_SUMMARY_CHARS
    ? `${body.slice(0, MAX_ROLLING_SUMMARY_CHARS - 1)}…`
    : body;
}

function buildPlannerMessages(
  staticPrefix: string,
  dynamicTail: string,
  input: string,
  history?: ProviderMessage[]
): {
  messages: ProviderMessage[];
  historyMessages: ProviderMessage[];
} {
  const allPrior = history ?? [];
  const verbatimTurns = allPrior.slice(-MAX_VERBATIM_MESSAGES);
  const olderTurns =
    allPrior.length > MAX_VERBATIM_MESSAGES
      ? allPrior.slice(0, allPrior.length - MAX_VERBATIM_MESSAGES)
      : [];
  const summaryText = compressRolledOffHistory(olderTurns);
  const historyMessages: ProviderMessage[] = summaryText
    ? [{ role: 'system', content: summaryText }, ...verbatimTurns]
    : [...verbatimTurns];

  const messages: ProviderMessage[] = [
    { role: 'system', content: staticPrefix },
    ...historyMessages,
    { role: 'system', content: dynamicTail },
    { role: 'user', content: input },
  ];

  return { messages, historyMessages };
}

function parseAndValidateModelPlan(
  rawText: string,
  systemPrompt: string,
  userInput?: string
): {
  plan: OperatorPlan & { escalate?: boolean };
  actions: OperatorContractAction[];
  reply: string;
  escalate?: boolean;
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

  const isSilentTurn =
    validatedActions.length > 0 && validatedActions.every((a) => a.type === 'stay_silent');

  const fallbackText = isSilentTurn ? '' : clarification?.question || 'Acción planificada con éxito.';
  const reply = isSilentTurn
    ? ''
    : sanitizeReply(
        filteredUnsafeClose && validatedActions.length === 0
          ? 'No ejecuté el cierre porque la orden no lo pedía explícitamente.'
          : candidateReply || (typeof parsed.answer === 'string' ? parsed.answer : ''),
        fallbackText
      );

  const escalate = parsed.escalate === true;

  const plan: OperatorPlan & { escalate?: boolean } = {
    strategy: 'llm',
    actions: clarification ? [] : validatedActions,
    reply,
    answer:
      isSilentTurn
        ? ''
        : typeof parsed.answer === 'string'
          ? parsed.answer
          : clarification
            ? clarification.question
            : undefined,
    ...(clarification ? { clarification } : {}),
    ...(filteredUnsafeClose ? { fallbackReason: EXPLICIT_CLOSE_REASON } : {}),
    ...(escalate ? { escalate: true } : {}),
  };

  return { plan, actions: validatedActions, reply, escalate };
}

export interface PlanTurnLLMOptions {
  onStreamSentence?: (sentence: string) => void;
  pendingDisambiguation?: PendingDisambiguationState | null;
  draftProposal?: DraftTaskProposal | TurnContext['draftProposal'] | null;
  signal?: AbortSignal;
  forceFullToolCatalog?: boolean;
}

export type OperatorPlanWithMeta = OperatorPlan & {
  escalate?: boolean;
};

export async function planTurnLLM(
  input: string,
  provider: PlannerProvider,
  context?: TurnContext,
  turnId?: string,
  history?: ProviderMessage[],
  planOptions?: PlanTurnLLMOptions
): Promise<OperatorPlanWithMeta> {
  const currentTurnId = turnId || `turn-${Date.now()}`;
  if (!runLedger.getRun(currentTurnId)) {
    runLedger.startRun(input, { runId: currentTurnId, taskType: 'llm_plan' });
  }

  const proposalScope = context?.boundThreadId || context?.workspaceId || '__default__';
  const activeDraftProposal =
    planOptions?.draftProposal !== undefined
      ? planOptions.draftProposal
      : context?.draftProposal !== undefined
        ? context.draftProposal
        : voiceSessionStore.getDraftProposal(proposalScope);

  let chatReach: ConsultChatsResult | undefined;
  const shouldConsultChats =
    REFERENCES_PAST_CONVERSATIONS_RE.test(input) || Boolean(activeDraftProposal);
  if (shouldConsultChats) {
    try {
      const catalog = await getCachedLiveChatCatalog(context?.workspaceId);
      if (catalog.entries.length > 0) {
        chatReach = await consultChats(input, catalog, liveChatReader);
      }
    } catch (chatErr) {
      console.warn('[Argos] Error consultando índice de chats:', chatErr);
    }
  }

  const chatReachTraceFields =
    chatReach && (chatReach.kind === 'read' || chatReach.kind === 'index')
      ? {
          chatReachKind: chatReach.kind,
          chatReachText: chatReach.text,
        }
      : {};

  const nativeToolsEnabled = provider.id !== 'local';
  const promptParts = await buildOperatorPromptPartsAsync(context, chatReach, {
    pendingDisambiguation: planOptions?.pendingDisambiguation,
    draftProposal: activeDraftProposal,
    nativeToolsEnabled,
  });
  const systemPrompt = promptParts.fullPrompt;

  const { messages, historyMessages } = buildPlannerMessages(
    promptParts.staticPrefix,
    promptParts.dynamicTail,
    input,
    history
  );

  const suiteClassification = planOptions?.forceFullToolCatalog
    ? {
        suites: ['orchestration', 'terminals', 'inspect'] as const,
        tools: OPERATOR_NATIVE_TOOLS,
        confidence: 'high' as const,
        isConversational: false,
      }
    : classifyIntentSuites(input, context, OPERATOR_NATIVE_TOOLS);
  let activeTools = suiteClassification.tools;
  let usedFullCatalogRetry = Boolean(planOptions?.forceFullToolCatalog);

  let rawOutput = '';
  let latencyMs = 0;
  let modelName = 'unknown';

  const recordTurnTokenBreakdown = (
    tokenCounts?: { prompt?: number; completion?: number; cache?: number },
    toolsSent: readonly unknown[] = activeTools
  ) => {
    const systemStaticTokens = estimateTokensApprox(promptParts.staticPrefix);
    const contextDynamicTokens = estimateTokensApprox(promptParts.dynamicTail);
    const toolsSchemaTokens = estimateTokensApprox(JSON.stringify(toolsSent));
    const historyTokens = estimateTokensApprox(
      historyMessages.map((m) => m.content).join('\n')
    );
    const fallbackPromptTotal =
      systemStaticTokens +
      contextDynamicTokens +
      toolsSchemaTokens +
      historyTokens +
      estimateTokensApprox(input);
    const promptTokensTotal = tokenCounts?.prompt ?? fallbackPromptTotal;
    const cachedTokens = tokenCounts?.cache ?? 0;
    const completionTokens = tokenCounts?.completion ?? estimateTokensApprox(rawOutput);
    const cacheHitRatio =
      promptTokensTotal > 0 ? Number((cachedTokens / promptTokensTotal).toFixed(4)) : 0;

    runLedger.recordTokenBreakdown(currentTurnId, {
      systemStaticTokens,
      contextDynamicTokens,
      toolsSchemaTokens,
      historyTokens,
      promptTokensTotal,
      cachedTokens,
      completionTokens,
      cacheHitRatio,
    });
  };

  try {
    console.info(`[Argos] Planificando con ${provider.id}…`);
    const requestStartedAt = Date.now();
    runLedger.recordProviderRequest(currentTurnId, {
      provider: provider.id,
      model: modelName,
      reasoningSetting: 'low',
    });

    // Attempt 1: primary call with streaming & pruned native tools
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
          const ttsReqTs = Date.now();
          runLedger.recordVoiceMilestones(currentTurnId, { ttsRequestAt: ttsReqTs });
          emitTrace({
            turnId: currentTurnId,
            ev: 'tts.first_sentence',
            chars: s.length,
            streamed: true,
            ttsRequestAt: ttsReqTs,
          });
        }
        planOptions.onStreamSentence(s);
      }
    };

    const runProviderAttempt = (toolsForCall: unknown[]) =>
      provider.plan(messages, {
        stream: true,
        reasoning: 'low',
        signal: planOptions?.signal,
        tools: toolsForCall,
        onFirstToken: (ts) => {
          if (!firstTokenSeen) {
            firstTokenSeen = true;
            runLedger.recordFirstToken(currentTurnId, ts);
            emitTrace({
              turnId: currentTurnId,
              ev: 'llm.first_token',
              ts,
              provider: provider.id,
              firstTokenAt: ts,
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

    let res = await runProviderAttempt(activeTools);

    if (sentenceExtractor && firstSentenceEmitted) {
      const remaining = sentenceExtractor.finish();
      if (remaining.length > 0) {
        emitStreamedSentences(remaining);
      }
    }

    // Single automatic retry with full catalog if pruned tools missed an emitted tool or returned a suite miss
    const prunedToolNames = new Set(activeTools.map((t) => t.function.name));
    const hasOutOfSuiteToolCall = Boolean(
      !usedFullCatalogRetry &&
        res.toolCalls?.some((tc) => !prunedToolNames.has(tc.name))
    );
    const hasAmbiguousEmptyToolMiss = Boolean(
      !usedFullCatalogRetry &&
        (!res.toolCalls || res.toolCalls.length === 0) &&
        suiteClassification.confidence === 'low' &&
        !res.rawText.trim()
    );
    if (hasOutOfSuiteToolCall || hasAmbiguousEmptyToolMiss) {
      usedFullCatalogRetry = true;
      activeTools = OPERATOR_NATIVE_TOOLS;
      res = await runProviderAttempt(activeTools);
    }

    rawOutput = res.rawText;
    latencyMs = res.latencyMs;
    modelName = res.model || 'unknown';

    runLedger.recordProviderResponse(currentTurnId, {
      latencyMs,
      tokenCounts: res.tokenCounts,
      rawText: rawOutput,
    });
    recordTurnTokenBreakdown(res.tokenCounts, activeTools);

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

      const plan: OperatorPlanWithMeta = {
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
      // Attempt 2: one correction retry (with full tool catalog if pruned initially)
      if (!usedFullCatalogRetry) {
        usedFullCatalogRetry = true;
        activeTools = OPERATOR_NATIVE_TOOLS;
      }
      const correctionMessages: ProviderMessage[] = [
        ...messages,
        { role: 'assistant', content: rawOutput },
        {
          role: 'user',
          content:
            'Tu respuesta anterior no cumplió el esquema JSON requerido. Por favor responde ÚNICAMENTE con el objeto JSON válido con campos "reply" y "actions".',
        },
      ];

      const retryRes = await provider.plan(correctionMessages, {
        signal: planOptions?.signal,
        tools: activeTools,
      });
      rawOutput = retryRes.rawText;
      latencyMs += retryRes.latencyMs;
      if (retryRes.tokenCounts) {
        recordTurnTokenBreakdown(retryRes.tokenCounts, activeTools);
      }

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
