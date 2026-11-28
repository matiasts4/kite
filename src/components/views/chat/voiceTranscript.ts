// Kite Code — Voice turn → standard chat transcript adapter.
// Voice turns are projected as regular `ChatItem`s so the thread renders them with the exact same
// rows, widths and spacing as any other conversation (`ChatItemRow` / `ChatWorkGroup`).

import type { ChatItem } from '../../../types';
import type { VoiceTurnRecord } from '../../../lib/operator/voice/voiceSessionStore';

export interface LiveVoiceStage {
  turnId: string;
  stage: string;
  detail?: string;
}

export interface VoiceTurnsProjectionOptions {
  includeSessionSummary?: boolean;
  sessionEndedAt?: number;
}

export interface KaraokeWordState {
  word: string;
  state: 'spoken' | 'active' | 'unspoken';
}

export interface KaraokeWordProgress {
  words: KaraokeWordState[];
  spokenCharCount: number;
  progress: number;
}

function formatDurationValue(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)} ms`;
  }
  const roundedSec = Math.round((durationMs / 1000) * 10) / 10;
  return Number.isInteger(roundedSec) ? `${roundedSec} s` : `${roundedSec.toFixed(1)} s`;
}

/** Formats durations >= 1000 ms into a concise `"Trabajó Xs"` label; returns null below 1s. */
export function formatWorkedForLabel(durationMs?: number): string | null {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 1000) {
    return null;
  }
  return `Trabajó ${formatDurationValue(durationMs)}`;
}

function baseItem(id: string, kind: ChatItem['kind'], createdAtUnixMs: number): ChatItem {
  return {
    id,
    kind,
    text: '',
    title: null,
    detail: null,
    status: 'completed',
    streaming: false,
    exitCode: null,
    createdAtUnixMs,
    attachments: [],
  };
}

function isCompletedVoiceTurn(turn: VoiceTurnRecord): boolean {
  if (
    turn.interrupted &&
    !(turn.reply && turn.reply.trim()) &&
    !(turn.receipts && turn.receipts.length > 0) &&
    !isValidTimestamp(turn.completedAt)
  ) {
    return false;
  }
  return Boolean(
    isValidTimestamp(turn.completedAt) ||
      (turn.reply && turn.reply.trim()) ||
      turn.overallSuccess !== undefined ||
      (turn.receipts && turn.receipts.length > 0) ||
      (turn.userPrompt && turn.userPrompt.trim()),
  );
}

/** Builds a post-call summary receipt card when a voice session has >= 1 completed turns. */
export function buildVoiceSessionSummaryItem(
  turns: VoiceTurnRecord[],
  endedAtUnixMs?: number,
): ChatItem | null {
  const completedTurns = turns.filter(isCompletedVoiceTurn);
  if (completedTurns.length === 0) {
    return null;
  }

  const allReceipts = completedTurns.flatMap((turn) => turn.receipts ?? []);
  const turnCount = completedTurns.length;
  const actionCount = allReceipts.length;
  const turnLabel = turnCount === 1 ? '1 turno' : `${turnCount} turnos`;
  const actionLabel = actionCount === 1 ? '1 acción' : `${actionCount} acciones`;

  const actionSummaries: string[] = [];
  let failedCount = 0;
  for (const receipt of allReceipts) {
    if (!receipt.ok) failedCount += 1;
    const data =
      receipt.data && typeof receipt.data === 'object'
        ? (receipt.data as Record<string, unknown>)
        : null;
    if (receipt.type === 'spawn_subagent' && typeof data?.role === 'string' && data.role.trim()) {
      actionSummaries.push(receipt.summaryEs || `Subagente ${data.role.trim()}`);
    } else if (
      receipt.type === 'launch_agent' &&
      typeof data?.agentName === 'string' &&
      data.agentName.trim()
    ) {
      actionSummaries.push(receipt.summaryEs || `Agente ${data.agentName.trim()}`);
    } else {
      actionSummaries.push(receipt.summaryEs || receipt.type);
    }
  }

  let totalDurationMs = completedTurns.reduce((sum, turn) => {
    if (typeof turn.durationMs === 'number' && Number.isFinite(turn.durationMs) && turn.durationMs > 0) {
      return sum + turn.durationMs;
    }
    return sum;
  }, 0);

  if (totalDurationMs === 0) {
    totalDurationMs = allReceipts.reduce((sum, receipt) => {
      if (
        typeof receipt.durationMs === 'number' &&
        Number.isFinite(receipt.durationMs) &&
        receipt.durationMs > 0
      ) {
        return sum + receipt.durationMs;
      }
      return sum;
    }, 0);
  }

  let earliestTs = Number.POSITIVE_INFINITY;
  let latestTs = 0;
  for (const turn of completedTurns) {
    if (isValidTimestamp(turn.createdAt)) {
      earliestTs = Math.min(earliestTs, turn.createdAt);
      latestTs = Math.max(latestTs, turn.createdAt);
    }
    if (isValidTimestamp(turn.completedAt)) {
      latestTs = Math.max(latestTs, turn.completedAt);
    }
  }

  if (
    totalDurationMs === 0 &&
    isValidTimestamp(endedAtUnixMs) &&
    Number.isFinite(earliestTs) &&
    endedAtUnixMs > earliestTs
  ) {
    totalDurationMs = endedAtUnixMs - earliestTs;
  }

  const detailParts: string[] = [];
  if (actionSummaries.length > 0) {
    detailParts.push(...actionSummaries);
  } else {
    detailParts.push('Conversación sin acciones delegadas');
  }
  if (failedCount > 0) {
    detailParts.push(failedCount === 1 ? '1 acción fallida' : `${failedCount} acciones fallidas`);
  }
  if (totalDurationMs > 0) {
    detailParts.push(formatWorkedForLabel(totalDurationMs) ?? `Duración: ${formatDurationValue(totalDurationMs)}`);
  }

  const summaryAt = isValidTimestamp(endedAtUnixMs)
    ? endedAtUnixMs
    : latestTs > 0
      ? latestTs
      : Date.now();

  return {
    ...baseItem('voice-session-summary', 'tool', summaryAt),
    title: `Resumen de sesión de voz · ${turnLabel} · ${actionLabel}`,
    detail: detailParts.join(' · '),
    text: detailParts.map((part) => `• ${part}`).join('\n'),
    status: 'completed',
    toolName: 'voice_session_summary',
    toolKind: 'dynamicToolCall',
    durationSeconds: totalDurationMs > 0 ? totalDurationMs / 1000 : null,
  };
}

/** Creates a clean session start/end divider item for the voice timeline. */
export function buildVoiceSessionBoundaryItem(
  sessionId: string,
  phase: 'started' | 'ended',
  timestampMs: number,
  durationMs?: number,
): ChatItem {
  const safeSessionId = (sessionId || 'session').trim() || 'session';
  const hasDuration =
    phase === 'ended' && typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0;
  const durationLabel = hasDuration ? formatDurationValue(durationMs as number) : null;
  const title =
    phase === 'started'
      ? 'Sesión de voz iniciada'
      : durationLabel
        ? `Sesión de voz finalizada · ${durationLabel}`
        : 'Sesión de voz finalizada';

  return {
    ...baseItem(`voice-session:${safeSessionId}:${phase}`, 'note', timestampMs),
    title,
    text: title,
    detail: durationLabel,
    toolName: 'voice_session_boundary',
    durationSeconds: hasDuration ? (durationMs as number) / 1000 : null,
  };
}

/** Flushes an in-flight partial transcript at session teardown so spoken trailing words are preserved. */
export function flushPendingVoiceTranscriptTail(
  partialText: string,
  threadId: string,
  existingTurns: VoiceTurnRecord[],
  nowMs?: number,
): VoiceTurnRecord | null {
  const trimmed = (partialText ?? '').trim();
  if (trimmed.length === 0) {
    return null;
  }

  const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
  const lastTurn = existingTurns.length > 0 ? existingTurns[existingTurns.length - 1] : null;
  if (lastTurn && normalize(lastTurn.userPrompt ?? '') === normalize(trimmed)) {
    return null;
  }

  const ts = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();
  const safeThread = (threadId || 'voice').trim() || 'voice';

  return {
    turnId: `tail-${safeThread}-${ts}`,
    userPrompt: trimmed,
    source: 'voz',
    strategy: 'tail_flush',
    overallSuccess: true,
    receipts: [],
    interrupted: true,
    createdAt: ts,
    completedAt: ts,
  };
}

/** Computes word-by-word karaoke states and spoken character count synced to TTS playback progress. */
export function computeKaraokeWordProgress(
  text: string,
  elapsedMs: number,
  totalDurationMs: number,
  playbackRate = 1,
): KaraokeWordProgress {
  const matches = Array.from((text ?? '').matchAll(/\S+/g));
  if (matches.length === 0) {
    return { words: [], spokenCharCount: 0, progress: 0 };
  }

  const safeRate =
    typeof playbackRate === 'number' && Number.isFinite(playbackRate) && playbackRate > 0
      ? playbackRate
      : 1;
  const safeElapsed =
    typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const safeTotal =
    typeof totalDurationMs === 'number' && Number.isFinite(totalDurationMs) ? totalDurationMs : 0;

  const rawProgress = safeTotal > 0 ? (safeElapsed * safeRate) / safeTotal : 0;
  const progress = Math.min(1, Math.max(0, rawProgress));

  if (progress <= 0) {
    return {
      words: matches.map((match) => ({ word: match[0], state: 'unspoken' })),
      spokenCharCount: 0,
      progress: 0,
    };
  }

  if (progress >= 1) {
    return {
      words: matches.map((match) => ({ word: match[0], state: 'spoken' })),
      spokenCharCount: text.length,
      progress: 1,
    };
  }

  const cursor = progress * text.length;
  let activeIdx = matches.length - 1;
  for (let i = 0; i < matches.length; i += 1) {
    const spanStart = i === 0 ? 0 : (matches[i].index ?? 0);
    const spanEnd = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    if (cursor >= spanStart && cursor < spanEnd) {
      activeIdx = i;
      break;
    }
  }

  const words: KaraokeWordState[] = matches.map((match, idx) => ({
    word: match[0],
    state: idx < activeIdx ? 'spoken' : idx === activeIdx ? 'active' : 'unspoken',
  }));

  return {
    words,
    spokenCharCount: Math.min(text.length, Math.max(0, Math.round(cursor))),
    progress,
  };
}

/** Projects recorded voice turns into the same item shapes a provider transcript uses. */
export function voiceTurnsToChatItems(
  turns: VoiceTurnRecord[],
  options?: VoiceTurnsProjectionOptions,
): ChatItem[] {
  const items: ChatItem[] = [];

  for (const turn of turns) {
    const at = turn.createdAt;

    if (!turn.isProactiveReport && (turn.userPrompt || '').trim().length > 0) {
      items.push({
        ...baseItem(`${turn.turnId}:user`, 'user', at),
        text: turn.userPrompt,
        inputSource: turn.source === 'voz' ? 'voice' : 'text',
      });
    }

    const consult = turn.consultChatsInfo;
    if (consult && consult.kind !== 'none') {
      const title =
        consult.kind === 'read'
          ? `Leyó el chat «${consult.title ?? 'sin título'}»`
          : consult.kind === 'index'
            ? 'Consultó el índice de conversaciones'
            : 'Sin coincidencias en chats anteriores';
      items.push({
        ...baseItem(`${turn.turnId}:consult`, 'tool', at),
        title,
        detail: consult.cli ? `Desde ${consult.cli}` : null,
        toolName: 'zed_consult_chats',
        toolKind: 'dynamicToolCall',
      });
    }

    (turn.receipts ?? []).forEach((receipt, index) => {
      const data = (receipt.data && typeof receipt.data === 'object'
        ? (receipt.data as Record<string, unknown>)
        : null);
      const detailParts: string[] = [];
      if (receipt.type === 'launch_thread') {
        detailParts.push('Hilo');
        if (typeof data?.provider === 'string') detailParts.push(data.provider);
        if (data?.oddMode) detailParts.push('ODD');
      } else if (receipt.type === 'spawn_subagent') {
        detailParts.push('Subagente');
        if (typeof data?.role === 'string') detailParts.push(data.role);
        if (typeof data?.provider === 'string') detailParts.push(data.provider);
        if (data?.oddMode) detailParts.push('ODD');
      } else if (receipt.type === 'launch_agent') {
        detailParts.push('Agente');
        if (typeof data?.agentName === 'string') detailParts.push(data.agentName);
        if (typeof data?.provider === 'string') detailParts.push(data.provider);
        if (data?.oddMode) detailParts.push('ODD');
      } else {
        detailParts.push(receipt.type);
      }

      const workedLabel = formatWorkedForLabel(receipt.durationMs);
      if (workedLabel) {
        detailParts.push(workedLabel);
      } else if (receipt.durationMs) {
        detailParts.push(`${receipt.durationMs} ms`);
      }

      const delegatedThreadId =
        (receipt.type === 'launch_thread' ||
          receipt.type === 'spawn_subagent' ||
          receipt.type === 'launch_agent') &&
        typeof data?.threadId === 'string' &&
        data.threadId.trim()
          ? data.threadId.trim()
          : null;
      const delegatedMode: 'chat' | 'agents' | undefined = delegatedThreadId
        ? receipt.type === 'launch_agent'
          ? 'agents'
          : 'chat'
        : undefined;

      items.push({
        ...baseItem(`${turn.turnId}:action:${index}`, 'tool', at),
        title: receipt.summaryEs || receipt.type,
        detail: detailParts.join(' · '),
        status: receipt.ok ? 'completed' : 'failed',
        toolName: receipt.type,
        toolKind: 'dynamicToolCall',
        ...(workedLabel ? { durationSeconds: (receipt.durationMs as number) / 1000 } : {}),
        ...(delegatedThreadId ? { delegatedThreadId, delegatedMode } : {}),
      });
    });

    if (turn.reply) {
      const replyAt =
        typeof turn.completedAt === 'number' && Number.isFinite(turn.completedAt)
          ? Math.max(at, turn.completedAt)
          : typeof turn.durationMs === 'number' && Number.isFinite(turn.durationMs) && turn.durationMs > 0
            ? at + turn.durationMs
            : at;
      const turnWorkedLabel = formatWorkedForLabel(turn.durationMs);
      items.push({
        ...baseItem(`${turn.turnId}:assistant`, 'assistant', replyAt),
        text: turn.reply,
        ...(turnWorkedLabel
          ? {
              detail: turnWorkedLabel,
              durationSeconds: (turn.durationMs as number) / 1000,
            }
          : {}),
      });
    }
  }

  if (options?.includeSessionSummary) {
    const summaryItem = buildVoiceSessionSummaryItem(turns, options.sessionEndedAt);
    if (summaryItem) {
      items.push(summaryItem);
    }
  }

  return items;
}

const LIVE_LABELS: Record<string, string> = {
  planning: 'Pensando…',
  consulting: 'Consultando chats…',
  executing: 'Ejecutando acciones…',
  verifying: 'Verificando…',
  speaking: 'Hablando…',
};

/** The in-flight stage rendered as the same "Thinking" row a streaming provider turn shows. */
export function liveVoiceStageItem(live: LiveVoiceStage): ChatItem {
  return {
    ...baseItem(`${live.turnId}:live`, 'reasoning', Number.MAX_SAFE_INTEGER),
    text: live.detail || LIVE_LABELS[live.stage] || 'Pensando…',
    status: 'running',
    streaming: true,
  };
}

function isValidTimestamp(ts: unknown): ts is number {
  return typeof ts === 'number' && Number.isFinite(ts) && ts > 0;
}

function crossSourceKindRank(kind: ChatItem['kind']): number {
  if (kind === 'user') return 0;
  if (kind === 'assistant') return 2;
  return 1;
}

/** Interleaves voice items with provider items by time, deduplicating live subagent cards and preserving chronological turn structure. */
export function mergeTimeline(providerItems: ChatItem[], voiceItems: ChatItem[]): ChatItem[] {
  if (voiceItems.length === 0) return providerItems;
  if (providerItems.length === 0) return voiceItems;

  const liveSubagentIds = new Set<string>();
  for (const item of providerItems) {
    if (item.toolKind === 'subagent' || item.subagentMeta) {
      const childId = item.subagentMeta?.childThreadId?.trim();
      const subId = item.subagentMeta?.subagentId?.trim();
      if (childId) liveSubagentIds.add(childId);
      if (subId) liveSubagentIds.add(subId);
    }
  }

  const subagentAnchorMs = new Map<string, number>();
  const dedupedVoiceItems = voiceItems.filter((item) => {
    if (
      item.toolName === 'spawn_subagent' &&
      item.status === 'completed' &&
      item.delegatedThreadId &&
      liveSubagentIds.has(item.delegatedThreadId)
    ) {
      if (isValidTimestamp(item.createdAtUnixMs)) {
        subagentAnchorMs.set(item.delegatedThreadId, item.createdAtUnixMs);
      }
      return false;
    }
    return true;
  });

  type Entry = {
    item: ChatItem;
    source: 'provider' | 'voice';
    ts: number;
    order: number;
  };

  const entries: Entry[] = [];
  let lastValidProviderTs = 0;
  providerItems.forEach((item, idx) => {
    let ts: number;
    if (isValidTimestamp(item.createdAtUnixMs)) {
      ts = item.createdAtUnixMs;
      lastValidProviderTs = ts;
    } else {
      const childId = item.subagentMeta?.childThreadId?.trim();
      const subId = item.subagentMeta?.subagentId?.trim();
      const anchored =
        (childId ? subagentAnchorMs.get(childId) : undefined) ??
        (subId ? subagentAnchorMs.get(subId) : undefined);
      ts = anchored ?? lastValidProviderTs;
    }
    entries.push({ item, source: 'provider', ts, order: idx });
  });

  const voiceOrderOffset = providerItems.length;
  let lastValidVoiceTs = 0;
  dedupedVoiceItems.forEach((item, idx) => {
    const ts = isValidTimestamp(item.createdAtUnixMs) ? item.createdAtUnixMs : lastValidVoiceTs;
    if (ts > 0) lastValidVoiceTs = ts;
    entries.push({ item, source: 'voice', ts, order: voiceOrderOffset + idx });
  });

  return entries
    .sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      if (a.source !== b.source) {
        const rankDiff = crossSourceKindRank(a.item.kind) - crossSourceKindRank(b.item.kind);
        if (rankDiff !== 0) return rankDiff;
      }
      return a.order - b.order;
    })
    .map((entry) => entry.item);
}
