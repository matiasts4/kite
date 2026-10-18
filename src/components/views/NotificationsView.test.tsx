import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationsView } from './NotificationsView';

// Mock ipc invokeCommand
vi.mock('../../lib/ipc', () => ({
  invokeCommand: vi.fn(),
}));

import { invokeCommand } from '../../lib/ipc';

describe('NotificationsView Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders clean header and empty state when there are no notifications', async () => {
    vi.mocked(invokeCommand).mockResolvedValueOnce({
      records: [],
      unreadCount: 0,
      openInputRequestCount: 0,
      authorization: 'authorized',
      preferences: {
        osNotificationsEnabled: true,
        finishSoundEnabled: true,
        inputRequestsEnabled: true,
      },
    });

    render(<NotificationsView />);

    expect(screen.getByText('Notifications')).toBeInTheDocument();
    expect(await screen.findByText('No notifications yet')).toBeInTheDocument();
    expect(screen.getByText('Notification settings…')).toBeInTheDocument();

    // Verify clutter buttons (Volume, Clear, Close) are NOT present in header
    expect(screen.queryByTitle(/sound/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/clear/i)).not.toBeInTheDocument();
  });

  it('renders grouped notifications matching design and triggers navigation', async () => {
    const onNavigateMode = vi.fn();
    const onOpenSettings = vi.fn();
    const user = userEvent.setup();

    const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000 - 10 * 60 * 60 * 1000;

    vi.mocked(invokeCommand).mockResolvedValueOnce({
      records: [
        {
          id: 'notif-1',
          createdAtUnixMs: fiveDaysAgo,
          isRead: true,
          target: { source: 'codeThread', id: 'session-123' },
          kind: { kind: 'settled', outcome: 'completed' },
        },
      ],
      unreadCount: 0,
      openInputRequestCount: 0,
    });

    render(
      <NotificationsView
        onNavigateMode={onNavigateMode}
        onOpenSettings={onOpenSettings}
      />
    );

    // Header and section
    expect(await screen.findByText('Earlier')).toBeInTheDocument();
    expect(screen.getByText('Code thread')).toBeInTheDocument();
    expect(screen.getByText('Code thread closed')).toBeInTheDocument();

    // Click row navigates to code mode
    const row = screen.getByRole('button', { name: /Code thread, Code thread closed/i });
    await user.click(row);
    expect(onNavigateMode).toHaveBeenCalledWith('code');

    // Click settings triggers onOpenSettings
    const settingsBtn = screen.getByRole('button', { name: /Notification settings…/i });
    await user.click(settingsBtn);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
