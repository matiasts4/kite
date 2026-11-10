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

  // If no threadId was given, create a general chat thread
  if (!targetThreadId) {
    try {
      const createPayload: Record<string, unknown> = {
        workspaceId: context?.workspaceId,
      };
      if (action.provider) {
        createPayload.provider = action.provider;
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

  return {
    actionIdx,
    type: 'launch_thread',
    ok: true,
    summaryEs: `Hilo ${targetThreadId} iniciado correctamente.`,
    data: { threadId: targetThreadId },
  };
}
