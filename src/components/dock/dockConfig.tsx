import React from 'react';
import {
  LayoutGridGlyph,
  GlobeGlyph,
  FolderGlyph,
  GitDiffGlyph,
  ListTodoGlyph,
  MessageSquareQuoteGlyph,
  SparklesGlyph,
  TimerGlyph,
  NotebookPenGlyph,
  FlameGlyph,
  SubagentsGlyph,
} from '../dockIcons';

export type SidePanelAppId = 'focusTimer' | 'scratchpad' | 'bombSprint' | 'kiteVerse';

export type RightDockTabKind =
  | 'dashboard'
  | 'browser'
  | 'files'
  | 'diffs'
  | 'tasks'
  | 'prompts'
  | 'subagents'
  | 'app';

export interface DockTabItem {
  id: string;
  kind: RightDockTabKind;
  appId?: SidePanelAppId | null;
  url?: string | null;
}

export const STORAGE_KEY_TABS = 'kite-code.side-panel.tabs.v1';
export const STORAGE_KEY_BROWSER = 'kite-code.app-browser.v1';

export const DEFAULT_TABS: DockTabItem[] = [
  { id: 'dashboard', kind: 'dashboard' },
];

export interface StoredTabsPayload {
  schemaVersion: number;
  tabs: Array<{
    id: string;
    kind: RightDockTabKind;
    appId?: SidePanelAppId | null;
    url?: string | null;
  }>;
  selectedId?: string;
}

export function loadInitialTabs(): { tabs: DockTabItem[]; activeTabId: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_TABS);
    if (raw) {
      const parsed: StoredTabsPayload = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
        const validTabs: DockTabItem[] = [];
        const seenIds = new Set<string>();

        for (const item of parsed.tabs) {
          if (!item || typeof item.id !== 'string' || seenIds.has(item.id)) continue;
          if (['dashboard', 'browser', 'files', 'diffs', 'tasks', 'prompts', 'subagents', 'app'].includes(item.kind)) {
            seenIds.add(item.id);
            validTabs.push({
              id: item.id,
              kind: item.kind,
              appId: item.appId ?? null,
              url: item.url ?? null,
            });
          }
        }

        // Pinned anchor: dashboard must be present
        if (!validTabs.some((t) => t.kind === 'dashboard')) {
          validTabs.unshift({ id: 'dashboard', kind: 'dashboard' });
        }

        if (validTabs.length > 0) {
          const selected = parsed.selectedId && validTabs.some((t) => t.id === parsed.selectedId)
            ? parsed.selectedId
            : validTabs[0].id;
          return { tabs: validTabs, activeTabId: selected };
        }
      }
    }
  } catch {}
  return { tabs: DEFAULT_TABS, activeTabId: 'dashboard' };
}

export function persistTabs(tabs: DockTabItem[], selectedId: string) {
  try {
    const payload: StoredTabsPayload = {
      schemaVersion: 4,
      tabs: tabs.map((t) => ({ id: t.id, kind: t.kind, appId: t.appId ?? null, url: t.url ?? null })),
      selectedId,
    };
    localStorage.setItem(STORAGE_KEY_TABS, JSON.stringify(payload));
  } catch {}
}

export function loadInitialWidth(): number {
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

export function persistWidth(width: number) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_BROWSER);
    const parsed = raw ? JSON.parse(raw) : {};
    localStorage.setItem(STORAGE_KEY_BROWSER, JSON.stringify({ ...parsed, width }));
  } catch {}
}

export interface TabResolvedDef {
  label: string;
  tooltip: string;
  closable: boolean;
  renderIcon: () => React.ReactElement;
}

export const TAB_CONFIGS: Record<string, TabResolvedDef> = {
  dashboard: { label: 'Dashboard', tooltip: 'Dashboard', closable: false, renderIcon: () => <LayoutGridGlyph /> },
  browser: { label: 'Browser', tooltip: 'Browser', closable: true, renderIcon: () => <GlobeGlyph /> },
  files: { label: 'Files', tooltip: 'Files', closable: true, renderIcon: () => <FolderGlyph /> },
  diffs: { label: 'Diffs', tooltip: 'Diffs & Changes', closable: true, renderIcon: () => <GitDiffGlyph /> },
  tasks: { label: 'Tasks', tooltip: 'Tasks', closable: true, renderIcon: () => <ListTodoGlyph /> },
  prompts: { label: 'Prompts', tooltip: 'Prompts', closable: true, renderIcon: () => <MessageSquareQuoteGlyph /> },
  subagents: {
    label: 'Subagents',
    tooltip: 'Subagents & Swarm (Ctrl+Alt+S)',
    closable: true,
    renderIcon: () => <SubagentsGlyph />,
  },
  'app:focusTimer': { label: 'Focus timer', tooltip: 'Focus timer', closable: true, renderIcon: () => <TimerGlyph /> },
  'app:scratchpad': { label: 'Scratchpad', tooltip: 'Scratchpad', closable: true, renderIcon: () => <NotebookPenGlyph /> },
  'app:bombSprint': { label: 'Bomb Sprint', tooltip: 'Bomb Sprint', closable: true, renderIcon: () => <FlameGlyph /> },
  'app:kiteVerse': { label: 'KiteVerse', tooltip: 'KiteVerse', closable: true, renderIcon: () => <SparklesGlyph /> },
};

export function resolveTabDef(tab: DockTabItem): TabResolvedDef {
  const key = tab.kind === 'app' ? `app:${tab.appId}` : tab.kind;
  return TAB_CONFIGS[key] || { label: 'App', tooltip: 'App', closable: true, renderIcon: () => <SparklesGlyph /> };
}

export const STANDARD_MENU_TABS = [
  { kind: 'browser' as const, label: 'Browser', icon: <GlobeGlyph /> },
  { kind: 'files' as const, label: 'Files', icon: <FolderGlyph />, shortcut: 'Ctrl+Alt+F' },
  { kind: 'diffs' as const, label: 'Diffs', icon: <GitDiffGlyph />, shortcut: 'Ctrl+Alt+D' },
  { kind: 'tasks' as const, label: 'Tasks', icon: <ListTodoGlyph /> },
  { kind: 'prompts' as const, label: 'Prompts', icon: <MessageSquareQuoteGlyph /> },
  { kind: 'subagents' as const, label: 'Subagents', icon: <SubagentsGlyph />, shortcut: 'Ctrl+Alt+S' },
];

export const APP_MENU_TABS: Array<{ appId: SidePanelAppId; label: string; icon: React.ReactElement }> = [
  { appId: 'focusTimer', label: 'Focus timer', icon: <TimerGlyph /> },
  { appId: 'scratchpad', label: 'Scratchpad', icon: <NotebookPenGlyph /> },
  { appId: 'bombSprint', label: 'Bomb Sprint', icon: <FlameGlyph /> },
  { appId: 'kiteVerse', label: 'KiteVerse', icon: <SparklesGlyph /> },
];
