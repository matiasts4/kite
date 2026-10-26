import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useNotifications } from './useNotifications';

vi.mock('../ipc', () => ({
  invokeCommand: vi.fn(),
}));

import { invokeCommand } from '../ipc';

describe('useNotifications hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
