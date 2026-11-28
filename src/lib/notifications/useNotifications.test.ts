import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useNotifications,
  areNotificationsSnapshotsEqual,
  NOTIFICATIONS_POLL_INTERVAL_MS,
} from './useNotifications';

const tauriMocks = vi.hoisted(() => {
  const listeners = new Map<string, Array<(event: { payload: unknown }) => void>>();
  const listen = vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    const arr = listeners.get(name) ?? [];
    arr.push(handler);
    listeners.set(name, arr);
    return () => {
      listeners.set(
        name,
        (listeners.get(name) ?? []).filter((fn) => fn !== handler)
      );
    };
  });
  return { listeners, listen };
});

vi.mock('@tauri-apps/api/event', () => ({
  listen: tauriMocks.listen,
}));

vi.mock('../ipc', () => ({
  invokeCommand: vi.fn(),
}));

vi.mock('./audioCues', () => ({
  playCompletionChime: vi.fn(),
  playApprovalChime: vi.fn(),
}));

vi.mock('../toast', () => ({
  toast: {
    agentApproval: vi.fn(() => 'approval-toast'),
    agentSettled: vi.fn(() => 'settled-toast'),
    dismiss: vi.fn(),
  },
}));

import { invokeCommand } from '../ipc';
import { toast } from '../toast';
import { playCompletionChime, playApprovalChime } from './audioCues';

function snapshot(
  record: Record<string, unknown>,
  opts: {
    inputRequestsEnabled?: boolean;
    finishSoundEnabled?: boolean;
    osNotificationsEnabled?: boolean;
  } | boolean = true
) {
  const normalized =
    typeof opts === 'boolean' ? { inputRequestsEnabled: opts } : opts;
  return {
    schemaVersion: 1,
    revision: 1,
    records: [record],
    unreadCount: 1,
    openInputRequestCount: 0,
    authorization: 'authorized',
    preferences: {
      schemaVersion: 2,
      osNotificationsEnabled: normalized.osNotificationsEnabled ?? false,
      finishSoundEnabled: normalized.finishSoundEnabled ?? false,
      inputRequestsEnabled: normalized.inputRequestsEnabled ?? true,
    },
  };
}

describe('useNotifications hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauriMocks.listeners.clear();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it('fetches initial snapshot on mount and reflects unreadCount', async () => {
    vi.mocked(invokeCommand).mockResolvedValueOnce({
      schemaVersion: 1,
      revision: 1,
      records: [
        {
          id: 'n1',
          createdAtUnixMs: Date.now(),
          isRead: false,
          kind: { kind: 'settled', outcome: 'completed' },
        },
      ],
      unreadCount: 1,
      openInputRequestCount: 0,
      authorization: 'authorized',
      preferences: {
        schemaVersion: 1,
        osNotificationsEnabled: false,
        finishSoundEnabled: true,
        inputRequestsEnabled: true,
      },
    });

    const { result } = renderHook(() => useNotifications());

    await waitFor(() => {
      expect(result.current.unreadCount).toBe(1);
    });

    expect(invokeCommand).toHaveBeenCalledWith('notifications_poll');
  });

  it('marks a notification as read and updates count', async () => {
    vi.mocked(invokeCommand)
      .mockResolvedValueOnce({
        records: [{ id: 'n1', isRead: false }],
        unreadCount: 1,
        openInputRequestCount: 0,
      })
      .mockResolvedValueOnce({
        records: [{ id: 'n1', isRead: true }],
        unreadCount: 0,
        openInputRequestCount: 0,
      });

    const { result } = renderHook(() => useNotifications());

    await waitFor(() => {
      expect(result.current.unreadCount).toBe(1);
    });

    await act(async () => {
      await result.current.markRead('n1');
    });

    expect(invokeCommand).toHaveBeenCalledWith('notifications_mark_read', { recordId: 'n1' });
    expect(result.current.unreadCount).toBe(0);
  });

  it('does not toast a finished turn, including a failure', async () => {
    vi.mocked(invokeCommand)
      .mockResolvedValueOnce(
        snapshot({ id: 'seed', isRead: true, kind: { kind: 'settled', outcome: 'completed' } })
      )
      .mockResolvedValueOnce(
        snapshot({ id: 'fail-1', isRead: false, kind: { kind: 'settled', outcome: 'failed' } })
      );
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);

    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.unreadCount).toBe(1));
    await act(async () => {
      await result.current.refresh();
    });

    expect(toast.agentSettled).not.toHaveBeenCalled();
    expect(toast.agentApproval).not.toHaveBeenCalled();
  });

  it('toasts an approval only when the window is elsewhere and questions are enabled', async () => {
    const approval = {
      id: 'ask-1',
      isRead: false,
      isWaitingForInput: true,
      kind: { kind: 'needsInput', requestKind: 'toolApproval' },
      target: { source: 'codeThread', id: 'thread-1' },
    };
    vi.mocked(invokeCommand)
      .mockResolvedValueOnce(
        snapshot({ id: 'seed', isRead: true, kind: { kind: 'settled', outcome: 'completed' } })
      )
      .mockResolvedValueOnce(snapshot(approval));
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);

    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(invokeCommand).toHaveBeenCalled());
    await act(async () => {
      await result.current.refresh();
    });

    expect(toast.agentApproval).toHaveBeenCalledTimes(1);
    expect(toast.agentSettled).not.toHaveBeenCalled();
  });

  it('keeps an approval in the thread when this window is already focused', async () => {
    const approval = {
      id: 'ask-2',
      isRead: false,
      isWaitingForInput: true,
      kind: { kind: 'needsInput', requestKind: 'toolApproval' },
    };
    vi.mocked(invokeCommand)
      .mockResolvedValueOnce(snapshot({ id: 'seed', isRead: true }))
      .mockResolvedValueOnce(snapshot(approval));

    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(invokeCommand).toHaveBeenCalled());
    await act(async () => {
      await result.current.refresh();
    });

    expect(toast.agentApproval).not.toHaveBeenCalled();
  });

  it('stays quiet when questions from agents are turned off', async () => {
    const approval = {
      id: 'ask-3',
      isRead: false,
      isWaitingForInput: true,
      kind: { kind: 'needsInput', requestKind: 'question' },
    };
    vi.mocked(invokeCommand)
      .mockResolvedValueOnce(snapshot({ id: 'seed', isRead: true }, false))
      .mockResolvedValueOnce(snapshot(approval, false));
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);

    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(invokeCommand).toHaveBeenCalled());
    await act(async () => {
      await result.current.refresh();
    });

    expect(toast.agentApproval).not.toHaveBeenCalled();
  });

  it('refreshes immediately on kite:notifications-refresh and exposes autoSwitchConfirm without duplicate approval toast', async () => {
    const autoSwitchRec = {
      id: 'autoswitch_conf-1',
      isRead: false,
      isWaitingForInput: true,
      confirmationId: 'conf-1',
      kind: { kind: 'autoSwitchConfirm', requestKind: 'model_mismatch' },
      title: 'Model confirmation required',
      body: 'Switching from Personal to Work',
    };
    vi.mocked(invokeCommand)
      .mockResolvedValueOnce(
        snapshot({ id: 'seed', isRead: true, kind: { kind: 'settled', outcome: 'completed' } })
      )
      .mockResolvedValueOnce(snapshot(autoSwitchRec));
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);

    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(invokeCommand).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new CustomEvent('kite:notifications-refresh'));
    });

    await waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledTimes(2);
      expect(result.current.snapshot?.records[0]?.id).toBe('autoswitch_conf-1');
    });
    expect(toast.agentApproval).not.toHaveBeenCalled();
  });

  it('plays sound only in same active module and shows in-app toast with lookups in another module', async () => {
    const lookups = {
      agents: [{ id: 'chip', name: 'Chip Worker' }],
      threads: [{ id: 'at-1', title: 'Migrate auth' }],
    };
    const agentDone = {
      id: 'done-agent-1',
      isRead: false,
      profileId: 'chip',
      target: { source: 'agentChat', id: 'at-1' },
      kind: { kind: 'settled', outcome: 'completed' },
    };
    const agentDoneInCode = {
      id: 'done-agent-2',
      isRead: false,
      profileId: 'chip',
      target: { source: 'agentChat', id: 'at-1' },
      kind: { kind: 'settled', outcome: 'completed' },
    };

    vi.mocked(invokeCommand)
      .mockResolvedValueOnce(
        snapshot(
          { id: 'seed', isRead: true, kind: { kind: 'settled', outcome: 'completed' } },
          { finishSoundEnabled: true, osNotificationsEnabled: true }
        )
      )
      .mockResolvedValueOnce(
        snapshot(agentDone, { finishSoundEnabled: true, osNotificationsEnabled: true })
      )
      .mockResolvedValueOnce(
        snapshot(agentDoneInCode, { finishSoundEnabled: true, osNotificationsEnabled: true })
      );

    const { result, rerender } = renderHook(
      ({ workMode }: { workMode: 'agent' | 'code' }) =>
        useNotifications({
          activeContext: { workMode, settingsOpen: false, routinesOpen: false },
          lookups,
        }),
      { initialProps: { workMode: 'agent' as 'agent' | 'code' } }
    );

    await waitFor(() => expect(invokeCommand).toHaveBeenCalledTimes(1));

    // Same module ('agent'): chime only, no toast, no OS toast
    await act(async () => {
      await result.current.refresh();
    });
    expect(playCompletionChime).toHaveBeenCalledWith(true, true);
    expect(toast.agentSettled).not.toHaveBeenCalled();
    expect(invokeCommand).not.toHaveBeenCalledWith('notifications_send_os', expect.anything());

    // Switch to 'code' module without recreating polling (no extra automatic poll on rerender)
    rerender({ workMode: 'code' });
    expect(invokeCommand).toHaveBeenCalledTimes(2);

    // Different module ('code'): chime + interactive in-app toast with lookups
    await act(async () => {
      await result.current.refresh();
    });
    expect(toast.agentSettled).toHaveBeenCalledWith(agentDoneInCode, undefined, lookups);
    expect(playApprovalChime).not.toHaveBeenCalled();
    expect(invokeCommand).not.toHaveBeenCalledWith('notifications_send_os', expect.anything());
  });

  it('refreshes immediately on kite://notifications-updated and dispatches Windows OS toast outside Kite', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const lookups = { agents: [{ id: 'chip', name: 'Chip Worker' }] };
    const settledRec = {
      id: 'os-1',
      isRead: false,
      profileId: 'chip',
      target: { source: 'agentChat', id: 'at-9' },
      threadTitle: 'Ship release',
      kind: { kind: 'settled', outcome: 'completed' },
    };

    vi.mocked(invokeCommand)
      .mockResolvedValueOnce(
        snapshot(
          { id: 'seed', isRead: true, kind: { kind: 'settled', outcome: 'completed' } },
          { finishSoundEnabled: true, osNotificationsEnabled: true }
        )
      )
      .mockResolvedValueOnce(
        snapshot(settledRec, { finishSoundEnabled: true, osNotificationsEnabled: true })
      )
      .mockResolvedValueOnce(undefined);

    renderHook(() =>
      useNotifications({
        activeContext: { workMode: 'agent', settingsOpen: false, routinesOpen: false },
        lookups,
      })
    );

    await waitFor(() => {
      expect(tauriMocks.listeners.get('kite://notifications-updated')?.length).toBeGreaterThan(0);
      expect(tauriMocks.listeners.get('kite:window-state')?.length).toBeGreaterThan(0);
    });

    // Simulate minimized Tauri window + backend push notification
    act(() => {
      for (const h of tauriMocks.listeners.get('kite:window-state') ?? []) {
        h({ payload: { minimized: true, focused: false } });
      }
      for (const h of tauriMocks.listeners.get('kite://notifications-updated') ?? []) {
        h({ payload: { revision: 2 } });
      }
    });

    await waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith('notifications_send_os', {
        title: 'Chip Worker finished',
        body: 'Ship release',
        tag: 'os-1',
        silent: false,
      });
    });

    expect(playCompletionChime).not.toHaveBeenCalled();
    expect(toast.agentSettled).not.toHaveBeenCalled();
  });

  it('treats enriched NotificationRecord and preferences fields as significant in snapshot equality', () => {
    const base = snapshot(
      {
        id: 'n1',
        actorName: 'Chip Worker',
        threadTitle: 'Auth',
        module: 'agent',
        isRead: false,
      },
      { osNotificationsEnabled: true }
    ) as any;
    const same = JSON.parse(JSON.stringify(base));
    const changedActor = JSON.parse(JSON.stringify(base));
    changedActor.records[0].actorName = 'Other Agent';
    const changedOsPref = JSON.parse(JSON.stringify(base));
    changedOsPref.preferences.osNotificationsEnabled = false;
    const changedAuth = JSON.parse(JSON.stringify(base));
    changedAuth.authorization = 'denied';

    expect(areNotificationsSnapshotsEqual(base, same)).toBe(true);
    expect(areNotificationsSnapshotsEqual(base, changedActor)).toBe(false);
    expect(areNotificationsSnapshotsEqual(base, changedOsPref)).toBe(false);
    expect(areNotificationsSnapshotsEqual(base, changedAuth)).toBe(false);
  });

  it('uses 15s fallback polling, pauses while document.hidden, and runs catch-up poll on restore', async () => {
    vi.useFakeTimers();
    const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
    const visDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    const setVisibility = (hidden: boolean) => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: hidden ? 'hidden' : 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    };

    try {
      vi.mocked(invokeCommand).mockResolvedValue(
        snapshot({ id: 'n-poll', isRead: true, kind: { kind: 'settled', outcome: 'completed' } })
      );

      renderHook(() => useNotifications());
      await act(async () => {
        await Promise.resolve();
      });
      expect(invokeCommand).toHaveBeenCalledTimes(1);
      expect(NOTIFICATIONS_POLL_INTERVAL_MS).toBe(15_000);

      // Does not poll at 4000ms (relaxed from 4s to 15s)
      await act(async () => {
        vi.advanceTimersByTime(4_000);
        await Promise.resolve();
      });
      expect(invokeCommand).toHaveBeenCalledTimes(1);

      // Polls once at 15000ms
      await act(async () => {
        vi.advanceTimersByTime(11_000);
        await Promise.resolve();
      });
      expect(invokeCommand).toHaveBeenCalledTimes(2);

      // Pausing completely when document.hidden becomes true
      act(() => {
        setVisibility(true);
      });
      await act(async () => {
        vi.advanceTimersByTime(60_000);
        await Promise.resolve();
      });
      expect(invokeCommand).toHaveBeenCalledTimes(2);

      // Visibility restore triggers one immediate catch-up poll and resumes 15s cadence
      await act(async () => {
        setVisibility(false);
        await Promise.resolve();
      });
      expect(invokeCommand).toHaveBeenCalledTimes(3);

      await act(async () => {
        vi.advanceTimersByTime(15_000);
        await Promise.resolve();
      });
      expect(invokeCommand).toHaveBeenCalledTimes(4);
    } finally {
      if (hiddenDescriptor) {
        Object.defineProperty(document, 'hidden', hiddenDescriptor);
      } else {
        delete (document as unknown as Record<string, unknown>).hidden;
      }
      if (visDescriptor) {
        Object.defineProperty(document, 'visibilityState', visDescriptor);
      } else {
        delete (document as unknown as Record<string, unknown>).visibilityState;
      }
      vi.useRealTimers();
    }
  });

  it('dismisses an active approval toast as soon as the approval is resolved or the user focuses its module', async () => {
    const waitingApproval = {
      id: 'ask-dismiss-1',
      isRead: false,
      isWaitingForInput: true,
      kind: { kind: 'needsInput', requestKind: 'toolApproval' },
      target: { source: 'codeThread', id: 'thread-dismiss-1' },
    };
    const attendedApproval = {
      ...waitingApproval,
      isRead: true,
      isWaitingForInput: false,
      resolution: 'attended',
    };

    vi.mocked(invokeCommand)
      .mockResolvedValueOnce(
        snapshot({ id: 'seed', isRead: true, kind: { kind: 'settled', outcome: 'completed' } })
      )
      .mockResolvedValueOnce(snapshot(waitingApproval))
      .mockResolvedValueOnce(snapshot(attendedApproval));

    const { result } = renderHook(() =>
      useNotifications({
        activeContext: {
          workMode: 'code',
          selectedThreadId: null,
          settingsOpen: false,
          routinesOpen: false,
        },
      })
    );

    await waitFor(() => expect(invokeCommand).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.refresh();
    });
    expect(toast.agentApproval).toHaveBeenCalledTimes(1);
    expect(toast.dismiss).not.toHaveBeenCalled();

    // Next snapshot resolves waiting -> dismisses tracked toast immediately
    await act(async () => {
      await result.current.refresh();
    });
    expect(toast.dismiss).toHaveBeenCalledWith('approval-toast');

    // Switching into the notification's module while focused also dismisses an active toast
    vi.mocked(toast.dismiss).mockClear();
    const secondApproval = {
      id: 'ask-dismiss-2',
      isRead: false,
      isWaitingForInput: true,
      kind: { kind: 'needsInput', requestKind: 'toolApproval' },
      target: { source: 'codeThread', id: 'thread-dismiss-2' },
    };
    vi.mocked(invokeCommand)
      .mockResolvedValueOnce(
        snapshot({ id: 'seed-2', isRead: true, kind: { kind: 'settled', outcome: 'completed' } })
      )
      .mockResolvedValueOnce(snapshot(secondApproval));

    const { result: res2, rerender } = renderHook(
      ({ workMode }: { workMode: 'code' | 'chat' }) =>
        useNotifications({
          activeContext: {
            workMode,
            selectedThreadId: workMode === 'chat' ? 'thread-dismiss-2' : null,
            settingsOpen: false,
            routinesOpen: false,
          },
        }),
      { initialProps: { workMode: 'code' as 'code' | 'chat' } }
    );

    await waitFor(() => expect(res2.current.snapshot?.records[0]?.id).toBe('seed-2'));
    await act(async () => {
      await res2.current.refresh();
    });
    expect(toast.agentApproval).toHaveBeenCalledTimes(2);
    expect(toast.dismiss).not.toHaveBeenCalled();

    rerender({ workMode: 'chat' });
    expect(toast.dismiss).toHaveBeenCalledWith('approval-toast');
  });
});
