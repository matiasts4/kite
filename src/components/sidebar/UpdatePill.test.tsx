import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpdateCircularButton, UpdateDetailCard, UpdatePill } from './UpdatePill';
import * as updaterHook from '../../hooks/useAppUpdater';

vi.mock('../../hooks/useAppUpdater', () => ({
  useAppUpdater: vi.fn(),
  checkSilently: vi.fn(),
}));

describe('Update Components - Cursor-inspired Update Experience', () => {
  const mockUpdateAndRestart = vi.fn();
  const mockRestart = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when status is idle or uptodate', () => {
    vi.mocked(updaterHook.useAppUpdater).mockReturnValue({
      state: { status: 'idle' },
      currentVersion: '0.1.0',
      isAvailable: false,
      isDownloading: false,
      isReady: false,
      check: vi.fn(),
      install: vi.fn(),
      restart: mockRestart,
      updateAndRestart: mockUpdateAndRestart,
      clearError: vi.fn(),
    });

    const { container } = render(
      <>
        <UpdateCircularButton />
        <UpdateDetailCard isOpen={true} onClose={vi.fn()} />
      </>
    );

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('update-circular-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('update-detail-card')).not.toBeInTheDocument();
  });

  it('renders circular button and detail card with version and notes when update is available', async () => {
    const user = userEvent.setup();
    const onToggleDetails = vi.fn();

    vi.mocked(updaterHook.useAppUpdater).mockReturnValue({
      state: {
        status: 'available',
        version: '0.1.2',
        notes: 'Fixes terminal render and memory usage.',
      },
      currentVersion: '0.1.0',
      isAvailable: true,
      isDownloading: false,
      isReady: false,
      check: vi.fn(),
      install: vi.fn(),
      restart: mockRestart,
      updateAndRestart: mockUpdateAndRestart,
      clearError: vi.fn(),
    });

    render(
      <>
        <UpdateCircularButton onToggleDetails={onToggleDetails} isDetailsOpen={false} />
        <UpdateDetailCard isOpen={true} onClose={vi.fn()} />
      </>
    );

    // Circular Button
    const circularBtn = screen.getByTestId('update-circular-button');
    expect(circularBtn).toBeInTheDocument();
    expect(circularBtn).toHaveAttribute('title', expect.stringContaining('v0.1.2'));

    // Clicking circular button invokes toggle
    await user.click(circularBtn);
    expect(onToggleDetails).toHaveBeenCalledTimes(1);

    // Detail Card
    expect(screen.getByTestId('update-detail-card')).toBeInTheDocument();
    expect(screen.getByText('v0.1.2')).toBeInTheDocument();
    expect(screen.getByText('Fixes terminal render and memory usage.')).toBeInTheDocument();

    const actionBtn = screen.getByRole('button', { name: /Actualizar y reiniciar/i });
    expect(actionBtn).toBeInTheDocument();

    await user.click(actionBtn);
    expect(mockUpdateAndRestart).toHaveBeenCalledTimes(1);
  });

  it('displays percentage progress when downloading', () => {
    vi.mocked(updaterHook.useAppUpdater).mockReturnValue({
      state: { status: 'downloading', percent: 64 },
      currentVersion: '0.1.0',
      isAvailable: false,
      isDownloading: true,
      isReady: false,
      check: vi.fn(),
      install: vi.fn(),
      restart: mockRestart,
      updateAndRestart: mockUpdateAndRestart,
      clearError: vi.fn(),
    });

    render(
      <>
        <UpdateCircularButton />
        <UpdateDetailCard isOpen={true} onClose={vi.fn()} />
      </>
    );

    // Both button and card show percentage
    expect(screen.getByText('64')).toBeInTheDocument();
    expect(screen.getByText(/64% descargado/i)).toBeInTheDocument();
  });

  it('renders ready state with green restart button and triggers restart on click', async () => {
    const user = userEvent.setup();

    vi.mocked(updaterHook.useAppUpdater).mockReturnValue({
      state: { status: 'ready', version: '0.1.2' },
      currentVersion: '0.1.0',
      isAvailable: false,
      isDownloading: false,
      isReady: true,
      check: vi.fn(),
      install: vi.fn(),
      restart: mockRestart,
      updateAndRestart: mockUpdateAndRestart,
      clearError: vi.fn(),
    });

    render(
      <>
        <UpdateCircularButton isDetailsOpen={false} />
        <UpdateDetailCard isOpen={true} onClose={vi.fn()} />
      </>
    );

    const circularBtn = screen.getByTestId('update-circular-button');
    expect(circularBtn).toHaveClass('update-circular-btn--ready');

    // Clicking circular button in ready state restarts the app
    await user.click(circularBtn);
    expect(mockRestart).toHaveBeenCalledTimes(1);

    // Clicking restart button inside card also calls restart
    const restartBtn = screen.getByRole('button', { name: /Reiniciar para aplicar/i });
    await user.click(restartBtn);
    expect(mockRestart).toHaveBeenCalledTimes(2);
  });

  it('allows dismissing the detail card via close button', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    vi.mocked(updaterHook.useAppUpdater).mockReturnValue({
      state: { status: 'available', version: '0.1.2' },
      currentVersion: '0.1.0',
      isAvailable: true,
      isDownloading: false,
      isReady: false,
      check: vi.fn(),
      install: vi.fn(),
      restart: mockRestart,
      updateAndRestart: mockUpdateAndRestart,
      clearError: vi.fn(),
    });

    render(<UpdateDetailCard isOpen={true} onClose={onClose} />);

    const closeBtn = screen.getByLabelText('Cerrar panel de actualización');
    await user.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('UpdatePill standalone wrapper works properly', () => {
    vi.mocked(updaterHook.useAppUpdater).mockReturnValue({
      state: { status: 'available', version: '0.1.2' },
      currentVersion: '0.1.0',
      isAvailable: true,
      isDownloading: false,
      isReady: false,
      check: vi.fn(),
      install: vi.fn(),
      restart: mockRestart,
      updateAndRestart: mockUpdateAndRestart,
      clearError: vi.fn(),
    });

    render(<UpdatePill />);
    expect(screen.getByTestId('update-detail-card')).toBeInTheDocument();
  });

  it('renders resilient error state with retry button when update fails', async () => {
    const user = userEvent.setup();

    vi.mocked(updaterHook.useAppUpdater).mockReturnValue({
      state: {
        status: 'error',
        error: { code: 'net_err', message: 'No se pudo conectar con el servidor de descargas', detail: '10061' },
      },
      currentVersion: '0.1.0',
      isAvailable: false,
      isDownloading: false,
      isReady: false,
      check: vi.fn(),
      install: vi.fn(),
      restart: mockRestart,
      updateAndRestart: mockUpdateAndRestart,
      clearError: vi.fn(),
    });

    render(
      <>
        <UpdateCircularButton />
        <UpdateDetailCard isOpen={true} onClose={vi.fn()} />
      </>
    );

    const circularBtn = screen.getByTestId('update-circular-button');
    expect(circularBtn).toBeInTheDocument();
    expect(circularBtn).toHaveClass('update-circular-btn--error');

    expect(screen.getByText('Aviso de actualización')).toBeInTheDocument();
    expect(screen.getByText(/No se pudo conectar con el servidor de descargas/i)).toBeInTheDocument();

    const retryBtn = screen.getByRole('button', { name: /Reintentar actualización/i });
    expect(retryBtn).toBeInTheDocument();

    await user.click(retryBtn);
    expect(mockUpdateAndRestart).toHaveBeenCalledTimes(1);
  });
});
