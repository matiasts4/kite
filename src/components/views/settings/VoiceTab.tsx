import React from 'react';
import type { DictationAvailability, DictationInputDevice, DictationSettings } from './types';

interface VoiceTabProps {
  dictationSettings: DictationSettings;
  dictationAvailability: DictationAvailability;
  dictationDevices: DictationInputDevice[];
  onUpdateDictationMode: (mode: 'cloud' | 'local') => void;
  onToggleCues: () => void;
  onResetShortcut: () => void;
  onSelectDevice: (deviceId: string | null) => void;
  onChooseWhisperModel: () => void;
  onRequestMicrophone: () => void;
}

export const VoiceTab: React.FC<VoiceTabProps> = ({
  dictationSettings,
  dictationAvailability,
  dictationDevices,
  onUpdateDictationMode,
  onToggleCues,
  onResetShortcut,
  onSelectDevice,
  onChooseWhisperModel,
  onRequestMicrophone,
}) => {
  return (
    <>
      <section className="settings-group">
        <h2 className="settings-group__title">Voice to text</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Voice transcription</h3>
              <p>Choose where each take is transcribed.</p>
            </div>
            <div className="settings-row__control">
              <fieldset aria-label="Voice transcription" className="ui-segmented">
                <button
                  aria-pressed={dictationSettings.mode === 'local'}
                  className="ui-segmented__item"
                  onClick={() => onUpdateDictationMode('local')}
                  type="button"
                >
                  <span>On this PC</span>
                </button>
                <button
                  aria-pressed={dictationSettings.mode === 'cloud'}
                  className="ui-segmented__item"
                  onClick={() => onUpdateDictationMode('cloud')}
                  type="button"
                >
                  <span>Cloud</span>
                </button>
              </fieldset>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Voice privacy</h3>
              <p>
                {dictationAvailability.guidance ||
                  (dictationSettings.mode === 'cloud'
                    ? 'Cloud transcription is unavailable in this local studio.'
                    : 'No installed local transcription engine is ready.')}
              </p>
            </div>
            <div className="settings-row__control">
              <span
                className="settings-badge"
                data-tone={dictationSettings.mode === 'local' ? 'running' : 'accent'}
              >
                {dictationSettings.mode === 'local' ? 'Local' : 'Cloud'}
              </span>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">
                {dictationSettings.mode === 'local' ? 'On-device engine' : 'Cloud model'}
              </h3>
              <p>
                {dictationSettings.mode === 'local'
                  ? 'Only installed engines can be selected. Local failure never sends audio to Cloud.'
                  : 'Cloud transcription is unavailable in this local studio. Audio is not sent anywhere.'}
              </p>
            </div>
            <div className="settings-row__control">
              {dictationSettings.mode === 'local' ? (
                <button
                  className="settings-control ui-button"
                  onClick={onChooseWhisperModel}
                  type="button"
                >
                  Choose Whisper model…
                </button>
              ) : (
                <span className="settings-badge" data-tone="warning">
                  Unavailable
                </span>
              )}
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Language</h3>
              <p>Automatic detects the spoken language for each take.</p>
            </div>
            <div className="settings-row__control">
              <span className="settings-badge">Automatic (detect)</span>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <h2 className="settings-group__title">Dictation</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Dictation shortcut</h3>
              <p>Starts dictation in the composer you&apos;re working in while Kite is in front. Press it again to transcribe.</p>
            </div>
            <div className="settings-row__control">
              <button
                aria-label="Dictation shortcut"
                className="settings-control dictation-shortcut__recorder ui-button"
                type="button"
              >
                <kbd>Ctrl+Shift+D</kbd>
              </button>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Audio cues</h3>
              <p>Play a soft chime when dictation starts and stops recording.</p>
            </div>
            <div className="settings-row__control">
              <button
                aria-checked={dictationSettings.cuesEnabled}
                aria-label="Audio cues"
                className="ui-switch"
                onClick={onToggleCues}
                role="switch"
                type="button"
              >
                <span aria-hidden="true" className="ui-switch__knob" />
              </button>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Microphone</h3>
              <p>Device names are private to this computer. Automatic chooses a safe input.</p>
            </div>
            <div className="settings-row__control settings-row__control--menu">
              <select
                aria-label="Microphone"
                className="settings-control"
                onChange={(event) =>
                  onSelectDevice(event.target.value === 'automatic' ? null : event.target.value)
                }
                value={dictationSettings.deviceId ?? 'automatic'}
              >
                <option value="automatic">Automatic</option>
                {dictationDevices.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Microphone access</h3>
              <p>{dictationAvailability.guidance || 'Checking the local microphone.'}</p>
            </div>
            <div className="settings-row__control">
              <button className="settings-control ui-button" onClick={onRequestMicrophone} type="button">
                Allow microphone…
              </button>
              <span
                className="settings-badge"
                data-tone={dictationAvailability.canStart ? 'running' : 'warning'}
              >
                {dictationAvailability.canStart ? 'Ready' : 'Unavailable'}
              </span>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Reset shortcut</h3>
              <p>Restore the default keyboard combination.</p>
            </div>
            <div className="settings-row__control">
              <button
                className="settings-control ui-button"
                onClick={onResetShortcut}
                type="button"
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
};
