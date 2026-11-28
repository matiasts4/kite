// Kite Code — Active Disambiguation Guard (S8: Max 1 Concrete Question Before Delegating)
// Prevents destructive guesses or empty delegations by holding a structured PendingDisambiguation
// slot and resolving it cleanly on the next turn without ever looping.

import type { OperatorClarification, OperatorPlan, TurnContext } from '../contract';
import {
  voiceSessionStore,
  type PendingDisambiguationState,
} from '../voice/voiceSessionStore';

const CANCELLATION_RE =
  /^(?:cancel(?:a|ar)?|d[eé]jalo(?:\s+as[ií])?|olv[ií]dalo|mejor\s+no|nada|no\s+importa|no\s+hagas\s+nada|olvida\s+eso|ya\s+no)[.!?]*$/i;

const AFFIRMATIVE_LEAD_RE =
  '(?:s[ií]|dale|ok|okey|perfecto|correcto|de\\s+acuerdo|va|claro|bueno|confirmar|confirmo|confirmado|conf[ií]rmalo|adelante|procede)';
const IMPERATIVE_EXEC_RE =
  '(?:l[aá]nzalo|hazlo|ejec[uú]talo|m[aá]ndalo|in[ií]cialo|arr[aá]ncalo|dale|adelante|procede)';
const NATURAL_CONFIRM_CLAUSE_RE =
  '(?:quiero\\s+que\\s+(?:lo\\s+(?:lances|hagas|ejecutes|mandes|inicies|confirme?s)|lances\\s+(?:el|al)\\s+(?:subagente|agente|hilo|plan))|puedes\\s+(?:lanzarlo|hacerlo|ejecutarlo|iniciarlo)|pod[eé]s\\s+(?:lanzarlo|hacerlo|ejecutarlo|iniciarlo)|por\\s+favor(?:,\\s*' +
  IMPERATIVE_EXEC_RE +
  ')?)';
const POLITE_TAIL_RE = '(?:\\s*(?:,\\s*|\\s+)(?:por\\s+favor|ya|ahora|nomas|nom[aá]s))*';

const PROPOSAL_CONFIRMATION_RE = new RegExp(
  `^(?:${AFFIRMATIVE_LEAD_RE}(?:\\s*[,;:.]?\\s+(?:${IMPERATIVE_EXEC_RE}|${NATURAL_CONFIRM_CLAUSE_RE}))?|${IMPERATIVE_EXEC_RE}|${NATURAL_CONFIRM_CLAUSE_RE})${POLITE_TAIL_RE}[.!\\s]*$`,
  'i'
);

const PROPOSAL_CONFIRMATION_BLOCKERS_RE =
  /\b(?:pero|mejor|cambia(?:r|lo|la)?|ajusta(?:r|lo|la)?|modifica(?:r|lo|la)?|en\s+vez\s+de|en\s+lugar\s+de|sino|adem[aá]s|agrega(?:r|lo|la)?|s[oó]lo|solamente|no|nunca|canc[eé]l(?:a|ar|alo|[aá]lo)?)\b|\b(?:con|usa(?:r|ndo)?)\s+(?:claude|codex|grok|antigravity|agy|opencode|gemini)\b/i;

const PROPOSAL_CANCELLATION_RE =
  /^(?:canc[eé]l(?:a|ar|alo|[aá]lo)?(?:\s+la\s+propuesta|\s+propuesta)?|no(?:\s*[,;:]\s*(?:canc[eé]l(?:a|ar|alo|[aá]lo)|no\s+lo\s+lances|olv[ií]dalo|d[eé]jalo(?:\s+as[ií])?|mejor\s+no|ya\s+no|nada|olvida\s+eso))?|no\s+lo\s+lances|olv[ií]dalo|d[eé]jalo(?:\s+as[ií])?|mejor\s+no|ya\s+no|nada)[.!?\s]*$/i;

const AMBIGUOUS_DEICTIC_TARGET_RE =
  /^(?:esa|ese|eso|esta|este|aquella|aquel|una|uno|ah[ií]|all[ií]|(?:esa|esta|aquella|la)\s+(?:terminal|consola|sesi[oó]n)|(?:al|el|ese|este)\s+agente)$/i;
const RAW_DEICTIC_TERMINAL_RE =
  /\b(?:esa\s+terminal|esta\s+terminal|aquella\s+terminal|esa\s+consola|ah[ií]|all[ií]|al\s+agente|ese\s+agente|este\s+agente)\b/i;
const RAW_EXPLICIT_TERMINAL_REF_RE =
  /\b(?:terminal\s*(?:\d+|uno|dos|tres|cuatro|cinco|seis|siete|ocho)|primera|segunda|tercera|actual|abierta|[uú]ltima)\b/i;
const PLACEHOLDER_TASK_RE = /^(?:tarea\s+delegada|esto|eso|algo|pendiente)?$/i;
const KNOWN_ENGINE_ALIAS_RE =
  /^(?:(?:la\s+|el\s+)?(?:terminal|consola|sesi[oó]n|agente)\s+(?:de\s+|con\s+)?)?(grok|claude|codex|antigravity|agy|opencode|open-code|powershell)$/i;

type TerminalSnapshot = NonNullable<TurnContext['activeTerminals']>[number];

function normalizeEngineName(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (lower === 'agy') return 'antigravity';
  if (lower === 'open-code') return 'opencode';
  return lower;
}

function extractEngineOnlyTarget(target: unknown): string | null {
  if (typeof target !== 'string') return null;
  const match = target.trim().match(KNOWN_ENGINE_ALIAS_RE);
  return match ? normalizeEngineName(match[1]) : null;
}

function formatTerminalCandidates(terminals: TerminalSnapshot[]): string[] {
  const whoCounts = new Map<string, number>();
  for (const t of terminals) {
    const w = (t.who || '').trim().toLowerCase();
    if (w) whoCounts.set(w, (whoCounts.get(w) || 0) + 1);
  }

  return terminals.slice(0, 4).map((t, i) => {
    const who = (t.who || '').trim();
    if (who && (whoCounts.get(who.toLowerCase()) || 0) === 1) {
      return who;
    }
    if (who && t.engine) {
      return `${who} (${t.engine} #${t.idx ?? i + 1})`;
    }
    if (t.engine) {
      return `${t.engine} #${t.idx ?? i + 1}`;
    }
    return t.title?.trim() || `Terminal ${t.idx ?? i + 1}`;
  });
}

function rawInputMentionsSpecificTerminal(rawInput: string, terminals: TerminalSnapshot[]): boolean {
  if (RAW_EXPLICIT_TERMINAL_REF_RE.test(rawInput)) return true;
  const lower = rawInput.toLowerCase();
  return terminals.some((t) => {
    const who = (t.who || '').trim().toLowerCase();
    const engine = (t.engine || '').trim().toLowerCase();
    return (who && lower.includes(who)) || (engine && lower.includes(engine)) || lower.includes(t.sessionId.toLowerCase());
  });
}

function findAmbiguousTerminalMatches(
  target: unknown,
  rawInput: string,
  activeTerminals: TerminalSnapshot[],
  options: { treatMissingAsAmbiguous: boolean; checkSchemaDefaultOne?: boolean }
): { matches: TerminalSnapshot[]; reason: 'deictic' | 'shared-engine' } | null {
  if (activeTerminals.length <= 1) return null;

  if (target === undefined || target === null || (typeof target === 'string' && target.trim() === '')) {
    return options.treatMissingAsAmbiguous
      ? { matches: activeTerminals, reason: 'deictic' }
      : null;
  }

  const targetStr = typeof target === 'string' ? target.trim() : '';
  if (targetStr && AMBIGUOUS_DEICTIC_TARGET_RE.test(targetStr)) {
    return { matches: activeTerminals, reason: 'deictic' };
  }

  const engineOnly = extractEngineOnlyTarget(targetStr);
  if (engineOnly) {
    const engineMatches = activeTerminals.filter(
      (t) => normalizeEngineName(t.engine || '') === engineOnly
    );
    if (engineMatches.length > 1) {
      return { matches: engineMatches, reason: 'shared-engine' };
    }
  }

  const isDefaultedTarget =
    (options.checkSchemaDefaultOne && target === 1) || targetStr.toLowerCase() === 'active';
  if (isDefaultedTarget) {
    const usesDeicticPhrase = RAW_DEICTIC_TERMINAL_RE.test(rawInput);
    const hasExplicitRef = rawInputMentionsSpecificTerminal(rawInput, activeTerminals);
    if (usesDeicticPhrase && !/\b(?:que\s+(?:tengo|ten[ií]a|est[aá])\s+abierta|actual)\b/i.test(rawInput)) {
      return { matches: activeTerminals, reason: 'deictic' };
    }
    if (options.checkSchemaDefaultOne && target === 1 && !hasExplicitRef) {
      return { matches: activeTerminals, reason: 'deictic' };
    }
  }

  return null;
}

const CONSULTATIVE_ACTION_TYPES = new Set([
  'peek_changes',
  'peek_runs',
  'peek_agents',
  'peek_files',
  'recall_conversations',
  'propose_task',
  'refine_proposal',
  'confirm_proposal',
  'cancel_proposal',
  'stay_silent',
]);

export function isDisambiguationCancellation(input: string): boolean {
  return CANCELLATION_RE.test((input || '').trim());
}

export function isProposalConfirmation(input: string): boolean {
  const trimmed = (input || '').trim();
  if (!trimmed || PROPOSAL_CONFIRMATION_BLOCKERS_RE.test(trimmed)) {
    return false;
  }
  return PROPOSAL_CONFIRMATION_RE.test(trimmed);
}

export function isProposalCancellation(input: string): boolean {
  return PROPOSAL_CANCELLATION_RE.test((input || '').trim());
}

export function resolveProposalReplyIntent(
  input: string,
  scopeKey?: string | null
): 'confirm' | 'cancel' | null {
  const active = voiceSessionStore.getDraftProposal(scopeKey);
  if (!active) return null;
  if (isProposalConfirmation(input)) return 'confirm';
  if (isProposalCancellation(input)) return 'cancel';
  return null;
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
  if (plan.actions.some((a) => CONSULTATIVE_ACTION_TYPES.has(a.type))) return null;

  for (const action of plan.actions) {
    // 1. Ambiguous destructive close ("cierra esa" when >1 active terminal exists)
    if (action.type === 'close_terminals') {
      const targetStr = typeof action.target === 'string' ? action.target.trim().toLowerCase() : '';
      const activeTerminals = context?.activeTerminals || [];
      if (AMBIGUOUS_DEICTIC_TARGET_RE.test(targetStr) && activeTerminals.length > 1) {
        const candidates = formatTerminalCandidates(activeTerminals);
        return {
          question: `¿Cuál quieres cerrar: ${candidates.join(' o ')}?`,
          missingSlot: 'target',
          candidates,
          draftAction: { ...action },
        };
      }
    }

    // 1b. Ambiguous prompt injection ("inyecta eso ahí", "escribe en esa terminal", or two terminals with same engine)
    if (action.type === 'inject_prompt') {
      const activeTerminals = context?.activeTerminals || [];
      const ambiguity = findAmbiguousTerminalMatches(action.target, rawInput, activeTerminals, {
        treatMissingAsAmbiguous: true,
        checkSchemaDefaultOne: true,
      });
      if (ambiguity) {
        const candidates = formatTerminalCandidates(ambiguity.matches);
        const engineHint =
          ambiguity.reason === 'shared-engine' ? extractEngineOnlyTarget(action.target) : null;
        const question = engineHint
          ? `Hay ${ambiguity.matches.length} terminales con ${engineHint}: ${candidates.join(' o ')}. ¿A cuál le envío la instrucción?`
          : `¿A qué terminal quieres que envíe la instrucción: ${candidates.join(' o ')}?`;
        return {
          question,
          missingSlot: 'target',
          candidates,
          draftAction: { ...action },
        };
      }

      const prompt = (action.prompt || '').trim();
      if (!prompt || PLACEHOLDER_TASK_RE.test(prompt)) {
        return {
          question: '¿Qué instrucción concreta quieres que envíe a la terminal?',
          missingSlot: 'task',
          draftAction: { ...action },
        };
      }
    }

    // 1c. Ambiguous multi-agent handoff (ambiguous sourceTerminal or existing targetSession)
    if (action.type === 'handoff_to_agent') {
      const activeTerminals = context?.activeTerminals || [];
      const sourceAmbiguity = findAmbiguousTerminalMatches(
        action.sourceTarget,
        rawInput,
        activeTerminals,
        { treatMissingAsAmbiguous: true, checkSchemaDefaultOne: false }
      );
      if (sourceAmbiguity) {
        const candidates = formatTerminalCandidates(sourceAmbiguity.matches);
        const engineHint =
          sourceAmbiguity.reason === 'shared-engine'
            ? extractEngineOnlyTarget(action.sourceTarget)
            : null;
        const question = engineHint
          ? `Hay ${sourceAmbiguity.matches.length} terminales con ${engineHint}: ${candidates.join(' o ')}. ¿De cuál tomo el trabajo?`
          : `¿De qué terminal tomo el trabajo para pasarlo: ${candidates.join(' o ')}?`;
        return {
          question,
          missingSlot: 'target',
          candidates,
          draftAction: { ...action },
        };
      }

      const expectsExistingTarget =
        action.spawnNew === false ||
        action.targetSession !== undefined ||
        (!action.targetEngine && !/\b(?:nuev[oa]|otr[oa])\b/i.test(rawInput));
      if (expectsExistingTarget) {
        const targetCandidate =
          action.targetSession !== undefined
            ? action.targetSession
            : action.spawnNew === false && action.targetEngine
              ? action.targetEngine
              : undefined;
        const targetAmbiguity = findAmbiguousTerminalMatches(
          targetCandidate,
          rawInput,
          activeTerminals,
          { treatMissingAsAmbiguous: true, checkSchemaDefaultOne: false }
        );
        if (targetAmbiguity) {
          const candidates = formatTerminalCandidates(targetAmbiguity.matches);
          const engineHint =
            targetAmbiguity.reason === 'shared-engine'
              ? extractEngineOnlyTarget(targetCandidate)
              : null;
          const question = engineHint
            ? `Hay ${targetAmbiguity.matches.length} terminales con ${engineHint}: ${candidates.join(' o ')}. ¿A cuál se lo paso?`
            : `¿A qué terminal quieres pasarle el trabajo: ${candidates.join(' o ')}?`;
          return {
            question,
            missingSlot: 'target',
            candidates,
            draftAction: { ...action },
          };
        }
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

export interface DisambiguationResolutionResult {
  status: 'resolved' | 'partial' | 'cancelled' | 'unresolved';
  resolvedSlots: Array<'target' | 'task'>;
  missingSlots: Array<'target' | 'task'>;
  draftAction?: Record<string, unknown>;
  nextClarification?: OperatorClarification;
}

const ORDINAL_INDEX_MAP: Record<string, number> = {
  primera: 1,
  primero: 1,
  uno: 1,
  segunda: 2,
  segundo: 2,
  dos: 2,
  tercera: 3,
  tercero: 3,
  tres: 3,
  cuarta: 4,
  cuarto: 4,
  cuatro: 4,
};

function matchTerminalFromReply(
  replyInput: string,
  activeTerminals: TerminalSnapshot[],
  candidates?: string[]
): { targetValue: string | number; matchedPhrase: string; label: string } | null {
  const trimmed = replyInput.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  for (const t of activeTerminals) {
    const who = (t.who || '').trim();
    if (who && lower.includes(who.toLowerCase())) {
      return { targetValue: who, matchedPhrase: who, label: who };
    }
    if (t.sessionId && lower.includes(t.sessionId.toLowerCase())) {
      return { targetValue: t.sessionId, matchedPhrase: t.sessionId, label: who || t.sessionId };
    }
  }

  if (candidates && candidates.length > 0) {
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i].trim();
      if (candidate && lower.includes(candidate.toLowerCase())) {
        const matchedTerm = activeTerminals[i];
        return {
          targetValue: matchedTerm?.who || candidate,
          matchedPhrase: candidate,
          label: candidate,
        };
      }
    }
  }

  const numMatch = lower.match(/(?:terminal|consola|sesi[oó]n|la|el)?\s*(\d+|primera?|segund[oa]|tercer[oa]|cuart[oa]|uno|dos|tres|cuatro)\b/i);
  if (numMatch) {
    const rawNum = numMatch[1].toLowerCase();
    const index = /^\d+$/.test(rawNum) ? parseInt(rawNum, 10) : ORDINAL_INDEX_MAP[rawNum];
    if (index && index >= 1 && index <= activeTerminals.length) {
      const term = activeTerminals[index - 1];
      return {
        targetValue: term.who || index,
        matchedPhrase: numMatch[0],
        label: term.who || `Terminal ${index}`,
      };
    }
  }

  return null;
}

function extractRemainingTaskFromReply(replyInput: string, matchedPhrase?: string): string {
  let rest = replyInput.trim();
  if (matchedPhrase) {
    const escaped = matchedPhrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefixRe = new RegExp(
      `^(?:(?:a|en|de|del|para|con)\\s+)?(?:(?:la|el)\\s+)?(?:(?:terminal|consola|sesi[oó]n|agente)\\s+(?:de\\s+|del\\s+)?)?${escaped}\\s*(?:[,;:\\-]|\\b(?:que|para\\s+que|con\\s+la\\s+instrucci[oó]n)\\b)?\\s*`,
      'i'
    );
    rest = rest.replace(prefixRe, '').trim();
  }
  rest = rest.replace(/^(?:que|para\s+que|con\s+la\s+instrucci[oó]n|instrucci[oó]n:?)\s+/i, '').trim();
  return rest;
}

function isTaskSlotMissing(actionType: string, draft: Record<string, unknown>): boolean {
  if (actionType === 'inject_prompt') {
    const prompt = typeof draft.prompt === 'string' ? draft.prompt.trim() : '';
    return !prompt || PLACEHOLDER_TASK_RE.test(prompt);
  }
  if (actionType === 'spawn_subagent') {
    const task = typeof draft.task === 'string' ? draft.task.trim() : '';
    return PLACEHOLDER_TASK_RE.test(task) || task.length < 4;
  }
  if (actionType === 'launch_agent') {
    const body = typeof draft.body === 'string' ? draft.body.trim() : '';
    return PLACEHOLDER_TASK_RE.test(body) || body.length < 4;
  }
  return false;
}

/**
 * Resolves one or more missing slots (`target`, `task`) on a PendingDisambiguationState
 * from a follow-up user reply, supporting partial multi-slot resolution.
 */
export function resolvePendingDisambiguationReply(
  replyInput: string,
  pending: PendingDisambiguationState,
  context?: TurnContext
): DisambiguationResolutionResult {
  if (isDisambiguationCancellation(replyInput)) {
    return { status: 'cancelled', resolvedSlots: [], missingSlots: [] };
  }

  const draft: Record<string, unknown> = { ...(pending.draftAction || {}) };
  const actionType = typeof draft.type === 'string' ? draft.type : '';
  const activeTerminals = context?.activeTerminals || [];
  const resolvedSlots: Array<'target' | 'task'> = [];
  let matchedPhrase: string | undefined;
  let resolvedLabel: string | undefined;

  if (actionType === 'inject_prompt') {
    const targetAmbiguous =
      pending.missingSlot === 'target' ||
      Boolean(
        findAmbiguousTerminalMatches(draft.target, pending.originalInput, activeTerminals, {
          treatMissingAsAmbiguous: true,
          checkSchemaDefaultOne: true,
        })
      );

    if (targetAmbiguous) {
      const matched = matchTerminalFromReply(replyInput, activeTerminals, pending.candidates);
      if (matched) {
        draft.target = matched.targetValue;
        matchedPhrase = matched.matchedPhrase;
        resolvedLabel = matched.label;
        resolvedSlots.push('target');
      }
    }

    if (isTaskSlotMissing(actionType, draft)) {
      const candidateTask = matchedPhrase
        ? extractRemainingTaskFromReply(replyInput, matchedPhrase)
        : pending.missingSlot === 'task'
          ? extractRemainingTaskFromReply(replyInput)
          : '';
      if (candidateTask && !PLACEHOLDER_TASK_RE.test(candidateTask)) {
        draft.prompt = candidateTask;
        resolvedSlots.push('task');
      }
    }
  } else if (actionType === 'handoff_to_agent') {
    const sourceAmbiguous = Boolean(
      findAmbiguousTerminalMatches(draft.sourceTarget, pending.originalInput, activeTerminals, {
        treatMissingAsAmbiguous: true,
        checkSchemaDefaultOne: false,
      })
    );
    const matched = matchTerminalFromReply(replyInput, activeTerminals, pending.candidates);
    if (matched) {
      if (sourceAmbiguous && !/\b(?:a|hacia|para)\b/i.test(replyInput)) {
        draft.sourceTarget = matched.targetValue;
      } else if (
        draft.spawnNew === false ||
        draft.targetSession !== undefined ||
        (!draft.targetEngine && !sourceAmbiguous)
      ) {
        draft.targetSession = matched.targetValue;
        draft.spawnNew = false;
      } else {
        draft.sourceTarget = matched.targetValue;
      }
      matchedPhrase = matched.matchedPhrase;
      resolvedLabel = matched.label;
      resolvedSlots.push('target');
    }

    const extraPrompt = matchedPhrase
      ? extractRemainingTaskFromReply(replyInput, matchedPhrase)
      : pending.missingSlot === 'task'
        ? extractRemainingTaskFromReply(replyInput)
        : '';
    if (extraPrompt && extraPrompt.length >= 4 && !PLACEHOLDER_TASK_RE.test(extraPrompt)) {
      draft.customPrompt = extraPrompt;
      resolvedSlots.push('task');
    }
  } else if (actionType === 'launch_agent') {
    const agents = context?.autonomousAgents || [];
    const currentQuery = typeof draft.agentQuery === 'string' ? draft.agentQuery.trim() : '';
    if (!currentQuery || pending.missingSlot === 'target') {
      const lower = replyInput.toLowerCase();
      const matchedAgent = agents.find((a) => lower.includes(a.name.toLowerCase()));
      const matchedCandidate = !matchedAgent
        ? pending.candidates?.find((c) => lower.includes(c.toLowerCase()))
        : undefined;
      const targetName = matchedAgent?.name || matchedCandidate;
      if (targetName) {
        draft.agentQuery = targetName;
        matchedPhrase = targetName;
        resolvedLabel = targetName;
        resolvedSlots.push('target');
      }
    }

    if (isTaskSlotMissing(actionType, draft)) {
      const candidateBody = matchedPhrase
        ? extractRemainingTaskFromReply(replyInput, matchedPhrase)
        : pending.missingSlot === 'task'
          ? extractRemainingTaskFromReply(replyInput)
          : '';
      if (candidateBody.length >= 4 && !PLACEHOLDER_TASK_RE.test(candidateBody)) {
        draft.body = candidateBody;
        resolvedSlots.push('task');
      }
    }
  } else if (actionType === 'spawn_subagent') {
    if (isTaskSlotMissing(actionType, draft)) {
      const task = extractRemainingTaskFromReply(replyInput);
      if (task.length >= 4 && !PLACEHOLDER_TASK_RE.test(task)) {
        draft.task = task;
        resolvedSlots.push('task');
      }
    }
  } else if (actionType === 'close_terminals') {
    const matched = matchTerminalFromReply(replyInput, activeTerminals, pending.candidates);
    if (matched) {
      draft.target = matched.targetValue;
      resolvedSlots.push('target');
    }
  }

  const missingSlots: Array<'target' | 'task'> = [];
  if (
    (actionType === 'inject_prompt' &&
      Boolean(
        findAmbiguousTerminalMatches(draft.target, pending.originalInput, activeTerminals, {
          treatMissingAsAmbiguous: true,
          checkSchemaDefaultOne: false,
        })
      )) ||
    (actionType === 'launch_agent' &&
      !(typeof draft.agentQuery === 'string' && draft.agentQuery.trim()) &&
      (context?.autonomousAgents?.length || 0) > 1)
  ) {
    missingSlots.push('target');
  }
  if (isTaskSlotMissing(actionType, draft)) {
    missingSlots.push('task');
  }

  if (resolvedSlots.length === 0) {
    return { status: 'unresolved', resolvedSlots, missingSlots, draftAction: draft };
  }

  if (missingSlots.length > 0) {
    const nextMissing = missingSlots[0];
    const nextClarification: OperatorClarification =
      nextMissing === 'task'
        ? {
            question: resolvedLabel
              ? `¿Qué instrucción concreta quieres que envíe a ${resolvedLabel}?`
              : '¿Qué instrucción concreta quieres que envíe?',
            missingSlot: 'task',
            draftAction: draft,
          }
        : {
            question: '¿A qué terminal o agente específico lo dirijo?',
            missingSlot: 'target',
            candidates: formatTerminalCandidates(activeTerminals),
            draftAction: draft,
          };
    return {
      status: 'partial',
      resolvedSlots,
      missingSlots,
      draftAction: draft,
      nextClarification,
    };
  }

  return {
    status: 'resolved',
    resolvedSlots,
    missingSlots: [],
    draftAction: draft,
  };
}
