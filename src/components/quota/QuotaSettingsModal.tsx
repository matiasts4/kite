import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  type ProviderQuotaStatus,
  type QuotaPreferences,
  PROVIDERS,
  PROVIDER_LABELS,
  ALL_SUPPORTED_PROVIDERS,
} from '../../lib/quota/types';
import { BrandLogo } from '../views/agents/engineMetadata';
import {
  readQuotaPreferences,
  saveQuotaPreferences,
  subscriptionQuotaManager,
  QUOTA_PREFS_CHANGED_EVENT,
} from '../../lib/quota/quotaManager';
import { diagnoseProvider } from '../../lib/quota/providerState';
import { saveOpenCodeApiKey, clearOpenCodeApiKey } from '../../lib/ipc';
import { AccountSwitcherModal } from './AccountSwitcherModal';
import { UsersIcon, ChevronUpIcon, ChevronDownIcon } from '../views/settings/icons';
import { usePresence } from '../../motion/usePresence';
import { motionSurfaceClass } from '../../motion/surface';

export interface QuotaSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  allQuotas?: Record<string, ProviderQuotaStatus>;
  initialSelectedProvider?: string;
}

export interface ProviderMetaConfig {
  title: string;
  desc: string;
  source: string;
  loginCmd?: string;
  connectionType: 'cli_oauth' | 'local_rpc' | 'local_config' | 'api_key' | 'opencode_form';
  details: string;
}

export const PROVIDER_CONFIGS_ES: Record<string, ProviderMetaConfig> = {
  [PROVIDERS.ANTIGRAVITY]: {
    title: 'Google Antigravity Language Server',
    desc: 'Límites de modelos Gemini Pro, Ultra y Claude Sonnet a través del Language Server local.',
    source: 'language_server.exe (Conexión local por RPC Connect)',
    connectionType: 'local_rpc',
    details:
      'Se conecta automáticamente al proceso local `language_server.exe` en tu equipo mediante Connect RPC y token CSRF. No requiere iniciar sesión manualmente ni ingresar claves de API en la aplicación.',
  },
  [PROVIDERS.CURSOR]: {
    title: 'Cursor Agent & IDE',
    desc: 'Cuotas de modelos de Cursor (Auto y API), créditos incluidos y ciclo de facturación.',
    source: 'Cursor IDE (state.vscdb) o ~/.cursor/auth.json',
    loginCmd: 'cursor-agent login',
    connectionType: 'cli_oauth',
    details:
      'Detecta automáticamente la sesión autenticada de Cursor IDE desde su base de datos local o credenciales de CLI. Si no has iniciado sesión o tu token expiró, abre Cursor o ejecuta `cursor-agent login`.',
  },
  [PROVIDERS.GROK]: {
    title: 'xAI Grok CLI & Build',
    desc: 'Monitoreo de suscripción SuperGrok, créditos semanales y consumo de modelos Grok.',
    source: '~/.grok/auth.json',
    loginCmd: 'grok login',
    connectionType: 'cli_oauth',
    details:
      'Detecta las credenciales de sesión en `~/.grok/auth.json`. Nota importante de xAI: Si tu cuenta tiene configurado Privacy Mode como "Legacy (no storage)", xAI no expone el saldo de créditos vía API hasta activar el modo Privacy estándar en la consola de Grok.',
  },
  [PROVIDERS.QODER]: {
    title: 'Qoder CLI',
    desc: 'Créditos del plan y add-ons para Qoder CLI analizados en tiempo real.',
    source: '~/.qoder/logs/runs/*/qodercli.log',
    loginCmd: 'qodercli',
    connectionType: 'local_config',
    details:
      'Lee el uso de créditos y balance reportado por Qoder CLI en los registros locales de ejecución en `~/.qoder`. Ejecuta una sesión con `qodercli` para refrescar los datos de cuota.',
  },
  [PROVIDERS.CLAUDE]: {
    title: 'Claude Code (Anthropic)',
    desc: 'Sesión de 5 horas, límites semanales de Sonnet y cuota mensual de Claude Pro / Team.',
    source: '~/.claude/.credentials.json o ANTHROPIC_OAUTH_TOKEN',
    loginCmd: 'claude login',
    connectionType: 'cli_oauth',
    details:
      'Monitorea el endpoint OAuth oficial de Anthropic. Requiere haber iniciado sesión en Claude Code CLI ejecutando `claude login` o haber definido la variable de entorno ANTHROPIC_OAUTH_TOKEN.',
  },
  [PROVIDERS.CODEX]: {
    title: 'OpenAI Codex',
    desc: 'Rate limits de sesión de 5 horas, tope semanal y revisiones de código de ChatGPT / Codex.',
    source: '~/.codex/config.toml y ~/.codex/auth.json',
    loginCmd: 'codex login',
    connectionType: 'cli_oauth',
    details:
      'Consulta los límites oficiales mediante el backend de ChatGPT. Requiere haber ejecutado `codex login` en tu terminal para almacenar la sesión OAuth en `~/.codex/auth.json`.',
  },
  [PROVIDERS.KIMI]: {
    title: 'Moonshot Kimi Code',
    desc: 'Límite semanal, ventana de 5 horas y saldo de billetera booster de Kimi Code.',
    source: '~/.kimi-code/credentials/kimi-code.json',
    loginCmd: 'kimi login',
    connectionType: 'cli_oauth',
    details:
      'Lee las credenciales OAuth en `~/.kimi-code/credentials/kimi-code.json` y refresca el token automáticamente. Si el token de actualización expira o la sesión caduca, ejecuta `kimi login` en la terminal.',
  },
  [PROVIDERS.COPILOT]: {
    title: 'GitHub Copilot CLI',
    desc: 'Límites de peticiones y cuota de GitHub Copilot.',
    source: '~/.copilot/config.json',
    loginCmd: 'gh copilot auth',
    connectionType: 'cli_oauth',
    details:
      'Detecta la instalación de GitHub Copilot CLI en `~/.copilot` o la autenticación de la CLI de GitHub.',
  },
  [PROVIDERS.DROID]: {
    title: 'Factory Droid',
    desc: 'Créditos y asignaciones de equipo de Factory Droid.',
    source: '~/.factory/',
    connectionType: 'local_config',
    details:
      'Detecta la configuración y credenciales del entorno de Factory Droid en `~/.factory`.',
  },
  [PROVIDERS.DEEPSEEK]: {
    title: 'DeepSeek API',
    desc: 'Uso de tokens y saldo de API para modelos DeepSeek R1 y V3.',
    source: 'Variable de entorno DEEPSEEK_API_KEY',
    connectionType: 'api_key',
    details:
      'Requiere definir la variable de entorno `DEEPSEEK_API_KEY` en tu sistema operativo con una clave de API válida de DeepSeek. Kite consulta el saldo directamente a api.deepseek.com.',
  },
  [PROVIDERS.OPENCODE]: {
    title: 'OpenCode Go',
    desc: 'Ventanas de cuota de 5 horas, semanal y mensual de tu suscripción OpenCode Go.',
    source: 'OpenCode CLI (opencode.db / auth.json), OPENCODE_API_KEY o API key guardada en Kite',
    loginCmd: 'opencode auth login opencode-go',
    connectionType: 'opencode_form',
    details:
      'Kite detecta automáticamente la sesión de OpenCode. Si no la encuentra, ejecutá `opencode auth login opencode-go` o guardá una API key de OpenCode Go. La cookie y el workspace legacy ya no se usan: la API oficial de cuotas requiere una API key.',
  },
};

export const QuotaSettingsModal: React.FC<QuotaSettingsModalProps> = ({
  isOpen,
  onClose,
  allQuotas = {},
  initialSelectedProvider,
}) => {
  const [prefs, setPrefs] = useState<QuotaPreferences>(() => readQuotaPreferences());
  const [selectedTab, setSelectedTab] = useState<string>(() => initialSelectedProvider || 'general');
  const [searchFilter, setSearchFilter] = useState<string>('');
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [verifyFeedback, setVerifyFeedback] = useState<string | null>(null);

  // OpenCode Go form state
  const [openCodeApiKey, setOpenCodeApiKey] = useState<string>('');
  const [openCodeStatus, setOpenCodeStatus] = useState<string | null>(null);

  // Multi-Account Switcher modal state
  const [accountSwitcherOpen, setAccountSwitcherOpen] = useState<boolean>(false);

  useEffect(() => {
    if (!isOpen) return;
    setPrefs(readQuotaPreferences());
    if (initialSelectedProvider) {
      setSelectedTab(initialSelectedProvider);
    }
  }, [isOpen, initialSelectedProvider]);

  useEffect(() => {
    const handler = (e: any) => {
      if (e?.detail) setPrefs(e.detail);
    };
    window.addEventListener(QUOTA_PREFS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(QUOTA_PREFS_CHANGED_EVENT, handler);
  }, []);

  const enabledSet = useMemo(() => {
    return new Set(prefs.enabledProviders ?? []);
  }, [prefs.enabledProviders]);

  const filteredProviders = useMemo(() => {
    if (!searchFilter.trim()) return ALL_SUPPORTED_PROVIDERS;
    const query = searchFilter.toLowerCase().trim();
    return ALL_SUPPORTED_PROVIDERS.filter((id) => {
      const label = PROVIDER_LABELS[id] || id;
      return label.toLowerCase().includes(query) || id.toLowerCase().includes(query);
    });
  }, [searchFilter]);

  const layerPresence = usePresence(isOpen);
  if (!layerPresence.mounted) return null;

  const scrimMotion = motionSurfaceClass(layerPresence.phase, 'scrim');
  const panelMotion = motionSurfaceClass(layerPresence.phase, 'modal');

  const handleToggleMaster = () => {
    saveQuotaPreferences({ enabled: !prefs.enabled });
  };

  const handleToggleAutoDetect = () => {
    saveQuotaPreferences({ autoDetectActive: !prefs.autoDetectActive });
  };

  const handleToggleProvider = (providerId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const currentEnabled = new Set(prefs.enabledProviders ?? []);
    if (currentEnabled.has(providerId)) {
      currentEnabled.delete(providerId);
    } else {
      currentEnabled.add(providerId);
    }
    saveQuotaPreferences({ enabledProviders: Array.from(currentEnabled) });
  };

  const handleEnableAll = () => {
    saveQuotaPreferences({ enabledProviders: [...ALL_SUPPORTED_PROVIDERS] });
  };

  const handleDisableAll = () => {
    saveQuotaPreferences({ enabledProviders: [] });
  };

  const handleEnableConnectedOnly = () => {
    const connected = ALL_SUPPORTED_PROVIDERS.filter((id) => {
      const q = allQuotas[id];
      const d = diagnoseProvider(q);
      return d.state === 'ok' || d.state === 'detected';
    });
    saveQuotaPreferences({ enabledProviders: connected });
  };

  const handlePinProvider = (providerId: string) => {
    const nextPin = prefs.pinnedProvider === providerId ? null : providerId;
    saveQuotaPreferences({ pinnedProvider: nextPin });
  };

  const handleMoveProviderOrder = (providerId: string, direction: 'up' | 'down') => {
    const order = [...prefs.providerOrder];
    const index = order.indexOf(providerId);
    if (index === -1) return;
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= order.length) return;
    const temp = order[index];
    order[index] = order[targetIndex];
    order[targetIndex] = temp;
    saveQuotaPreferences({ providerOrder: order });
  };

  const handleSetDisplayMode = (mode: 'percent_remaining' | 'percent_used' | 'compact') => {
    saveQuotaPreferences({ displayMode: mode });
  };

  const handleCopyCommand = async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedCmd(cmd);
      setTimeout(() => setCopiedCmd(null), 2500);
    } catch (_) {}
  };

  const handleVerifyNow = async (targetId?: string) => {
    setIsVerifying(true);
    setVerifyFeedback(null);
    try {
      const fresh = await subscriptionQuotaManager.fetchAll(true);
      const target = targetId || (selectedTab !== 'general' ? selectedTab : undefined);
      if (target && fresh[target]) {
        const q = fresh[target];
        const d = diagnoseProvider(q);
        if (d.state === 'ok') {
          const rem = q.primaryRemainingPercent;
          setVerifyFeedback(`${q.displayName}: En línea y respondiendo (${rem}% restante)`);
        } else if (d.state === 'detected') {
          setVerifyFeedback(`${q.displayName}: Sesión local detectada activamente`);
        } else if (d.state === 'error' || d.state === 'signed_out') {
          setVerifyFeedback(`${q.displayName}: ${d.detail || d.statusLabel}`);
        } else {
          setVerifyFeedback(`${q.displayName}: No se encontraron credenciales`);
        }
      } else {
        setVerifyFeedback('Estado actualizado con las credenciales locales');
      }
    } catch (err: any) {
      setVerifyFeedback(`Error al verificar: ${err?.message || 'Fallo de conexión'}`);
    } finally {
      setIsVerifying(false);
      setTimeout(() => setVerifyFeedback(null), 5000);
    }
  };

  const handleSaveOpenCode = async () => {
    if (!openCodeApiKey.trim()) return;
    setOpenCodeStatus('Guardando...');
    try {
      const ok = await saveOpenCodeApiKey(openCodeApiKey.trim());
      if (ok) {
        setOpenCodeStatus('API key guardada correctamente');
        setOpenCodeApiKey('');
        await subscriptionQuotaManager.fetchAll(true);
      } else {
        setOpenCodeStatus('Error al guardar la API key');
      }
    } catch (err: any) {
      setOpenCodeStatus(`Error: ${err?.message || 'Fallo al guardar'}`);
    }
    setTimeout(() => setOpenCodeStatus(null), 3500);
  };

  const handleClearOpenCode = async () => {
    setOpenCodeStatus('Limpiando...');
    try {
      await clearOpenCodeApiKey();
      setOpenCodeStatus('Clave de Kite eliminada; la detección de OpenCode sigue activa');
      setOpenCodeApiKey('');
      await subscriptionQuotaManager.fetchAll(true);
    } catch (err: any) {
      setOpenCodeStatus(`Error: ${err?.message || 'Fallo al limpiar'}`);
    }
    setTimeout(() => setOpenCodeStatus(null), 3000);
  };

  const currentSelectedQuota = selectedTab !== 'general' ? allQuotas[selectedTab] : null;
  const currentSelectedConfig = selectedTab !== 'general' ? PROVIDER_CONFIGS_ES[selectedTab] : null;
  const currentSelectedDiag = selectedTab !== 'general' ? diagnoseProvider(currentSelectedQuota) : null;

  return createPortal(
    <div
      className={`usage-dash-portal-backdrop${scrimMotion ? ` ${scrimMotion}` : ''}`}
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10002,
        backgroundColor: 'rgba(0, 0, 0, 0.78)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Configuración de Cuotas y Proveedores IA"
        onClick={(e) => e.stopPropagation()}
        className={panelMotion || undefined}
        style={{
          width: '100%',
          maxWidth: '860px',
          height: '640px',
          maxHeight: '92vh',
          backgroundColor: '#121215',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          borderRadius: '14px',
          boxShadow: '0 30px 70px rgba(0, 0, 0, 0.85), 0 0 0 1px rgba(255, 255, 255, 0.06)',
          color: '#f4f4f5',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 20px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            backgroundColor: 'rgba(255, 255, 255, 0.02)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                backgroundColor: 'rgba(52, 211, 153, 0.15)',
                color: '#34d399',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid rgba(52, 211, 153, 0.25)',
              }}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
            </span>
            <div>
              <h2 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: '#fafafa' }}>
                Configuración de Cuotas y Proveedores IA
              </h2>
              <p style={{ margin: '2px 0 0', fontSize: '11px', color: '#a1a1aa' }}>
                Monitoreo en tiempo real, detección de cuentas locales y verificación de sesión
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar configuración"
            style={{
              background: 'none',
              border: 'none',
              padding: '6px',
              borderRadius: '6px',
              color: '#a1a1aa',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* 2-Column Body */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {/* Left Sidebar */}
          <div
            style={{
              width: '280px',
              borderRight: '1px solid rgba(255, 255, 255, 0.08)',
              backgroundColor: 'rgba(0, 0, 0, 0.25)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            {/* General item */}
            <div style={{ padding: '10px 12px 6px' }}>
              <button
                type="button"
                onClick={() => setSelectedTab('general')}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: selectedTab === 'general' ? '1px solid rgba(52, 211, 153, 0.3)' : '1px solid transparent',
                  background: selectedTab === 'general' ? 'rgba(52, 211, 153, 0.12)' : 'rgba(255, 255, 255, 0.04)',
                  color: selectedTab === 'general' ? '#34d399' : '#d4d4d8',
                  textAlign: 'left',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 120ms ease',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
                <span>Preferencias Generales</span>
              </button>
            </div>

            {/* Quick Filter & Bulk Actions */}
            <div style={{ padding: '0 12px 8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ position: 'relative' }}>
                <input
                  type="text"
                  placeholder="Buscar proveedor..."
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: '5px 10px 5px 26px',
                    fontSize: '11px',
                    backgroundColor: '#0a0a0c',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '6px',
                    color: '#fafafa',
                  }}
                />
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ position: 'absolute', left: '8px', top: '7px', color: '#71717a' }}
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </div>

              {/* Bulk action buttons */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <button
                  type="button"
                  onClick={handleEnableAll}
                  style={{
                    flex: 1,
                    padding: '3px 4px',
                    fontSize: '10px',
                    backgroundColor: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '4px',
                    color: '#a1a1aa',
                    cursor: 'pointer',
                  }}
                  title="Habilitar todos los proveedores"
                >
                  Todos
                </button>
                <button
                  type="button"
                  onClick={handleDisableAll}
                  style={{
                    flex: 1,
                    padding: '3px 4px',
                    fontSize: '10px',
                    backgroundColor: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '4px',
                    color: '#a1a1aa',
                    cursor: 'pointer',
                  }}
                  title="Deshabilitar todos los proveedores"
                >
                  Ninguno
                </button>
                <button
                  type="button"
                  onClick={handleEnableConnectedOnly}
                  style={{
                    flex: 1.4,
                    padding: '3px 4px',
                    fontSize: '10px',
                    backgroundColor: 'rgba(52, 211, 153, 0.1)',
                    border: '1px solid rgba(52, 211, 153, 0.2)',
                    borderRadius: '4px',
                    color: '#34d399',
                    cursor: 'pointer',
                  }}
                  title="Habilitar solo los proveedores con sesión activa o detectada"
                >
                  Solo activos
                </button>
              </div>
            </div>

            <div
              style={{
                padding: '6px 12px 4px',
                fontSize: '10px',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: '#71717a',
                display: 'flex',
                justifyContent: 'space-between',
              }}
            >
              <span>Proveedores</span>
              <span>{enabledSet.size} activos</span>
            </div>

            {/* Providers list with FAST TOGGLES IN EVERY ROW */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 6px 10px' }}>
              {filteredProviders.map((id) => {
                const label = PROVIDER_LABELS[id] || id;
                const isSelected = selectedTab === id;
                const isEnabled = enabledSet.has(id);
                const isPinned = prefs.pinnedProvider === id;
                const q = allQuotas[id];
                const d = diagnoseProvider(q);

                return (
                  <div
                    key={id}
                    onClick={() => setSelectedTab(id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '6px 8px',
                      marginBottom: '2px',
                      borderRadius: '6px',
                      background: isSelected
                        ? 'rgba(255, 255, 255, 0.08)'
                        : 'transparent',
                      borderLeft: isSelected ? '3px solid #34d399' : '3px solid transparent',
                      color: isSelected ? '#fafafa' : isEnabled ? '#d4d4d8' : '#71717a',
                      cursor: 'pointer',
                      transition: 'all 100ms ease',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1 }}>
                      <span
                        style={{
                          width: '20px',
                          height: '20px',
                          borderRadius: '4px',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          backgroundColor: 'rgba(255, 255, 255, 0.05)',
                          overflow: 'hidden',
                        }}
                      >
                        <BrandLogo engine={id} size={14} />
                      </span>

                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            fontSize: '11px',
                            fontWeight: isSelected ? 600 : 500,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {label}
                        </div>
                      </div>

                      {/* State dot */}
                      <span
                        style={{
                          width: '6px',
                          height: '6px',
                          borderRadius: '50%',
                          flexShrink: 0,
                          backgroundColor:
                            d.state === 'ok'
                              ? '#10b981'
                              : d.state === 'detected'
                              ? '#38bdf8'
                              : d.state === 'signed_out' || d.state === 'error'
                              ? '#f59e0b'
                              : 'rgba(255, 255, 255, 0.2)',
                        }}
                        title={d.statusLabel}
                      />
                    </div>

                    {/* Actions right: Pin & FAST TOGGLE SWITCH */}
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0, marginLeft: '6px' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {isPinned && (
                        <span title="Fijado como predeterminado" style={{ display: 'inline-flex', alignItems: 'center' }}>
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 24 24"
                            fill="#fbbf24"
                            stroke="#fbbf24"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                          </svg>
                        </span>
                      )}

                      {/* Fast Switch on the row */}
                      <button
                        type="button"
                        role="switch"
                        aria-checked={isEnabled}
                        aria-label={`Alternar ${label}`}
                        className="ui-switch"
                        onClick={(e) => handleToggleProvider(id, e)}
                        style={{
                          cursor: 'pointer',
                          transform: 'scale(0.85)',
                          transformOrigin: 'right center',
                        }}
                      >
                        <span aria-hidden="true" className="ui-switch__knob" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right Main Content */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {selectedTab === 'general' ? (
              /* General Preferences View */
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div>
                  <h3 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600, color: '#fafafa' }}>
                    Preferencias de Visualización y Detección
                  </h3>
                  <p style={{ margin: 0, fontSize: '11px', color: '#a1a1aa' }}>
                    Personaliza cómo se integran las cuotas de IA en la cabecera de la aplicación
                  </p>
                </div>

                <div
                  style={{
                    backgroundColor: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '10px',
                    overflow: 'hidden',
                  }}
                >
                  {/* Row 1: Master enable */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 14px',
                      borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 500, color: '#fafafa' }}>
                        Mostrar medidor de cuota en barra superior
                      </div>
                      <div style={{ fontSize: '11px', color: '#a1a1aa', marginTop: '2px' }}>
                        Pastilla en tiempo real en la cabecera con porcentaje y cuenta regresiva de reseteo.
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={prefs.enabled}
                      aria-label="Activar medidor de cuota"
                      className="ui-switch"
                      onClick={handleToggleMaster}
                      style={{ cursor: 'pointer' }}
                    >
                      <span aria-hidden="true" className="ui-switch__knob" />
                    </button>
                  </div>

                  {/* Row 2: Auto-detect */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 14px',
                      borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 500, color: '#fafafa' }}>
                        Detección automática del agente activo
                      </div>
                      <div style={{ fontSize: '11px', color: '#a1a1aa', marginTop: '2px' }}>
                        Alterna automáticamente la pastilla para reflejar el modelo que esté respondiendo en el chat.
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={prefs.autoDetectActive}
                      aria-label="Activar detección automática"
                      className="ui-switch"
                      onClick={handleToggleAutoDetect}
                      style={{ cursor: 'pointer' }}
                    >
                      <span aria-hidden="true" className="ui-switch__knob" />
                    </button>
                  </div>

                  {/* Row 3: Display Mode */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 14px',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 500, color: '#fafafa' }}>
                        Formato del texto en la pastilla
                      </div>
                      <div style={{ fontSize: '11px', color: '#a1a1aa', marginTop: '2px' }}>
                        Estilo numérico que se mostrará junto al logo en la barra superior.
                      </div>
                    </div>
                    <div
                      style={{
                        display: 'inline-flex',
                        backgroundColor: 'rgba(255, 255, 255, 0.06)',
                        borderRadius: '6px',
                        padding: '2px',
                        border: '1px solid rgba(255, 255, 255, 0.08)',
                      }}
                    >
                      {[
                        { id: 'percent_remaining', label: '% Restante' },
                        { id: 'percent_used', label: '% Usado' },
                        { id: 'compact', label: 'Compacto' },
                      ].map((opt) => {
                        const isSel = prefs.displayMode === opt.id;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => handleSetDisplayMode(opt.id as any)}
                            style={{
                              background: isSel ? 'rgba(255, 255, 255, 0.12)' : 'none',
                              border: 'none',
                              padding: '4px 9px',
                              borderRadius: '4px',
                              color: isSel ? '#fafafa' : '#a1a1aa',
                              fontSize: '11px',
                              fontWeight: isSel ? 600 : 400,
                              cursor: 'pointer',
                            }}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Priority / Order management */}
                <div
                  style={{
                    backgroundColor: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '10px',
                    padding: '14px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                  }}
                >
                  <div style={{ fontSize: '13px', fontWeight: 500, color: '#fafafa' }}>
                    Prioridad de Proveedores en la Barra Superior
                  </div>
                  <div style={{ fontSize: '11px', color: '#a1a1aa' }}>
                    Cuando no hay un modelo activo en el chat, el sistema mostrará el primer proveedor disponible en este orden:
                  </div>

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' }}>
                    {prefs.providerOrder.map((id, index) => {
                      const label = PROVIDER_LABELS[id] || id;
                      const isEnabled = enabledSet.has(id);
                      return (
                        <div
                          key={id}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '6px',
                            padding: '4px 8px',
                            borderRadius: '6px',
                            backgroundColor: isEnabled ? 'rgba(255, 255, 255, 0.06)' : 'rgba(255, 255, 255, 0.02)',
                            border: '1px solid rgba(255, 255, 255, 0.08)',
                            fontSize: '11px',
                            color: isEnabled ? '#e4e4e7' : '#71717a',
                          }}
                        >
                          <span style={{ fontSize: '10px', color: '#71717a' }}>{index + 1}.</span>
                          <BrandLogo engine={id} size={12} />
                          <span>{label}</span>

                          <div style={{ display: 'flex', alignItems: 'center', gap: '2px', marginLeft: '4px' }}>
                            {index > 0 && (
                              <button
                                type="button"
                                onClick={() => handleMoveProviderOrder(id, 'up')}
                                title="Mover arriba"
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  padding: '1px 3px',
                                  color: '#a1a1aa',
                                  cursor: 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                }}
                              >
                                <ChevronUpIcon size={12} strokeWidth={2.5} />
                              </button>
                            )}
                            {index < prefs.providerOrder.length - 1 && (
                              <button
                                type="button"
                                onClick={() => handleMoveProviderOrder(id, 'down')}
                                title="Mover abajo"
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  padding: '1px 3px',
                                  color: '#a1a1aa',
                                  cursor: 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                }}
                              >
                                <ChevronDownIcon size={12} strokeWidth={2.5} />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    fontSize: '11px',
                    color: '#71717a',
                    lineHeight: 1.5,
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                  <span>
                    Para configurar autenticación, comandos o tokens de un proveedor específico, selecciónalo en la lista de la izquierda.
                  </span>
                </div>
              </div>
            ) : currentSelectedConfig ? (
              /* Specific Provider Configuration View */
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
                    borderRadius: '10px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span
                      style={{
                        width: '38px',
                        height: '38px',
                        borderRadius: '8px',
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
                        {currentSelectedDiag?.state === 'ok' ? (
                          <span
                            style={{
                              fontSize: '10px',
                              padding: '2px 7px',
                              borderRadius: '4px',
                              fontWeight: 600,
                              backgroundColor: 'rgba(16, 185, 129, 0.15)',
                              color: '#34d399',
                              border: '1px solid rgba(16, 185, 129, 0.3)',
                            }}
                          >
                            En línea
                          </span>
                        ) : currentSelectedDiag?.state === 'detected' ? (
                          <span
                            style={{
                              fontSize: '10px',
                              padding: '2px 7px',
                              borderRadius: '4px',
                              fontWeight: 600,
                              backgroundColor: 'rgba(56, 189, 248, 0.15)',
                              color: '#38bdf8',
                              border: '1px solid rgba(56, 189, 248, 0.3)',
                            }}
                          >
                            Sesión local activa
                          </span>
                        ) : currentSelectedDiag?.state === 'signed_out' ? (
                          <span
                            style={{
                              fontSize: '10px',
                              padding: '2px 7px',
                              borderRadius: '4px',
                              fontWeight: 600,
                              backgroundColor: 'rgba(245, 158, 11, 0.15)',
                              color: '#fbbf24',
                              border: '1px solid rgba(245, 158, 11, 0.3)',
                            }}
                          >
                            Sesión requerida
                          </span>
                        ) : currentSelectedDiag?.state === 'error' ? (
                          <span
                            style={{
                              fontSize: '10px',
                              padding: '2px 7px',
                              borderRadius: '4px',
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
                              borderRadius: '4px',
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
                        {currentSelectedConfig.desc}
                      </div>
                    </div>
                  </div>

                  {/* Actions right */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <button
                      type="button"
                      onClick={() => handlePinProvider(selectedTab)}
                      title={
                        prefs.pinnedProvider === selectedTab
                          ? 'Desfijar de la barra superior'
                          : `Fijar ${PROVIDER_LABELS[selectedTab]} como predeterminado`
                      }
                      style={{
                        background:
                          prefs.pinnedProvider === selectedTab
                            ? 'rgba(245, 158, 11, 0.15)'
                            : 'rgba(255, 255, 255, 0.06)',
                        border:
                          prefs.pinnedProvider === selectedTab
                            ? '1px solid rgba(245, 158, 11, 0.3)'
                            : '1px solid rgba(255, 255, 255, 0.1)',
                        borderRadius: '6px',
                        padding: '5px 9px',
                        color: prefs.pinnedProvider === selectedTab ? '#fbbf24' : '#a1a1aa',
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
                        fill={prefs.pinnedProvider === selectedTab ? '#fbbf24' : 'none'}
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                      </svg>
                      <span>{prefs.pinnedProvider === selectedTab ? 'Predeterminado' : 'Fijar'}</span>
                    </button>

                    <button
                      type="button"
                      role="switch"
                      aria-checked={enabledSet.has(selectedTab)}
                      aria-label={`Activar ${PROVIDER_LABELS[selectedTab]}`}
                      className="ui-switch"
                      onClick={() => handleToggleProvider(selectedTab)}
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
                    borderRadius: '10px',
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
                    <div style={{ backgroundColor: 'rgba(0, 0, 0, 0.25)', padding: '8px 10px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '10px', color: '#71717a' }}>FUENTE DETECTADA</div>
                      <div style={{ fontSize: '11px', color: '#e4e4e7', marginTop: '2px', wordBreak: 'break-all' }}>
                        {currentSelectedQuota?.metadata?.source
                          ? String(currentSelectedQuota.metadata.source)
                          : currentSelectedConfig.source}
                      </div>
                    </div>

                    <div style={{ backgroundColor: 'rgba(0, 0, 0, 0.25)', padding: '8px 10px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '10px', color: '#71717a' }}>CUENTA / PLAN</div>
                      <div style={{ fontSize: '11px', color: '#e4e4e7', marginTop: '2px' }}>
                        {currentSelectedQuota?.metadata?.email
                          ? String(currentSelectedQuota.metadata.email)
                          : currentSelectedQuota?.metadata?.userName
                          ? String(currentSelectedQuota.metadata.userName)
                          : currentSelectedQuota?.metadata?.planType
                          ? `Plan: ${currentSelectedQuota.metadata.planType}`
                          : currentSelectedQuota?.metadata?.balance
                          ? `Saldo: ${currentSelectedQuota.metadata.balance}`
                          : currentSelectedDiag?.state === 'ok' || currentSelectedDiag?.state === 'detected'
                          ? 'Sesión activa'
                          : 'No autenticado'}
                      </div>
                    </div>
                  </div>

                  {/* Error / Warning banner if present */}
                  {currentSelectedQuota?.error && (
                    <div
                      style={{
                        backgroundColor: 'rgba(245, 158, 11, 0.08)',
                        border: '1px solid rgba(245, 158, 11, 0.25)',
                        borderRadius: '6px',
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
                        <line x1="12" y1="17" x2="12.01" y2="17" />
                      </svg>
                      <span style={{ flex: 1, lineHeight: 1.4 }}>{currentSelectedQuota.error}</span>
                    </div>
                  )}
                </div>

                {/* Multi-Account Switcher Vault Card */}
                {['antigravity', 'claude', 'codex', 'opencode', 'grok'].includes(selectedTab) && (
                  <div
                    style={{
                      backgroundColor: 'rgba(59, 130, 246, 0.08)',
                      border: '1px solid rgba(59, 130, 246, 0.28)',
                      borderRadius: '10px',
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
                          borderRadius: '8px',
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
                          <span style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '4px', backgroundColor: 'rgba(16, 185, 129, 0.2)', color: '#34d399', fontWeight: 500 }}>
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
                      onClick={() => setAccountSwitcherOpen(true)}
                      style={{
                        padding: '8px 16px',
                        borderRadius: '7px',
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
                    borderRadius: '10px',
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
                    {currentSelectedConfig.details}
                  </p>

                  {/* CLI Login Command Box */}
                  {currentSelectedConfig.loginCmd && (
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
                          borderRadius: '8px',
                          padding: '8px 12px',
                        }}
                      >
                        <code style={{ fontSize: '12px', color: '#34d399', fontFamily: 'monospace' }}>
                          {currentSelectedConfig.loginCmd}
                        </code>
                        <button
                          type="button"
                          onClick={() => handleCopyCommand(currentSelectedConfig.loginCmd!)}
                          style={{
                            background: 'rgba(255, 255, 255, 0.08)',
                            border: '1px solid rgba(255, 255, 255, 0.12)',
                            borderRadius: '6px',
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
                          {copiedCmd === currentSelectedConfig.loginCmd ? (
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
                  {currentSelectedConfig.connectionType === 'opencode_form' && (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '10px',
                        marginTop: '4px',
                        padding: '12px',
                        backgroundColor: 'rgba(0, 0, 0, 0.25)',
                        borderRadius: '8px',
                        border: '1px solid rgba(255, 255, 255, 0.08)',
                      }}
                    >
                      <div
                        style={{
                          fontSize: '10px',
                          lineHeight: 1.6,
                          color: '#a1a1aa',
                          padding: '8px',
                          borderRadius: '6px',
                          backgroundColor: 'rgba(255, 255, 255, 0.03)',
                          border: '1px solid rgba(255, 255, 255, 0.06)',
                        }}
                      >
                        <div>
                          <strong style={{ color: '#e4e4e7' }}>Detección:</strong>{' '}
                          {String(
                            currentSelectedQuota?.metadata?.authSource ||
                              'sin credenciales detectadas'
                          )}
                        </div>
                        <div>
                          <strong style={{ color: '#e4e4e7' }}>Endpoint:</strong>{' '}
                          {String(currentSelectedQuota?.metadata?.endpoint || '—')}
                        </div>
                        <div>
                          <strong style={{ color: '#e4e4e7' }}>Último estado:</strong>{' '}
                          {currentSelectedQuota?.metadata?.httpStatus
                            ? `HTTP ${currentSelectedQuota.metadata.httpStatus}`
                            : 'sin respuesta'}{' '}
                          ·{' '}
                          {currentSelectedQuota?.error ||
                            (currentSelectedQuota
                              ? `${Math.round(currentSelectedQuota.primaryRemainingPercent)}% restante`
                              : '—')}
                        </div>
                        {currentSelectedQuota?.metadata?.legacyNote && (
                          <div style={{ color: '#fbbf24', marginTop: '2px' }}>
                            {String(currentSelectedQuota.metadata.legacyNote)}
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
                            borderRadius: '6px',
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
                          onClick={handleSaveOpenCode}
                          style={{
                            padding: '5px 12px',
                            borderRadius: '6px',
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
                          onClick={handleClearOpenCode}
                          style={{
                            padding: '5px 12px',
                            borderRadius: '6px',
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
                    borderRadius: '10px',
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
                    onClick={() => handleVerifyNow(selectedTab)}
                    disabled={isVerifying}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '6px 14px',
                      borderRadius: '6px',
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
            ) : null}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            padding: '12px 20px',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            backgroundColor: 'rgba(255, 255, 255, 0.02)',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '6px 18px',
              borderRadius: '6px',
              backgroundColor: '#10b981',
              border: 'none',
              color: '#ffffff',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 120ms ease',
            }}
          >
            Listo
          </button>
        </div>
      </div>

      {accountSwitcherOpen && (
        <AccountSwitcherModal
          provider={selectedTab}
          providerLabel={PROVIDER_LABELS[selectedTab] || selectedTab}
          isOpen={accountSwitcherOpen}
          onClose={() => setAccountSwitcherOpen(false)}
          onAccountSwitched={() => {
            void subscriptionQuotaManager.fetchAll(true);
          }}
        />
      )}
    </div>,
    document.body
  );
};
