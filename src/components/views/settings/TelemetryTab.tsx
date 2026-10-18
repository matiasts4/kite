import React from 'react';
import type { TelemetryPrefs, TelemetryIdentity } from './types';

interface TelemetryTabProps {
  telemetryPrefs: TelemetryPrefs;
  telemetryIdentity: TelemetryIdentity | null;
  onToggleTelemetry: (key: 'analytics' | 'diagnostics') => void;
}

export const TelemetryTab: React.FC<TelemetryTabProps> = ({
  telemetryPrefs,
  telemetryIdentity,
  onToggleTelemetry,
}) => {
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">Privacy</h2>
      <div className="ui-card">
        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Product analytics</h3>
            <p>Share feature usage to improve Kite Code. No prompts, files, or email addresses.</p>
          </div>
          <div className="settings-row__control">
            <button
              aria-checked={telemetryPrefs.analytics}
              aria-label="Product analytics"
              className="ui-switch"
              onClick={() => onToggleTelemetry('analytics')}
              role="switch"
              type="button"
            >
              <span aria-hidden="true" className="ui-switch__knob" />
            </button>
          </div>
        </div>

        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Crash and error reports</h3>
            <p>Share redacted crash reports and failure categories to help fix production errors.</p>
          </div>
          <div className="settings-row__control">
            <button
              aria-checked={telemetryPrefs.diagnostics}
              aria-label="Crash and error reports"
              className="ui-switch"
              onClick={() => onToggleTelemetry('diagnostics')}
              role="switch"
              type="button"
            >
              <span aria-hidden="true" className="ui-switch__knob" />
            </button>
          </div>
        </div>

        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Anonymous identifier</h3>
            <p>
              {telemetryIdentity?.id
                ? `${telemetryIdentity.id.slice(0, 32)}…`
                : 'Local hardware signature generated on device.'}
            </p>
          </div>
          <div className="settings-row__control">
            <span className="settings-badge" data-tone={telemetryIdentity?.ready ? 'running' : 'accent'}>
              {telemetryIdentity?.ready ? 'Ready' : 'Local'}
            </span>
          </div>
        </div>
      </div>
      <p className="settings-note">
        Privacy settings are preserved locally on this device.
      </p>
    </section>
  );
};
