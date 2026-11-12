import React from 'react';
import {
  type SidePanelAppId,
  STANDARD_MENU_TABS,
  APP_MENU_TABS,
} from './dockConfig';

export interface DockNewTabMenuProps {
  isOpen: boolean;
  onClose: () => void;
  highlightedMenuId: string | null;
  setHighlightedMenuId: (id: string | null) => void;
  onOpenStandardTab: (kind: 'browser' | 'files' | 'diffs' | 'tasks' | 'prompts' | 'subagents') => void;
  onOpenAppTab: (appId: SidePanelAppId) => void;
  menuRef?: React.RefObject<HTMLDivElement | null>;
}

export const DockNewTabMenu: React.FC<DockNewTabMenuProps> = ({
  isOpen,
  onClose,
  highlightedMenuId,
  setHighlightedMenuId,
  onOpenStandardTab,
  onOpenAppTab,
  menuRef,
}) => {
  if (!isOpen) return null;

  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 59 }}
        onClick={onClose}
      />
      <div
        ref={menuRef as any}
        role="menu"
        aria-label="New tab"
        className="ui-menu side-panel-add-menu scroll-quiet"
        onMouseLeave={() => setHighlightedMenuId(null)}
        style={{
          position: 'absolute',
          top: 'calc(var(--pane-header-height, 36px) + 2px)',
          right: 0,
          zIndex: 60,
        }}
      >
        <div className="ui-menu__header" role="presentation">
          <span className="ui-menu__title">New tab</span>
        </div>
        <div aria-hidden="true" className="ui-menu__rule" />

        {STANDARD_MENU_TABS.map((item) => {
          const id = `std-${item.kind}`;
          const isHighlighted = highlightedMenuId === id;
          return (
            <div
              key={item.kind}
              role="menuitem"
              tabIndex={-1}
              className="ui-menu__row"
              data-highlighted={isHighlighted ? 'true' : undefined}
              onMouseEnter={() => setHighlightedMenuId(id)}
              onClick={() => onOpenStandardTab(item.kind)}
            >
              <span aria-hidden="true" className="ui-menu__icon">
                {item.icon}
              </span>
              <span className="ui-menu__label">
                <span className="ui-menu__row-title">{item.label}</span>
              </span>
              {item.shortcut && (
                <span aria-hidden="true" className="ui-menu__shortcut">
                  {item.shortcut}
                </span>
              )}
            </div>
          );
        })}

        <div aria-hidden="true" className="ui-menu__rule" />
        <div className="ui-menu__heading" role="presentation">
          Apps
        </div>

        {APP_MENU_TABS.map((item) => {
          const id = `app-${item.appId}`;
          const isHighlighted = highlightedMenuId === id;
          return (
            <div
              key={item.appId}
              role="menuitem"
              tabIndex={-1}
              className="ui-menu__row"
              data-highlighted={isHighlighted ? 'true' : undefined}
              onMouseEnter={() => setHighlightedMenuId(id)}
              onClick={() => onOpenAppTab(item.appId)}
            >
              <span aria-hidden="true" className="ui-menu__icon">
                {item.icon}
              </span>
              <span className="ui-menu__label">
                <span className="ui-menu__row-title">{item.label}</span>
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
};
