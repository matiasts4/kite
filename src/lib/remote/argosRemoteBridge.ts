import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauriEnvironment } from '../ipc/core';
import {
  replyRemoteArgosTurn,
  type RemoteArgosTurnReplyPayload,
} from '../ipc/remote';
import type {
  OperatorTurnResult,
  RunOperatorTurnOptions,
} from '../operator/index';
import type { ProviderMessage } from '../operator/providers/types';
import {
  voiceSessionStore,
  type DraftTaskProposal,
  type VoiceSessionState,
} from '../operator/voice/voiceSessionStore';

export const REMOTE_ARGOS_TURN_REQUEST_EVENT = 'remote:argos-turn-request';

export interface ArgosRemoteTurnRequestEvent {
  requestId: string;
  turnId?: string;
  transcript?: string;
  workspaceId?: string | null;
  history?: ProviderMessage[];
  mode?: string;
  language?: string;
  requestTts?: boolean;
}

export type VoiceSnapshotWithProposal = VoiceSessionState & {
  activeProposal?: DraftTaskProposal | null;
};

export interface ArgosRemoteBridgeDeps {
  runOperatorTurn?: (
    input: string,
    options?: RunOperatorTurnOptions
  ) => Promise<OperatorTurnResult>;
  getSnapshot?: () => VoiceSnapshotWithProposal;
  getDraftProposal?: (scopeKey?: string | null) => DraftTaskProposal | null;
  replyRemoteArgosTurn?: (
    requestId: string,
    payload: RemoteArgosTurnReplyPayload
  ) => Promise<void>;
}

/**
 * Processes one `remote:argos-turn-request` event via the local Argos operator pipeline
 * and always dispatches a reply back to Rust so the mobile client never hangs on timeout.
 */
export async function handleArgosRemoteTurnRequest(
  payload: ArgosRemoteTurnRequestEvent,
  deps: ArgosRemoteBridgeDeps = {}
): Promise<RemoteArgosTurnReplyPayload | null> {
  const requestId = typeof payload?.requestId === 'string' ? payload.requestId.trim() : '';
  if (!requestId) {
    console.warn('[ArgosRemoteBridge] Received remote:argos-turn-request without requestId.');
    return null;
  }

  const sendReply = deps.replyRemoteArgosTurn ?? replyRemoteArgosTurn;

  const transcript = typeof payload.transcript === 'string' ? payload.transcript.trim() : '';

  try {
    if (!transcript) {
      throw new Error('El turno remoto de Argos no recibió una transcripción válida.');
    }

    const executeTurn =
      deps.runOperatorTurn ?? (await import('../operator/index')).runOperatorTurn;

    const getSnapshot =
      deps.getSnapshot ?? (() => voiceSessionStore.getSnapshot() as VoiceSnapshotWithProposal);
    const getDraftProposal =
      deps.getDraftProposal ??
      ((scopeKey?: string | null) => voiceSessionStore.getDraftProposal(scopeKey));

    const turnResult = await executeTurn(transcript, {
      source: 'voz',
      ttsEnabled: false,
      workspaceId: payload.workspaceId ?? undefined,
      history: payload.history,
      turnId: payload.turnId,
      mode: payload.mode ?? (payload.language ? `remote:${payload.language}` : undefined),
    });

    const snapshot = getSnapshot();
    const proposal =
      snapshot.activeProposal ??
      snapshot.draftProposal ??
      getDraftProposal(payload.workspaceId ?? null) ??
      null;

    const response: RemoteArgosTurnReplyPayload = {
      ok: true,
      turnId: turnResult.turnId,
      transcript,
      reply: turnResult.reply,
      receipts: turnResult.receipts,
      proposal,
      strategy: turnResult.strategy,
      durationMs: turnResult.durationMs,
      overallSuccess: turnResult.overallSuccess,
      providerId: turnResult.providerId,
      model: turnResult.model,
    };

    await sendReply(requestId, response);
    return response;
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : String(err || 'Error inesperado en Argos remoto.');
    console.warn('[ArgosRemoteBridge] Failed to process remote Argos turn:', err);

    const errorResponse: RemoteArgosTurnReplyPayload = {
      ok: false,
      error: errorMessage,
      turnId: payload.turnId,
      transcript,
      receipts: [],
      proposal: null,
    };

    try {
      await sendReply(requestId, errorResponse);
    } catch (replyErr) {
      console.warn('[ArgosRemoteBridge] Failed to deliver error reply for request:', requestId, replyErr);
    }

    return errorResponse;
  }
}

/**
 * Subscribes to `remote:argos-turn-request` Tauri backend events and returns an unsubscribe cleanup.
 */
export function initArgosRemoteBridge(deps: ArgosRemoteBridgeDeps = {}): () => void {
  if (!isTauriEnvironment()) {
    return () => {};
  }

  let disposed = false;
  let unlisten: UnlistenFn | null = null;

  void listen<ArgosRemoteTurnRequestEvent>(REMOTE_ARGOS_TURN_REQUEST_EVENT, (event) => {
    if (disposed || !event?.payload) return;
    void handleArgosRemoteTurnRequest(event.payload, deps);
  })
    .then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlisten = fn;
      }
    })
    .catch((err) => {
      console.warn('[ArgosRemoteBridge] Failed to attach remote Argos listener:', err);
    });

  return () => {
    disposed = true;
    if (unlisten) {
      const fn = unlisten;
      unlisten = null;
      fn();
    }
  };
}
