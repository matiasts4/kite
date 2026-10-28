import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { usePresence } from '../../motion/usePresence';
import { MOTION_EXIT_MS } from '../../motion/contract';
import { surfaceMotion } from '../../motion/standard/surfaces';
import { SunIcon, MoonIcon, SettingsIcon } from './sidebarIcons';
import type { ContextMenuState } from './types';
import { UpdateDetailCard, UpdateCircularButton } from './UpdatePill';
import { useAppUpdater } from '../../hooks/useAppUpdater';

export interface SidebarFooterProps {
  accountName?: string;
  /** @deprecated Plans and credits are no longer displayed in the sidebar */
  accountTier?: string;
  /** @deprecated Plans and credits are no longer displayed in the sidebar */
  accountTierPaid?: boolean;
  /** @deprecated Plans and credits are no longer displayed in the sidebar */
  creditsLabel?: string;
  appearance: 'dark' | 'light';
  onToggleAppearance: () => void;
  onOpenSettings: () => void;
}

export const SidebarFooter: React.FC<SidebarFooterProps> = ({
  accountName,
  appearance,
  onToggleAppearance,
  onOpenSettings,
}) => {
  const { state } = useAppUpdater();
  const [showUpdateDetails, setShowUpdateDetails] = useState(false);

  // Auto-expand details card when an update is available or ready, collapse on idle/uptodate
  useEffect(() => {
    if (state.status === 'available' || state.status === 'ready') {
      setShowUpdateDetails(true);
    } else if (state.status === 'idle' || state.status === 'uptodate' || state.status === 'error') {
      setShowUpdateDetails(false);
    }
  }, [state.status]);

  return (
    <footer className="sidebar__footer" style={{ position: 'relative' }}>
      <UpdateDetailCard
        isOpen={showUpdateDetails}
        onClose={() => setShowUpdateDetails(false)}
      />
      <div className="sidebar__rule" />
      <div className="account-row">
        <button
          aria-label="Account"
          className="account-row__identity"
          onClick={onOpenSettings}
          title={accountName ? `${accountName} · Account settings` : 'Account settings'}
          type="button"
        >
          <span aria-hidden="true" className="account-row__avatar">
            {accountName ? accountName.trim().charAt(0).toUpperCase() : 'K'}
          </span>
          <span className="account-row__copy">
            <span
              className="account-row__name"
              style={{
                fontSize: 'var(--text-row, 12px)',
                fontWeight: 'var(--weight-medium, 500)',
                color: 'var(--text-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                lineHeight: 'var(--leading-row, 16px)',
              }}
            >
              {accountName || 'Kite'}
            </span>
          </span>
        </button>

        {/* Circular update button */}
        <UpdateCircularButton
          onToggleDetails={() => setShowUpdateDetails((prev) => !prev)}
          isDetailsOpen={showUpdateDetails}
        />

        <button
          aria-label={`Use ${appearance === 'dark' ? 'light' : 'dark'} theme`}
          className="chrome-button"
          onClick={onToggleAppearance}
          title={`Use ${appearance === 'dark' ? 'light' : 'dark'} theme`}
          type="button"
        >
          {appearance === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>

        <button
          aria-label="Settings"
          className="chrome-button"
          onClick={onOpenSettings}
          title="Settings"
          type="button"
        >
          <SettingsIcon />
        </button>
      </div>
    </footer>
  );
};

export interface SidebarContextMenuProps {
  contextMenu: ContextMenuState | null;
  onClose: () => void;
}

export const SidebarContextMenu: React.FC<SidebarContextMenuProps> = ({ contextMenu, onClose }) => {
  const [heldMenu, setHeldMenu] = useState<ContextMenuState | null>(null);
  const menuPresence = usePresence(Boolean(contextMenu));

  useEffect(() => {
    if (contextMenu) setHeldMenu(contextMenu);
  }, [contextMenu]);

  if (!menuPresence.mounted || !heldMenu) return null;

  const menuWidth = 220;
  const menuEstimatedHeight = 280;
  const x = Math.min(Math.max(heldMenu.x, 8), window.innerWidth - menuWidth - 8);
  const y = Math.min(Math.max(heldMenu.y, 8), window.innerHeight - menuEstimatedHeight - 8);
  // Grow from the trigger corner even when the menu is clamped into the viewport.
  const originX = Math.max(0, heldMenu.x - x);
  const originY = Math.max(0, heldMenu.y - y);

  const menuElement = (
    <motion.div
      {...surfaceMotion('menu', { exitMs: MOTION_EXIT_MS })}
      className="ui-menu scroll-quiet"
      role="menu"
      style={
        {
          position: 'fixed',
          left: x,
          top: y,
          zIndex: 99999,
          transformOrigin: `${originX}px ${originY}px`,
          animation: 'none',
        } as React.CSSProperties
      }
    >
      {heldMenu.header && (
        <>
          <div className="ui-menu__header" role="presentation">
            <span className="ui-menu__title">{heldMenu.header.title}</span>
            {heldMenu.header.subtitle && (
              <span className="ui-menu__subtitle">{heldMenu.header.subtitle}</span>
            )}
          </div>
          <div aria-hidden="true" className="ui-menu__rule" />
        </>
      )}

      {heldMenu.sections.map((section, secIdx) => (
        <React.Fragment key={secIdx}>
          {secIdx > 0 && <div aria-hidden="true" className="ui-menu__rule" />}
          {section.map((item) => (
            <div
              key={item.id}
              aria-disabled={item.disabled ? true : undefined}
              className={`ui-menu__row${
                item.role === 'destructive' ? ' ui-menu__row--destructive' : ''
              }${item.detail ? ' ui-menu__row--detail' : ''}`}
              onClick={() => {
                if (item.disabled) return;
                onClose();
                item.action();
              }}
              role="menuitem"
              tabIndex={-1}
            >
              {item.icon && (
                <span aria-hidden="true" className="ui-menu__icon">
                  {item.icon}
                </span>
              )}
              <span className="ui-menu__label">
                <span className="ui-menu__row-title">{item.title}</span>
                {item.detail && <span className="ui-menu__row-detail">{item.detail}</span>}
              </span>
              {item.shortcut && (
                <span aria-hidden="true" className="ui-menu__shortcut">
                  {item.shortcut}
                </span>
              )}
            </div>
          ))}
        </React.Fragment>
      ))}
    </motion.div>
  );

  return typeof document !== 'undefined' ? (
    createPortal(
      <AnimatePresence>{menuPresence.phase === 'in' && menuElement}</AnimatePresence>,
      document.body
    )
  ) : (
    menuElement
  );
};
