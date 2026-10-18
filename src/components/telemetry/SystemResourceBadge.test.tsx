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
    },
  }),
  isTauriEnvironment: vi.fn().mockReturnValue(true),
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
      screen.getByRole('dialog', { name: /monitor de recursos del sistema y de la aplicación/i })
    ).toBeInTheDocument();

    // Verifies process tree breakdown & system cards are shown
    expect(screen.getByText(/RAM Total de la Aplicación/i)).toBeInTheDocument();
    expect(screen.getByText(/Núcleo Rust \(Tauri Host\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Motor UI \(WebView2 \/ GPU\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Terminales PTY & Agentes/i)).toBeInTheDocument();
    expect(screen.getByText(/Procesador \(CPU\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Disco \(E:\\\)/i)).toBeInTheDocument();

    // Switch to CPU tab
    await user.click(screen.getByRole('tab', { name: 'CPU' }));
    expect(screen.getByText(/Carga de Procesador \(CPU\)/i)).toBeInTheDocument();
    expect(screen.getByText(/AMD Ryzen 9 16-Core Processor/i)).toBeInTheDocument();

    // Switch to Disk tab
    await user.click(screen.getByRole('tab', { name: 'Disco' }));
    expect(screen.getByText(/Almacenamiento Local \(E:\\\)/i)).toBeInTheDocument();

    // Toggle badge display mode to RAM + CPU
    await user.click(screen.getByRole('button', { name: 'RAM + CPU' }));
    expect(badgeBtn).toHaveTextContent('3.4%');
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
});
