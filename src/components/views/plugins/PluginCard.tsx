import React, { useState } from 'react';
import type { ActivePlugin, OfficialPlugin, PluginAction, PluginConnection, PluginConnectionState, PluginLogo } from './types';
import {
  PuzzleIcon,
  BugIcon,
  SendIcon,
} from './pluginIcons';

export interface PluginCardProps {
  plugin: OfficialPlugin | ActivePlugin;
  connection?: PluginConnection | null;
  onAction?: (id: string, action: PluginAction) => void;
  onToggleStatus?: (plugin: any) => void;
  onOpenDetails?: (plugin: any) => void;
  onConnectAction?: (plugin: any) => void;
}

export function resolveCardCopy(
  plugin: { name: string; summary: string },
  connection?: PluginConnection | null
): { text: string; tone?: 'failed' } {
  if (connection?.message) {
    return { text: connection.message, tone: 'failed' };
  }
  const state = connection?.state;
  if (state === 'connected') {
    return { text: connection?.account || 'Connected' };
  }
  if (state === 'needsReauth') {
    const who = connection?.account || plugin.name;
    return { text: `${who} — reconnect to keep using it.` };
  }
  if (state === 'connecting') {
    return { text: 'Finish in your browser or local app, then return here.' };
  }
  if (state === 'unavailable') {
    return { text: 'Account setup is not available in this build.' };
  }
  return { text: plugin.summary };
}

export const BrandLogo: React.FC<{
  alt: string;
  size?: number;
  variant: PluginLogo;
  fallbackIcon?: 'bug' | 'send' | null;
}> = ({ alt, size = 20, variant, fallbackIcon }) => {
  const [hasError, setHasError] = useState(false);

  if (hasError) {
    if (fallbackIcon === 'bug') {
      return (
        <span aria-hidden="true" className="brand-logo brand-logo--fallback">
          <BugIcon size={18} />
        </span>
      );
    }
    if (fallbackIcon === 'send') {
      return (
        <span aria-hidden="true" className="brand-logo brand-logo--fallback">
          <SendIcon size={18} />
        </span>
      );
    }
    return (
      <span aria-hidden="true" className="brand-logo brand-logo--fallback">
        <PuzzleIcon size={18} />
      </span>
    );
  }

  const logoStyle = {
    '--brand-logo-size': `${size}px`,
  } as React.CSSProperties;

  if ('template' in variant) {
    return (
      <span
        aria-hidden="true"
        aria-label={alt}
        className="brand-logo"
        role="img"
        style={{
          ...logoStyle,
          width: `${size}px`,
          height: `${size}px`,
          backgroundColor: 'currentColor',
          maskImage: `url(/assets/logos/${variant.template}.png)`,
          WebkitMaskImage: `url(/assets/logos/${variant.template}.png)`,
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

  if ('file' in variant) {
    return (
      <img
        alt={alt}
        className="brand-logo"
        src={`/assets/logos/${variant.file}.png`}
        width={size}
        height={size}
        style={logoStyle}
        onError={() => setHasError(true)}
      />
    );
  }

  return (
    <span className="brand-logo-pair" style={logoStyle}>
      <img
        alt=""
        className="brand-logo brand-logo--dark"
        src={`/assets/logos/${variant.onDark}.png`}
        width={size}
        height={size}
        onError={() => setHasError(true)}
      />
      <img
        alt={alt}
        className="brand-logo brand-logo--light"
        src={`/assets/logos/${variant.onLight}.png`}
        width={size}
        height={size}
        onError={() => setHasError(true)}
      />
    </span>
  );
};

export const PluginCard: React.FC<PluginCardProps> = ({
  plugin,
  connection,
  onAction,
  onToggleStatus,
  onOpenDetails,
  onConnectAction,
}) => {
  const effectiveState: PluginConnectionState =
    connection?.state ??
    ((plugin as any).status === 'installed'
      ? 'connected'
      : (plugin.initialState as PluginConnectionState) ?? 'disconnected');

  const effectiveConnection: PluginConnection = connection ?? {
    id: plugin.id,
    state: effectiveState,
    account: (plugin as any).config?.account ?? null,
    message: null,
  };

  const copy = resolveCardCopy(plugin, effectiveConnection);

  const handleAction = (act: PluginAction, e: React.MouseEvent) => {
    e.stopPropagation();
    onAction?.(plugin.id, act);
    onConnectAction?.(plugin);
    onToggleStatus?.(plugin);
  };

  const renderActionButton = () => {
    if (effectiveState === 'preview' || effectiveState === 'unavailable') {
      return (
        <span className="plugin-connect plugin-connect--chip">
          {effectiveState === 'preview' ? 'Preview' : 'Unavailable'}
        </span>
      );
    }

    if (effectiveState === 'connecting') {
      return (
        <button
          aria-label={`Cancel ${plugin.name}`}
          className="plugin-connect plugin-connect--quiet"
          onClick={(e) => handleAction('cancel', e)}
          type="button"
        >
          <span aria-hidden="true" className="button-spinner" />
          Cancel
        </button>
      );
    }

    if (effectiveState === 'connected') {
      return (
        <button
          aria-label={`Disconnect ${plugin.name}`}
          className="plugin-connect plugin-connect--linked"
          onClick={(e) => handleAction('disconnect', e)}
          title="Disconnect"
          type="button"
        >
          <span aria-hidden="true" className="plugin-connect__swap">
            <span className="plugin-connect__rest">
              <i className="plugin-connect__dot" />
              Connected
            </span>
            <span className="plugin-connect__hover">Disconnect</span>
          </span>
        </button>
      );
    }

    if (effectiveState === 'needsReauth') {
      return (
        <button
          aria-label={`Reconnect ${plugin.name}`}
          className="plugin-connect"
          onClick={(e) => handleAction('connect', e)}
          type="button"
        >
          Reconnect
        </button>
      );
    }

    if (effectiveState === 'disconnectPending') {
      return (
        <button
          aria-label={`Disconnect ${plugin.name}`}
          className="plugin-connect"
          onClick={(e) => handleAction('disconnect', e)}
          type="button"
        >
          Disconnect
        </button>
      );
    }

    // Default: disconnected
    return (
      <button
        aria-label={`Connect ${plugin.name}`}
        className="plugin-connect"
        onClick={(e) => handleAction('connect', e)}
        type="button"
      >
        Connect
      </button>
    );
  };

  return (
    <article
      aria-label={`${plugin.name}, ${plugin.vendor}`}
      className="plugin-card"
      data-plugin={plugin.id}
      style={{ cursor: 'pointer' }}
      onClick={() => onOpenDetails?.(plugin)}
    >
      {/* Tile with official logo */}
      <span
        aria-hidden="true"
        className={`plugin-card__tile${plugin.prefersDarkTile ? ' plugin-card__tile--ink' : ''}`}
      >
        <BrandLogo
          alt={plugin.name}
          size={20}
          variant={plugin.logo}
          fallbackIcon={plugin.fallbackIcon}
        />
      </span>

      {/* Plugin Copy */}
      <span className="plugin-card__copy">
        <strong>{plugin.name}</strong>
        <small aria-live="polite" title={copy.text} data-tone={copy.tone}>
          {copy.text}
        </small>
      </span>

      {/* Action button state */}
      {renderActionButton()}
    </article>
  );
};
