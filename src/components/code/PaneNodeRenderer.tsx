import React from 'react';
import type { Workspace, AgentProfile } from '../../types';
import { TerminalView } from '../views/TerminalView';
import { ChatView } from '../views/ChatView';
import { CodePaneHeader } from './CodePaneHeader';
import { getAllLeaves, findLeaf } from './treeUtils';
import type {
  PaneNode,
  WorkspaceTab,
  AgentEngineDescriptor,
  PaneAxis,
} from './types';

export type TerminalStatus = 'idle' | 'working' | 'needsInput' | 'done' | 'failed';

export interface PaneNodeRendererProps {
  node: PaneNode;
  fullscreenLeafId: string | null;
  focusedLeafId: string | null;
  spotlightLeafId?: string | null;
  paneMenuOpenLeafId: string | null;
  paneMenuKind: 'actions' | 'new' | null;
  renamingLeafId: string | null;
  renameValue: string;
  terminalStatus: Record<string, TerminalStatus>;
  availableEngines: AgentEngineDescriptor[];
  selectedWorkspace: Workspace;
  activeTab: WorkspaceTab | null;
  agents?: AgentProfile[];
  selectedAgentId?: string | null;
  onFocusLeaf: (id: string) => void;
  onOpenMenu: (leafId: string, kind: 'actions' | 'new') => void;
  onCloseMenu: () => void;
  onToggleFullscreen: (id: string) => void;
  onClosePane: (id: string) => void;
  onSplit: (id: string, axis: PaneAxis, engine?: { id: string; name: string }) => void;
  onSwap: (id: string, offset: -1 | 1) => void;
  onExtractToTab: (id: string) => void;
  onEqualize: () => void;
  onStartRename: (id: string, current: string) => void;
  onChangeRename: (val: string) => void;
  onCommitRename: (id: string, val: string) => void;
  onCancelRename: () => void;
  onLaunchTerminal: () => void;
  onLaunchAgent: (wireId: string, displayName: string) => void;
  onNewSession: () => void;
  onDividerPointerDown: (e: React.PointerEvent, splitId: string, dividerIndex: number, axis: PaneAxis) => void;
  onSetTerminalStatus: (sessionId: string, status: TerminalStatus) => void;
  onResumePrevious?: (leafId: string, engine: string, title?: string) => void;
}

export const PaneNodeRenderer: React.FC<PaneNodeRendererProps> = ({
  node,
  fullscreenLeafId,
  focusedLeafId,
  spotlightLeafId = null,
  paneMenuOpenLeafId,
  paneMenuKind,
  renamingLeafId,
  renameValue,
  terminalStatus,
  availableEngines,
  selectedWorkspace,
  activeTab,
  agents = [],
  selectedAgentId = null,
  onFocusLeaf,
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
  onLaunchTerminal,
  onLaunchAgent,
  onNewSession,
  onDividerPointerDown,
  onSetTerminalStatus,
  onResumePrevious,
}) => {
  if (fullscreenLeafId) {
    if (node.type === 'leaf') {
      if (node.id !== fullscreenLeafId) return null;
    } else if (node.type === 'split') {
      const fsLeaf = findLeaf(node, fullscreenLeafId);
      if (fsLeaf) {
        return (
          <PaneNodeRenderer
            node={fsLeaf}
            fullscreenLeafId={fullscreenLeafId}
            focusedLeafId={focusedLeafId}
            spotlightLeafId={spotlightLeafId}
            paneMenuOpenLeafId={paneMenuOpenLeafId}
            paneMenuKind={paneMenuKind}
            renamingLeafId={renamingLeafId}
            renameValue={renameValue}
            terminalStatus={terminalStatus}
            availableEngines={availableEngines}
            selectedWorkspace={selectedWorkspace}
            activeTab={activeTab}
            agents={agents}
            selectedAgentId={selectedAgentId}
            onFocusLeaf={onFocusLeaf}
            onOpenMenu={onOpenMenu}
            onCloseMenu={onCloseMenu}
            onToggleFullscreen={onToggleFullscreen}
            onClosePane={onClosePane}
            onSplit={onSplit}
            onSwap={onSwap}
            onExtractToTab={onExtractToTab}
            onEqualize={onEqualize}
            onStartRename={onStartRename}
            onChangeRename={onChangeRename}
            onCommitRename={onCommitRename}
            onCancelRename={onCancelRename}
            onLaunchTerminal={onLaunchTerminal}
            onLaunchAgent={onLaunchAgent}
            onNewSession={onNewSession}
            onDividerPointerDown={onDividerPointerDown}
            onSetTerminalStatus={onSetTerminalStatus}
            onResumePrevious={onResumePrevious}
          />
        );
      }
      return null;
    }
  }

  if (node.type === 'leaf') {
    const isFocused = focusedLeafId === node.id;
    const isFullscreen = fullscreenLeafId === node.id;
    const occupant = node.occupant;
    const isSpotlighted =
      spotlightLeafId === node.id ||
      (occupant.kind === 'terminal' && occupant.sessionId === spotlightLeafId);
    const isMenuOpen = paneMenuOpenLeafId === node.id;
    const ownTitle =
      occupant.kind === 'terminal'
        ? occupant.runtime?.workTitle || occupant.runtime?.displayName || 'Terminal'
        : occupant.title || 'Thread';
    const displayName =
      occupant.kind === 'terminal'
        ? occupant.label || ownTitle
        : occupant.title || 'Thread';
    const canSwap = activeTab ? getAllLeaves(activeTab.root).length > 1 : false;
    const sessionStatus =
      occupant.kind === 'terminal' ? terminalStatus[occupant.sessionId] || 'idle' : 'idle';

    return (
      <section
        key={node.id}
        aria-label={`${displayName} pane`}
        className={`code-pane-panel${isFocused ? ' code-pane-panel--focused' : ''}${isSpotlighted ? ' code-pane-panel--beacon-a' : ''}${occupant.kind === 'terminal' ? ' motion-terminal-in' : ''}`}
        onClick={() => onFocusLeaf(node.id)}
        data-leaf-id={node.id}
        data-occupant-kind={occupant.kind}
        data-testid={occupant.kind === 'terminal' ? 'terminal-pane' : undefined}
        style={{ position: 'relative' }}
      >
        {isSpotlighted && <div className="code-pane-beacon" aria-hidden="true" />}
        <CodePaneHeader
          nodeId={node.id}
          occupant={occupant}
          displayName={displayName}
          workspaceName={selectedWorkspace.displayName}
          canSwap={canSwap}
          isFullscreen={isFullscreen}
          isMenuOpen={isMenuOpen}
          paneMenuKind={paneMenuKind}
          renamingLeafId={renamingLeafId}
          renameValue={renameValue}
          terminalStatus={sessionStatus}
          availableEngines={availableEngines}
          onOpenMenu={(kind) => onOpenMenu(node.id, kind)}
          onCloseMenu={onCloseMenu}
          onToggleFullscreen={() => onToggleFullscreen(node.id)}
          onClosePane={() => onClosePane(node.id)}
          onSplit={(axis, engine) => onSplit(node.id, axis, engine)}
          onSwap={(offset) => onSwap(node.id, offset)}
          onExtractToTab={() => onExtractToTab(node.id)}
          onEqualize={onEqualize}
          onStartRename={() => {
            onStartRename(node.id, occupant.kind === 'terminal' ? occupant.label || '' : occupant.title || '');
          }}
          onChangeRename={onChangeRename}
          onCommitRename={(val) => onCommitRename(node.id, val)}
          onCancelRename={onCancelRename}
          onLaunchTerminal={onLaunchTerminal}
          onLaunchAgent={onLaunchAgent}
          onNewTab={onLaunchTerminal}
          onNewSession={onNewSession}
          onPointerDownHeader={() => onFocusLeaf(node.id)}
          onTerminalCommand={(cmd) => {
            if (occupant.kind === 'terminal') {
              window.dispatchEvent(
                new CustomEvent('kite:terminal-command', {
                  detail: { sessionId: occupant.sessionId, command: cmd },
                })
              );
            }
          }}
          onResumePrevious={
            occupant.kind === 'terminal' &&
            (occupant.engine || occupant.runtime?.engine) &&
            onResumePrevious
              ? () => {
                  const eng = occupant.engine || occupant.runtime?.engine || '';
                  onResumePrevious(node.id, eng, occupant.label || eng);
                }
              : undefined
          }
        />

        <div
          className="code-pane-body"
          data-terminal-slot={occupant.kind === 'terminal' ? occupant.sessionId : undefined}
        >
          {occupant.kind === 'terminal' ? (
            <TerminalView
              key={occupant.sessionId}
              chrome="pane"
              workspaceId={selectedWorkspace.id}
              paneId={node.id}
              sessionId={occupant.sessionId}
              initialEngine={occupant.engine || occupant.runtime?.engine}
              title={occupant.label}
              onStatusChange={(status) => {
                const mapped: TerminalStatus =
                  status === 'running' || status === 'connecting'
                    ? 'working'
                    : status === 'exited'
                    ? 'done'
                    : status === 'terminated'
                    ? 'failed'
                    : 'idle';
                onSetTerminalStatus(occupant.sessionId, mapped);
              }}
            />
          ) : (
            <ChatView
              workspaceId={selectedWorkspace.id}
              threadId={occupant.threadId}
              embedded={true}
            />
          )}
        </div>
      </section>
    );
  }

  const isVertical = node.axis === 'vertical';
  const gutter = 'var(--layout-code-gutter, 8px)';
  const gridTemplate = node.ratios
    .map((ratio, index) => {
      const share = `${Math.max(ratio, 0.05)}fr`;
      return index < node.ratios.length - 1 ? `${share} ${gutter}` : share;
    })
    .join(' ');

  return (
    <div
      key={node.id}
      className={`pane-tree pane-tree--${node.axis}`}
      style={{
        display: 'grid',
        gridTemplateColumns: isVertical ? gridTemplate : '1fr',
        gridTemplateRows: isVertical ? '1fr' : gridTemplate,
        overflow: 'hidden',
      }}
    >
      {node.children.map((child, idx) => (
        <React.Fragment key={child.id}>
          <div className="pane-tree__child">
            <PaneNodeRenderer
              node={child}
              fullscreenLeafId={fullscreenLeafId}
              focusedLeafId={focusedLeafId}
              spotlightLeafId={spotlightLeafId}
              paneMenuOpenLeafId={paneMenuOpenLeafId}
              paneMenuKind={paneMenuKind}
              renamingLeafId={renamingLeafId}
              renameValue={renameValue}
              terminalStatus={terminalStatus}
              availableEngines={availableEngines}
              selectedWorkspace={selectedWorkspace}
              activeTab={activeTab}
              agents={agents}
              selectedAgentId={selectedAgentId}
              onFocusLeaf={onFocusLeaf}
              onOpenMenu={onOpenMenu}
              onCloseMenu={onCloseMenu}
              onToggleFullscreen={onToggleFullscreen}
              onClosePane={onClosePane}
              onSplit={onSplit}
              onSwap={onSwap}
              onExtractToTab={onExtractToTab}
              onEqualize={onEqualize}
              onStartRename={onStartRename}
              onChangeRename={onChangeRename}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
              onLaunchTerminal={onLaunchTerminal}
              onLaunchAgent={onLaunchAgent}
              onNewSession={onNewSession}
              onDividerPointerDown={onDividerPointerDown}
              onSetTerminalStatus={onSetTerminalStatus}
              onResumePrevious={onResumePrevious}
            />
          </div>
          {idx < node.children.length - 1 && (
            <div
              className={`pane-divider pane-divider--${node.axis}`}
              onPointerDown={(e) => onDividerPointerDown(e, node.id, idx, node.axis)}
              role="separator"
              aria-orientation={isVertical ? 'vertical' : 'horizontal'}
            />
          )}
        </React.Fragment>
      ))}
    </div>
  );
};
