import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { invokeSpy, defaultInvokeRef } = vi.hoisted(() => ({
  invokeSpy: vi.fn(),
  defaultInvokeRef: {
    fn: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>),
  },
}));

vi.mock('../../../lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/ipc')>();
  defaultInvokeRef.fn = actual.invokeCommand as (
    cmd: string,
    args?: Record<string, unknown>
  ) => Promise<unknown>;
  invokeSpy.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
    actual.invokeCommand(cmd, args)
  );
  return {
    ...actual,
    invokeCommand: invokeSpy,
  };
});

import { SettingsView, SettingsModal, resetSettingsDictationCache } from '../SettingsView';

const DICTATION_COMMANDS = new Set([
  'read_dictation_availability',
  'read_dictation_settings',
  'list_dictation_input_devices',
]);

describe('SettingsModal / SettingsView as Modal', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSettingsDictationCache();
    invokeSpy.mockReset();
    invokeSpy.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (defaultInvokeRef.fn) {
        return defaultInvokeRef.fn(cmd, args);
      }
      return Promise.resolve(undefined);
    });
  });

  it('exports SettingsModal as an alias of SettingsView', () => {
    expect(SettingsModal).toBe(SettingsView);
  });

  it('renders nothing when isOpen is false', () => {
    const { container } = render(<SettingsModal isOpen={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders as a modal dialog with backdrop when isOpen is true', () => {
    render(<SettingsModal isOpen={true} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('settings-modal-backdrop')).toBeInTheDocument();
  });

  it('calls onClose when clicking the modal close button', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SettingsModal isOpen={true} onClose={onClose} />);

    const closeBtn = screen.getByRole('button', { name: /Cerrar modal de configuración/i });
    await user.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when clicking the sidebar Close button', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SettingsModal isOpen={true} onClose={onClose} />);

    const sidebarCloseBtn = screen.getByRole('button', { name: /Close settings/i });
    await user.click(sidebarCloseBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when pressing the Escape key', () => {
    const onClose = vi.fn();
    render(<SettingsModal isOpen={true} onClose={onClose} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when clicking on the backdrop scrim', () => {
    const onClose = vi.fn();
    render(<SettingsModal isOpen={true} onClose={onClose} />);

    const backdrop = screen.getByTestId('settings-modal-backdrop');
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose when clicking inside the dialog content', () => {
    const onClose = vi.fn();
    render(<SettingsModal isOpen={true} onClose={onClose} />);

    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('allows switching tabs inside the modal', async () => {
    const user = userEvent.setup();
    render(<SettingsModal isOpen={true} onClose={vi.fn()} />);

    // Click on Shortcuts tab
    const shortcutsTab = screen.getByRole('button', { name: /Shortcuts/i });
    await user.click(shortcutsTab);

    // Header updates to Shortcuts and lazy chunk resolves
    expect(screen.getByRole('heading', { level: 2, name: 'Shortcuts' })).toBeInTheDocument();
    expect(
      await screen.findByText('Keyboard Shortcuts', {}, { timeout: 5000 })
    ).toBeInTheDocument();
  });

  it('portals into .app-frame--scaled when present in the DOM', () => {
    const frame = document.createElement('div');
    frame.className = 'app-frame app-frame--scaled';
    document.body.appendChild(frame);

    render(<SettingsModal isOpen={true} onClose={vi.fn()} />);
    const backdrop = screen.getByTestId('settings-modal-backdrop');
    expect(frame.contains(backdrop)).toBe(true);

    document.body.removeChild(frame);
  });

  it('does not close settings modal when an open submodal intercepts Escape', async () => {
    const onCloseSettings = vi.fn();
    const user = userEvent.setup();

    render(<SettingsModal isOpen={true} onClose={onCloseSettings} />);

    // Switch to Cuentas y Proveedores tab
    const quotasTab = screen.getByRole('button', { name: /Cuentas y Proveedores/i });
    await user.click(quotasTab);

    // Open AddProviderModal once lazy QuotasTab resolves
    const addBtns = await screen.findAllByRole(
      'button',
      { name: /\+ agregar proveedor/i },
      { timeout: 5000 }
    );
    await user.click(addBtns[0]);

    // Verify AddProviderModal is in the document
    expect(screen.getByText('Agregar proveedores de IA')).toBeInTheDocument();

    // Press Escape - should close only AddProviderModal, not SettingsModal
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onCloseSettings).not.toHaveBeenCalled();
    expect(screen.queryByText('Agregar proveedores de IA')).toBeNull();

    // Now that the submodal is closed, pressing Escape closes SettingsModal
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCloseSettings).toHaveBeenCalledTimes(1);
  });

  it('defers Voice dictation IPC discovery when closed or opening on non-Voice tabs', async () => {
    const user = userEvent.setup();

    const { rerender } = render(<SettingsModal isOpen={false} onClose={vi.fn()} />);
    expect(
      invokeSpy.mock.calls.filter(([cmd]) => DICTATION_COMMANDS.has(String(cmd)))
    ).toHaveLength(0);

    rerender(<SettingsModal isOpen={true} onClose={vi.fn()} initialTab="general" />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: 'General' })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Cuentas y Proveedores/i }));
    await screen.findAllByRole('button', { name: /\+ agregar proveedor/i }, { timeout: 5000 });

    expect(
      invokeSpy.mock.calls.filter(([cmd]) => DICTATION_COMMANDS.has(String(cmd)))
    ).toHaveLength(0);
  });

  it('loads Voice dictation IPC once on switching to Voice and reuses cached state on reopen', async () => {
    const user = userEvent.setup();

    invokeSpy.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'read_dictation_availability') {
        return Promise.resolve({
          state: 'available',
          canRequestPermission: false,
          canStart: true,
          guidance: 'Ready',
          localEngines: [],
        });
      }
      if (cmd === 'read_dictation_settings') {
        return Promise.resolve({
          schemaVersion: 1,
          mode: 'local',
          localEngine: null,
          language: 'auto',
          deviceId: 'mic-1',
          cuesEnabled: true,
          shortcut: { kind: 'standard' },
        });
      }
      if (cmd === 'list_dictation_input_devices') {
        return Promise.resolve({
          devices: [{ id: 'mic-1', name: 'Studio Mic', isBluetooth: false }],
          selectedId: 'mic-1',
        });
      }
      return defaultInvokeRef.fn ? defaultInvokeRef.fn(cmd, args) : Promise.resolve(undefined);
    });

    const { unmount } = render(
      <SettingsModal isOpen={true} onClose={vi.fn()} initialTab="general" />
    );

    expect(
      invokeSpy.mock.calls.filter(([cmd]) => DICTATION_COMMANDS.has(String(cmd)))
    ).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /Voice & Dictado/i }));

    await waitFor(
      () => {
        const dictationCalls = invokeSpy.mock.calls.map(([cmd]) => String(cmd));
        expect(dictationCalls.filter((c) => c === 'read_dictation_availability')).toHaveLength(1);
        expect(dictationCalls.filter((c) => c === 'read_dictation_settings')).toHaveLength(1);
        expect(dictationCalls.filter((c) => c === 'list_dictation_input_devices')).toHaveLength(1);
      },
      { timeout: 5000 }
    );
    expect(
      await screen.findByText('Voice privacy', {}, { timeout: 5000 })
    ).toBeInTheDocument();

    unmount();

    render(<SettingsModal isOpen={true} onClose={vi.fn()} initialTab="voice" />);
    expect(
      await screen.findByText('Voice privacy', {}, { timeout: 5000 })
    ).toBeInTheDocument();

    const dictationCallsAfterReopen = invokeSpy.mock.calls.map(([cmd]) => String(cmd));
    expect(
      dictationCallsAfterReopen.filter((c) => c === 'read_dictation_availability')
    ).toHaveLength(1);
    expect(
      dictationCallsAfterReopen.filter((c) => c === 'read_dictation_settings')
    ).toHaveLength(1);
    expect(
      dictationCallsAfterReopen.filter((c) => c === 'list_dictation_input_devices')
    ).toHaveLength(1);
  });
});
