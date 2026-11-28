import { describe, it, expect, beforeEach } from 'vitest';
import {
  TAB_CONFIGS,
  STANDARD_MENU_TABS,
  STORAGE_KEY_TABS,
  loadInitialTabs,
  persistTabs,
  resolveTabDef,
  type DockTabItem,
} from './dockConfig';

describe('dockConfig subagents registration', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('registers subagents in TAB_CONFIGS and STANDARD_MENU_TABS with Ctrl+Alt+S shortcut', () => {
    expect(TAB_CONFIGS.subagents).toBeDefined();
    expect(TAB_CONFIGS.subagents.label).toBe('Subagents');
    expect(TAB_CONFIGS.subagents.closable).toBe(true);

    const menuEntry = STANDARD_MENU_TABS.find((t) => t.kind === 'subagents');
    expect(menuEntry).toBeDefined();
    expect(menuEntry?.label).toBe('Subagents');
    expect(menuEntry?.shortcut).toBe('Ctrl+Alt+S');
  });

  it('restores persisted subagents tab from localStorage', () => {
    localStorage.setItem(
      STORAGE_KEY_TABS,
      JSON.stringify({
        tabs: [
          { id: 'dashboard', kind: 'dashboard' },
          { id: 'subagents', kind: 'subagents' },
        ],
        selectedId: 'subagents',
      }),
    );

    const restored = loadInitialTabs();
    expect(restored.tabs.some((t) => t.kind === 'subagents')).toBe(true);
    expect(restored.activeTabId).toBe('subagents');
  });
});

describe('dockConfig sidecar and mcp-app schema v5 persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persists schemaVersion 5 and restores sidecar and mcp-app tabs', () => {
    const tabs: DockTabItem[] = [
      { id: 'dashboard', kind: 'dashboard' },
      {
        id: 'sidecar:android-cli-plugin/device-hub',
        kind: 'sidecar',
        sidecarId: 'android-cli-plugin/device-hub',
        viewPath: '/?view=auxpane',
        title: 'Device Hub',
      },
      {
        id: 'mcp-app:demo',
        kind: 'mcp-app',
        title: 'Inspector',
        mcpAppSpec: {
          serverName: 'demo-server',
          toolName: 'inspect_state',
          resourceUri: 'ui://demo/inspector',
          title: 'Inspector',
        },
      },
    ];

    persistTabs(tabs, 'sidecar:android-cli-plugin/device-hub');

    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY_TABS) || '{}');
    expect(raw.schemaVersion).toBe(5);

    const restored = loadInitialTabs();
    expect(restored.activeTabId).toBe('sidecar:android-cli-plugin/device-hub');
    const sidecarTab = restored.tabs.find((t) => t.kind === 'sidecar');
    expect(sidecarTab).toMatchObject({
      id: 'sidecar:android-cli-plugin/device-hub',
      kind: 'sidecar',
      sidecarId: 'android-cli-plugin/device-hub',
      viewPath: '/?view=auxpane',
      title: 'Device Hub',
    });

    const mcpTab = restored.tabs.find((t) => t.kind === 'mcp-app');
    expect(mcpTab).toMatchObject({
      id: 'mcp-app:demo',
      kind: 'mcp-app',
      title: 'Inspector',
      mcpAppSpec: {
        serverName: 'demo-server',
        toolName: 'inspect_state',
        resourceUri: 'ui://demo/inspector',
        title: 'Inspector',
      },
    });
  });

  it('skips malformed sidecar and mcp-app entries on load while keeping dashboard', () => {
    localStorage.setItem(
      STORAGE_KEY_TABS,
      JSON.stringify({
        schemaVersion: 5,
        tabs: [
          { id: 'sidecar:broken', kind: 'sidecar', sidecarId: '' },
          { id: 'mcp-app:broken', kind: 'mcp-app', mcpAppSpec: { serverName: 'only-server' } },
        ],
        selectedId: 'sidecar:broken',
      }),
    );

    const restored = loadInitialTabs();
    expect(restored.tabs).toEqual([{ id: 'dashboard', kind: 'dashboard' }]);
    expect(restored.activeTabId).toBe('dashboard');
  });

  it('resolves dynamic labels, tooltips, and icons for sidecar and mcp-app tabs', () => {
    const sidecarDef = resolveTabDef({
      id: 'sidecar:android-cli-plugin/device-hub',
      kind: 'sidecar',
      sidecarId: 'android-cli-plugin/device-hub',
      title: 'Device Hub',
    });
    expect(sidecarDef.label).toBe('Device Hub');
    expect(sidecarDef.tooltip).toBe('Device Hub (android-cli-plugin/device-hub)');
    expect(sidecarDef.closable).toBe(true);
    expect(sidecarDef.renderIcon()).toBeTruthy();

    const fallbackSidecarDef = resolveTabDef({
      id: 'sidecar:echo-plugin/echo-ui',
      kind: 'sidecar',
      sidecarId: 'echo-plugin/echo-ui',
    });
    expect(fallbackSidecarDef.label).toBe('echo-ui');

    const mcpDef = resolveTabDef({
      id: 'mcp-app:ui',
      kind: 'mcp-app',
      mcpAppSpec: {
        serverName: 'weather',
        toolName: 'show_radar',
        resourceUri: 'ui://weather/radar',
      },
    });
    expect(mcpDef.label).toBe('show_radar');
    expect(mcpDef.tooltip).toBe('show_radar (weather)');
    expect(mcpDef.closable).toBe(true);
    expect(mcpDef.renderIcon()).toBeTruthy();
  });
});
