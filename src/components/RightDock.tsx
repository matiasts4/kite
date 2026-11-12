import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { BrowserView } from './views/BrowserView';
import { closeBrowserSurfaceSession, getBrowserSurfaceSession } from './views/browser/browserSurfaceRegistry';
import { OPEN_RIGHT_DOCK_BROWSER_EVENT } from '../lib/terminalLinkNav';
import {
  OPEN_DIFFS_EVENT,
  OPEN_RIGHT_DOCK_DIFFS_EVENT,
  peekPendingDiffPreview,
} from '../lib/diffPreviewNav';
import { openFileInRightDock } from '../lib/filePreviewNav';
import { FilesView } from './views/FilesView';
import { DiffsView } from './views/diffs/DiffsView';
import { TicketsView } from './views/TicketsView';
import { PromptsView } from './views/PromptsView';
import { SidePanelAppsView } from './views/SidePanelAppsView';
import { AgentDashboardView } from './views/apps/AgentDashboardView';
import { SubagentInspectorView } from './views/subagents/SubagentInspectorView';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { getActiveAgentTerminals } from '../lib/terminalRegistry';
import {
  OPEN_RIGHT_DOCK_SUBAGENT_EVENT,
  consumePendingSubagentRequest,
  type OpenRightDockSubagentDetail,
} from '../lib/subagentNav';
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

export const RightDock: React.FC<RightDockProps> = ({
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
  const [panelWidth, setPanelWidth] = useState<number>(() => loadInitialWidth());
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(panelWidth);
  widthRef.current = panelWidth;

  const [isFullScreen, setIsFullScreen] = useState(false);
  const [isNewTabMenuOpen, setIsNewTabMenuOpen] = useState(false);
  const [highlightedMenuId, setHighlightedMenuId] = useState<string | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);

  const effectiveWorkspaceId = useMemo(() => {
    if (workspaceId) return workspaceId;
    const saved = typeof window !== 'undefined' ? localStorage.getItem('kite.selectedWorkspaceId') : null;
    if (saved && workspaces?.some((w) => w.id === saved)) return saved;
    return workspaces?.[0]?.id ?? null;
  }, [workspaceId, workspaces]);

  useEffect(() => {
    if (!workspaceId && effectiveWorkspaceId && onSelectWorkspace) {
      onSelectWorkspace(effectiveWorkspaceId);
    }
  }, [workspaceId, effectiveWorkspaceId, onSelectWorkspace]);

  const allMenuItems = useMemo(
    () => [
      ...STANDARD_MENU_TABS.map((t) => ({ id: `std-${t.kind}`, kind: t.kind, type: 'standard' as const })),
      ...APP_MENU_TABS.map((t) => ({ id: `app-${t.appId}`, appId: t.appId, type: 'app' as const })),
    ],
    []
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
    const update = () => {
      const active = getActiveAgentTerminals();
      setActiveAgentsCount(active.length);
    };
    window.addEventListener('kite:terminal-agent-update', update);
    const interval = window.setInterval(update, 2000);
    return () => {
      window.removeEventListener('kite:terminal-agent-update', update);
      window.clearInterval(interval);
    };
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
    window.addEventListener('kite:open-right-dock-file', handleOpenFile);
    return () => window.removeEventListener('kite:open-right-dock-file', handleOpenFile);
  }, []);

  // Listen for open-right-dock-browser event to switch to or open the browser tab and load URL
  useEffect(() => {
    const handleOpenBrowser = (e: Event) => {
      const custom = e as CustomEvent<{ url?: string; workspaceId?: string | null }>;
      setTabs((prev) => {
        if (!prev.some((t) => t.id === 'browser')) {
          return [...prev, { id: 'browser', kind: 'browser' }];
        }
        return prev;
      });
      setActiveTabId('browser');

      if (custom.detail?.url) {
        const session = getBrowserSurfaceSession(effectiveWorkspaceId);
        void session.openAddress(custom.detail.url);
      }
    };
    window.addEventListener(OPEN_RIGHT_DOCK_BROWSER_EVENT, handleOpenBrowser);
    return () => window.removeEventListener(OPEN_RIGHT_DOCK_BROWSER_EVENT, handleOpenBrowser);
  }, [effectiveWorkspaceId]);

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
    const handleOpenDiffsEvent = () => {
      setTabs((prev) => {
        if (!prev.some((t) => t.id === 'diffs')) {
          return [...prev, { id: 'diffs', kind: 'diffs' }];
        }
        return prev;
      });
      setActiveTabId('diffs');
    };
    const handleSubagentCount = (e: Event) => {
      const custom = e as CustomEvent<{ count?: number }>;
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
    window.addEventListener('kite:open-diffs', handleOpenDiffsEvent);
    window.addEventListener(OPEN_RIGHT_DOCK_SUBAGENT_EVENT, handleOpenSubagent);
    window.addEventListener('kite:subagent-activity-count', handleSubagentCount);
    return () => {
      window.removeEventListener('keydown', handleGlobalShortcuts);
      window.removeEventListener('kite:open-diffs', handleOpenDiffsEvent);
      window.removeEventListener(OPEN_RIGHT_DOCK_SUBAGENT_EVENT, handleOpenSubagent);
      window.removeEventListener('kite:subagent-activity-count', handleSubagentCount);
    };

    function handleOpenSubagent(e: Event) {
      handleOpenSubagents(e);
    }
  }, []);

  // Sync live subagents running count for the active thread in Tauri sessions
  const trackedSubagentThreadId = requestedSubagentTarget?.threadId ?? selectedThreadId;
  useEffect(() => {
    if (
      activeSubagentsCount !== undefined ||
      !trackedSubagentThreadId ||
      typeof window === 'undefined' ||
      !('__TAURI_INTERNALS__' in window)
    ) {
      return;
    }
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
  useEffect(() => {
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
    // Closing the browser tab tears down the native WebView2 surface.
    if (tabId === 'browser') void closeBrowserSurfaceSession(workspaceId);
  };

  const handleOpenStandardTab = (kind: 'browser' | 'files' | 'diffs' | 'tasks' | 'prompts' | 'subagents') => {
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
          else handleOpenAppTab(found.appId);
        }
      }
    };
    window.addEventListener('keydown', handleMenuKeyDown);
    return () => window.removeEventListener('keydown', handleMenuKeyDown);
  }, [isNewTabMenuOpen, allMenuItems, highlightedMenuId]);

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
      const next = Math.min(Math.max(320, startWidth - (ev.clientX - startX)), Math.round(window.innerWidth * 0.72));
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
          style={{ '--app-browser-width': `${panelWidth}px`, width: panelWidth, minWidth: panelWidth, flex: 'none' } as React.CSSProperties}
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
            style={isFullScreen ? undefined : ({ '--app-browser-width': `${panelWidth}px`, width: panelWidth, minWidth: panelWidth, flex: 'none' } as React.CSSProperties)}
          >
            {!isFullScreen && (
              <hr
                className="app-browser-sidebar__grip"
                aria-label="Resize side panel"
                aria-orientation="vertical"
                aria-valuemin={320}
                aria-valuemax={Math.round(window.innerWidth * 0.72)}
                aria-valuenow={panelWidth}
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
                          <span className="side-panel-tab__count">
                            {activeSubagentsCount ?? liveSubagentsCount}
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
                    <FilesView
                      workspaceId={effectiveWorkspaceId}
                      workspaces={workspaces}
                      onSelectWorkspace={onSelectWorkspace}
                    />
                  )}
                  {activeTab.kind === 'diffs' && (
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
                    />
                  )}
                  {activeTab.kind === 'app' && (
                    <SidePanelAppsView
                      app={activeTab.appId ?? undefined}
                      title={activeTab.appId ? resolveTabDef(activeTab).label : undefined}
                    />
                  )}
                </ErrorBoundary>
              )}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
};
