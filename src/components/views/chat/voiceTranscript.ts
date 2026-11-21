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

/** Projects recorded voice turns into the same item shapes a provider transcript uses. */
export function voiceTurnsToChatItems(turns: VoiceTurnRecord[]): ChatItem[] {
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
      if (receipt.durationMs) detailParts.push(`${receipt.durationMs} ms`);

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
        ...(delegatedThreadId ? { delegatedThreadId, delegatedMode } : {}),
      });
    });

    if (turn.reply) {
      items.push({
        ...baseItem(`${turn.turnId}:assistant`, 'assistant', at),
        text: turn.reply,
      });
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

/** Interleaves voice items with provider items by time, keeping insertion order for ties. */
export function mergeTimeline(providerItems: ChatItem[], voiceItems: ChatItem[]): ChatItem[] {
  if (voiceItems.length === 0) return providerItems;
  if (providerItems.length === 0) return voiceItems;
  return [...providerItems, ...voiceItems]
    .map((item, order) => ({ item, order }))
    .sort((a, b) => a.item.createdAtUnixMs - b.item.createdAtUnixMs || a.order - b.order)
    .map((entry) => entry.item);
}
