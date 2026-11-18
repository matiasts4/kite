import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

    expect(screen.getByText('Atajos de teclado')).toBeDefined();
    expect(screen.getByText('Navegación')).toBeDefined();
    expect(screen.getByText('Modos')).toBeDefined();
    expect(screen.getByText('Terminal y Código')).toBeDefined();
    expect(screen.getByText('Voz')).toBeDefined();
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

  it('filters by key sequence and restores all categories when cleared', async () => {
    render(<KeybindingsTab platform="windows" />);

    const searchInput = screen.getByPlaceholderText(/Buscar atajos/) as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: 'Agent mode' } });
    expect(searchInput.value).toBe('Agent mode');

    await waitFor(() => {
      expect(screen.getByText('Switch to Agent mode')).toBeDefined();
      expect(screen.queryByText('Toggle lateral sidebar')).toBeNull();
    });

    fireEvent.change(searchInput, { target: { value: '' } });

    await waitFor(() => {
      expect(screen.getByText('Toggle lateral sidebar')).toBeDefined();
      expect(screen.getByText('Switch to Agent mode')).toBeDefined();
    });
  });
});
