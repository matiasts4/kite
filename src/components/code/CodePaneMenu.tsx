import React from 'react';
import { createPortal } from 'react-dom';
import type { AgentEngineDescriptor, PaneOccupant } from './types';
import { SquareTerminalIcon, SplitHorizontalIcon, PlusIcon } from './codeIcons';
import { BrandLogo } from '../views/agents/engineMetadata';

export interface CodePaneActionsMenuProps {
  displayName: string;
  workspaceName: string;
  occupant: PaneOccupant;
  canSwap: boolean;
  anchorRect?: DOMRect | null;
  onSplit: (axis: 'vertical' | 'horizontal') => void;
  onSwap: (offset: -1 | 1) => void;
  onExtractToTab: () => void;
  onEqualize: () => void;
  onRename: () => void;
  onClose: () => void;
  onTerminalCommand: (command: 'font-larger' | 'font-smaller' | 'clear' | 'interrupt' | 'restart') => void;
  onResumePrevious?: () => void;
  onCloseMenu: () => void;
}

export const CodePaneActionsMenu: React.FC<CodePaneActionsMenuProps> = ({
  displayName,
  workspaceName,
  occupant,
  canSwap,
  anchorRect,
  onSplit,
  onSwap,
  onExtractToTab,
  onEqualize,
  onRename,
  onClose,
  onTerminalCommand,
  onResumePrevious,
  onCloseMenu,
}) => {
  const menuStyle: React.CSSProperties = anchorRect
    ? {
        position: 'fixed',
        top: `${Math.min(anchorRect.bottom + 4, window.innerHeight - 340)}px`,
        right: `${Math.max(8, window.innerWidth - anchorRect.right)}px`,
        zIndex: 99999,
      }
    : {};

  const menuElement = (
    <div
      className="ui-menu ui-menu--plain code-pane-menu"
      role="menu"
      style={menuStyle}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="ui-menu__header" role="presentation">
        <span className="ui-menu__title">{displayName}</span>
        <span className="ui-menu__subtitle">{workspaceName}</span>
      </div>
      <div className="ui-menu__rule" aria-hidden="true" />

      {/* Split actions */}
      <div
        role="menuitem"
        className="ui-menu__row"
        onClick={() => {
          onCloseMenu();
          onSplit('vertical');
        }}
      >
        <span className="ui-menu__label">
          <span className="ui-menu__row-title">Split Right</span>
        </span>
        <span className="ui-menu__shortcut">Ctrl+D</span>
      </div>
      <div
        role="menuitem"
        className="ui-menu__row"
        onClick={() => {
          onCloseMenu();
          onSplit('horizontal');
        }}
      >
        <span className="ui-menu__label">
          <span className="ui-menu__row-title">Split Down</span>
        </span>
        <span className="ui-menu__shortcut">Ctrl+Shift+D</span>
      </div>

      {/* Reordering actions */}
      <div
        role="menuitem"
        aria-disabled={!canSwap || undefined}
        className="ui-menu__row"
        onClick={() => {
          if (!canSwap) return;
          onCloseMenu();
          onSwap(-1);
        }}
      >
        <span className="ui-menu__label">
          <span className="ui-menu__row-title">Swap with Previous Pane</span>
        </span>
        <span className="ui-menu__shortcut">Ctrl+Alt+[</span>
      </div>
      <div
        role="menuitem"
        aria-disabled={!canSwap || undefined}
        className="ui-menu__row"
        onClick={() => {
          if (!canSwap) return;
          onCloseMenu();
          onSwap(1);
        }}
      >
        <span className="ui-menu__label">
          <span className="ui-menu__row-title">Swap with Next Pane</span>
        </span>
        <span className="ui-menu__shortcut">Ctrl+Alt+]</span>
      </div>
      <div
        role="menuitem"
        aria-disabled={!canSwap || undefined}
        className="ui-menu__row"
        onClick={() => {
          if (!canSwap) return;
          onCloseMenu();
          onExtractToTab();
        }}
      >
        <span className="ui-menu__label">
          <span className="ui-menu__row-title">Move to New Tab</span>
        </span>
      </div>
      <div
        role="menuitem"
        aria-disabled={!canSwap || undefined}
        className="ui-menu__row"
        onClick={() => {
          if (!canSwap) return;
          onCloseMenu();
          onEqualize();
        }}
      >
        <span className="ui-menu__label">
          <span className="ui-menu__row-title">Equalize Panes</span>
        </span>
        <span className="ui-menu__shortcut">Ctrl+Alt+=</span>
      </div>

      {/* Terminal-specific actions */}
      {occupant.kind === 'terminal' && (
        <>
          <div className="ui-menu__rule" aria-hidden="true" />
          <div
            role="menuitem"
            className="ui-menu__row"
            onClick={() => {
              onCloseMenu();
              onTerminalCommand('font-larger');
            }}
          >
            <span className="ui-menu__label">
              <span className="ui-menu__row-title">Bigger Text</span>
            </span>
          </div>
          <div
            role="menuitem"
            className="ui-menu__row"
            onClick={() => {
              onCloseMenu();
              onTerminalCommand('font-smaller');
            }}
          >
            <span className="ui-menu__label">
              <span className="ui-menu__row-title">Smaller Text</span>
            </span>
          </div>
          <div
            role="menuitem"
            className="ui-menu__row"
            onClick={() => {
              onCloseMenu();
              onRename();
            }}
          >
            <span className="ui-menu__label">
              <span className="ui-menu__row-title">Rename Pane…</span>
            </span>
          </div>
          <div className="ui-menu__rule" aria-hidden="true" />
          <div
            role="menuitem"
            className="ui-menu__row"
            onClick={() => {
              onCloseMenu();
              onTerminalCommand('clear');
            }}
          >
            <span className="ui-menu__label">
              <span className="ui-menu__row-title">Clear Screen</span>
            </span>
          </div>
          <div
            role="menuitem"
            className="ui-menu__row"
            onClick={() => {
              onCloseMenu();
              onTerminalCommand('interrupt');
            }}
          >
            <span className="ui-menu__label">
              <span className="ui-menu__row-title">Interrupt</span>
            </span>
            <span className="ui-menu__shortcut">Ctrl+C</span>
          </div>
          <div
            role="menuitem"
            className="ui-menu__row"
            onClick={() => {
              onCloseMenu();
              onTerminalCommand('restart');
            }}
          >
            <span className="ui-menu__label">
              <span className="ui-menu__row-title">Restart</span>
            </span>
          </div>
          {(() => {
            const eng = occupant.kind === 'terminal' ? occupant.engine || occupant.runtime?.engine : undefined;
            return eng && eng !== 'terminal' && eng !== 'powershell' && onResumePrevious ? (
              <div
                role="menuitem"
                className="ui-menu__row"
                onClick={() => {
                  onCloseMenu();
                  onResumePrevious();
                }}
              >
                <span className="ui-menu__label">
                  <span className="ui-menu__row-title">
                    Resume Previous Conversation…
                  </span>
                </span>
              </div>
            ) : null;
          })()}
        </>
      )}

      {/* Destructive Close Pane */}
      <div className="ui-menu__rule" aria-hidden="true" />
      <div
        role="menuitem"
        className="ui-menu__row ui-menu__row--destructive"
        onClick={() => {
          onCloseMenu();
          onClose();
        }}
      >
        <span className="ui-menu__label">
          <span className="ui-menu__row-title">Close Pane</span>
        </span>
        <span className="ui-menu__shortcut">Ctrl+W</span>
      </div>
    </div>
  );

  return typeof document !== 'undefined' && anchorRect
    ? createPortal(menuElement, document.querySelector('.app-frame--scaled') ?? document.body)
    : menuElement;
};

export interface CodePaneNewMenuProps {
  workspaceName: string;
  availableEngines: AgentEngineDescriptor[];
  anchorRect?: DOMRect | null;
  onLaunchTerminal: () => void;
  onLaunchAgent: (engineId: string, engineName: string) => void;
  onSplitDown: () => void;
  onNewTab: () => void;
  onNewSession: () => void;
  onCloseMenu: () => void;
}

export const CodePaneNewMenu: React.FC<CodePaneNewMenuProps> = ({
  workspaceName,
  availableEngines,
  anchorRect,
  onLaunchTerminal,
  onLaunchAgent,
  onSplitDown,
  onNewTab,
  onNewSession,
  onCloseMenu,
}) => {
  const menuStyle: React.CSSProperties = anchorRect
    ? {
        position: 'fixed',
        top: `${Math.min(anchorRect.bottom + 4, window.innerHeight - 380)}px`,
        right: `${Math.max(8, window.innerWidth - anchorRect.right)}px`,
        zIndex: 99999,
      }
    : {};

  const menuElement = (
    <div
      className="ui-menu code-pane-menu"
      role="menu"
      style={menuStyle}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="ui-menu__header" role="presentation">
        <span className="ui-menu__title">New pane</span>
        <span className="ui-menu__subtitle">{workspaceName}</span>
      </div>
      <div className="ui-menu__rule" aria-hidden="true" />
      <div
        role="menuitem"
        className="ui-menu__row"
        onClick={() => {
          onCloseMenu();
          onLaunchTerminal();
        }}
      >
        <span className="ui-menu__icon" aria-hidden="true">
          <SquareTerminalIcon size={13} />
        </span>
        <span className="ui-menu__label">
          <span className="ui-menu__row-title">Terminal</span>
        </span>
        <span className="ui-menu__shortcut">Ctrl+D</span>
      </div>
      <div className="ui-menu__rule" aria-hidden="true" />
      {availableEngines.map((engine) => (
        <div
          key={engine.wireId}
          role="menuitem"
          className="ui-menu__row"
          onClick={() => {
            onCloseMenu();
            onLaunchAgent(engine.wireId, engine.displayName);
          }}
        >
          <span className="ui-menu__icon" aria-hidden="true">
            <BrandLogo engine={engine.wireId} size={13} />
          </span>
          <span className="ui-menu__label">
            <span className="ui-menu__row-title">{engine.displayName}</span>
          </span>
        </div>
      ))}
      <div className="ui-menu__rule" aria-hidden="true" />
      <div
        role="menuitem"
        className="ui-menu__row"
        onClick={() => {
          onCloseMenu();
          onSplitDown();
        }}
      >
        <span className="ui-menu__icon" aria-hidden="true">
          <SplitHorizontalIcon size={13} />
        </span>
        <span className="ui-menu__label">
          <span className="ui-menu__row-title">Split Down</span>
        </span>
        <span className="ui-menu__shortcut">Ctrl+Shift+D</span>
      </div>
      <div
        role="menuitem"
        className="ui-menu__row"
        onClick={() => {
          onCloseMenu();
          onNewTab();
        }}
      >
        <span className="ui-menu__icon" aria-hidden="true">
          <PlusIcon size={13} />
        </span>
        <span className="ui-menu__label">
          <span className="ui-menu__row-title">New Tab</span>
        </span>
        <span className="ui-menu__shortcut">Ctrl+T</span>
      </div>
      <div
        role="menuitem"
        className="ui-menu__row"
        onClick={() => {
          onCloseMenu();
          onNewSession();
        }}
      >
        <span className="ui-menu__icon" aria-hidden="true">
          <SquareTerminalIcon size={13} />
        </span>
        <span className="ui-menu__label">
          <span className="ui-menu__row-title">New Session…</span>
        </span>
      </div>
    </div>
  );

  return typeof document !== 'undefined' && anchorRect
    ? createPortal(menuElement, document.querySelector('.app-frame--scaled') ?? document.body)
    : menuElement;
};
