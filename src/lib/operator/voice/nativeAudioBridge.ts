// Kite Code — Native Rust Audio Capture Bridge (`voice_audio` IPC)
// Prefers native cpal WASAPI capture when running inside Tauri, falling back cleanly
// to WebView2 AudioWorklet in browser previews or unit tests.

import { invokeCommand, isTauriEnvironment } from '../../ipc';

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
}): Promise<NativeCaptureStartResult> {
  if (!isNativeRustAudioSupported()) {
    return { ok: false, error: 'Native audio unavailable outside Tauri runtime' };
  }
  try {
    const res = await invokeCommand<NativeCaptureStartResult>('voice_audio_start_capture', {
      deviceId: options?.deviceId ?? null,
      sampleRate: options?.sampleRate ?? 16000,
    });
    return res ?? { ok: false, error: 'Empty response from voice_audio_start_capture' };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function stopNativeAudioCapture(): Promise<NativeCaptureStopResult> {
  if (!isNativeRustAudioSupported()) {
    return { ok: false, wavBytes: 0 };
  }
  try {
    const res = await invokeCommand<NativeCaptureStopResult>('voice_audio_stop_capture');
    cachedNativeLevel = 0;
    return res ?? { ok: false, wavBytes: 0 };
  } catch (err: any) {
    cachedNativeLevel = 0;
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
  onAudioLevel?: (level: number, rms: number) => void;
  onSttPartial?: (text: string) => void;
  onSttFinal?: (text: string) => void;
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
        await eventMod.listen<{ level?: number; rms?: number }>('voice:audio-level', (ev) => {
          const level = ev?.payload?.level ?? 0;
          setCachedNativeAudioLevel(level);
          handlers.onAudioLevel?.(level, ev?.payload?.rms ?? 0);
        })
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
