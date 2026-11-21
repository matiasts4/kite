import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SystemResourceBadge } from './SystemResourceBadge';

vi.mock('../../lib/ipc', () => ({
  getSystemMetrics: vi.fn().mockResolvedValue({
    timestampMs: Date.now(),
    pid: 5120,
    uptimeSeconds: 340,
    memory: {
      appTotalBytes: 480 * 1024 * 1024,
      appCoreBytes: 360 * 1024 * 1024,
      appTerminalsBytes: 120 * 1024 * 1024,
      systemTotalBytes: 32 * 1024 * 1024 * 1024,
      systemUsedBytes: 14 * 1024 * 1024 * 1024,
      systemAvailableBytes: 18 * 1024 * 1024 * 1024,
      systemUsagePercent: 43.8,
      appShareOfSystemPercent: 1.5,
      pressure: 'normal',
    },
    cpu: {
      appUsagePercent: 3.4,
      systemUsagePercent: 12.8,
      logicalCores: 16,
      model: 'AMD Ryzen 9 16-Core Processor',
    },
    disk: {
      mountPoint: 'E:\\',
      totalBytes: 1024 * 1024 * 1024 * 1024,
      usedBytes: 412 * 1024 * 1024 * 1024,
      availableBytes: 612 * 1024 * 1024 * 1024,
      usagePercent: 40.2,
      appCacheBytes: 18 * 1024 * 1024,
    },
    runtime: {
      activeTerminals: 3,
      processCount: 5,
      breakdown: [
        { id: 'core', label: 'Núcleo Rust (Tauri Host)', memoryBytes: 85 * 1024 * 1024, processCount: 1 },
        { id: 'webview', label: 'Motor UI (WebView2 / GPU)', memoryBytes: 275 * 1024 * 1024, processCount: 1 },
        { id: 'terminals', label: 'Terminales PTY & Agentes', memoryBytes: 120 * 1024 * 1024, processCount: 3 },
      ],
      processes: [
        { pid: 5120, name: 'kite-code.exe', label: 'Núcleo Kite Code (Tauri Host)', category: 'core', memoryBytes: 85 * 1024 * 1024, privateBytes: 55 * 1024 * 1024 },
        { pid: 5124, name: 'msedgewebview2.exe', label: 'Motor UI (WebView2)', category: 'webview', memoryBytes: 275 * 1024 * 1024, privateBytes: 160 * 1024 * 1024 },
        { pid: 6100, name: 'node.exe', label: 'Antigravity CLI Agent', category: 'terminals', memoryBytes: 80 * 1024 * 1024, privateBytes: 60 * 1024 * 1024 },
        { pid: 6105, name: 'powershell.exe', label: 'PowerShell Shell', category: 'terminals', memoryBytes: 30 * 1024 * 1024, privateBytes: 20 * 1024 * 1024 },
        { pid: 6110, name: 'conhost.exe', label: 'Host de consola Windows (ConPTY)', category: 'terminals', memoryBytes: 10 * 1024 * 1024, privateBytes: 6 * 1024 * 1024 },
      ],
    },
  }),
  isTauriEnvironment: vi.fn().mockReturnValue(true),
  invokeCommand: vi.fn().mockResolvedValue({
    ok: true,
    engine_version: '0.1.0',
    lifetime: {
      requests: 3,
      raw_tokens: 10000,
      compressed_tokens: 2000,
      tokens_saved: 8000,
      savings_percent: 80,
      cache_hits: 1,
      cache_hit_rate: 33.3,
      estimated_usd_saved: 0.02,
    },
    session: {
      requests: 3,
      raw_tokens: 10000,
      compressed_tokens: 2000,
      tokens_saved: 8000,
      savings_percent: 80,
      cache_hits: 1,
      cache_hit_rate: 33.3,
      estimated_usd_saved: 0.02,
    },
    agents: [],
    models: [],
    categories: [],
    recent_sparkline: [],
    avg_overhead_ms: 1.2,
    ccr_entries: 1,
    shared_entries: 0,
    read_records: 2,
    quota_preservation: {
      saved_tokens_30d: 8000,
      pro_equivalent_pct: 0.16,
      tier_5x_pct: 0.03,
      tier_20x_pct: 0.01,
    },
  }),
}));

describe('SystemResourceBadge & SystemResourcePopover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('displays total application RAM usage in the top bar badge', async () => {
    render(<SystemResourceBadge />);

    await waitFor(() => {
      expect(screen.getByTestId('system-resource-ram-value')).toHaveTextContent('480 MB');
    });
  });

  it('opens the resource monitor popover with RAM, CPU, and Disk breakdown when clicked', async () => {
    const user = userEvent.setup();
    render(<SystemResourceBadge />);

    await waitFor(() => {
      expect(screen.getByTestId('system-resource-ram-value')).toHaveTextContent('480 MB');
    });

    const badgeBtn = screen.getByTestId('system-resource-badge');
    await user.click(badgeBtn);

    expect(
      await screen.findByRole('dialog', { name: /monitor de recursos del sistema y de la aplicación/i })
    ).toBeInTheDocument();

    // Verifies process tree breakdown & system cards are shown
    expect(screen.getByText(/RAM Total de la Aplicación/i)).toBeInTheDocument();
    expect(screen.getByText(/Núcleo Rust \(Tauri Host\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Motor UI \(WebView2 \/ GPU\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Terminales PTY & Agentes/i)).toBeInTheDocument();
    expect(screen.getByText(/Procesador \(CPU\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Disco \(E:\\\)/i)).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Headroom' })).not.toBeInTheDocument();

    // Switch to CPU tab
    await user.click(screen.getByRole('tab', { name: 'CPU' }));
    expect(screen.getByText(/Carga de Procesador \(CPU\)/i)).toBeInTheDocument();
    expect(screen.getByText(/AMD Ryzen 9 16-Core Processor/i)).toBeInTheDocument();

    // Switch to Disk tab
    await user.click(screen.getByRole('tab', { name: 'Disco' }));
    expect(screen.getByText(/Almacenamiento Local \(E:\\\)/i)).toBeInTheDocument();

    // Switch to Contexto tab
    await user.click(screen.getByRole('tab', { name: 'Contexto' }));
    expect(await screen.findByText(/Ahorro acumulado/i)).toBeInTheDocument();

    // Toggle badge display mode to RAM + CPU
    await user.click(screen.getByRole('button', { name: 'RAM + CPU' }));
    expect(badgeBtn).toHaveTextContent('3.4%');
  });

  it('displays detailed process breakdown and private memory in the RAM tab', async () => {
    const user = userEvent.setup();
    render(<SystemResourceBadge />);

    await waitFor(() => {
      expect(screen.getByTestId('system-resource-ram-value')).toHaveTextContent('480 MB');
    });

    const badgeBtn = screen.getByTestId('system-resource-badge');
    await user.click(badgeBtn);

    // Switch to RAM tab
    await user.click(await screen.findByRole('tab', { name: 'RAM' }));

    // Verifies explanatory note is displayed
    expect(screen.getByText(/¿Por qué varía el consumo\?/i)).toBeInTheDocument();
    expect(screen.getByText(/Subprocesos Activos/i)).toBeInTheDocument();

    // Verifies individual processes are listed
    expect(screen.getByText('PID 6100')).toBeInTheDocument();
    expect(screen.getByText(/Antigravity CLI Agent/i)).toBeInTheDocument();
    expect(screen.getByText('PID 5120')).toBeInTheDocument();
  });

  it('evaluates memory state relative to the machine capacity', async () => {
    const { evaluateMemoryPressure, getPressureColors } = await import('../../lib/systemMetrics');

    // 1. Light usage (<4% and <650MB) -> Bajo consumo
    const lowState = evaluateMemoryPressure(
      400 * 1024 * 1024,
      32 * 1024 * 1024 * 1024,
      20 * 1024 * 1024 * 1024,
      37.5
    );
    expect(lowState).toBe('low');
    expect(getPressureColors(lowState).label).toBe('Bajo consumo');

    // 2. Healthy normal work (1.8 GB on 32GB machine = 5.6%) -> Buen rendimiento
    const normalState = evaluateMemoryPressure(
      1800 * 1024 * 1024,
      32 * 1024 * 1024 * 1024,
      12 * 1024 * 1024 * 1024,
      62.5
    );
    expect(normalState).toBe('normal');
    expect(getPressureColors(normalState).label).toBe('Buen rendimiento');

    // 3. Intensive multi-process workload (>14% or >4GB) -> Uso activo
    const moderateState = evaluateMemoryPressure(
      4500 * 1024 * 1024,
      32 * 1024 * 1024 * 1024,
      8 * 1024 * 1024 * 1024,
      75.0
    );
    expect(moderateState).toBe('moderate');
    expect(getPressureColors(moderateState).label).toBe('Uso activo');

    // 4. Truly exhausted system (<900MB free and 95% full) -> Crítico
    const criticalState = evaluateMemoryPressure(
      6000 * 1024 * 1024,
      32 * 1024 * 1024 * 1024,
      500 * 1024 * 1024,
      98.4
    );
    expect(criticalState).toBe('critical');
    expect(getPressureColors(criticalState).label).toBe('Crítico');
  });

  it('supports grouping by project and by terminal with granular breakdown in RAM tab', async () => {
    const { getSystemMetrics } = await import('../../lib/ipc');
    (getSystemMetrics as any).mockResolvedValueOnce({
      timestampMs: Date.now(),
      pid: 5120,
      uptimeSeconds: 340,
      memory: {
        appTotalBytes: 800 * 1024 * 1024,
        appCoreBytes: 300 * 1024 * 1024,
        appTerminalsBytes: 500 * 1024 * 1024,
        systemTotalBytes: 32 * 1024 * 1024 * 1024,
        systemUsedBytes: 14 * 1024 * 1024 * 1024,
        systemAvailableBytes: 18 * 1024 * 1024 * 1024,
        systemUsagePercent: 43.8,
        appShareOfSystemPercent: 2.5,
        pressure: 'normal',
      },
      cpu: {
        appUsagePercent: 3.4,
        systemUsagePercent: 12.8,
        logicalCores: 16,
        model: 'AMD Ryzen 9 16-Core Processor',
      },
      disk: {
        mountPoint: 'E:\\',
        totalBytes: 1024 * 1024 * 1024 * 1024,
        usedBytes: 412 * 1024 * 1024 * 1024,
        availableBytes: 612 * 1024 * 1024 * 1024,
        usagePercent: 40.2,
        appCacheBytes: 18 * 1024 * 1024,
      },
      runtime: {
        activeTerminals: 2,
        processCount: 4,
        breakdown: [
          { id: 'core', label: 'Núcleo Rust (Tauri Host)', memoryBytes: 80 * 1024 * 1024, processCount: 1 },
          { id: 'webview', label: 'Motor UI (WebView2 / GPU)', memoryBytes: 220 * 1024 * 1024, processCount: 1 },
          { id: 'terminals', label: 'Terminales PTY & Agentes', memoryBytes: 500 * 1024 * 1024, processCount: 2 },
        ],
        workspaces: [
          {
            workspaceId: 'kite-core',
            displayName: 'kite-core',
            memoryBytes: 500 * 1024 * 1024,
            privateBytes: 350 * 1024 * 1024,
            processCount: 2,
            terminalCount: 1,
          },
        ],
        terminals: [
          {
            sessionId: 'term-agent-orion',
            title: 'Agente Antigravity',
            engine: 'antigravity',
            workspaceId: 'kite-core',
            isAgent: true,
            rootPid: 6200,
            memoryBytes: 500 * 1024 * 1024,
            privateBytes: 350 * 1024 * 1024,
            processCount: 2,
          },
        ],
        processes: [
          { pid: 5120, name: 'kite-code.exe', label: 'Núcleo Kite Code', category: 'core', role: 'core', memoryBytes: 80 * 1024 * 1024 },
          { pid: 5124, name: 'msedgewebview2.exe', label: 'Motor UI', category: 'webview', role: 'webview', memoryBytes: 220 * 1024 * 1024 },
          { pid: 6200, name: 'node.exe', label: 'Antigravity CLI Agent', category: 'terminals', role: 'agent', sessionId: 'term-agent-orion', workspaceId: 'kite-core', memoryBytes: 200 * 1024 * 1024 },
          { pid: 6250, name: 'rustc.exe', label: 'Compilador Rust', category: 'terminals', role: 'build', sessionId: 'term-agent-orion', workspaceId: 'kite-core', memoryBytes: 300 * 1024 * 1024 },
        ],
      },
    });

    const user = userEvent.setup();
    render(<SystemResourceBadge />);

    await waitFor(() => {
      expect(screen.getByTestId('system-resource-ram-value')).toHaveTextContent('800 MB');
    });

    await user.click(screen.getByTestId('system-resource-badge'));
    await user.click(await screen.findByRole('tab', { name: 'RAM' }));

    // Verifies workspace grouping is shown by default when workspaces exist
    expect(screen.getByText('kite-core')).toBeInTheDocument();
    expect(screen.getByText('PID 6250')).toBeInTheDocument();
    expect(screen.getByText('Build')).toBeInTheDocument();

    // Switch to "Por Terminal" view
    await user.click(screen.getByRole('button', { name: /Por Terminal/i }));
    expect(screen.getByText(/Agente AI/i)).toBeInTheDocument();
    expect(screen.getByText(/Agente Antigravity/i)).toBeInTheDocument();

    // Switch to "Lista Completa" flat view
    await user.click(screen.getByRole('button', { name: /Lista Completa/i }));
    expect(screen.getByText('PID 6200')).toBeInTheDocument();
  });

  it('isolates popover scroll container on its own compositor layer without stacked backdrop-filter or nested scroll traps', async () => {
    const user = userEvent.setup();
    render(<SystemResourceBadge />);

    await waitFor(() => {
      expect(screen.getByTestId('system-resource-ram-value')).toHaveTextContent('480 MB');
    });

    await user.click(screen.getByTestId('system-resource-badge'));

    const dialog = await screen.findByRole('dialog', {
      name: /monitor de recursos del sistema y de la aplicación/i,
    });
    expect(dialog.style.backdropFilter).toBe('none');

    const scrollViewport = dialog.querySelector('.system-resource-popover__scroll') as HTMLElement | null;
    expect(scrollViewport).not.toBeNull();
    expect(scrollViewport?.style.willChange).toBe('scroll-position');
    expect(scrollViewport?.style.transform).toBe('translateZ(0)');

    // Switch to RAM tab and ensure process lists do not create nested overflow-y: auto scroll traps
    await user.click(screen.getByRole('tab', { name: 'RAM' }));
    const nestedAutoScrollers = Array.from(scrollViewport?.querySelectorAll('*') ?? []).filter(
      (el) => (el as HTMLElement).style?.overflowY === 'auto'
    );
    expect(nestedAutoScrollers).toHaveLength(0);

    // Must use an opaque solid plate instead of translucent --glass-modal-bg / --glass-overlay-bg
    expect(dialog.style.background).toContain('var(--menu-plate');
    expect(dialog.style.background).not.toContain('var(--glass-modal-bg');
    expect(dialog.style.background).not.toContain('var(--glass-overlay-bg');

    const fsSpecifier = ['node', 'fs'].join(':');
    const fs = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (filePath: string, encoding: 'utf8') => string;
    };
    const visualLangCss = fs.readFileSync('src/visual-language.css', 'utf8');
    const popoverRule =
      visualLangCss.match(/body\.kite-app \.system-resource-popover\s*\{[^}]*\}/)?.[0] ?? '';
    expect(popoverRule).toContain('var(--menu-plate');
    expect(popoverRule).not.toContain('var(--glass-modal-bg');
    expect(popoverRule).not.toContain('var(--glass-overlay-bg');
  });
});
