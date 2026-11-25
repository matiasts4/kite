import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ipc from '../../ipc';
import {
  armBargeInMonitor,
  disarmBargeInMonitor,
  getCurrentAudioLevel,
  releaseOperatorCapture,
  setOperatorMicMuted,
  startOperatorListening,
  stopOperatorListening,
} from './zedVoice';
import { saveOperatorConfig } from '../operatorConfig';

const eventListeners = new Map<string, Array<(event: { payload: any }) => void>>();

vi.mock('../../ipc', async () => {
  const actual = await vi.importActual<typeof import('../../ipc')>('../../ipc');
  return {
    ...actual,
    invokeCommand: vi.fn(async () => ({})),
    invokeFlatCommand: vi.fn(async () => ({ ok: true })),
    proxyOperatorHttp: vi.fn(async () => ({
      success: true,
      status: 200,
      body: JSON.stringify({ text: 'abre dos terminales' }),
    })),
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
      const next = list.filter((fn) => fn !== handler);
      eventListeners.set(eventName, next);
    };
  }),
}));

vi.mock('./audioDucking', () => ({
  startAudioDucking: vi.fn(async () => {}),
  stopAudioDucking: vi.fn(async () => {}),
}));

function emitNativeEvent(eventName: string, payload: unknown): void {
  const handlers = eventListeners.get(eventName) || [];
  for (const h of handlers) {
    h({ payload });
  }
}

describe('zedVoice — Native Rust WASAPI Capture, Adaptive VAD, Barge-In & Streaming STT', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventListeners.clear();
    localStorage.clear();
    saveOperatorConfig({
      grokApiKey: 'xai-test-key',
      grokTranscriptionApiKey: 'xai-stt-key',
    });
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(),
      },
    });
  });

  afterEach(async () => {
    disarmBargeInMonitor();
    await releaseOperatorCapture();
    delete (window as any).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('detects speech via native RMS frames, marks Rust speech start, auto-endpoints on trailing silence, and transcribes WAV', async () => {
    vi.useFakeTimers();

    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'proxy_operator_http') {
        return {
          success: true,
          status: 200,
          body: JSON.stringify({ text: 'abre dos terminales' }),
        };
      }
      return {};
    });

    vi.mocked(ipc.invokeFlatCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'voice_audio_start_capture') {
        return { ok: true, sampleRate: 16000 };
      }
      if (cmd === 'voice_audio_mark_speech_start') {
        return { ok: true, preRollSamples: 6400 };
      }
      if (cmd === 'voice_audio_stop_capture') {
        const fakeWav = new Uint8Array(600).fill(1);
        fakeWav.set([0x52, 0x49, 0x46, 0x46], 0);
        let binary = '';
        for (let i = 0; i < fakeWav.length; i++) binary += String.fromCharCode(fakeWav[i]);
        return {
          ok: true,
          wavBytes: fakeWav.length,
          wavBase64: btoa(binary),
          sttTranscript: null,
        };
      }
      return { ok: true };
    });

    const onAudioLevel = vi.fn();
    const listenPromise = startOperatorListening({
      continuous: true,
      language: 'es-ES',
      onAudioLevel,
    });

    await vi.advanceTimersByTimeAsync(20);
    expect(ipc.invokeFlatCommand).toHaveBeenCalledWith(
      'voice_audio_start_capture',
      expect.objectContaining({ sampleRate: 16000, keepExisting: false })
    );

    // Ambient noise frames keep session quietly listening
    for (let i = 0; i < 4; i++) {
      emitNativeEvent('voice:audio-level', { level: 0.01, rms: 0.004, durationMs: 40 });
    }
    expect(ipc.invokeFlatCommand).not.toHaveBeenCalledWith(
      'voice_audio_mark_speech_start',
      expect.anything()
    );

    // Sustained voiced frames (>= 120ms) open native speech gate and reset silence timer
    for (let i = 0; i < 5; i++) {
      emitNativeEvent('voice:audio-level', { level: 0.5, rms: 0.14, durationMs: 40 });
      await vi.advanceTimersByTimeAsync(40);
    }
    expect(getCurrentAudioLevel()).toBeGreaterThan(0.1);
    expect(onAudioLevel).toHaveBeenCalled();
    expect(ipc.invokeFlatCommand).toHaveBeenCalledWith('voice_audio_mark_speech_start', {
      preRollMs: 400,
    });

    // Trailing silence closes the turn automatically and drives FileReader/fetch timers to completion
    for (let i = 0; i < 4; i++) {
      emitNativeEvent('voice:audio-level', { level: 0.01, rms: 0.003, durationMs: 40 });
    }
    await vi.advanceTimersByTimeAsync(1500);
    await vi.runAllTimersAsync();

    const transcript = await listenPromise;
    expect(transcript).toBe('abre dos terminales');
    expect(ipc.proxyOperatorHttp).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST' })
    );
    expect(ipc.invokeFlatCommand).toHaveBeenCalledWith(
      'voice_audio_stop_capture',
      expect.objectContaining({ keepAlive: true, discard: false })
    );
  });

  it('uses Rust sttTranscript directly when streaming WS succeeds and supports warm native barge-in', async () => {
    vi.useFakeTimers();

    vi.mocked(ipc.invokeFlatCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'voice_audio_start_capture') return { ok: true, sampleRate: 16000 };
      if (cmd === 'voice_audio_mark_speech_start') return { ok: true, preRollSamples: 6400 };
      if (cmd === 'voice_audio_stop_capture') {
        return {
          ok: true,
          wavBytes: 0,
          sttTranscript: 'revisa los cambios',
        };
      }
      return { ok: true };
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onInterim = vi.fn();

    const listenPromise = startOperatorListening({
      continuous: true,
      language: 'es-ES',
      onInterim,
    });
    await vi.advanceTimersByTimeAsync(10);

    emitNativeEvent('voice:stt-partial', { kind: 'partial', text: 'revisa los cambios' });
    expect(onInterim).toHaveBeenCalledWith('revisa los cambios');

    await vi.advanceTimersByTimeAsync(1300);
    const result = await listenPromise;
    expect(result).toBe('revisa los cambios');
    expect(fetchSpy).not.toHaveBeenCalled();

    // Warm stream stays active across TTS playback so acoustic barge-in arms successfully
    const onBargeIn = vi.fn();
    expect(armBargeInMonitor(onBargeIn)).toBe(true);

    // Advance past 250ms attack guard, then emit sustained speech RMS above floor
    await vi.advanceTimersByTimeAsync(300);
    for (let i = 0; i < 6; i++) {
      emitNativeEvent('voice:audio-level', { level: 0.85, rms: 0.25, durationMs: 50 });
    }
    expect(onBargeIn).toHaveBeenCalledTimes(1);
  });

  it('propagates mute state to Rust native capture and ignores RMS while muted', async () => {
    vi.useFakeTimers();
    vi.mocked(ipc.invokeFlatCommand).mockResolvedValue({ ok: true, sampleRate: 16000 });

    const listenPromise = startOperatorListening({ continuous: true, language: 'es-ES' });
    await vi.advanceTimersByTimeAsync(10);

    setOperatorMicMuted(true);
    expect(ipc.invokeFlatCommand).toHaveBeenCalledWith('voice_audio_set_muted', { muted: true });

    for (let i = 0; i < 6; i++) {
      emitNativeEvent('voice:audio-level', { level: 0.9, rms: 0.3, durationMs: 50 });
    }
    expect(ipc.invokeFlatCommand).not.toHaveBeenCalledWith(
      'voice_audio_mark_speech_start',
      expect.anything()
    );

    const aborted = await stopOperatorListening({ discard: true });
    expect(aborted).toBe('');
    await expect(listenPromise).resolves.toBe('');
  });

  it('hydrates Grok STT key from native SQLite Vault when missing in localStorage', async () => {
    vi.useFakeTimers();
    localStorage.clear();
    (window as any).__TAURI_INTERNALS__ = {};

    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'get_active_provider_key' && args?.provider === 'grok_transcription') {
        return { success: true, key: 'xai-vault-stt-key' };
      }
      if (cmd === 'get_active_provider_key') {
        return { success: true, key: null };
      }
      return {};
    });

    vi.mocked(ipc.invokeFlatCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'voice_audio_start_capture') return { ok: true, sampleRate: 16000 };
      if (cmd === 'voice_audio_stop_capture') return { ok: true, wavBytes: 0, sttTranscript: null };
      return { ok: true };
    });

    const listenPromise = startOperatorListening({ continuous: true, language: 'es-ES' });
    await vi.advanceTimersByTimeAsync(20);

    expect(ipc.invokeCommand).toHaveBeenCalledWith('get_active_provider_key', {
      provider: 'grok_transcription',
    });
    expect(ipc.invokeFlatCommand).toHaveBeenCalledWith(
      'voice_audio_start_capture',
      expect.objectContaining({
        sampleRate: 16000,
        sttApiKey: 'xai-vault-stt-key',
        sttBaseUrl: 'https://api.x.ai/v1',
        sttLanguage: 'es-ES',
      })
    );

    const aborted = await stopOperatorListening({ discard: true });
    expect(aborted).toBe('');
    await expect(listenPromise).resolves.toBe('');
  });

  it('logs voice:stt-error without aborting the session and completes via HTTP WAV fallback', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.mocked(ipc.invokeFlatCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'voice_audio_start_capture') return { ok: true, sampleRate: 16000 };
      if (cmd === 'voice_audio_mark_speech_start') return { ok: true, preRollSamples: 6400 };
      if (cmd === 'voice_audio_stop_capture') {
        const fakeWav = new Uint8Array(600).fill(1);
        fakeWav.set([0x52, 0x49, 0x46, 0x46], 0);
        let binary = '';
        for (let i = 0; i < fakeWav.length; i++) binary += String.fromCharCode(fakeWav[i]);
        return {
          ok: true,
          wavBytes: fakeWav.length,
          wavBase64: btoa(binary),
          sttTranscript: null,
        };
      }
      return { ok: true };
    });

    const listenPromise = startOperatorListening({ continuous: true, language: 'es-ES' });
    await vi.advanceTimersByTimeAsync(20);

    emitNativeEvent('voice:stt-error', {
      error: 'STT WebSocket handshake failed',
      backend: 'rust-ws',
    });
    expect(warnSpy).toHaveBeenCalledWith(
      '[ArgosVoice] Native Rust streaming STT error:',
      'STT WebSocket handshake failed'
    );

    for (let i = 0; i < 5; i++) {
      emitNativeEvent('voice:audio-level', { level: 0.5, rms: 0.14, durationMs: 40 });
      await vi.advanceTimersByTimeAsync(40);
    }
    for (let i = 0; i < 4; i++) {
      emitNativeEvent('voice:audio-level', { level: 0.01, rms: 0.003, durationMs: 40 });
    }
    await vi.advanceTimersByTimeAsync(1500);
    await vi.runAllTimersAsync();

    await expect(listenPromise).resolves.toBe('abre dos terminales');
    expect(ipc.proxyOperatorHttp).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST' })
    );
  });
});
