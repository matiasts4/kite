import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { PaneDragOverlay } from './PaneDragOverlay';

describe('PaneDragOverlay', () => {
  beforeEach(() => {
    // Setup mock panels in DOM
    document.body.innerHTML = `
      <div class="workspace-tab-layer workspace-tab-layer--active">
        <div class="code-pane-panel" data-leaf-id="leaf-1" style="position: absolute; left: 0px; top: 0px; width: 400px; height: 400px;"></div>
        <div class="code-pane-panel" data-leaf-id="leaf-2" style="position: absolute; left: 400px; top: 0px; width: 400px; height: 400px;"></div>
      </div>
    `;

    // Mock getBoundingClientRect on mock panels
    const p1 = document.querySelector('[data-leaf-id="leaf-1"]')!;
    const p2 = document.querySelector('[data-leaf-id="leaf-2"]')!;

    vi.spyOn(p1, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 400,
      bottom: 400,
      width: 400,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    vi.spyOn(p2, 'getBoundingClientRect').mockReturnValue({
      left: 400,
      top: 0,
      right: 800,
      bottom: 400,
      width: 400,
      height: 400,
      x: 400,
      y: 0,
      toJSON: () => {},
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('remains inactive when pointer movement is below the 4px deadband', () => {
    const onDrop = vi.fn();
    const onCancel = vi.fn();

    render(
      <PaneDragOverlay
        sourceLeafId="leaf-1"
        sourceTitle="Terminal 1"
        initialPointerX={100}
        initialPointerY={100}
        onDrop={onDrop}
        onCancel={onCancel}
      />
    );

    // Micro-move of 2px
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 102, clientY: 101 }));
    });

    expect(screen.queryByTestId('pane-drag-overlay')).toBeNull();
  });

  it('activates and renders overlay when pointer moves >= 4px', () => {
    const onDrop = vi.fn();
    const onCancel = vi.fn();

    render(
      <PaneDragOverlay
        sourceLeafId="leaf-1"
        sourceTitle="Terminal 1"
        initialPointerX={100}
        initialPointerY={100}
        onDrop={onDrop}
        onCancel={onCancel}
      />
    );

    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 110, clientY: 110 }));
    });

    expect(screen.getByTestId('pane-drag-overlay')).toBeDefined();
    expect(screen.getByTestId('pane-drag-ghost-badge')).toBeDefined();
    expect(screen.getByText('Terminal 1')).toBeDefined();
  });

  it('cancels drag cleanly when Escape key is pressed', () => {
    const onDrop = vi.fn();
    const onCancel = vi.fn();

    render(
      <PaneDragOverlay
        sourceLeafId="leaf-1"
        sourceTitle="Terminal 1"
        initialPointerX={100}
        initialPointerY={100}
        onDrop={onDrop}
        onCancel={onCancel}
      />
    );

    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 120, clientY: 120 }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('detects drop target over leaf-2 and calls onDrop on pointerup', () => {
    const onDrop = vi.fn();
    const onCancel = vi.fn();

    render(
      <PaneDragOverlay
        sourceLeafId="leaf-1"
        sourceTitle="Terminal 1"
        initialPointerX={100}
        initialPointerY={100}
        onDrop={onDrop}
        onCancel={onCancel}
      />
    );

    // Move pointer over the right 5% of leaf-2 (x = 780, y = 200) -> edge: right
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 780, clientY: 200 }));
    });

    const preview = screen.getByTestId('pane-drag-preview');
    expect(preview).toBeDefined();
    expect(preview.dataset.edge).toBe('right');

    // Release mouse
    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup'));
    });

    expect(onDrop).toHaveBeenCalledWith('leaf-1', 'leaf-2', 'right');
  });

  it('detects center swap over leaf-2 when hovering middle zone', () => {
    const onDrop = vi.fn();
    const onCancel = vi.fn();

    render(
      <PaneDragOverlay
        sourceLeafId="leaf-1"
        sourceTitle="Terminal 1"
        initialPointerX={100}
        initialPointerY={100}
        onDrop={onDrop}
        onCancel={onCancel}
      />
    );

    // Move pointer over center of leaf-2 (x = 600, y = 200) -> edge: null (swap)
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 600, clientY: 200 }));
    });

    const preview = screen.getByTestId('pane-drag-preview');
    expect(preview).toBeDefined();
    expect(preview.dataset.edge).toBe('swap');

    // Release mouse
    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup'));
    });

    expect(onDrop).toHaveBeenCalledWith('leaf-1', 'leaf-2', null);
  });
});
