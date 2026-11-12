import React from 'react';
import {
  type ProviderQuotaStatus,
  PROVIDER_LABELS,
} from '../../../lib/quota/types';
import type { ProviderMetaConfig } from '../../../config/quotaProviderMetadata';
import { BrandLogo } from '../../views/agents/engineMetadata';
import { UsersIcon } from '../../views/settings/icons';

export interface QuotaProviderDetailPanelProps {
  selectedTab: string;
  config: ProviderMetaConfig;
  quota?: ProviderQuotaStatus;
  diagnostic: {
    state: 'ok' | 'detected' | 'signed_out' | 'error' | 'not_installed';
    statusLabel: string;
  };
  isPinned: boolean;
  isEnabled: boolean;
  onPinProvider: (id: string) => void;
  onToggleProvider: (id: string) => void;
  onOpenAccountSwitcher: () => void;
  copiedCmd: string | null;
  onCopyCommand: (cmd: string) => void;
  openCodeApiKey: string;
  setOpenCodeApiKey: (key: string) => void;
  openCodeStatus: string | null;
  onSaveOpenCode: () => void;
  onClearOpenCode: () => void;
  isVerifying: boolean;
  verifyFeedback: string | null;
  onVerifyNow: (id: string) => void;
}

export const QuotaProviderDetailPanel: React.FC<QuotaProviderDetailPanelProps> = ({
  selectedTab,
  config,
  quota,
  diagnostic,
  isPinned,
  isEnabled,
  onPinProvider,
  onToggleProvider,
  onOpenAccountSwitcher,
  copiedCmd,
  onCopyCommand,
  openCodeApiKey,
  setOpenCodeApiKey,
  openCodeStatus,
  onSaveOpenCode,
  onClearOpenCode,
  isVerifying,
  verifyFeedback,
  onVerifyNow,
}) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Provider Hero Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 16px',
          backgroundColor: 'rgba(255, 255, 255, 0.03)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: 'var(--card-radius, 12px)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span
            style={{
              width: '38px',
              height: '38px',
              borderRadius: 'var(--control-radius, 8px)',
              backgroundColor: 'rgba(255, 255, 255, 0.06)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              overflow: 'hidden',
            }}
          >
            <BrandLogo engine={selectedTab} size={24} />
          </span>

          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: '#fafafa' }}>
                {PROVIDER_LABELS[selectedTab] || selectedTab}
              </h3>

              {/* Status pill using honest diagnostic */}
              {diagnostic?.state === 'ok' ? (
                <span
                  style={{
                    fontSize: '10px',
                    padding: '2px 7px',
                    borderRadius: 'var(--vl-radius-xs, 4px)',
                    fontWeight: 600,
                    backgroundColor: 'rgba(16, 185, 129, 0.15)',
                    color: '#34d399',
                    border: '1px solid rgba(16, 185, 129, 0.3)',
                  }}
                >
                  En línea
                </span>
              ) : diagnostic?.state === 'detected' ? (
                <span
                  style={{
                    fontSize: '10px',
                    padding: '2px 7px',
                    borderRadius: 'var(--vl-radius-xs, 4px)',
                    fontWeight: 600,
                    backgroundColor: 'rgba(56, 189, 248, 0.15)',
                    color: '#38bdf8',
                    border: '1px solid rgba(56, 189, 248, 0.3)',
                  }}
                >
                  Sesión local activa
                </span>
              ) : diagnostic?.state === 'signed_out' ? (
                <span
                  style={{
                    fontSize: '10px',
                    padding: '2px 7px',
                    borderRadius: 'var(--vl-radius-xs, 4px)',
                    fontWeight: 600,
                    backgroundColor: 'rgba(245, 158, 11, 0.15)',
                    color: '#fbbf24',
                    border: '1px solid rgba(245, 158, 11, 0.3)',
                  }}
                >
                  Sesión requerida
                </span>
              ) : diagnostic?.state === 'error' ? (
                <span
                  style={{
                    fontSize: '10px',
                    padding: '2px 7px',
                    borderRadius: 'var(--vl-radius-xs, 4px)',
                    fontWeight: 600,
                    backgroundColor: 'rgba(244, 63, 94, 0.15)',
                    color: '#f43f5e',
                    border: '1px solid rgba(244, 63, 94, 0.3)',
                  }}
                >
                  Atención requerida
                </span>
              ) : (
                <span
                  style={{
                    fontSize: '10px',
                    padding: '2px 7px',
                    borderRadius: 'var(--vl-radius-xs, 4px)',
                    fontWeight: 500,
                    backgroundColor: 'rgba(255, 255, 255, 0.08)',
                    color: '#a1a1aa',
                  }}
                >
                  No detectado
                </span>
              )}
            </div>
            <div style={{ fontSize: '11px', color: '#a1a1aa', marginTop: '2px' }}>
              {config.desc}
            </div>
          </div>
        </div>

        {/* Actions right */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button
            type="button"
            onClick={() => onPinProvider(selectedTab)}
            title={
              isPinned
                ? 'Desfijar de la barra superior'
                : `Fijar ${PROVIDER_LABELS[selectedTab]} como predeterminado`
            }
            style={{
              background: isPinned
                ? 'rgba(245, 158, 11, 0.15)'
                : 'rgba(255, 255, 255, 0.06)',
              border: isPinned
                ? '1px solid rgba(245, 158, 11, 0.3)'
                : '1px solid rgba(255, 255, 255, 0.1)',
              borderRadius: 'var(--control-radius, 8px)',
              padding: '5px 9px',
              color: isPinned ? '#fbbf24' : '#a1a1aa',
              fontSize: '11px',
              fontWeight: 500,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
            }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill={isPinned ? '#fbbf24' : 'none'}
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            <span>{isPinned ? 'Predeterminado' : 'Fijar'}</span>
          </button>

          <button
            type="button"
            role="switch"
            aria-checked={isEnabled}
            aria-label={`Activar ${PROVIDER_LABELS[selectedTab]}`}
            className="ui-switch"
            onClick={() => onToggleProvider(selectedTab)}
            style={{ cursor: 'pointer' }}
          >
            <span aria-hidden="true" className="ui-switch__knob" />
          </button>
        </div>
      </div>

      {/* Connection Status & Diagnostics Card */}
      <div
        style={{
          backgroundColor: 'rgba(255, 255, 255, 0.03)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: 'var(--card-radius, 12px)',
          padding: '14px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        <h4 style={{ margin: 0, fontSize: '12px', fontWeight: 600, color: '#e4e4e7', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          Diagnóstico de Conexión
        </h4>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px' }}>
          <div style={{ backgroundColor: 'rgba(0, 0, 0, 0.25)', padding: '8px 10px', borderRadius: 'var(--control-radius, 8px)' }}>
            <div style={{ fontSize: '10px', color: '#71717a' }}>FUENTE DETECTADA</div>
            <div style={{ fontSize: '11px', color: '#e4e4e7', marginTop: '2px', wordBreak: 'break-all' }}>
              {quota?.metadata?.source
                ? String(quota.metadata.source)
                : config.source}
            </div>
          </div>

          <div style={{ backgroundColor: 'rgba(0, 0, 0, 0.25)', padding: '8px 10px', borderRadius: 'var(--control-radius, 8px)' }}>
            <div style={{ fontSize: '10px', color: '#71717a' }}>CUENTA / PLAN</div>
            <div style={{ fontSize: '11px', color: '#e4e4e7', marginTop: '2px' }}>
              {quota?.metadata?.email
                ? String(quota.metadata.email)
                : quota?.metadata?.userName
                ? String(quota.metadata.userName)
                : quota?.metadata?.planType
                ? `Plan: ${quota.metadata.planType}`
                : quota?.metadata?.balance
                ? `Saldo: ${quota.metadata.balance}`
                : diagnostic?.state === 'ok' || diagnostic?.state === 'detected'
                ? 'Sesión activa'
                : 'No autenticado'}
            </div>
          </div>
        </div>

        {/* Error / Warning banner if present */}
        {quota?.error && (
          <div
            style={{
              backgroundColor: 'rgba(245, 158, 11, 0.08)',
              border: '1px solid rgba(245, 158, 11, 0.25)',
              borderRadius: 'var(--control-radius, 8px)',
              padding: '8px 12px',
              fontSize: '11px',
              color: '#fbbf24',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '8px',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: '2px' }}>
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <span style={{ flex: 1, lineHeight: 1.4 }}>{quota.error}</span>
          </div>
        )}
      </div>

      {/* Multi-Account Switcher Vault Card */}
      {['antigravity', 'claude', 'codex', 'opencode', 'grok'].includes(selectedTab) && (
        <div
          style={{
            backgroundColor: 'rgba(59, 130, 246, 0.08)',
            border: '1px solid rgba(59, 130, 246, 0.28)',
            borderRadius: 'var(--card-radius, 12px)',
            padding: '14px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '14px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
            <div
              style={{
                width: '38px',
                height: '38px',
                borderRadius: 'var(--control-radius, 8px)',
                backgroundColor: 'rgba(59, 130, 246, 0.2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                color: '#60a5fa',
              }}
            >
              <UsersIcon size={18} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: '#f4f4f5', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>Gestor de Cuentas ({PROVIDER_LABELS[selectedTab] || selectedTab})</span>
                <span style={{ fontSize: '10px', padding: '1px 6px', borderRadius: 'var(--vl-radius-xs, 4px)', backgroundColor: 'rgba(16, 185, 129, 0.2)', color: '#34d399', fontWeight: 500 }}>
                  Multi-Suscripción
                </span>
              </div>
              <div style={{ fontSize: '11px', color: '#93c5fd', marginTop: '3px' }}>
                Guarda tus distintas suscripciones (Google AI Pro, Claude, etc.) y rota entre ellas en 1 clic sin volver al navegador.
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={onOpenAccountSwitcher}
            style={{
              padding: '8px 16px',
              borderRadius: 'var(--control-radius, 8px)',
              backgroundColor: '#2563eb',
              color: '#ffffff',
              border: 'none',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              whiteSpace: 'nowrap',
              boxShadow: '0 2px 8px rgba(37, 99, 235, 0.35)',
              flexShrink: 0,
            }}
          >
            <span>Abrir Gestor de Cuentas</span>
            <span>→</span>
          </button>
        </div>
      )}

      {/* Instructions & Step-by-Step Login Card */}
      <div
        style={{
          backgroundColor: 'rgba(255, 255, 255, 0.03)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: 'var(--card-radius, 12px)',
          padding: '14px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        <h4 style={{ margin: 0, fontSize: '12px', fontWeight: 600, color: '#e4e4e7', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          Guía de Conexión
        </h4>

        <p style={{ margin: 0, fontSize: '12px', color: '#d4d4d8', lineHeight: 1.5 }}>
          {config.details}
        </p>

        {/* CLI Login Command Box */}
        {config.loginCmd && (
          <div>
            <div style={{ fontSize: '11px', color: '#a1a1aa', marginBottom: '6px' }}>
              Comando para iniciar sesión en la terminal de tu equipo:
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                backgroundColor: '#0a0a0c',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: 'var(--control-radius, 8px)',
                padding: '8px 12px',
              }}
            >
              <code style={{ fontSize: '12px', color: '#34d399', fontFamily: 'monospace' }}>
                {config.loginCmd}
              </code>
              <button
                type="button"
                onClick={() => onCopyCommand(config.loginCmd!)}
                style={{
                  background: 'rgba(255, 255, 255, 0.08)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  borderRadius: 'var(--control-radius, 8px)',
                  padding: '4px 10px',
                  color: '#e4e4e7',
                  fontSize: '11px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                }}
              >
                {copiedCmd === config.loginCmd ? (
                  <>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <span style={{ color: '#34d399' }}>Copiado</span>
                  </>
                ) : (
                  <>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                    </svg>
                    <span>Copiar comando</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* OpenCode Go specific form */}
        {config.connectionType === 'opencode_form' && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              marginTop: '4px',
              padding: '12px',
              backgroundColor: 'rgba(0, 0, 0, 0.25)',
              borderRadius: 'var(--control-radius, 8px)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
            }}
          >
            <div
              style={{
                fontSize: '10px',
                lineHeight: 1.6,
                color: '#a1a1aa',
                padding: '8px',
                borderRadius: 'var(--control-radius, 8px)',
                backgroundColor: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.06)',
              }}
            >
              <div>
                <strong style={{ color: '#e4e4e7' }}>Detección:</strong>{' '}
                {String(quota?.metadata?.authSource || 'sin credenciales detectadas')}
              </div>
              <div>
                <strong style={{ color: '#e4e4e7' }}>Endpoint:</strong>{' '}
                {String(quota?.metadata?.endpoint || '—')}
              </div>
              <div>
                <strong style={{ color: '#e4e4e7' }}>Último estado:</strong>{' '}
                {quota?.metadata?.httpStatus
                  ? `HTTP ${quota.metadata.httpStatus}`
                  : 'sin respuesta'}{' '}
                ·{' '}
                {quota?.error ||
                  (quota
                    ? `${Math.round(quota.primaryRemainingPercent)}% restante`
                    : '—')}
              </div>
              {quota?.metadata?.legacyNote && (
                <div style={{ color: '#fbbf24', marginTop: '2px' }}>
                  {String(quota.metadata.legacyNote)}
                </div>
              )}
            </div>

            <div>
              <label style={{ fontSize: '11px', fontWeight: 500, color: '#a1a1aa' }}>
                API key de OpenCode Go
              </label>
              <input
                type="password"
                placeholder="sk-... (opcional si OpenCode ya está logueado)"
                autoComplete="off"
                value={openCodeApiKey}
                onChange={(e) => setOpenCodeApiKey(e.target.value)}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  marginTop: '4px',
                  padding: '6px 10px',
                  backgroundColor: '#0a0a0c',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  borderRadius: 'var(--control-radius, 8px)',
                  color: '#fafafa',
                  fontSize: '11px',
                  fontFamily: 'monospace',
                }}
              />
            </div>

            <div style={{ fontSize: '10px', color: '#71717a', lineHeight: 1.5 }}>
              Kite detecta la sesión de OpenCode automáticamente. Guardá una API key solo
              si querés forzar otra cuenta. La API oficial es{' '}
              <code>opencode.ai/zen/go/v1/usage</code>.
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
              <button
                type="button"
                onClick={onSaveOpenCode}
                style={{
                  padding: '5px 12px',
                  borderRadius: 'var(--control-radius, 8px)',
                  backgroundColor: '#10b981',
                  border: 'none',
                  color: '#ffffff',
                  fontSize: '11px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Guardar API key
              </button>
              <button
                type="button"
                onClick={onClearOpenCode}
                style={{
                  padding: '5px 12px',
                  borderRadius: 'var(--control-radius, 8px)',
                  backgroundColor: 'rgba(255, 255, 255, 0.08)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: '#a1a1aa',
                  fontSize: '11px',
                  cursor: 'pointer',
                }}
              >
                Quitar clave de Kite
              </button>
              {openCodeStatus && (
                <span style={{ fontSize: '11px', color: '#34d399' }}>{openCodeStatus}</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Verification Footer Action with real status */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          backgroundColor: 'rgba(255, 255, 255, 0.02)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: 'var(--card-radius, 12px)',
        }}
      >
        <div style={{ fontSize: '11px', color: '#a1a1aa', flex: 1, marginRight: '12px' }}>
          {verifyFeedback ? (
            <span
              style={{
                color:
                  verifyFeedback.includes('Error') || verifyFeedback.includes('no entrega')
                    ? '#fbbf24'
                    : '#34d399',
                fontWeight: 500,
              }}
            >
              {verifyFeedback}
            </span>
          ) : (
            'Comprueba la conexión en tiempo real contra las credenciales del equipo'
          )}
        </div>

        <button
          type="button"
          onClick={() => onVerifyNow(selectedTab)}
          disabled={isVerifying}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 14px',
            borderRadius: 'var(--control-radius, 8px)',
            backgroundColor: 'rgba(255, 255, 255, 0.1)',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            color: '#fafafa',
            fontSize: '11px',
            fontWeight: 500,
            cursor: isVerifying ? 'wait' : 'pointer',
            flexShrink: 0,
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              animation: isVerifying ? 'spin 1s linear infinite' : 'none',
            }}
          >
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
            <path d="M16 21h5v-5" />
          </svg>
          <span>{isVerifying ? 'Verificando...' : `Verificar ${PROVIDER_LABELS[selectedTab]}`}</span>
        </button>
      </div>
    </div>
  );
};
