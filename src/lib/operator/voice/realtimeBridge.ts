// Kite Code — Full-Duplex 24 kHz Realtime Speech-to-Speech Bridge
// Connects native Rust `voice_realtime` WebSocket proxy to Argos's `executePlan()` tool loop,
// automatically downgrading to `cascaded` mode if credentials or endpoint are unavailable.

import { invokeCommand, invokeFlatCommand, isTauriEnvironment } from '../../ipc';
import {
  ActionSchema,
  OPERATOR_NATIVE_TOOLS,
  type OperatorPlan,
  type TurnContext,
} from '../contract';
import { executePlan } from '../executor';

const REALTIME_TOOL_NAMES = new Set([
  'peek_changes',
  'peek_runs',
  'peek_agents',
  'peek_files',
  'recall_conversations',
  'propose_task',
  'refine_proposal',
  'confirm_proposal',
  'cancel_proposal',
  'spawn_subagent',
  'manage_tasks',
  'stay_silent',
]);

export interface RealtimeConnectOptions {
  endpoint?: string;
  voice?: string;
  instructions?: string;
  prefixPaddingMs?: number;
  silenceDurationMs?: number;
  deviceId?: string | null;
}

export interface RealtimeConnectResult {
  activeTransport: 'realtime' | 'cascaded';
  fallbackReason?: string;
  endpoint?: string;
}

export interface RealtimeToolCallPayload {
  callId: string;
  name: string;
  arguments: Record<string, unknown> | string;
}

export interface RealtimeBridgeHandlers {
  onTransportFallback?: (mode: 'cascaded', reason: string) => void;
  onAudioDelta?: (base64Pcm: string) => void;
  onTranscript?: (ev: { text?: string; delta?: string; type?: string }) => void;
}

export class RealtimeVoiceBridge {
  private readonly handlers: RealtimeBridgeHandlers;
  private connected = false;
  private unlisteners: Array<() => void> = [];

  constructor(handlers: RealtimeBridgeHandlers = {}) {
    this.handlers = handlers;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public async connect(options: RealtimeConnectOptions = {}): Promise<RealtimeConnectResult> {
    if (!isTauriEnvironment()) {
      const reason = 'tauri_runtime_unavailable';
      this.handlers.onTransportFallback?.('cascaded', reason);
      return { activeTransport: 'cascaded', fallbackReason: reason };
    }

    const realtimeTools = OPERATOR_NATIVE_TOOLS.filter((t) =>
      REALTIME_TOOL_NAMES.has(t.function.name)
    ).map((t) => ({
      type: 'function',
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));

    try {
      const res = await invokeFlatCommand<{
        ok?: boolean;
        connected?: boolean;
        fallbackToCascaded?: boolean;
        reason?: string;
        endpoint?: string;
      }>('voice_realtime_connect', {
        endpoint: options.endpoint,
        voice: options.voice || 'Ara',
        instructions: options.instructions || '',
        tools: realtimeTools,
        prefixPaddingMs: options.prefixPaddingMs ?? 300,
        silenceDurationMs: options.silenceDurationMs ?? 500,
        deviceId: options.deviceId ?? null,
      });

      if (!res?.ok || res?.fallbackToCascaded) {
        const reason = res?.reason || 'realtime_unavailable';
        this.connected = false;
        this.handlers.onTransportFallback?.('cascaded', reason);
        return { activeTransport: 'cascaded', fallbackReason: reason };
      }

      this.connected = true;
      return {
        activeTransport: 'realtime',
        endpoint: res.endpoint ?? options.endpoint,
      };
    } catch (err: any) {
      const reason = err?.message || 'realtime_connect_error';
      this.connected = false;
      this.handlers.onTransportFallback?.('cascaded', reason);
      return { activeTransport: 'cascaded', fallbackReason: reason };
    }
  }

  public async subscribeEvents(contextProvider: () => TurnContext): Promise<void> {
    if (!isTauriEnvironment()) return;
    try {
      const eventMod = await import('@tauri-apps/api/event');
      if (typeof eventMod?.listen !== 'function') return;

      this.unlisteners.push(
        await eventMod.listen<any>('voice:realtime-tool-call', (ev) => {
          const payload = ev?.payload;
          if (!payload) return;
          const callId = payload.call_id || payload.callId || '';
          const name = payload.name || '';
          const args = payload.arguments ?? {};
          if (callId && name) {
            void this.handleToolCallEvent({ callId, name, arguments: args }, contextProvider());
          }
        })
      );

      if (this.handlers.onAudioDelta) {
        this.unlisteners.push(
          await eventMod.listen<{ delta?: string }>('voice:realtime-audio-delta', (ev) => {
            if (ev?.payload?.delta) {
              this.handlers.onAudioDelta?.(ev.payload.delta);
            }
          })
        );
      }

      if (this.handlers.onTranscript) {
        this.unlisteners.push(
          await eventMod.listen<any>('voice:realtime-transcript', (ev) => {
            if (ev?.payload) {
              this.handlers.onTranscript?.(ev.payload);
            }
          })
        );
      }
    } catch {
      // ignore outside Tauri event environment
    }
  }

  public async handleToolCallEvent(
    toolCall: RealtimeToolCallPayload,
    context: TurnContext,
    turnId: string = `rt-${Date.now()}`
  ): Promise<{ ok: boolean; outputJson: string }> {
    let parsedArgs: Record<string, unknown> = {};
    if (typeof toolCall.arguments === 'string') {
      try {
        parsedArgs = JSON.parse(toolCall.arguments);
      } catch {
        parsedArgs = {};
      }
    } else if (toolCall.arguments && typeof toolCall.arguments === 'object') {
      parsedArgs = toolCall.arguments;
    }

    let outputPayload: Record<string, unknown>;
    let ok = false;

    try {
      const validated = ActionSchema.parse({
        type: toolCall.name,
        ...parsedArgs,
      });
      const plan: OperatorPlan = {
        strategy: 'llm',
        actions: [validated],
      };
      const execRes = await executePlan(plan, context, turnId);
      ok = execRes.overallSuccess;
      outputPayload = {
        ok: execRes.overallSuccess,
        reply: execRes.reply,
        receipts: execRes.receipts,
      };
    } catch (err: any) {
      outputPayload = {
        ok: false,
        error: err?.message || String(err),
      };
    }

    const outputJson = JSON.stringify(outputPayload);
    if (isTauriEnvironment()) {
      await invokeFlatCommand('voice_realtime_submit_tool_result', {
        callId: toolCall.callId,
        outputJson,
      }).catch((err) => {
        console.warn('[RealtimeVoiceBridge] voice_realtime_submit_tool_result failed:', err);
      });
    }
    return { ok, outputJson };
  }

  public async truncateAssistantAudio(itemId: string, audioEndMs: number): Promise<void> {
    if (!isTauriEnvironment() || !itemId) return;
    await invokeFlatCommand('voice_realtime_truncate', {
      itemId,
      audioEndMs: Math.max(0, Math.round(audioEndMs)),
    }).catch((err) => {
      console.warn('[RealtimeVoiceBridge] voice_realtime_truncate failed:', err);
    });
  }

  public async disconnect(): Promise<void> {
    this.connected = false;
    for (const unlisten of this.unlisteners) {
      try {
        unlisten();
      } catch {}
    }
    this.unlisteners = [];
    if (isTauriEnvironment()) {
      await invokeCommand('voice_realtime_disconnect').catch(() => undefined);
    }
  }
}
