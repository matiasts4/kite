import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

  it('ignores internal list scroll events without re-measuring trigger geometry', () => {
    render(
      <SelectMenu
        label="Modelo"
        value="alpha"
        rows={[
          { id: 'alpha', title: 'Alpha' },
          { id: 'beta', title: 'Beta' },
        ]}
        onSelect={() => {}}
      />
    );

    const trigger = screen.getByRole('combobox', { name: 'Modelo' });
    const rectSpy = vi.spyOn(trigger, 'getBoundingClientRect');

    fireEvent.click(trigger);
    expect(rectSpy).toHaveBeenCalled();

    rectSpy.mockClear();

    const rowsEl = document.querySelector('.select-menu__rows') as HTMLElement | null;
    expect(rowsEl).toBeTruthy();
    fireEvent.scroll(rowsEl!);

    expect(rectSpy).not.toHaveBeenCalled();
  });

  it('does not force maxHeight="none" during measurement and supports searchable keyboard selection', () => {
    const onSelect = vi.fn();
    const assignedMaxHeights: string[] = [];
    const maxHeightDesc = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'maxHeight');

    render(
      <SelectMenu
        label="Modelo"
        searchable
        value="alpha"
        rows={[
          { id: 'alpha', title: 'Alpha' },
          { id: 'beta', title: 'Beta' },
          { id: 'gamma', title: 'Gamma' },
        ]}
        onSelect={onSelect}
      />
    );

    if (maxHeightDesc?.set) {
      vi.spyOn(CSSStyleDeclaration.prototype, 'maxHeight', 'set').mockImplementation(function (
        this: CSSStyleDeclaration,
        val: string
      ) {
        assignedMaxHeights.push(val);
        maxHeightDesc.set!.call(this, val);
      });
    }

    fireEvent.click(screen.getByRole('combobox', { name: 'Modelo' }));

    expect(assignedMaxHeights).not.toContain('none');

    const searchInput = screen.getByRole('combobox', { name: 'Search models' });
    fireEvent.change(searchInput, { target: { value: 'gam' } });
    fireEvent.keyDown(searchInput, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('gamma');
    vi.restoreAllMocks();
  });
});
