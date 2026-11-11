import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SelectMenu } from './SelectMenu';

describe('SelectMenu overlay stacking', () => {
  it('paints the open list above a fixed modal ancestor', () => {
    const host = document.createElement('div');
    host.className = 'settings-modal-backdrop';
    host.style.position = 'fixed';
    host.style.zIndex = '10000';
    document.body.appendChild(host);

    render(
      <SelectMenu
        label="Modelo"
        value={null}
        rows={[{ id: 'alpha', title: 'Alpha' }]}
        onSelect={() => {}}
      />,
      { container: host }
    );

    fireEvent.click(screen.getByRole('combobox', { name: 'Modelo' }));

    const menu = document.querySelector('[data-select-menu]');
    expect(menu).toBeTruthy();
    expect(Number.parseInt((menu as HTMLElement).style.zIndex, 10)).toBeGreaterThan(10000);
    host.remove();
  });
});
