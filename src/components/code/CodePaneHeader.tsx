import React, { useRef } from 'react';
import type { AgentEngineDescriptor, PaneOccupant } from './types';
import {
  SquareTerminalIcon,
  MoreHorizontalIcon,
  MaximizeIcon,
  MinimizeIcon,
  PlusIcon,
  CloseIcon,
} from './codeIcons';
import { BrandLogo } from '../views/agents/engineMetadata';
import { CodePaneActionsMenu, CodePaneNewMenu } from './CodePaneMenu';

export interface CodePaneHeaderProps {
  nodeId: string;
  occupant: PaneOccupant;
  displayName: string;
  workspaceName: string;
  canSwap: boolean;
  isFullscreen: boolean;
  isMenuOpen: boolean;
  paneMenuKind: 'actions' | 'new' | null;
  renamingLeafId: string | null;
  renameValue: string;
  terminalStatus?: 'idle' | 'working' | 'needsInput' | 'done' | 'failed';
  availableEngines: AgentEngineDescriptor[];
  onOpenMenu: (kind: 'actions' | 'new') => void;
  onCloseMenu: () => void;
  onToggleFullscreen: () => void;
  onClosePane: () => void;
  onSplit: (axis: 'vertical' | 'horizontal', engine?: { id: string; name: string }) => void;
  onSwap: (offset: -1 | 1) => void;
  onExtractToTab: () => void;
  onEqualize: () => void;
  onStartRename: () => void;
  onChangeRename: (val: string) => void;
  onCommitRename: (val: string) => void;
  onCancelRename: () => void;
  onLaunchTerminal: () => void;
  onLaunchAgent: (engineId: string, engineName: string) => void;
  onNewTab: () => void;
  onNewSession: () => void;
  onPointerDownHeader: (e: React.PointerEvent) => void;
  onTerminalCommand: (cmd: 'font-larger' | 'font-smaller' | 'clear' | 'interrupt' | 'restart') => void;
  onResumePrevious?: () => void;
}

export const CodePaneHeader: React.FC<CodePaneHeaderProps> = ({
  nodeId,
  occupant,
  displayName,
  workspaceName,
  canSwap,
  isFullscreen,
  isMenuOpen,
  paneMenuKind,
  renamingLeafId,
  renameValue,
  terminalStatus = 'idle',
  availableEngines,
  onOpenMenu,
  onCloseMenu,
  onToggleFullscreen,
  onClosePane,
  onSplit,
  onSwap,
  onExtractToTab,
  onEqualize,
  onStartRename,
  onChangeRename,
  onCommitRename,
  onCancelRename,
  onLaunchTerminal: _onLaunchTerminal,
  onLaunchAgent: _onLaunchAgent,
  onNewTab,
  onNewSession,
  onPointerDownHeader,
  onTerminalCommand,
  onResumePrevious,
}) => {
  const isRenaming = renamingLeafId === nodeId;
  const actionsBtnRef = useRef<HTMLButtonElement | null>(null);
  const newBtnRef = useRef<HTMLButtonElement | null>(null);

  return (
    <header
      className="code-pane-header"
      data-draggable="true"
      onPointerDown={onPointerDownHeader}
    >
      {isRenaming ? (
        <form
          className="code-pane-rename"
          onSubmit={(e) => {
            e.preventDefault();
            onCommitRename(renameValue);
          }}
        >
          <input
            autoFocus
            type="text"
            value={renameValue}
            onChange={(e) => onChangeRename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                onCancelRename();
              }
            }}
            onBlur={() => onCommitRename(renameValue)}
            maxLength={64}
            aria-label="Pane name"
          />
        </form>
      ) : (
        <>
          <span className="code-pane-identity" title={displayName.replace(/\s*\([^)]*\)\s*$/, '').trim() || displayName}>
            <span
              className="code-pane-identity__dot"
              data-status={terminalStatus}
              aria-hidden="true"
            />
            {occupant.kind === 'terminal' && occupant.runtime?.engine ? (
              <BrandLogo engine={occupant.runtime.engine} size={13} />
            ) : (
              <SquareTerminalIcon size={13} />
            )}
            {(() => {
              const agentName = occupant.kind === 'terminal' ? occupant.runtime?.agentName : undefined;
              if (agentName) {
                let suffix = displayName;
                if (suffix.toLowerCase().startsWith(agentName.toLowerCase())) {
                  suffix = suffix.slice(agentName.length).trim();
                }
                const isEngineSuffix = /^\s*\([^)]*\)\s*$/.test(suffix);
                const displaySuffix = isEngineSuffix ? '' : suffix;
                return (
                  <>
                    <span aria-hidden="true" className="code-pane-identity__name">
                      {agentName}
                    </span>
                    {displaySuffix ? (
                      <span aria-hidden="true" className="code-pane-identity__label">
                        {displaySuffix}
                      </span>
                    ) : null}
                  </>
                );
              }
              const cleanTitle = displayName.replace(/\s*\([^)]*\)\s*$/, '').trim() || displayName;
              return (
                <span aria-hidden="true" className="code-pane-identity__label">
                  {cleanTitle}
                </span>
              );
            })()}
            <span className="sr-only">{displayName.replace(/\s*\([^)]*\)\s*$/, '').trim() || displayName}</span>
          </span>
          <span className="code-pane-meta" />
        </>
      )}

      <div className="code-pane-actions">
        {/* Pane actions menu trigger */}
        <button
          ref={actionsBtnRef}
          type="button"
          aria-haspopup="menu"
          aria-label={`${displayName} pane actions`}
          data-pane-menu-trigger="actions"
          title="Pane actions"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (isMenuOpen && paneMenuKind === 'actions') onCloseMenu();
            else onOpenMenu('actions');
          }}
        >
          <MoreHorizontalIcon size={14} />
        </button>

        {/* Fullscreen toggle */}
        {(canSwap || isFullscreen) && (
          <button
            type="button"
            aria-label={isFullscreen ? `Exit ${displayName} fullscreen` : `Fullscreen ${displayName} pane`}
            className={isFullscreen ? 'code-pane-action--selected' : undefined}
            title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFullscreen();
            }}
          >
            {isFullscreen ? (
              <MinimizeIcon size={11} className="code-pane-action__mirrored" />
            ) : (
              <MaximizeIcon size={11} className="code-pane-action__mirrored" />
            )}
          </button>
        )}

        {/* New pane split trigger */}
        <button
          ref={newBtnRef}
          type="button"
          aria-haspopup="menu"
          aria-label={`New pane beside ${displayName}`}
          data-pane-menu-trigger="newPane"
          title="New pane — terminal or an agent"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (isMenuOpen && paneMenuKind === 'new') onCloseMenu();
            else onOpenMenu('new');
          }}
        >
          <PlusIcon size={12} />
        </button>

        {/* Close pane */}
        <button
          type="button"
          className="code-pane-action--close"
          aria-label={`Close ${displayName} pane`}
          title="Close pane (Ctrl+W outside the terminal)"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClosePane();
          }}
        >
          <CloseIcon size={11} />
        </button>

        {/* Popups */}
        {isMenuOpen && paneMenuKind === 'actions' && (
          <CodePaneActionsMenu
            anchorRect={actionsBtnRef.current?.getBoundingClientRect()}
            displayName={displayName}
            workspaceName={workspaceName}
            occupant={occupant}
            canSwap={canSwap}
            onSplit={(axis) => onSplit(axis)}
            onSwap={onSwap}
            onExtractToTab={onExtractToTab}
            onEqualize={onEqualize}
            onRename={onStartRename}
            onClose={onClosePane}
            onTerminalCommand={onTerminalCommand}
            onResumePrevious={onResumePrevious}
            onCloseMenu={onCloseMenu}
          />
        )}

        {isMenuOpen && paneMenuKind === 'new' && (
          <CodePaneNewMenu
            anchorRect={newBtnRef.current?.getBoundingClientRect()}
            workspaceName={workspaceName}
            availableEngines={availableEngines}
            onLaunchTerminal={() => onSplit('vertical')}
            onLaunchAgent={(engineId, engineName) =>
              onSplit('vertical', { id: engineId, name: engineName })
            }
            onSplitDown={() => onSplit('horizontal')}
            onNewTab={onNewTab}
            onNewSession={onNewSession}
            onCloseMenu={onCloseMenu}
          />
        )}
      </div>
    </header>
  );
};
