import React, { useEffect, useState } from 'react';
import type {
  PluginRecordDto,
  PluginSourceKind,
  SidecarStatusSnapshot,
} from '../../../lib/ipc/pluginRuntime';
import {
  OPEN_RIGHT_DOCK_SIDECAR_EVENT,
  openSidecarInRightDock,
} from '../../../lib/sidecarNav';
import { PuzzleIcon } from './pluginIcons';

export { OPEN_RIGHT_DOCK_SIDECAR_EVENT };

export function getPluginSourceLabel(source: PluginSourceKind): string {
  switch (source) {
    case 'globalKite':
      return 'Kite';
    case 'workspace':
      return 'Workspace';
    case 'sharedSystem':
      return 'Sistema';
  }
}

export function dispatchOpenRightDockSidecar(
  sidecar: SidecarStatusSnapshot,
  viewPath?: string
): string {
  const targetPath =
    (viewPath && viewPath.trim()) ||
    sidecar.views?.[0]?.path?.trim() ||
    '/';
  const title =
    sidecar.views?.find((view) => view.path === targetPath)?.title ||
    sidecar.views?.[0]?.title ||
    sidecar.displayName ||
    sidecar.pluginName;

  openSidecarInRightDock({
    sidecarId: sidecar.namespacedId,
    viewPath: targetPath,
    title,
  });
  return targetPath;
}

export interface InstalledPluginCardProps {
  plugin: PluginRecordDto;
  onOpenDetails: (plugin: PluginRecordDto) => void;
  onToggleEnabled: (dirId: string, enabled: boolean) => Promise<unknown> | void;
  onOpenSidecar?: (sidecar: SidecarStatusSnapshot, viewPath: string) => void;
}

export const InstalledPluginCard: React.FC<InstalledPluginCardProps> = ({
  plugin,
  onOpenDetails,
  onToggleEnabled,
  onOpenSidecar,
}) => {
  const [logoError, setLogoError] = useState(false);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    setLogoError(false);
  }, [plugin.logoDataUri]);

  const title = plugin.displayName || plugin.name;
  const sourceLabel = getPluginSourceLabel(plugin.source);
  const uiSidecar = plugin.sidecars.find((sidecar) => sidecar.hasWebUi) ?? null;
  const hasRunningSidecar = plugin.sidecars.some((sidecar) => sidecar.state === 'running');

  const handleToggle = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (toggling) return;
    setToggling(true);
    try {
      await onToggleEnabled(plugin.dirId, !plugin.enabled);
    } catch (err) {
      console.warn('[InstalledPluginCard] Failed to toggle plugin state:', err);
    } finally {
      setToggling(false);
    }
  };

  const handleOpenPanel = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!uiSidecar || !plugin.enabled) return;
    const viewPath = dispatchOpenRightDockSidecar(uiSidecar);
    onOpenSidecar?.(uiSidecar, viewPath);
  };

  const handleCardKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpenDetails(plugin);
    }
  };

  return (
    <article
      aria-label={`${title} (${sourceLabel})`}
      className={`installed-plugin-card${plugin.enabled ? '' : ' installed-plugin-card--disabled'}`}
      data-plugin-id={plugin.dirId}
      data-source={plugin.source}
      onClick={() => onOpenDetails(plugin)}
      onKeyDown={handleCardKeyDown}
      tabIndex={0}
    >
      <div className="installed-plugin-card__top">
        <span aria-hidden="true" className="installed-plugin-card__tile">
          {plugin.logoDataUri && !logoError ? (
            <img
              alt=""
              className="installed-plugin-card__logo"
              src={plugin.logoDataUri}
              onError={() => setLogoError(true)}
            />
          ) : (
            <PuzzleIcon size={18} />
          )}
        </span>

        <div className="installed-plugin-card__identity">
          <div className="installed-plugin-card__title-row">
            <strong className="installed-plugin-card__title">{title}</strong>
            {plugin.version ? (
              <span className="installed-plugin-card__version">{plugin.version}</span>
            ) : null}
          </div>
          <div className="installed-plugin-card__meta-row">
            <span
              className={`installed-plugin-card__source installed-plugin-card__source--${plugin.source}`}
            >
              {sourceLabel}
            </span>
            {plugin.author ? (
              <span className="installed-plugin-card__author">{plugin.author}</span>
            ) : null}
          </div>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={plugin.enabled}
          aria-label={`${plugin.enabled ? 'Desactivar' : 'Activar'} ${title}`}
          className="ui-switch installed-plugin-card__switch"
          disabled={toggling}
          onClick={handleToggle}
        >
          <span className="ui-switch__knob" />
        </button>
      </div>

      <p className="installed-plugin-card__description">
        {plugin.description || 'Extensión instalada en Kite Code.'}
      </p>

      <div className="installed-plugin-card__footer">
        <div className="installed-plugin-card__badges">
          {plugin.sidecars.length > 0 ? (
            <span
              className={`installed-plugin-card__badge${
                hasRunningSidecar ? ' installed-plugin-card__badge--running' : ''
              }`}
            >
              {hasRunningSidecar ? <i aria-hidden="true" className="installed-plugin-card__dot" /> : null}
              {plugin.sidecars.length}{' '}
              {plugin.sidecars.length === 1 ? 'sidecar' : 'sidecars'}
            </span>
          ) : null}
          {plugin.mcpServers.length > 0 ? (
            <span className="installed-plugin-card__badge">
              {plugin.mcpServers.length} MCP
            </span>
          ) : null}
          {plugin.skills.length > 0 ? (
            <span className="installed-plugin-card__badge">
              {plugin.skills.length}{' '}
              {plugin.skills.length === 1 ? 'skill' : 'skills'}
            </span>
          ) : null}
          {plugin.ruleNames.length > 0 ? (
            <span className="installed-plugin-card__badge">
              {plugin.ruleNames.length}{' '}
              {plugin.ruleNames.length === 1 ? 'regla' : 'reglas'}
            </span>
          ) : null}
          {plugin.hasHooks ? (
            <span className="installed-plugin-card__badge">Hooks</span>
          ) : null}
        </div>

        {plugin.enabled && uiSidecar ? (
          <button
            type="button"
            className="secondary-button installed-plugin-card__open-btn"
            onClick={handleOpenPanel}
          >
            Abrir panel
          </button>
        ) : null}
      </div>
    </article>
  );
};
