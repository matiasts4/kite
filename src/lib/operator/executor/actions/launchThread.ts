import { invokeCommand } from '../../../ipc';
import type { ActionReceipt, TurnContext } from '../../contract';

export interface LaunchThreadActionPayload {
  type: 'launch_thread';
  threadId?: string;
  provider?: string;
  body?: string;
}

export async function executeLaunchThreadAction(
  action: LaunchThreadActionPayload,
  actionIdx: number,
  context?: TurnContext
): Promise<ActionReceipt> {
  let targetThreadId = action.threadId;
  let provider = action.provider;

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

  // If there is a body to send, send it via dispatch_send
  if (action.body) {
    try {
      const sendRes = await invokeCommand<{ status?: string; error?: string }>('dispatch_send', {
        address: `thread:${targetThreadId}`,
        body: action.body,
        caller: 'agent',
      });

      if (sendRes?.status && sendRes.status !== 'submitted') {
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

  // S11: Refresh thread list and switch/focus thread in UI
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent('kite:threads-changed'));
      window.dispatchEvent(
        new CustomEvent('kite:select-thread', {
          detail: { threadId: targetThreadId, mode: 'chat' },
        })
      );
    } catch {}
  }

  const providerLabel = provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : '';
  const summaryEs = providerLabel
    ? `Nuevo hilo con ${providerLabel} iniciado correctamente.`
    : 'Nuevo hilo iniciado correctamente.';

  return {
    actionIdx,
    type: 'launch_thread',
    ok: true,
    summaryEs,
    data: { threadId: targetThreadId, ...(provider ? { provider } : {}) },
  };
}
