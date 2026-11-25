// Kite Code — Operator Public API & Pipeline Coordinator
// Executes unified operator turns: Trace -> Plan -> Execute & Verify -> Compose Verified Reply -> TTS -> End Trace.

import {
  type OperatorPlan,
  type TurnContext,
  type ActionReceipt,
} from './contract';
import { emitTrace } from './trace/trace';
import {
  hasExplicitImmediateExecutionCue,
  isDirectLocalControlAction,
  planTurnHeuristic,
} from './planner/heuristic';
import { planTurnLLM } from './planner/llm';
import { normalizeSpanishVoiceStt } from './planner/voiceNormalizer';
import { analyzeClausePolarity } from './planner/clausePolarity';
import {
  buildPendingDisambiguationState,
  detectPreExecutionDisambiguation,
  isDisambiguationCancellation,
} from './planner/disambiguation';
import { executePlan, composeReplyFromReceipts } from './executor';
import { isPeekActionType } from './executor/actions/peekWorkspace';
import { ttsNarrator } from './ttsNarrator';
import { loadOperatorConfig } from './operatorConfig';
import { runLedger } from './runLedger';
import { getActiveAgentTerminals } from '../terminalRegistry';
import type { PlannerProvider, ProviderMessage } from './providers/types';
import { resolvePlannerProvider } from './providers/resolvePlanner';
import { zedAssistantFailureMessage } from './assistantFailureNotice';
import { voiceSessionStore } from './voice/voiceSessionStore';
import {
  buildEnrichedTurnContext,
  filterTerminalsForWorkspace,
  resolveAuthoritativeWorkspace,
} from './context/workspaceSnapshot';
import {
  ensureEpisodicSessionHook,
  loadWorkspaceEpisodicMemory,
  recordDelegationsFromReceipts,
} from './context/episodicMemory';
import { ensureVoiceSessionPrewarmHook } from './voice/sessionPrewarm';

export { resolvePlannerProvider } from './providers/resolvePlanner';

export * from './contract';
export * from './trace/types';
export * from './trace/trace';
export * from './planner/heuristic';
export * from './planner/llm';
export * from './planner/sanitize';
export * from './planner/prompt';
export * from './executor';
export * from './context/ctxClient';
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
  /** Timestamp (ms) when STT delivered the final transcript (`t = 0` for voice TTFA). */
  sttFinalizedAt?: number;
  context?: TurnContext;
  /** Prior user and assistant messages from the operator run, oldest first. */
  history?: ProviderMessage[];
  /** Optional streaming callback invoked as each complete conversational sentence arrives from LLM. */
  onStreamSentence?: (sentence: string) => void;
}

/**
 * Formats read-only ReAct observations concisely for multi-hop planning loops.
 */
export function formatReactObservation(receipts: ActionReceipt[]): string {
  return receipts
    .map(
      (r) =>
        `[Observación ${r.type}]: ${r.summaryEs}${r.data ? ` | ${JSON.stringify(r.data).slice(0, 400)}` : ''}`
    )
    .join('\n');
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
  const resolved = resolveAuthoritativeWorkspace(workspaceId);
  const resolvedWsId = resolved.workspaceId;
  let workspaceName = resolved.workspaceName;
  const workspacePath = resolved.workspacePath;

  let allTerminals: any[] = [];
  try {
    allTerminals = getActiveAgentTerminals();
  } catch {
    allTerminals = [];
  }

  // S5: Strictly isolate terminals to the active workspace to prevent cross-project confusion.
  const filteredTerminals = filterTerminalsForWorkspace(allTerminals, resolvedWsId);

  if (!workspaceName && filteredTerminals.length > 0) {
    workspaceName = filteredTerminals[0].workspaceName;
  }

  const voiceSnapshot = voiceSessionStore.getSnapshot();
  const isVoiceSessionActive =
    voiceSnapshot.phase === 'active' || voiceSnapshot.phase === 'starting';
  const resolvedMode =
    mode ||
    (isVoiceSessionActive && voiceSnapshot.activeSurface === 'thread' ? 'thread' : 'code');

  return {
    mode: resolvedMode,
    workspaceId: resolvedWsId,
    workspaceName,
    workspacePath,
    gitBranch: resolved.gitBranch,
    boundThreadId: isVoiceSessionActive ? (voiceSnapshot.boundThreadId ?? undefined) : undefined,
    voiceSessionActive: isVoiceSessionActive,
    activeTerminals: filteredTerminals.map((t, idx) => ({
      sessionId: t.sessionId,
      engine: t.engine,
      title: t.title,
      who: t.who,
      state: t.state,
      latestLine: t.latestLine ? String(t.latestLine).slice(0, 120) : undefined,
      idx: idx + 1,
      workspaceId: t.workspaceId ?? undefined,
    })),
  };
}

export async function runOperatorTurn(
  input: string,
  options: RunOperatorTurnOptions = {}
): Promise<OperatorTurnResult> {
  ensureEpisodicSessionHook();
  ensureVoiceSessionPrewarmHook();
  const startTime = Date.now();
  const sttFinalizedAt = options.sttFinalizedAt ?? (options.source === 'voz' ? startTime : undefined);
  const turnId = options.turnId || `turn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  if (!runLedger.getRun(turnId)) {
    runLedger.startRun(input, {
      runId: turnId,
      taskType: options.source === 'voz' ? 'voice_turn' : 'operator_turn',
    });
  }
  runLedger.recordVoiceClassification(turnId, {
    transport: 'cascaded',
  });
  if (sttFinalizedAt !== undefined) {
    runLedger.recordVoiceMilestones(turnId, { sttFinalizedAt });
  }
  const context =
    options.context ||
    (await buildEnrichedTurnContext(options.mode, options.workspaceId).catch(() =>
      captureCurrentTurnContext(options.mode, options.workspaceId)
    ));
  if (context.workspaceId) {
    await loadWorkspaceEpisodicMemory(context.workspaceId).catch(() => {});
  }
  runLedger.recordVoiceMilestones(turnId, { contextReadyAt: Date.now() });

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
    // 0. Normalize Spanish STT phonetics & analyze clause-level polarity (preserving raw input in trace).
    const sttNorm = normalizeSpanishVoiceStt(input);
    const normalizedInput = sttNorm.normalized || input;
    const polarity = analyzeClausePolarity(normalizedInput);
    const disambiguationScope = context.boundThreadId || context.workspaceId || '__default__';
    const activePending = voiceSessionStore.getPendingDisambiguation(disambiguationScope);

    // 1. Handle cancellation of a pending disambiguation cleanly
    if (activePending && isDisambiguationCancellation(normalizedInput)) {
      voiceSessionStore.clearPendingDisambiguation(disambiguationScope);
      const cancelPlan: OperatorPlan = {
        strategy: 'heuristic',
        actions: [],
        reply: 'Entendido, dejo esa acción cancelada.',
        answer: 'Entendido, dejo esa acción cancelada.',
      };
      emitTrace({
        turnId,
        ev: 'intent.route',
        route: 'clarification',
        reason: 'disambiguation_cancelled',
        rawInput: input,
        normalizedInput,
      });
      emitTrace({
        turnId,
        ev: 'plan.created',
        strategy: 'heuristic',
        actions: [],
        reply: cancelPlan.reply,
      });
      const durationMs = Date.now() - startTime;
      const cancelResult: OperatorTurnResult = {
        turnId,
        plan: cancelPlan,
        receipts: [],
        reply: cancelPlan.reply!,
        overallSuccess: true,
        durationMs,
        strategy: 'heuristic',
        providerId: provider.id,
      };
      emitTrace({
        turnId,
        ev: 'turn.end',
        overallSuccess: true,
        durationMs,
        reply: cancelPlan.reply,
        turnResult: cancelResult,
      });
      return cancelResult;
    }

    // 2. Plan turn with Confidence-Gated Hybrid Router (Fast-Path Heuristic vs LLM Planner)
    let plan: OperatorPlan;
    let fastPlan = planTurnHeuristic(normalizedInput, { scopeKey: disambiguationScope });
    const activeDraftProposal = voiceSessionStore.getDraftProposal(disambiguationScope);
    const negatedEntireUtterance = polarity.isEntireUtteranceNegated;
    const hasDeterministicActions =
      fastPlan.strategy === 'heuristic' &&
      fastPlan.actions.length > 0;

    // Avoid LLM mis-plans (p. ej. abrir Grok) cuando claramente pidieron narrar/resumir una terminal abierta.
    // Only intercept when terminals actually exist and the user is NOT asking about threads/chats/ODDs/subagents/plans.
    const hasOpenTerminals = (context.activeTerminals?.length ?? 0) > 0;
    const mentionsNonTerminalDomain =
      /\b(?:chat|chats|hilo|hilos|thread|threads|odd|odds|subagente|subagentes|plan|proyecto|conversaci[oó]n|memoria|ayer|anoche)\b/i.test(
        normalizedInput
      );
    if (
      hasOpenTerminals &&
      !mentionsNonTerminalDomain &&
      !negatedEntireUtterance &&
      !hasDeterministicActions &&
      /resum(?:e|ir|en|o|a|i)\b|resumen\b|\bnarr(?:a|ame|ar)\b|com[eé]ntame|cu[eé]ntame|qu[eé]\s+hay|qu[eé]\s+hab[ií]a/i.test(
        normalizedInput
      ) &&
      !/(?:abre|abrir|lanza|crea|inicia|pon|spawn)\s+(?:\d+|un|una|uno|dos|tres|\w+\s+)?(?:terminal|terminales|agente|agentes)\b/i.test(
        normalizedInput.toLowerCase()
      )
    ) {
      fastPlan = {
        strategy: 'heuristic',
        actions: [{ type: 'narrate_summary', target: 'active' }],
        reply: 'Leyendo resumen de la terminal abierta.',
      };
    }

    // In Thread Voice Mode (or with zero open terminals), never let a generic
    // targetless `narrate_summary` heuristic hijack conversational questions before the LLM sees them.
    const isGenericNarrateWithoutTerminals =
      !hasOpenTerminals &&
      fastPlan.actions.length === 1 &&
      fastPlan.actions[0].type === 'narrate_summary' &&
      !fastPlan.actions[0].target;

    // S7: In Thread/Voice Mode, saying "abre/lanza un agente..." WITHOUT explicitly requesting a terminal/console/powershell
    // must be routed to the LLM (with workspace roster) so it chooses between Autonomous Agent, Subagent, or Thread
    // rather than hijacking into a Code PTY terminal!
    const isAgentHijackedToTerminalInThreadMode =
      (context.mode === 'thread' || Boolean(context.voiceSessionActive)) &&
      fastPlan.actions.length === 1 &&
      fastPlan.actions[0].type === 'open_terminals' &&
      !/\b(?:terminal|terminales|consola|consolas|powershell|pane|panes)\b/i.test(normalizedInput);

    // S3.2: In active voice/thread consultative sessions, non-local-control delegations
    // route to the consultative LLM loop (`propose_task` / `refine_proposal`) unless
    // the user explicitly asks for immediate execution ("hazlo directo / sin preguntar").
    const isConsultativeProposalRefinement =
      Boolean(activeDraftProposal) &&
      !fastPlan.actions.some((a) => a.type === 'confirm_proposal' || a.type === 'cancel_proposal');
    const requiresConsultativeDelegation =
      (context.mode === 'thread' || Boolean(context.voiceSessionActive)) &&
      fastPlan.actions.length > 0 &&
      !fastPlan.actions.every((a) => isDirectLocalControlAction(a.type)) &&
      !hasExplicitImmediateExecutionCue(normalizedInput);

    // S8: If a pending disambiguation is open, route the user's answer to the LLM so it resolves the missing slot.
    const mustDeferToLlm =
      Boolean(activePending) ||
      isGenericNarrateWithoutTerminals ||
      isAgentHijackedToTerminalInThreadMode ||
      isConsultativeProposalRefinement ||
      requiresConsultativeDelegation;

    const useFastPlan =
      (!mustDeferToLlm &&
        fastPlan.strategy === 'heuristic' &&
        fastPlan.actions.length > 0) ||
      negatedEntireUtterance;

    const effectiveHistory =
      options.history ??
      (context.boundThreadId
        ? voiceSessionStore.getConversationHistory(context.boundThreadId)
        : undefined);

    const accumulatedPeekReceipts: ActionReceipt[] = [];

    if (provider.id === 'local' || useFastPlan) {
      plan = fastPlan;
      runLedger.recordVoiceClassification(turnId, { tier: 'L0' });
      runLedger.recordVoiceMilestones(turnId, { routerDecisionAt: Date.now() });
      emitTrace({
        turnId,
        ev: 'intent.route',
        route: negatedEntireUtterance ? 'negation' : 'heuristic',
        tier: 'L0',
        transport: 'cascaded',
        routerDecisionAt: Date.now(),
        reason: provider.id === 'local' ? 'local_provider' : 'deterministic_fast_path',
        rawInput: input,
        normalizedInput,
      });
      emitTrace({
        turnId,
        ev: 'plan.created',
        strategy: 'heuristic',
        actions: plan.actions,
      });
    } else {
      runLedger.recordVoiceClassification(turnId, { tier: 'L1' });
      runLedger.recordVoiceMilestones(turnId, { routerDecisionAt: Date.now() });
      emitTrace({
        turnId,
        ev: 'intent.route',
        route: activePending ? 'clarification' : 'llm',
        tier: 'L1',
        transport: 'cascaded',
        routerDecisionAt: Date.now(),
        reason: activePending
          ? 'resolving_pending_disambiguation'
          : isAgentHijackedToTerminalInThreadMode
            ? 'surface_selection_llm'
            : isConsultativeProposalRefinement
              ? 'proposal_refinement'
              : 'planner_required',
        rawInput: input,
        normalizedInput,
      });

      const streamingQueue =
        options.ttsEnabled && !options.muted && !options.onStreamSentence
          ? ttsNarrator.createStreamingQueue({
              voiceName: config.persona?.voice || 'Ara',
              rate: config.ttsRate || 1.0,
              lang: config.persona?.language === 'en' ? 'en-US' : 'es-ES',
              turnId,
              turnStartedAt: startTime,
              sttFinalizedAt,
            })
          : null;
      const streamSentenceHandler =
        options.onStreamSentence ??
        (streamingQueue ? (sentence: string) => streamingQueue.enqueue(sentence) : undefined);

      const MAX_PEEK_HOPS = 3;
      let workingHistory: ProviderMessage[] = effectiveHistory ? [...effectiveHistory] : [];
      plan = await planTurnLLM(normalizedInput, provider, context, turnId, workingHistory, {
        onStreamSentence: streamSentenceHandler,
        pendingDisambiguation: activePending,
        draftProposal: activeDraftProposal,
      });

      // S3.1: Bounded ReAct loop (max 3 read-only peek_* hops before answering or proposing)
      let peekHop = 0;
      while (
        peekHop < MAX_PEEK_HOPS &&
        plan.actions.length > 0 &&
        plan.actions.every((a) => isPeekActionType(a.type))
      ) {
        const peekExec = await executePlan(plan, context, turnId);
        accumulatedPeekReceipts.push(...peekExec.receipts);
        const obsSummary = formatReactObservation(peekExec.receipts);
        workingHistory = [
          ...workingHistory,
          { role: 'assistant', content: JSON.stringify({ actions: plan.actions }) },
          { role: 'user', content: `Resultados de inspección rápida (solo lectura):\n${obsSummary}\nResponde al usuario o emite "propose_task" según corresponda.` },
        ];
        peekHop += 1;
        plan = await planTurnLLM(normalizedInput, provider, context, turnId, workingHistory, {
          onStreamSentence: streamSentenceHandler,
          pendingDisambiguation: activePending,
          draftProposal: voiceSessionStore.getDraftProposal(disambiguationScope),
        });
      }

      if (streamingQueue) {
        if (streamingQueue.hasSpokenAny()) {
          await streamingQueue.close();
        } else {
          streamingQueue.abort();
        }
      }
    }

    // S8: Active Disambiguation Guard (max 1 concrete question before delegating or executing ambiguous actions)
    const clarification = detectPreExecutionDisambiguation(
      normalizedInput,
      plan,
      context,
      activePending
    );
    if (clarification) {
      voiceSessionStore.setPendingDisambiguation(
        disambiguationScope,
        buildPendingDisambiguationState(normalizedInput, clarification)
      );
      plan = {
        ...plan,
        actions: [],
        reply: clarification.question,
        answer: clarification.question,
        clarification,
      };
      emitTrace({
        turnId,
        ev: 'intent.route',
        route: 'clarification',
        reason: `missing_${clarification.missingSlot}`,
        rawInput: input,
        normalizedInput,
      });
    } else if (activePending) {
      // Pending disambiguation was consumed on this follow-up turn; never linger or loop.
      voiceSessionStore.clearPendingDisambiguation(disambiguationScope);
    }

    // 2. Execute actions and collect verified receipts
    const isSilentTurn =
      plan.actions.length > 0 && plan.actions.every((a) => a.type === 'stay_silent');
    if (plan.actions.length > 0 && !isSilentTurn) {
      runLedger.recordVoiceMilestones(turnId, { firstActionStartAt: Date.now() });
    }
    const execution = await executePlan(plan, context, turnId);
    const receipts = [...accumulatedPeekReceipts, ...execution.receipts];
    const reply = isSilentTurn
      ? ''
      : execution.reply || composeReplyFromReceipts(plan, execution.receipts);
    const overallSuccess = execution.overallSuccess;

    // S3.3: Automatically open a 12s hands-free reply window when proposing/refining or asking a question
    const hasProposalInteraction = plan.actions.some(
      (a) => a.type === 'propose_task' || a.type === 'refine_proposal'
    );
    if (!isSilentTurn && (hasProposalInteraction || reply.trim().endsWith('?'))) {
      voiceSessionStore.setHandsFreeReplyWindow(12_000);
    }

    // S6: Persist verified delegations into workspace-scoped episodic ledger
    if (receipts.length > 0) {
      void recordDelegationsFromReceipts(context.workspaceId, receipts).catch(() => {});
    }

    // 3. Speak reply via TTS if requested, not muted, and not a silent turn
    if (options.ttsEnabled && !options.muted && reply && !isSilentTurn) {
      try {
        runLedger.recordVoiceMilestones(turnId, { ttsRequestAt: Date.now() });
        ttsNarrator.speak(reply, {
          voiceName: config.persona?.voice || 'Ara',
          rate: config.ttsRate || 1.0,
          lang: config.persona?.language === 'en' ? 'en-US' : 'es-ES',
          turnId,
          turnStartedAt: startTime,
          sttFinalizedAt,
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
    const providerFailure = zedAssistantFailureMessage({
      strategy: plan.strategy,
      fallbackReason: plan.fallbackReason,
      actionCount: plan.actions.length,
    });

    const turnResult: OperatorTurnResult = {
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

    emitTrace({
      turnId,
      ev: 'turn.end',
      overallSuccess,
      durationMs,
      reply,
      turnResult,
      ...(providerFailure ? { error: providerFailure } : {}),
    });

    // S1: a run ledger run opened while planning (e.g. `llm_plan`) is closed here.
    runLedger.completeRun(turnId, {
      reply,
      outcome: overallSuccess ? 'success' : 'failure',
    });

    return turnResult;
  } catch (err: any) {
    const errorMsg = err?.message || 'Error inesperado durante la ejecución del turno';
    const durationMs = Date.now() - startTime;
    const providerFailure =
      zedAssistantFailureMessage({
        strategy: 'heuristic-fallback',
        fallbackReason: errorMsg,
        actionCount: 1,
      }) ?? errorMsg;

    const fallbackReceipt: ActionReceipt = {
      actionIdx: 0,
      type: 'unknown',
      ok: false,
      error: errorMsg,
      summaryEs: providerFailure,
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
      error: providerFailure,
    });

    runLedger.completeRun(turnId, {
      reply: fallbackReceipt.summaryEs,
      outcome: 'failure',
      errorCategory: 'operator_turn_error',
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
