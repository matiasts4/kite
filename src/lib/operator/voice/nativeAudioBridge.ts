// Kite Code — Native Rust Audio Capture Bridge (`voice_audio` IPC)
// Prefers native cpal WASAPI capture when running inside Tauri, falling back cleanly
// to WebView2 AudioWorklet in browser previews or unit tests.

import { invokeCommand, invokeFlatCommand, isTauriEnvironment } from '../../ipc';

export interface NativeAudioDeviceInfo {
  id: string;
  name: string;
  isDefault: boolean;
  sampleRate: number;
  channels: number;
}

export interface NativeCaptureStartResult {
  ok: boolean;
  sampleRate?: number;
  error?: string;
}

export interface NativeCaptureStopResult {
  ok: boolean;
  wavBytes: number;
  wavBase64?: string;
  sttTranscript?: string | null;
  error?: string;
}

export interface NativeCaptureSnapshotResult {
  ok: boolean;
  wavBytes: number;
  wavBase64?: string;
  error?: string;
}

export interface NativeCaptureStatusSnapshot {
  active: boolean;
  deviceName?: string | null;
  sampleRate: number;
  bufferedSamples: number;
  level: number;
  privacy?: {
    available: boolean;
    accessDenied: boolean;
    hresultHex?: string | null;
    messageEs?: string;
  };
}

let cachedNativeLevel = 0;

export function getCachedNativeAudioLevel(): number {
  return cachedNativeLevel;
}

export function setCachedNativeAudioLevel(level: number): void {
  cachedNativeLevel = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
}

export function isNativeRustAudioSupported(): boolean {
  return isTauriEnvironment();
}

export async function listNativeAudioInputDevices(): Promise<NativeAudioDeviceInfo[]> {
  if (!isNativeRustAudioSupported()) return [];
  try {
    const devices = await invokeCommand<NativeAudioDeviceInfo[]>('voice_audio_list_devices');
    return Array.isArray(devices) ? devices : [];
  } catch {
    return [];
  }
}

export async function startNativeAudioCapture(options?: {
  deviceId?: string | null;
  sampleRate?: 16000 | 24000;
  keepExisting?: boolean;
  fromBargeIn?: boolean;
  sttApiKey?: string;
  sttBaseUrl?: string;
  sttLanguage?: string;
}): Promise<NativeCaptureStartResult> {
  if (!isNativeRustAudioSupported()) {
    return { ok: false, error: 'Native audio unavailable outside Tauri runtime' };
  }
  try {
    const res = await invokeFlatCommand<NativeCaptureStartResult>('voice_audio_start_capture', {
      deviceId: options?.deviceId ?? null,
      sampleRate: options?.sampleRate ?? 16000,
      keepExisting: options?.keepExisting ?? false,
      fromBargeIn: options?.fromBargeIn ?? false,
      sttApiKey: options?.sttApiKey ?? null,
      sttBaseUrl: options?.sttBaseUrl ?? null,
      sttLanguage: options?.sttLanguage ?? null,
    });
    return res ?? { ok: false, error: 'Empty response from voice_audio_start_capture' };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function markNativeSpeechStart(preRollMs: number = 400): Promise<boolean> {
  if (!isNativeRustAudioSupported()) return false;
  try {
    const res = await invokeFlatCommand<{ ok?: boolean }>('voice_audio_mark_speech_start', {
      preRollMs,
    });
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

export async function setNativeAudioMuted(muted: boolean): Promise<boolean> {
  if (!isNativeRustAudioSupported()) return false;
  try {
    const res = await invokeFlatCommand<{ ok?: boolean }>('voice_audio_set_muted', { muted });
    if (muted) cachedNativeLevel = 0;
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

export async function stopNativeAudioCapture(options?: {
  keepAlive?: boolean;
  discard?: boolean;
  trimTrailingMs?: number;
}): Promise<NativeCaptureStopResult> {
  if (!isNativeRustAudioSupported()) {
    return { ok: false, wavBytes: 0 };
  }
  try {
    const res = await invokeFlatCommand<NativeCaptureStopResult>('voice_audio_stop_capture', {
      keepAlive: options?.keepAlive ?? false,
      discard: options?.discard ?? false,
      trimTrailingMs: options?.trimTrailingMs ?? 0,
    });
    if (!options?.keepAlive) {
      cachedNativeLevel = 0;
    }
    return res ?? { ok: false, wavBytes: 0 };
  } catch (err: any) {
    if (!options?.keepAlive) {
      cachedNativeLevel = 0;
    }
    return { ok: false, wavBytes: 0, error: err?.message || String(err) };
  }
}

export async function snapshotNativeAudioWav(
  minMs: number = 500
): Promise<NativeCaptureSnapshotResult> {
  if (!isNativeRustAudioSupported()) {
    return { ok: false, wavBytes: 0, error: 'Native audio unavailable outside Tauri runtime' };
  }
  try {
    const res = await invokeFlatCommand<NativeCaptureSnapshotResult>('voice_audio_snapshot_wav', {
      minMs,
    });
    return res ?? { ok: false, wavBytes: 0 };
  } catch (err: any) {
    return { ok: false, wavBytes: 0, error: err?.message || String(err) };
  }
}

export async function getNativeAudioStatus(): Promise<NativeCaptureStatusSnapshot | null> {
  if (!isNativeRustAudioSupported()) return null;
  try {
    return await invokeCommand<NativeCaptureStatusSnapshot>('voice_audio_status');
  } catch {
    return null;
  }
}

export function decodeWavBase64ToBlob(wavBase64: string): Blob | null {
  const clean = (wavBase64 || '').trim();
  if (!clean) return null;
  try {
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return new Blob([bytes], { type: 'audio/wav' });
  } catch {
    return null;
  }
}

export async function subscribeNativeAudioEvents(handlers: {
  onAudioLevel?: (level: number, rms: number, durationMs: number) => void;
  onSttPartial?: (text: string) => void;
  onSttFinal?: (text: string) => void;
  onSttError?: (error: string) => void;
  onDeviceLost?: (error: string) => void;
}): Promise<() => void> {
  if (!isNativeRustAudioSupported()) {
    return () => {};
  }
  try {
    const eventMod = await import('@tauri-apps/api/event');
    if (typeof eventMod?.listen !== 'function') return () => {};
    const unlisteners: Array<() => void> = [];

    if (handlers.onAudioLevel) {
      unlisteners.push(
        await eventMod.listen<{ level?: number; rms?: number; durationMs?: number }>(
          'voice:audio-level',
          (ev) => {
            const level = ev?.payload?.level ?? 0;
            const durationMs = ev?.payload?.durationMs ?? 33;
            setCachedNativeAudioLevel(level);
            handlers.onAudioLevel?.(level, ev?.payload?.rms ?? 0, durationMs);
          }
        )
      );
    }
    if (handlers.onSttPartial) {
      unlisteners.push(
        await eventMod.listen<{ text?: string }>('voice:stt-partial', (ev) => {
          if (ev?.payload?.text) handlers.onSttPartial?.(ev.payload.text);
        })
      );
    }
    if (handlers.onSttFinal) {
      unlisteners.push(
        await eventMod.listen<{ text?: string }>('voice:stt-final', (ev) => {
          if (ev?.payload?.text) handlers.onSttFinal?.(ev.payload.text);
        })
      );
    }
    if (handlers.onSttError) {
      unlisteners.push(
        await eventMod.listen<{ error?: string }>('voice:stt-error', (ev) => {
          handlers.onSttError?.(ev?.payload?.error || 'Streaming STT error');
        })
      );
    }
    if (handlers.onDeviceLost) {
      unlisteners.push(
        await eventMod.listen<{ error?: string }>('voice:device-lost', (ev) => {
          handlers.onDeviceLost?.(ev?.payload?.error || 'Audio device lost');
        })
      );
    }
    return () => {
      for (const unlisten of unlisteners) {
        try {
          unlisten();
        } catch {}
      }
    };
  } catch {
    return () => {};
  }
}
