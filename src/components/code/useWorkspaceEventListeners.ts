import { useEffect, useRef } from 'react';
import type { Workspace } from '../../types';
import type { WorkspaceTab, WorkspaceLayout, PaneLeaf, PaneAxis } from './types';
import { getAllLeaves, createLeaf, splitLeaf } from './treeUtils';
import {
  collectActiveAgentNames,
  estimateTargetPaneGrid,
} from './workspaceUtils';
import { cleanAgentTitle, getNextAgentName } from '../../lib/agentNames';
import { invokeCommand } from '../../lib/ipc';
import { registerSpawnedTerminal } from '../../lib/terminalRegistry';
import { waitForSpawnGeometry } from '../../lib/terminalHostSize';
import { sendUiAck, type UiBusRequestPayload } from '../../lib/operator/executor/ui-bus';
import { isTerminalTarget } from '../../lib/shortcuts/useGlobalShortcuts';

export interface UseWorkspaceEventListenersParams {
  selectedWorkspace: Workspace | null;
  latestLayoutRef: React.MutableRefObject<WorkspaceLayout>;
  persistLayout: (nextLayout: WorkspaceLayout) => Promise<void>;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  onSelectWorkspace: (id: string) => void;
  focusedLeafId: string | null;
  setFocusedLeafId: (id: string | null) => void;
  setSpotlightLeafId: (id: string | null) => void;
  spotlightTimerRef: React.MutableRefObject<any>;
  paneMenuOpenLeafId: string | null;
  setPaneMenuOpenLeafId: (id: string | null) => void;
  setPaneMenuKind: (kind: 'actions' | 'new' | null) => void;
  headerMenuOpen: boolean;
  setHeaderMenuOpen: (open: boolean) => void;
  renamingLeafId: string | null;
  setRenamingLeafId: (id: string | null) => void;
  handleCloseLeaf: (leafId: string) => void;
  handleCloseTab: (tabId: string) => void;
  handleEqualize: () => void;
  handleSplitLeaf: (leafId: string, axis: PaneAxis, engine?: { id: string; name: string }) => void;
  handleToggleFullscreen: (leafId: string) => void;
  fullscreenLeafId?: string | null;
  handleLaunchTerminal: () => void;
  handleLaunchAgent: (engineId: string, engineName: string) => void;
}

export function useWorkspaceEventListeners({
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
  fullscreenLeafId,
  handleLaunchTerminal,
  handleLaunchAgent,
}: UseWorkspaceEventListenersParams) {
  const spawnQueueRef = useRef<Promise<void>>(Promise.resolve());

  // Escape & layout keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        if (paneMenuOpenLeafId || headerMenuOpen) {
          e.preventDefault();
          setPaneMenuOpenLeafId(null);
          setPaneMenuKind(null);
          setHeaderMenuOpen(false);
          return;
        }
        if (renamingLeafId) {
          e.preventDefault();
          setRenamingLeafId(null);
          return;
        }
        const inTerminal = isTerminalTarget(e.target);
        if (latestLayoutRef.current.fullscreenLeafId !== null && !inTerminal) {
          e.preventDefault();
          void persistLayout({
            ...latestLayoutRef.current,
            fullscreenLeafId: null,
          });
        }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [paneMenuOpenLeafId, headerMenuOpen, renamingLeafId, latestLayoutRef, persistLayout, setPaneMenuOpenLeafId, setPaneMenuKind, setHeaderMenuOpen, setRenamingLeafId]);

  // Terminal lifecycle & IPC events
  useEffect(() => {
    const onTerminate = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string; leafId?: string; name?: string }>).detail;
      if (!detail?.sessionId && !detail?.leafId && !detail?.name) return;
      const targetName = detail.name?.trim().toLowerCase();
      const current = latestLayoutRef.current;
      for (const tab of current.tabs) {
        const leaf = getAllLeaves(tab.root).find((l) => {
          if (detail.sessionId && l.occupant.kind === 'terminal' && l.occupant.sessionId === detail.sessionId) {
            return true;
          }
          if (
            detail.leafId &&
            (l.id === detail.leafId || (l.occupant.kind === 'terminal' && l.occupant.sessionId === detail.leafId))
          ) {
            return true;
          }
          if (targetName && l.occupant.kind === 'terminal') {
            const occ = l.occupant;
            const matchesLabel =
              occ.label?.toLowerCase() === targetName || occ.label?.toLowerCase().includes(targetName);
            const matchesAgentName =
              occ.runtime?.agentName?.toLowerCase() === targetName ||
              occ.runtime?.agentName?.toLowerCase().includes(targetName);
            const matchesDisplayName =
              occ.runtime?.displayName?.toLowerCase() === targetName ||
              occ.runtime?.displayName?.toLowerCase().includes(targetName);
            return Boolean(matchesLabel || matchesAgentName || matchesDisplayName);
          }
          return false;
        });
        if (leaf) {
          handleCloseLeaf(leaf.id);
          break;
        }
      }
    };

    const onCloseTabEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ workspaceId?: string; tabId?: string }>).detail;
      if (!detail?.tabId || (detail.workspaceId && detail.workspaceId !== selectedWorkspace?.id)) return;
      handleCloseTab(detail.tabId);
    };

    const onRenameTabEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ workspaceId?: string; tabId?: string; newTitle?: string }>).detail;
      if (!detail?.tabId || !detail.newTitle || (detail.workspaceId && detail.workspaceId !== selectedWorkspace?.id)) return;
      const current = latestLayoutRef.current;
      const updated = current.tabs.map((t) => (t.id === detail.tabId ? { ...t, title: detail.newTitle!.trim() } : t));
      void persistLayout({ ...current, tabs: updated });
    };

    const onSpotlight = (e: Event) => {
      const detail = (e as CustomEvent<{ leafId?: string; sessionId?: string; workspaceId?: string }>).detail;
      if (!detail) return;
      if (detail.workspaceId && selectedWorkspace && detail.workspaceId !== selectedWorkspace.id) {
        onSelectWorkspace(detail.workspaceId);
      }

      const current = latestLayoutRef.current;
      let targetTab: WorkspaceTab | null = null;
      let targetLeaf: PaneLeaf | null = null;

      for (const tab of current.tabs) {
        const leaf = getAllLeaves(tab.root).find(
          (l) =>
            (detail.leafId && l.id === detail.leafId) ||
            (detail.sessionId && l.occupant.kind === 'terminal' && l.occupant.sessionId === detail.sessionId) ||
            (detail.leafId && l.occupant.kind === 'terminal' && l.occupant.sessionId === detail.leafId)
        );
        if (leaf) {
          targetTab = tab;
          targetLeaf = leaf;
          break;
        }
      }

      if (targetLeaf) {
        const leafId = targetLeaf.id;
        if (targetTab && current.activeTabId !== targetTab.id) {
          void persistLayout({
            ...current,
            activeTabId: targetTab.id,
          });
        }
        setFocusedLeafId(leafId);
        setSpotlightLeafId(leafId);
        if (spotlightTimerRef.current) {
          clearTimeout(spotlightTimerRef.current);
        }
        spotlightTimerRef.current = setTimeout(() => {
          setSpotlightLeafId(null);
        }, 2500);
      }
    };

    const spawnTerminalCore = async (detail: {
      sessionId: string;
      engine?: string;
      title?: string;
      agentName?: string;
      splitAxis?: 'vertical' | 'horizontal';
      initialPrompt?: string;
      attachOnly?: boolean;
      autoApprove?: boolean;
      workspaceId?: string;
      sourceSessionId?: string;
      sourcePaneId?: string;
      label?: string;
      projectileLabel?: string;
      requestId?: string;
    }) => {
      const paneId = globalThis.crypto.randomUUID();
      const wireEngine = detail.engine || 'powershell';
      const isShell = wireEngine === 'powershell' || wireEngine === 'terminal';

      let agentName = detail.agentName;
      if (!agentName && !isShell) {
        if (detail.title && !detail.title.startsWith('[ODD]') && !detail.title.startsWith('Agent ')) {
          agentName = cleanAgentTitle(detail.title);
        } else {
          const activeNames = collectActiveAgentNames(latestLayoutRef.current.tabs);
          agentName = getNextAgentName(activeNames);
        }
      }

      const finalTitle = detail.title || (agentName ? `${agentName} (${wireEngine})` : `Terminal (${wireEngine})`);
      const leafLabel = agentName || cleanAgentTitle(finalTitle);
      const attachOnly = detail.attachOnly === true;

      if (!attachOnly) {
        let dims = estimateTargetPaneGrid(canvasRef.current, 1, 'vertical');
        if (!isShell && dims.columns < 50) {
          await waitForSpawnGeometry(canvasRef.current, dims.columns);
          dims = estimateTargetPaneGrid(canvasRef.current, 1, 'vertical');
        }

        try {
          await invokeCommand('start_terminal', {
            sessionId: detail.sessionId,
            engine: wireEngine,
            workspaceId: selectedWorkspace?.id || null,
            paneId,
            columns: dims.columns,
            rows: dims.rows,
            confirmedByBuilder: true,
            agentName: agentName || undefined,
            displayName: leafLabel,
            initialPrompt: detail.initialPrompt,
            autoApprove: detail.autoApprove ?? true,
          });
        } catch (err) {
          console.warn('[ODD] Failed to start terminal:', err);
          throw err;
        }
      }

      void invokeCommand('dispatch_pane_shown', { sessionId: detail.sessionId }).catch(() => {});

      registerSpawnedTerminal(detail.sessionId, {
        workspaceId: selectedWorkspace?.id || null,
        workspaceName: selectedWorkspace?.displayName,
        engine: wireEngine,
        title: finalTitle,
        who: agentName || leafLabel,
      });

      const newLeaf = createLeaf({
        kind: 'terminal',
        sessionId: detail.sessionId,
        label: leafLabel,
        engine: wireEngine,
        runtime: {
          engine: wireEngine,
          displayName: leafLabel,
          workTitle: leafLabel,
          agentName: isShell ? undefined : (agentName || leafLabel),
          paneId,
        },
      });

      const current = latestLayoutRef.current;
      const currentTab = current.tabs.find((t) => t.id === current.activeTabId) || current.tabs[0];

      if (!currentTab) {
        const tabNum = current.tabs.length + 1;
        const newTab: WorkspaceTab = {
          id: globalThis.crypto.randomUUID(),
          title: `Ventana ${tabNum}`,
          root: newLeaf,
          focusedLeafId: newLeaf.id,
        };
        const nextLayout: WorkspaceLayout = {
          ...current,
          workspaceId: selectedWorkspace?.id || current.workspaceId,
          tabs: [newTab],
          activeTabId: newTab.id,
        };
        latestLayoutRef.current = nextLayout;
        setFocusedLeafId(newLeaf.id);
        await persistLayout(nextLayout);
        return;
      }

      const targetLeafId = currentTab.focusedLeafId || currentTab.root.id;
      const splitAxis: PaneAxis = detail.splitAxis || 'vertical';
      const updatedRoot = splitLeaf(currentTab.root, targetLeafId, newLeaf, splitAxis);

      const updatedTabs = current.tabs.map((t) =>
        t.id === currentTab.id ? { ...t, root: updatedRoot, focusedLeafId: newLeaf.id } : t
      );

      const nextLayout: WorkspaceLayout = {
        ...current,
        tabs: updatedTabs,
      };
      latestLayoutRef.current = nextLayout;
      setFocusedLeafId(newLeaf.id);
      await persistLayout(nextLayout);
    };

    const onSpawnAgentTerminal = (e: Event) => {
      const customEvent = e as CustomEvent<{
        sessionId: string;
        engine?: string;
        initialPrompt?: string;
        autoApprove?: boolean;
        title?: string;
        agentName?: string;
        splitAxis?: 'vertical' | 'horizontal';
        workspaceId?: string;
        taskSlug?: string;
        sourceSessionId?: string;
        sourcePaneId?: string;
        label?: string;
        projectileLabel?: string;
        requestId?: string;
        attachOnly?: boolean;
      }>;
      const detail = customEvent.detail;
      if (!detail) return;

      if (detail.workspaceId && selectedWorkspace && detail.workspaceId !== selectedWorkspace.id) {
        console.debug(
          '[ODD] Spawn for workspace',
          detail.workspaceId,
          'arrived while',
          selectedWorkspace.id,
          'is active; spawning in the active tree.'
        );
      }

      spawnQueueRef.current = spawnQueueRef.current
        .then(() => spawnTerminalCore(detail))
        .catch((err) => console.error('[ODD] Error spawning terminal in queue:', err));
    };

    const onOpRequest = (e: Event) => {
      const customEvent = e as CustomEvent<UiBusRequestPayload>;
      if (!customEvent.detail) return;
      if (customEvent.detail.kind === 'spawn-terminal') {
        const payload = customEvent.detail.payload as any;
        const reqId = customEvent.detail.reqId;
        const sessionId =
          payload.sessionId ||
          `agent-term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        spawnQueueRef.current = spawnQueueRef.current
          .then(async () => {
            await spawnTerminalCore({
              sessionId,
              engine: payload.engine,
              title: payload.title,
              agentName: payload.agentName,
              splitAxis: payload.splitAxis || 'vertical',
              initialPrompt: payload.initialPrompt,
              autoApprove: payload.autoApprove,
              workspaceId: payload.workspaceId,
            });
            sendUiAck({
              reqId,
              ok: true,
              sessionId,
              data: { agentName: payload.agentName },
            });
          })
          .catch((err) => {
            console.error('[CodeWorkspace] Error in spawn queue:', err);
            sendUiAck({
              reqId,
              ok: false,
              reason: err?.message || 'spawn-failed',
            });
          });
      }
    };

    window.addEventListener('kite:terminate-agent', onTerminate);
    window.addEventListener('kite:close-workspace-tab', onCloseTabEvent);
    window.addEventListener('kite:rename-workspace-tab', onRenameTabEvent);
    window.addEventListener('kite:spotlight-pane', onSpotlight);
    window.addEventListener('kite:spawn-agent-terminal', onSpawnAgentTerminal);
    window.addEventListener('kite:op-request', onOpRequest);
    return () => {
      window.removeEventListener('kite:terminate-agent', onTerminate);
      window.removeEventListener('kite:close-workspace-tab', onCloseTabEvent);
      window.removeEventListener('kite:rename-workspace-tab', onRenameTabEvent);
      window.removeEventListener('kite:spotlight-pane', onSpotlight);
      window.removeEventListener('kite:spawn-agent-terminal', onSpawnAgentTerminal);
      window.removeEventListener('kite:op-request', onOpRequest);
      if (spotlightTimerRef.current) {
        clearTimeout(spotlightTimerRef.current);
      }
    };
  }, [selectedWorkspace, persistLayout, onSelectWorkspace, latestLayoutRef, canvasRef, handleCloseLeaf, handleCloseTab, setFocusedLeafId, setSpotlightLeafId, spotlightTimerRef]);

  // Layout resize signals
  useEffect(() => {
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new CustomEvent('kite:layout-resized', { detail: { fullscreenLeafId } }));
    const raf = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new CustomEvent('kite:layout-resized', { detail: { fullscreenLeafId } }));
    });
    return () => window.cancelAnimationFrame(raf);
  }, [fullscreenLeafId]);

  // S8 — operator-driven pane layout: equalize, split, focus and zoom the pane grid.
  useEffect(() => {
    const resolveLeafId = (tab: WorkspaceTab, target?: string | number): string => {
      const leaves = getAllLeaves(tab.root);
      const fallback = tab.focusedLeafId || tab.root.id;

      if (typeof target === 'number') {
        return leaves[Math.floor(target) - 1]?.id || fallback;
      }

      if (typeof target === 'string' && target.trim()) {
        const norm = target.trim().toLowerCase();
        if (/^\d+$/.test(norm)) {
          const byIndex = leaves[parseInt(norm, 10) - 1];
          if (byIndex) return byIndex.id;
        }
        const byId = leaves.find((leaf) => leaf.id === target || leaf.id.toLowerCase() === norm);
        if (byId) return byId.id;
        const byOccupant = leaves.find((leaf) => {
          if (leaf.occupant.kind !== 'terminal') return false;
          const occ = leaf.occupant;
          return (
            occ.sessionId.toLowerCase() === norm ||
            Boolean(occ.label?.toLowerCase().includes(norm)) ||
            Boolean(occ.runtime?.agentName?.toLowerCase().includes(norm)) ||
            Boolean(occ.runtime?.displayName?.toLowerCase().includes(norm))
          );
        });
        if (byOccupant) return byOccupant.id;
      }

      return fallback;
    };

    const handleOperatorPaneLayout = (e: Event) => {
      const detail = (
        e as CustomEvent<{ operation?: string; target?: string | number; workspaceId?: string }>
      ).detail;
      if (!detail?.operation) return;

      const current = latestLayoutRef.current;
      const tab = current.tabs.find((t) => t.id === current.activeTabId) || current.tabs[0];
      if (!tab) return;

      if (detail.operation === 'equalize') {
        handleEqualize();
        return;
      }

      const leafId = resolveLeafId(tab, detail.target);

      if (detail.operation === 'split-horizontal' || detail.operation === 'split-vertical') {
        handleSplitLeaf(leafId, detail.operation === 'split-horizontal' ? 'horizontal' : 'vertical');
        return;
      }

      if (detail.operation === 'focus') {
        setFocusedLeafId(leafId);
        setSpotlightLeafId(leafId);
        if (spotlightTimerRef.current) {
          clearTimeout(spotlightTimerRef.current);
        }
        spotlightTimerRef.current = setTimeout(() => {
          setSpotlightLeafId(null);
        }, 2500);
        return;
      }

      if (detail.operation === 'zoom') {
        handleToggleFullscreen(leafId);
      }
    };

    const handleShortcutPaneAction = (e: Event) => {
      const detail = (
        e as CustomEvent<{ action: string; axis?: 'vertical' | 'horizontal' }>
      ).detail;
      if (!detail?.action) return;

      const current = latestLayoutRef.current;
      const tab = current.tabs.find((t) => t.id === current.activeTabId) || current.tabs[0];
      if (!tab) return;

      if (detail.action === 'new-terminal') {
        handleLaunchTerminal();
      } else if (detail.action === 'launch-agent') {
        const payload = detail as { action: string; engineId?: string; engineName?: string };
        if (payload.engineId) {
          handleLaunchAgent(payload.engineId, payload.engineName || payload.engineId);
        }
      } else if (detail.action === 'split-pane') {
        const leafId = focusedLeafId || resolveLeafId(tab);
        handleSplitLeaf(leafId, detail.axis || 'vertical');
      } else if (detail.action === 'close-pane') {
        const leafId = focusedLeafId || resolveLeafId(tab);
        handleCloseLeaf(leafId);
      }
    };

    window.addEventListener('kite:operator-pane-layout', handleOperatorPaneLayout);
    window.addEventListener('kite:shortcut-pane-action', handleShortcutPaneAction);
    return () => {
      window.removeEventListener('kite:operator-pane-layout', handleOperatorPaneLayout);
      window.removeEventListener('kite:shortcut-pane-action', handleShortcutPaneAction);
    };
  });
}
