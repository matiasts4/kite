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
import { PuzzleIcon } from '../views/plugins/pluginIcons';

export type SidePanelAppId = 'focusTimer' | 'scratchpad' | 'bombSprint' | 'kiteVerse';

export type RightDockTabKind =
  | 'dashboard'
  | 'browser'
  | 'files'
  | 'diffs'
  | 'tasks'
  | 'prompts'
  | 'subagents'
  | 'voice-transcript'
  | 'app'
  | 'sidecar'
  | 'mcp-app';

export interface McpAppTabSpec {
  serverName: string;
  toolName: string;
  resourceUri: string;
  title?: string;
}

export interface DockTabItem {
  id: string;
  kind: RightDockTabKind;
  appId?: SidePanelAppId | null;
  url?: string | null;
  sidecarId?: string | null;
  viewPath?: string | null;
  title?: string | null;
  mcpAppSpec?: McpAppTabSpec | null;
}

export const STORAGE_KEY_TABS = 'kite-code.side-panel.tabs.v1';
export const STORAGE_KEY_BROWSER = 'kite-code.app-browser.v1';

export const DEFAULT_TABS: DockTabItem[] = [
  { id: 'dashboard', kind: 'dashboard' },
];

export interface StoredTabsPayload {
  schemaVersion: number;
  tabs: DockTabItem[];
  selectedId?: string;
}

const VALID_TAB_KINDS = new Set<string>([
  'dashboard',
  'browser',
  'files',
  'diffs',
  'tasks',
  'prompts',
  'subagents',
  'voice-transcript',
  'app',
  'sidecar',
  'mcp-app',
]);

function isValidMcpAppSpec(spec: unknown): spec is McpAppTabSpec {
  if (!spec || typeof spec !== 'object') return false;
  const candidate = spec as Record<string, unknown>;
  return (
    typeof candidate.serverName === 'string' &&
    candidate.serverName.trim().length > 0 &&
    typeof candidate.toolName === 'string' &&
    candidate.toolName.trim().length > 0 &&
    typeof candidate.resourceUri === 'string' &&
    candidate.resourceUri.trim().length > 0
  );
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
          if (!item || typeof item.id !== 'string' || !item.id.trim() || seenIds.has(item.id)) continue;
          if (!VALID_TAB_KINDS.has(item.kind)) continue;

          if (item.kind === 'sidecar') {
            if (typeof item.sidecarId !== 'string' || !item.sidecarId.trim()) continue;
            seenIds.add(item.id);
            validTabs.push({
              id: item.id,
              kind: 'sidecar',
              appId: null,
              url: null,
              sidecarId: item.sidecarId.trim(),
              viewPath: typeof item.viewPath === 'string' ? item.viewPath : null,
              title: typeof item.title === 'string' ? item.title : null,
            });
            continue;
          }

          if (item.kind === 'mcp-app') {
            if (!isValidMcpAppSpec(item.mcpAppSpec)) continue;
            seenIds.add(item.id);
            validTabs.push({
              id: item.id,
              kind: 'mcp-app',
              appId: null,
              url: null,
              title: typeof item.title === 'string' ? item.title : item.mcpAppSpec.title ?? null,
              mcpAppSpec: {
                serverName: item.mcpAppSpec.serverName,
                toolName: item.mcpAppSpec.toolName,
                resourceUri: item.mcpAppSpec.resourceUri,
                ...(typeof item.mcpAppSpec.title === 'string' ? { title: item.mcpAppSpec.title } : {}),
              },
            });
            continue;
          }

          seenIds.add(item.id);
          validTabs.push({
            id: item.id,
            kind: item.kind,
            appId: item.appId ?? null,
            url: item.url ?? null,
          });
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
      schemaVersion: 5,
      tabs: tabs.map((t) => {
        const base: DockTabItem = {
          id: t.id,
          kind: t.kind,
          appId: t.appId ?? null,
          url: t.url ?? null,
        };
        if (t.kind === 'sidecar') {
          base.sidecarId = t.sidecarId ?? null;
          base.viewPath = t.viewPath ?? null;
          base.title = t.title ?? null;
        } else if (t.kind === 'mcp-app') {
          base.title = t.title ?? null;
          base.mcpAppSpec = t.mcpAppSpec ?? null;
        }
        return base;
      }),
      selectedId,
    };
    localStorage.setItem(STORAGE_KEY_TABS, JSON.stringify(payload));
  } catch {}
}

export function computeResponsiveDockWidth(preferredWidth: number, viewportWidth: number): number {
  const safePreferred = Number.isFinite(preferredWidth) ? preferredWidth : 440;
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return Math.round(Math.max(280, Math.min(safePreferred, 720)));
  }
  const minWidth = viewportWidth < 900 ? 260 : 320;
  const maxByRatio = Math.round(viewportWidth * 0.72);
  // Reserve space for Sidebar (~232px) + usable center thread pane (>=320px).
  const maxLeavingCenter = Math.max(minWidth, viewportWidth - 580);
  const maxWidth = Math.max(minWidth, Math.min(maxByRatio, maxLeavingCenter));
  return Math.round(Math.max(minWidth, Math.min(safePreferred, maxWidth)));
}

export function loadInitialWidth(): number {
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1366;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_BROWSER);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.width === 'number' && Number.isFinite(parsed.width)) {
        return computeResponsiveDockWidth(parsed.width, viewportWidth);
      }
    }
  } catch {}
  return computeResponsiveDockWidth(440, viewportWidth);
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
  'voice-transcript': {
    label: 'Voz',
    tooltip: 'Transcripción de voz',
    closable: true,
    renderIcon: () => (
      <svg
        width={13}
        height={13}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="22" />
      </svg>
    ),
  },
  'app:focusTimer': { label: 'Focus timer', tooltip: 'Focus timer', closable: true, renderIcon: () => <TimerGlyph /> },
  'app:scratchpad': { label: 'Scratchpad', tooltip: 'Scratchpad', closable: true, renderIcon: () => <NotebookPenGlyph /> },
  'app:bombSprint': { label: 'Bomb Sprint', tooltip: 'Bomb Sprint', closable: true, renderIcon: () => <FlameGlyph /> },
  'app:kiteVerse': { label: 'KiteVerse', tooltip: 'KiteVerse', closable: true, renderIcon: () => <SparklesGlyph /> },
};

export function resolveTabDef(tab: DockTabItem): TabResolvedDef {
  if (tab.kind === 'sidecar') {
    const label = tab.title?.trim() || tab.sidecarId?.split('/').pop()?.trim() || 'Extension';
    const tooltip =
      tab.title?.trim() && tab.sidecarId
        ? `${tab.title.trim()} (${tab.sidecarId})`
        : tab.sidecarId || label;
    return {
      label,
      tooltip,
      closable: true,
      renderIcon: () => <PuzzleIcon size={12} strokeWidth={1.65} />,
    };
  }
  if (tab.kind === 'mcp-app') {
    const label =
      tab.title?.trim() ||
      tab.mcpAppSpec?.title?.trim() ||
      tab.mcpAppSpec?.toolName ||
      'MCP App';
    const tooltip = tab.mcpAppSpec?.serverName ? `${label} (${tab.mcpAppSpec.serverName})` : label;
    return {
      label,
      tooltip,
      closable: true,
      renderIcon: () => <LayoutGridGlyph />,
    };
  }
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
  {
    kind: 'voice-transcript' as const,
    label: 'Transcripción de voz',
    icon: (
      <svg
        width={13}
        height={13}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="22" />
      </svg>
    ),
    shortcut: '',
  },
];

export const APP_MENU_TABS: Array<{ appId: SidePanelAppId; label: string; icon: React.ReactElement }> = [
  { appId: 'focusTimer', label: 'Focus timer', icon: <TimerGlyph /> },
  { appId: 'scratchpad', label: 'Scratchpad', icon: <NotebookPenGlyph /> },
  { appId: 'bombSprint', label: 'Bomb Sprint', icon: <FlameGlyph /> },
  { appId: 'kiteVerse', label: 'KiteVerse', icon: <SparklesGlyph /> },
];
