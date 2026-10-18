import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { BrowserView } from './views/BrowserView';
import { closeBrowserSurfaceSession } from './views/browser/browserSurfaceRegistry';
import { FilesView } from './views/FilesView';
import { DiffsView } from './views/diffs/DiffsView';
import { TicketsView } from './views/TicketsView';
import { PromptsView } from './views/PromptsView';
import { SidePanelAppsView } from './views/SidePanelAppsView';
import { AgentDashboardView } from './views/apps/AgentDashboardView';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { getActiveAgentTerminals } from '../lib/terminalRegistry';
import type { Workspace } from '../types';
import {
  LayoutGridGlyph,
  GlobeGlyph,
  FolderGlyph,
  GitDiffGlyph,
  ListTodoGlyph,
  MessageSquareQuoteGlyph,
  CloseGlyph,
  PlusGlyph,
  Maximize2Glyph,
  Minimize2Glyph,
  SparklesGlyph,
  TimerGlyph,
  NotebookPenGlyph,
  FlameGlyph,
} from './dockIcons';

export type SidePanelAppId = 'focusTimer' | 'scratchpad' | 'bombSprint' | 'bridgeVerse';

export type RightDockTabKind =
  | 'dashboard'
  | 'browser'
  | 'files'
  | 'diffs'
  | 'tasks'
  | 'prompts'
  | 'app';

export type RightDockTab = RightDockTabKind;

export interface DockTabItem {
  id: string;
  kind: RightDockTabKind;
  appId?: SidePanelAppId | null;
  url?: string | null;
}

export interface RightDockProps {
  visible: boolean;
  onClose: () => void;
  workspaceId: string | null;
  isOccluded?: boolean;
  workspaces?: Workspace[];
  onSelectWorkspace?: (id: string) => void;
  onStartAgent?: () => void;
}

/* ==========================================================================
   Constants & Storage
   ========================================================================== */

const STORAGE_KEY_TABS = 'kite-code.side-panel.tabs.v1';
const STORAGE_KEY_BROWSER = 'kite-code.app-browser.v1';

const DEFAULT_TABS: DockTabItem[] = [
  { id: 'dashboard', kind: 'dashboard' },
  { id: 'tasks', kind: 'tasks' },
  { id: 'prompts', kind: 'prompts' },
];

interface StoredTabsPayload {
  schemaVersion: number;
  tabs: Array<{
    id: string;
    kind: RightDockTabKind;
    appId?: SidePanelAppId | null;
    url?: string | null;
  }>;
  selectedId?: string;
}

function loadInitialTabs(): { tabs: DockTabItem[]; activeTabId: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_TABS);
    if (raw) {
      const parsed: StoredTabsPayload = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
        const validTabs: DockTabItem[] = [];
        const seenIds = new Set<string>();

        for (const item of parsed.tabs) {
          if (!item || typeof item.id !== 'string' || seenIds.has(item.id)) continue;
          if (['dashboard', 'browser', 'files', 'diffs', 'tasks', 'prompts', 'app'].includes(item.kind)) {
            seenIds.add(item.id);
            validTabs.push({
              id: item.id,
              kind: item.kind,
              appId: item.appId || null,
              url: item.url || null,
            });
          }
        }

        // Pinned tabs: dashboard, tasks, prompts must be present
        if (!validTabs.some((t) => t.kind === 'dashboard')) {
          validTabs.unshift({ id: 'dashboard', kind: 'dashboard' });
        }
        if (!validTabs.some((t) => t.kind === 'tasks')) {
          const dashIdx = validTabs.findIndex((t) => t.kind === 'dashboard');
          validTabs.splice(dashIdx + 1, 0, { id: 'tasks', kind: 'tasks' });
        }
        if (!validTabs.some((t) => t.kind === 'prompts')) {
          const tasksIdx = validTabs.findIndex((t) => t.kind === 'tasks');
          validTabs.splice(tasksIdx + 1, 0, { id: 'prompts', kind: 'prompts' });
        }

        const activeId =
          parsed.selectedId && validTabs.some((t) => t.id === parsed.selectedId)
            ? parsed.selectedId
            : validTabs[0].id;

        return { tabs: validTabs, activeTabId: activeId };
      }
    }
  } catch {}

  return { tabs: DEFAULT_TABS, activeTabId: 'tasks' };
}

function loadInitialWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_BROWSER);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.width === 'number' && Number.isFinite(parsed.width)) {
        return Math.round(Math.max(320, Math.min(parsed.width, window.innerWidth * 0.72)));
      }
    }
  } catch {}
  return 440;
}

function persistWidth(width: number) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_BROWSER);
    const parsed = raw ? JSON.parse(raw) : {};
    localStorage.setItem(STORAGE_KEY_BROWSER, JSON.stringify({ ...parsed, width }));
  } catch {}
}

/* ==========================================================================
   Tab Reordering & Midpoint Slot Algorithms (Ye, $e, Xe, et from bundle)
   ========================================================================== */

interface TabBox {
  left: number;
  width: number;
}

const TAB_GAP = 2;
const RUBBER_COEFF = 0.6;

function rubberBand(offset: number, max: number, factor = 0.55): number {
  return max <= 0 ? 0 : (offset * max * factor) / (max + factor * Math.abs(offset));
}

/** Midpoint slot tracking: Ye(boxes, from, midX) */
function calculateSlot(boxes: TabBox[], from: number, midX: number): number {
  let slot = 0;
  boxes.forEach((box, i) => {
    if (i !== from && midX > box.left + box.width / 2) slot += 1;
  });
  return slot;
}

/** Offset shifts for non-carried tabs: Xe(boxes, from, slot, gap) */
function calculateTabShifts(boxes: TabBox[], from: number, slot: number, gap: number): number[] {
  const carried = boxes[from];
  if (!carried) return boxes.map(() => 0);
  const stride = carried.width + gap;
  return boxes.map((_, i) => {
    if (i === from) return 0;
    if (slot > from && i > from && i <= slot) return -stride;
    if (slot < from && i >= slot && i < from) return stride;
    return 0;
  });
}

/** Clamped / rubberbanded drag offset: $e(boxes, from, dx) */
function clampDragOffset(boxes: TabBox[], from: number, dx: number): number {
  const current = boxes[from];
  const first = boxes[0];
  const last = boxes[boxes.length - 1];
  if (!Number.isFinite(dx)) return 0;
  if (!current || !first || !last) return dx;

  const minOffset = first.left - current.left;
  const maxOffset = last.left + last.width - (current.left + current.width);
  const slack = current.width * RUBBER_COEFF;

  if (dx < minOffset) return minOffset + rubberBand(dx - minOffset, slack);
  if (dx > maxOffset) return maxOffset + rubberBand(dx - maxOffset, slack);
  return dx;
}

/** Target slot left position: et(boxes, from, slot) */
function calculateSlotLeft(boxes: TabBox[], from: number, slot: number): number {
  const r = boxes[from];
  const target = boxes[slot];
  if (!r || !target) return r?.left ?? 0;
  return slot > from ? target.left + target.width - r.width : target.left;
}

/** Keyboard index navigation: rt(key, index, total) */
function getKeyboardNextIndex(key: string, index: number, total: number): number | null {
  if (total === 0) return null;
  switch (key) {
    case 'ArrowLeft': return (index - 1 + total) % total;
    case 'ArrowRight': return (index + 1) % total;
    case 'Home': return 0;
    case 'End': return total - 1;
    default: return null;
  }
}

/* ==========================================================================
   Pointer Drag Hook (from usePointerDrag)
   ========================================================================== */

function setPointerDraggingState(dragging: boolean) {
  const doc = globalThis.document?.documentElement;
  if (!doc) return;
  if (dragging) {
    doc.dataset.pointerDragging = 'true';
    globalThis.getSelection?.()?.removeAllRanges();
  } else {
    delete doc.dataset.pointerDragging;
  }
}

interface PointerDragOptions {
  enabled?: boolean;
  threshold?: number;
  ignoreSelector?: string;
  onStart: (pos: { clientX: number; clientY: number }) => void;
  onMove?: (pos: { clientX: number; clientY: number }) => void;
  onEnd: (pos: { clientX: number; clientY: number }) => void;
  onCancel?: () => void;
}

function usePointerDrag(options: PointerDragOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const activePointerRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    started: boolean;
  } | null>(null);

  const cleanupRef = useRef<(() => void) | null>(null);

  const cleanup = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (activePointerRef.current?.started) setPointerDraggingState(false);
    activePointerRef.current = null;
  }, []);

  useEffect(() => {
    if (options.enabled) return;
    const current = activePointerRef.current;
    cleanup();
    if (current?.started) optionsRef.current.onCancel?.();
  }, [cleanup, options.enabled]);

  useEffect(() => () => {
    const current = activePointerRef.current;
    cleanup();
    if (current?.started) optionsRef.current.onCancel?.();
  }, [cleanup]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const opts = optionsRef.current;
    if (!opts.enabled || e.button !== 0 || !e.isPrimary || activePointerRef.current !== null) return;
    const target = e.target;
    if (opts.ignoreSelector && target instanceof Element && target.closest(opts.ignoreSelector) !== null) return;

    const state = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, started: false };
    activePointerRef.current = state;
    const threshold = opts.threshold ?? 6;
    const getPos = (ev: PointerEvent) => ({ clientX: ev.clientX, clientY: ev.clientY });

    const handlePointerMove = (ev: PointerEvent) => {
      if (ev.pointerId !== state.pointerId) return;
      if (!state.started) {
        if (Math.hypot(ev.clientX - state.startX, ev.clientY - state.startY) < threshold) return;
        state.started = true;
        setPointerDraggingState(true);
        optionsRef.current.onStart(getPos(ev));
      }
      optionsRef.current.onMove?.(getPos(ev));
    };

    const handlePointerUp = (ev: PointerEvent) => {
      if (ev.pointerId !== state.pointerId) return;
      const started = state.started;
      cleanup();
      if (started) optionsRef.current.onEnd(getPos(ev));
    };

    const handleCancel = () => {
      const started = state.started;
      cleanup();
      if (started) optionsRef.current.onCancel?.();
    };

    const handlePointerCancel = (ev: PointerEvent) => {
      if (ev.pointerId === state.pointerId) handleCancel();
    };

    const handleKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') handleCancel();
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    window.addEventListener('blur', handleCancel);
    window.addEventListener('keydown', handleKeyDown);

    cleanupRef.current = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
      window.removeEventListener('blur', handleCancel);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [cleanup]);

  return { onPointerDown };
}

/* ==========================================================================
   Tab Configurations & Resolution
   ========================================================================== */

interface TabResolvedDef {
  label: string;
  tooltip: string;
  closable: boolean;
  renderIcon: () => React.ReactElement;
}

const TAB_CONFIGS: Record<string, TabResolvedDef> = {
  dashboard: { label: 'Dashboard', tooltip: 'Dashboard', closable: false, renderIcon: () => <LayoutGridGlyph /> },
  browser: { label: 'Browser', tooltip: 'Browser', closable: true, renderIcon: () => <GlobeGlyph /> },
  files: { label: 'Files', tooltip: 'Files', closable: true, renderIcon: () => <FolderGlyph /> },
  diffs: { label: 'Diffs', tooltip: 'Diffs & Changes', closable: true, renderIcon: () => <GitDiffGlyph /> },
  tasks: { label: 'Tasks', tooltip: 'Tasks', closable: false, renderIcon: () => <ListTodoGlyph /> },
  prompts: { label: 'Prompts', tooltip: 'Prompts', closable: false, renderIcon: () => <MessageSquareQuoteGlyph /> },
  'app:focusTimer': { label: 'Focus timer', tooltip: 'Focus timer', closable: true, renderIcon: () => <TimerGlyph /> },
  'app:scratchpad': { label: 'Scratchpad', tooltip: 'Scratchpad', closable: true, renderIcon: () => <NotebookPenGlyph /> },
  'app:bombSprint': { label: 'Bomb Sprint', tooltip: 'Bomb Sprint', closable: true, renderIcon: () => <FlameGlyph /> },
  'app:bridgeVerse': { label: 'KiteVerse', tooltip: 'KiteVerse', closable: true, renderIcon: () => <SparklesGlyph /> },
};

function resolveTabDef(tab: DockTabItem): TabResolvedDef {
  const key = tab.kind === 'app' ? `app:${tab.appId}` : tab.kind;
  return TAB_CONFIGS[key] || { label: 'App', tooltip: 'App', closable: true, renderIcon: () => <SparklesGlyph /> };
}

const STANDARD_MENU_TABS = [
  { kind: 'browser' as const, label: 'Browser', icon: <GlobeGlyph /> },
  { kind: 'files' as const, label: 'Files', icon: <FolderGlyph />, shortcut: 'Ctrl+Alt+F' },
  { kind: 'diffs' as const, label: 'Diffs', icon: <GitDiffGlyph />, shortcut: 'Ctrl+Alt+D' },
  { kind: 'tasks' as const, label: 'Tasks', icon: <ListTodoGlyph /> },
  { kind: 'prompts' as const, label: 'Prompts', icon: <MessageSquareQuoteGlyph /> },
];

const APP_MENU_TABS: Array<{ appId: SidePanelAppId; label: string; icon: React.ReactElement }> = [
  { appId: 'focusTimer', label: 'Focus timer', icon: <TimerGlyph /> },
  { appId: 'scratchpad', label: 'Scratchpad', icon: <NotebookPenGlyph /> },
  { appId: 'bombSprint', label: 'Bomb Sprint', icon: <FlameGlyph /> },
  { appId: 'bridgeVerse', label: 'KiteVerse', icon: <SparklesGlyph /> },
];

/* ==========================================================================
   Main RightDock Component
   ========================================================================== */

export const RightDock: React.FC<RightDockProps> = ({
  visible,
  workspaceId,
  isOccluded = false,
  workspaces = [],
  onSelectWorkspace,
  onStartAgent,
}) => {
  const [initial] = useState(() => loadInitialTabs());
  const [tabs, setTabs] = useState<DockTabItem[]>(initial.tabs);
  const [activeTabId, setActiveTabId] = useState<string>(initial.activeTabId);
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
    const saved = typeof window !== 'undefined' ? localStorage.getItem('bmone.selectedWorkspaceId') : null;
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
    window.addEventListener('kite:open-right-dock-diffs', handleOpenDiffs);
    return () => window.removeEventListener('kite:open-right-dock-diffs', handleOpenDiffs);
  }, []);

  // Shortcut Ctrl+Alt+D to open or focus diffs tab
  useEffect(() => {
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
      }
    };
    window.addEventListener('keydown', handleGlobalShortcuts);
    return () => window.removeEventListener('keydown', handleGlobalShortcuts);
  }, []);

  // Persistence for tabs & active tab
  useEffect(() => {
    try {
      const payload: StoredTabsPayload = {
        schemaVersion: 4,
        tabs: tabs.map((t) => ({ id: t.id, kind: t.kind, appId: t.appId ?? null, url: t.url ?? null })),
        selectedId: activeTabId,
      };
      localStorage.setItem(STORAGE_KEY_TABS, JSON.stringify(payload));
    } catch {}
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

  const handleOpenStandardTab = (kind: 'browser' | 'files' | 'diffs' | 'tasks' | 'prompts') => {
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
    // Delete closes closable tab
    if (e.key === 'Delete' && tabDef.closable && !e.altKey) {
      e.preventDefault();
      handleCloseTab(tab.id);
      return;
    }

    // ArrowLeft / ArrowRight / Home / End navigation
    if (!e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      const targetIdx = getKeyboardNextIndex(e.key, index, tabs.length);
      if (targetIdx === null) return;
      e.preventDefault();
      const targetTab = tabs[targetIdx];
      if (targetTab) tabButtonRefs.current.get(targetTab.id)?.focus();
      return;
    }

    // Alt+Shift+ArrowLeft / ArrowRight reordering
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

  if (!visible) return null;

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];

  return (
    <>
      {dragging && (
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
      {isFullScreen && (
        <div
          aria-hidden="true"
          className="app-browser-sidebar__spacer"
          style={{ '--app-browser-width': `${panelWidth}px`, width: panelWidth, minWidth: panelWidth, flex: 'none' } as React.CSSProperties}
        />
      )}
      <aside
        ref={asideRef}
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

          {isNewTabMenuOpen && (
            <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 59 }}
                onClick={() => setIsNewTabMenuOpen(false)}
              />
              <div
                role="menu"
                aria-label="New tab"
                className="ui-menu side-panel-add-menu scroll-quiet"
                onMouseLeave={() => setHighlightedMenuId(null)}
                style={{
                  position: 'absolute',
                  top: 'calc(var(--pane-header-height, 36px) + 2px)',
                  right: 0,
                  zIndex: 60,
                }}
              >
                <div className="ui-menu__header" role="presentation">
                  <span className="ui-menu__title">New tab</span>
                </div>
                <div aria-hidden="true" className="ui-menu__rule" />

                {STANDARD_MENU_TABS.map((item) => {
                  const id = `std-${item.kind}`;
                  const isHighlighted = highlightedMenuId === id;
                  return (
                    <div
                      key={item.kind}
                      role="menuitem"
                      tabIndex={-1}
                      className="ui-menu__row"
                      data-highlighted={isHighlighted ? 'true' : undefined}
                      onMouseEnter={() => setHighlightedMenuId(id)}
                      onClick={() => handleOpenStandardTab(item.kind)}
                    >
                      <span aria-hidden="true" className="ui-menu__icon">
                        {item.icon}
                      </span>
                      <span className="ui-menu__label">
                        <span className="ui-menu__row-title">{item.label}</span>
                      </span>
                      {item.shortcut && (
                        <span aria-hidden="true" className="ui-menu__shortcut">
                          {item.shortcut}
                        </span>
                      )}
                    </div>
                  );
                })}

                <div aria-hidden="true" className="ui-menu__rule" />
                <div className="ui-menu__heading" role="presentation">
                  Apps
                </div>

                {APP_MENU_TABS.map((item) => {
                  const id = `app-${item.appId}`;
                  const isHighlighted = highlightedMenuId === id;
                  return (
                    <div
                      key={item.appId}
                      role="menuitem"
                      tabIndex={-1}
                      className="ui-menu__row"
                      data-highlighted={isHighlighted ? 'true' : undefined}
                      onMouseEnter={() => setHighlightedMenuId(id)}
                      onClick={() => handleOpenAppTab(item.appId)}
                    >
                      <span aria-hidden="true" className="ui-menu__icon">
                        {item.icon}
                      </span>
                      <span className="ui-menu__label">
                        <span className="ui-menu__row-title">{item.label}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
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
                  window.dispatchEvent(
                    new CustomEvent('kite:open-right-dock-file', {
                      detail: { filePath, workspaceId: effectiveWorkspaceId },
                    })
                  );
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
            {activeTab.kind === 'app' && (
              <SidePanelAppsView
                app={activeTab.appId ?? undefined}
                title={activeTab.appId ? resolveTabDef(activeTab).label : undefined}
              />
            )}
          </ErrorBoundary>
        )}
      </div>
    </aside>
  </>
  );
};
