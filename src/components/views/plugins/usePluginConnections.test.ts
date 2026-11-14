import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  PLUGIN_CONNECTIONS_POLL_MS,
  usePluginConnections,
  areConnectionsEqual,
} from './usePluginConnections';
import { invoke } from '@tauri-apps/api/core';
import type { PluginConnection } from './types';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('usePluginConnections', () => {
  const mockInvoke = vi.mocked(invoke);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('queries plugin_connections on mount and marks ready', async () => {
    const mockConnections: PluginConnection[] = [
      { id: 'github', state: 'connected', account: 'octocat', message: null },
      { id: 'slack', state: 'disconnected', account: null, message: null },
    ];
    mockInvoke.mockResolvedValueOnce(mockConnections);

    const { result } = renderHook(() => usePluginConnections());

    expect(result.current.ready).toBe(false);

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockInvoke).toHaveBeenCalledWith('plugin_connections');
    expect(result.current.ready).toBe(true);
    expect(result.current.connections).toEqual(mockConnections);
  });

  it('polls at gentle idle interval (15000ms) when visible and focused', async () => {
    mockInvoke.mockResolvedValue([]);

    renderHook(() => usePluginConnections());

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // Must not poll after old 2000ms interval
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // Fast-forward remainder to 15000ms
    await act(async () => {
      vi.advanceTimersByTime(PLUGIN_CONNECTIONS_POLL_MS - 2000);
      await Promise.resolve();
    });
    expect(mockInvoke).toHaveBeenCalledTimes(2);

    // Fast-forward another 15000ms
    await act(async () => {
      vi.advanceTimersByTime(PLUGIN_CONNECTIONS_POLL_MS);
      await Promise.resolve();
    });
    expect(mockInvoke).toHaveBeenCalledTimes(3);
  });

  it('suspends polling when document.hidden is true or window loses focus', async () => {
    mockInvoke.mockResolvedValue([]);

    renderHook(() => usePluginConnections());

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // Document hidden skips interval polls
    const hiddenSpy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => {
      vi.advanceTimersByTime(PLUGIN_CONNECTIONS_POLL_MS);
      await Promise.resolve();
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    hiddenSpy.mockRestore();

    // Document loses focus
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);

    await act(async () => {
      vi.advanceTimersByTime(PLUGIN_CONNECTIONS_POLL_MS);
      await Promise.resolve();
    });
    // Should NOT have polled again
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(PLUGIN_CONNECTIONS_POLL_MS * 2);
      await Promise.resolve();
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // Regain focus
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it('prevents overlapping polls while a previous fetch is still in flight', async () => {
    let resolveFirst!: (value: PluginConnection[]) => void;
    const pendingPromise = new Promise<PluginConnection[]>((resolve) => {
      resolveFirst = resolve;
    });
    mockInvoke.mockReturnValueOnce(pendingPromise);

    renderHook(() => usePluginConnections());
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // Advance past poll interval AND dispatch focus while first request is still pending
    await act(async () => {
      vi.advanceTimersByTime(PLUGIN_CONNECTIONS_POLL_MS);
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // Resolve first request; subsequent interval poll proceeds normally
    mockInvoke.mockResolvedValueOnce([]);
    await act(async () => {
      resolveFirst([]);
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(PLUGIN_CONNECTIONS_POLL_MS);
      await Promise.resolve();
    });
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it('preserves array reference on deep equality match to avoid React re-renders', async () => {
    const listA: PluginConnection[] = [
      { id: 'stripe', state: 'connected', account: 'acct_123', message: null },
      { id: 'linear', state: 'disconnected', account: null, message: null },
    ];
    mockInvoke.mockResolvedValueOnce(listA);

    const { result } = renderHook(() => usePluginConnections());

    await act(async () => {
      await Promise.resolve();
    });

    const firstRef = result.current.connections;

    // Return structurally identical data
    const listB: PluginConnection[] = [
      { id: 'stripe', state: 'connected', account: 'acct_123', message: null },
      { id: 'linear', state: 'disconnected', account: null, message: null },
    ];
    mockInvoke.mockResolvedValueOnce(listB);

    await act(async () => {
      vi.advanceTimersByTime(PLUGIN_CONNECTIONS_POLL_MS);
      await Promise.resolve();
    });

    // Reference should remain untouched
    expect(result.current.connections).toBe(firstRef);

    // Now return changed data
    const listC: PluginConnection[] = [
      { id: 'stripe', state: 'needsReauth', account: 'acct_123', message: null },
      { id: 'linear', state: 'disconnected', account: null, message: null },
    ];
    mockInvoke.mockResolvedValueOnce(listC);

    await act(async () => {
      vi.advanceTimersByTime(PLUGIN_CONNECTIONS_POLL_MS);
      await Promise.resolve();
    });

    expect(result.current.connections).not.toBe(firstRef);
    expect(result.current.connections[0].state).toBe('needsReauth');
  });

  it('dispatches action with schemaVersion 1 and optimistically updates', async () => {
    const initialList: PluginConnection[] = [
      { id: 'github', state: 'disconnected', account: null, message: null },
    ];
    mockInvoke.mockResolvedValueOnce(initialList);

    const { result } = renderHook(() => usePluginConnections());

    await act(async () => {
      await Promise.resolve();
    });

    // Mock response for action
    const actionResult: PluginConnection = {
      id: 'github',
      state: 'connected',
      account: 'octocat',
      message: null,
    };
    mockInvoke.mockResolvedValueOnce(actionResult);

    await act(async () => {
      await result.current.action('github', 'connect');
    });

    expect(mockInvoke).toHaveBeenCalledWith('plugin_connection_action', {
      request: {
        schemaVersion: 1,
        id: 'github',
        action: 'connect',
      },
    });

    expect(result.current.connections.find((c) => c.id === 'github')?.state).toBe('connected');
  });

  it('rolls back optimistic update when action rejects', async () => {
    const initialList: PluginConnection[] = [
      { id: 'github', state: 'disconnected', account: null, message: null },
    ];
    mockInvoke.mockResolvedValueOnce(initialList);

    const { result } = renderHook(() => usePluginConnections());

    await act(async () => {
      await Promise.resolve();
    });

    mockInvoke.mockRejectedValueOnce(new Error('Network error'));

    let caughtError: any = null;
    await act(async () => {
      try {
        await result.current.action('github', 'connect');
      } catch (e) {
        caughtError = e;
      }
    });

    expect(caughtError).toBeTruthy();
    expect(result.current.error).toBe('Network error');
    // Rolled back to disconnected
    expect(result.current.connections.find((c) => c.id === 'github')?.state).toBe('disconnected');
  });

  it('supports refresh manual trigger', async () => {
    mockInvoke.mockResolvedValue([]);

    const { result } = renderHook(() => usePluginConnections());

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.refresh();
    });
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });
});

describe('areConnectionsEqual helper', () => {
  it('detects equal connection arrays regardless of element order', () => {
    const a: PluginConnection[] = [
      { id: 'x', state: 'preview', account: null, message: null },
      { id: 'github', state: 'connected', account: 'test', message: null },
    ];
    const b: PluginConnection[] = [
      { id: 'github', state: 'connected', account: 'test', message: null },
      { id: 'x', state: 'preview', account: null, message: null },
    ];
    expect(areConnectionsEqual(a, b)).toBe(true);
  });

  it('detects changes in connection fields', () => {
    const a: PluginConnection[] = [
      { id: 'x', state: 'preview', account: null, message: null },
    ];
    const b: PluginConnection[] = [
      { id: 'x', state: 'disconnected', account: null, message: null },
    ];
    expect(areConnectionsEqual(a, b)).toBe(false);
  });
});
