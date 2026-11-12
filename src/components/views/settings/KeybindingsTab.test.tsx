import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KeybindingsTab } from './KeybindingsTab';
import { saveShortcut, resetAllShortcuts } from '../../../lib/shortcuts/shortcutsRegistry';

describe('KeybindingsTab', () => {
  beforeEach(() => {
    localStorage.clear();
    resetAllShortcuts();
    vi.restoreAllMocks();
  });

  it('renders all keybinding categories and actions', () => {
    render(<KeybindingsTab platform="windows" />);

    expect(screen.getByText('Keyboard Shortcuts')).toBeDefined();
    expect(screen.getByText('Navigation')).toBeDefined();
    expect(screen.getByText('Modes')).toBeDefined();
    expect(screen.getByText('Terminal & Code')).toBeDefined();
    expect(screen.getByText('Voice')).toBeDefined();
    expect(screen.getByText('Toggle lateral sidebar')).toBeDefined();
    expect(screen.getByText('Switch to Agent mode')).toBeDefined();
  });

  it('filters shortcuts using search input', () => {
    render(<KeybindingsTab platform="windows" />);

    const searchInput = screen.getByPlaceholderText(/Buscar atajos/);
    fireEvent.change(searchInput, { target: { value: 'sidebar' } });

    expect(screen.getByText('Toggle lateral sidebar')).toBeDefined();
    expect(screen.queryByText('Switch to Agent mode')).toBeNull();
  });

  it('opens ShortcutRecordModal when clicking Edit button', () => {
    render(<KeybindingsTab platform="windows" />);

    const editButtons = screen.getAllByRole('button', { name: 'Editar' });
    fireEvent.click(editButtons[0]);

    expect(screen.getByText('Editar atajo de teclado')).toBeDefined();
  });

  it('shows Personalizado badge when shortcut has been customized', () => {
    saveShortcut('toggle-sidebar', ['Ctrl', 'Shift', 'X'], 'windows');

    render(<KeybindingsTab platform="windows" />);

    expect(screen.getByText('Personalizado')).toBeDefined();
    expect(screen.getByText('X')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Restablecer' })).toBeDefined();
  });

  it('restores defaults when clicking Restablecer todos', () => {
    saveShortcut('toggle-sidebar', ['Ctrl', 'Shift', 'X'], 'windows');

    render(<KeybindingsTab platform="windows" />);

    const resetAllBtn = screen.getByRole('button', { name: /Restablecer todos/ });
    fireEvent.click(resetAllBtn);

    expect(screen.queryByText('Personalizado')).toBeNull();
    expect(screen.queryByText('X')).toBeNull();
  });
});
