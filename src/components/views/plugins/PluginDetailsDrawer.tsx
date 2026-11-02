import React, { useState, useEffect } from 'react';
import type { ActivePlugin, OfficialPlugin, PluginAction, PluginConfig, PluginConnection } from './types';
import type { AgentProfile } from '../../../types';
import { Sheet } from '../../ui/Sheet';
import { BrandLogo } from './PluginCard';
import { BrandLogo as EngineBrandLogo, getEngineDisplayName, getEngineVendor } from '../agents/engineMetadata';
import { AgentAvatar } from '../../AgentAvatar';
import { invokeCommand } from '../../../lib/ipc';
import {
  ShieldIcon,
  KeyIcon,
  ExternalLinkIcon,
  CheckIcon,
  LockIcon,
} from './pluginIcons';

export const SUPPORTED_MCP_ENGINES = [
  'claude-code',
  'codex',
  'antigravity',
  'open-code',
  'cursor',
  'gemini',
  'grok',
] as const;

export interface PluginDetailsDrawerProps {
  plugin: OfficialPlugin | ActivePlugin | null;
  isOpen: boolean;
  onClose: () => void;
  onToggleStatus?: (plugin: any) => void;
  onSaveConfig?: (pluginId: string, config: PluginConfig) => void;
  onAction?: (id: string, action: PluginAction) => void;
  connection?: PluginConnection | null;
  agents?: AgentProfile[];
  isPluginEnabledForAgent?: (agentId: string, pluginId: string) => boolean;
  onTogglePluginForAgent?: (agentId: string, pluginId: string, enable: boolean) => Promise<void>;
}

export const PluginDetailsDrawer: React.FC<PluginDetailsDrawerProps> = ({
  plugin,
  isOpen,
  onClose,
  onToggleStatus,
  onSaveConfig,
  onAction,
  connection,
  agents = [],
  isPluginEnabledForAgent,
  onTogglePluginForAgent,
}) => {
  const [activeTab, setActiveTab] = useState<'config' | 'providers' | 'agents'>('config');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [readOnly, setReadOnly] = useState(true);
  const [account, setAccount] = useState('');
  const [customPort, setCustomPort] = useState(8080);
  const [enabledProviders, setEnabledProviders] = useState<string[]>([...SUPPORTED_MCP_ENGINES]);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!plugin || !isOpen) return;

    let isMounted = true;
    const initialConfig = (plugin as ActivePlugin).config;
    setApiKey(initialConfig?.apiKey || '');
    setReadOnly(initialConfig?.readOnly ?? true);
    setAccount(initialConfig?.account || '');
    setCustomPort(initialConfig?.customPort || 8080);
    if (Array.isArray(initialConfig?.enabledProviders) && initialConfig.enabledProviders.length > 0) {
      setEnabledProviders(initialConfig.enabledProviders);
    } else {
      setEnabledProviders([...SUPPORTED_MCP_ENGINES]);
    }
    setShowKey(false);
    setSavedSuccess(false);
    setValidationError(null);

    // Fetch persistent config from backend
    invokeCommand<PluginConfig | null>('get_plugin_config', { pluginId: plugin.id })
      .then((cfg) => {
        if (!isMounted || !cfg) return;
        if (cfg.apiKey !== undefined) setApiKey(cfg.apiKey || '');
        if (cfg.readOnly !== undefined) setReadOnly(cfg.readOnly);
        if (cfg.account !== undefined) setAccount(cfg.account || '');
        if (cfg.customPort !== undefined) setCustomPort(cfg.customPort || 8080);
        if (Array.isArray(cfg.enabledProviders) && cfg.enabledProviders.length > 0) {
          setEnabledProviders(cfg.enabledProviders);
        }
      })
      .catch(() => {
        // Fallback to in-memory config if IPC unavailable
      });

    return () => {
      isMounted = false;
    };
  }, [plugin, isOpen]);

  if (!isOpen || !plugin) return null;

  const isInstalled = connection
    ? connection.state === 'connected'
    : (plugin as ActivePlugin).status === 'installed';

  const handleConnect = async () => {
    setValidationError(null);

    if (plugin.authentication === 'apiKey' && !apiKey.trim()) {
      setValidationError('Se requiere una clave de API válida para conectar este servicio.');
      setActiveTab('config');
      return;
    }

    if (plugin.authentication === 'localMCP' && (!customPort || customPort <= 0)) {
      setValidationError('Se requiere configurar un puerto local válido (ej. 8080).');
      setActiveTab('config');
      return;
    }

    const configToSave: PluginConfig = {
      apiKey: apiKey.trim(),
      readOnly,
      account: account.trim(),
      customPort,
      enabledProviders,
    };

    try {
      await invokeCommand('save_plugin_config', {
        pluginId: plugin.id,
        config: configToSave,
      });
    } catch {
      // IPC fallback
    }

    onSaveConfig?.(plugin.id, configToSave);

    if (onAction) {
      onAction(plugin.id, 'connect');
    }
    if (onToggleStatus) {
      onToggleStatus(plugin);
    }
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 2500);
  };

  const handleDisconnect = () => {
    if (onAction) {
      onAction(plugin.id, 'disconnect');
    }
    if (onToggleStatus) {
      onToggleStatus(plugin);
    }
  };

  const handleSaveConfigOnly = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setValidationError(null);

    const configToSave: PluginConfig = {
      apiKey: apiKey.trim(),
      readOnly,
      account: account.trim(),
      customPort,
      enabledProviders,
    };

    try {
      await invokeCommand('save_plugin_config', {
        pluginId: plugin.id,
        config: configToSave,
      });
    } catch {
      // IPC fallback
    }

    onSaveConfig?.(plugin.id, configToSave);
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 2500);
  };

  const handleToggleProvider = async (engineKey: string) => {
    const isCurrentlyEnabled = enabledProviders.includes(engineKey);
    const nextProviders = isCurrentlyEnabled
      ? enabledProviders.filter((p) => p !== engineKey)
      : [...enabledProviders, engineKey];

    setEnabledProviders(nextProviders);

    const updatedConfig: PluginConfig = {
      apiKey: apiKey.trim(),
      readOnly,
      account: account.trim(),
      customPort,
      enabledProviders: nextProviders,
    };

    try {
      await invokeCommand('save_plugin_config', {
        pluginId: plugin.id,
        config: updatedConfig,
      });
    } catch {}

    onSaveConfig?.(plugin.id, updatedConfig);

    // Sync all workspace agents that match this engine
    const targetAgents = agents.filter((a) => a.engine === engineKey);
    if (targetAgents.length > 0 && onTogglePluginForAgent) {
      const shouldEnable = !isCurrentlyEnabled;
      await Promise.allSettled(
        targetAgents.map((agent) =>
          onTogglePluginForAgent(agent.id, plugin.id, shouldEnable)
        )
      );
    }
  };

  const handleToggleAgent = async (agentId: string) => {
    if (!onTogglePluginForAgent) return;
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return;

    const isEnabled = isPluginEnabledForAgent
      ? isPluginEnabledForAgent(agent.id, plugin.id)
      : !agent.disabledPluginIds?.includes(plugin.id);

    await onTogglePluginForAgent(agent.id, plugin.id, !isEnabled);
  };

  return (
    <Sheet
      open={isOpen}
      onCancel={onClose}
      width={600}
      title={plugin.name}
      description={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: '12px', marginTop: '2px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span
              className={`plugin-card__tile${plugin.prefersDarkTile ? ' plugin-card__tile--ink' : ''}`}
              style={{
                width: '24px',
                height: '24px',
                borderRadius: 'var(--radius-chip)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <BrandLogo alt={plugin.name} size={16} variant={plugin.logo} fallbackIcon={plugin.fallbackIcon} />
            </span>
            <span
              style={{
                fontSize: 'var(--text-badge)',
                fontFamily: 'var(--font-mono)',
                padding: '1px 6px',
                borderRadius: 'var(--radius-chip)',
                backgroundColor: 'var(--chip-fill)',
                color: 'var(--text-secondary)',
              }}
            >
              {plugin.version}
            </span>
            <span
              style={{
                fontSize: 'var(--text-badge)',
                fontWeight: 'var(--weight-semibold)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                padding: '1px 6px',
                borderRadius: 'var(--radius-chip)',
                backgroundColor: 'color-mix(in srgb, var(--accent) 15%, transparent)',
                color: 'var(--accent)',
              }}
            >
              {plugin.category}
            </span>
            <span style={{ fontSize: 'var(--text-meta)', color: 'var(--text-secondary)' }}>
              por {plugin.vendor} · {plugin.authentication}
            </span>
          </div>

          {/* Connection Status Pill */}
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '2px 8px',
              borderRadius: 'var(--radius-pill)',
              fontSize: 'var(--text-meta)',
              fontWeight: 'var(--weight-medium)',
              backgroundColor: isInstalled
                ? 'color-mix(in srgb, #22c55e 15%, transparent)'
                : 'var(--chip-fill)',
              color: isInstalled ? '#4ade80' : 'var(--text-secondary)',
              border: isInstalled
                ? '1px solid color-mix(in srgb, #22c55e 30%, transparent)'
                : '1px solid var(--block-stroke)',
              flexShrink: 0,
            }}
          >
            <i
              style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                backgroundColor: isInstalled ? '#4ade80' : 'var(--text-faint)',
              }}
            />
            {isInstalled ? 'Conectado' : 'Desconectado'}
          </span>
        </div>
      }
      secondary={{
        label: 'Cerrar',
        onClick: onClose,
      }}
      primary={
        isInstalled
          ? {
              label: 'Desconectar',
              variant: 'danger',
              onClick: handleDisconnect,
            }
          : {
              label: 'Conectar Servicio',
              variant: 'primary',
              onClick: handleConnect,
            }
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {/* Segmented Tab Navigation */}
        <div
          className="segmented-control"
          style={{
            display: 'flex',
            gap: '4px',
            backgroundColor: 'var(--block-fill)',
            padding: '3px',
            borderRadius: 'var(--radius-card)',
            border: '1px solid var(--block-stroke)',
          }}
        >
          <button
            type="button"
            className={`segmented-control__button${activeTab === 'config' ? ' segmented-control__button--selected' : ''}`}
            onClick={() => setActiveTab('config')}
            style={{
              flex: 1,
              padding: '6px 10px',
              fontSize: 'var(--text-row)',
              borderRadius: 'var(--radius-chip)',
              border: 0,
              cursor: 'pointer',
              backgroundColor: activeTab === 'config' ? 'var(--selected-fill)' : 'transparent',
              color: activeTab === 'config' ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: activeTab === 'config' ? 'var(--weight-semibold)' : 'var(--weight-regular)',
            }}
          >
            Configuración y Credenciales
          </button>
          <button
            type="button"
            className={`segmented-control__button${activeTab === 'providers' ? ' segmented-control__button--selected' : ''}`}
            onClick={() => setActiveTab('providers')}
            style={{
              flex: 1,
              padding: '6px 10px',
              fontSize: 'var(--text-row)',
              borderRadius: 'var(--radius-chip)',
              border: 0,
              cursor: 'pointer',
              backgroundColor: activeTab === 'providers' ? 'var(--selected-fill)' : 'transparent',
              color: activeTab === 'providers' ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: activeTab === 'providers' ? 'var(--weight-semibold)' : 'var(--weight-regular)',
            }}
          >
            Proveedores ({SUPPORTED_MCP_ENGINES.length})
          </button>
          <button
            type="button"
            className={`segmented-control__button${activeTab === 'agents' ? ' segmented-control__button--selected' : ''}`}
            onClick={() => setActiveTab('agents')}
            style={{
              flex: 1,
              padding: '6px 10px',
              fontSize: 'var(--text-row)',
              borderRadius: 'var(--radius-chip)',
              border: 0,
              cursor: 'pointer',
              backgroundColor: activeTab === 'agents' ? 'var(--selected-fill)' : 'transparent',
              color: activeTab === 'agents' ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: activeTab === 'agents' ? 'var(--weight-semibold)' : 'var(--weight-regular)',
            }}
          >
            Agentes ({agents.length})
          </button>
        </div>

        {/* Validation Error Banner */}
        {validationError && (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 'var(--radius-chip)',
              backgroundColor: 'var(--danger-fill)',
              color: 'var(--danger-ink)',
              fontSize: 'var(--text-meta)',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              border: '1px solid color-mix(in srgb, var(--danger-ink) 30%, transparent)',
            }}
          >
            <span>{validationError}</span>
          </div>
        )}

        {/* Success Banner */}
        {savedSuccess && (
          <div
            style={{
              padding: '8px 12px',
              borderRadius: 'var(--radius-chip)',
              backgroundColor: 'color-mix(in srgb, #22c55e 15%, transparent)',
              color: '#4ade80',
              fontSize: 'var(--text-meta)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <CheckIcon size={14} />
            <span>Configuración guardada correctamente.</span>
          </div>
        )}

        {/* TAB 1: CONFIGURATION & CREDENTIALS */}
        {activeTab === 'config' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            {/* Overview */}
            <div>
              <label
                style={{
                  fontSize: 'var(--text-meta)',
                  fontWeight: 'var(--weight-semibold)',
                  color: 'var(--text-secondary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  display: 'block',
                  marginBottom: 'var(--space-1)',
                }}
              >
                Descripción
              </label>
              <p style={{ margin: 0, fontSize: 'var(--text-body)', lineHeight: 'var(--leading-body)', color: 'var(--text-secondary)' }}>
                {plugin.description}
              </p>
            </div>

            {/* Permissions / Capabilities */}
            <div>
              <label
                style={{
                  fontSize: 'var(--text-meta)',
                  fontWeight: 'var(--weight-semibold)',
                  color: 'var(--text-secondary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  marginBottom: 'var(--space-2)',
                }}
              >
                <ShieldIcon size={13} style={{ color: 'var(--accent)' }} />
                <span>Capacidades Otorgadas</span>
              </label>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  padding: '10px 12px',
                  backgroundColor: 'var(--block-fill)',
                  borderRadius: 'var(--radius-chip)',
                  border: '1px solid var(--block-stroke)',
                }}
              >
                {plugin.permissions.map((perm, idx) => (
                  <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-row)', color: 'var(--text-primary)' }}>
                    <CheckIcon size={13} style={{ color: '#4ade80', flexShrink: 0 }} />
                    <span>{perm}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Credentials Configuration */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              <label
                style={{
                  fontSize: 'var(--text-meta)',
                  fontWeight: 'var(--weight-semibold)',
                  color: 'var(--text-secondary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <KeyIcon size={13} style={{ color: 'var(--accent)' }} />
                <span>Credenciales de Integración</span>
              </label>

              {/* API Key field */}
              {plugin.authentication === 'apiKey' && (
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--text-meta)', fontWeight: 'var(--weight-medium)', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                    Clave de API / Token Secreto
                  </label>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <input
                      type={showKey ? 'text' : 'password'}
                      value={apiKey}
                      onChange={(e) => {
                        setApiKey(e.target.value);
                        if (validationError) setValidationError(null);
                      }}
                      placeholder={`Ingresa tu clave de API para ${plugin.name}...`}
                      style={{
                        flex: 1,
                        height: '32px',
                        padding: '0 10px',
                        backgroundColor: 'var(--block-fill)',
                        border: '1px solid var(--block-stroke)',
                        borderRadius: 'var(--radius-chip)',
                        color: 'var(--text-primary)',
                        fontSize: 'var(--text-row)',
                        fontFamily: showKey ? 'var(--font-mono)' : 'inherit',
                        outline: 'none',
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey(!showKey)}
                      className="secondary-button"
                      style={{
                        padding: '0 12px',
                        height: '32px',
                        fontSize: 'var(--text-caption)',
                        cursor: 'pointer',
                      }}
                    >
                      {showKey ? 'Ocultar' : 'Mostrar'}
                    </button>
                  </div>
                </div>
              )}

              {/* Local IPC Port */}
              {plugin.authentication === 'localMCP' && (
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--text-meta)', fontWeight: 'var(--weight-medium)', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                    Puerto IPC Local
                  </label>
                  <input
                    type="number"
                    value={customPort}
                    onChange={(e) => {
                      setCustomPort(Number(e.target.value));
                      if (validationError) setValidationError(null);
                    }}
                    style={{
                      width: '130px',
                      height: '32px',
                      padding: '0 10px',
                      backgroundColor: 'var(--block-fill)',
                      border: '1px solid var(--block-stroke)',
                      borderRadius: 'var(--radius-chip)',
                      color: 'var(--text-primary)',
                      fontSize: 'var(--text-row)',
                      outline: 'none',
                    }}
                  />
                </div>
              )}

              {/* Connected Account */}
              {plugin.authentication.startsWith('oauth') && (
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--text-meta)', fontWeight: 'var(--weight-medium)', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                    Cuenta u Organización Conectada
                  </label>
                  <input
                    type="text"
                    value={account}
                    onChange={(e) => setAccount(e.target.value)}
                    placeholder="ej. workspace@empresa.com"
                    style={{
                      width: '100%',
                      height: '32px',
                      padding: '0 10px',
                      backgroundColor: 'var(--block-fill)',
                      border: '1px solid var(--block-stroke)',
                      borderRadius: 'var(--radius-chip)',
                      color: 'var(--text-primary)',
                      fontSize: 'var(--text-row)',
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
              )}

              {/* Read-Only Mode Toggle */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-chip)',
                  backgroundColor: 'var(--block-fill)',
                  border: '1px solid var(--block-stroke)',
                }}
              >
                <div>
                  <div style={{ fontSize: 'var(--text-row)', fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <LockIcon size={13} />
                    <span>Modo Solo Lectura</span>
                  </div>
                  <div style={{ fontSize: 'var(--text-meta)', color: 'var(--text-secondary)', marginTop: '2px' }}>
                    Impide que los agentes modifiquen registros o ejecuten acciones destructivas en este servicio.
                  </div>
                </div>

                <button
                  type="button"
                  role="switch"
                  aria-checked={readOnly}
                  onClick={() => setReadOnly(!readOnly)}
                  className="ui-switch"
                  style={{ marginLeft: '12px' }}
                >
                  <span className="ui-switch__knob" />
                </button>
              </div>

              <div style={{ display: 'flex', gap: '8px', marginTop: 'var(--space-1)' }}>
                <button
                  type="button"
                  onClick={handleSaveConfigOnly}
                  className="secondary-button"
                  style={{
                    padding: '6px 14px',
                    fontSize: 'var(--text-meta)',
                    cursor: 'pointer',
                  }}
                >
                  Guardar Ajustes
                </button>

                {plugin.docUrl && (
                  <a
                    href={plugin.docUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      marginLeft: 'auto',
                      fontSize: 'var(--text-meta)',
                      color: 'var(--accent)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      textDecoration: 'none',
                    }}
                  >
                    <span>Documentación del Proveedor</span>
                    <ExternalLinkIcon size={12} />
                  </a>
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: SELECTION BY AI ENGINES / PROVIDERS */}
        {activeTab === 'providers' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <div>
              <p style={{ margin: 0, fontSize: 'var(--text-row)', color: 'var(--text-secondary)' }}>
                Activa o desactiva este plugin para cada motor de IA. Al habilitar un motor, sus agentes tendrán acceso a las herramientas MCP de este plugin.
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {SUPPORTED_MCP_ENGINES.map((engineKey) => {
                const name = getEngineDisplayName(engineKey);
                const vendor = getEngineVendor(engineKey) || '';
                const engineAgents = agents.filter((a) => a.engine === engineKey);
                const isEnabled = enabledProviders.includes(engineKey);

                return (
                  <div
                    key={engineKey}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 14px',
                      borderRadius: 'var(--radius-card)',
                      backgroundColor: 'var(--block-fill)',
                      border: '1px solid var(--block-stroke)',
                      transition: 'border-color var(--duration-ink) var(--ease-ink)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <EngineBrandLogo engine={engineKey} size={24} label={name} />
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ fontSize: 'var(--text-row)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)' }}>
                            {name}
                          </span>
                          <span
                            style={{
                              fontSize: 'var(--text-badge)',
                              padding: '1px 6px',
                              borderRadius: 'var(--radius-chip)',
                              backgroundColor: 'var(--chip-fill)',
                              color: 'var(--text-secondary)',
                            }}
                          >
                            {engineAgents.length > 0
                              ? `${engineAgents.length} ${engineAgents.length === 1 ? 'agente' : 'agentes'}`
                              : '0 agentes'}
                          </span>
                        </div>
                        <span style={{ fontSize: 'var(--text-meta)', color: 'var(--text-secondary)' }}>
                          {vendor ? `${vendor} · ` : ''}Model Context Protocol
                        </span>
                      </div>
                    </div>

                    <button
                      type="button"
                      role="switch"
                      aria-label={`Habilitar ${plugin.name} para ${name}`}
                      aria-checked={isEnabled}
                      onClick={() => handleToggleProvider(engineKey)}
                      className="ui-switch"
                    >
                      <span className="ui-switch__knob" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* TAB 3: SELECTION BY WORKSPACE AGENTS */}
        {activeTab === 'agents' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <div>
              <p style={{ margin: 0, fontSize: 'var(--text-row)', color: 'var(--text-secondary)' }}>
                Control granular para encender o apagar este plugin individualmente en cada agente de tu espacio de trabajo.
              </p>
            </div>

            {agents.length === 0 ? (
              <div
                style={{
                  padding: '24px',
                  borderRadius: 'var(--radius-card)',
                  backgroundColor: 'var(--block-fill)',
                  border: '1px solid var(--block-stroke)',
                  textAlign: 'center',
                  color: 'var(--text-secondary)',
                  fontSize: 'var(--text-row)',
                }}
              >
                No hay agentes registrados en este espacio de trabajo.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {agents.map((agent) => {
                  const isEnabled = isPluginEnabledForAgent
                    ? isPluginEnabledForAgent(agent.id, plugin.id)
                    : !agent.disabledPluginIds?.includes(plugin.id);
                  const engineName = getEngineDisplayName(agent.engine);

                  return (
                    <div
                      key={agent.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '10px 14px',
                        borderRadius: 'var(--radius-card)',
                        backgroundColor: 'var(--block-fill)',
                        border: '1px solid var(--block-stroke)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <AgentAvatar id={agent.id} name={agent.name} avatar={agent.avatar} size={28} />
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontSize: 'var(--text-row)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)' }}>
                              {agent.name}
                            </span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
                            <EngineBrandLogo engine={agent.engine} size={14} label={engineName} />
                            <span style={{ fontSize: 'var(--text-meta)', color: 'var(--text-secondary)' }}>
                              {engineName}
                            </span>
                          </div>
                        </div>
                      </div>

                      <button
                        type="button"
                        role="switch"
                        aria-label={`Habilitar ${plugin.name} para ${agent.name}`}
                        aria-checked={isEnabled}
                        onClick={() => handleToggleAgent(agent.id)}
                        className="ui-switch"
                      >
                        <span className="ui-switch__knob" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
};

export default PluginDetailsDrawer;
