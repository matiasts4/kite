import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { SidecarPanelView } from './SidecarPanelView';
import { DockNewTabMenu } from '../dock/DockNewTabMenu';
import { RightDock } from '../RightDock';
import { STORAGE_KEY_TABS } from '../dock/dockConfig';
import {
  clearKnownSidecars,
  consumePendingSidecarRequest,
  OPEN_RIGHT_DOCK_SIDECAR_EVENT,
  openSidecarInRightDock,
  parseSidecarUri,
  registerKnownSidecars,
} from '../../lib/sidecarNav';
import type { SidecarStatusSnapshot } from '../../lib/ipc/pluginRuntime';
import * as pluginRuntime from '../../lib/ipc/pluginRuntime';

vi.mock('../../lib/ipc/pluginRuntime', () => ({
  runSidecarAction: vi.fn(),
  fetchSidecarLogs: vi.fn(),
  listUiSidecars: vi.fn(),
  pluginMcpAppListEntrypoints: vi.fn(),
  pluginMcpAppReadResource: vi.fn(),
  pluginMcpAppCallTool: vi.fn(),
}));
vi.mock('./plugins/McpAppFrame', () => ({
  McpAppFrame: (props: { serverName: string; resourceUri: string; toolName?: string }) => (
    <div
      data-testid="mock-mcp-app-frame"
      data-server={props.serverName}
      data-uri={props.resourceUri}
      data-tool={props.toolName}
    />
  ),
}));
vi.mock('./BrowserView', () => ({
  BrowserView: () => <div data-testid="mock-browser-view" />,
}));
vi.mock('./FilesView', () => ({
  FilesView: () => <div data-testid="mock-files-view" />,
}));
vi.mock('./diffs/DiffsView', () => ({
  DiffsView: () => <div data-testid="mock-diffs-view" />,
}));
vi.mock('./TicketsView', () => ({
  TicketsView: () => <div data-testid="mock-tickets-view" />,
}));
vi.mock('./PromptsView', () => ({
  PromptsView: () => <div data-testid="mock-prompts-view" />,
}));
vi.mock('./SidePanelAppsView', () => ({
  SidePanelAppsView: () => <div data-testid="mock-apps-view" />,
}));
vi.mock('./apps/AgentDashboardView', () => ({
  AgentDashboardView: () => <div data-testid="mock-dashboard-view" />,
}));
vi.mock('./subagents/SubagentInspectorView', () => ({
  SubagentInspectorView: () => <div data-testid="mock-subagent-view" />,
}));
vi.mock('./voice/VoiceTranscriptPane', () => ({
  VoiceTranscriptPane: () => <div data-testid="mock-voice-view" />,
}));
vi.mock('../../lib/terminalRegistry', () => ({
  getActiveAgentTerminals: () => [],
}));

const mockedRunSidecarAction = vi.mocked(pluginRuntime.runSidecarAction);
const mockedFetchSidecarLogs = vi.mocked(pluginRuntime.fetchSidecarLogs);
const mockedListUiSidecars = vi.mocked(pluginRuntime.listUiSidecars);
const mockedListMcpAppEntrypoints = vi.mocked(pluginRuntime.pluginMcpAppListEntrypoints);

function makeSnapshot(overrides: Partial<SidecarStatusSnapshot> = {}): SidecarStatusSnapshot {
  return {
    namespacedId: 'android-cli-plugin/device-hub',
    sidecarId: 'device-hub',
    pluginId: 'android-cli-plugin',
    pluginName: 'android-cli',
    displayName: 'Android Device Hub',
    description: 'Mirror and manage devices',
    hasWebUi: true,
    views: [{ title: 'Device Hub', path: '/', entrypoint: 'aux_pane' }],
    state: 'running',
    pid: 4242,
    upstreamPort: 50001,
    proxyPort: 50002,
    proxyUrl: 'http://127.0.0.1:50002',
    entryUrl: 'http://127.0.0.1:50002/?__kite_token=tok123',
    logPath: 'C:/Users/dev/.kite/sidecar.log',
    restartCount: 0,
    lastError: null,
    startedAtMs: 1700000000000,
    builtin: null,
    ...overrides,
  };
}

describe('sidecarNav URI parser & event queue', () => {
  beforeEach(() => {
    clearKnownSidecars();
    consumePendingSidecarRequest();
  });

  it('parses namespaced and short sidecar:// URIs while preserving query params', () => {
    expect(parseSidecarUri('sidecar://android-cli-plugin/device-hub')).toEqual({
      sidecarId: 'android-cli-plugin/device-hub',
      viewPath: '/',
    });

    expect(parseSidecarUri('sidecar://android-cli-plugin/device-hub/?view=auxpane')).toEqual({
      sidecarId: 'android-cli-plugin/device-hub',
      viewPath: '/?view=auxpane',
    });

    expect(parseSidecarUri('sidecar://android-cli-plugin/device-hub/mirror?device=emulator-5554')).toEqual({
      sidecarId: 'android-cli-plugin/device-hub',
      viewPath: '/mirror?device=emulator-5554',
    });

    expect(parseSidecarUri('sidecar://device-hub?view=auxpane')).toEqual({
      sidecarId: 'device-hub',
      viewPath: '/?view=auxpane',
    });

    expect(parseSidecarUri('sidecar://device-hub/index.html?view=auxpane')).toEqual({
      sidecarId: 'device-hub',
      viewPath: '/index.html?view=auxpane',
    });

    registerKnownSidecars([{ namespacedId: 'android-cli-plugin/device-hub', sidecarId: 'device-hub' }]);
    expect(parseSidecarUri('sidecar://device-hub/mirror?view=auxpane')).toEqual({
      sidecarId: 'device-hub',
      viewPath: '/mirror?view=auxpane',
    });

    expect(parseSidecarUri('https://example.com')).toBeNull();
    expect(parseSidecarUri('sidecar://')).toBeNull();
  });

  it('queues pending sidecar request and dispatches OPEN_RIGHT_DOCK_SIDECAR_EVENT', () => {
    const listener = vi.fn();
    window.addEventListener(OPEN_RIGHT_DOCK_SIDECAR_EVENT, listener);

    openSidecarInRightDock({
      sidecarId: 'android-cli-plugin/device-hub',
      viewPath: '/?view=auxpane',
      title: 'Device Hub',
      workspaceId: 'ws-1',
    });

    expect(listener).toHaveBeenCalledTimes(1);
    const ev = listener.mock.calls[0][0] as CustomEvent;
    expect(ev.detail).toEqual({
      sidecarId: 'android-cli-plugin/device-hub',
      viewPath: '/?view=auxpane',
      title: 'Device Hub',
      workspaceId: 'ws-1',
    });

    expect(consumePendingSidecarRequest()).toEqual({
      sidecarId: 'android-cli-plugin/device-hub',
      viewPath: '/?view=auxpane',
      title: 'Device Hub',
      workspaceId: 'ws-1',
    });
    expect(consumePendingSidecarRequest()).toBeNull();

    window.removeEventListener(OPEN_RIGHT_DOCK_SIDECAR_EVENT, listener);
  });
});

describe('SidecarPanelView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFetchSidecarLogs.mockResolvedValue([]);
    mockedListUiSidecars.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens on mount, polls at 1500ms while starting, then renders iframe once running', async () => {
    vi.useFakeTimers();

    const startingSnap = makeSnapshot({ state: 'starting' });
    const runningSnap = makeSnapshot({
      state: 'running',
      entryUrl: 'http://127.0.0.1:50002/?view=auxpane&__kite_token=tok123',
    });

    mockedRunSidecarAction.mockResolvedValueOnce(startingSnap);
    mockedListUiSidecars.mockResolvedValueOnce([runningSnap]);
    mockedRunSidecarAction.mockResolvedValueOnce(runningSnap);

    await act(async () => {
      render(
        <SidecarPanelView
          sidecarId="android-cli-plugin/device-hub"
          viewPath="/?view=auxpane"
          workspaceId="ws-1"
        />,
      );
      await Promise.resolve();
    });

    expect(mockedRunSidecarAction).toHaveBeenCalledWith(
      'android-cli-plugin/device-hub',
      'open',
      { viewPath: '/?view=auxpane', workspaceId: 'ws-1' },
    );
    expect(screen.getByTestId('sidecar-status-dot')).toHaveAttribute('data-state', 'starting');
    expect(screen.getByText(/Starting Device Hub/i)).toBeInTheDocument();
    expect(screen.queryByTitle('Device Hub')).not.toBeInTheDocument();

    // Advance 1500ms to trigger startup readiness poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(mockedListUiSidecars).toHaveBeenCalledWith('ws-1');
    const iframe = screen.getByTitle('Device Hub') as HTMLIFrameElement;
    expect(iframe).toBeInTheDocument();
    expect(iframe.tagName).toBe('IFRAME');
    expect(iframe.className).toBe('sidecar-panel__frame');
    expect(iframe.src).toBe('http://127.0.0.1:50002/?view=auxpane&__kite_token=tok123');
    expect(screen.getByTestId('sidecar-status-dot')).toHaveAttribute('data-state', 'running');

    // Fast 1500ms polling has stopped: advancing 1500ms more should NOT trigger another listUiSidecars call
    const callsAtReady = mockedListUiSidecars.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(mockedListUiSidecars).toHaveBeenCalledTimes(callsAtReady);
  });

  it('renders pointer-events resize shield only while isResizing is true', async () => {
    mockedRunSidecarAction.mockResolvedValue(makeSnapshot({ state: 'running' }));

    const { rerender } = render(
      <SidecarPanelView
        sidecarId="android-cli-plugin/device-hub"
        isResizing={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTitle('Device Hub')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('sidecar-resize-shield')).toBeNull();

    rerender(
      <SidecarPanelView
        sidecarId="android-cli-plugin/device-hub"
        isResizing={true}
      />,
    );

    expect(screen.getByTestId('sidecar-resize-shield')).toBeInTheDocument();
  });

  it('supports Reload, Stop/Start toggle, Restart, and Logs drawer', async () => {
    const runningSnap = makeSnapshot({ state: 'running' });
    const stoppedSnap = makeSnapshot({ state: 'stopped', pid: null, entryUrl: null });
    const restartedSnap = makeSnapshot({ state: 'running', restartCount: 1 });

    mockedRunSidecarAction
      .mockResolvedValueOnce(runningSnap)
      .mockResolvedValueOnce(stoppedSnap)
      .mockResolvedValueOnce(runningSnap)
      .mockResolvedValueOnce(restartedSnap);
    mockedFetchSidecarLogs.mockResolvedValue(['[stdout] listening on 50001', '[stdout] ready']);

    render(
      <SidecarPanelView
        sidecarId="android-cli-plugin/device-hub"
        workspaceId="ws-9"
      />,
    );

    const frameBefore = (await screen.findByTitle('Device Hub')) as HTMLIFrameElement;
    fireEvent.click(screen.getByRole('button', { name: 'Reload panel' }));
    const frameAfterReload = screen.getByTitle('Device Hub') as HTMLIFrameElement;
    expect(frameAfterReload).not.toBe(frameBefore);

    // Stop sidecar -> honest stopped state with Start button
    fireEvent.click(screen.getByRole('button', { name: 'Stop sidecar' }));
    expect(await screen.findByText(/Device Hub is stopped/i)).toBeInTheDocument();
    expect(mockedRunSidecarAction).toHaveBeenCalledWith(
      'android-cli-plugin/device-hub',
      'stop',
      { workspaceId: 'ws-9' },
    );

    // Start from stopped card
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => {
      expect(screen.getByTitle('Device Hub')).toBeInTheDocument();
    });
    expect(mockedRunSidecarAction).toHaveBeenCalledWith(
      'android-cli-plugin/device-hub',
      'start',
      { viewPath: undefined, workspaceId: 'ws-9' },
    );

    // Restart sidecar
    fireEvent.click(screen.getByRole('button', { name: 'Restart sidecar' }));
    await waitFor(() => {
      expect(mockedRunSidecarAction).toHaveBeenCalledWith(
        'android-cli-plugin/device-hub',
        'restart',
        { viewPath: undefined, workspaceId: 'ws-9' },
      );
    });

    // Toggle Logs drawer
    fireEvent.click(screen.getByRole('button', { name: 'Toggle logs' }));
    const drawer = await screen.findByTestId('sidecar-logs-drawer');
    expect(drawer).toBeInTheDocument();
    expect(mockedFetchSidecarLogs).toHaveBeenCalledWith('android-cli-plugin/device-hub', 200);
    await waitFor(() => {
      expect(drawer).toHaveTextContent('[stdout] listening on 50001');
    });
  });

  it('renders honest crashed state with actionable Retry and View Logs actions', async () => {
    mockedRunSidecarAction
      .mockResolvedValueOnce(
        makeSnapshot({
          state: 'crashed',
          entryUrl: null,
          lastError: 'Address already in use on loopback socket',
        }),
      )
      .mockResolvedValueOnce(makeSnapshot({ state: 'running' }));
    mockedFetchSidecarLogs.mockResolvedValue(['[stderr] fatal startup error']);

    render(<SidecarPanelView sidecarId="android-cli-plugin/device-hub" />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Address already in use on loopback socket')).toBeInTheDocument();
    expect(screen.getByTestId('sidecar-status-dot')).toHaveAttribute('data-state', 'crashed');

    fireEvent.click(screen.getByRole('button', { name: 'View Logs' }));
    const drawer = await screen.findByTestId('sidecar-logs-drawer');
    await waitFor(() => {
      expect(drawer).toHaveTextContent('[stderr] fatal startup error');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(screen.getByTitle('Device Hub')).toBeInTheDocument();
    });
  });
});

describe('DockNewTabMenu Extensions section', () => {
  it('renders Extensions section with live status dots when sidecars are provided', () => {
    const onOpenSidecarTab = vi.fn();
    const sidecars = [
      makeSnapshot({ state: 'running' }),
      makeSnapshot({
        namespacedId: 'echo-plugin/echo-ui',
        sidecarId: 'echo-ui',
        displayName: 'Echo UI',
        views: [],
        state: 'crashed',
      }),
    ];

    render(
      <DockNewTabMenu
        isOpen={true}
        onClose={vi.fn()}
        highlightedMenuId={null}
        setHighlightedMenuId={vi.fn()}
        onOpenStandardTab={vi.fn()}
        onOpenAppTab={vi.fn()}
        sidecars={sidecars}
        onOpenSidecarTab={onOpenSidecarTab}
      />,
    );

    expect(screen.getByText('Extensions')).toBeInTheDocument();
    const deviceHubItem = screen.getByText('Device Hub').closest('[role="menuitem"]');
    const echoItem = screen.getByText('Echo UI').closest('[role="menuitem"]');
    expect(deviceHubItem).not.toBeNull();
    expect(echoItem).not.toBeNull();
    expect(deviceHubItem?.querySelector('[data-state="running"]')).not.toBeNull();
    expect(echoItem?.querySelector('[data-state="crashed"]')).not.toBeNull();

    fireEvent.click(deviceHubItem!);
    expect(onOpenSidecarTab).toHaveBeenCalledWith(sidecars[0]);
  });
});

describe('RightDock sidecar integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    clearKnownSidecars();
    consumePendingSidecarRequest();
    mockedFetchSidecarLogs.mockResolvedValue([]);
    mockedListUiSidecars.mockResolvedValue([makeSnapshot({ state: 'running' })]);
    mockedRunSidecarAction.mockResolvedValue(makeSnapshot({ state: 'running' }));
    mockedListMcpAppEntrypoints.mockResolvedValue([]);
  });

  it('consumes queued sidecar request on mount, persists schema v5 tab, and renders SidecarPanelView', async () => {
    openSidecarInRightDock({
      sidecarId: 'android-cli-plugin/device-hub',
      viewPath: '/?view=auxpane',
      title: 'Device Hub',
      workspaceId: 'ws-dock',
    });

    render(<RightDock visible={true} onClose={vi.fn()} workspaceId="ws-dock" />);

    const panel = await screen.findByTestId('sidecar-panel-view');
    expect(panel).toHaveAttribute('data-sidecar-id', 'android-cli-plugin/device-hub');
    expect(await screen.findByTitle('Device Hub')).toBeInTheDocument();

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_TABS) || '{}');
    expect(stored.schemaVersion).toBe(5);
    expect(stored.selectedId).toBe('sidecar:android-cli-plugin/device-hub');
    expect(stored.tabs.some((t: any) => t.id === 'sidecar:android-cli-plugin/device-hub')).toBe(true);
  });

  it('opens sidecar from Extensions section in New tab menu and logs listUiSidecars errors with console.warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockedListUiSidecars
      .mockRejectedValueOnce(new Error('runtime unavailable'))
      .mockResolvedValue([makeSnapshot({ state: 'running' })]);

    render(<RightDock visible={true} onClose={vi.fn()} workspaceId="ws-menu" />);

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        '[RightDock] Failed to load UI sidecars:',
        expect.any(Error),
      );
    });

    fireEvent.click(screen.getByLabelText('New tab'));
    const extensionRow = await screen.findByText('Device Hub');
    fireEvent.click(extensionRow.closest('[role="menuitem"]')!);

    expect(await screen.findByTestId('sidecar-panel-view')).toBeInTheDocument();
    warnSpy.mockRestore();
  });

  it('opens an MCP App entrypoint from New tab menu into McpAppFrame', async () => {
    mockedListUiSidecars.mockResolvedValue([]);
    mockedListMcpAppEntrypoints.mockResolvedValue([
      {
        id: 'demo-plugin:server:inspector',
        pluginId: 'demo-plugin',
        pluginName: 'Demo Plugin',
        serverName: 'demo-server',
        toolName: 'inspector',
        title: 'Demo Inspector',
        description: 'Inspect state',
        resourceUri: 'ui://demo-server/inspector.html',
        surface: 'aux_pane',
      },
    ]);

    render(<RightDock visible={true} onClose={vi.fn()} workspaceId="ws-app" />);

    fireEvent.click(screen.getByLabelText('New tab'));
    const entryRow = await screen.findByText('Demo Inspector');
    fireEvent.click(entryRow.closest('[role="menuitem"]')!);

    const frame = await screen.findByTestId('mock-mcp-app-frame');
    expect(frame).toHaveAttribute('data-server', 'demo-server');
    expect(frame).toHaveAttribute('data-uri', 'ui://demo-server/inspector.html');
  });

  it('does not probe MCP App entrypoints until the New tab menu is opened', async () => {
    mockedListUiSidecars.mockResolvedValue([makeSnapshot({ state: 'stopped', entryUrl: null })]);
    mockedListMcpAppEntrypoints.mockResolvedValue([]);

    render(<RightDock visible={true} onClose={vi.fn()} workspaceId="ws-lazy" />);

    await waitFor(() => {
      expect(mockedListUiSidecars).toHaveBeenCalledWith('ws-lazy');
    });
    expect(mockedListMcpAppEntrypoints).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('New tab'));
    await waitFor(() => {
      expect(mockedListMcpAppEntrypoints).toHaveBeenCalledWith('ws-lazy');
    });
  });

  it('stops a UI sidecar when its last RightDock tab is closed', async () => {
    openSidecarInRightDock({
      sidecarId: 'android-cli-plugin/device-hub',
      viewPath: '/?view=auxpane',
      title: 'Device Hub',
      workspaceId: 'ws-close',
    });

    render(<RightDock visible={true} onClose={vi.fn()} workspaceId="ws-close" />);

    expect(await screen.findByTestId('sidecar-panel-view')).toBeInTheDocument();
    mockedRunSidecarAction.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Close Device Hub' }));

    await waitFor(() => {
      expect(mockedRunSidecarAction).toHaveBeenCalledWith(
        'android-cli-plugin/device-hub',
        'stop',
        { workspaceId: 'ws-close' },
      );
    });
  });
});
