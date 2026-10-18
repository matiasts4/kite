import React from 'react';
import {
  RefreshCwIcon,
  SparklesIcon,
  ArrowUpRightIcon,
  WrenchIcon,
  ShieldIcon,
  MinusIcon,
} from './icons';
import type { UpdateCheckResult } from './types';
import { CURRENT_APP_VERSION } from '../../../hooks/useAppUpdater';
import { getReleases, type ReleaseItem, type ReleaseNote } from '../../../lib/changelogData';

export { KITE_RELEASES as RELEASES } from '../../../lib/changelogData';

interface ChangelogTabProps {
  updateInfo: UpdateCheckResult | null;
  updateChecked: boolean;
  isCheckingUpdate: boolean;
  updateError?: string | null;
  currentVersion?: string;
  onCheckUpdate: () => void;
  onUpdateAndRestart?: () => void;
}

export const ChangelogTab: React.FC<ChangelogTabProps> = ({
  updateInfo,
  updateChecked,
  isCheckingUpdate,
  updateError,
  currentVersion = CURRENT_APP_VERSION,
  onCheckUpdate,
  onUpdateAndRestart,
}) => {
  const releases: ReleaseNote[] = getReleases(currentVersion, updateInfo);

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
      {/* 1. Current Version & Update Status */}
      <section className="settings-group">
        <h2 className="settings-group__title">Estado de la versión</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Kite Code v{currentVersion}</h3>
              <p>
                {updateError ? (
                  <span style={{ color: 'var(--danger-fill, #ef4444)' }}>
                    {updateError}
                  </span>
                ) : updateInfo?.available ? (
                  `Versión ${updateInfo.version} disponible para descargar e instalar.`
                ) : updateChecked ? (
                  `Kite Code v${currentVersion} está actualizado a la última versión.`
                ) : (
                  `Ejecutando Kite Code v${currentVersion} en runtime nativo autónomo.`
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

      {/* 2. Chronological Release Ledger */}
      {releases.map((rel) => (
        <section
          key={rel.version}
          aria-label={`Kite Code ${rel.version}`}
          className="settings-changelog__release"
        >
          <div
            className="settings-changelog__heading"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: '13px' }}>v{rel.version}</span>
              {rel.title && (
                <span style={{ color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 500 }}>
                  — {rel.title}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {rel.date && <span className="settings-changelog__date">{rel.date}</span>}
              {rel.isCurrent && (
                <span
                  className="settings-badge"
                  data-tone="running"
                  style={{ fontSize: '11px', padding: '1px 8px' }}
                >
                  Installed
                </span>
              )}
              {rel.isIncoming && (
                <span
                  className="settings-badge"
                  style={{
                    fontSize: '11px',
                    padding: '1px 8px',
                    backgroundColor: 'rgba(92, 143, 255, 0.2)',
                    color: 'var(--accent, #5c8fff)',
                    border: '1px solid rgba(92, 143, 255, 0.3)',
                  }}
                >
                  Disponible
                </span>
              )}
            </div>
          </div>

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
        </section>
      ))}
    </>
  );
};
