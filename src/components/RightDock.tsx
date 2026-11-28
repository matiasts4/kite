import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { BrowserView } from './views/BrowserView';
import {
  closeBrowserSurfaceSession,
  closeInactiveBrowserSurfaces,
  getBrowserSurfaceSession,
} from './views/browser/browserSurfaceRegistry';
import { OPEN_RIGHT_DOCK_BROWSER_EVENT, consumePendingBrowserRequest } from '../lib/terminalLinkNav';
import {
  OPEN_DIFFS_EVENT,
  OPEN_RIGHT_DOCK_DIFFS_EVENT,
  peekPendingDiffPreview,
} from '../lib/diffPreviewNav';
import { openFileInRightDock, peekPendingFilePreview } from '../lib/filePreviewNav';
const FilesView = React.lazy(() =>
  import('./views/FilesView').then((m) => ({ default: m.FilesView }))
);
const DiffsView = React.lazy(() =>
  import('./views/diffs/DiffsView').then((m) => ({ default: m.DiffsView }))
);
import { TicketsView } from './views/TicketsView';
import { PromptsView } from './views/PromptsView';
import { SidePanelAppsView } from './views/SidePanelAppsView';
import { SidecarPanelView } from './views/SidecarPanelView';
import { AgentDashboardView } from './views/apps/AgentDashboardView';
import { SubagentInspectorView } from './views/subagents/SubagentInspectorView';
import { VoiceTranscriptPane } from './views/voice/VoiceTranscriptPane';
import {
  consumePendingVoiceTranscriptRequest,
  type PendingVoiceTranscriptRequest,
} from './views/chat/VoiceTranscriptCard';
import { AgentStatusIndicator } from './ui/AgentStatusIndicator';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { getActiveAgentTerminals } from '../lib/terminalRegistry';
import {
  OPEN_RIGHT_DOCK_SUBAGENT_EVENT,
  consumePendingSubagentRequest,
  type OpenRightDockSubagentDetail,
} from '../lib/subagentNav';
import {
  OPEN_RIGHT_DOCK_SIDECAR_EVENT,
  consumePendingSidecarRequest,
  registerKnownSidecars,
  type OpenRightDockSidecarDetail,
} from '../lib/sidecarNav';
import {
  listUiSidecars,
  pluginMcpAppListEntrypoints,
  runSidecarAction,
  type McpAppEntrypointDto,
  type SidecarStatusSnapshot,
} from '../lib/ipc/pluginRuntime';
import { McpAppFrame } from './views/plugins/McpAppFrame';
import { loadChatThread } from '../lib/ipc/chat';
import { countRunningSubagents } from './views/chat/hooks/useSubagentEvents';
import { AnimatePresence, motion } from 'motion/react';
import { MOTION_EXIT_MS } from '../motion/contract';
import { surfaceMotion } from '../motion/standard/surfaces';
import type { Workspace } from '../types';
import {
  CloseGlyph,
  PlusGlyph,
  Maximize2Glyph,
  Minimize2Glyph,
} from './dockIcons';
import {
  type SidePanelAppId,
  type RightDockTabKind,
  type DockTabItem,
  type TabResolvedDef,
  loadInitialTabs,
  persistTabs,
  computeResponsiveDockWidth,
  loadInitialWidth,
  persistWidth,
  resolveTabDef,
  STANDARD_MENU_TABS,
  APP_MENU_TABS,
} from './dock/dockConfig';
import {
  type TabBox,
  TAB_GAP,
  calculateSlot,
  calculateTabShifts,
  clampDragOffset,
  calculateSlotLeft,
  getKeyboardNextIndex,
  usePointerDrag,
} from './dock/dockTabPhysics';
import { DockNewTabMenu } from './dock/DockNewTabMenu';

export type { SidePanelAppId, RightDockTabKind, DockTabItem };
export type RightDockTab = RightDockTabKind;

export interface RightDockProps {
  visible: boolean;
  onClose: () => void;
  workspaceId: string | null;
  selectedThreadId?: string | null;
  activeSubagentsCount?: number;
  isOccluded?: boolean;
  workspaces?: Workspace[];
  onSelectWorkspace?: (id: string) => void;
  onStartAgent?: () => void;
}

const RightDockInner: React.FC<RightDockProps> = ({
  visible,
  workspaceId,
  selectedThreadId = null,
  activeSubagentsCount,
  isOccluded = false,
  workspaces = [],
  onSelectWorkspace,
  onStartAgent,
}) => {
  const [initial] = useState(() => loadInitialTabs());
  const [tabs, setTabs] = useState<DockTabItem[]>(initial.tabs);
  const [activeTabId, setActiveTabId] = useState<string>(initial.activeTabId);
  const [requestedSubagentTarget, setRequestedSubagentTarget] =
    useState<OpenRightDockSubagentDetail | null>(null);
  const [liveSubagentsCount, setLiveSubagentsCount] = useState<number>(0);
  const trackedSubagentThreadId = requestedSubagentTarget?.threadId ?? selectedThreadId;
  const trackedSubagentThreadIdRef = useRef<string | null>(trackedSubagentThreadId);
  trackedSubagentThreadIdRef.current = trackedSubagentThreadId;
  const prevSelectedThreadIdRef = useRef<string | null>(selectedThreadId);

  useEffect(() => {
    if (prevSelectedThreadIdRef.current === selectedThreadId) return;
    prevSelectedThreadIdRef.current = selectedThreadId;
    setRequestedSubagentTarget((prev) => {
      if (!prev) return null;
      return prev.threadId === selectedThreadId ? prev : null;
    });
  }, [selectedThreadId]);
  const [panelWidth, setPanelWidth] = useState<number>(() => loadInitialWidth());
  const [viewportWidth, setViewportWidth] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1366
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  const effectivePanelWidth = computeResponsiveDockWidth(panelWidth, viewportWidth);
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(effectivePanelWidth);
  widthRef.current = effectivePanelWidth;

  const [isFullScreen, setIsFullScreen] = useState(false);
  const [isNewTabMenuOpen, setIsNewTabMenuOpen] = useState(false);
  const [highlightedMenuId, setHighlightedMenuId] = useState<string | null>(null);
  const [uiSidecars, setUiSidecars] = useState<SidecarStatusSnapshot[]>([]);
  const [mcpAppEntrypoints, setMcpAppEntrypoints] = useState<McpAppEntrypointDto[]>([]);
  const uiSidecarsRef = useRef<SidecarStatusSnapshot[]>(uiSidecars);
  uiSidecarsRef.current = uiSidecars;
  const asideRef = useRef<HTMLElement | null>(null);

  const [savedWorkspaceId, setSavedWorkspaceId] = useState<string | null>(() => {
    if (!visible || workspaceId || typeof window === 'undefined') return null;
    try {
      return window.localStorage.getItem('kite.selectedWorkspaceId');
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (!visible || workspaceId || typeof window === 'undefined') return;
    try {
      const next = window.localStorage.getItem('kite.selectedWorkspaceId');
      setSavedWorkspaceId((prev) => (prev === next ? prev : next));
    } catch {
      setSavedWorkspaceId(null);
    }
  }, [visible, workspaceId]);

  const effectiveWorkspaceId = useMemo(() => {
    if (workspaceId) return workspaceId;
    if (savedWorkspaceId && workspaces?.some((w) => w.id === savedWorkspaceId)) {
      return savedWorkspaceId;
    }
    return workspaces?.[0]?.id ?? null;
  }, [workspaceId, savedWorkspaceId, workspaces]);

  useEffect(() => {
    if (visible && !workspaceId && effectiveWorkspaceId && onSelectWorkspace) {
      onSelectWorkspace(effectiveWorkspaceId);
    }
  }, [visible, workspaceId, effectiveWorkspaceId, onSelectWorkspace]);

  // Destroy dormant WebView2 browser surfaces belonging to inactive workspaces.
  useEffect(() => {
    if (!visible && !workspaceId) return;
    void closeInactiveBrowserSurfaces(effectiveWorkspaceId);
  }, [visible, workspaceId, effectiveWorkspaceId]);

  const refreshUiSidecars = useCallback(async () => {
    try {
      const sidecars = await listUiSidecars(effectiveWorkspaceId);
      setUiSidecars(sidecars);
      registerKnownSidecars(sidecars);
    } catch (err) {
      console.warn('[RightDock] Failed to load UI sidecars:', err);
    }
  }, [effectiveWorkspaceId]);

  const refreshMcpAppEntrypoints = useCallback(async () => {
    try {
      const entrypoints = await pluginMcpAppListEntrypoints(effectiveWorkspaceId);
      setMcpAppEntrypoints(entrypoints);
    } catch (err) {
      console.warn('[RightDock] Failed to load MCP App entrypoints:', err);
    }
  }, [effectiveWorkspaceId]);

  useEffect(() => {
    if (!visible) return;
    void refreshUiSidecars();
    const handlePluginsUpdated = () => {
      void refreshUiSidecars();
    };
    window.addEventListener('kite:plugins-updated', handlePluginsUpdated);
    return () => {
      window.removeEventListener('kite:plugins-updated', handlePluginsUpdated);
    };
  }, [visible, isNewTabMenuOpen, refreshUiSidecars]);

  useEffect(() => {
    if (!visible || !isNewTabMenuOpen) return;
    void refreshMcpAppEntrypoints();
    const handlePluginsUpdated = () => {
      void refreshMcpAppEntrypoints();
    };
    window.addEventListener('kite:plugins-updated', handlePluginsUpdated);
    return () => {
      window.removeEventListener('kite:plugins-updated', handlePluginsUpdated);
    };
  }, [visible, isNewTabMenuOpen, refreshMcpAppEntrypoints]);

  const allMenuItems = useMemo(
    () => [
      ...STANDARD_MENU_TABS.map((t) => ({ id: `std-${t.kind}`, kind: t.kind, type: 'standard' as const })),
      ...APP_MENU_TABS.map((t) => ({ id: `app-${t.appId}`, appId: t.appId, type: 'app' as const })),
      ...uiSidecars.map((s) => ({
        id: `sidecar-${s.namespacedId}`,
        sidecar: s,
        type: 'sidecar' as const,
      })),
      ...mcpAppEntrypoints.map((entry) => ({
        id: `mcp-app-${entry.id}`,
        entry,
        type: 'mcp-app' as const,
      })),
    ],
    [uiSidecars, mcpAppEntrypoints]
  );

  // Set inert on background siblings while maximized/fullscreen
  useLayoutEffect(() => {
    const el = asideRef.current;
    const parent = el?.parentElement;
    if (!isFullScreen || !el || !parent) return;

    const siblings = Array.from(parent.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        child !== el &&
        !child.classList.contains('app-browser-sidebar__spacer')
    );

    for (const s of siblings) {
      s.setAttribute('inert', '');
    }

    return () => {
      for (const s of siblings) {
        s.removeAttribute('inert');
      }
    };
  }, [isFullScreen]);

  // Handle Escape key to exit fullscreen
  useEffect(() => {
    if (!isFullScreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsFullScreen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFullScreen]);

  // Dynamic active agents count for Dashboard badge
  const [activeAgentsCount, setActiveAgentsCount] = useState<number>(() => {
    const active = getActiveAgentTerminals();
    return active.length;
  });

  useEffect(() => {
    if (!visible) return;
    const update = () => {
      const nextCount = getActiveAgentTerminals().length;
      setActiveAgentsCount((prev) => (prev === nextCount ? prev : nextCount));
    };
    update();
    window.addEventListener('kite:terminal-agent-update', update);
    const interval = window.setInterval(update, 2000);
    return () => {
      window.removeEventListener('kite:terminal-agent-update', update);
      window.clearInterval(interval);
    };
  }, [visible]);

  const [requestedVoiceCallId, setRequestedVoiceCallId] = useState<string | null>(null);
  const [requestedVoiceThreadId, setRequestedVoiceThreadId] = useState<string | null>(null);

  useEffect(() => {
    const applyVoiceTranscriptRequest = (detail?: PendingVoiceTranscriptRequest | null) => {
      if (detail?.callId !== undefined) {
        setRequestedVoiceCallId(detail.callId ?? null);
      }
      if (detail?.threadId !== undefined) {
        setRequestedVoiceThreadId(detail.threadId ?? null);
      }
      setTabs((prev) => {
        if (!prev.some((t) => t.id === 'voice-transcript')) {
          return [...prev, { id: 'voice-transcript', kind: 'voice-transcript' }];
        }
        return prev;
      });
      setActiveTabId('voice-transcript');
    };

    const handleOpenVoiceTranscript = (e: Event) => {
      const custom = e as CustomEvent<PendingVoiceTranscriptRequest>;
      consumePendingVoiceTranscriptRequest();
      applyVoiceTranscriptRequest(custom.detail);
    };

    const pending = consumePendingVoiceTranscriptRequest();
    if (pending) {
      applyVoiceTranscriptRequest(pending);
    }
    window.addEventListener('kite:open-voice-transcript', handleOpenVoiceTranscript);
    return () => window.removeEventListener('kite:open-voice-transcript', handleOpenVoiceTranscript);
  }, []);

  // Listen for open-right-dock-file to switch to the files tab
  useEffect(() => {
    const handleOpenFile = () => {
      setTabs((prev) => {
        if (!prev.some((t) => t.id === 'files')) {
          return [...prev, { id: 'files', kind: 'files' }];
        }
        return prev;
      });
      setActiveTabId('files');
    };
    if (peekPendingFilePreview()) {
      handleOpenFile();
    }
    window.addEventListener('kite:open-right-dock-file', handleOpenFile);
    return () => window.removeEventListener('kite:open-right-dock-file', handleOpenFile);
  }, []);

  // Listen for open-right-dock-browser event to switch to or open the browser tab and load URL
  useEffect(() => {
    const applyBrowserRequest = (detail?: { url?: string; workspaceId?: string | null }) => {
      setTabs((prev) => {
        if (!prev.some((t) => t.id === 'browser')) {
          return [...prev, { id: 'browser', kind: 'browser' }];
        }
        return prev;
      });
      setActiveTabId('browser');

      if (detail?.url) {
        const targetWorkspaceId = detail?.workspaceId ?? effectiveWorkspaceId;
        const session = getBrowserSurfaceSession(targetWorkspaceId);
        void session.openAddress(detail.url);
      }
    };

    const handleOpenBrowser = (e: Event) => {
      const custom = e as CustomEvent<{ url?: string; workspaceId?: string | null }>;
      consumePendingBrowserRequest();
      applyBrowserRequest(custom.detail);
    };

    const pendingBrowser = consumePendingBrowserRequest();
    if (pendingBrowser) {
      applyBrowserRequest(pendingBrowser);
    }

    window.addEventListener(OPEN_RIGHT_DOCK_BROWSER_EVENT, handleOpenBrowser);
    return () => window.removeEventListener(OPEN_RIGHT_DOCK_BROWSER_EVENT, handleOpenBrowser);
  }, [effectiveWorkspaceId]);

  const tabsRef = useRef<DockTabItem[]>(tabs);
  tabsRef.current = tabs;

  const openOrFocusSidecarTab = useCallback((detail: OpenRightDockSidecarDetail) => {
    const rawId = detail.sidecarId?.trim();
    if (!rawId) return;

    const known = uiSidecarsRef.current;
    let matched = known.find(
      (s) =>
        s.namespacedId.toLowerCase() === rawId.toLowerCase() ||
        s.sidecarId.toLowerCase() === rawId.toLowerCase()
    );
    let resolvedViewPath = detail.viewPath;

    if (!matched && rawId.includes('/')) {
      const [head, ...rest] = rawId.split('/');
      const shortMatch = known.find((s) => s.sidecarId.toLowerCase() === head.toLowerCase());
      if (shortMatch) {
        matched = shortMatch;
        const prefix = `/${rest.join('/')}`;
        if (!resolvedViewPath || resolvedViewPath === '/') {
          resolvedViewPath = prefix;
        }
      }
    }

    const resolvedSidecarId = matched?.namespacedId ?? rawId;
    const defaultTabId = `sidecar:${resolvedSidecarId}`;
    const resolvedTitle =
      detail.title?.trim() ||
      matched?.views[0]?.title?.trim() ||
      matched?.displayName?.trim() ||
      null;
    const nextViewPath = resolvedViewPath ?? matched?.views[0]?.path ?? '/';

    const existingCurrent = tabsRef.current.find(
      (t) =>
        t.id === defaultTabId ||
        (t.kind === 'sidecar' &&
          matched &&
          (t.sidecarId?.toLowerCase() === matched.namespacedId.toLowerCase() ||
            t.sidecarId?.toLowerCase() === matched.sidecarId.toLowerCase()))
    );
    const targetTabId = existingCurrent?.id ?? defaultTabId;

    setTabs((prev) => {
      const existing = prev.find((t) => t.id === targetTabId);
      if (existing) {
        const updatedViewPath = resolvedViewPath ?? existing.viewPath ?? nextViewPath;
        const updatedTitle = detail.title?.trim() || existing.title || resolvedTitle;
        if (updatedViewPath === existing.viewPath && updatedTitle === existing.title) {
          return prev;
        }
        return prev.map((t) =>
          t.id === existing.id
            ? { ...t, viewPath: updatedViewPath, title: updatedTitle }
            : t
        );
      }
      return [
        ...prev,
        {
          id: defaultTabId,
          kind: 'sidecar',
          sidecarId: resolvedSidecarId,
          viewPath: nextViewPath,
          title: resolvedTitle,
        },
      ];
    });
    setActiveTabId(targetTabId);
  }, []);

  // Listen for open-right-dock-sidecar event and consume any queued mount request
  useEffect(() => {
    const handleOpenSidecar = (e: Event) => {
      const custom = e as CustomEvent<OpenRightDockSidecarDetail>;
      consumePendingSidecarRequest();
      if (custom.detail?.sidecarId) {
        openOrFocusSidecarTab(custom.detail);
      }
    };

    const pendingSidecar = consumePendingSidecarRequest();
    if (pendingSidecar?.sidecarId) {
      openOrFocusSidecarTab(pendingSidecar);
    }

    window.addEventListener(OPEN_RIGHT_DOCK_SIDECAR_EVENT, handleOpenSidecar);
    return () => window.removeEventListener(OPEN_RIGHT_DOCK_SIDECAR_EVENT, handleOpenSidecar);
  }, [openOrFocusSidecarTab]);

  // Listen for open-right-dock-diffs event to switch to or open diffs tab
  useEffect(() => {
    const handleOpenDiffs = () => {
      setTabs((prev) => {
        if (!prev.some((t) => t.id === 'diffs')) {
          return [...prev, { id: 'diffs', kind: 'diffs' }];
        }
        return prev;
      });
      setActiveTabId('diffs');
    };
    if (peekPendingDiffPreview()) {
      handleOpenDiffs();
    }
    window.addEventListener(OPEN_RIGHT_DOCK_DIFFS_EVENT, handleOpenDiffs);
    window.addEventListener(OPEN_DIFFS_EVENT, handleOpenDiffs);
    return () => {
      window.removeEventListener(OPEN_RIGHT_DOCK_DIFFS_EVENT, handleOpenDiffs);
      window.removeEventListener(OPEN_DIFFS_EVENT, handleOpenDiffs);
    };
  }, []);

  // Shortcut Ctrl+Alt+D to open or focus diffs tab, Ctrl+Alt+S for subagents tab
  useEffect(() => {
    const handleOpenSubagents = (e?: Event) => {
      const custom = e as CustomEvent<OpenRightDockSubagentDetail> | undefined;
      const pending = consumePendingSubagentRequest();
      const target = custom?.detail ?? pending ?? null;
      if (target) {
        setRequestedSubagentTarget(target);
      }
      setTabs((prev) => {
        if (!prev.some((t) => t.id === 'subagents')) {
          return [...prev, { id: 'subagents', kind: 'subagents' }];
        }
        return prev;
      });
      setActiveTabId('subagents');
    };

    const handleGlobalShortcuts = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        setTabs((prev) => {
          if (!prev.some((t) => t.id === 'diffs')) {
            return [...prev, { id: 'diffs', kind: 'diffs' }];
          }
          return prev;
        });
        setActiveTabId('diffs');
      } else if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        handleOpenSubagents();
      }
    };
    const handleSubagentCount = (e: Event) => {
      const custom = e as CustomEvent<{ threadId?: string; count?: number }>;
      const incomingThreadId = custom.detail?.threadId;
      if (incomingThreadId && incomingThreadId !== trackedSubagentThreadIdRef.current) {
        return;
      }
      if (typeof custom.detail?.count === 'number') {
        setLiveSubagentsCount(Math.max(0, custom.detail.count));
      }
    };

    const pendingOnMount = consumePendingSubagentRequest();
    if (pendingOnMount) {
      setRequestedSubagentTarget(pendingOnMount);
      setTabs((prev) => {
        if (!prev.some((t) => t.id === 'subagents')) {
          return [...prev, { id: 'subagents', kind: 'subagents' }];
        }
        return prev;
      });
      setActiveTabId('subagents');
    }

    window.addEventListener('keydown', handleGlobalShortcuts);
    window.addEventListener(OPEN_RIGHT_DOCK_SUBAGENT_EVENT, handleOpenSubagent);
    window.addEventListener('kite:subagent-activity-count', handleSubagentCount);
    return () => {
      window.removeEventListener('keydown', handleGlobalShortcuts);
      window.removeEventListener(OPEN_RIGHT_DOCK_SUBAGENT_EVENT, handleOpenSubagent);
      window.removeEventListener('kite:subagent-activity-count', handleSubagentCount);
    };

    function handleOpenSubagent(e: Event) {
      handleOpenSubagents(e);
    }
  }, []);

  // Sync live subagents running count for the active thread in Tauri sessions
  useEffect(() => {
    if (activeSubagentsCount !== undefined) return;
    setLiveSubagentsCount(0);
    if (!trackedSubagentThreadId) {
      return;
    }
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
      return;
    }
    // One-shot count when the tracked thread changes. Later changes arrive through the
    // `kite:subagent-activity-count` listener, so lifecycle events never re-download the
    // whole thread here.
    let cancelled = false;
    void loadChatThread(trackedSubagentThreadId)
      .then((thread) => {
        if (!cancelled) {
          setLiveSubagentsCount(countRunningSubagents(thread));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [trackedSubagentThreadId, activeSubagentsCount]);

  // Persistence for tabs & active tab
  const hasMountedTabsRef = useRef(false);
  useEffect(() => {
    if (!hasMountedTabsRef.current) {
      hasMountedTabsRef.current = true;
      return;
    }
    persistTabs(tabs, activeTabId);
  }, [tabs, activeTabId]);

  // Tab Drag & Drop state
  const tabElementsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const tabButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const pointerDownTargetRef = useRef<{ id: string; x: number } | null>(null);

  const [settling, setSettling] = useState<{ id: string; offset: number; phase: 'from' | 'to' } | null>(null);
  const dragRef = useRef<{ id: string; from: number; boxes: TabBox[]; originX: number; startX: number; dx: number; scale: number; slot: number } | null>(null);
  const [activeDrag, setActiveDrag] = useState<{ id: string; from: number; boxes: TabBox[]; originX: number; startX: number; dx: number; scale: number; slot: number } | null>(null);

  const didDragRef = useRef(false);
  const focusPendingTabIdRef = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const canReorder = tabs.length > 1;

  const cancelDrag = useCallback(() => {
    dragRef.current = null;
    setActiveDrag(null);
  }, []);

  const moveTab = useCallback((id: string, targetSlot: number) => {
    setTabs((prev) => {
      const fromIndex = prev.findIndex((t) => t.id === id);
      if (fromIndex === -1 || targetSlot < 0 || targetSlot >= prev.length || fromIndex === targetSlot) return prev;
      const next = [...prev];
      const [removed] = next.splice(fromIndex, 1);
      next.splice(targetSlot, 0, removed);
      return next;
    });
  }, []);

  const dragHook = usePointerDrag({
    enabled: canReorder,
    ignoreSelector: '.side-panel-tab__close',
    onStart: (pos) => {
      const target = pointerDownTargetRef.current;
      const from = tabs.findIndex((t) => t.id === target?.id);
      if (!target || from < 0) return;

      const container = tabsContainerRef.current;
      const containerRect = container?.getBoundingClientRect();
      const scaleRaw = containerRect && container ? containerRect.width / container.offsetWidth : 1;
      const scale = Number.isFinite(scaleRaw) && scaleRaw > 0 ? scaleRaw : 1;

      const boxes: TabBox[] = tabs.map((t) => {
        const rect = tabElementsRef.current.get(t.id)?.getBoundingClientRect();
        return { left: (rect?.left ?? 0) / scale, width: (rect?.width ?? 0) / scale };
      });

      const originX = (containerRect?.left ?? 0) / scale - (container?.scrollLeft ?? 0);
      const dragInfo = { id: target.id, from, boxes, originX, startX: target.x, dx: (pos.clientX - target.x) / scale, scale, slot: from };

      setSettling(null);
      dragRef.current = dragInfo;
      setActiveDrag(dragInfo);
    },
    onMove: (pos) => {
      const current = dragRef.current;
      if (!current) return;
      const dx = (pos.clientX - current.startX) / current.scale;
      const currentBox = current.boxes[current.from];
      const slot = calculateSlot(current.boxes, current.from, currentBox.left + currentBox.width / 2 + dx);
      const next = { ...current, dx, slot };
      dragRef.current = next;
      setActiveDrag(next);
    },
    onEnd: () => {
      const current = dragRef.current;
      cancelDrag();
      if (!current) return;

      didDragRef.current = true;
      window.setTimeout(() => { didDragRef.current = false; }, 0);
      if (current.slot === current.from) return;

      const startOffset = current.boxes[current.from].left + clampDragOffset(current.boxes, current.from, current.dx);
      const targetOffset = calculateSlotLeft(current.boxes, current.from, current.slot);
      setSettling({ id: current.id, offset: startOffset - targetOffset, phase: 'from' });
      moveTab(current.id, current.slot);
    },
    onCancel: cancelDrag,
  });

  // Settling animation effect
  useEffect(() => {
    if (settling === null) return;
    if (settling.phase === 'from') {
      const frame = window.requestAnimationFrame(() => {
        setSettling((prev) => (prev === null ? null : { ...prev, phase: 'to' }));
      });
      return () => window.cancelAnimationFrame(frame);
    }
    const timer = window.setTimeout(() => setSettling(null), 400);
    return () => window.clearTimeout(timer);
  }, [settling]);

  // Focus pending tab on keyboard move
  useEffect(() => {
    const pendingId = focusPendingTabIdRef.current;
    if (pendingId !== null) {
      focusPendingTabIdRef.current = null;
      tabButtonRefs.current.get(pendingId)?.focus();
    }
  });

  const handleCloseTab = (tabId: string) => {
    const closingTab = tabs.find((t) => t.id === tabId);
    const targetSidecarId =
      closingTab?.kind === 'sidecar' && closingTab.sidecarId
        ? closingTab.sidecarId
        : null;
    const shouldStopSidecar =
      targetSidecarId !== null &&
      !tabs.some(
        (t) =>
          t.id !== tabId &&
          t.kind === 'sidecar' &&
          t.sidecarId === targetSidecarId
      );

    setTabs((prev) => {
      const tabIndex = prev.findIndex((t) => t.id === tabId);
      if (tabIndex === -1) return prev;
      const next = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId) {
        const fallbackIdx = Math.max(0, tabIndex - 1);
        const fallbackTab = next[fallbackIdx] || next[0];
        if (fallbackTab) setActiveTabId(fallbackTab.id);
      }
      return next;
    });
    // Closing the browser tab tears down the native WebView2 surface(s).
    if (tabId === 'browser') {
      void closeBrowserSurfaceSession(effectiveWorkspaceId);
      void closeInactiveBrowserSurfaces(effectiveWorkspaceId);
    }
    // Closing the last tab for a UI sidecar stops it to free memory and loopback ports.
    if (shouldStopSidecar && targetSidecarId) {
      void runSidecarAction(targetSidecarId, 'stop', {
        workspaceId: effectiveWorkspaceId,
      })
        .then(() => {
          void refreshUiSidecars();
        })
        .catch((err) => {
          console.warn(`[RightDock] Failed to stop closed sidecar ${targetSidecarId}:`, err);
        });
    }
  };

  const handleOpenStandardTab = (
    kind: 'browser' | 'files' | 'diffs' | 'tasks' | 'prompts' | 'subagents' | 'voice-transcript'
  ) => {
    setTabs((prev) => {
      if (!prev.some((t) => t.id === kind)) return [...prev, { id: kind, kind }];
      return prev;
    });
    setActiveTabId(kind);
    setIsNewTabMenuOpen(false);
  };

  const handleOpenAppTab = (appId: SidePanelAppId) => {
    const tabId = `app-${appId}`;
    setTabs((prev) => {
      if (!prev.some((t) => t.id === tabId)) return [...prev, { id: tabId, kind: 'app', appId }];
      return prev;
    });
    setActiveTabId(tabId);
    setIsNewTabMenuOpen(false);
  };

  const handleOpenSidecarTab = useCallback(
    (sidecar: SidecarStatusSnapshot) => {
      openOrFocusSidecarTab({
        sidecarId: sidecar.namespacedId || sidecar.sidecarId,
        viewPath: sidecar.views[0]?.path ?? '/',
        title: sidecar.views[0]?.title?.trim() || sidecar.displayName || sidecar.sidecarId,
        workspaceId: effectiveWorkspaceId,
      });
      setIsNewTabMenuOpen(false);
    },
    [effectiveWorkspaceId, openOrFocusSidecarTab]
  );

  const handleOpenMcpAppTab = useCallback(
    (entry: McpAppEntrypointDto) => {
      const tabId = `mcp-app:${entry.serverName}:${entry.toolName}`;
      const tabTitle = entry.title?.trim() || entry.toolName;
      setTabs((prev) => {
        if (!prev.some((t) => t.id === tabId)) {
          return [
            ...prev,
            {
              id: tabId,
              kind: 'mcp-app',
              title: tabTitle,
              mcpAppSpec: {
                serverName: entry.serverName,
                toolName: entry.toolName,
                resourceUri: entry.resourceUri,
                title: tabTitle,
              },
            },
          ];
        }
        return prev;
      });
      setActiveTabId(tabId);
      setIsNewTabMenuOpen(false);
    },
    []
  );

  // Keyboard navigation & Escape for New Tab menu
  useEffect(() => {
    if (!isNewTabMenuOpen) {
      setHighlightedMenuId(null);
      return;
    }
    const handleMenuKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsNewTabMenuOpen(false);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightedMenuId((prev) => {
          if (!prev) return allMenuItems[0]?.id ?? null;
          const idx = allMenuItems.findIndex((item) => item.id === prev);
          return allMenuItems[(idx + 1) % allMenuItems.length]?.id ?? null;
        });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightedMenuId((prev) => {
          if (!prev) return allMenuItems[allMenuItems.length - 1]?.id ?? null;
          const idx = allMenuItems.findIndex((item) => item.id === prev);
          return allMenuItems[(idx - 1 + allMenuItems.length) % allMenuItems.length]?.id ?? null;
        });
      } else if (e.key === 'Enter') {
        if (!highlightedMenuId) return;
        e.preventDefault();
        const found = allMenuItems.find((item) => item.id === highlightedMenuId);
        if (found) {
          if (found.type === 'standard') handleOpenStandardTab(found.kind);
          else if (found.type === 'app') handleOpenAppTab(found.appId);
          else if (found.type === 'mcp-app') handleOpenMcpAppTab(found.entry);
          else handleOpenSidecarTab(found.sidecar);
        }
      }
    };
    window.addEventListener('keydown', handleMenuKeyDown);
    return () => window.removeEventListener('keydown', handleMenuKeyDown);
  }, [
    isNewTabMenuOpen,
    allMenuItems,
    highlightedMenuId,
    handleOpenMcpAppTab,
    handleOpenSidecarTab,
  ]);

  // When panel becomes hidden, close the new tab menu if open
  useEffect(() => {
    if (!visible) {
      setIsNewTabMenuOpen(false);
    }
  }, [visible]);

  const handleTabKeyDown = (
    e: React.KeyboardEvent,
    index: number,
    tab: DockTabItem,
    tabDef: TabResolvedDef
  ) => {
    if (e.key === 'Delete' && tabDef.closable && !e.altKey) {
      e.preventDefault();
      handleCloseTab(tab.id);
      return;
    }

    if (!e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      const targetIdx = getKeyboardNextIndex(e.key, index, tabs.length);
      if (targetIdx === null) return;
      e.preventDefault();
      const targetTab = tabs[targetIdx];
      if (targetTab) tabButtonRefs.current.get(targetTab.id)?.focus();
      return;
    }

    if (!canReorder || !e.altKey || !e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) {
      return;
    }

    e.preventDefault();
    const delta = e.key === 'ArrowLeft' ? -1 : 1;
    const nextSlot = index + delta;
    if (nextSlot < 0 || nextSlot >= tabs.length) return;

    focusPendingTabIdRef.current = tab.id;
    moveTab(tab.id, nextSlot);
    setAnnouncement(`${tabDef.label} moved to position ${nextSlot + 1} of ${tabs.length}`);
  };

  const onGripDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || isFullScreen) return;
    event.preventDefault();
    event.stopPropagation();
    const gripEl = event.currentTarget;
    if (typeof gripEl.setPointerCapture === 'function') {
      try {
        gripEl.setPointerCapture(event.pointerId);
      } catch (_) {}
    }
    const startX = event.clientX;
    const startWidth = widthRef.current;
    setDragging(true);
    const onMove = (ev: PointerEvent) => {
      const next = computeResponsiveDockWidth(startWidth - (ev.clientX - startX), window.innerWidth);
      setPanelWidth(next);
      widthRef.current = next;
    };
    const onUp = () => {
      setDragging(false);
      if (typeof gripEl.hasPointerCapture === 'function' && gripEl.hasPointerCapture(event.pointerId)) {
        try {
          gripEl.releasePointerCapture(event.pointerId);
        } catch (_) {}
      }
      persistWidth(widthRef.current);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const [dockMounted, setDockMounted] = useState(visible);

  useEffect(() => {
    if (visible) setDockMounted(true);
  }, [visible]);

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];

  return (
    <>
      {dragging && dockMounted && (
        <div
          aria-hidden="true"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 99999,
            cursor: 'col-resize',
            userSelect: 'none',
            background: 'transparent',
          }}
        />
      )}
      {isFullScreen && dockMounted && (
        <div
          aria-hidden="true"
          className="app-browser-sidebar__spacer"
          style={{ '--app-browser-width': `${effectivePanelWidth}px`, width: effectivePanelWidth, minWidth: effectivePanelWidth, flex: 'none' } as React.CSSProperties}
        />
      )}
      <AnimatePresence onExitComplete={() => setDockMounted(false)}>
        {visible && (
          <motion.aside
            key="right-dock"
            ref={asideRef}
            {...surfaceMotion('panel', { exitMs: MOTION_EXIT_MS })}
            className={`app-browser-sidebar ${isFullScreen ? 'app-browser-sidebar--fullscreen' : ''}${dragging ? ' app-browser-sidebar--resizing' : ''}`}
            data-testid="app-browser-sidebar"
            style={isFullScreen ? undefined : ({ '--app-browser-width': `${effectivePanelWidth}px`, width: effectivePanelWidth, minWidth: effectivePanelWidth, flex: 'none' } as React.CSSProperties)}
          >
            {!isFullScreen && (
              <hr
                className="app-browser-sidebar__grip"
                aria-label="Resize side panel"
                aria-orientation="vertical"
                aria-valuemin={viewportWidth < 900 ? 260 : 320}
                aria-valuemax={computeResponsiveDockWidth(viewportWidth, viewportWidth)}
                aria-valuenow={effectivePanelWidth}
                data-dragging={dragging ? 'true' : undefined}
                onPointerDown={onGripDown}
                tabIndex={0}
              />
            )}

            {/* Side Panel Header with Tab Navigation */}
            <div
              className={`side-panel-header${activeDrag !== null ? ' side-panel-header--dragging' : ''}`}
              data-tooltip-placement="above"
            >
              <span aria-live="polite" className="sr-only">
                {announcement || activeTab?.kind}
              </span>

              {/* Tab list */}
              <div
                aria-label="Sidebar tabs"
                className="side-panel-header__tabs"
                ref={tabsContainerRef}
                role="tablist"
              >
                {activeDrag !== null && (
                  <span
                    aria-hidden="true"
                    className="side-panel-tab-slot"
                    style={{
                      left: `${calculateSlotLeft(activeDrag.boxes, activeDrag.from, activeDrag.slot) - activeDrag.originX}px`,
                      width: `${activeDrag.boxes[activeDrag.from]?.width ?? 0}px`,
                    }}
                  />
                )}

                {tabs.map((tab, index) => {
                  const def = resolveTabDef(tab);
                  const isSelected = tab.id === activeTab?.id;
                  const isCarried = activeDrag?.id === tab.id;
                  const isSettling = settling?.id === tab.id;

                  const shifts = activeDrag === null ? null : calculateTabShifts(activeDrag.boxes, activeDrag.from, activeDrag.slot, TAB_GAP);
                  const translateX = isCarried
                    ? clampDragOffset(activeDrag?.boxes ?? [], activeDrag?.from ?? 0, activeDrag?.dx ?? 0)
                    : isSettling && settling?.phase === 'from'
                    ? settling.offset
                    : shifts?.[index] ?? 0;

                  const shortcuts = [
                    canReorder && index > 0 ? 'Alt+Shift+ArrowLeft' : null,
                    canReorder && index < tabs.length - 1 ? 'Alt+Shift+ArrowRight' : null,
                    def.closable ? 'Delete' : null,
                  ].filter(Boolean);

                  return (
                    <div
                      key={tab.id}
                      className={`side-panel-tab${isSelected ? ' side-panel-tab--selected' : ''}${isCarried ? ' side-panel-tab--carried' : ''}${isSettling ? ` side-panel-tab--settling-${settling?.phase}` : ''}`}
                      data-kind={tab.kind}
                      onPointerDown={(e) => {
                        pointerDownTargetRef.current = { id: tab.id, x: e.clientX };
                        dragHook.onPointerDown(e);
                      }}
                      ref={(el) => {
                        if (el === null) tabElementsRef.current.delete(tab.id);
                        else tabElementsRef.current.set(tab.id, el);
                      }}
                      style={translateX === 0 ? undefined : { transform: `translateX(${translateX}px)` }}
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={isSelected}
                        aria-keyshortcuts={shortcuts.length > 0 ? shortcuts.join(' ') : undefined}
                        tabIndex={isSelected ? 0 : -1}
                        className="side-panel-tab__select"
                        onClick={() => {
                          if (didDragRef.current) return;
                          setActiveTabId(tab.id);
                        }}
                        onKeyDown={(e) => handleTabKeyDown(e, index, tab, def)}
                        ref={(el) => {
                          if (el === null) tabButtonRefs.current.delete(tab.id);
                          else tabButtonRefs.current.set(tab.id, el);
                        }}
                        title={canReorder ? `${def.tooltip} · drag to reorder` : def.tooltip}
                      >
                        {def.renderIcon()}
                        <span className="side-panel-tab__label">{def.label}</span>
                        {tab.kind === 'dashboard' && activeAgentsCount > 0 && (
                          <span className="side-panel-tab__count">{activeAgentsCount}</span>
                        )}
                        {tab.kind === 'subagents' && (activeSubagentsCount ?? liveSubagentsCount) > 0 && (
                          <span className="side-panel-tab__activity">
                            <AgentStatusIndicator status="running" size={11} />
                            <span className="side-panel-tab__count">
                              {activeSubagentsCount ?? liveSubagentsCount}
                            </span>
                          </span>
                        )}
                      </button>

                      {def.closable && activeDrag === null && (
                        <button
                          type="button"
                          className="side-panel-tab__close"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCloseTab(tab.id);
                          }}
                          tabIndex={-1}
                          title="Close tab"
                          aria-label={`Close ${def.label}`}
                        >
                          <CloseGlyph />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* New Tab Action with Dropdown Menu */}
              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  aria-expanded={isNewTabMenuOpen}
                  aria-haspopup="menu"
                  aria-label="New tab"
                  className={`side-panel-header__action${isNewTabMenuOpen ? ' side-panel-header__action--on' : ''}`}
                  onClick={() => setIsNewTabMenuOpen((v) => !v)}
                  title="New tab"
                >
                  <PlusGlyph />
                </button>

                <DockNewTabMenu
                  isOpen={isNewTabMenuOpen}
                  onClose={() => setIsNewTabMenuOpen(false)}
                  highlightedMenuId={highlightedMenuId}
                  setHighlightedMenuId={setHighlightedMenuId}
                  onOpenStandardTab={handleOpenStandardTab}
                  onOpenAppTab={handleOpenAppTab}
                  sidecars={uiSidecars}
                  onOpenSidecarTab={handleOpenSidecarTab}
                  mcpAppEntrypoints={mcpAppEntrypoints}
                  onOpenMcpAppTab={handleOpenMcpAppTab}
                />
              </div>

              {/* Fullscreen Action */}
              <button
                type="button"
                aria-label={isFullScreen ? 'Exit full screen' : 'Full screen'}
                aria-pressed={isFullScreen}
                className={`side-panel-header__action${isFullScreen ? ' side-panel-header__action--on' : ''}`}
                onClick={() => setIsFullScreen((v) => !v)}
                title={isFullScreen ? 'Exit full screen' : 'Full screen'}
              >
                {isFullScreen ? <Minimize2Glyph /> : <Maximize2Glyph />}
              </button>
            </div>

            {/* Side Panel Content Page */}
            <div className="app-browser-sidebar__page">
              {activeTab && (
                <ErrorBoundary name={`RightDockView:${activeTab.kind}`}>
                  {activeTab.kind === 'dashboard' && <AgentDashboardView onStartAgent={onStartAgent} />}
                  {activeTab.kind === 'browser' && (
                    <BrowserView workspaceId={effectiveWorkspaceId} isOccluded={isOccluded || dragging} />
                  )}
                  {activeTab.kind === 'files' && (
                    <React.Suspense fallback={null}>
                      <FilesView
                        workspaceId={effectiveWorkspaceId}
                        workspaces={workspaces}
                        onSelectWorkspace={onSelectWorkspace}
                      />
                    </React.Suspense>
                  )}
                  {activeTab.kind === 'diffs' && (
                    <React.Suspense fallback={null}>
                      <DiffsView
                        workspaceId={effectiveWorkspaceId}
                        workspaces={workspaces}
                        onSelectWorkspace={onSelectWorkspace}
                        onOpenFileInEditor={(filePath) => {
                          setTabs((prev) => {
                            if (!prev.some((t) => t.id === 'files')) {
                              return [...prev, { id: 'files', kind: 'files' }];
                            }
                            return prev;
                          });
                          setActiveTabId('files');
                          openFileInRightDock({
                            candidate: filePath,
                            workspaceId: effectiveWorkspaceId,
                          });
                        }}
                      />
                    </React.Suspense>
                  )}
                  {activeTab.kind === 'tasks' && (
                    <div className="app-browser-sidebar__tasks">
                      <TicketsView workspaces={workspaces} selectedWorkspaceId={effectiveWorkspaceId} />
                    </div>
                  )}
                  {activeTab.kind === 'prompts' && (
                    <div className="app-browser-sidebar__prompts">
                      <PromptsView />
                    </div>
                  )}
                  {activeTab.kind === 'subagents' && (
                    <SubagentInspectorView
                      workspaceId={effectiveWorkspaceId}
                      selectedThreadId={selectedThreadId}
                      requestedTarget={requestedSubagentTarget}
                      onClearTarget={() => setRequestedSubagentTarget(null)}
                    />
                  )}
                  {activeTab.kind === 'voice-transcript' && (
                    <VoiceTranscriptPane
                      callId={requestedVoiceCallId}
                      threadId={requestedVoiceThreadId ?? selectedThreadId}
                    />
                  )}
                  {activeTab.kind === 'app' && (
                    <SidePanelAppsView
                      app={activeTab.appId ?? undefined}
                      title={activeTab.appId ? resolveTabDef(activeTab).label : undefined}
                    />
                  )}
                  {activeTab.kind === 'sidecar' && activeTab.sidecarId && (
                    <SidecarPanelView
                      key={activeTab.id}
                      sidecarId={activeTab.sidecarId}
                      viewPath={activeTab.viewPath ?? undefined}
                      title={activeTab.title ?? undefined}
                      workspaceId={effectiveWorkspaceId}
                      isResizing={dragging}
                    />
                  )}
                  {activeTab.kind === 'mcp-app' &&
                    (activeTab.mcpAppSpec ? (
                      <McpAppFrame
                        key={activeTab.id}
                        serverName={activeTab.mcpAppSpec.serverName}
                        resourceUri={activeTab.mcpAppSpec.resourceUri}
                        toolName={activeTab.mcpAppSpec.toolName}
                        title={
                          activeTab.title ||
                          activeTab.mcpAppSpec.title ||
                          activeTab.mcpAppSpec.toolName
                        }
                        mode="dock"
                        workspaceId={effectiveWorkspaceId}
                        isResizing={dragging}
                      />
                    ) : (
                      <div className="ui-status-notice">
                        <div className="ui-status-notice__copy">
                          <p className="ui-status-notice__title">
                            {activeTab.title || 'MCP App'}
                          </p>
                          <p className="ui-status-notice__message">
                            MCP App view is not configured for this tab.
                          </p>
                        </div>
                      </div>
                    ))}
                </ErrorBoundary>
              )}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
};

export const RightDock = React.memo(RightDockInner);
