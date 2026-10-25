import React, { useState, useEffect } from 'react';
import {
  getProviderConnectionMeta,
  openProviderPortal,
  saveVaultApiKey,
  removeVaultApiKey,
} from '../../lib/quota/connectionMethods';
import { openExternalLink } from '../../lib/terminalLinkNav';
import { type ProviderDetectedSession } from '../../lib/quota/sessionDetection';
import { type CredentialStatusItem } from '../../lib/ipc';
import {
  TerminalIcon,
  KeyIcon,
  GlobeIcon,
  CopyIcon,
  CheckIcon,
  TrashIcon,
  ExternalLinkIcon,
  CheckCircleIcon,
  AlertCircleIcon,
} from '../views/settings/icons';

export interface ProviderConnectionPanelProps {
  providerId: string;
  detectedSession?: ProviderDetectedSession;
  vaultCredential?: CredentialStatusItem;
  onCredentialChanged?: () => void;
}

export const ProviderConnectionPanel: React.FC<ProviderConnectionPanelProps> = ({
  providerId,
  detectedSession,
  vaultCredential,
  onCredentialChanged,
}) => {
  const meta = getProviderConnectionMeta(providerId);
  const [activeTab, setActiveTab] = useState<'cli' | 'apikey' | 'portal'>('cli');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  // Switch default tab if provider only supports API Key (e.g. DeepSeek)
  useEffect(() => {
    if (meta && !meta.supportsCli && meta.supportsApiKey) {
      setActiveTab('apikey');
    } else {
      setActiveTab('cli');
    }
    setApiKeyInput('');
    setStatusMessage(null);
  }, [providerId, meta]);

  if (!meta) return null;

  const handleCopy = async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedCmd(cmd);
      setTimeout(() => setCopiedCmd(null), 2500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const handleCopyAndNavigateTerminal = async (cmd: string) => {
    await handleCopy(cmd);
    window.dispatchEvent(new CustomEvent('kite:navigate-mode', { detail: 'code' }));
  };

  const handleSaveApiKey = async () => {
    if (!apiKeyInput.trim()) return;
    setIsSaving(true);
    setStatusMessage(null);
    try {
      const ok = await saveVaultApiKey(providerId, apiKeyInput.trim());
      if (ok) {
        setStatusMessage({ text: 'Clave de API guardada y cifrada en tu bóveda.', tone: 'ok' });
        setApiKeyInput('');
        onCredentialChanged?.();
      } else {
        setStatusMessage({ text: 'No se pudo guardar la clave.', tone: 'error' });
      }
    } catch (err: any) {
      setStatusMessage({ text: err?.message || 'Error al guardar la clave.', tone: 'error' });
    } finally {
      setIsSaving(false);
      setTimeout(() => setStatusMessage(null), 4000);
    }
  };

  const handleRemoveApiKey = async () => {
    setIsSaving(true);
    try {
      const ok = await removeVaultApiKey(providerId);
      if (ok) {
        setStatusMessage({ text: 'Clave eliminada de la bóveda.', tone: 'ok' });
        onCredentialChanged?.();
      } else {
        setStatusMessage({ text: 'No se pudo eliminar la clave.', tone: 'error' });
      }
    } catch (err: any) {
      setStatusMessage({ text: err?.message || 'Error al eliminar la clave.', tone: 'error' });
    } finally {
      setIsSaving(false);
      setTimeout(() => setStatusMessage(null), 3500);
    }
  };

  const isCliActive = detectedSession?.sessionType === 'cli_authenticated' || detectedSession?.sessionType === 'terminal_agent';
  const isVaultConfigured = vaultCredential?.isConfigured;

  return (
    <div className="qt-conn-panel">
      <div className="qt-conn-panel__header">
        <div>
          <h4 className="qt-conn-panel__title">Opciones de conexión para {meta.name}</h4>
          <p className="qt-hint" style={{ margin: '2px 0 0' }}>
            Puedes conectar este proveedor mediante sesión local o guardar una clave de API directamente.
          </p>
        </div>
      </div>

      {/* Tabs / Method Selector */}
      <div className="qt-conn-panel__tabs" role="tablist" aria-label="Métodos de conexión">
        {meta.supportsCli ? (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'cli'}
            className="qt-conn-panel__tab-btn"
            data-active={activeTab === 'cli' ? '' : undefined}
            onClick={() => setActiveTab('cli')}
          >
            <TerminalIcon size={14} />
            <span>Sesión CLI / Terminal</span>
            {isCliActive ? (
              <span className="qt-chip" data-tone="ok" style={{ padding: '0 4px', fontSize: '9px', height: '14px' }}>
                <span className="qt-status-dot" data-tone="ok" />
                Activa
              </span>
            ) : null}
          </button>
        ) : null}

        {meta.supportsApiKey ? (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'apikey'}
            className="qt-conn-panel__tab-btn"
            data-active={activeTab === 'apikey' ? '' : undefined}
            onClick={() => setActiveTab('apikey')}
          >
            <KeyIcon size={14} />
            <span>Clave de API en Bóveda</span>
            {isVaultConfigured ? (
              <span className="qt-chip" data-tone="ok" style={{ padding: '0 4px', fontSize: '9px', height: '14px' }}>
                <span className="qt-status-dot" data-tone="ok" />
                En Bóveda
              </span>
            ) : null}
          </button>
        ) : null}

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'portal'}
          className="qt-conn-panel__tab-btn"
          data-active={activeTab === 'portal' ? '' : undefined}
          onClick={() => setActiveTab('portal')}
        >
          <GlobeIcon size={14} />
          <span>Consola y Enlaces</span>
        </button>
      </div>

      {/* Feedback banner */}
      {statusMessage ? (
        <div
          className="qt-banner"
          data-tone={statusMessage.tone === 'ok' ? 'ok' : 'error'}
          style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}
        >
          {statusMessage.tone === 'ok' ? (
            <CheckCircleIcon size={14} />
          ) : (
            <AlertCircleIcon size={14} />
          )}
          <span>{statusMessage.text}</span>
        </div>
      ) : null}

      {/* ── 1. CLI Tab ─────────────────────────────────────────────────── */}
      {activeTab === 'cli' && meta.supportsCli ? (
        <div className="qt-conn-panel__body">
          <div className="qt-spec-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span className="qt-spec-card__label">Comando de inicio de sesión</span>
              {isCliActive ? (
                <span className="qt-chip" data-tone="ok">
                  <span className="qt-status-dot" data-tone="ok" />
                  Sesión detectada
                </span>
              ) : (
                <span className="qt-chip" data-tone="idle">
                  <span className="qt-status-dot" data-tone="idle" />
                  No iniciada
                </span>
              )}
            </div>

            <p style={{ margin: '6px 0 8px', fontSize: '12px', color: 'var(--text-secondary)' }}>
              Ejecuta el siguiente comando en tu terminal para iniciar sesión con tu cuenta de {meta.name}:
            </p>

            <div className="qt-cmd">
              <code>{meta.cliCommand}</code>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  type="button"
                  className="qt-button qt-button--primary"
                  onClick={() => handleCopy(meta.cliCommand!)}
                >
                  {copiedCmd === meta.cliCommand ? (
                    <>
                      <CheckIcon size={13} />
                      <span>Copiado</span>
                    </>
                  ) : (
                    <>
                      <CopyIcon size={13} />
                      <span>Copiar comando</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  className="qt-button qt-button--ghost"
                  onClick={() => handleCopyAndNavigateTerminal(meta.cliCommand!)}
                  title="Copia el comando y te lleva a la vista de terminal de Kite"
                >
                  <TerminalIcon size={13} />
                  <span>Copiar e ir a Terminal</span>
                </button>
              </div>
            </div>
          </div>

          {meta.cliInstallCommand ? (
            <div className="qt-spec-card" style={{ marginTop: '8px' }}>
              <span className="qt-spec-card__label">¿No tienes {meta.name} instalado?</span>
              <p style={{ margin: '4px 0 8px', fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                Instálalo con PowerShell ejecutando:
              </p>
              <div className="qt-cmd">
                <code>{meta.cliInstallCommand}</code>
                <button
                  type="button"
                  className="qt-button qt-button--ghost"
                  onClick={() => handleCopy(meta.cliInstallCommand!)}
                >
                  {copiedCmd === meta.cliInstallCommand ? (
                    <>
                      <CheckIcon size={13} />
                      <span>Copiado</span>
                    </>
                  ) : (
                    <>
                      <CopyIcon size={13} />
                      <span>Copiar instalación</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ── 2. API Key Tab ──────────────────────────────────────────────── */}
      {activeTab === 'apikey' && meta.supportsApiKey ? (
        <div className="qt-conn-panel__body">
          <div className="qt-spec-card">
            <span className="qt-spec-card__label">Clave de API guardada en la bóveda de Kite</span>
            <p style={{ margin: '4px 0 8px', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
              {meta.apiKeyHelp} Se almacena cifrada en tu equipo y se usa para verificar límites o ejecutar agentes.
            </p>

            {isVaultConfigured ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 12px',
                  borderRadius: 'var(--radius-chip)',
                  background: 'var(--composer)',
                  border: '1px solid var(--block-stroke)',
                  marginBottom: '10px',
                }}
              >
                <div>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                    Origen: {vaultCredential?.source === 'vault' ? 'Bóveda local de Kite' : 'Variable de entorno'}
                  </div>
                  <code style={{ fontSize: '12px', fontWeight: 600 }}>
                    {vaultCredential?.preview || '••••••••••••••••'}
                  </code>
                </div>
                {vaultCredential?.source === 'vault' ? (
                  <button
                    type="button"
                    className="qt-button qt-button--ghost"
                    onClick={handleRemoveApiKey}
                    disabled={isSaving}
                    style={{ color: 'var(--status-failed)' }}
                  >
                    <TrashIcon size={13} />
                    <span>Eliminar</span>
                  </button>
                ) : (
                  <span className="qt-chip" data-tone="ok">
                    <span className="qt-status-dot" data-tone="ok" />
                    Definida en sistema
                  </span>
                )}
              </div>
            ) : null}

            <div className="qt-form">
              <input
                className="qt-input"
                type="password"
                autoComplete="off"
                placeholder={meta.apiKeyPlaceholder}
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
              />
              <div className="qt-form__actions" style={{ marginTop: '8px' }}>
                <button
                  type="button"
                  className="qt-button qt-button--primary"
                  onClick={handleSaveApiKey}
                  disabled={isSaving || !apiKeyInput.trim()}
                >
                  <KeyIcon size={13} />
                  <span>
                    {isSaving ? 'Guardando…' : isVaultConfigured ? 'Actualizar clave' : 'Guardar clave en bóveda'}
                  </span>
                </button>
                <button
                  type="button"
                  className="qt-button qt-button--ghost"
                  onClick={() => openProviderPortal(providerId)}
                  title="Obtener clave en el portal oficial"
                >
                  <span>Obtener clave en {meta.portalLabel}</span>
                  <ExternalLinkIcon size={13} />
                </button>
              </div>
            </div>
          </div>

          {meta.envVars && meta.envVars.length > 0 ? (
            <div className="qt-spec-card" style={{ marginTop: '8px' }}>
              <span className="qt-spec-card__label">Variables de entorno reconocidas</span>
              <p style={{ margin: '4px 0 6px', fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                Si prefieres configurar variables en tu sistema operativo o archivo <code>.env</code>:
              </p>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {meta.envVars.map((v) => (
                  <code key={v} style={{ fontSize: '11px', padding: '2px 6px', borderRadius: '4px', background: 'var(--chip-fill)' }}>
                    {v}
                  </code>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ── 3. Portal Tab ───────────────────────────────────────────────── */}
      {activeTab === 'portal' ? (
        <div className="qt-conn-panel__body">
          <div className="qt-spec-card">
            <span className="qt-spec-card__label">Consola y Portal Oficial</span>
            <p style={{ margin: '4px 0 10px', fontSize: '12px', color: 'var(--text-secondary)' }}>
              Accede directamente al panel oficial de {meta.name} ({meta.vendor}) para administrar tu suscripción, revisar facturación o generar claves de acceso.
            </p>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="qt-button qt-button--primary"
                onClick={() => openProviderPortal(providerId)}
              >
                <span>Abrir {meta.portalLabel} ↗</span>
                <ExternalLinkIcon size={13} />
              </button>
              {meta.cliDocUrl ? (
                <button
                  type="button"
                  className="qt-button qt-button--ghost"
                  onClick={() => openExternalLink(meta.cliDocUrl!)}
                >
                  <span>Ver documentación oficial</span>
                  <ExternalLinkIcon size={13} />
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};
