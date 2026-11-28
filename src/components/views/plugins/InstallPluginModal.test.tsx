import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InstallPluginModal } from './InstallPluginModal';
import * as pluginRuntime from '../../../lib/ipc/pluginRuntime';

vi.mock('../../../lib/ipc/pluginRuntime', () => ({
  pickPluginInstallPath: vi.fn(),
}));

describe('InstallPluginModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders 3 source tabs and validates empty input before submitting', async () => {
    const user = userEvent.setup();
    const onInstallFolder = vi.fn();

    render(
      <InstallPluginModal
        open={true}
        onClose={vi.fn()}
        onInstallFolder={onInstallFolder}
        onInstallGit={vi.fn()}
        onInstallArchive={vi.fn()}
      />
    );

    expect(screen.getByRole('tab', { name: 'Carpeta local' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('tab', { name: 'Repositorio Git' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Archivo .zip' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Instalar extensión' }));
    expect(onInstallFolder).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/carpeta local/i);
  });

  it('picks local folder via pickPluginInstallPath("folder"), shows loading state, and closes on success', async () => {
    const user = userEvent.setup();
    vi.mocked(pluginRuntime.pickPluginInstallPath).mockResolvedValueOnce(
      'C:\\plugins\\my-extension'
    );

    let resolveInstall!: (val: unknown) => void;
    const onInstallFolder = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveInstall = resolve;
        })
    );
    const onClose = vi.fn();

    render(
      <InstallPluginModal
        open={true}
        onClose={onClose}
        onInstallFolder={onInstallFolder}
        onInstallGit={vi.fn()}
        onInstallArchive={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Examinar...' }));
    expect(pluginRuntime.pickPluginInstallPath).toHaveBeenCalledWith('folder');
    expect(screen.getByLabelText('Ruta de la carpeta local')).toHaveValue(
      'C:\\plugins\\my-extension'
    );

    await user.click(screen.getByRole('button', { name: 'Instalar extensión' }));
    expect(onInstallFolder).toHaveBeenCalledWith('C:\\plugins\\my-extension');
    expect(screen.getByRole('button', { name: 'Instalando...' })).toBeDisabled();

    resolveInstall({});
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('installs from Git repository with optional branch/ref and subfolder', async () => {
    const user = userEvent.setup();
    const onInstallGit = vi.fn().mockResolvedValue({});
    const onClose = vi.fn();

    render(
      <InstallPluginModal
        open={true}
        onClose={onClose}
        onInstallFolder={vi.fn()}
        onInstallGit={onInstallGit}
        onInstallArchive={vi.fn()}
      />
    );

    await user.click(screen.getByRole('tab', { name: 'Repositorio Git' }));
    await user.type(
      screen.getByLabelText('URL del repositorio Git'),
      'https://github.com/example/plugin-repo.git'
    );
    await user.type(screen.getByLabelText('Rama o tag (opcional)'), 'v2.0');
    await user.type(
      screen.getByLabelText('Subcarpeta (opcional)'),
      'packages/device-hub'
    );

    await user.click(screen.getByRole('button', { name: 'Instalar extensión' }));

    await waitFor(() => {
      expect(onInstallGit).toHaveBeenCalledWith(
        'https://github.com/example/plugin-repo.git',
        { gitRef: 'v2.0', subdir: 'packages/device-hub' }
      );
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('picks archive via pickPluginInstallPath("archive") and surfaces backend install errors', async () => {
    const user = userEvent.setup();
    vi.mocked(pluginRuntime.pickPluginInstallPath).mockResolvedValueOnce(
      'C:\\downloads\\bundle.zip'
    );
    const onInstallArchive = vi
      .fn()
      .mockRejectedValue(new Error('El archivo ZIP no contiene un manifiesto válido.'));
    const onClose = vi.fn();

    render(
      <InstallPluginModal
        open={true}
        onClose={onClose}
        onInstallFolder={vi.fn()}
        onInstallGit={vi.fn()}
        onInstallArchive={onInstallArchive}
      />
    );

    await user.click(screen.getByRole('tab', { name: 'Archivo .zip' }));
    await user.click(screen.getByRole('button', { name: 'Examinar...' }));
    expect(pluginRuntime.pickPluginInstallPath).toHaveBeenCalledWith('archive');

    await user.click(screen.getByRole('button', { name: 'Instalar extensión' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'El archivo ZIP no contiene un manifiesto válido.'
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
