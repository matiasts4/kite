import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { Workspace, AgentProfile } from '../../types';
import { invokeCommand } from '../../lib/ipc';
import { releaseTerminal } from '../views/TerminalView';
import { NewSessionPane } from './NewSessionPane';
import { CodeHome } from './CodeHome';
import { WorkspaceEmptyLauncher } from './WorkspaceEmptyLauncher';
import { CODE_LAUNCH_ENGINES } from './engineCatalog';
import { CodePaneNewMenu } from './CodePaneMenu';
import { PaneNodeRenderer } from './PaneNodeRenderer';
import { AgentPaneResumeModal } from '../modals/AgentPaneResumeModal';
import {
  FolderIcon,
  PlusIcon,
  CloseIcon,
} from './codeIcons';
import {
  createLeaf,
  createSplit,
  splitLeaf,
  removeLeaf,
  updateSplitRatios,
  equalizeSplits,
  swapAdjacent,
  findLeaf,
  getAllLeaves,
} from './treeUtils';
import type {
  PaneNode,
  PaneLeaf,
  PaneOccupant,
  PaneOccupantTerminal,
  WorkspaceTab,
  WorkspaceLayout,
  AgentEngineDescriptor,
  PaneAxis,
} from './types';
import '../views/workspaces.css';
import { registerSpawnedTerminal } from '../../lib/terminalRegistry';
import { sendUiAck, type UiBusRequestPayload } from '../../lib/operator/executor/ui-bus';
import { dispatchPromptWhenPaneReady, pulseZedOrb } from '../../motion/contract';
import { startAgentInboxPolling } from '../../lib/agentInboxLoop';
import { copyWorkspacePath } from '../../lib/ipc';

function listTerminals(node: PaneNode): PaneOccupantTerminal[] {
  if (node.type === 'leaf') {
    return node.occupant.kind === 'terminal' ? [node.occupant] : [];
  }
  return node.children.flatMap(listTerminals);
}

function findPane(node: PaneNode, id: string): PaneNode | null {
  if (node.id === id) return node;
  if (node.type === 'split') {
    for (const child of node.children) {
      const found = findPane(child, id);
      if (found) return found;
    }
  }
  return null;
}

interface LaunchedTerminalSlot {
  index: number;
  sessionId: string;
  paneId: string;
  engine: string;
  displayName: string;
  agentName?: string | null;
  roleLabel: string | null;
  workTitle: string | null;
}

import { AGENT_CODENAMES, getNextAgentName, cleanAgentTitle } from '../../lib/agentNames';
export { AGENT_CODENAMES, getNextAgentName, cleanAgentTitle };

export function collectActiveAgentNames(tabs: WorkspaceTab[]): Set<string> {
  const names = new Set<string>();
  for (const tab of tabs) {
    for (const term of listTerminals(tab.root)) {
      if (term.runtime?.agentName) {
        names.add(term.runtime.agentName.trim().toLowerCase());
      }
      if (term.label) {
        const clean = term.label.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
        if (clean) names.add(clean);
      }
      if (term.runtime?.displayName) {
        const clean = term.runtime.displayName.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
        if (clean) names.add(clean);
      }
    }
  }
  return names;
}

function sanitizeWorkspaceLayout(layout: WorkspaceLayout): WorkspaceLayout {
  const sanitizeOccupant = (occ: PaneOccupant): PaneOccupant => {
    if (occ.kind === 'terminal') {
      const cleanLabel = occ.label ? cleanAgentTitle(occ.label) : occ.label;
      const cleanDisplay = occ.runtime?.displayName
        ? cleanAgentTitle(occ.runtime.displayName)
        : occ.runtime?.displayName;
      const cleanWorkTitle = occ.runtime?.workTitle
        ? cleanAgentTitle(occ.runtime.workTitle)
        : occ.runtime?.workTitle;
      return {
        ...occ,
        label: cleanLabel,
        runtime: occ.runtime
          ? {
              ...occ.runtime,
              displayName: cleanDisplay || occ.runtime.displayName,
              workTitle: cleanWorkTitle || occ.runtime.workTitle,
            }
          : undefined,
      };
    }
    return occ;
  };
  const sanitizeNode = (node: PaneNode): PaneNode => {
    if (node.type === 'leaf') {
      return { ...node, occupant: sanitizeOccupant(node.occupant) };
    }
    return { ...node, children: node.children.map(sanitizeNode) };
  };
  return {
    ...layout,
    tabs: (layout.tabs || []).map((tab) => ({
      ...tab,
      title: cleanAgentTitle(tab.title),
      root: sanitizeNode(tab.root),
    })),
  };
}

function seatEngine(engine: string): string {
  return engine === 'powershell' || engine === 'terminal' ? 'terminal' : engine;
}

async function requestWorkspaceTerminals(
  workspaceId: string,
  seats: Array<{ engine: string; label?: string; agentName?: string }>,
  task = '',
): Promise<LaunchedTerminalSlot[] | null> {
  void invokeCommand('list_terminal_profiles').catch(() => undefined);
  try {
    const launched = await invokeCommand<{ slots?: LaunchedTerminalSlot[] }>('launch_workspace_terminals', {
      workspaceId,
      requestId: globalThis.crypto.randomUUID(),
      seats: seats.map((seat) => ({
        engine: seatEngine(seat.engine),
        ...(seat.label?.trim() ? { label: seat.label.trim().slice(0, 32) } : {}),
        ...(seat.agentName?.trim() ? { agentName: seat.agentName.trim().slice(0, 32) } : {}),
      })),
      task,
      columns: 80,
      rows: 24,
      confirmedByBuilder: true,
    });
    return launched?.slots?.length ? launched.slots : null;
  } catch {
    return null;
  }
}

function takeSeatName(taken: Set<string>, base: string): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let n = 2;
  while (taken.has(`${base} ${n}`)) n += 1;
  const name = `${base} ${n}`;
  taken.add(name);
  return name;
}

function releasePaneTerminals(node: PaneNode | null | undefined) {
  if (!node) return;
  for (const terminal of listTerminals(node)) {
    releaseTerminal(terminal.sessionId);
  }
}

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

  // Core Layout State
  const [layout, setLayout] = useState<WorkspaceLayout>({
    schemaVersion: 2,
    workspaceId: selectedWorkspace?.id || '',
    tabs: [],
    activeTabId: null,
    fullscreenLeafId: null,
  });

  const [composerOpen, setComposerOpen] = useState(false);
  const [focusedLeafId, setFocusedLeafId] = useState<string | null>(null);
  const [renamingLeafId, setRenamingLeafId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState<string>('');
  const [paneMenuOpenLeafId, setPaneMenuOpenLeafId] = useState<string | null>(null);
  const [paneMenuKind, setPaneMenuKind] = useState<'actions' | 'new' | null>(null);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [persistenceWarning, setPersistenceWarning] = useState<string | null>(null);
  const [failedSaveAttempts, setFailedSaveAttempts] = useState(0);
  const [terminalStatus, setTerminalStatus] = useState<
    Record<string, 'idle' | 'working' | 'needsInput' | 'done' | 'failed'>
  >({});
  const [isAddingWs, setIsAddingWs] = useState(false);
  const [spotlightLeafId, setSpotlightLeafId] = useState<string | null>(null);
  const spotlightTimerRef = useRef<any>(null);
  const [resumeModalPane, setResumeModalPane] = useState<{
    paneId: string;
    engine: string;
    title?: string;
  } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const latestLayoutRef = useRef<WorkspaceLayout>(layout);
  const spawnQueueRef = useRef<Promise<void>>(Promise.resolve());
  const canvasRef = useRef<HTMLDivElement>(null);
  const headerNewBtnRef = useRef<HTMLButtonElement | null>(null);
  const workspaceCwdRef = useRef<string | null>(null);

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

  const activeTab = layout.tabs.find((t) => t.id === layout.activeTabId) || layout.tabs[0] || null;

  // Load layout from Tauri when selected workspace changes
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

  useEffect(() => {
    if (newSessionRequest > 0) setComposerOpen(true);
  }, [newSessionRequest]);

  // Persist layout helper
  const persistLayout = useCallback(
    async (nextLayout: WorkspaceLayout) => {
      latestLayoutRef.current = nextLayout;
      setLayout(nextLayout);
      if (!selectedWorkspace?.id) return;
      try {
        await invokeCommand('save_workspace_layout', {
          workspaceId: selectedWorkspace.id,
          layout: nextLayout,
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
      layout.tabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        paneCount: countLeaves(tab.root),
        isActive: tab.id === resolvedActiveId,
      }))
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
      if (activeTab && activeTab.focusedLeafId !== leafId) {
        const updatedTabs = layout.tabs.map((t) =>
          t.id === activeTab.id ? { ...t, focusedLeafId: leafId } : t
        );
        void persistLayout({
          ...layout,
          tabs: updatedTabs,
        });
      }
    },
    [activeTab, focusedLeafId, layout, persistLayout]
  );

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
        const inTerminal =
          e.target instanceof Element &&
          e.target.closest('.xterm, .terminal-surface__host') !== null;
        if (layout.fullscreenLeafId !== null && !inTerminal) {
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
  }, [paneMenuOpenLeafId, headerMenuOpen, renamingLeafId, layout.fullscreenLeafId, persistLayout]);

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

  const handleLaunchTerminal = () => {
    const workspace = selectedWorkspace;
    if (!workspace) return;
    void (async () => {
      const slots = await requestWorkspaceTerminals(workspace.id, [{ engine: 'powershell', label: 'Terminal' }]);
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
  };

  const handleLaunchAgent = (engineId: string, _engineName: string) => {
    const workspace = selectedWorkspace;
    if (!workspace) return;
    void (async () => {
      const activeNames = collectActiveAgentNames(latestLayoutRef.current.tabs);
      const chosenName = getNextAgentName(activeNames);
      const slots = await requestWorkspaceTerminals(workspace.id, [{ engine: engineId, agentName: chosenName }]);
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
  };

  const handleLaunchMultiSeat = ({
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
      const slots = await requestWorkspaceTerminals(
        workspace.id,
        planned.map((seat) => ({
          engine: seat.isTerm ? 'terminal' : seat.eng,
          ...(seat.isTerm ? { label: seat.name } : { agentName: seat.agentName }),
        })),
        task,
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
  };

  const handleSplitLeaf = (
    targetLeafId: string,
    axis: PaneAxis,
    engine?: { id: string; name: string }
  ) => {
    const workspace = selectedWorkspace;
    const tab = activeTab;
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
      const slots = await requestWorkspaceTerminals(workspace.id, seats);
      const current = latestLayoutRef.current;
      const currentTab = current.tabs.find((item) => item.id === tab.id);
      if (!currentTab || current.workspaceId !== workspace.id) return;
      const slot = slots?.[0];
      const finalName = slot?.agentName || agentName || label;
      const newLeaf = createLeaf({
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
      });

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
  };

  const updateActiveRoot = (nextRoot: PaneNode) => {
    if (!activeTab) return;
    void persistLayout({
      ...layout,
      tabs: layout.tabs.map((tab) => (tab.id === activeTab.id ? { ...tab, root: nextRoot } : tab)),
    });
  };

  const handleEqualize = () => {
    if (!activeTab) return;
    updateActiveRoot(equalizeSplits(activeTab.root));
  };

  const handleSwap = (leafId: string, direction: -1 | 1) => {
    if (!activeTab) return;
    updateActiveRoot(swapAdjacent(activeTab.root, leafId, direction));
  };

  const handleExtractLeafToTab = (leafId: string) => {
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

    const updatedTabs = layout.tabs.map((t) =>
      t.id === activeTab.id
        ? { ...t, root: updatedRoot, focusedLeafId: nextFocusedInCurrent }
        : t
    );

    setFocusedLeafId(leaf.id);
    void persistLayout({
      ...layout,
      tabs: [...updatedTabs, newTab],
      activeTabId: newTab.id,
      fullscreenLeafId: null,
    });
  };

  const handleRenameLeaf = (leafId: string, name: string) => {
    if (!activeTab) return;
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
    updateActiveRoot(walk(activeTab.root));
  };

  const handleCloseLeaf = (targetLeafId: string) => {
    if (!selectedWorkspace) return;
    const current = latestLayoutRef.current;
    const targetTab = current.tabs.find((t) => findLeaf(t.root, targetLeafId) !== null) || activeTab;
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
  };

  const handleCloseTab = (tabId: string) => {
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
  };

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
      autoApprove?: boolean;
      workspaceId?: string;
      sourceSessionId?: string;
      sourcePaneId?: string;
      label?: string;
      projectileLabel?: string;
    }) => {
      const paneId = globalThis.crypto.randomUUID();
      // S3: a spawn without an explicit engine is a shell pane, never a silent Grok launch.
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

      try {
        await invokeCommand('start_terminal', {
          sessionId: detail.sessionId,
          engine: wireEngine,
          workspaceId: selectedWorkspace?.id || null,
          paneId,
          columns: 80,
          rows: 24,
          confirmedByBuilder: true,
          agentName: agentName || undefined,
          displayName: leafLabel,
          initialPrompt: undefined, // Let terminal start interactively; staged delivery writes prompt visibly
          autoApprove: detail.autoApprove ?? true,
        });
      } catch (err) {
        console.warn('[ODD] Failed to start terminal:', err);
        // S1: without a live PTY there is no terminal to register or to lay out.
        throw err;
      }

      // S1: the registry only learns about a terminal once the PTY IPC resolved, so a
      // failed spawn can never masquerade as a live agent in verification.
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
        const newTab: WorkspaceTab = {
          id: globalThis.crypto.randomUUID(),
          title: leafLabel,
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

        if (detail.initialPrompt) {
          dispatchPromptWhenPaneReady({
            targetPaneId: newLeaf.id,
            targetSessionId: detail.sessionId,
            agentName: leafLabel,
            engine: wireEngine,
            prompt: detail.initialPrompt,
            sourceSessionId: detail.sourceSessionId,
            sourcePaneId: detail.sourcePaneId,
            label: detail.label ?? detail.projectileLabel,
          });
        }
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

      if (detail.initialPrompt) {
        dispatchPromptWhenPaneReady({
          targetPaneId: newLeaf.id,
          targetSessionId: detail.sessionId,
          agentName: leafLabel,
          engine: wireEngine,
          prompt: detail.initialPrompt,
          sourceSessionId: detail.sourceSessionId,
          sourcePaneId: detail.sourcePaneId,
          label: detail.label ?? detail.projectileLabel,
        });
      }
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
      }>;
      const detail = customEvent.detail;
      if (!detail) return;
      // S9: a spawn requested while the workspace switch is still propagating must not be
      // dropped; the pane lands in the workspace tree that is currently rendered.
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
  }, [selectedWorkspace, persistLayout, onSelectWorkspace]);

  const handleToggleFullscreen = (leafId: string) => {
    const nextFs = layout.fullscreenLeafId === leafId ? null : leafId;
    void persistLayout({
      ...layout,
      fullscreenLeafId: nextFs,
    });
  };

  // S8 — operator-driven pane layout: equalize, split, focus and zoom the pane grid.
  // No dependency array: the listener always sees the latest layout and handlers.
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

  const handleDividerPointerDown = (
    e: React.PointerEvent,
    splitId: string,
    dividerIndex: number,
    axis: PaneAxis
  ) => {
    e.preventDefault();
    const isVertical = axis === 'vertical';
    const startPos = isVertical ? e.clientX : e.clientY;
    const parentElem = (e.currentTarget.parentElement as HTMLElement) || containerRef.current;
    const totalSize = isVertical ? parentElem.clientWidth : parentElem.clientHeight;

    const handlePointerMove = (ev: PointerEvent) => {
      const currentPos = isVertical ? ev.clientX : ev.clientY;
      const deltaPixels = currentPos - startPos;
      const deltaRatio = deltaPixels / (totalSize || 1);

      if (!activeTab) return;
      const nextRoot = updateSplitRatios(activeTab.root, splitId, dividerIndex, deltaRatio);
      const nextLayout: WorkspaceLayout = {
        ...latestLayoutRef.current,
        tabs: latestLayoutRef.current.tabs.map((t) => (t.id === activeTab.id ? { ...t, root: nextRoot } : t)),
      };
      latestLayoutRef.current = nextLayout;
      setLayout(nextLayout);
    };

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      if (selectedWorkspace?.id && latestLayoutRef.current) {
        void invokeCommand('save_workspace_layout', {
          workspaceId: selectedWorkspace.id,
          layout: latestLayoutRef.current,
        });
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
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

  const renderPaneNode = (node: PaneNode): React.ReactNode => {
    let targetNode = node;
    if (layout.fullscreenLeafId) {
      const fsLeaf = findLeaf(node, layout.fullscreenLeafId);
      if (fsLeaf) {
        targetNode = fsLeaf;
      }
    }
    return (
      <PaneNodeRenderer
        node={targetNode}
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

  const renderNotices = () => {
    if (!operationError && !persistenceWarning) return null;
    return (
      <section className="workspace-notices" aria-label="Workspace notices">
        {operationError ? (
          <div className="workspace-notice workspace-notice--error" role="alert">
            <span>{operationError}</span>
            <button
              type="button"
              aria-label="Dismiss pane error"
              onClick={() => setOperationError(null)}
            >
              <CloseIcon size={11} />
            </button>
          </div>
        ) : null}
        {persistenceWarning ? (
          <div className="workspace-notice workspace-notice--error" role="alert">
            <span>
              {persistenceWarning}
              {failedSaveAttempts > 1 ? (
                <small className="workspace-notice__attempts"> Retry {failedSaveAttempts - 1} also failed.</small>
              ) : null}
            </span>
            <button
              type="button"
              onClick={() => void persistLayout(latestLayoutRef.current)}
            >
              Retry save
            </button>
          </div>
        ) : null}
      </section>
    );
  };

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
