import type { OperatorConfig, RealtimeProviderId } from '../config/types';
import {
  loadOperatorConfig,
  sanitizeRealtimeProvider,
  sanitizeVoiceIdleTimeoutSec,
  saveOperatorConfig,
} from '../config/storage';
import { invokeCommand, isTauriEnvironment } from '../../ipc';

export const AUDIO_SETTINGS_CHANGED_EVENT = 'kite:audio-settings-changed';
const MIC_DEVICE_STORAGE_KEY = 'kite_selected_mic_device_id';
const SPEAKER_DEVICE_STORAGE_KEY = 'kite_selected_output_device_id';

export interface UnifiedAudioSettings {
  micDeviceId: string;
  outputDeviceId: string;
  language: string;
  ttsEngine: OperatorConfig['ttsEngine'];
  ttsRate: number;
  voiceTransportMode: 'cascaded' | 'realtime';
  realtimeProvider: RealtimeProviderId;
  voiceIdleTimeoutSec: number;
}

const listeners = new Set<(next: UnifiedAudioSettings) => void>();

function safeStorageGet(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  } catch {
    // ignore storage errors
  }
}

export function readUnifiedAudioSettings(): UnifiedAudioSettings {
  const cfg = loadOperatorConfig();
  const micDeviceId = safeStorageGet(MIC_DEVICE_STORAGE_KEY) || 'automatic';
  const outputDeviceId = safeStorageGet(SPEAKER_DEVICE_STORAGE_KEY) || 'automatic';
  const language = cfg.ttsLanguage || cfg.persona.language || 'es-AR';
  return {
    micDeviceId,
    outputDeviceId,
    language,
    ttsEngine: cfg.ttsEngine,
    ttsRate: cfg.ttsRate,
    voiceTransportMode: cfg.voiceTransportMode ?? 'cascaded',
    realtimeProvider: sanitizeRealtimeProvider(cfg.realtimeProvider),
    voiceIdleTimeoutSec: sanitizeVoiceIdleTimeoutSec(cfg.voiceIdleTimeoutSec),
  };
}

export async function updateUnifiedAudioSettings(
  patch: Partial<UnifiedAudioSettings>
): Promise<UnifiedAudioSettings> {
  if (patch.micDeviceId !== undefined) {
    safeStorageSet(MIC_DEVICE_STORAGE_KEY, patch.micDeviceId);
  }
  if (patch.outputDeviceId !== undefined) {
    safeStorageSet(SPEAKER_DEVICE_STORAGE_KEY, patch.outputDeviceId);
  }

  const currentCfg = loadOperatorConfig();
  const cfgPatch: Partial<OperatorConfig> = {};
  if (patch.language !== undefined) {
    cfgPatch.ttsLanguage = patch.language;
    cfgPatch.persona = { ...currentCfg.persona, language: patch.language };
  }
  if (patch.ttsEngine !== undefined) {
    cfgPatch.ttsEngine = patch.ttsEngine;
  }
  if (patch.ttsRate !== undefined) {
    cfgPatch.ttsRate = patch.ttsRate;
  }
  if (patch.voiceTransportMode !== undefined) {
    cfgPatch.voiceTransportMode = patch.voiceTransportMode;
  }
  if (patch.realtimeProvider !== undefined) {
    cfgPatch.realtimeProvider = sanitizeRealtimeProvider(patch.realtimeProvider);
  }
  if (patch.voiceIdleTimeoutSec !== undefined) {
    cfgPatch.voiceIdleTimeoutSec = sanitizeVoiceIdleTimeoutSec(patch.voiceIdleTimeoutSec);
  }
  if (Object.keys(cfgPatch).length > 0) {
    saveOperatorConfig(cfgPatch);
  }

  const next = readUnifiedAudioSettings();

  if (isTauriEnvironment()) {
    try {
      await invokeCommand('update_dictation_settings', {
        settings: {
          deviceId: next.micDeviceId === 'automatic' ? null : next.micDeviceId,
          outputDeviceId: next.outputDeviceId === 'automatic' ? null : next.outputDeviceId,
          language: next.language,
          voiceTransportMode: next.voiceTransportMode,
          realtimeProvider: next.realtimeProvider,
          voiceIdleTimeoutSec: next.voiceIdleTimeoutSec,
        },
      });
    } catch (err) {
      // keep local synchronization authoritative even if IPC is unavailable
      console.warn('[audioSettingsSync] Failed to sync update_dictation_settings via IPC:', err);
    }
  }

  for (const listener of listeners) {
    try {
      listener(next);
    } catch {
      // ignore subscriber errors
    }
  }

  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AUDIO_SETTINGS_CHANGED_EVENT, { detail: next }));
  }

  return next;
}

export function subscribeUnifiedAudioSettings(
  listener: (next: UnifiedAudioSettings) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
