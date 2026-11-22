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

  it('portals inside an open <dialog> (Top Layer), offsets by containing block, and honors minWidth + closeOnSelect=false', () => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    dialog.open = true;
    dialog.style.transform = 'translateY(0px)';
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 50,
      right: 600,
      bottom: 550,
      width: 500,
      height: 500,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    });
    document.body.appendChild(dialog);

    const onSelect = vi.fn();
    render(
      <SelectMenu
        label="Labels"
        minWidth={220}
        closeOnSelect={false}
        value=""
        rows={[
          { id: 'Frontend', title: 'Frontend', selected: true },
          { id: 'Backend', title: 'Backend', selected: false },
        ]}
        onSelect={onSelect}
      />,
      { container: dialog }
    );

    const trigger = screen.getByRole('combobox', { name: 'Labels' });
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      left: 120,
      top: 90,
      right: 220,
      bottom: 118,
      width: 100,
      height: 28,
      x: 120,
      y: 90,
      toJSON: () => ({}),
    });

    fireEvent.click(trigger);

    const menu = dialog.querySelector('[data-select-menu]') as HTMLElement | null;
    expect(menu).toBeTruthy();
    expect(menu!.parentElement).toBe(dialog);
    expect(Number.parseInt(menu!.style.zIndex, 10)).toBeGreaterThanOrEqual(10200);
    expect(menu!.style.width).toBe('220px');
    expect(menu!.style.left).toBe('20px');
    expect(menu!.style.top).toBe('75px');

    fireEvent.click(screen.getByRole('option', { name: 'Backend' }));
    expect(onSelect).toHaveBeenCalledWith('Backend');
    // closeOnSelect={false} keeps menu open
    expect(dialog.querySelector('[data-select-menu]')).toBeTruthy();

    dialog.remove();
    vi.restoreAllMocks();
  });

  it('does not cross dialog[open] to outer transformed ancestors when settled', () => {
    const outer = document.createElement('div');
    outer.className = 'app-frame app-frame--scaled';
    outer.style.transform = 'scale(1)';
    vi.spyOn(outer, 'getBoundingClientRect').mockReturnValue({
      left: 50,
      top: 40,
      right: 1250,
      bottom: 840,
      width: 1200,
      height: 800,
      x: 50,
      y: 40,
      toJSON: () => ({}),
    });

    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    dialog.open = true;
    outer.appendChild(dialog);
    document.body.appendChild(outer);

    render(
      <SelectMenu
        label="NonGlass"
        value={null}
        rows={[{ id: 'a', title: 'Alpha' }]}
        onSelect={() => {}}
      />,
      { container: dialog }
    );

    const trigger = screen.getByRole('combobox', { name: 'NonGlass' });
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      left: 200,
      top: 150,
      right: 320,
      bottom: 180,
      width: 120,
      height: 30,
      x: 200,
      y: 150,
      toJSON: () => ({}),
    });

    fireEvent.click(trigger);
    const menu = dialog.querySelector('[data-select-menu]') as HTMLElement | null;
    expect(menu).toBeTruthy();
    expect(menu!.style.left).toBe('200px');
    expect(menu!.style.top).toBe('187px');

    outer.remove();
    vi.restoreAllMocks();
  });

  it('flips upward when a clipping containing-block dialog lacks space below', () => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    dialog.open = true;
    dialog.style.transform = 'translateY(0px)';
    dialog.style.overflowY = 'auto';
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 100,
      right: 660,
      bottom: 500,
      width: 560,
      height: 400,
      x: 100,
      y: 100,
      toJSON: () => ({}),
    });
    document.body.appendChild(dialog);

    render(
      <SelectMenu
        label="ClippedBottom"
        value={null}
        rows={[{ id: 'a', title: 'Alpha' }]}
        onSelect={() => {}}
      />,
      { container: dialog }
    );

    const bottomTrigger = screen.getByRole('combobox', { name: 'ClippedBottom' });
    vi.spyOn(bottomTrigger, 'getBoundingClientRect').mockReturnValue({
      left: 140,
      top: 440,
      right: 260,
      bottom: 468,
      width: 120,
      height: 28,
      x: 140,
      y: 440,
      toJSON: () => ({}),
    });

    fireEvent.click(bottomTrigger);
    const flippedMenu = dialog.querySelector('[data-select-menu]') as HTMLElement | null;
    expect(flippedMenu).toBeTruthy();
    expect(flippedMenu!.className).toContain('select-menu--from-bottom');

    dialog.remove();
    vi.restoreAllMocks();
  });
});
