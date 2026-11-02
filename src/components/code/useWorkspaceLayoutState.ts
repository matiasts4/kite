import { useState, useEffect, useCallback, useRef } from 'react';
import type { Workspace } from '../../types';
import { invokeCommand } from '../../lib/ipc';
import { releaseTerminal } from '../views/TerminalView';
import { setTerminalDividerDragging } from '../../lib/terminalViewport';
import { pulseZedOrb } from '../../motion/contract';
import { getNextAgentName } from '../../lib/agentNames';
import {
  createLeaf,
  createSplit,
  splitLeaf,
  removeLeaf,
  updateSplitRatios,
  equalizeSplits,
  swapAdjacent,
  swapLeaves,
  moveLeafToEdge,
  type PaneDropEdge,
  findLeaf,
  getAllLeaves,
  copySplitRatiosIfSameChildren,
} from './treeUtils';
import type { WorkspaceSessionTab, WorkspaceSessionPaneInfo } from '../sidebar/types';
import type {
  PaneNode,
  PaneLeaf,
  WorkspaceTab,
  WorkspaceLayout,
  PaneAxis,
} from './types';
import {
  listTerminals,
  findPane,
  collectActiveAgentNames,
  sanitizeWorkspaceLayout,
  estimateTargetPaneGrid,
  requestWorkspaceTerminals,
  takeSeatName,
  releasePaneTerminals,
} from './workspaceUtils';

export interface UseWorkspaceLayoutStateParams {
  selectedWorkspace: Workspace | null;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onSessionsChange?: (
    workspaceId: string,
    sessions: WorkspaceSessionTab[]
  ) => void;
  requestedTabId?: string | null;
  onTabRequestedHandled?: () => void;
}

export function useWorkspaceLayoutState({
  selectedWorkspace,
  canvasRef,
  containerRef,
  onSessionsChange,
  requestedTabId,
  onTabRequestedHandled,
}: UseWorkspaceLayoutStateParams) {
  const [layout, setLayout] = useState<WorkspaceLayout>({
    schemaVersion: 2,
    workspaceId: selectedWorkspace?.id || '',
    tabs: [],
    activeTabId: null,
    fullscreenLeafId: null,
  });

  const [focusedLeafId, setFocusedLeafId] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [persistenceWarning, setPersistenceWarning] = useState<string | null>(null);
  const [failedSaveAttempts, setFailedSaveAttempts] = useState(0);

  const latestLayoutRef = useRef<WorkspaceLayout>(layout);

  const activeTab = layout.tabs.find((t) => t.id === layout.activeTabId) || layout.tabs[0] || null;

  const activeLayoutTab = useCallback(() => {
    const current = latestLayoutRef.current;
    return current.tabs.find((tab) => tab.id === current.activeTabId) || current.tabs[0] || null;
  }, []);

  const loadLayout = useCallback(async (wsId: string) => {
    try {
      const res = await invokeCommand<{ layout?: WorkspaceLayout }>('load_workspace_layout', {
        workspaceId: wsId,
      });
      if (res && res.layout && Array.isArray(res.layout.tabs)) {
        const sanitized = sanitizeWorkspaceLayout(res.layout);
        latestLayoutRef.current = sanitized;
        setLayout(sanitized);
        if (sanitized.tabs.length > 0) {
          const active = sanitized.activeTabId || sanitized.tabs[0].id;
          setFocusedLeafId(sanitized.tabs.find((t) => t.id === active)?.focusedLeafId || null);
        }
      } else {
        const empty: WorkspaceLayout = {
          schemaVersion: 2,
          workspaceId: wsId,
          tabs: [],
          activeTabId: null,
          fullscreenLeafId: null,
        };
        latestLayoutRef.current = empty;
        setLayout(empty);
      }
    } catch {
      const empty: WorkspaceLayout = {
        schemaVersion: 2,
        workspaceId: wsId,
        tabs: [],
        activeTabId: null,
        fullscreenLeafId: null,
      };
      latestLayoutRef.current = empty;
      setLayout(empty);
    }
  }, []);

  useEffect(() => {
    if (selectedWorkspace?.id) {
      void loadLayout(selectedWorkspace.id);
    }
  }, [selectedWorkspace?.id, loadLayout]);

  const persistLayout = useCallback(
    async (nextLayout: WorkspaceLayout) => {
      const revision = (latestLayoutRef.current.revision ?? 0) + 1;
      const stamped: WorkspaceLayout = { ...nextLayout, revision };
      latestLayoutRef.current = stamped;
      setLayout(stamped);
      if (!selectedWorkspace?.id) return;
      try {
        await invokeCommand('save_workspace_layout', {
          workspaceId: selectedWorkspace.id,
          layout: stamped,
        });
        setPersistenceWarning(null);
        setFailedSaveAttempts(0);
      } catch (err) {
        console.warn('Failed to persist workspace layout:', err);
        setPersistenceWarning('Pane layout could not be saved.');
        setFailedSaveAttempts((prev: number) => prev + 1);
      }
    },
    [selectedWorkspace?.id]
  );

  const countLeaves = (node: PaneNode): number => {
    if (node.type === 'leaf') return 1;
    return node.children.reduce((total, child) => total + countLeaves(child), 0);
  };

  useEffect(() => {
    if (!selectedWorkspace?.id || !onSessionsChange) return;
    if (layout.workspaceId && layout.workspaceId !== selectedWorkspace.id) return;
    const resolvedActiveId =
      layout.tabs.find((t) => t.id === layout.activeTabId)?.id ||
      layout.tabs[0]?.id ||
      null;
    onSessionsChange(
      selectedWorkspace.id,
      layout.tabs.map((tab) => {
        const leaves = getAllLeaves(tab.root);
        const panes: WorkspaceSessionPaneInfo[] = leaves.map((leaf) => {
          if (leaf.occupant.kind === 'terminal') {
            const occ = leaf.occupant;
            const wireEngine = occ.engine || occ.runtime?.engine || 'terminal';
            const label = occ.runtime?.agentName || occ.label || occ.runtime?.displayName || 'Terminal';
            return {
              id: leaf.id,
              kind: 'terminal',
              label,
              engine: wireEngine,
              agentName: occ.runtime?.agentName,
              isFocused: tab.focusedLeafId === leaf.id,
            };
          }
          return {
            id: leaf.id,
            kind: 'thread',
            label: leaf.occupant.title || 'Chat',
            isFocused: tab.focusedLeafId === leaf.id,
          };
        });
        return {
          id: tab.id,
          title: tab.title,
          paneCount: leaves.length,
          isActive: tab.id === resolvedActiveId,
          panes,
        };
      })
    );
  }, [layout, selectedWorkspace?.id, onSessionsChange]);

  useEffect(() => {
    if (!requestedTabId || !selectedWorkspace?.id) return;
    const current = latestLayoutRef.current;
    if (current.workspaceId !== selectedWorkspace.id) return;
    const tab = current.tabs.find((item) => item.id === requestedTabId);
    if (!tab) {
      onTabRequestedHandled?.();
      return;
    }
    if (current.activeTabId === requestedTabId) {
      onTabRequestedHandled?.();
      return;
    }
    setFocusedLeafId(tab.focusedLeafId);
    void persistLayout({ ...current, activeTabId: requestedTabId });
    onTabRequestedHandled?.();
  }, [requestedTabId, selectedWorkspace?.id, layout, persistLayout, onTabRequestedHandled]);

  const handleFocusLeaf = useCallback(
    (leafId: string) => {
      if (focusedLeafId === leafId && activeTab?.focusedLeafId === leafId) return;
      setFocusedLeafId(leafId);
      const current = latestLayoutRef.current;
      const tab =
        current.tabs.find((item) => item.id === current.activeTabId) || current.tabs[0];
      if (tab && tab.focusedLeafId !== leafId) {
        const updatedTabs = current.tabs.map((item) =>
          item.id === tab.id ? { ...item, focusedLeafId: leafId } : item
        );
        void persistLayout({
          ...current,
          tabs: updatedTabs,
        });
      }
    },
    [activeTab, focusedLeafId, persistLayout]
  );

  const updateActiveRoot = useCallback((nextRoot: PaneNode, tabId: string) => {
    const current = latestLayoutRef.current;
    void persistLayout({
      ...current,
      tabs: current.tabs.map((tab) => (tab.id === tabId ? { ...tab, root: nextRoot } : tab)),
    });
  }, [persistLayout]);

  const handleCloseTab = useCallback((tabId: string) => {
    const current = latestLayoutRef.current;
    const closing = current.tabs.find((t) => t.id === tabId);
    const hadTerminal = closing ? listTerminals(closing.root).length > 0 : false;
    releasePaneTerminals(closing?.root);
    if (hadTerminal) pulseZedOrb();
    const remainingTabs = current.tabs.filter((t) => t.id !== tabId);
    const nextActiveId =
      current.activeTabId === tabId ? remainingTabs[0]?.id || null : current.activeTabId;

    void persistLayout({
      ...current,
      tabs: remainingTabs,
      activeTabId: nextActiveId,
      fullscreenLeafId: null,
    });
  }, [persistLayout]);

  const handleCloseLeaf = useCallback((targetLeafId: string) => {
    if (!selectedWorkspace) return;
    const current = latestLayoutRef.current;
    const targetTab = current.tabs.find((t) => findLeaf(t.root, targetLeafId) !== null) || activeLayoutTab();
    if (!targetTab) return;

    const pane = findPane(targetTab.root, targetLeafId);
    const hadTerminal = pane ? listTerminals(pane).length > 0 : false;
    releasePaneTerminals(pane);
    const updatedRoot = removeLeaf(targetTab.root, targetLeafId);

    if (!updatedRoot) {
      handleCloseTab(targetTab.id);
      return;
    }
    if (hadTerminal) pulseZedOrb();

    const updatedTabs = current.tabs.map((t) =>
      t.id === targetTab.id ? { ...t, root: updatedRoot } : t
    );

    void persistLayout({
      ...current,
      tabs: updatedTabs,
      fullscreenLeafId: current.fullscreenLeafId === targetLeafId ? null : current.fullscreenLeafId,
    });
  }, [selectedWorkspace, activeLayoutTab, handleCloseTab, persistLayout]);

  const handleEqualize = useCallback(() => {
    const tab = activeLayoutTab();
    if (!tab) return;
    updateActiveRoot(equalizeSplits(tab.root), tab.id);
  }, [activeLayoutTab, updateActiveRoot]);

  const handleSwap = useCallback((leafId: string, direction: -1 | 1) => {
    const tab = activeLayoutTab();
    if (!tab) return;
    updateActiveRoot(swapAdjacent(tab.root, leafId, direction), tab.id);
  }, [activeLayoutTab, updateActiveRoot]);

  const handleSwapLeaves = useCallback((sourceLeafId: string, targetLeafId: string) => {
    const tab = activeLayoutTab();
    if (!tab) return;
    const nextRoot = swapLeaves(tab.root, sourceLeafId, targetLeafId);
    if (nextRoot !== tab.root) {
      updateActiveRoot(nextRoot, tab.id);
      setFocusedLeafId(sourceLeafId);
    }
  }, [activeLayoutTab, updateActiveRoot]);

  const handleMoveLeaf = useCallback((
    sourceLeafId: string,
    targetLeafId: string,
    edge: PaneDropEdge
  ) => {
    const tab = activeLayoutTab();
    if (!tab) return;
    const nextRoot = moveLeafToEdge(tab.root, sourceLeafId, targetLeafId, edge);
    if (nextRoot !== tab.root) {
      updateActiveRoot(nextRoot, tab.id);
      setFocusedLeafId(sourceLeafId);
    }
  }, [activeLayoutTab, updateActiveRoot]);

  const handleExtractLeafToTab = useCallback((leafId: string) => {
    const current = latestLayoutRef.current;
    const activeTab = current.tabs.find((tab) => tab.id === current.activeTabId) || current.tabs[0];
    if (!activeTab) return;
    const leaf = findLeaf(activeTab.root, leafId);
    if (!leaf) return;
    const updatedRoot = removeLeaf(activeTab.root, leafId);
    if (!updatedRoot) return;

    const remainingLeaves = getAllLeaves(updatedRoot);
    const nextFocusedInCurrent =
      activeTab.focusedLeafId === leafId
        ? remainingLeaves[0]?.id || activeTab.focusedLeafId
        : activeTab.focusedLeafId;

    const title =
      leaf.occupant.kind === 'terminal'
        ? leaf.occupant.label ||
          leaf.occupant.runtime?.workTitle ||
          leaf.occupant.runtime?.displayName ||
          'Terminal'
        : leaf.occupant.title || 'Thread';

    const newTab: WorkspaceTab = {
      id: globalThis.crypto.randomUUID(),
      title,
      root: leaf,
      focusedLeafId: leaf.id,
    };

    const updatedTabs = current.tabs.map((t) =>
      t.id === activeTab.id
        ? { ...t, root: updatedRoot, focusedLeafId: nextFocusedInCurrent }
        : t
    );

    setFocusedLeafId(leaf.id);
    void persistLayout({
      ...current,
      tabs: [...updatedTabs, newTab],
      activeTabId: newTab.id,
      fullscreenLeafId: null,
    });
  }, [persistLayout]);

  const handleRenameLeaf = useCallback((leafId: string, name: string) => {
    const tab = activeLayoutTab();
    if (!tab) return;
    const nextName = name.trim();
    const walk = (node: PaneNode): PaneNode => {
      if (node.type === 'split') return { ...node, children: node.children.map(walk) };
      if (node.id !== leafId || node.occupant.kind !== 'terminal') return node;
      return {
        ...node,
        occupant: {
          ...node.occupant,
          label: nextName.length > 0 ? nextName : undefined,
        },
      };
    };
    updateActiveRoot(walk(tab.root), tab.id);
  }, [activeLayoutTab, updateActiveRoot]);

  const handleToggleFullscreen = useCallback((leafId: string) => {
    const current = latestLayoutRef.current;
    const nextFs = current.fullscreenLeafId === leafId ? null : leafId;
    void persistLayout({
      ...current,
      fullscreenLeafId: nextFs,
    });
  }, [persistLayout]);

  const handleLaunchTerminal = useCallback(() => {
    const workspace = selectedWorkspace;
    if (!workspace) return;
    void (async () => {
      const dims = estimateTargetPaneGrid(canvasRef.current, 1, 'vertical');
      const slots = await requestWorkspaceTerminals(workspace.id, [{ engine: 'powershell', label: 'Terminal' }], '', dims);
      if (latestLayoutRef.current.workspaceId !== workspace.id) return;
      const slot = slots?.[0];
      const newLeaf = createLeaf(
        {
          kind: 'terminal',
          sessionId: slot?.sessionId || globalThis.crypto.randomUUID(),
          label: 'Terminal',
          engine: 'powershell',
          runtime: {
            engine: 'powershell',
            displayName: slot?.displayName || 'Terminal',
            workTitle: slot?.workTitle ?? 'PowerShell',
            paneId: slot?.paneId,
          },
        },
        slot?.paneId,
      );

      const current = latestLayoutRef.current;
      const newTab: WorkspaceTab = {
        id: globalThis.crypto.randomUUID(),
        title: 'Terminal',
        root: newLeaf,
        focusedLeafId: newLeaf.id,
      };

      const nextLayout: WorkspaceLayout = {
        ...current,
        workspaceId: workspace.id,
        tabs: [...current.tabs, newTab],
        activeTabId: newTab.id,
      };

      setFocusedLeafId(newLeaf.id);
      void persistLayout(nextLayout);
    })();
  }, [selectedWorkspace, canvasRef, persistLayout]);

  const handleLaunchAgent = useCallback((engineId: string, _engineName: string) => {
    const workspace = selectedWorkspace;
    if (!workspace) return;
    void (async () => {
      const dims = estimateTargetPaneGrid(canvasRef.current, 1, 'vertical');
      const activeNames = collectActiveAgentNames(latestLayoutRef.current.tabs);
      const chosenName = getNextAgentName(activeNames);
      const slots = await requestWorkspaceTerminals(workspace.id, [{ engine: engineId, agentName: chosenName }], '', dims);
      if (latestLayoutRef.current.workspaceId !== workspace.id) return;
      const slot = slots?.[0];
      const agentCodename = slot?.agentName || chosenName;
      const newLeaf = createLeaf(
        {
          kind: 'terminal',
          sessionId: slot?.sessionId || globalThis.crypto.randomUUID(),
          label: agentCodename,
          engine: engineId,
          runtime: {
            engine: engineId,
            displayName: agentCodename,
            workTitle: agentCodename,
            agentName: agentCodename,
            paneId: slot?.paneId,
          },
        },
        slot?.paneId,
      );

      const current = latestLayoutRef.current;
      const newTab: WorkspaceTab = {
        id: globalThis.crypto.randomUUID(),
        title: agentCodename,
        root: newLeaf,
        focusedLeafId: newLeaf.id,
      };

      const nextLayout: WorkspaceLayout = {
        ...current,
        workspaceId: workspace.id,
        tabs: [...current.tabs, newTab],
        activeTabId: newTab.id,
      };

      setFocusedLeafId(newLeaf.id);
      void persistLayout(nextLayout);
    })();
  }, [selectedWorkspace, canvasRef, persistLayout]);

  const handleLaunchMultiSeat = useCallback(({
    title,
    engines,
    task,
  }: {
    title: string;
    engines: string[];
    task: string;
  }) => {
    const workspace = selectedWorkspace;
    if (!workspace || engines.length === 0) return;
    void (async () => {
      const activeNames = collectActiveAgentNames(latestLayoutRef.current.tabs);
      const takenTerminal = new Set<string>();
      const planned = engines.map((eng) => {
        const isTerm = eng === 'terminal' || eng === 'powershell';
        if (isTerm) {
          const name = takeSeatName(takenTerminal, 'Terminal');
          return { eng, name, isTerm, agentName: undefined };
        } else {
          const agentName = getNextAgentName(activeNames);
          return { eng, name: agentName, isTerm, agentName };
        }
      });
      const dims = estimateTargetPaneGrid(canvasRef.current, planned.length, 'vertical');
      const slots = await requestWorkspaceTerminals(
        workspace.id,
        planned.map((seat) => ({
          engine: seat.isTerm ? 'terminal' : seat.eng,
          ...(seat.isTerm ? { label: seat.name } : { agentName: seat.agentName }),
        })),
        task,
        dims,
      );
      if (latestLayoutRef.current.workspaceId !== workspace.id) return;
      const existingSessionIds = new Set(
        latestLayoutRef.current.tabs.flatMap((t) =>
          listTerminals(t.root).map((term) => term.sessionId)
        )
      );
      if (slots && slots.some((s) => existingSessionIds.has(s.sessionId))) {
        setOperationError('One or more sessions are already open in another tab.');
        return;
      }
      const leaves: PaneLeaf[] = planned.map((seat, index) => {
        const slot = slots?.[index];
        const agentCodename = slot?.agentName || seat.agentName;
        const label = agentCodename || seat.name;
        const wireEng = seat.isTerm ? 'powershell' : seat.eng;
        return createLeaf(
          {
            kind: 'terminal',
            sessionId: slot?.sessionId || globalThis.crypto.randomUUID(),
            label,
            engine: wireEng,
            runtime: {
              engine: wireEng,
              displayName: label,
              workTitle: label,
              agentName: agentCodename,
              paneId: slot?.paneId,
            },
          },
          slot?.paneId,
        );
      });

      let rootNode: PaneNode;
      if (leaves.length === 1) {
        rootNode = leaves[0];
      } else if (leaves.length === 2) {
        rootNode = createSplit('vertical', leaves, [0.5, 0.5]);
      } else if (leaves.length === 3) {
        rootNode = createSplit('vertical', leaves, [0.333, 0.333, 0.334]);
      } else {
        const mid = Math.ceil(leaves.length / 2);
        const col1 = leaves.slice(0, mid);
        const col2 = leaves.slice(mid);
        const leftSplit = col1.length === 1 ? col1[0] : createSplit('horizontal', col1);
        const rightSplit = col2.length === 1 ? col2[0] : createSplit('horizontal', col2);
        rootNode = createSplit('vertical', [leftSplit, rightSplit], [0.5, 0.5]);
      }

      const newTab: WorkspaceTab = {
        id: globalThis.crypto.randomUUID(),
        title: title || 'Multi-seat Session',
        root: rootNode,
        focusedLeafId: leaves[0].id,
      };

      const current = latestLayoutRef.current;
      const nextLayout: WorkspaceLayout = {
        ...current,
        workspaceId: workspace.id,
        tabs: [...current.tabs, newTab],
        activeTabId: newTab.id,
      };

      setFocusedLeafId(leaves[0].id);
      void persistLayout(nextLayout);
    })();
  }, [selectedWorkspace, canvasRef, persistLayout]);

  const handleSplitLeaf = useCallback((
    targetLeafId: string,
    axis: PaneAxis,
    engine?: { id: string; name: string }
  ) => {
    const workspace = selectedWorkspace;
    const tab = activeLayoutTab();
    if (!tab || !workspace) return;
    const isShell = !engine || engine.id === 'terminal' || engine.id === 'powershell';
    const wireEngine = isShell ? 'powershell' : engine.id;
    void (async () => {
      const activeNames = collectActiveAgentNames(latestLayoutRef.current.tabs);
      const takenTerminal = new Set(listTerminals(tab.root).map((terminal) => terminal.label || ''));
      let agentName: string | undefined;
      let label: string;
      if (isShell) {
        label = takeSeatName(takenTerminal, 'Terminal');
      } else {
        agentName = getNextAgentName(activeNames);
        label = agentName;
      }
      const seats = isShell
        ? [{ engine: wireEngine, label }]
        : [{ engine: wireEngine, agentName }];
      const dims = estimateTargetPaneGrid(canvasRef.current, 2, axis);
      const slots = await requestWorkspaceTerminals(workspace.id, seats, '', dims);
      const current = latestLayoutRef.current;
      const currentTab = current.tabs.find((item) => item.id === tab.id);
      if (!currentTab || current.workspaceId !== workspace.id) return;
      const slot = slots?.[0];
      const finalName = slot?.agentName || agentName || label;
      const newLeaf = createLeaf(
        {
          kind: 'terminal',
          sessionId: slot?.sessionId || globalThis.crypto.randomUUID(),
          label: finalName,
          engine: wireEngine,
          runtime: {
            engine: wireEngine,
            displayName: finalName,
            workTitle: finalName,
            agentName: isShell ? undefined : finalName,
            paneId: slot?.paneId,
          },
        },
        slot?.paneId,
      );

      const updatedRoot = splitLeaf(currentTab.root, targetLeafId, newLeaf, axis);
      const updatedTabs = current.tabs.map((t) =>
        t.id === tab.id ? { ...t, root: updatedRoot, focusedLeafId: newLeaf.id } : t
      );

      setFocusedLeafId(newLeaf.id);
      void persistLayout({
        ...current,
        tabs: updatedTabs,
      });
    })();
  }, [selectedWorkspace, activeLayoutTab, canvasRef, persistLayout]);

  const handleDividerPointerDown = useCallback((
    e: React.PointerEvent,
    splitId: string,
    dividerIndex: number,
    axis: PaneAxis
  ) => {
    e.preventDefault();
    setTerminalDividerDragging(true);
    const isVertical = axis === 'vertical';
    const startPos = isVertical ? e.clientX : e.clientY;
    const parentElem = (e.currentTarget.parentElement as HTMLElement) || containerRef.current;
    const totalSize = isVertical ? parentElem.clientWidth : parentElem.clientHeight;

    const tabId = activeTab?.id;
    const baselineTab = latestLayoutRef.current.tabs.find((tab) => tab.id === tabId);
    const baselineRoot = baselineTab?.root;
    if (!tabId || !baselineRoot) return;

    let rafId: number | null = null;
    let pendingDeltaRatio: number | null = null;

    const commitRatio = () => {
      rafId = null;
      if (pendingDeltaRatio === null) return;
      const resizedRoot = updateSplitRatios(baselineRoot, splitId, dividerIndex, pendingDeltaRatio);
      const current = latestLayoutRef.current;
      const currentTab = current.tabs.find((tab) => tab.id === tabId);
      if (!currentTab) return;
      const nextRoot = copySplitRatiosIfSameChildren(currentTab.root, resizedRoot);
      const nextLayout: WorkspaceLayout = {
        ...current,
        tabs: current.tabs.map((tab) => (tab.id === tabId ? { ...tab, root: nextRoot } : tab)),
      };
      latestLayoutRef.current = nextLayout;
      setLayout(nextLayout);
    };

    const handlePointerMove = (ev: PointerEvent) => {
      const currentPos = isVertical ? ev.clientX : ev.clientY;
      const deltaPixels = currentPos - startPos;
      pendingDeltaRatio = deltaPixels / (totalSize || 1);
      if (rafId === null) {
        rafId = window.requestAnimationFrame(commitRatio);
      }
    };

    const handlePointerUp = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        commitRatio();
      }
      setTerminalDividerDragging(false);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      if (selectedWorkspace?.id) {
        void persistLayout(latestLayoutRef.current);
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  }, [activeTab?.id, containerRef, selectedWorkspace?.id, persistLayout]);

  const handleApplyPaneSessionKey = useCallback(
    (targetPaneId: string, nextSessionId: string) => {
      const current = latestLayoutRef.current;
      let foundOldSession: string | null = null;
      const nextTabs = current.tabs.map((tab) => {
        const updateLeafSession = (n: PaneNode): PaneNode => {
          if (n.type === 'leaf') {
            if (n.id === targetPaneId && n.occupant.kind === 'terminal') {
              foundOldSession = n.occupant.sessionId;
              return {
                ...n,
                occupant: {
                  ...n.occupant,
                  sessionId: nextSessionId,
                },
              };
            }
            return n;
          }
          return {
            ...n,
            children: n.children.map(updateLeafSession),
          };
        };
        return {
          ...tab,
          root: updateLeafSession(tab.root),
        };
      });
      if (foundOldSession) {
        releaseTerminal(foundOldSession);
      }
      const updated: WorkspaceLayout = {
        ...current,
        tabs: nextTabs,
      };
      void persistLayout(updated);
    },
    [persistLayout]
  );

  return {
    layout,
    setLayout,
    latestLayoutRef,
    activeTab,
    activeLayoutTab,
    focusedLeafId,
    setFocusedLeafId,
    operationError,
    setOperationError,
    persistenceWarning,
    failedSaveAttempts,
    persistLayout,
    loadLayout,
    handleFocusLeaf,
    handleEqualize,
    handleSwap,
    handleSwapLeaves,
    handleMoveLeaf,
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
  };
}
