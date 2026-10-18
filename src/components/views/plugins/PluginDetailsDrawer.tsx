import React, { useState, useEffect } from 'react';
import type { ActivePlugin, PluginConfig } from './types';
import {
  XIcon,
  ShieldIcon,
  KeyIcon,
  ExternalLinkIcon,
  CheckIcon,
  LockIcon,
} from './pluginIcons';


export interface PluginDetailsDrawerProps {
  plugin: ActivePlugin | null;
  isOpen: boolean;
  onClose: () => void;
  onToggleStatus: (plugin: ActivePlugin) => void;
  onSaveConfig: (pluginId: string, config: PluginConfig) => void;
}

export const PluginDetailsDrawer: React.FC<PluginDetailsDrawerProps> = ({
  plugin,
  isOpen,
  onClose,
  onToggleStatus,
  onSaveConfig,
}) => {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [readOnly, setReadOnly] = useState(true);
  const [account, setAccount] = useState('');
  const [customPort, setCustomPort] = useState(8080);
  const [savedSuccess, setSavedSuccess] = useState(false);

  useEffect(() => {
    if (plugin) {
      setApiKey(plugin.config?.apiKey || '');
      setReadOnly(plugin.config?.readOnly ?? true);
      setAccount(plugin.config?.account || '');
      setCustomPort(plugin.config?.customPort || 8080);
      setShowKey(false);
      setSavedSuccess(false);
    }
  }, [plugin, isOpen]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !plugin) return null;

  const isInstalled = plugin.status === 'installed';

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveConfig(plugin.id, {
      apiKey: apiKey.trim(),
      readOnly,
      account: account.trim(),
      customPort,
    });
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 3000);
  };

  const renderLogo = () => {
    if ('template' in plugin.logo) {
      return (
        <span
          className="brand-logo"
          style={{
            width: '28px',
            height: '28px',
            backgroundColor: 'currentColor',
            maskImage: `url(/assets/logos/${plugin.logo.template}.png)`,
            WebkitMaskImage: `url(/assets/logos/${plugin.logo.template}.png)`,
            maskPosition: 'center',
            WebkitMaskPosition: 'center',
            maskRepeat: 'no-repeat',
            WebkitMaskRepeat: 'no-repeat',
            maskSize: 'contain',
            WebkitMaskSize: 'contain',
            display: 'block',
          }}
        />
      );
    }
    if ('file' in plugin.logo) {
      return (
        <img
          alt={plugin.name}
          src={`/assets/logos/${plugin.logo.file}.png`}
          width={28}
          height={28}
          style={{ objectFit: 'contain' }}
          onError={(e) => {
            (e.currentTarget as HTMLElement).style.display = 'none';
          }}
        />
      );
    }
    return (
      <span className="brand-logo-pair">
        <img
          alt=""
          className="brand-logo brand-logo--dark"
          src={`/assets/logos/${plugin.logo.onDark}.png`}
          width={28}
          height={28}
          style={{ objectFit: 'contain' }}
        />
        <img
          alt={plugin.name}
          className="brand-logo brand-logo--light"
          src={`/assets/logos/${plugin.logo.onLight}.png`}
          width={28}
          height={28}
          style={{ objectFit: 'contain' }}
        />
      </span>
    );
  };

  return (
    <div
      className="notif-modal-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        backgroundColor: 'rgba(0, 0, 0, 0.72)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
        boxSizing: 'border-box',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="notif-modal-dialog"
        style={{
          width: '580px',
          maxWidth: '100%',
          maxHeight: '90vh',
          backgroundColor: 'var(--dialog, #16171d)',
          borderRadius: '12px',
          border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.12))',
          boxShadow: '0 20px 45px rgba(0, 0, 0, 0.55)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '18px 20px',
            borderBottom: '1px solid var(--separator, rgba(255, 255, 255, 0.08))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            backgroundColor: 'var(--block-fill, rgba(255, 255, 255, 0.02))',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span
              className={`plugin-card__tile${plugin.prefersDarkTile ? ' plugin-card__tile--ink' : ''}`}
              style={{
                width: '42px',
                height: '42px',
                borderRadius: '8px',
                backgroundColor: 'rgba(255, 255, 255, 0.06)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              {renderLogo()}
            </span>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: 'var(--text-primary, #fff)' }}>
                  {plugin.name}
                </h2>
                <span
                  style={{
                    fontSize: '11px',
                    fontFamily: 'var(--font-mono, monospace)',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    backgroundColor: 'rgba(255, 255, 255, 0.08)',
                    color: 'var(--text-secondary, #9da2b4)',
                  }}
                >
                  {plugin.version}
                </span>
                <span
                  style={{
                    fontSize: '10px',
                    textTransform: 'uppercase',
                    fontWeight: 600,
                    letterSpacing: '0.05em',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    backgroundColor: 'rgba(92, 143, 255, 0.15)',
                    color: 'var(--accent, #5c8fff)',
                  }}
                >
                  {plugin.category}
                </span>
              </div>
              <p style={{ margin: '2px 0 0', fontSize: '12px', color: 'var(--text-secondary, #9da2b4)' }}>
                by {plugin.vendor} · {plugin.authentication}
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {/* Quick Toggle */}
            <button
              type="button"
              role="switch"
              aria-label={isInstalled ? `Disable ${plugin.name}` : `Enable ${plugin.name}`}
              aria-checked={isInstalled}
              onClick={() => onToggleStatus(plugin)}
              className="ui-switch"
              title={isInstalled ? 'Disconnect plugin' : 'Connect plugin'}
            >
              <span className="ui-switch__knob" />
            </button>

            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'none',
                border: 0,
                padding: '6px',
                color: 'var(--text-secondary, #9da2b4)',
                cursor: 'pointer',
                borderRadius: '6px',
                display: 'inline-flex',
              }}
              aria-label="Close"
            >
              <XIcon size={16} />
            </button>
          </div>
        </div>

        {/* Scrollable Body */}
        <div
          style={{
            padding: '20px',
            overflowY: 'auto',
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            gap: '18px',
          }}
        >
          {/* Status & Banner */}
          <div
            style={{
              padding: '12px 14px',
              borderRadius: '8px',
              backgroundColor: isInstalled ? 'rgba(74, 222, 128, 0.08)' : 'rgba(255, 255, 255, 0.03)',
              border: isInstalled ? '1px solid rgba(74, 222, 128, 0.25)' : '1px solid var(--block-stroke, rgba(255, 255, 255, 0.08))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  backgroundColor: isInstalled ? '#4ade80' : 'var(--text-secondary, #888)',
                }}
              />
              <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-primary, #fff)' }}>
                Status: {isInstalled ? 'Active & Connected' : plugin.status === 'disabled' ? 'Disabled' : 'Available to Connect'}
              </span>
            </div>
            {savedSuccess && (
              <span style={{ fontSize: '11px', color: '#4ade80', fontWeight: 600 }}>
                Configuration saved!
              </span>
            )}
          </div>

          {/* Description */}
          <div>
            <h4 style={{ margin: '0 0 6px', fontSize: '12px', fontWeight: 600, color: 'var(--text-primary, #ddd)' }}>
              Overview
            </h4>
            <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.5, color: 'var(--text-secondary, #9da2b4)' }}>
              {plugin.description}
            </p>
          </div>

          {/* Permissions List */}
          <div>
            <h4 style={{ margin: '0 0 8px', fontSize: '12px', fontWeight: 600, color: 'var(--text-primary, #ddd)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <ShieldIcon size={13} style={{ color: 'var(--accent, #5c8fff)' }} />
              <span>Agent Capabilities & Grants</span>
            </h4>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                padding: '10px 12px',
                backgroundColor: 'rgba(0, 0, 0, 0.2)',
                borderRadius: '6px',
                border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.06))',
              }}
            >
              {plugin.permissions.map((perm, idx) => (
                <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-secondary, #bbb)' }}>
                  <CheckIcon size={12} style={{ color: '#4ade80', flexShrink: 0 }} />
                  <span>{perm}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Configuration Form */}
          <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <h4 style={{ margin: 0, fontSize: '12px', fontWeight: 600, color: 'var(--text-primary, #ddd)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <KeyIcon size={13} style={{ color: 'var(--accent, #5c8fff)' }} />
              <span>Integration Settings</span>
            </h4>

            {/* API Key / Token field if apiKey auth */}
            {plugin.authentication === 'apiKey' && (
              <div>
                <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary, #9da2b4)', marginBottom: '5px' }}>
                  API Token / Secret Key
                </label>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={`Enter your ${plugin.name} API key...`}
                    style={{
                      flex: 1,
                      height: '32px',
                      padding: '0 10px',
                      backgroundColor: 'var(--block-fill, rgba(255, 255, 255, 0.04))',
                      border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.1))',
                      borderRadius: '6px',
                      color: 'var(--text-primary, #fff)',
                      fontSize: '12px',
                      fontFamily: showKey ? 'var(--font-mono, monospace)' : 'inherit',
                      outline: 'none',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    style={{
                      padding: '0 10px',
                      height: '32px',
                      borderRadius: '6px',
                      border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.1))',
                      backgroundColor: 'transparent',
                      color: 'var(--text-secondary, #9da2b4)',
                      fontSize: '11px',
                      cursor: 'pointer',
                    }}
                  >
                    {showKey ? 'Hide' : 'Reveal'}
                  </button>
                </div>
              </div>
            )}

            {/* Local MCP Port if localMCP */}
            {plugin.authentication === 'localMCP' && (
              <div>
                <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary, #9da2b4)', marginBottom: '5px' }}>
                  Local IPC Port / Socket
                </label>
                <input
                  type="number"
                  value={customPort}
                  onChange={(e) => setCustomPort(Number(e.target.value))}
                  style={{
                    width: '120px',
                    height: '32px',
                    padding: '0 10px',
                    backgroundColor: 'var(--block-fill, rgba(255, 255, 255, 0.04))',
                    border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.1))',
                    borderRadius: '6px',
                    color: 'var(--text-primary, #fff)',
                    fontSize: '12px',
                    outline: 'none',
                  }}
                />
              </div>
            )}

            {/* OAuth Connected Account if OAuth */}
            {plugin.authentication.startsWith('oauth') && (
              <div>
                <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary, #9da2b4)', marginBottom: '5px' }}>
                  Connected Account / Organization
                </label>
                <input
                  type="text"
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                  placeholder="e.g. builder@example.com or org_prod"
                  style={{
                    width: '100%',
                    height: '32px',
                    padding: '0 10px',
                    backgroundColor: 'var(--block-fill, rgba(255, 255, 255, 0.04))',
                    border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.1))',
                    borderRadius: '6px',
                    color: 'var(--text-primary, #fff)',
                    fontSize: '12px',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            )}

            {/* Read-Only Access Mode Toggle */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 12px',
                borderRadius: '6px',
                backgroundColor: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.06))',
              }}
            >
              <div>
                <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary, #fff)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <LockIcon size={12} />
                  <span>Enforce Read-Only Mode</span>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary, #9da2b4)', marginTop: '2px' }}>
                  Prevents agents from mutating records, spending credits, or deleting resources.
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

            <button
              type="submit"
              className="primary-button"
              style={{
                alignSelf: 'flex-start',
                padding: '6px 14px',
                borderRadius: '6px',
                backgroundColor: 'var(--accent, #5c8fff)',
                color: '#fff',
                fontSize: '12px',
                fontWeight: 600,
                border: 0,
                cursor: 'pointer',
              }}
            >
              Save Settings
            </button>
          </form>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '12px 20px',
            borderTop: '1px solid var(--separator, rgba(255, 255, 255, 0.08))',
            backgroundColor: 'var(--block-fill, rgba(255, 255, 255, 0.02))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          {plugin.docUrl ? (
            <a
              href={plugin.docUrl}
              target="_blank"
              rel="noreferrer"
              style={{
                fontSize: '12px',
                color: 'var(--accent, #5c8fff)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                textDecoration: 'none',
              }}
            >
              <span>Vendor Documentation</span>
              <ExternalLinkIcon size={11} />
            </a>
          ) : (
            <span style={{ fontSize: '11px', color: 'var(--text-secondary, #888)' }}>
              Integrated via Model Context Protocol
            </span>
          )}

          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              onClick={onClose}
              className="secondary-button"
              style={{
                padding: '6px 14px',
                borderRadius: '6px',
                fontSize: '12px',
                border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.12))',
                backgroundColor: 'transparent',
                color: 'var(--text-primary, #fff)',
                cursor: 'pointer',
              }}
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
