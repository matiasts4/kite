import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  holdThreadSelection,
  registerNewThreadHandler,
  requestNewThread,
  resolveHeldThreadSelection,
} from './newThreadRequest';

describe('sidebar new thread request', () => {
  afterEach(() => {
    registerNewThreadHandler(() => undefined)();
    holdThreadSelection('clear-hold');
    resolveHeldThreadSelection(null, ['clear-hold']);
  });

  it('delivers a workspace id to the mounted thread session', () => {
    const onNewThread = vi.fn();
    const stop = registerNewThreadHandler(onNewThread);

    requestNewThread('ws-kite');

    expect(onNewThread).toHaveBeenCalledTimes(1);
    expect(onNewThread).toHaveBeenCalledWith('ws-kite');
    stop();
    requestNewThread('ws-other');
    expect(onNewThread).toHaveBeenCalledTimes(1);
  });

  it('keeps a request made before the thread session is mounted', () => {
    requestNewThread(null);
    const onNewThread = vi.fn();

    const stop = registerNewThreadHandler(onNewThread);

    expect(onNewThread).toHaveBeenCalledWith(null);
    stop();
  });

  it('keeps the previous selection when no new thread is held', () => {
    expect(resolveHeldThreadSelection('main', ['main', 'other'])).toBe('main');
    expect(resolveHeldThreadSelection('gone', ['main'])).toBe('main');
  });

  it('selects the held thread once the list includes it and does not jump away before that', () => {
    holdThreadSelection('created');

    expect(resolveHeldThreadSelection('main', ['main'])).toBe('main');
    expect(resolveHeldThreadSelection('main', ['main', 'created'])).toBe('created');
    expect(resolveHeldThreadSelection('created', ['main', 'created'])).toBe('created');
  });
});
