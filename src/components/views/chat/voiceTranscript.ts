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

    items.push({
      ...baseItem(`${turn.turnId}:user`, 'user', at),
      text: turn.userPrompt,
    });

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
      items.push({
        ...baseItem(`${turn.turnId}:action:${index}`, 'tool', at),
        title: receipt.summaryEs || receipt.type,
        detail: receipt.durationMs ? `${receipt.type} · ${receipt.durationMs} ms` : receipt.type,
        status: receipt.ok ? 'completed' : 'failed',
        toolName: receipt.type,
        toolKind: 'dynamicToolCall',
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
