import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TitleBar } from './TitleBar';

// Mock ipc windowControls
vi.mock('../lib/ipc', () => ({
  windowControls: {
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    startDragging: vi.fn(),
  },
  getSubscriptionQuotas: vi.fn().mockResolvedValue({}),
  getSystemMetrics: vi.fn().mockResolvedValue({
    timestampMs: Date.now(),
    pid: 4242,
    uptimeSeconds: 180,
    memory: {
      appTotalBytes: 420 * 1024 * 1024,
      appCoreBytes: 340 * 1024 * 1024,
      appTerminalsBytes: 80 * 1024 * 1024,
      systemTotalBytes: 16 * 1024 * 1024 * 1024,
      systemUsedBytes: 7 * 1024 * 1024 * 1024,
      systemAvailableBytes: 9 * 1024 * 1024 * 1024,
      systemUsagePercent: 43.8,
      appShareOfSystemPercent: 2.6,
      pressure: 'normal',
    },
    cpu: {
      appUsagePercent: 2.3,
      systemUsagePercent: 11.4,
      logicalCores: 12,
      model: '12-Core Processor',
    },
    disk: {
      mountPoint: 'E:\\',
      totalBytes: 512 * 1024 * 1024 * 1024,
      usedBytes: 200 * 1024 * 1024 * 1024,
      availableBytes: 312 * 1024 * 1024 * 1024,
      usagePercent: 39.1,
      appCacheBytes: 12 * 1024 * 1024,
    },
    runtime: {
      activeTerminals: 2,
      processCount: 4,
      breakdown: [
        { id: 'core', label: 'Núcleo Rust (Tauri Host)', memoryBytes: 80 * 1024 * 1024, processCount: 1 },
        { id: 'webview', label: 'Motor UI (WebView2 / GPU)', memoryBytes: 260 * 1024 * 1024, processCount: 1 },
        { id: 'terminals', label: 'Terminales PTY & Agentes', memoryBytes: 80 * 1024 * 1024, processCount: 2 },
      ],
    },
  }),
  isTauriEnvironment: vi.fn().mockReturnValue(true),
}));

import { windowControls } from '../lib/ipc';

describe('TitleBar - Behavioral Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders brand lockup and mode switcher options', () => {
    render(<TitleBar activeMode="agent" />);

    expect(screen.getByText('Kite')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /agent/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /code/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /thread/i })).toBeInTheDocument();
  });

  it('calls onModeChange when a different mode option is selected', async () => {
    const user = userEvent.setup();
    const onModeChange = vi.fn();

    render(<TitleBar activeMode="agent" onModeChange={onModeChange} />);

    const codeBtn = screen.getByRole('button', { name: /code/i });
    await user.click(codeBtn);

    expect(onModeChange).toHaveBeenCalledWith('code');
  });

  it('calls onToggleSidebar when left rail toggle is clicked', async () => {
    const user = userEvent.setup();
    const onToggleSidebar = vi.fn();

    render(
      <TitleBar
        activeMode="code"
        sidebarVisible={true}
        onToggleSidebar={onToggleSidebar}
      />
    );

    const toggleBtn = screen.getByRole('button', { name: /hide sidebar/i });
    await user.click(toggleBtn);

    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });

  it('calls onToggleBrowser when right side panel toggle is clicked', async () => {
    const user = userEvent.setup();
    const onToggleBrowser = vi.fn();

    render(
      <TitleBar
        activeMode="code"
        browserVisible={false}
        onToggleBrowser={onToggleBrowser}
      />
    );

    const dockToggleBtn = screen.getByTestId('side-panel-toggle');
    await user.click(dockToggleBtn);

    expect(onToggleBrowser).toHaveBeenCalledTimes(1);
  });

  it('triggers window caption actions (minimize, maximize, close)', async () => {
    const user = userEvent.setup();

    render(<TitleBar platform="windows" />);

    const minBtn = screen.getByRole('button', { name: /minimize/i });
    const maxBtn = screen.getByRole('button', { name: /maximize/i });
    const closeBtn = screen.getByRole('button', { name: /close/i });

    await user.click(minBtn);
    expect(windowControls.minimize).toHaveBeenCalledTimes(1);

    await user.click(maxBtn);
    expect(windowControls.toggleMaximize).toHaveBeenCalledTimes(1);

    await user.click(closeBtn);
    expect(windowControls.close).toHaveBeenCalledTimes(1);
  });
});
