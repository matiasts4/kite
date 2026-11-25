import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIO_SETTINGS_CHANGED_EVENT,
  readUnifiedAudioSettings,
  subscribeUnifiedAudioSettings,
  updateUnifiedAudioSettings,
} from './audioSettingsSync';
import { loadOperatorConfig } from '../config/storage';
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
});
