import React from 'react';
import {
  RefreshCwIcon,
  SparklesIcon,
  ArrowUpRightIcon,
  WrenchIcon,
  ShieldIcon,
  MinusIcon,
} from './icons';
import type { UpdateCheckResult, ReleaseItem, TelemetryPrefs, TelemetryIdentity } from './types';
import { CURRENT_APP_VERSION } from '../../../hooks/useAppUpdater';
import { getReleases } from '../../../lib/changelogData';

interface AboutTabProps {
  updateInfo: UpdateCheckResult | null;
  updateChecked: boolean;
  isCheckingUpdate: boolean;
  updateError?: string | null;
  currentVersion?: string;
  telemetryPrefs: TelemetryPrefs;
  telemetryIdentity: TelemetryIdentity | null;
  onCheckUpdate: () => void;
  onUpdateAndRestart?: () => void;
  onToggleTelemetry: (key: 'analytics' | 'diagnostics') => void;
  onOpenWhatsNew?: () => void;
}

export const AboutTab: React.FC<AboutTabProps> = ({
  updateInfo,
  updateChecked,
  isCheckingUpdate,
  updateError,
  currentVersion = CURRENT_APP_VERSION,
  telemetryPrefs,
  telemetryIdentity,
  onCheckUpdate,
  onUpdateAndRestart,
  onToggleTelemetry,
  onOpenWhatsNew,
}) => {
  const releases = getReleases(currentVersion, updateInfo);
  const renderKindIcon = (kind: ReleaseItem['kind']) => {
    switch (kind) {
      case 'added':
        return <SparklesIcon size={12} strokeWidth={2.2} />;
      case 'changed':
        return <ArrowUpRightIcon size={12} strokeWidth={2.2} />;
      case 'fixed':
        return <WrenchIcon size={12} strokeWidth={2.2} />;
      case 'security':
        return <ShieldIcon size={12} strokeWidth={2.2} />;
      default:
        return <MinusIcon size={12} strokeWidth={2.2} />;
    }
  };

  const getKindColorVar = (kind: ReleaseItem['kind']) => {
    switch (kind) {
      case 'added':
        return '--status-running';
      case 'changed':
        return '--accent';
      case 'fixed':
        return '--status-waiting';
      case 'security':
        return '--danger-fill';
      default:
        return '--text-secondary';
    }
  };

  return (
    <>
      <section className="settings-group">
        <h2 className="settings-group__title">Application</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Kite Code</h3>
              <p>Studio Edition · Version {currentVersion} (Production Native)</p>
            </div>
            <div className="settings-row__control">
              <span className="settings-badge" data-tone="running">v{currentVersion}</span>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Runtime environment</h3>
              <p>Native ConPTY daemon, WebView2, and hardware-accelerated rendering.</p>
            </div>
            <div className="settings-row__control">
              <span className="settings-badge">Tauri 2.0</span>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Software update</h3>
              <p>
                {updateError ? (
                  <span style={{ color: 'var(--danger-fill, #ef4444)' }}>
                    {updateError}
                  </span>
                ) : updateInfo?.available ? (
                  `Version ${updateInfo.version} is available to install.`
                ) : updateChecked ? (
                  `Kite Code v${currentVersion} is up to date.`
                ) : (
                  'Running latest official release build.'
                )}
              </p>
            </div>
            <div className="settings-row__control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {updateInfo?.available && onUpdateAndRestart && (
                <button
                  className="settings-control ui-button"
                  onClick={onUpdateAndRestart}
                  type="button"
                  style={{
                    backgroundColor: 'var(--accent, #5c8fff)',
                    color: '#fff',
                    fontWeight: 600,
                  }}
                >
                  Update &amp; Restart
                </button>
              )}
              <button
                className="settings-control ui-button"
                disabled={isCheckingUpdate}
                onClick={onCheckUpdate}
                type="button"
              >
                {isCheckingUpdate ? (
                  <>
                    <RefreshCwIcon className="animate-spin" size={13} />
                    Checking…
                  </>
                ) : (
                  'Check for updates'
                )}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <h2 className="settings-group__title">Offline Telemetry & Privacy</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Product analytics</h3>
              <p>Store feature usage locally on device. No external network telemetry calls are ever made.</p>
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
              <h3 className="settings-row__title">Crash diagnostics</h3>
              <p>Redacted local crash logs preserved on this device for offline debugging.</p>
            </div>
            <div className="settings-row__control">
              <button
                aria-checked={telemetryPrefs.diagnostics}
                aria-label="Crash diagnostics"
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
              <h3 className="settings-row__title">Device identity</h3>
              <p>
                {telemetryIdentity?.id
                  ? `${telemetryIdentity.id.slice(0, 32)}…`
                  : 'Local hardware signature generated on device.'}
              </p>
            </div>
            <div className="settings-row__control">
              <span className="settings-badge" data-tone={telemetryIdentity?.ready ? 'running' : 'accent'}>
                Offline
              </span>
            </div>
          </div>
        </div>
        <p className="settings-note">
          Kite operates completely offline for telemetry. No diagnostic or usage packets leave this computer.
        </p>
      </section>

      <section className="settings-group">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
          <h2 className="settings-group__title">What&apos;s new in {currentVersion}</h2>
          {onOpenWhatsNew ? (
            <button className="settings-control ui-button" onClick={onOpenWhatsNew} type="button">
              Open full release notes
            </button>
          ) : null}
        </div>
        {releases.slice(0, 3).map((rel) => (
          <div
            key={rel.version}
            aria-label={`Kite ${rel.version}`}
            className="settings-changelog__release"
          >
            <h3 className="settings-changelog__heading">
              <span>Version {rel.version}</span>
              {rel.date ? <span className="settings-changelog__date">{rel.date}</span> : null}
              {rel.isCurrent ? <span className="settings-changelog__current">Installed</span> : null}
            </h3>
            <div className="settings-changelog__card">
              <ul className="whats-new__items">
                {rel.items.map((item, idx) => (
                  <li
                    key={idx}
                    className="whats-new__item"
                    style={{ '--kind-ink': `var(${getKindColorVar(item.kind)})` } as React.CSSProperties}
                  >
                    <span className="whats-new__tile" title={item.kind}>
                      {renderKindIcon(item.kind)}
                    </span>
                    <span className="whats-new__text">{item.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </section>

      <p className="settings-note settings-footer">Kite Code · Build 2026.10.14</p>
    </>
  );
};
