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
import { voiceSessionStore, type RealtimeProviderId } from './voiceSessionStore';

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

export interface RealtimeToolSchema {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const TALKER_THINKER_TOOLS: RealtimeToolSchema[] = [
  {
    type: 'function',
    name: 'call_thinker_agent',
    description:
      'Delegate coding, workspace edits, multi-step analysis, or background tasks asynchronously to the Thinker layer (subagent, thread, or autonomous agent) without blocking spoken dialogue.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Actionable task instructions for the Thinker worker.',
        },
        targetKind: {
          type: 'string',
          enum: ['subagent', 'thread', 'agent'],
          default: 'subagent',
          description: 'Execution surface: subagent (default), thread, or autonomous agent.',
        },
        role: {
          type: 'string',
          description: 'Optional subagent role label or autonomous agent name.',
        },
        provider: {
          type: 'string',
          enum: ['grok', 'claude', 'codex', 'antigravity', 'opencode'],
          description: 'Optional coding model provider for the Thinker task.',
        },
        oddMode: {
          type: 'boolean',
          description: 'Enable ODD spec-first execution framing.',
        },
      },
      required: ['task'],
    },
  },
  {
    type: 'function',
    name: 'cancel_thinker_agent',
    description: 'Cancel a running delegated Thinker subagent or worker.',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Optional subagent ID, role, or 1-based index to cancel (defaults to latest active).',
        },
      },
    },
  },
  {
    type: 'function',
    name: 'set_progress_updates',
    description: 'Enable or mute spoken background progress updates while Thinker tasks run.',
    parameters: {
      type: 'object',
      properties: {
        enabled: {
          type: 'boolean',
          description: 'Whether to narrate background Thinker progress updates aloud.',
        },
      },
      required: ['enabled'],
    },
  },
  {
    type: 'function',
    name: 'hang_up',
    description: 'End the active voice session cleanly when the user says goodbye or asks to hang up.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Optional concise reason for hanging up.',
        },
      },
    },
  },
];

export interface RealtimeConnectOptions {
  provider?: RealtimeProviderId;
  apiKey?: string;
  model?: string;
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
  provider?: RealtimeProviderId;
  inputSampleRate?: number;
}

export interface RealtimeToolCallPayload {
  callId: string;
  name: string;
  arguments: Record<string, unknown> | string;
}

export interface RealtimeBridgeHandlers {
  onTransportFallback?: (mode: 'cascaded', reason: string) => void;
  onAudioDelta?: (base64Pcm: string, sampleRate?: number) => void;
  onTranscript?: (ev: { text?: string; delta?: string; type?: string }) => void;
  onClearAudio?: () => void;
  onUserSpeech?: (ev: { text: string; interim: boolean; delta?: boolean }) => void;
  onStatusError?: (error: string) => void;
  onHangUp?: (reason?: string) => void;
}

function buildRealtimeToolsPayload(): RealtimeToolSchema[] {
  const nativeTools: RealtimeToolSchema[] = OPERATOR_NATIVE_TOOLS.filter((t) =>
    REALTIME_TOOL_NAMES.has(t.function.name)
  ).map((t) => ({
    type: 'function',
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters as Record<string, unknown>,
  }));
  return [...nativeTools, ...TALKER_THINKER_TOOLS];
}

function parseToolArguments(rawArgs: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof rawArgs === 'string') {
    try {
      const parsed = JSON.parse(rawArgs);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (rawArgs && typeof rawArgs === 'object') {
    return rawArgs;
  }
  return {};
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

    const realtimeTools = buildRealtimeToolsPayload();

    try {
      const res = await invokeFlatCommand<{
        ok?: boolean;
        connected?: boolean;
        fallbackToCascaded?: boolean;
        reason?: string;
        endpoint?: string;
        provider?: RealtimeProviderId;
        inputSampleRate?: number;
      }>('voice_realtime_connect', {
        endpoint: options.endpoint,
        voice: options.voice || 'Ara',
        instructions: options.instructions || '',
        tools: realtimeTools,
        prefixPaddingMs: options.prefixPaddingMs ?? 300,
        silenceDurationMs: options.silenceDurationMs ?? 500,
        deviceId: options.deviceId ?? null,
        provider: options.provider,
        apiKey: options.apiKey,
        model: options.model,
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
        provider: res.provider ?? options.provider,
        inputSampleRate: res.inputSampleRate,
      };
    } catch (err: any) {
      console.warn('[RealtimeVoiceBridge] voice_realtime_connect failed:', err);
      const reason = err?.message || 'realtime_connect_error';
      this.connected = false;
      this.handlers.onTransportFallback?.('cascaded', reason);
      return { activeTransport: 'cascaded', fallbackReason: reason };
    }
  }

  public async setMuted(muted: boolean): Promise<boolean> {
    if (!this.connected || !isTauriEnvironment()) {
      return false;
    }
    try {
      const res = await invokeFlatCommand<{ ok?: boolean }>('voice_realtime_set_muted', {
        muted: Boolean(muted),
      });
      return typeof res === 'boolean' ? res : res?.ok !== false;
    } catch (err) {
      console.warn('[RealtimeVoiceBridge] voice_realtime_set_muted failed:', err);
      return false;
    }
  }

  private clearListeners(): void {
    for (const unlisten of this.unlisteners) {
      try {
        unlisten();
      } catch (err) {
        console.warn('[RealtimeVoiceBridge] Failed to unlisten realtime event:', err);
      }
    }
    this.unlisteners = [];
  }

  public async subscribeEvents(contextProvider: () => TurnContext): Promise<void> {
    if (!isTauriEnvironment()) return;
    this.clearListeners();

    try {
      const eventMod = await import('@tauri-apps/api/event');
      if (typeof eventMod?.listen !== 'function') return;

      this.unlisteners.push(
        await eventMod.listen<any>('voice:realtime-tool-call', (ev) => {
          const payload = ev?.payload;
          if (!payload) return;
          const callId = String(payload.call_id || payload.callId || payload.id || '').trim();
          const name = String(payload.name || '').trim();
          const args = payload.arguments ?? payload.args ?? {};
          if (callId && name) {
            void this.handleToolCallEvent({ callId, name, arguments: args }, contextProvider());
          }
        })
      );

      this.unlisteners.push(
        await eventMod.listen<{ delta?: string; sampleRate?: number }>(
          'voice:realtime-audio-delta',
          (ev) => {
            if (ev?.payload?.delta) {
              this.handlers.onAudioDelta?.(ev.payload.delta, ev.payload.sampleRate);
            }
          }
        )
      );

      this.unlisteners.push(
        await eventMod.listen<unknown>('voice:realtime-clear-audio', () => {
          this.handlers.onClearAudio?.();
        })
      );

      this.unlisteners.push(
        await eventMod.listen<{ text?: string; interim?: boolean; delta?: boolean }>(
          'voice:realtime-user-speech',
          (ev) => {
            if (ev?.payload) {
              this.handlers.onUserSpeech?.({
                text: typeof ev.payload.text === 'string' ? ev.payload.text : '',
                interim: Boolean(ev.payload.interim),
                ...(ev.payload.delta !== undefined ? { delta: Boolean(ev.payload.delta) } : {}),
              });
            }
          }
        )
      );

      this.unlisteners.push(
        await eventMod.listen<any>('voice:realtime-transcript', (ev) => {
          if (ev?.payload) {
            this.handlers.onTranscript?.(ev.payload);
          }
        })
      );

      this.unlisteners.push(
        await eventMod.listen<{ ok?: boolean; error?: string }>('voice:realtime-status', (ev) => {
          const payload = ev?.payload;
          if (
            payload &&
            payload.ok === false &&
            typeof payload.error === 'string' &&
            payload.error.trim().length > 0
          ) {
            this.handlers.onStatusError?.(payload.error);
          }
        })
      );
    } catch (err) {
      console.warn('[RealtimeVoiceBridge] subscribeEvents failed:', err);
    }
  }

  private async executeThinkerCall(
    parsedArgs: Record<string, unknown>,
    context: TurnContext,
    turnId: string
  ): Promise<{ ok: boolean; outputPayload: Record<string, unknown> }> {
    const task = typeof parsedArgs.task === 'string' ? parsedArgs.task.trim() : '';
    if (!task) {
      return {
        ok: false,
        outputPayload: { ok: false, error: 'call_thinker_agent requires a non-empty task' },
      };
    }

    const rawKind =
      typeof parsedArgs.targetKind === 'string' ? parsedArgs.targetKind.trim().toLowerCase() : '';
    const targetKind: 'subagent' | 'thread' | 'agent' =
      rawKind === 'thread' || rawKind === 'agent' ? rawKind : 'subagent';
    const role = typeof parsedArgs.role === 'string' && parsedArgs.role.trim() ? parsedArgs.role.trim() : undefined;
    const provider =
      typeof parsedArgs.provider === 'string' && parsedArgs.provider.trim()
        ? parsedArgs.provider.trim().toLowerCase()
        : undefined;
    const oddMode = parsedArgs.oddMode !== undefined ? Boolean(parsedArgs.oddMode) : undefined;

    let rawAction: Record<string, unknown>;
    if (targetKind === 'thread') {
      rawAction = {
        type: 'launch_thread',
        body: task,
        ...(role ? { title: role } : {}),
        ...(provider ? { provider } : {}),
        ...(oddMode !== undefined ? { oddMode } : {}),
      };
    } else if (targetKind === 'agent') {
      rawAction = {
        type: 'launch_agent',
        body: task,
        ...(role ? { agentQuery: role } : {}),
        ...(provider ? { provider } : {}),
        ...(oddMode !== undefined ? { oddMode } : {}),
      };
    } else {
      rawAction = {
        type: 'spawn_subagent',
        via: 'thread',
        task,
        ...(role ? { role } : {}),
        ...(provider ? { provider } : {}),
        ...(oddMode !== undefined ? { oddMode } : {}),
      };
    }

    const validated = ActionSchema.parse(rawAction);
    const plan: OperatorPlan = {
      strategy: 'llm',
      actions: [validated],
    };
    const execRes = await executePlan(plan, context, turnId);
    const ok = execRes.overallSuccess;
    return {
      ok,
      outputPayload: {
        ok,
        status: ok ? 'dispatched' : 'failed',
        targetKind,
        reply: execRes.reply,
        receipts: execRes.receipts,
      },
    };
  }

  private async executeCancelThinker(
    parsedArgs: Record<string, unknown>,
    context: TurnContext,
    turnId: string
  ): Promise<{ ok: boolean; outputPayload: Record<string, unknown> }> {
    const rawTarget = parsedArgs.target;
    const target =
      typeof rawTarget === 'number'
        ? rawTarget
        : typeof rawTarget === 'string' && rawTarget.trim()
        ? rawTarget.trim()
        : 1;

    const validated = ActionSchema.parse({
      type: 'control_subagent',
      operation: 'cancel',
      target,
    });
    const execRes = await executePlan({ strategy: 'llm', actions: [validated] }, context, turnId);
    return {
      ok: execRes.overallSuccess,
      outputPayload: {
        ok: execRes.overallSuccess,
        reply: execRes.reply,
        receipts: execRes.receipts,
      },
    };
  }

  public async handleToolCallEvent(
    toolCall: RealtimeToolCallPayload,
    context: TurnContext,
    turnId: string = `rt-${Date.now()}`
  ): Promise<{ ok: boolean; outputJson: string }> {
    const parsedArgs = parseToolArguments(toolCall.arguments);

    let outputPayload: Record<string, unknown>;
    let ok = false;
    let pendingHangUpReason: string | undefined;
    let shouldHangUp = false;

    try {
      if (toolCall.name === 'call_thinker_agent') {
        const res = await this.executeThinkerCall(parsedArgs, context, turnId);
        ok = res.ok;
        outputPayload = res.outputPayload;
      } else if (toolCall.name === 'cancel_thinker_agent') {
        const res = await this.executeCancelThinker(parsedArgs, context, turnId);
        ok = res.ok;
        outputPayload = res.outputPayload;
      } else if (toolCall.name === 'set_progress_updates') {
        const enabled = Boolean(parsedArgs.enabled);
        voiceSessionStore.setProgressUpdatesEnabled(enabled);
        ok = true;
        outputPayload = { ok: true, enabled };
      } else if (toolCall.name === 'hang_up') {
        pendingHangUpReason =
          typeof parsedArgs.reason === 'string' && parsedArgs.reason.trim()
            ? parsedArgs.reason.trim()
            : undefined;
        shouldHangUp = true;
        ok = true;
        outputPayload = {
          ok: true,
          hangingUp: true,
          ...(pendingHangUpReason ? { reason: pendingHangUpReason } : {}),
        };
      } else {
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
      }
    } catch (err: any) {
      outputPayload = {
        ok: false,
        error: err?.message || String(err),
      };
    }

    const outputJson = JSON.stringify(outputPayload);
    if (isTauriEnvironment()) {
      try {
        await invokeFlatCommand('voice_realtime_submit_tool_result', {
          callId: toolCall.callId,
          outputJson,
          toolName: toolCall.name,
        });
      } catch (err) {
        console.warn('[RealtimeVoiceBridge] voice_realtime_submit_tool_result failed:', err);
      }
    }

    if (shouldHangUp) {
      if (this.handlers.onHangUp) {
        this.handlers.onHangUp(pendingHangUpReason);
      } else {
        voiceSessionStore.stopSession();
      }
    }

    return { ok, outputJson };
  }

  public async truncateAssistantAudio(itemId: string, audioEndMs: number): Promise<void> {
    if (!isTauriEnvironment() || !itemId) return;
    try {
      await invokeFlatCommand('voice_realtime_truncate', {
        itemId,
        audioEndMs: Math.max(0, Math.round(audioEndMs)),
      });
    } catch (err) {
      console.warn('[RealtimeVoiceBridge] voice_realtime_truncate failed:', err);
    }
  }

  public async disconnect(): Promise<void> {
    this.connected = false;
    this.clearListeners();
    if (isTauriEnvironment()) {
      try {
        await invokeCommand('voice_realtime_disconnect');
      } catch (err) {
        console.warn('[RealtimeVoiceBridge] voice_realtime_disconnect failed:', err);
      }
    }
  }
}
