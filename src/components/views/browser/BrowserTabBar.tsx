import React from 'react';
import type { BrowserSurfaceView } from '../../../types';
import { browserAddressLabel } from './browserAddress';
import { BotIcon, EarthIcon, PlusIcon, ShieldAlertIcon, XIcon } from './browserIcons';

export interface BrowserTabBarProps {
  surfaces: BrowserSurfaceView[];
  activeSurfaceId: string | null;
  onSelectTab: (surface: BrowserSurfaceView) => void;
  onCloseTab: (surface: BrowserSurfaceView) => void;
  onNewTab: () => void;
}

function tabDisplayLabel(surface: BrowserSurfaceView): string {
  const title = surface.title?.trim();
  if (title && title.length > 0 && title !== 'about:blank') {
    return title;
  }
  if (surface.displayUrl) {
    return browserAddressLabel(surface.displayUrl);
  }
  return surface.ownerKind === 'agent' ? 'Agent tab' : 'New tab';
}

export const BrowserTabBar: React.FC<BrowserTabBarProps> = ({
  surfaces,
  activeSurfaceId,
  onSelectTab,
  onCloseTab,
  onNewTab,
}) => {
  if (surfaces.length === 0) return null;

  return (
    <div
      className="browser-tabbar"
      role="tablist"
      aria-label="Browser tabs"
      data-testid="browser-tabbar"
    >
      <div className="browser-tabbar__list">
        {surfaces.map((surface) => {
          const isActive = surface.surfaceId === activeSurfaceId;
          const isAgent = surface.ownerKind === 'agent' || Boolean(surface.agentActive);
          const isPaused = Boolean(surface.pausedForAuth);
          const label = tabDisplayLabel(surface);

          return (
            <div
              key={surface.surfaceId}
              className={`browser-tabbar__item${isActive ? ' browser-tabbar__item--active' : ''}${isAgent ? ' browser-tabbar__item--agent' : ''}${isPaused ? ' browser-tabbar__item--paused' : ''}`}
              role="presentation"
            >
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                className="browser-tabbar__trigger"
                data-testid={`browser-tab-${surface.surfaceId}`}
                onClick={() => onSelectTab(surface)}
                title={
                  surface.statusPill
                    ? `${label} — ${surface.statusPill}`
                    : surface.displayUrl || label
                }
              >
                <span className="browser-tabbar__icon" aria-hidden="true">
                  {isPaused ? (
                    <ShieldAlertIcon size={11} />
                  ) : isAgent ? (
                    <BotIcon size={11} />
                  ) : (
                    <EarthIcon size={11} />
                  )}
                </span>
                <span className="browser-tabbar__label">{label}</span>
                {isAgent && (
                  <span
                    className={`browser-tabbar__badge${surface.agentActive ? ' browser-tabbar__badge--live' : ''}${isPaused ? ' browser-tabbar__badge--paused' : ''}`}
                  >
                    {isPaused ? 'Auth' : surface.agentActive ? 'Agent' : 'Idle'}
                  </span>
                )}
              </button>
              <button
                type="button"
                className="browser-tabbar__close"
                aria-label={`Close tab ${label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(surface);
                }}
              >
                <XIcon size={10} />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="browser-tabbar__new"
        aria-label="New browser tab"
        title="New browser tab"
        data-testid="browser-new-tab-btn"
        onClick={onNewTab}
      >
        <PlusIcon size={12} />
      </button>
    </div>
  );
};
