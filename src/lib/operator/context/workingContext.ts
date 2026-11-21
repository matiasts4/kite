// Kite Code — Long-Session Rolling Working Context (S4)
// Maintains a compact, persisted working memory per voice thread (current topic, agreed decisions,
// settled subagent findings, open follow-ups, and rolled-off turn digests) so 40+ min conversations
// retain full continuity beyond the 8-turn verbatim history window.

import type { SubagentDelegationMode } from '../contract';
import type { VoiceTurnRecord } from '../voice/voiceSessionStore';

export type SubagentFindingStatus = 'running' | 'completed' | 'failed' | 'waiting';

export interface SubagentFindingRecord {
  subagentId: string;
  role: string;
  provider?: string;
  mode?: SubagentDelegationMode;
  status: SubagentFindingStatus;
  taskSummary: string;
  findingsSummary?: string;
  updatedAt: number;
}

export interface SessionWorkingContext {
  threadId: string;
  currentTopic?: string;
  decisions: string[];
  findings: SubagentFindingRecord[];
  openQuestions: string[];
  olderTurnsSummary: string[];
  compactedTurnCount: number;
  updatedAt: number;
}

const STORAGE_PREFIX = 'kite.voiceWorkingContext.v1.';
export const WORKING_CONTEXT_RECENT_WINDOW = 8;
const MAX_DECISIONS = 6;
const MAX_FINDINGS = 6;
const MAX_OPEN_QUESTIONS = 4;
const MAX_OLDER_SUMMARIES = 6;
const MAX_PROMPT_CHARS = 1250;

const TRIVIAL_UTTERANCE_RE =
  /^(?:hola|buenas|hey|che|okey|ok|si|sí|dale|genial|perfecto|listo|gracias|bien|claro|exacto|entendido|aj[aá]|joya|buen[ií]simo)[.!?\s]*$/i;

const TOPIC_PIVOT_RE =
  /\b(?:quiero\s+(?:revisar|ver|analizar|trabajar|hablar|arreglar|mejorar)|pasemos\s+a|cambiemos\s+de\s+tema|ahora\s+(?:veamos|revisemos|trabajemos)|hablemos\s+de|enf[oó]quemonos\s+en)\b/i;

const DECISION_SIGNAL_RE =
  /\b(?:acordamos|decidimos|queda\s+(?:acordado|definido|cerrado)|vamos\s+con|arranquemos\s+con|hagamos\s+eso|implementa(?:r|mos)?|armemos\s+el\s+odd|aprobado|confirmado|usar\s+subagentes|prioricemos|empezando\s+por)\b/i;

const contextCache = new Map<string, SessionWorkingContext>();

function emptyWorkingContext(threadId: string): SessionWorkingContext {
  return {
    threadId,
    decisions: [],
    findings: [],
    openQuestions: [],
    olderTurnsSummary: [],
    compactedTurnCount: 0,
    updatedAt: 0,
  };
}

function cleanLine(text: string | undefined, maxChars: number): string {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > maxChars * 0.5 ? cut.slice(0, sp) : cut).trim()}…`;
}

function normalizeKey(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readFromStorage(threadId: string): SessionWorkingContext {
  if (!threadId || typeof localStorage === 'undefined') {
    return emptyWorkingContext(threadId);
  }
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${threadId}`);
    if (!raw) return emptyWorkingContext(threadId);
    const parsed = JSON.parse(raw) as Partial<SessionWorkingContext>;
    return {
      threadId,
      currentTopic: typeof parsed.currentTopic === 'string' ? parsed.currentTopic : undefined,
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.filter((d) => typeof d === 'string') : [],
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      openQuestions: Array.isArray(parsed.openQuestions)
        ? parsed.openQuestions.filter((q) => typeof q === 'string')
        : [],
      olderTurnsSummary: Array.isArray(parsed.olderTurnsSummary)
        ? parsed.olderTurnsSummary.filter((s) => typeof s === 'string')
        : [],
      compactedTurnCount:
        typeof parsed.compactedTurnCount === 'number' && Number.isFinite(parsed.compactedTurnCount)
          ? parsed.compactedTurnCount
          : 0,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    };
  } catch {
    return emptyWorkingContext(threadId);
  }
}

function persistContext(ctx: SessionWorkingContext): void {
  if (!ctx.threadId) return;
  const bounded: SessionWorkingContext = {
    ...ctx,
    decisions: ctx.decisions.slice(-MAX_DECISIONS),
    findings: ctx.findings.slice(-MAX_FINDINGS),
    openQuestions: ctx.openQuestions.slice(-MAX_OPEN_QUESTIONS),
    olderTurnsSummary: ctx.olderTurnsSummary.slice(-MAX_OLDER_SUMMARIES),
  };
  contextCache.set(ctx.threadId, bounded);
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(`${STORAGE_PREFIX}${ctx.threadId}`, JSON.stringify(bounded));
    } catch {}
  }
}

export function getSessionWorkingContext(threadId?: string | null): SessionWorkingContext {
  const key = (threadId || '').trim();
  if (!key) return emptyWorkingContext('');
  const cached = contextCache.get(key);
  if (cached) return cached;
  const loaded = readFromStorage(key);
  contextCache.set(key, loaded);
  return loaded;
}

function appendUnique(list: string[], entry: string, maxItems: number): string[] {
  const clean = entry.trim();
  if (!clean) return list;
  const targetKey = normalizeKey(clean);
  if (!targetKey) return list;
  if (list.some((existing) => normalizeKey(existing) === targetKey)) {
    return list;
  }
  return [...list, clean].slice(-maxItems);
}

function extractTrailingQuestion(text?: string): string | null {
  if (!text) return null;
  const matches = text.match(/¿[^?]{8,140}\?/g);
  if (!matches || matches.length === 0) return null;
  return cleanLine(matches[matches.length - 1], 130);
}

function digestSingleTurn(turn: VoiceTurnRecord): string {
  const prompt = cleanLine(turn.userPrompt, 85);
  const receiptNote = (turn.receipts || [])
    .filter((r) => r.ok && r.summaryEs)
    .map((r) => cleanLine(r.summaryEs, 70))
    .slice(0, 1)
    .join('');

  if (turn.isProactiveReport) {
    return `Reporte subagente: ${cleanLine(turn.reply, 100)}`;
  }
  if (receiptNote) {
    return `"${prompt}" → ${receiptNote}`;
  }
  const reply = cleanLine(turn.reply, 75);
  return reply ? `"${prompt}" → ${reply}` : `"${prompt}"`;
}

/**
 * Compacts turns that have rolled off the recent verbatim history window into a bounded,
 * signal-prioritized digest so long (40+ min) conversations never suffer amnesia.
 */
export function compactRolledOffTurns(
  allTurns: VoiceTurnRecord[],
  recentWindow: number = WORKING_CONTEXT_RECENT_WINDOW
): { compactedCount: number; summaries: string[] } {
  const valid = [...allTurns]
    .sort((a, b) => a.createdAt - b.createdAt)
    .filter((t) => {
      const reply = (t.reply || '').trim();
      if (!reply) return false;
      const prompt = (t.userPrompt || '').trim();
      if (prompt.startsWith('[captura de voz descartada')) return false;
      return Boolean(prompt) || Boolean(t.isProactiveReport);
    });

  if (valid.length <= recentWindow) {
    return { compactedCount: 0, summaries: [] };
  }

  const rolledOff = valid.slice(0, valid.length - recentWindow);
  // Prioritize turns carrying decisions, delegations, proactive findings, or substantive topics
  const scored = rolledOff.map((turn, idx) => {
    let weight = 1;
    if (turn.isProactiveReport) weight += 4;
    if ((turn.receipts || []).some((r) => r.ok)) weight += 3;
    if (DECISION_SIGNAL_RE.test(turn.userPrompt || '') || DECISION_SIGNAL_RE.test(turn.reply || '')) {
      weight += 3;
    }
    if (idx === 0) weight += 2; // Preserve initial topic anchor
    if (TRIVIAL_UTTERANCE_RE.test(turn.userPrompt || '')) weight = 0;
    return { turn, idx, weight };
  });

  const nonTrivial = scored.filter((item) => item.weight > 0);
  const picked =
    nonTrivial.length <= MAX_OLDER_SUMMARIES
      ? nonTrivial
      : [...nonTrivial]
          .sort((a, b) => b.weight - a.weight || b.idx - a.idx)
          .slice(0, MAX_OLDER_SUMMARIES)
          .sort((a, b) => a.idx - b.idx);

  return {
    compactedCount: rolledOff.length,
    summaries: picked.map((item) => digestSingleTurn(item.turn)),
  };
}

/**
 * Updates the persisted Working Context from a completed voice/text turn and optionally
 * refreshes the compacted digest of older turns beyond the verbatim window.
 */
export function recordTurnIntoWorkingContext(
  threadId: string | null | undefined,
  turn: VoiceTurnRecord,
  allThreadTurns?: VoiceTurnRecord[]
): SessionWorkingContext {
  const key = (threadId || '').trim();
  if (!key) return emptyWorkingContext('');

  const current = getSessionWorkingContext(key);
  const next: SessionWorkingContext = {
    ...current,
    decisions: [...current.decisions],
    findings: [...current.findings],
    openQuestions: [...current.openQuestions],
    olderTurnsSummary: [...current.olderTurnsSummary],
    updatedAt: Math.max(current.updatedAt, turn.createdAt || Date.now()),
  };

  const prompt = (turn.userPrompt || '').trim();
  const reply = (turn.reply || '').trim();
  const isDiscarded = prompt.startsWith('[captura de voz descartada');

  if (!isDiscarded && prompt && !TRIVIAL_UTTERANCE_RE.test(prompt)) {
    // Establish initial topic or update on explicit topic pivot
    if (!next.currentTopic || TOPIC_PIVOT_RE.test(prompt)) {
      if (prompt.length >= 16) {
        next.currentTopic = cleanLine(prompt, 130);
      }
    }

    // Extract explicit decisions / agreed direction from user turn
    if (DECISION_SIGNAL_RE.test(prompt)) {
      next.decisions = appendUnique(next.decisions, cleanLine(prompt, 130), MAX_DECISIONS);
    }
  }

  // Record verified delegation / execution decisions from receipts
  for (const r of turn.receipts || []) {
    if (r.ok && r.summaryEs && ['launch_thread', 'spawn_subagent', 'launch_agent', 'switch_workspace'].includes(r.type)) {
      next.decisions = appendUnique(next.decisions, cleanLine(r.summaryEs, 120), MAX_DECISIONS);
    }
  }

  // Track open conversational proposal from assistant reply
  if (reply) {
    const trailingQ = extractTrailingQuestion(reply);
    if (trailingQ) {
      next.openQuestions = appendUnique(next.openQuestions, trailingQ, MAX_OPEN_QUESTIONS);
    } else if (prompt && !turn.isProactiveReport && next.openQuestions.length > 0) {
      // User answered and SETH moved forward without asking again -> pop oldest resolved prompt
      next.openQuestions = next.openQuestions.slice(1);
    }
  }

  if (allThreadTurns && allThreadTurns.length > WORKING_CONTEXT_RECENT_WINDOW) {
    const { compactedCount, summaries } = compactRolledOffTurns(allThreadTurns);
    next.compactedTurnCount = compactedCount;
    next.olderTurnsSummary = summaries;
  }

  persistContext(next);
  return next;
}

/**
 * Records or updates a child subagent's status and findings inside the voice thread's Working Context.
 */
export function upsertSubagentFinding(
  threadId: string | null | undefined,
  entry: Omit<SubagentFindingRecord, 'updatedAt'> & { updatedAt?: number }
): SessionWorkingContext {
  const key = (threadId || '').trim();
  if (!key) return emptyWorkingContext('');

  const current = getSessionWorkingContext(key);
  const now = entry.updatedAt ?? Date.now();
  const existing = current.findings.find((f) => f.subagentId === entry.subagentId);

  const merged: SubagentFindingRecord = {
    subagentId: entry.subagentId,
    role: entry.role || existing?.role || 'Explorer',
    provider: entry.provider || existing?.provider,
    mode: entry.mode || existing?.mode,
    status: entry.status,
    taskSummary: cleanLine(entry.taskSummary || existing?.taskSummary || 'Exploración delegada', 120),
    findingsSummary: entry.findingsSummary
      ? cleanLine(entry.findingsSummary, 360)
      : existing?.findingsSummary,
    updatedAt: now,
  };

  const next: SessionWorkingContext = {
    ...current,
    findings: [
      ...current.findings.filter((f) => f.subagentId !== entry.subagentId),
      merged,
    ].slice(-MAX_FINDINGS),
    updatedAt: now,
  };

  persistContext(next);
  return next;
}

export function findSubagentFindingInWorkingContext(
  threadId: string | null | undefined,
  query?: string
): SubagentFindingRecord | null {
  const wc = getSessionWorkingContext(threadId);
  if (wc.findings.length === 0) return null;
  if (!query || !query.trim()) {
    return wc.findings[wc.findings.length - 1];
  }
  const norm = query.trim().toLowerCase();
  const reversed = [...wc.findings].reverse();
  return (
    reversed.find(
      (f) =>
        f.subagentId.toLowerCase() === norm ||
        f.role.toLowerCase() === norm ||
        f.role.toLowerCase().includes(norm)
    ) ?? null
  );
}

/**
 * Formats the live session Working Context into a compact, token-budgeted section
 * injected into `buildOperatorSystemPrompt`.
 */
export function formatWorkingContextForPrompt(ctx?: SessionWorkingContext | null): string {
  if (!ctx) return '';
  const hasContent =
    Boolean(ctx.currentTopic) ||
    ctx.decisions.length > 0 ||
    ctx.findings.length > 0 ||
    ctx.openQuestions.length > 0 ||
    ctx.olderTurnsSummary.length > 0;
  if (!hasContent) return '';

  const lines: string[] = [];
  if (ctx.currentTopic) {
    lines.push(`- Tema actual: ${ctx.currentTopic}`);
  }
  if (ctx.decisions.length > 0) {
    lines.push(`- Decisiones acordadas: ${ctx.decisions.slice(-4).join(' | ')}`);
  }
  if (ctx.findings.length > 0) {
    lines.push('- Hallazgos de subagentes en esta charla:');
    for (const f of ctx.findings.slice(-4)) {
      const modeTag = f.mode ? `, ${f.mode}` : '';
      const detail = f.findingsSummary || f.taskSummary;
      lines.push(`  * [${f.role} (${f.status}${modeTag})]: ${cleanLine(detail, 220)}`);
    }
  }
  if (ctx.openQuestions.length > 0) {
    lines.push(`- Propuesta/pendiente abierto: ${ctx.openQuestions[ctx.openQuestions.length - 1]}`);
  }
  if (ctx.olderTurnsSummary.length > 0) {
    lines.push(
      `- Resumen de turnos anteriores (${ctx.compactedTurnCount} compactados): ${ctx.olderTurnsSummary
        .slice(-4)
        .join(' ; ')}`
    );
  }

  let block = `\n\nCONTEXTO VIVO DE LA SESIÓN ACTUAL:\n${lines.join('\n')}`;
  if (block.length > MAX_PROMPT_CHARS) {
    block = `${block.slice(0, MAX_PROMPT_CHARS - 1)}…`;
  }
  return block;
}

export function clearSessionWorkingContext(threadId: string): void {
  const key = (threadId || '').trim();
  if (!key) return;
  contextCache.delete(key);
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(`${STORAGE_PREFIX}${key}`);
    } catch {}
  }
}

export function resetWorkingContextForTests(): void {
  contextCache.clear();
}
