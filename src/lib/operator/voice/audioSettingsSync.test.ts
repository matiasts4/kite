import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIO_SETTINGS_CHANGED_EVENT,
  readUnifiedAudioSettings,
  subscribeUnifiedAudioSettings,
  updateUnifiedAudioSettings,
} from './audioSettingsSync';
import {
  DEFAULT_OPERATOR_CONFIG,
  OPERATOR_CONFIG_STORAGE_KEY,
  loadOperatorConfig,
  saveOperatorConfig,
} from '../config/storage';
import * as ipc from '../../ipc';

vi.mock('../../ipc', async () => {
  const actual = await vi.importActual<typeof import('../../ipc')>('../../ipc');
  return {
    ...actual,
    invokeCommand: vi.fn(async () => ({})),
    isTauriEnvironment: vi.fn(() => true),
  };
});

describe('audioSettingsSync (T8 — Unified Audio/Dictation/Voice Source of Truth)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('synchronizes mic, speaker, language, and transport across localStorage, OperatorConfig, window events, and dictation IPC', async () => {
    const listener = vi.fn();
    const unsub = subscribeUnifiedAudioSettings(listener);
    const eventSpy = vi.fn();
    window.addEventListener(AUDIO_SETTINGS_CHANGED_EVENT, eventSpy);

    const updated = await updateUnifiedAudioSettings({
      micDeviceId: 'mic-usb-pro',
      outputDeviceId: 'spk-studio-1',
      language: 'en-US',
      ttsEngine: 'elevenlabs',
      ttsRate: 1.15,
      voiceTransportMode: 'realtime',
    });

    expect(updated.micDeviceId).toBe('mic-usb-pro');
    expect(updated.outputDeviceId).toBe('spk-studio-1');
    expect(updated.language).toBe('en-US');
    expect(updated.ttsEngine).toBe('elevenlabs');
    expect(updated.voiceTransportMode).toBe('realtime');

    expect(localStorage.getItem('kite_selected_mic_device_id')).toBe('mic-usb-pro');
    expect(localStorage.getItem('kite_selected_output_device_id')).toBe('spk-studio-1');

    const cfg = loadOperatorConfig();
    expect(cfg.ttsLanguage).toBe('en-US');
    expect(cfg.persona.language).toBe('en-US');
    expect(cfg.ttsEngine).toBe('elevenlabs');
    expect(cfg.ttsRate).toBe(1.15);
    expect(cfg.voiceTransportMode).toBe('realtime');

    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'update_dictation_settings',
      expect.objectContaining({
        settings: expect.objectContaining({
          deviceId: 'mic-usb-pro',
          language: 'en-US',
        }),
      })
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(eventSpy).toHaveBeenCalledTimes(1);

    const snapshot = readUnifiedAudioSettings();
    expect(snapshot.micDeviceId).toBe('mic-usb-pro');
    expect(snapshot.outputDeviceId).toBe('spk-studio-1');
    expect(snapshot.language).toBe('en-US');

    window.removeEventListener(AUDIO_SETTINGS_CHANGED_EVENT, eventSpy);
    unsub();
  });

  it('hydrates legacy stored OperatorConfig without dropping existing keys and sanitizes new realtime/idle/volume fields', () => {
    localStorage.setItem(
      OPERATOR_CONFIG_STORAGE_KEY,
      JSON.stringify({
        activeProvider: 'grok',
        grokApiKey: 'xai-legacy-key',
        voiceTransportMode: 'realtime',
        ttsRate: 1.2,
      })
    );

    const hydrated = loadOperatorConfig();
    expect(hydrated.activeProvider).toBe('grok');
    expect(hydrated.grokApiKey).toBe('xai-legacy-key');
    expect(hydrated.voiceTransportMode).toBe('realtime');
    expect(hydrated.ttsRate).toBe(1.2);
    expect(hydrated.realtimeProvider).toBe('xai');
    expect(hydrated.voiceIdleTimeoutSec).toBe(180);
    expect(hydrated.voiceVolume).toBe(100);
    expect(hydrated.geminiLiveApiKey).toBe('');
    expect(hydrated.openaiRealtimeApiKey).toBe('');

    localStorage.setItem(
      OPERATOR_CONFIG_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_OPERATOR_CONFIG,
        realtimeProvider: 'invalid-provider',
        voiceIdleTimeoutSec: 999,
        voiceVolume: 250,
      })
    );
    const sanitized = loadOperatorConfig();
    expect(sanitized.realtimeProvider).toBe('xai');
    expect(sanitized.voiceIdleTimeoutSec).toBe(180);
    expect(sanitized.voiceVolume).toBe(100);

    const saved = saveOperatorConfig({
      realtimeProvider: 'gemini_live',
      geminiLiveApiKey: 'AIza-saved',
      openaiRealtimeApiKey: 'sk-saved',
      voiceIdleTimeoutSec: 0,
      voiceVolume: -15,
    });
    expect(saved.realtimeProvider).toBe('gemini_live');
    expect(saved.geminiLiveApiKey).toBe('AIza-saved');
    expect(saved.openaiRealtimeApiKey).toBe('sk-saved');
    expect(saved.voiceIdleTimeoutSec).toBe(0);
    expect(saved.voiceVolume).toBe(0);
  });

  it('hydrates and persists realtimeProvider and voiceIdleTimeoutSec through UnifiedAudioSettings and dictation IPC', async () => {
    const first = await updateUnifiedAudioSettings({
      realtimeProvider: 'gemini_live',
      voiceIdleTimeoutSec: 300,
    });

    expect(first.realtimeProvider).toBe('gemini_live');
    expect(first.voiceIdleTimeoutSec).toBe(300);

    expect(readUnifiedAudioSettings()).toEqual(
      expect.objectContaining({
        realtimeProvider: 'gemini_live',
        voiceIdleTimeoutSec: 300,
      })
    );
    expect(loadOperatorConfig()).toEqual(
      expect.objectContaining({
        realtimeProvider: 'gemini_live',
        voiceIdleTimeoutSec: 300,
      })
    );
    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'update_dictation_settings',
      expect.objectContaining({
        settings: expect.objectContaining({
          realtimeProvider: 'gemini_live',
          voiceIdleTimeoutSec: 300,
        }),
      })
    );

    const disabled = await updateUnifiedAudioSettings({
      realtimeProvider: 'openai',
      voiceIdleTimeoutSec: 0,
    });
    expect(disabled.realtimeProvider).toBe('openai');
    expect(disabled.voiceIdleTimeoutSec).toBe(0);
    expect(readUnifiedAudioSettings().voiceIdleTimeoutSec).toBe(0);
  });

  it('logs console.warn and preserves local state when update_dictation_settings IPC fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(ipc.invokeCommand).mockRejectedValueOnce(new Error('ipc_unavailable'));

    const next = await updateUnifiedAudioSettings({
      realtimeProvider: 'openai',
      voiceIdleTimeoutSec: 60,
    });

    expect(next.realtimeProvider).toBe('openai');
    expect(next.voiceIdleTimeoutSec).toBe(60);
    expect(loadOperatorConfig().realtimeProvider).toBe('openai');
    expect(loadOperatorConfig().voiceIdleTimeoutSec).toBe(60);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[audioSettingsSync]'),
      expect.any(Error)
    );
  });
});
