import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { BrowserSurfaceView } from '../../types';
import { formatContextCategoryLabel, formatContextFeatureLabel } from '../../lib/contextMonitor';

const ipcMocks = vi.hoisted(() => ({
  listBrowserSurfaces: vi.fn(),
  takeoverBrowserSurface: vi.fn(),
  resumeBrowserSurface: vi.fn(),
  discoverBrowserServers: vi.fn(),
  captureBrowserSurfaceScreenshot: vi.fn(),
  closeBrowserSurface: vi.fn(),
  createBrowserSurface: vi.fn(),
  navigateBrowserSurface: vi.fn(),
  controlBrowserSurface: vi.fn(),
  readBrowserSurface: vi.fn(),
  updateBrowserSurfacePresentation: vi.fn(),
  isTauriEnvironment: vi.fn(() => false),
  randomUuid: vi.fn(() => 'uuid-test-1'),
}));

vi.mock('../../lib/ipc', () => ipcMocks);
vi.mock('../../lib/terminalLinkNav', () => ({
  openExternalLink: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

import { ATTACH_BROWSER_SCREENSHOT_EVENT, BrowserView } from './BrowserView';

function makeSurface(overrides: Partial<BrowserSurfaceView> = {}): BrowserSurfaceView {
  return {
    schemaVersion: 1,
    surfaceId: 'tab-user-1',
    descriptorId: 'desc-user-1',
    workspaceId: 'ws-browser-test',
    revision: 1,
    displayUrl: 'http://localhost:5173/',
    transportSecurity: 'local',
    title: 'Kite App',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    visible: true,
    designMode: false,
    ownerKind: 'user',
    ownerThreadId: null,
    agentActive: false,
    statusPill: null,
    pausedForAuth: false,
    pauseReason: null,
    takeoverRequested: false,
    isolated: false,
    ...overrides,
  };
}

describe('BrowserView (Multi-Tab, Agent Takeover/Resume, Dev-Server Picker & Screenshot Capture)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcMocks.isTauriEnvironment.mockReturnValue(false);
    ipcMocks.listBrowserSurfaces.mockResolvedValue({ surfaces: [] });
    ipcMocks.discoverBrowserServers.mockResolvedValue({
      servers: [
        {
          url: 'http://localhost:5173',
          host: 'localhost',
          port: 5173,
          frameworkHint: 'Vite',
          titleHint: 'Kite Dev',
          reachable: true,
          source: 'port-probe',
        },
      ],
    });
    ipcMocks.closeBrowserSurface.mockResolvedValue({ closed: true });
    ipcMocks.updateBrowserSurfacePresentation.mockResolvedValue(makeSurface());
  });

  it('discovers local dev servers on the start screen and toolbar popover', async () => {
    render(<BrowserView workspaceId="ws-start-servers" />);

    await waitFor(() => {
      expect(screen.getByTestId('browser-start-servers')).toBeInTheDocument();
    });
    expect(screen.getByText('Vite :5173')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('browser-local-servers-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('browser-servers-popover')).toBeInTheDocument();
    });
    expect(screen.getByText('http://localhost:5173')).toBeInTheDocument();
  });

  it('renders user and parallel agent tabs, switches tabs, and supports Stop/Take Over and Resume Agent', async () => {
    const userTab = makeSurface({
      surfaceId: 'tab-u1',
      title: 'Docs',
      displayUrl: 'http://localhost:3000/docs',
      ownerKind: 'user',
    });
    const agentTab = makeSurface({
      surfaceId: 'tab-a1',
      descriptorId: 'desc-agent-1',
      title: 'Checkout Flow',
      displayUrl: 'http://localhost:5173/checkout',
      ownerKind: 'agent',
      ownerThreadId: 'thread-qa-1',
      agentActive: true,
      statusPill: 'Step 2/4: fill',
    });
    const takenOverTab = makeSurface({
      ...agentTab,
      ownerKind: 'user',
      agentActive: false,
      takeoverRequested: true,
      statusPill: 'Manual control',
    });
    const resumedTab = makeSurface({
      ...agentTab,
      ownerKind: 'agent',
      agentActive: true,
      takeoverRequested: false,
      pausedForAuth: false,
      statusPill: 'Agent resumed',
    });

    ipcMocks.listBrowserSurfaces.mockResolvedValue({ surfaces: [userTab, agentTab] });
    ipcMocks.takeoverBrowserSurface.mockResolvedValue(takenOverTab);
    ipcMocks.resumeBrowserSurface.mockResolvedValue(resumedTab);

    render(<BrowserView workspaceId="ws-agent-tabs" />);

    await waitFor(() => {
      expect(screen.getByTestId('browser-tabbar')).toBeInTheDocument();
    });
    expect(screen.getByTestId('browser-tab-tab-u1')).toBeInTheDocument();
    expect(screen.getByTestId('browser-tab-tab-a1')).toBeInTheDocument();
    expect(screen.getByText('Agent')).toBeInTheDocument();

    // Switch to the parallel agent tab
    fireEvent.click(screen.getByTestId('browser-tab-tab-a1'));
    await waitFor(() => {
      expect(screen.getByTestId('browser-agent-banner')).toBeInTheDocument();
    });
    expect(screen.getByText('Step 2/4: fill')).toBeInTheDocument();

    // Stop / Take Over
    fireEvent.click(screen.getByTestId('browser-takeover-btn'));
    await waitFor(() => {
      expect(ipcMocks.takeoverBrowserSurface).toHaveBeenCalledWith('tab-a1');
      expect(screen.getByTestId('browser-resume-btn')).toBeInTheDocument();
    });

    // Resume Agent
    fireEvent.click(screen.getByTestId('browser-resume-btn'));
    await waitFor(() => {
      expect(ipcMocks.resumeBrowserSurface).toHaveBeenCalledWith('tab-a1', 'thread-qa-1');
    });
  });

  it('captures a screenshot and dispatches kite:attach-browser-screenshot for the active thread composer', async () => {
    const activeTab = makeSurface({
      surfaceId: 'tab-cap-1',
      displayUrl: 'http://localhost:5173/preview',
      title: 'Preview',
    });
    ipcMocks.listBrowserSurfaces.mockResolvedValue({ surfaces: [activeTab] });
    ipcMocks.captureBrowserSurfaceScreenshot.mockResolvedValue({
      ok: true,
      surfaceId: 'tab-cap-1',
      mimeType: 'image/png',
      format: 'png',
      sha256: 'abc123',
      dataBase64: 'iVBORw0KGgo=',
    });

    const received: unknown[] = [];
    const listener = (event: Event) => {
      received.push((event as CustomEvent).detail);
    };
    window.addEventListener(ATTACH_BROWSER_SCREENSHOT_EVENT, listener);

    try {
      render(<BrowserView workspaceId="ws-capture-test" />);
      await waitFor(() => {
        expect(screen.getByTestId('browser-tab-tab-cap-1')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('browser-tab-tab-cap-1'));
      await waitFor(() => {
        expect(screen.getByTestId('browser-capture-screenshot-btn')).not.toBeDisabled();
      });

      fireEvent.click(screen.getByTestId('browser-capture-screenshot-btn'));
      await waitFor(() => {
        expect(ipcMocks.captureBrowserSurfaceScreenshot).toHaveBeenCalledWith('tab-cap-1', 'png', 90);
        expect(received).toHaveLength(1);
      });
      expect(received[0]).toMatchObject({
        dataBase64: 'iVBORw0KGgo=',
        mimeType: 'image/png',
        url: 'http://localhost:5173/preview',
        sha256: 'abc123',
      });
    } finally {
      window.removeEventListener(ATTACH_BROWSER_SCREENSHOT_EVENT, listener);
    }
  });

  it('formats browser:* telemetry categories and features cleanly for ContextTab', () => {
    expect(formatContextCategoryLabel('browser')).toBe('Navegador');
    expect(formatContextFeatureLabel('browser:snapshot_stub')).toContain('Snapshot');
    expect(formatContextFeatureLabel('browser:ax_diff')).toContain('Delta AX');
    expect(formatContextFeatureLabel('browser:chrome_strip')).toContain('Chrome');
    expect(formatContextFeatureLabel('browser:network_crush')).toContain('Red');
    expect(formatContextFeatureLabel('browser:screenshot_dedup')).toContain('Deduplicación');
    expect(formatContextFeatureLabel('browser:recipe_replay')).toContain('0 tokens');
  });
});
