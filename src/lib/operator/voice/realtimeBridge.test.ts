import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ipc from '../../ipc';
import * as executor from '../executor';
import { RealtimeVoiceBridge } from './realtimeBridge';
import { voiceSessionStore } from './voiceSessionStore';

const eventListeners = new Map<string, Array<(event: { payload: any }) => void>>();

vi.mock('../../ipc', async () => {
  const actual = await vi.importActual<typeof import('../../ipc')>('../../ipc');
  return {
    ...actual,
    invokeCommand: vi.fn(async () => ({})),
    invokeFlatCommand: vi.fn(async () => ({ ok: true })),
    isTauriEnvironment: vi.fn(() => true),
  };
});

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (eventName: string, handler: (event: { payload: any }) => void) => {
    const existing = eventListeners.get(eventName) || [];
    existing.push(handler);
    eventListeners.set(eventName, existing);
    return () => {
      const list = eventListeners.get(eventName) || [];
      eventListeners.set(
        eventName,
        list.filter((fn) => fn !== handler)
      );
    };
  }),
}));

function emitNativeEvent(eventName: string, payload: unknown): void {
  const handlers = eventListeners.get(eventName) || [];
  for (const handler of [...handlers]) {
    handler({ payload });
  }
}

describe('RealtimeVoiceBridge — Multi-Provider S2S, Talker↔Thinker Bridge & VoiceSessionStore (S2/S5/S6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventListeners.clear();
    vi.mocked(ipc.isTauriEnvironment).mockReturnValue(true);
    vi.mocked(ipc.invokeCommand).mockResolvedValue({});
    vi.mocked(ipc.invokeFlatCommand).mockResolvedValue({ ok: true });
    voiceSessionStore.stopSession();
    voiceSessionStore.setVoiceError(null);
    voiceSessionStore.setInactivityNotice(null);
  });

  afterEach(() => {
    voiceSessionStore.stopSession();
    voiceSessionStore.setVoiceError(null);
    voiceSessionStore.setInactivityNotice(null);
    vi.restoreAllMocks();
  });

  it('automatically downgrades to cascaded mode when realtime credentials are missing or proxy rejects', async () => {
    vi.mocked(ipc.invokeFlatCommand).mockResolvedValueOnce({
      ok: false,
      fallbackToCascaded: true,
      reason: 'missing_credentials',
    });

    const onFallback = vi.fn();
    const bridge = new RealtimeVoiceBridge({ onTransportFallback: onFallback });
    const res = await bridge.connect({ voice: 'Ara', endpoint: 'wss://api.x.ai/v1/realtime' });

    expect(res.activeTransport).toBe('cascaded');
    expect(res.fallbackReason).toBe('missing_credentials');
    expect(onFallback).toHaveBeenCalledWith('cascaded', 'missing_credentials');
  });

  it('connects with multi-provider options, exposes Talker↔Thinker schemas, and warns on IPC rejection', async () => {
    vi.mocked(ipc.invokeFlatCommand).mockResolvedValueOnce({
      ok: true,
      connected: true,
      provider: 'gemini_live',
      inputSampleRate: 16000,
      endpoint: 'wss://generativelanguage.googleapis.com/ws/mock',
    });

    const bridge = new RealtimeVoiceBridge();
    const conn = await bridge.connect({
      provider: 'gemini_live',
      apiKey: 'AIza-unit-test',
      model: 'models/gemini-2.5-flash-native-audio-preview-09-2025',
      voice: 'Aoede',
    });

    expect(conn).toEqual({
      activeTransport: 'realtime',
      provider: 'gemini_live',
      inputSampleRate: 16000,
      endpoint: 'wss://generativelanguage.googleapis.com/ws/mock',
    });
    expect(bridge.isConnected()).toBe(true);

    const connectCall = vi.mocked(ipc.invokeFlatCommand).mock.calls[0];
    expect(connectCall[0]).toBe('voice_realtime_connect');
    const connectPayload = connectCall[1] as Record<string, any>;
    expect(connectPayload.provider).toBe('gemini_live');
    expect(connectPayload.apiKey).toBe('AIza-unit-test');
    expect(connectPayload.model).toBe('models/gemini-2.5-flash-native-audio-preview-09-2025');

    const toolNames = (connectPayload.tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).toContain('peek_changes');
    expect(toolNames).toContain('call_thinker_agent');
    expect(toolNames).toContain('cancel_thinker_agent');
    expect(toolNames).toContain('set_progress_updates');
    expect(toolNames).toContain('hang_up');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onFallback = vi.fn();
    const errBridge = new RealtimeVoiceBridge({ onTransportFallback: onFallback });
    vi.mocked(ipc.invokeFlatCommand).mockRejectedValueOnce(new Error('socket_boom'));

    const errRes = await errBridge.connect({ provider: 'openai' });
    expect(errRes).toEqual({ activeTransport: 'cascaded', fallbackReason: 'socket_boom' });
    expect(onFallback).toHaveBeenCalledWith('cascaded', 'socket_boom');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('forwards setMuted IPC only when connected inside Tauri and handles errors cleanly', async () => {
    const bridge = new RealtimeVoiceBridge();

    // Disconnected -> returns false without invoking IPC
    await expect(bridge.setMuted(true)).resolves.toBe(false);
    expect(ipc.invokeFlatCommand).not.toHaveBeenCalled();

    // Connect first
    vi.mocked(ipc.invokeFlatCommand).mockResolvedValueOnce({ ok: true, connected: true });
    await bridge.connect({ provider: 'xai' });

    vi.mocked(ipc.invokeFlatCommand).mockResolvedValueOnce({ ok: true, muted: true, flushedMs: 500 });
    await expect(bridge.setMuted(true)).resolves.toBe(true);
    expect(ipc.invokeFlatCommand).toHaveBeenCalledWith('voice_realtime_set_muted', { muted: true });

    // Rejection warns and returns false
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(ipc.invokeFlatCommand).mockRejectedValueOnce(new Error('mute_ipc_fail'));
    await expect(bridge.setMuted(false)).resolves.toBe(false);
    expect(warnSpy).toHaveBeenCalled();

    // Outside Tauri -> returns false
    vi.mocked(ipc.isTauriEnvironment).mockReturnValue(false);
    await expect(bridge.setMuted(true)).resolves.toBe(false);
  });

  it('subscribes to clear-audio, user-speech, audio-delta, transcript, status, and tool-call events and cleans up on disconnect', async () => {
    const onClearAudio = vi.fn();
    const onUserSpeech = vi.fn();
    const onAudioDelta = vi.fn();
    const onTranscript = vi.fn();
    const onStatusError = vi.fn();

    const bridge = new RealtimeVoiceBridge({
      onClearAudio,
      onUserSpeech,
      onAudioDelta,
      onTranscript,
      onStatusError,
    });

    await bridge.subscribeEvents(() => ({ workspaceId: 'ws-1', mode: 'thread' }));

    emitNativeEvent('voice:realtime-clear-audio', { reason: 'interrupted' });
    expect(onClearAudio).toHaveBeenCalledTimes(1);

    emitNativeEvent('voice:realtime-user-speech', { text: 'hola argos', interim: true });
    emitNativeEvent('voice:realtime-user-speech', { text: 'hola argos abre tests', interim: false });
    expect(onUserSpeech).toHaveBeenNthCalledWith(1, { text: 'hola argos', interim: true });
    expect(onUserSpeech).toHaveBeenNthCalledWith(2, { text: 'hola argos abre tests', interim: false });

    emitNativeEvent('voice:realtime-audio-delta', { delta: 'AQID', sampleRate: 24000 });
    expect(onAudioDelta).toHaveBeenCalledWith('AQID', 24000);

    emitNativeEvent('voice:realtime-transcript', {
      type: 'response.audio_transcript.delta',
      delta: 'Revisando.',
    });
    expect(onTranscript).toHaveBeenCalledWith({
      type: 'response.audio_transcript.delta',
      delta: 'Revisando.',
    });

    emitNativeEvent('voice:realtime-status', { ok: true, setupComplete: true });
    expect(onStatusError).not.toHaveBeenCalled();

    emitNativeEvent('voice:realtime-status', { ok: false, error: 'quota_exceeded' });
    expect(onStatusError).toHaveBeenCalledWith('quota_exceeded');

    // Gemini-shaped tool-call payload (`id` + `args`)
    emitNativeEvent('voice:realtime-tool-call', {
      id: 'gem-call-1',
      name: 'set_progress_updates',
      args: { enabled: false },
    });
    await vi.waitFor(() => {
      expect(voiceSessionStore.getSnapshot().progressUpdatesEnabled).toBe(false);
    });
    expect(ipc.invokeFlatCommand).toHaveBeenCalledWith(
      'voice_realtime_submit_tool_result',
      expect.objectContaining({
        callId: 'gem-call-1',
        outputJson: JSON.stringify({ ok: true, enabled: false }),
      })
    );

    await bridge.disconnect();
    expect(bridge.isConnected()).toBe(false);
    expect(ipc.invokeCommand).toHaveBeenCalledWith('voice_realtime_disconnect');
    for (const handlers of eventListeners.values()) {
      expect(handlers).toHaveLength(0);
    }
  });

  it('forwards realtime function-call events into executePlan() and submits structured tool output', async () => {
    vi.mocked(ipc.invokeFlatCommand)
      .mockResolvedValueOnce({ ok: true, connected: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });

    const execSpy = vi.spyOn(executor, 'executePlan').mockResolvedValueOnce({
      overallSuccess: true,
      reply: 'No hay cambios pendientes.',
      receipts: [
        {
          actionIdx: 0,
          type: 'peek_changes',
          ok: true,
          summaryEs: 'Sin cambios sin commitear.',
          data: { branch: 'feat/response-thread' },
        },
      ],
    });

    const bridge = new RealtimeVoiceBridge();
    const conn = await bridge.connect({ voice: 'Ara' });
    expect(conn.activeTransport).toBe('realtime');

    const handled = await bridge.handleToolCallEvent(
      {
        callId: 'call-123',
        name: 'peek_changes',
        arguments: { includeDiff: false },
      },
      { workspaceId: 'ws-kite', mode: 'thread' }
    );

    expect(handled.ok).toBe(true);
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(ipc.invokeFlatCommand).toHaveBeenCalledWith(
      'voice_realtime_submit_tool_result',
      expect.objectContaining({
        callId: 'call-123',
        outputJson: expect.stringContaining('Sin cambios sin commitear'),
      })
    );

    await bridge.truncateAssistantAudio('item-99', 1420);
    expect(ipc.invokeFlatCommand).toHaveBeenCalledWith('voice_realtime_truncate', {
      itemId: 'item-99',
      audioEndMs: 1420,
    });
  });

  it('handles call_thinker_agent (subagent, thread, agent), cancel_thinker_agent, set_progress_updates, and hang_up tools', async () => {
    const execSpy = vi.spyOn(executor, 'executePlan').mockResolvedValue({
      overallSuccess: true,
      reply: 'Subagente despachado.',
      receipts: [
        {
          actionIdx: 0,
          type: 'spawn_subagent',
          ok: true,
          summaryEs: 'Subagente despachado.',
        },
      ],
    });

    const onHangUp = vi.fn();
    const bridge = new RealtimeVoiceBridge({ onHangUp });
    const ctx = { workspaceId: 'ws-kite', boundThreadId: 'thr-9', mode: 'thread' };

    // 1a. call_thinker_agent -> default subagent
    const subRes = await bridge.handleToolCallEvent(
      {
        callId: 'ct-1',
        name: 'call_thinker_agent',
        arguments: {
          task: 'Run unit tests in voice module',
          role: 'QA Runner',
          provider: 'claude',
          oddMode: true,
        },
      },
      ctx
    );
    expect(subRes.ok).toBe(true);
    expect(JSON.parse(subRes.outputJson)).toMatchObject({
      ok: true,
      status: 'dispatched',
      reply: 'Subagente despachado.',
    });
    expect(execSpy).toHaveBeenNthCalledWith(
      1,
      {
        strategy: 'llm',
        actions: [
          expect.objectContaining({
            type: 'spawn_subagent',
            via: 'thread',
            task: 'Run unit tests in voice module',
            role: 'QA Runner',
            provider: 'claude',
            oddMode: true,
          }),
        ],
      },
      ctx,
      expect.any(String)
    );

    // 1b. call_thinker_agent -> thread
    await bridge.handleToolCallEvent(
      {
        callId: 'ct-2',
        name: 'call_thinker_agent',
        arguments: {
          task: 'Audit CSS tokens',
          targetKind: 'thread',
          provider: 'codex',
        },
      },
      ctx
    );
    expect(execSpy).toHaveBeenNthCalledWith(
      2,
      {
        strategy: 'llm',
        actions: [
          expect.objectContaining({
            type: 'launch_thread',
            body: 'Audit CSS tokens',
            provider: 'codex',
          }),
        ],
      },
      ctx,
      expect.any(String)
    );

    // 1c. call_thinker_agent -> agent
    await bridge.handleToolCallEvent(
      {
        callId: 'ct-3',
        name: 'call_thinker_agent',
        arguments: {
          task: 'Prepare release notes',
          targetKind: 'agent',
          role: 'Release Bot',
        },
      },
      ctx
    );
    expect(execSpy).toHaveBeenNthCalledWith(
      3,
      {
        strategy: 'llm',
        actions: [
          expect.objectContaining({
            type: 'launch_agent',
            body: 'Prepare release notes',
            agentQuery: 'Release Bot',
          }),
        ],
      },
      ctx,
      expect.any(String)
    );

    // 1d. call_thinker_agent -> empty task fails cleanly without calling executePlan
    const emptyTaskRes = await bridge.handleToolCallEvent(
      {
        callId: 'ct-empty',
        name: 'call_thinker_agent',
        arguments: { task: '   ' },
      },
      ctx
    );
    expect(emptyTaskRes.ok).toBe(false);
    expect(JSON.parse(emptyTaskRes.outputJson).error).toMatch(/non-empty task/i);
    expect(execSpy).toHaveBeenCalledTimes(3);

    // 2. cancel_thinker_agent (named target & omitted default target = 1)
    const cancelRes = await bridge.handleToolCallEvent(
      {
        callId: 'cancel-1',
        name: 'cancel_thinker_agent',
        arguments: { target: 'QA Runner' },
      },
      ctx
    );
    expect(cancelRes.ok).toBe(true);
    expect(execSpy).toHaveBeenNthCalledWith(
      4,
      {
        strategy: 'llm',
        actions: [
          {
            type: 'control_subagent',
            operation: 'cancel',
            target: 'QA Runner',
          },
        ],
      },
      ctx,
      expect.any(String)
    );

    await bridge.handleToolCallEvent(
      {
        callId: 'cancel-2',
        name: 'cancel_thinker_agent',
        arguments: {},
      },
      ctx
    );
    expect(execSpy).toHaveBeenNthCalledWith(
      5,
      {
        strategy: 'llm',
        actions: [
          {
            type: 'control_subagent',
            operation: 'cancel',
            target: 1,
          },
        ],
      },
      ctx,
      expect.any(String)
    );

    // 3. set_progress_updates
    const progressOff = await bridge.handleToolCallEvent(
      {
        callId: 'prog-1',
        name: 'set_progress_updates',
        arguments: { enabled: false },
      },
      ctx
    );
    expect(progressOff.ok).toBe(true);
    expect(JSON.parse(progressOff.outputJson)).toEqual({ ok: true, enabled: false });
    expect(voiceSessionStore.getSnapshot().progressUpdatesEnabled).toBe(false);

    const progressOn = await bridge.handleToolCallEvent(
      {
        callId: 'prog-2',
        name: 'set_progress_updates',
        arguments: { enabled: true },
      },
      ctx
    );
    expect(progressOn.ok).toBe(true);
    expect(voiceSessionStore.getSnapshot().progressUpdatesEnabled).toBe(true);

    // 4a. hang_up with handler
    const hangRes = await bridge.handleToolCallEvent(
      {
        callId: 'hang-1',
        name: 'hang_up',
        arguments: { reason: 'user_said_goodbye' },
      },
      ctx
    );
    expect(hangRes.ok).toBe(true);
    expect(JSON.parse(hangRes.outputJson)).toMatchObject({ ok: true, hangingUp: true });
    expect(onHangUp).toHaveBeenCalledWith('user_said_goodbye');

    // 4b. hang_up without handler stops active voiceSessionStore session
    voiceSessionStore.startSession('thr-9', 'thread');
    expect(voiceSessionStore.getSnapshot().phase).toBe('active');
    const bareBridge = new RealtimeVoiceBridge();
    const hangDefaultRes = await bareBridge.handleToolCallEvent(
      { callId: 'hang-2', name: 'hang_up', arguments: {} },
      ctx
    );
    expect(hangDefaultRes.ok).toBe(true);
    expect(voiceSessionStore.getSnapshot().phase).toBe('inactive');
  });

  it('accumulates incremental user deltas in VoiceSessionStore and forwards explicit delta flags from subscribeEvents', async () => {
    voiceSessionStore.startSession('thr-delta-1', 'thread');

    const acc1 = voiceSessionStore.upsertLiveTeleprompterUser('Hola ', true, { seq: 11, append: true });
    const acc2 = voiceSessionStore.upsertLiveTeleprompterUser('mundo', true, { seq: 11, append: true });
    expect(acc1).toBe('Hola');
    expect(acc2).toBe('Hola mundo');
    const linesAfterDelta = voiceSessionStore.getSnapshot().liveTeleprompterLines ?? [];
    expect(linesAfterDelta[linesAfterDelta.length - 1]?.text).toBe('Hola mundo');

    // Non-append cumulative snapshot replaces the same seq cleanly
    const replaced = voiceSessionStore.upsertLiveTeleprompterUser('Hola mundo final', false, {
      seq: 11,
      append: false,
    });
    expect(replaced).toBe('Hola mundo final');
    const linesAfterReplace = voiceSessionStore.getSnapshot().liveTeleprompterLines ?? [];
    expect(linesAfterReplace[linesAfterReplace.length - 1]).toMatchObject({
      seq: 11,
      text: 'Hola mundo final',
      interim: false,
    });

    const onUserSpeech = vi.fn();
    const bridge = new RealtimeVoiceBridge({ onUserSpeech });
    await bridge.subscribeEvents(() => ({ workspaceId: 'ws-1', mode: 'thread' }));

    emitNativeEvent('voice:realtime-user-speech', { text: 'Abre ', interim: true, delta: true });
    emitNativeEvent('voice:realtime-user-speech', {
      text: 'Abre el panel',
      interim: true,
      delta: false,
    });

    expect(onUserSpeech).toHaveBeenNthCalledWith(1, { text: 'Abre ', interim: true, delta: true });
    expect(onUserSpeech).toHaveBeenNthCalledWith(2, {
      text: 'Abre el panel',
      interim: true,
      delta: false,
    });

    await bridge.disconnect();
  });

  it('manages VoiceSessionStore transport, speaker level, teleprompter karaoke spans, barge-in freeze, and inactivity notice lifecycle', () => {
    voiceSessionStore.setVoiceError({
      message: 'Permiso de micrófono denegado',
      at: 1000,
      retryable: true,
      openPrivacySettings: true,
    });
    voiceSessionStore.setInactivityNotice('Sesión pausada por inactividad para cuidar tu cuota');

    // startSession stamps startedAt and clears stale error / inactivity notice / lines
    voiceSessionStore.startSession('thr-voice', 'thread');
    const started = voiceSessionStore.getSnapshot();
    expect(started.phase).toBe('active');
    expect(typeof started.startedAt).toBe('number');
    expect(started.voiceError).toBeNull();
    expect(started.inactivityNotice).toBeNull();
    expect(started.liveTeleprompterLines).toEqual([]);
    expect(started.progressUpdatesEnabled).toBe(true);
    expect(started.speakerAudioLevel).toBe(0);

    // setActiveTransport & setSpeakerAudioLevel
    voiceSessionStore.setActiveTransport('realtime', 'gemini_live');
    voiceSessionStore.setSpeakerAudioLevel(1.4);
    expect(voiceSessionStore.getSnapshot().activeTransport).toBe('realtime');
    expect(voiceSessionStore.getSnapshot().activeRealtimeProvider).toBe('gemini_live');
    expect(voiceSessionStore.getSnapshot().speakerAudioLevel).toBe(1);

    voiceSessionStore.setSpeakerAudioLevel(-0.5);
    expect(voiceSessionStore.getSnapshot().speakerAudioLevel).toBe(0);

    voiceSessionStore.setActiveTransport('cascaded');
    expect(voiceSessionStore.getSnapshot().activeTransport).toBe('cascaded');
    expect(voiceSessionStore.getSnapshot().activeRealtimeProvider).toBeUndefined();

    // upsertLiveTeleprompterUser: monotonic seq, updates matching seq or active interim, preserves non-empty text
    voiceSessionStore.upsertLiveTeleprompterUser('  hola  ', true);
    voiceSessionStore.upsertLiveTeleprompterUser('hola argos', true);
    voiceSessionStore.upsertLiveTeleprompterUser('   ', false);
    let lines = voiceSessionStore.getSnapshot().liveTeleprompterLines || [];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: 'user',
      text: 'hola argos',
      interim: false,
    });

    voiceSessionStore.upsertLiveTeleprompterUser('revisar archivo', true, 10);
    voiceSessionStore.upsertLiveTeleprompterUser('revisar archivo auth', false, 10);
    lines = voiceSessionStore.getSnapshot().liveTeleprompterLines || [];
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({
      seq: 10,
      kind: 'user',
      text: 'revisar archivo auth',
      interim: false,
    });

    // appendLiveTeleprompterVoice + replace + recordLiveVoiceAudioSpan + freezeLiveVoiceSpokenChars
    voiceSessionStore.appendLiveTeleprompterVoice('Borrador temporal');
    voiceSessionStore.appendLiveTeleprompterVoice('Primera parte', { replace: true });
    voiceSessionStore.appendLiveTeleprompterVoice(' segunda parte completa', {
      talkerDuration: 4,
    });
    voiceSessionStore.recordLiveVoiceAudioSpan(10, 12, 1);

    lines = voiceSessionStore.getSnapshot().liveTeleprompterLines || [];
    const voiceLine = lines[2];
    expect(voiceLine.kind).toBe('voice');
    expect(voiceLine.text).toBe('Primera parte segunda parte completa');
    expect(voiceLine.utteranceStart).toBe(10);
    expect(voiceLine.utteranceEnd).toBe(12);
    expect(voiceLine.audioSpans).toEqual([{ startAt: 10, endAt: 12, talkerDur: 2 }]);

    // Freeze at half of talkerDuration (12s -> 2/4 = 0.5 of 36 chars = 18 chars)
    voiceSessionStore.freezeLiveVoiceSpokenChars(12);
    lines = voiceSessionStore.getSnapshot().liveTeleprompterLines || [];
    expect(lines[2].spokenChars).toBe(Math.round(0.5 * voiceLine.text.length));

    // Late audio span must not mutate frozen voice line
    voiceSessionStore.recordLiveVoiceAudioSpan(12, 14, 1);
    lines = voiceSessionStore.getSnapshot().liveTeleprompterLines || [];
    expect(lines[2].audioSpans).toEqual([{ startAt: 10, endAt: 12, talkerDur: 2 }]);

    // Inactivity notice set before stopSession survives stopSession for UI banner visibility
    voiceSessionStore.setInactivityNotice('Sesión pausada por inactividad para cuidar tu cuota');
    voiceSessionStore.stopSession();
    const stopped = voiceSessionStore.getSnapshot();
    expect(stopped.phase).toBe('inactive');
    expect(stopped.startedAt).toBeUndefined();
    expect(stopped.activeTransport).toBeUndefined();
    expect(stopped.activeRealtimeProvider).toBeUndefined();
    expect(stopped.speakerAudioLevel).toBe(0);
    expect(stopped.liveTeleprompterLines).toEqual([]);
    expect(stopped.progressUpdatesEnabled).toBe(true);
    expect(stopped.inactivityNotice).toBe('Sesión pausada por inactividad para cuidar tu cuota');

    // Explicit clear works cleanly
    voiceSessionStore.setInactivityNotice(null);
    expect(voiceSessionStore.getSnapshot().inactivityNotice).toBeNull();
  });
});
