import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';

const { listenMock, tauriListeners, fetchAllSpy, toastActionSpy } = vi.hoisted(() => ({
  listenMock: vi.fn(),
  tauriListeners: new Map<string, (event: { payload: any }) => void>(),
  fetchAllSpy: vi.fn().mockResolvedValue({}),
  toastActionSpy: vi.fn().mockReturnValue('toast-1'),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: any[]) => listenMock(...args),
}));

vi.mock('../../lib/toast', () => ({
  registerToastNavigator: vi.fn(() => () => {}),
  toast: {
    action: (...args: any[]) => toastActionSpy(...args),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock('../../lib/quota/quotaManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/quota/quotaManager')>();
  actual.subscriptionQuotaManager.fetchAll = fetchAllSpy;
  return actual;
});

import { useAppGlobalEvents } from './useAppGlobalEvents';

function TestHarness() {
  useAppGlobalEvents({
    setWorkMode: vi.fn(),
    setSettingsOpen: vi.fn(),
    setRoutinesOpen: vi.fn(),
    setSelectedWorkspaceId: vi.fn(),
    setSelectedAgentId: vi.fn(),
    setSelectedThreadId: vi.fn(),
    setRightDockVisible: vi.fn(),
    loadBootstrap: vi.fn().mockResolvedValue(undefined),
    loadThreads: vi.fn().mockResolvedValue(undefined),
    setAgents: vi.fn(),
    selectedAgentId: null,
  });
  return null;
}

describe('useAppGlobalEvents — Model Quota Alerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauriListeners.clear();
    listenMock.mockImplementation(async (eventName: string, handler: (event: { payload: any }) => void) => {
      tauriListeners.set(eventName, handler);
      return () => {
        tauriListeners.delete(eventName);
      };
    });
  });

  it('forces quota refresh and deduplicates runtime usage-limit and backend model-exhaustion toasts', async () => {
    render(<TestHarness />);

    await act(async () => {
      await Promise.resolve();
    });

    // Runtime usage limit forces immediate backend quota refresh + toast.action once per failure signature
    act(() => {
      window.dispatchEvent(
        new CustomEvent('kite:usage-limit-detected', {
          detail: {
            provider: 'agy',
            message: 'Individual quota reached on Gemini 4 Argon.',
            resetAtUnixMs: 1_800_000_000_000,
          },
        })
      );
      window.dispatchEvent(
        new CustomEvent('kite:usage-limit-detected', {
          detail: {
            provider: 'agy',
            message: 'Individual quota reached on Gemini 4 Argon.',
            resetAtUnixMs: 1_800_000_000_000,
          },
        })
      );
    });

    expect(fetchAllSpy).toHaveBeenCalledWith(true, ['antigravity']);
    expect(toastActionSpy).toHaveBeenCalledTimes(1);
    expect(toastActionSpy.mock.calls[0]?.[0]).toContain('Antigravity');

    const exhaustedListener = tauriListeners.get('kite://model-quota-exhausted');
    expect(exhaustedListener).toBeDefined();

    // Backend model-quota-exhausted event fires toast once per (provider, window, resetsAt)
    act(() => {
      exhaustedListener?.({
        payload: {
          providerId: 'antigravity',
          displayName: 'Antigravity',
          windowName: 'Gemini 4 Argon (Gemini 4 Argon Weekly Limit)',
          remainingPercent: 0,
          resetsAt: '2026-11-22T05:16:50Z',
          dedupKey: 'antigravity:Gemini 4 Argon:2026-11-22T05:16:50Z',
        },
      });
      exhaustedListener?.({
        payload: {
          providerId: 'antigravity',
          displayName: 'Antigravity',
          windowName: 'Gemini 4 Argon (Gemini 4 Argon Weekly Limit)',
          remainingPercent: 0,
          resetsAt: '2026-11-22T05:16:50Z',
          dedupKey: 'antigravity:Gemini 4 Argon:2026-11-22T05:16:50Z',
        },
      });
    });

    expect(toastActionSpy).toHaveBeenCalledTimes(2);
    expect(toastActionSpy.mock.calls[1]?.[0]).toContain('Gemini 4 Argon');
  });
});
