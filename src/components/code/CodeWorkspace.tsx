import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { Workspace, AgentProfile } from '../../types';
import { invokeCommand, copyWorkspacePath } from '../../lib/ipc';
import { TerminalView } from '../views/TerminalView';
import { NewSessionPane } from './NewSessionPane';
import { CodeHome } from './CodeHome';
import { WorkspaceEmptyLauncher } from './WorkspaceEmptyLauncher';
import { CODE_LAUNCH_ENGINES } from './engineCatalog';
import { CodePaneNewMenu } from './CodePaneMenu';
import { PaneNodeRenderer, type TerminalStatus } from './PaneNodeRenderer';
import { AgentPaneResumeModal } from '../modals/AgentPaneResumeModal';
import { FolderIcon, PlusIcon } from './codeIcons';
import { getAllLeaves } from './treeUtils';
import type {
  PaneNode,
  PaneLeaf,
  PaneOccupantTerminal,
  AgentEngineDescriptor,
} from './types';
import '../views/workspaces.css';
import { startAgentInboxPolling } from '../../lib/agentInboxLoop';
import { AGENT_CODENAMES, getNextAgentName, cleanAgentTitle } from '../../lib/agentNames';
import { collectActiveAgentNames } from './workspaceUtils';
import { useWorkspaceLayoutState } from './useWorkspaceLayoutState';
import { useWorkspaceEventListeners } from './useWorkspaceEventListeners';
import { WorkspaceNotices } from './WorkspaceNotices';

export { AGENT_CODENAMES, getNextAgentName, cleanAgentTitle, collectActiveAgentNames };

export interface CodeWorkspaceProps {
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onRefresh: () => Promise<void> | void;
  onAddWorkspace?: () => Promise<void> | void;
  agents?: AgentProfile[];
  selectedAgentId?: string | null;
  availability?: Record<string, boolean>;
  onSessionsChange?: (
    workspaceId: string,
    sessions: Array<{ id: string; title: string; paneCount: number; isActive: boolean }>
  ) => void;
  requestedTabId?: string | null;
  onTabRequestedHandled?: () => void;
  newSessionRequest?: number;
}

export const CodeWorkspace: React.FC<CodeWorkspaceProps> = ({
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  onRefresh,
  onAddWorkspace,
  agents = [],
  selectedAgentId = null,
  availability,
  onSessionsChange,
  requestedTabId = null,
  onTabRequestedHandled,
  newSessionRequest = 0,
}) => {
  const selectedWorkspace =
    workspaces.find((w) => w.id === selectedWorkspaceId) || workspaces[0] || null;

  const availableEngines: AgentEngineDescriptor[] = useMemo(() => {
    return CODE_LAUNCH_ENGINES.map((eng) => ({
      ...eng,
      isAvailable: availability ? availability[eng.wireId] ?? false : true,
    }));
  }, [availability]);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const headerNewBtnRef = useRef<HTMLButtonElement | null>(null);
  const workspaceCwdRef = useRef<string | null>(null);
  const terminalSlotsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const spotlightTimerRef = useRef<any>(null);

  const [composerOpen, setComposerOpen] = useState(false);
  const [renamingLeafId, setRenamingLeafId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState<string>('');
  const [paneMenuOpenLeafId, setPaneMenuOpenLeafId] = useState<string | null>(null);
  const [paneMenuKind, setPaneMenuKind] = useState<'actions' | 'new' | null>(null);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [isAddingWs, setIsAddingWs] = useState(false);
  const [spotlightLeafId, setSpotlightLeafId] = useState<string | null>(null);
  const [terminalStatus, setTerminalStatus] = useState<
    Record<string, 'idle' | 'working' | 'needsInput' | 'done' | 'failed'>
  >({});
  const [resumeModalPane, setResumeModalPane] = useState<{
    paneId: string;
    engine: string;
    title?: string;
  } | null>(null);

  const {
    layout,
    latestLayoutRef,
    activeTab,
    focusedLeafId,
    setFocusedLeafId,
    operationError,
    setOperationError,
    persistenceWarning,
    failedSaveAttempts,
    persistLayout,
    handleFocusLeaf,
    handleEqualize,
    handleSwap,
    handleExtractLeafToTab,
    handleRenameLeaf,
    handleCloseLeaf,
    handleCloseTab,
    handleToggleFullscreen,
    handleLaunchTerminal,
    handleLaunchAgent,
    handleLaunchMultiSeat,
    handleSplitLeaf,
    handleDividerPointerDown,
    handleApplyPaneSessionKey,
  } = useWorkspaceLayoutState({
    selectedWorkspace,
    canvasRef,
    containerRef,
    onSessionsChange,
    requestedTabId,
    onTabRequestedHandled,
  });

  useWorkspaceEventListeners({
    selectedWorkspace,
    latestLayoutRef,
    persistLayout,
    canvasRef,
    onSelectWorkspace,
    focusedLeafId,
    setFocusedLeafId,
    setSpotlightLeafId,
    spotlightTimerRef,
    paneMenuOpenLeafId,
    setPaneMenuOpenLeafId,
    setPaneMenuKind,
    headerMenuOpen,
    setHeaderMenuOpen,
    renamingLeafId,
    setRenamingLeafId,
    handleCloseLeaf,
    handleCloseTab,
    handleEqualize,
    handleSplitLeaf,
    handleToggleFullscreen,
    fullscreenLeafId: layout.fullscreenLeafId,
    handleLaunchTerminal,
    handleLaunchAgent,
  });

  const getOrCreateTerminalSlotHost = useCallback((leafId: string): HTMLDivElement => {
    let host = terminalSlotsRef.current.get(leafId);
    if (!host) {
      host = document.createElement('div');
      host.className = 'terminal-portal-slot-host';
      host.style.width = '100%';
      host.style.height = '100%';
      host.style.display = 'flex';
      host.style.flexDirection = 'column';
      host.style.flex = '1 1 auto';
      host.style.minWidth = '0';
      host.style.minHeight = '0';
      terminalSlotsRef.current.set(leafId, host);
    }
    return host;
  }, []);

  const handleRegisterTerminalSlot = useCallback(
    (leafId: string, bodyEl: HTMLDivElement | null) => {
      if (!bodyEl) return;
      const host = getOrCreateTerminalSlotHost(leafId);
      if (host.parentElement !== bodyEl) {
        bodyEl.appendChild(host);
      }
    },
    [getOrCreateTerminalSlotHost]
  );

  useEffect(() => {
    let cancelled = false;
    if (!selectedWorkspace?.id) {
      workspaceCwdRef.current = null;
      return;
    }
    void copyWorkspacePath(selectedWorkspace.id)
      .then((folderPath) => {
        if (!cancelled) workspaceCwdRef.current = folderPath;
      })
      .catch(() => {
        if (!cancelled) workspaceCwdRef.current = null;
      });
    return () => {
      cancelled = true;
    };
  }, [selectedWorkspace?.id]);

  useEffect(() => {
    return startAgentInboxPolling(() => workspaceCwdRef.current);
  }, [selectedWorkspace?.id]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as unknown as { __kiteCodeWorkspaceMounted?: boolean }).__kiteCodeWorkspaceMounted = true;
      window.dispatchEvent(new CustomEvent('kite:code-workspace-ready'));
    }
    return () => {
      if (typeof window !== 'undefined') {
        (window as unknown as { __kiteCodeWorkspaceMounted?: boolean }).__kiteCodeWorkspaceMounted = false;
      }
    };
  }, []);

  const allTerminalLeaves = useMemo(() => {
    const list: Array<{ leaf: PaneLeaf; tabId: string; isActiveTab: boolean }> = [];
    const resolvedActiveId =
      layout.tabs.find((t) => t.id === layout.activeTabId)?.id ||
      layout.tabs[0]?.id ||
      null;
    for (const tab of layout.tabs) {
      const leaves = getAllLeaves(tab.root);
      for (const leaf of leaves) {
        if (leaf.occupant.kind === 'terminal') {
          list.push({
            leaf,
            tabId: tab.id,
            isActiveTab: tab.id === resolvedActiveId,
          });
        }
      }
    }
    return list;
  }, [layout.tabs, layout.activeTabId]);

  useEffect(() => {
    const activeIds = new Set(allTerminalLeaves.map((item) => item.leaf.id));
    for (const [leafId, hostEl] of terminalSlotsRef.current.entries()) {
      if (!activeIds.has(leafId)) {
        hostEl.remove();
        terminalSlotsRef.current.delete(leafId);
      }
    }
  }, [allTerminalLeaves]);

  useEffect(() => {
    if (newSessionRequest > 0) setComposerOpen(true);
  }, [newSessionRequest]);

  // Close context menu on click outside
  useEffect(() => {
    if (!paneMenuOpenLeafId && !headerMenuOpen) return;
    const handleOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.code-pane-menu') || target?.closest('[data-pane-menu-trigger]')) {
        return;
      }
      setPaneMenuOpenLeafId(null);
      setPaneMenuKind(null);
      setHeaderMenuOpen(false);
    };
    const timer = window.setTimeout(() => {
      window.addEventListener('pointerdown', handleOutside);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', handleOutside);
    };
  }, [paneMenuOpenLeafId, headerMenuOpen]);

  const handleAddWorkspaceClick = async () => {
    if (onAddWorkspace) {
      await onAddWorkspace();
      return;
    }
    setIsAddingWs(true);
    try {
      const created = await invokeCommand<Workspace | null>('add_workspace', {
        supportedSchemaVersion: 1,
      });
      if (created && created.id) {
        onSelectWorkspace(created.id);
      }
      await onRefresh();
    } catch (err) {
      console.error('Failed to enroll workspace:', err);
    } finally {
      setIsAddingWs(false);
    }
  };

  if (!selectedWorkspace || workspaces.length === 0) {
    return <CodeHome onAddWorkspace={() => void handleAddWorkspaceClick()} isAdding={isAddingWs} />;
  }

  const renderEmptyLauncher = () => (
    <WorkspaceEmptyLauncher
      workspace={selectedWorkspace}
      availableEngines={availableEngines}
      onLaunchAgent={handleLaunchAgent}
      onLaunchTerminal={handleLaunchTerminal}
      onLaunchMore={() => setComposerOpen(true)}
    />
  );

  const renderPaneNode = (node: PaneNode): React.ReactNode => {
    return (
      <PaneNodeRenderer
        node={node}
        fullscreenLeafId={layout.fullscreenLeafId}
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
        onFocusLeaf={handleFocusLeaf}
        onOpenMenu={(leafId, kind) => {
          setPaneMenuOpenLeafId(leafId);
          setPaneMenuKind(kind);
        }}
        onCloseMenu={() => {
          setPaneMenuOpenLeafId(null);
          setPaneMenuKind(null);
        }}
        onToggleFullscreen={handleToggleFullscreen}
        onClosePane={handleCloseLeaf}
        onSplit={handleSplitLeaf}
        onSwap={handleSwap}
        onExtractToTab={handleExtractLeafToTab}
        onEqualize={handleEqualize}
        onStartRename={(leafId, current) => { setRenamingLeafId(leafId); setRenameValue(current); }}
        onChangeRename={setRenameValue}
        onCommitRename={(leafId, val) => { handleRenameLeaf(leafId, val); setRenamingLeafId(null); }}
        onCancelRename={() => setRenamingLeafId(null)}
        onLaunchTerminal={() => handleLaunchTerminal()}
        onLaunchAgent={handleLaunchAgent}
        onNewSession={() => setComposerOpen(true)}
        onDividerPointerDown={handleDividerPointerDown}
        onSetTerminalStatus={(sessionId, mapped) => {
          setTerminalStatus((prev) => (prev[sessionId] === mapped ? prev : { ...prev, [sessionId]: mapped }));
        }}
        onResumePrevious={(leafId, engine, title) => {
          setResumeModalPane({ paneId: leafId, engine, title });
        }}
        onRegisterTerminalSlot={handleRegisterTerminalSlot}
      />
    );
  };

  if (composerOpen) {
    return (
      <NewSessionPane
        workspaceId={selectedWorkspace.id}
        workspaceName={selectedWorkspace.displayName}
        engines={availableEngines}
        onCancel={() => setComposerOpen(false)}
        onLaunch={(engineId, count) => {
          const meta = availableEngines.find((engine) => engine.wireId === engineId);
          handleLaunchMultiSeat({
            title: meta?.displayName || 'Terminal',
            engines: Array.from({ length: count }, () => engineId),
            task: '',
          });
          setComposerOpen(false);
        }}
      />
    );
  }

  const renderNotices = () => (
    <WorkspaceNotices
      operationError={operationError}
      persistenceWarning={persistenceWarning}
      failedSaveAttempts={failedSaveAttempts}
      onDismissError={() => setOperationError(null)}
      onRetrySave={() => void persistLayout(latestLayoutRef.current)}
    />
  );

  if (!activeTab) {
    return (
      <section
        ref={containerRef}
        aria-label={`${selectedWorkspace.displayName} workspace`}
        className="pane code-empty"
      >
        <header className="pane-titlebar workspace-empty__header">
          <span className="workspace-pill" title={selectedWorkspace.displayName}>
            <FolderIcon size={11} />
            {selectedWorkspace.displayName}
          </span>
          <span className="pane-titlebar__spacer" />
          <div className="code-pane-actions">
            <button
              ref={headerNewBtnRef}
              className="chrome-button"
              aria-haspopup="menu"
              aria-label="New pane"
              data-pane-menu-trigger="newPane"
              title="New pane — terminal or an agent"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setHeaderMenuOpen((open) => !open);
              }}
            >
              <PlusIcon size={14} />
            </button>
            {headerMenuOpen && (
              <CodePaneNewMenu
                anchorRect={headerNewBtnRef.current?.getBoundingClientRect()}
                workspaceName={selectedWorkspace.displayName}
                availableEngines={availableEngines}
                onLaunchTerminal={() => { setHeaderMenuOpen(false); handleLaunchTerminal(); }}
                onLaunchAgent={(wireId, displayName) => { setHeaderMenuOpen(false); handleLaunchAgent(wireId, displayName); }}
                onSplitDown={() => { setHeaderMenuOpen(false); handleLaunchTerminal(); }}
                onNewTab={() => { setHeaderMenuOpen(false); handleLaunchTerminal(); }}
                onNewSession={() => { setHeaderMenuOpen(false); setComposerOpen(true); }}
                onCloseMenu={() => setHeaderMenuOpen(false)}
              />
            )}
          </div>
        </header>
        {renderEmptyLauncher()}
        {renderNotices()}
      </section>
    );
  }

  return (
    <section
      ref={canvasRef}
      aria-label={`${selectedWorkspace.displayName} pane canvas`}
      className="workspace-pane-canvas"
      data-fullscreen={layout.fullscreenLeafId !== null || undefined}
    >
      {layout.tabs.map((tab) => {
        const resolvedActiveId =
          layout.tabs.find((t) => t.id === layout.activeTabId)?.id ||
          layout.tabs[0]?.id ||
          null;
        const isActive = tab.id === resolvedActiveId;
        return (
          <div
            key={tab.id}
            className={`workspace-tab-layer${isActive ? ' workspace-tab-layer--active' : ''}`}
            aria-hidden={!isActive}
          >
            <div className="workspace-tab-layer__tree">{renderPaneNode(tab.root)}</div>
          </div>
        );
      })}
      {allTerminalLeaves.map(({ leaf: l }) => {
        const occ = l.occupant as PaneOccupantTerminal;
        const slotEl = getOrCreateTerminalSlotHost(l.id);
        const resolvedActiveId =
          layout.tabs.find((t) => t.id === layout.activeTabId)?.id ||
          layout.tabs[0]?.id ||
          null;
        const isTabActive = activeTab ? activeTab.id === resolvedActiveId : true;
        const isLeafFocused = isTabActive && focusedLeafId === l.id;
        return createPortal(
          <TerminalView
            key={occ.sessionId}
            chrome="pane"
            workspaceId={selectedWorkspace.id}
            paneId={l.id}
            sessionId={occ.sessionId}
            initialEngine={occ.engine || occ.runtime?.engine}
            title={occ.label}
            isFocused={isLeafFocused}
            onStatusChange={(status) => {
              const mapped: TerminalStatus =
                status === 'running' || status === 'connecting'
                  ? 'working'
                  : status === 'exited'
                  ? 'done'
                  : status === 'terminated'
                  ? 'failed'
                  : 'idle';
              setTerminalStatus((prev) => (prev[occ.sessionId] === mapped ? prev : { ...prev, [occ.sessionId]: mapped }));
            }}
          />,
          slotEl,
          occ.sessionId,
        );
      })}
      {renderNotices()}
      {resumeModalPane && (
        <AgentPaneResumeModal
          isOpen={true}
          workspaceId={selectedWorkspace.id}
          paneId={resumeModalPane.paneId}
          engine={resumeModalPane.engine}
          title={resumeModalPane.title}
          onClose={() => setResumeModalPane(null)}
          onResumeSelected={(key) => {
            handleApplyPaneSessionKey(resumeModalPane.paneId, key);
            setResumeModalPane(null);
          }}
          onStartFresh={() => {
            handleApplyPaneSessionKey(resumeModalPane.paneId, globalThis.crypto.randomUUID());
            setResumeModalPane(null);
          }}
        />
      )}
    </section>
  );
};

export default CodeWorkspace;
