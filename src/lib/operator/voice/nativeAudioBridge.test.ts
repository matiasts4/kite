import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ipc from '../../ipc';
import {
  decodeWavBase64ToBlob,
  getCachedNativeAudioLevel,
  listNativeAudioInputDevices,
  markNativeSpeechStart,
  setCachedNativeAudioLevel,
  setNativeAudioMuted,
  startNativeAudioCapture,
  stopNativeAudioCapture,
} from './nativeAudioBridge';

vi.mock('../../ipc', async () => {
  const actual = await vi.importActual<typeof import('../../ipc')>('../../ipc');
  return {
    ...actual,
    invokeCommand: vi.fn(),
    invokeFlatCommand: vi.fn(),
    isTauriEnvironment: vi.fn(() => true),
  };
});

describe('nativeAudioBridge — Rust cpal WASAPI IPC Bridge (S5/T5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCachedNativeAudioLevel(0);
  });

  afterEach(() => {
    setCachedNativeAudioLevel(0);
  });

  it('lists native WASAPI input devices and starts/stops capture cleanly', async () => {
    vi.mocked(ipc.invokeCommand).mockResolvedValueOnce([
      {
        id: 'wasapi:Micrófono Studio',
        name: 'Micrófono Studio',
        isDefault: true,
        sampleRate: 48000,
        channels: 2,
      },
    ]);
    vi.mocked(ipc.invokeFlatCommand)
      .mockResolvedValueOnce({ ok: true, sampleRate: 16000 })
      .mockResolvedValueOnce({ ok: true, preRollSamples: 6400 })
      .mockResolvedValueOnce({ ok: true, muted: false })
      .mockResolvedValueOnce({
        ok: true,
        wavBytes: 48,
        wavBase64: btoa('RIFFxxxxWAVEfmt '),
        sttTranscript: 'abre dos terminales',
      });

    const devices = await listNativeAudioInputDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0].id).toBe('wasapi:Micrófono Studio');

    const startRes = await startNativeAudioCapture({
      deviceId: devices[0].id,
      sampleRate: 16000,
      keepExisting: true,
    });
    expect(startRes.ok).toBe(true);
    expect(await markNativeSpeechStart(400)).toBe(true);
    expect(await setNativeAudioMuted(false)).toBe(true);

    setCachedNativeAudioLevel(0.65);
    expect(getCachedNativeAudioLevel()).toBe(0.65);

    const stopRes = await stopNativeAudioCapture({ keepAlive: false, trimTrailingMs: 500 });
    expect(stopRes.ok).toBe(true);
    expect(stopRes.sttTranscript).toBe('abre dos terminales');
    expect(getCachedNativeAudioLevel()).toBe(0);

    const blob = decodeWavBase64ToBlob(stopRes.wavBase64 || '');
    expect(blob).not.toBeNull();
    expect(blob?.type).toBe('audio/wav');
  });

  it('returns clean fallback error outside Tauri runtime', async () => {
    vi.mocked(ipc.isTauriEnvironment).mockReturnValueOnce(false);
    const startRes = await startNativeAudioCapture();
    expect(startRes.ok).toBe(false);
    expect(startRes.error).toContain('unavailable');
  });
});
