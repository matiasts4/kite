import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { springs, scale } from '../motion/standard/tokens';
import { windowControls } from '../lib/ipc';
import { SubscriptionQuotaBadge } from './quota/SubscriptionQuotaBadge';
import { SystemResourceBadge } from './telemetry/SystemResourceBadge';
import { readQuotaPreferences, QUOTA_PREFS_CHANGED_EVENT } from '../lib/quota/quotaManager';
import './zedFloat.css';

export type TitleBarMode = 'agent' | 'code' | 'chat';

export interface TitleBarProps {
  title?: string;
  activeMode?: TitleBarMode;
  onModeChange?: (mode: TitleBarMode) => void;
  sidebarVisible?: boolean;
  onToggleSidebar?: () => void;
  browserVisible?: boolean;
  onToggleBrowser?: () => void;
  operatorVisible?: boolean;
  onToggleOperator?: () => void;
  settingsOpen?: boolean;
  unreadCount?: number;
  onOpenNotifications?: (anchorRect?: DOMRect) => void;
  onOpenUsage?: () => void;
  platform?: 'windows' | 'macos' | 'linux';
  activeSessionTitle?: string | null;
  activeEngine?: string | null;
}

/**
 * Mode labels and descriptions:
 * qr = { agent: 'Agent', code: 'Code', chat: 'Thread' }
 * Jr = {
 *   agent: 'Agent mode â€” hand work to agents that remember and improve',
 *   code: 'Code mode â€” work in a folder, open panes, ship',
 *   chat: 'Thread mode â€” work by conversation, with a folder when you need one'
 * }
 */
const MODE_DESCRIPTIONS: Record<TitleBarMode, { label: string; title: string }> = {
  agent: {
    label: 'Agent',
    title: 'Agent mode â€” hand work to agents that remember and improve',
  },
  code: {
    label: 'Code',
    title: 'Code mode â€” work in a folder, open panes, ship',
  },
  chat: {
    label: 'Thread',
    title: 'Thread mode â€” work by conversation, with a folder when you need one',
  },
};

export const TitleBar: React.FC<TitleBarProps> = ({
  title = 'Kite',
  activeMode = 'agent',
  onModeChange,
  sidebarVisible = true,
  onToggleSidebar,
  browserVisible = false,
  onToggleBrowser,
  operatorVisible = false,
  onToggleOperator,
  settingsOpen = false,
  unreadCount = 0,
  onOpenNotifications,
  onOpenUsage,
  platform = 'windows',
  activeSessionTitle = null,
  activeEngine = null,
}) => {
  const [isMax, setIsMax] = useState(false);
  const [thumbReady, setThumbReady] = useState(false);
  const trackRef = useRef<HTMLFieldSetElement>(null);
  const [quotaEnabled, setQuotaEnabled] = useState(() => {
    try {
      return readQuotaPreferences().enabled;
    } catch {
      return true;
    }
  });

  useEffect(() => {
    const handler = (e: any) => {
      if (e?.detail && typeof e.detail.enabled === 'boolean') {
        setQuotaEnabled(e.detail.enabled);
      }
    };
    window.addEventListener(QUOTA_PREFS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(QUOTA_PREFS_CHANGED_EVENT, handler);
  }, []);

  // Sync window maximized state across native Tauri and browser fallback
  useEffect(() => {
    let mounted = true;
    let timer: any = null;
    const checkMax = async () => {
      try {
        const val = await windowControls.isMaximized();
        if (mounted) setIsMax(val);
      } catch (_) {}
    };
    checkMax();

    const debouncedCheck = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(checkMax, 120);
    };

    window.addEventListener('resize', debouncedCheck);
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
      window.removeEventListener('resize', debouncedCheck);
    };
  }, []);

  useEffect(() => {
    setThumbReady(true);
  }, []);

  const handleToggleMaximize = async () => {
    try {
      await windowControls.toggleMaximize();
      const val = await windowControls.isMaximized();
      setIsMax(val);
    } catch (e) {
      console.error(e);
    }
  };

  const handleMinimize = async () => {
    try {
      await windowControls.minimize();
    } catch (e) {
      console.error(e);
    }
  };

  const handleClose = async () => {
    try {
      await windowControls.close();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <header
      className={`titlebar titlebar--${platform}`}
      data-platform={platform}
      data-tauri-drag-region
      style={{ height: 'var(--chrome-band-height, 40px)', minHeight: 'var(--chrome-band-height, 40px)' }}
      onMouseDown={(e) => {
        const target = e.target as HTMLElement;
        if (
          e.buttons === 1 &&
          target.closest('[data-tauri-drag-region]') &&
          !target.closest('button, input, select, textarea, [data-no-drag], fieldset')
        ) {
          windowControls.startDragging().catch(() => {});
        }
      }}
      onDoubleClick={(e) => {
        const target = e.target as HTMLElement;
        if (
          target.closest('[data-tauri-drag-region]') &&
          !target.closest('button, input, select, textarea, [data-no-drag], fieldset')
        ) {
          handleToggleMaximize();
        }
      }}
    >
      {/* Brand & Leading Area */}
      <div
        className="titlebar__leading"
        data-tauri-drag-region
      >
        <div className="brand-lockup" data-tauri-drag-region>
          <img
            className="brand-lockup__mark"
            src="/assets/kite-symbol.svg"
            alt=""
            aria-hidden="true"
            width={18}
            height={18}
            style={{ borderRadius: 4, display: 'block' }}
          />
          <span data-tauri-drag-region>
            {title}
          </span>
        </div>

        {!settingsOpen && onToggleSidebar && (
          <button
            aria-pressed={sidebarVisible}
            data-rail-toggle
            className={`chrome-button${sidebarVisible ? ' chrome-button--selected' : ''}`}
            onClick={onToggleSidebar}
            title={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
            aria-label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
            type="button"
          >
            {/* Panel-left icon */}
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <path d="M9 3v18" />
            </svg>
          </button>
        )}
      </div>

      {/* Mode Toggle (Agent | Code | Thread) — Stadium Pill & Animated UI standard */}
      {!settingsOpen && (
        <fieldset
          aria-label="Work mode"
          className="mode-toggle mode-toggle--stadium"
          data-mode={activeMode}
          data-thumb-ready={thumbReady ? '' : undefined}
          ref={trackRef}
        >
          {(['agent', 'code', 'chat'] as const).map((m) => {
            const { label, title: modeTitle } = MODE_DESCRIPTIONS[m];
            const isActive = activeMode === m;
            return (
              <motion.button
                key={m}
                type="button"
                aria-pressed={isActive}
                whileTap={{ scale: scale.press }}
                className={`mode-toggle__item${isActive ? ' mode-toggle__item--active' : ''}`}
                data-label={label}
                onClick={() => onModeChange?.(m)}
                title={modeTitle}
              >
                {isActive && (
                  <motion.div
                    layoutId="titlebar-mode-toggle-indicator"
                    className="mode-toggle__stadium-indicator"
                    transition={springs.selection}
                    initial={false}
                    aria-hidden="true"
                    data-mode={m}
                  >
                    <div className="mode-toggle__stadium-backdrop" />
                  </motion.div>
                )}
                <span className="mode-toggle__label-text">{label}</span>
              </motion.button>
            );
          })}
        </fieldset>
      )}

      {/* Trailing Area / Status & Window Controls */}
      <div className="titlebar__trailing" data-tauri-drag-region>
        {/* Zed Operator Assistant Button */}
        <button
          type="button"
          className={`chrome-button zed-toggle-button${
            operatorVisible ? ' chrome-button--selected zed-toggle-button--active' : ''
          }`}
          data-testid="operator-toggle"
          aria-label="Asistente Zed (Operador y Voz)"
          aria-pressed={operatorVisible}
          aria-keyshortcuts={platform === 'macos' ? 'Meta+Shift+K' : 'Control+Shift+K'}
          title={`Asistente Zed (${platform === 'macos' ? 'Cmd+Shift+K' : 'Ctrl+Shift+K'})`}
          onClick={onToggleOperator}
        >
          <span
            className="zed-mini-orb"
            data-active={operatorVisible ? 'true' : 'false'}
            aria-hidden="true"
          />
        </button>

        {/* Usage slot per production markup */}
        <span
          data-usage-meter-slot=""
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}
        >
          <SystemResourceBadge />

          {quotaEnabled ? (
            <SubscriptionQuotaBadge
              activeSessionTitle={activeSessionTitle}
              activeEngine={activeEngine}
              onOpenTokenUsage={onOpenUsage}
            />
          ) : null}

          {!quotaEnabled && onOpenUsage ? (
            <button
              type="button"
              className="usage-meter-button"
              onClick={onOpenUsage}
              title="Open usage & credits dashboard"
              aria-label="Open usage & credits dashboard"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0 8px',
                height: '24px',
                width: 'auto',
                borderRadius: '6px',
                border: '1px solid var(--block-stroke)',
                fontSize: '11px',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              Tokens
            </button>
          ) : null}
        </span>

        {/* Notification Bell */}
        <button
          type="button"
          className={`chrome-button notification-bell${
            unreadCount > 0 ? ' notification-bell--active' : ''
          }`}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            onOpenNotifications?.(rect);
          }}
          title={unreadCount > 0 ? `${unreadCount} unread notifications` : 'Notifications'}
          aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
          aria-haspopup="dialog"
        >
          {/* Bell icon */}
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill={unreadCount > 0 ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M10.268 21a2 2 0 0 0 3.464 0" />
            <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
          </svg>
          {unreadCount > 0 && (
            <span className="notification-bell__badge" aria-hidden="true">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </button>

        {/* App Browser / Side Panel Toggle Button */}
        {onToggleBrowser && (
          <button
            aria-label="Side panel"
            aria-pressed={browserVisible}
            aria-keyshortcuts={platform === 'macos' ? 'Meta+Shift+B' : 'Control+Shift+B'}
            className={`chrome-button${browserVisible ? ' chrome-button--selected' : ''}`}
            data-testid="side-panel-toggle"
            onClick={onToggleBrowser}
            title={`Side panel (${platform === 'macos' ? 'âŒ˜â‡§B' : 'Ctrl+Shift+B'})`}
            type="button"
          >
            {/* Panel-right icon */}
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <path d="M15 3v18" />
            </svg>
          </button>
        )}

        {/* Window Caption Controls (Windows 11 native) */}
        {platform !== 'macos' && (
          <fieldset
            aria-label="Window controls"
            className="window-controls"
            data-tauri-drag-region="false"
          >
            <button
              aria-label="Minimize"
              title="Minimize"
              onClick={handleMinimize}
              type="button"
            >
              <svg
                aria-hidden="true"
                fill="none"
                focusable="false"
                height="10"
                stroke="currentColor"
                strokeWidth="1"
                viewBox="0 0 10 10"
                width="10"
              >
                <path d="M0 5.5H10" />
              </svg>
            </button>
            <button
              aria-label={isMax ? 'Restore' : 'Maximize'}
              title={isMax ? 'Restore' : 'Maximize'}
              onClick={handleToggleMaximize}
              type="button"
            >
              {isMax ? (
                <svg
                  aria-hidden="true"
                  fill="none"
                  focusable="false"
                  height="10"
                  stroke="currentColor"
                  strokeWidth="1"
                  viewBox="0 0 10 10"
                  width="10"
                >
                  <rect height="7" width="7" x="0.5" y="2.5" />
                  <path d="M2.5 2.5V0.5H9.5V7.5H7.5" />
                </svg>
              ) : (
                <svg
                  aria-hidden="true"
                  fill="none"
                  focusable="false"
                  height="10"
                  stroke="currentColor"
                  strokeWidth="1"
                  viewBox="0 0 10 10"
                  width="10"
                >
                  <rect height="9" width="9" x="0.5" y="0.5" />
                </svg>
              )}
            </button>
            <button
              aria-label="Close"
              className="window-controls__close"
              title="Close"
              onClick={handleClose}
              type="button"
            >
              <svg
                aria-hidden="true"
                fill="none"
                focusable="false"
                height="10"
                stroke="currentColor"
                strokeWidth="1"
                viewBox="0 0 10 10"
                width="10"
              >
                <path d="M0.5 0.5L9.5 9.5M9.5 0.5L0.5 9.5" />
              </svg>
            </button>
          </fieldset>
        )}
      </div>
    </header>
  );
};
