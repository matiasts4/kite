import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ShortcutRecordModal } from './ShortcutRecordModal';
import { ShortcutItem } from '../../lib/shortcuts/types';

describe('ShortcutRecordModal', () => {
  const dummyShortcut: ShortcutItem = {
    id: 'toggle-sidebar',
    category: 'Navigation',
    action: 'Toggle lateral sidebar',
    description: 'Show or hide the primary left navigation sidebar.',
    defaultKeys: ['Ctrl', 'B'],
  };

  it('renders modal when open with shortcut details', () => {
    render(
      <ShortcutRecordModal
        isOpen={true}
        shortcut={dummyShortcut}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onReset={vi.fn()}
        platform="windows"
      />
    );

    expect(screen.getByText('Editar atajo de teclado')).toBeDefined();
    expect(screen.getByText(/Toggle lateral sidebar/)).toBeDefined();
    expect(screen.getByText('Ctrl')).toBeDefined();
    expect(screen.getByText('B')).toBeDefined();
  });

  it('records new key combination when user presses keys', () => {
    const onSave = vi.fn();
    render(
      <ShortcutRecordModal
        isOpen={true}
        shortcut={dummyShortcut}
        onClose={vi.fn()}
        onSave={onSave}
        onReset={vi.fn()}
        platform="windows"
      />
    );

    // Press Ctrl+Shift+X
    fireEvent.keyDown(window, {
      key: 'x',
      ctrlKey: true,
      shiftKey: true,
    });

    expect(screen.getByText('X')).toBeDefined();
    expect(screen.getByText('Shift')).toBeDefined();

    // Click "Guardar atajo"
    const saveButton = screen.getByRole('button', { name: 'Guardar atajo' });
    expect(saveButton).toBeDefined();
    fireEvent.click(saveButton);

    expect(onSave).toHaveBeenCalledWith('toggle-sidebar', ['Ctrl', 'Shift', 'X']);
  });

  it('shows error banner and disables save button when reserved system shortcut is pressed', () => {
    render(
      <ShortcutRecordModal
        isOpen={true}
        shortcut={dummyShortcut}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onReset={vi.fn()}
        platform="windows"
      />
    );

    // Press Alt+F4 (reserved by Windows)
    fireEvent.keyDown(window, {
      key: 'F4',
      altKey: true,
    });

    expect(screen.getByText(/Atajo reservado \(Windows\)/)).toBeDefined();
    const saveButton = screen.getByRole('button', { name: 'Guardar atajo' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });

  it('shows conflict warning when pressing combination already used by another shortcut', () => {
    render(
      <ShortcutRecordModal
        isOpen={true}
        shortcut={dummyShortcut} // 'toggle-sidebar'
        onClose={vi.fn()}
        onSave={vi.fn()}
        onReset={vi.fn()}
        platform="windows"
      />
    );

    // 'mode-agent' uses Ctrl+1 by default
    fireEvent.keyDown(window, {
      key: '1',
      ctrlKey: true,
    });

    expect(screen.getByText(/Conflicto detectado/)).toBeDefined();
    expect(screen.getByText(/Switch to Agent mode/)).toBeDefined();
  });

  it('calls onReset when clicking default button', () => {
    const onReset = vi.fn();
    const onClose = vi.fn();
    render(
      <ShortcutRecordModal
        isOpen={true}
        shortcut={{
          ...dummyShortcut,
          customKeys: ['Ctrl', 'Shift', 'Z'],
        }}
        onClose={onClose}
        onSave={vi.fn()}
        onReset={onReset}
        platform="windows"
      />
    );

    const defaultBtn = screen.getByRole('button', { name: /Por defecto/ });
    fireEvent.click(defaultBtn);

    expect(onReset).toHaveBeenCalledWith('toggle-sidebar');
    expect(onClose).toHaveBeenCalled();
  });
});
