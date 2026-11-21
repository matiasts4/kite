import { invokeCommand } from '../../../ipc';
import type { ActionReceipt, TurnContext } from '../../contract';
import { voiceSessionStore } from '../../voice/voiceSessionStore';
import { formatDelegatedTask } from './oddBrief';

export interface LaunchThreadActionPayload {
  type: 'launch_thread';
  threadId?: string;
  provider?: string;
  title?: string;
  body?: string;
  oddMode?: boolean;
  focusThread?: boolean;
}

function normalizeProvider(raw?: string): string | undefined {
  if (!raw) return undefined;
  const lower = raw.trim().toLowerCase();
  if (!lower || lower === 'powershell') return undefined;
  if (lower === 'open-code') return 'opencode';
  return lower;
}

export async function executeLaunchThreadAction(
  action: LaunchThreadActionPayload,
  actionIdx: number,
  context?: TurnContext
): Promise<ActionReceipt> {
  let targetThreadId = action.threadId;
  let provider = normalizeProvider(action.provider);
  let createdNewThread = false;

  // Infer provider from body if not explicitly set
  if (!provider && action.body) {
    const lowerBody = action.body.toLowerCase();
    if (lowerBody.includes('grok')) provider = 'grok';
    else if (lowerBody.includes('claude')) provider = 'claude';
    else if (lowerBody.includes('codex')) provider = 'codex';
    else if (lowerBody.includes('antigravity') || lowerBody.includes('agy')) provider = 'antigravity';
    else if (lowerBody.includes('opencode')) provider = 'opencode';
  }

  // If no threadId was given, create a general chat thread
  if (!targetThreadId) {
    try {
      const createPayload: Record<string, unknown> = {
        workspaceId: context?.workspaceId,
      };
      if (provider) {
        createPayload.provider = provider;
      }
      const created = await invokeCommand<{ id?: string }>('create_general_chat', createPayload);
      if (!created || !created.id) {
        return {
          actionIdx,
          type: 'launch_thread',
          ok: false,
          summaryEs: 'No pude abrir el hilo: respuesta inválida al crear chat.',
          error: 'create_failed',
        };
      }
      targetThreadId = created.id;
      createdNewThread = true;
    } catch (err: any) {
      return {
        actionIdx,
        type: 'launch_thread',
        ok: false,
        summaryEs: `No pude abrir el hilo: ${err?.message || String(err)}`,
        error: err?.message || String(err),
      };
    }
  }

  // Optionally set thread title when provided for a newly created thread
  const cleanTitle = action.title?.trim();
  if (createdNewThread && cleanTitle) {
    try {
      await invokeCommand('rename_chat_thread', {
        supportedSchemaVersion: 1,
        threadId: targetThreadId,
        title: cleanTitle,
      });
    } catch {
      // Non-fatal: thread is already created and usable.
    }
  }

  // If there is a body to send, send it via dispatch_send (with optional ODD-first framing)
  if (action.body) {
    const preparedBody = formatDelegatedTask(action.body, {
      oddMode: action.oddMode,
      targetKind: 'thread',
    });
    try {
      const sendRes = await invokeCommand<{ status?: string; error?: string }>('dispatch_send', {
        address: `thread:${targetThreadId}`,
        body: preparedBody,
        caller: 'agent',
      });

      const okDispatchStatuses = new Set(['submitted', 'queued', 'settled']);
      if (sendRes?.status && !okDispatchStatuses.has(sendRes.status)) {
        const errMsg = sendRes.error || sendRes.status;
        return {
          actionIdx,
          type: 'launch_thread',
          ok: false,
          summaryEs: `No pude enviar el mensaje al hilo: ${errMsg}`,
          error: errMsg,
        };
      }
    } catch (err: any) {
      return {
        actionIdx,
        type: 'launch_thread',
        ok: false,
        summaryEs: `No pude enviar el mensaje al hilo: ${err?.message || String(err)}`,
        error: err?.message || String(err),
      };
    }
  }

  // Determine whether to preserve the live Thread Voice Mode call or switch UI focus (S10 vs S11).
  const vs = voiceSessionStore.getSnapshot();
  const inActiveThreadVoiceCall =
    ((vs.phase === 'active' || vs.phase === 'starting') && vs.activeSurface === 'thread') ||
    Boolean(context?.voiceSessionActive && context?.mode === 'thread');
  const shouldFocusThread = action.focusThread === true || !inActiveThreadVoiceCall;

  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent('kite:threads-changed'));
      if (shouldFocusThread) {
        window.dispatchEvent(
          new CustomEvent('kite:select-thread', {
            detail: { threadId: targetThreadId, mode: 'chat' },
          })
        );
      }
    } catch {}
  }

  const providerLabel = provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : '';
  const titleLabel = cleanTitle ? ` «${cleanTitle}»` : '';
  const oddLabel = action.oddMode ? ' con enfoque ODD' : '';

  const summaryEs = createdNewThread
    ? providerLabel
      ? `Nuevo hilo${titleLabel} con ${providerLabel}${oddLabel} iniciado correctamente.`
      : `Nuevo hilo${titleLabel}${oddLabel} iniciado correctamente.`
    : `Mensaje enviado al hilo${titleLabel}${oddLabel}.`;

  const spokenSummaryEs =
    inActiveThreadVoiceCall && !shouldFocusThread
      ? createdNewThread
        ? `Abrí el hilo${titleLabel}${providerLabel ? ` con ${providerLabel}` : ''}${oddLabel} en segundo plano.`
        : `Envié las instrucciones al hilo${oddLabel}.`
      : summaryEs;

  return {
    actionIdx,
    type: 'launch_thread',
    ok: true,
    summaryEs,
    spokenSummaryEs,
    data: {
      threadId: targetThreadId,
      ...(provider ? { provider } : {}),
      ...(cleanTitle ? { title: cleanTitle } : {}),
      ...(action.oddMode ? { oddMode: true } : {}),
      focused: shouldFocusThread,
    },
  };
}
