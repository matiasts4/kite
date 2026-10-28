import React from 'react';
import { SunIcon, MoonIcon, RefreshCwIcon } from './icons';
import type { UpdateCheckResult, TelemetryPrefs } from './types';
import { SegmentedIndicator } from '../../ui/SegmentedIndicator';
import { PrivacyPolicyCard } from './PrivacyPolicyCard';

import { CURRENT_APP_VERSION } from '../../../hooks/useAppUpdater';

interface GeneralTabProps {
  mode: 'dark' | 'light';
  autoSaveFiles: boolean;
  automaticUpdates: boolean;
  updateInfo: UpdateCheckResult | null;
  updateChecked: boolean;
  isCheckingUpdate: boolean;
  currentVersion?: string;
  telemetryPrefs?: TelemetryPrefs;
  onToggleMode: (mode: 'dark' | 'light') => void;
  onToggleAutoSave: () => void;
  onToggleAutomaticUpdates: () => void;
  onCheckUpdate: () => void;
  onUpdateAndRestart?: () => void;
  onToggleTelemetry?: (key: 'analytics' | 'diagnostics') => void;
}

export const GeneralTab: React.FC<GeneralTabProps> = ({
  mode,
  autoSaveFiles,
  automaticUpdates,
  updateInfo,
  updateChecked,
  isCheckingUpdate,
  currentVersion = CURRENT_APP_VERSION,
  telemetryPrefs = { diagnostics: false, analytics: false },
  onToggleMode,
  onToggleAutoSave,
  onToggleAutomaticUpdates,
  onCheckUpdate,
  onUpdateAndRestart,
  onToggleTelemetry,
}) => {
  return (
    <>
      {/* 1. Appearance Section */}
      <section className="settings-group">
        <h2 className="settings-group__title">Apariencia</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Modo</h3>
              <p>Oscuro o claro. Personaliza la paleta de colores en la pestaña Customizations.</p>
            </div>
            <div className="settings-row__control">
              <fieldset aria-label="Modo de color" className="ui-segmented">
                <button
                  aria-pressed={mode === 'light'}
                  className="ui-segmented__item"
                  onClick={() => onToggleMode('light')}
                  type="button"
                >
                  {mode === 'light' && <SegmentedIndicator group="settings-general-mode" />}
                  <span aria-hidden="true" className="ui-segmented__icon">
                    <SunIcon size={12} strokeWidth={2} />
                  </span>
                  <span>Light</span>
                </button>
                <button
                  aria-pressed={mode === 'dark'}
                  className="ui-segmented__item"
                  onClick={() => onToggleMode('dark')}
                  type="button"
                >
                  {mode === 'dark' && <SegmentedIndicator group="settings-general-mode" />}
                  <span aria-hidden="true" className="ui-segmented__icon">
                    <MoonIcon size={12} strokeWidth={2} />
                  </span>
                  <span>Dark</span>
                </button>
              </fieldset>
            </div>
          </div>

        </div>
      </section>

      {/* 2. Files Section */}
      <section className="settings-group">
        <h2 className="settings-group__title">Archivos y Espacio de Trabajo</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Autoguardado</h3>
              <p>
                Guarda automáticamente los cambios en el editor unos instantes después de escribir.
                Ctrl+S sigue guardando de forma inmediata.
              </p>
            </div>
            <div className="settings-row__control">
              <button
                aria-checked={autoSaveFiles}
                aria-label="Autoguardado de archivos"
                className="ui-switch"
                onClick={onToggleAutoSave}
                role="switch"
                type="button"
              >
                <span aria-hidden="true" className="ui-switch__knob" />
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* 3. Updates Section */}
      <section className="settings-group">
        <h2 className="settings-group__title">Actualizaciones de Software</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Descarga automática</h3>
              <p>
                Verificar y descargar silenciosamente paquetes firmados para Windows.
              </p>
            </div>
            <div className="settings-row__control">
              <button
                aria-checked={automaticUpdates}
                aria-label="Actualizaciones automáticas"
                className="ui-switch"
                onClick={onToggleAutomaticUpdates}
                role="switch"
                type="button"
              >
                <span aria-hidden="true" className="ui-switch__knob" />
              </button>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Estado de la versión</h3>
              <p aria-live="polite">
                {updateInfo?.available
                  ? `La versión ${updateInfo.version} está lista para instalar.`
                  : updateChecked
                  ? `Kite Code ${currentVersion} está actualizado a la última versión.`
                  : `Ejecutando Kite Code ${currentVersion} (Canal oficial).`}
              </p>
            </div>
            <div className="settings-row__control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {updateInfo?.available && onUpdateAndRestart && (
                <button
                  className="settings-control ui-button"
                  onClick={onUpdateAndRestart}
                  type="button"
                  style={{
                    height: '28px',
                    padding: '0 12px',
                    fontSize: '12px',
                    backgroundColor: 'var(--accent, #5c8fff)',
                    color: '#fff',
                    fontWeight: 600,
                  }}
                >
                  Actualizar y Reiniciar
                </button>
              )}
              <button
                className="settings-control ui-button secondary-button"
                disabled={isCheckingUpdate}
                onClick={onCheckUpdate}
                type="button"
                style={{ height: '28px', padding: '0 12px', fontSize: '12px' }}
              >
                {isCheckingUpdate ? (
                  <>
                    <RefreshCwIcon className="animate-spin" size={12} />
                    <span>Buscando…</span>
                  </>
                ) : (
                  'Buscar actualizaciones'
                )}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Local Privacy & Diagnostics */}
      <section className="settings-group">
        <h2 className="settings-group__title">Privacidad y Diagnósticos</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Diagnósticos y logs locales</h3>
              <p>Conserva registros de depuración y errores en el equipo (app.log). Sin envíos externos a servidores terceros.</p>
            </div>
            <div className="settings-row__control">
              <button
                aria-checked={telemetryPrefs.diagnostics}
                aria-label="Diagnósticos locales"
                className="ui-switch"
                onClick={() => onToggleTelemetry?.('diagnostics')}
                role="switch"
                type="button"
              >
                <span aria-hidden="true" className="ui-switch__knob" />
              </button>
            </div>
          </div>
        </div>
      </section>

      <PrivacyPolicyCard />

      <p className="settings-note settings-footer">Kite Code · Edición Nativa {currentVersion}</p>
    </>
  );
};
