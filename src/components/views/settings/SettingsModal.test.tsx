import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsView, SettingsModal } from '../SettingsView';

describe('SettingsModal / SettingsView as Modal', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
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

    // Header updates to Shortcuts
    expect(screen.getByRole('heading', { level: 2, name: 'Shortcuts' })).toBeInTheDocument();
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

    // Open AddProviderModal
    const addBtns = screen.getAllByRole('button', { name: /\+ agregar proveedor/i });
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
});
