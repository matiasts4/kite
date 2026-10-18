import React, { useState } from 'react';
import type { ActivePlugin, PluginLogo } from './types';
import {
  PuzzleIcon,
  BugIcon,
  SendIcon,
} from './pluginIcons';

export interface PluginCardProps {
  plugin: ActivePlugin;
  onToggleStatus: (plugin: ActivePlugin) => void;
  onOpenDetails: (plugin: ActivePlugin) => void;
  onConnectAction: (plugin: ActivePlugin) => void;
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
  onToggleStatus: _onToggleStatus,
  onOpenDetails,
  onConnectAction,
}) => {
  const isInstalled = plugin.status === 'installed';
  const isUnavailable = plugin.initialState === 'unavailable';
  const isPreview = plugin.initialState === 'preview';

  const summaryText = isInstalled
    ? 'Connected'
    : isUnavailable
    ? 'Account setup is not available in this build.'
    : plugin.summary;

  return (
    <article
      aria-label={`${plugin.name}, ${plugin.vendor}`}
      className="plugin-card"
      data-plugin={plugin.id}
      style={{ cursor: 'pointer' }}
      onClick={() => onOpenDetails(plugin)}
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
        <small aria-live="polite" title={summaryText} data-tone={isUnavailable ? 'failed' : undefined}>
          {summaryText}
        </small>
      </span>

      {/* Connect Action chip/button */}
      {isPreview || isUnavailable ? (
        <span className="plugin-connect plugin-connect--chip">
          {isPreview ? 'Preview' : 'Unavailable'}
        </span>
      ) : isInstalled ? (
        <button
          aria-label={`Disconnect ${plugin.name}`}
          className="plugin-connect plugin-connect--linked"
          onClick={(e) => {
            e.stopPropagation();
            onConnectAction(plugin);
          }}
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
      ) : (
        <button
          aria-label={`Connect ${plugin.name}`}
          className="plugin-connect"
          onClick={(e) => {
            e.stopPropagation();
            onConnectAction(plugin);
          }}
          type="button"
        >
          Connect
        </button>
      )}
    </article>
  );
};
