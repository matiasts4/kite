import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyHostBox, waitForStableHost } from './terminalHostSize';

describe('classifyHostBox', () => {
  it('ignores a host that cannot hold a terminal grid', () => {
    expect(classifyHostBox(null, 0, 0)).toEqual({ kind: 'ignore' });
    expect(classifyHostBox(null, 47, 400)).toEqual({ kind: 'ignore' });
    expect(classifyHostBox({ width: 320, height: 180 }, 320, 20)).toEqual({ kind: 'ignore' });
  });

  it('treats the first usable box as a change and the same box as stable', () => {
    expect(classifyHostBox(null, 320, 180)).toEqual({
      kind: 'changed',
      box: { width: 320, height: 180 },
    });
    expect(classifyHostBox({ width: 320, height: 180 }, 320, 180)).toEqual({
      kind: 'stable',
      box: { width: 320, height: 180 },
    });
  });

  it('treats a later resize as a change', () => {
    expect(classifyHostBox({ width: 320, height: 180 }, 200, 180).kind).toBe('changed');
  });
});

describe('waitForStableHost', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('resolves only after the same box survives the confirm beat', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      return setTimeout(() => cb(0), 0) as unknown as number;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));

    const el = { clientWidth: 300, clientHeight: 160 } as HTMLElement;
    const pending = waitForStableHost(el, () => false);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ width: 300, height: 160 });
  });

  it('returns null when cancelled before the size settles', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      return setTimeout(() => cb(0), 0) as unknown as number;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));

    const el = { clientWidth: 300, clientHeight: 160 } as HTMLElement;
    let cancel = false;
    const pending = waitForStableHost(el, () => cancel);
    cancel = true;
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeNull();
  });
});
