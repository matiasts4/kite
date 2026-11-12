import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ArchivedChatsModal } from './ArchivedChatsModal';
import * as ipc from '../../../lib/ipc';

vi.mock('../../../lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/ipc')>();
  return {
    ...actual,
    listArchivedChats: vi.fn(),
    restoreArchivedChat: vi.fn(),
    purgeArchivedChat: vi.fn(),
  };
});

describe('ArchivedChatsModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders empty state when there are no archived chats', async () => {
    vi.mocked(ipc.listArchivedChats).mockResolvedValueOnce([]);

    render(
      <ArchivedChatsModal
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('No archived conversations')).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Conversations you archive will appear here and can be restored at any time within 30 days/)
    ).toBeInTheDocument();
  });

  it('renders archived chats list with metadata and search filter', async () => {
    const now = Date.now();
    vi.mocked(ipc.listArchivedChats).mockResolvedValueOnce([
      {
        id: 'chat-1',
        title: 'Refactor Auth Layer',
        profileId: null,
        revision: 'rev-1',
        archivedAtUnixMs: now - 3600 * 1000,
        expiresAtUnixMs: now + 29 * 24 * 3600 * 1000,
        provider: 'antigravity',
        model: 'gemini-3.8-flash',
      },
      {
        id: 'chat-2',
        title: 'Fix SQLite Deadlock',
        profileId: null,
        revision: 'rev-2',
        archivedAtUnixMs: now - 7200 * 1000,
        expiresAtUnixMs: now + 15 * 24 * 3600 * 1000,
        provider: 'claude',
        model: 'claude-3-7-sonnet',
      },
    ]);

    render(
      <ArchivedChatsModal
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Refactor Auth Layer')).toBeInTheDocument();
      expect(screen.getByText('Fix SQLite Deadlock')).toBeInTheDocument();
    });

    // Model tags rendered
    expect(screen.getByText('gemini-3.8-flash')).toBeInTheDocument();
    expect(screen.getByText('claude-3-7-sonnet')).toBeInTheDocument();

    // Filter by search query
    const searchInput = screen.getByPlaceholderText('Search archived chats…');
    fireEvent.change(searchInput, { target: { value: 'Deadlock' } });

    expect(screen.queryByText('Refactor Auth Layer')).not.toBeInTheDocument();
    expect(screen.getByText('Fix SQLite Deadlock')).toBeInTheDocument();

    // Clear search
    const clearBtn = screen.getByRole('button', { name: 'Clear search query' });
    fireEvent.click(clearBtn);

    expect(screen.getByText('Refactor Auth Layer')).toBeInTheDocument();
  });

  it('restores chat and invokes onRestored', async () => {
    const now = Date.now();
    vi.mocked(ipc.listArchivedChats).mockResolvedValueOnce([
      {
        id: 'chat-restore-1',
        title: 'Feature Checkout',
        profileId: null,
        revision: 'rev-1',
        archivedAtUnixMs: now,
        expiresAtUnixMs: now + 30 * 24 * 3600 * 1000,
        provider: 'antigravity',
      },
    ]);
    vi.mocked(ipc.restoreArchivedChat).mockResolvedValueOnce(undefined);

    const onRestored = vi.fn();
    render(
      <ArchivedChatsModal
        isOpen={true}
        onClose={vi.fn()}
        onRestored={onRestored}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Feature Checkout')).toBeInTheDocument();
    });

    const restoreBtn = screen.getByRole('button', { name: 'Restore Feature Checkout' });
    fireEvent.click(restoreBtn);

    await waitFor(() => {
      expect(ipc.restoreArchivedChat).toHaveBeenCalledWith('chat-restore-1', null);
      expect(onRestored).toHaveBeenCalledWith('chat-restore-1');
    });
  });

  it('confirms permanent deletion before purging', async () => {
    const now = Date.now();
    vi.mocked(ipc.listArchivedChats).mockResolvedValueOnce([
      {
        id: 'chat-delete-1',
        title: 'Ephemeral Spike',
        profileId: null,
        revision: 'rev-1',
        archivedAtUnixMs: now,
        expiresAtUnixMs: now + 30 * 24 * 3600 * 1000,
        provider: 'antigravity',
      },
    ]);
    vi.mocked(ipc.purgeArchivedChat).mockResolvedValueOnce(undefined);

    render(
      <ArchivedChatsModal
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Ephemeral Spike')).toBeInTheDocument();
    });

    // Clicking delete icon opens confirmation
    const deleteBtn = screen.getByRole('button', { name: 'Delete Ephemeral Spike permanently' });
    fireEvent.click(deleteBtn);

    expect(
      screen.getByText(/Permanently delete “Ephemeral Spike”\? This conversation will be removed forever and cannot be restored\./)
    ).toBeInTheDocument();

    // Cancel keeping the conversation
    const keepBtn = screen.getByRole('button', { name: 'Keep conversation' });
    fireEvent.click(keepBtn);
    expect(ipc.purgeArchivedChat).not.toHaveBeenCalled();

    // Click delete again and confirm
    fireEvent.click(deleteBtn);
    const confirmPurgeBtn = screen.getByRole('button', { name: 'Delete permanently' });
    fireEvent.click(confirmPurgeBtn);

    await waitFor(() => {
      expect(ipc.purgeArchivedChat).toHaveBeenCalledWith('chat-delete-1', null);
      expect(screen.queryByText('Ephemeral Spike')).not.toBeInTheDocument();
    });
  });
});
