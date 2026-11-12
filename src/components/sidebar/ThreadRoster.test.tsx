import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ThreadRoster } from './ThreadRoster';
import type { ChatThreadSummary } from './types';
import type { Workspace } from '../../types';

type RosterThread = ChatThreadSummary & {
  sideChat?: boolean;
  snoozedUntil?: number | null;
};

const workspace: Workspace = {
  id: 'ws',
  displayName: 'Kite',
  createdAtUnixMs: 1,
  lastOpenedAtUnixMs: 1,
  pinned: false,
  available: true,
};

function thread(partial: Partial<RosterThread> & Pick<RosterThread, 'id' | 'title'>): RosterThread {
  return {
    status: 'idle',
    ...partial,
  };
}

describe('ThreadRoster live shelves', () => {
  it('hides side chats, keeps search and New thread, and does not mark an empty catalog as failed', () => {
    render(
      <ThreadRoster
        threads={[
          thread({ id: 'main', title: 'Main', workspaceId: 'ws' }),
          thread({ id: 'side', title: 'Side note', workspaceId: 'ws', sideChat: true }),
          thread({ id: 'broken', title: 'Broken', status: 'error' }),
          thread({ id: 'idle', title: 'Idle thread', status: 'idle', workspaceId: 'ws' }),
        ]}
        workspaces={[workspace]}
        selectedThreadId="main"
        onNewChatInWorkspace={() => undefined}
      />,
    );

    expect(screen.getByPlaceholderText('Search threads…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New thread in Kite' })).toBeInTheDocument();
    expect(screen.getByText('Main')).toBeInTheDocument();
    expect(screen.queryByText('Side note')).not.toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(document.querySelectorAll('.chat-thread-row__dot--failed')).toHaveLength(1);
    expect(screen.getByText('Idle thread')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search threads…'), { target: { value: 'broken' } });
    expect(screen.queryByText('Main')).not.toBeInTheDocument();
    expect(screen.queryByText('Side note')).not.toBeInTheDocument();
    expect(screen.getByText('Broken')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New thread in Kite' })).toBeInTheDocument();
  });

  it('asks for a new thread in that workspace from the workspace plus button', () => {
    const onNewChatInWorkspace = vi.fn();
    render(
      <ThreadRoster
        threads={[thread({ id: 'main', title: 'Main', workspaceId: 'ws' })]}
        workspaces={[workspace]}
        selectedThreadId="main"
        onNewChatInWorkspace={onNewChatInWorkspace}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'New thread in Kite' }));

    expect(onNewChatInWorkspace).toHaveBeenCalledTimes(1);
    expect(onNewChatInWorkspace).toHaveBeenCalledWith('ws');
  });

  it('folds a running thread into Working and returns it when the turn finishes', () => {
    const running = thread({ id: 'busy', title: 'Busy', status: 'running', workspaceId: 'ws' });
    const pinned = thread({ id: 'pin', title: 'Pinned busy', status: 'running', pinned: true, workspaceId: 'ws' });
    const view = render(
      <ThreadRoster threads={[running, pinned]} workspaces={[workspace]} selectedThreadId={null} />,
    );

    const working = screen.getByRole('region', { name: 'Working threads' });
    expect(within(working).getByText('Busy')).toBeInTheDocument();
    expect(within(working).queryByText('Pinned busy')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Pinned threads' }).textContent).toContain('Pinned busy');
    expect(screen.getAllByText('Busy')).toHaveLength(1);

    view.rerender(
      <ThreadRoster
        threads={[{ ...running, status: 'idle' }, pinned]}
        workspaces={[workspace]}
        selectedThreadId={null}
      />,
    );
    expect(screen.queryByRole('region', { name: 'Working threads' })).not.toBeInTheDocument();
    expect(screen.getByText('Busy')).toBeInTheDocument();
  });

  it('parks a snoozed thread on the Snoozed shelf', () => {
    render(
      <ThreadRoster
        threads={[
          thread({
            id: 'later',
            title: 'Later',
            workspaceId: 'ws',
            snoozedUntil: Date.now() + 60_000,
          }),
        ]}
        workspaces={[workspace]}
      />,
    );
    expect(within(screen.getByRole('region', { name: 'Snoozed threads' })).getByText('Later')).toBeInTheDocument();
    expect(screen.getAllByText('Later')).toHaveLength(1);
  });

  it('offers Regenerate title only for the selected thread and disables it while pending', () => {
    const onRegenerateTitle = vi.fn();
    const threads = [
      thread({ id: 'main', title: 'Main' }),
      thread({ id: 'other', title: 'Other' }),
    ];
    const view = render(
      <ThreadRoster
        threads={threads}
        selectedThreadId="main"
        onRegenerateTitle={onRegenerateTitle}
      />,
    );
    const button = screen.getByRole('button', { name: 'Regenerate title' });
    expect(screen.getAllByRole('button', { name: 'Regenerate title' })).toHaveLength(1);
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onRegenerateTitle).toHaveBeenCalledTimes(1);
    expect(onRegenerateTitle).toHaveBeenCalledWith('main');

    onRegenerateTitle.mockClear();
    view.rerender(
      <ThreadRoster
        threads={threads}
        selectedThreadId="main"
        onRegenerateTitle={onRegenerateTitle}
        titlePending
      />,
    );
    expect(screen.getByRole('button', { name: 'Regenerate title' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate title' }));
    expect(onRegenerateTitle).not.toHaveBeenCalled();
  });

  it('does not render Regenerate title when the handler is missing', () => {
    render(
      <ThreadRoster
        threads={[thread({ id: 'main', title: 'Main' })]}
        selectedThreadId="main"
      />,
    );
    expect(screen.queryByRole('button', { name: 'Regenerate title' })).not.toBeInTheDocument();
  });

  it('undoes pin and archive from the toast and from Ctrl+Z or Cmd+Z', () => {
    const onPin = vi.fn();
    const onArchive = vi.fn();
    const onRestore = vi.fn();
    const view = render(
      <ThreadRoster
        threads={[thread({ id: 'main', title: 'Main' })]}
        onTogglePinThread={onPin}
        onDeleteThread={onArchive}
        onRestoreThread={onRestore}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pin Main' }));
    expect(onPin).toHaveBeenCalledWith('main', true);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onPin).toHaveBeenLastCalledWith('main', false);
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();

    view.rerender(
      <ThreadRoster
        threads={[thread({ id: 'main', title: 'Main', pinned: true })]}
        onTogglePinThread={onPin}
        onDeleteThread={onArchive}
        onRestoreThread={onRestore}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Unpin Main' }));
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(onPin).toHaveBeenLastCalledWith('main', true);

    view.rerender(
      <ThreadRoster
        threads={[thread({ id: 'main', title: 'Main' })]}
        onTogglePinThread={onPin}
        onDeleteThread={onArchive}
        onRestoreThread={onRestore}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Archive Main' }));
    expect(onArchive).toHaveBeenCalledWith('main');
    fireEvent.keyDown(window, { key: 'Z', metaKey: true });
    expect(onRestore).toHaveBeenCalledWith('main');
  });

  it('does not treat Ctrl+Shift+Z as undo', () => {
    const onPin = vi.fn();
    render(
      <ThreadRoster
        threads={[thread({ id: 'main', title: 'Main' })]}
        onTogglePinThread={onPin}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pin Main' }));
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(onPin).toHaveBeenCalledTimes(1);
  });

  it('calls onArchiveThread when provided and exposes delete chat in context menu', () => {
    const onArchive = vi.fn();
    const onDelete = vi.fn();
    const onOpenMenu = vi.fn();
    render(
      <ThreadRoster
        threads={[thread({ id: 'th-1', title: 'Feature Alpha' })]}
        onArchiveThread={onArchive}
        onDeleteThread={onDelete}
        onOpenMenu={onOpenMenu}
        archivedCount={5}
      />,
    );

    // Clicking archive hover button calls onArchive
    fireEvent.click(screen.getByRole('button', { name: 'Archive Feature Alpha' }));
    expect(onArchive).toHaveBeenCalledWith('th-1');

    // Context menu opens with both Archive and Delete actions
    const selectBtn = screen.getByRole('button', { name: /^Feature Alpha,/ });
    fireEvent.contextMenu(selectBtn, { clientX: 100, clientY: 200 });
    expect(onOpenMenu).toHaveBeenCalled();
    const menuState = onOpenMenu.mock.calls[0][0];
    const allItems = menuState.sections.flat();
    const archiveItem = allItems.find((i: any) => i.id === 'archive');
    const deleteItem = allItems.find((i: any) => i.id === 'delete');
    expect(archiveItem).toBeDefined();
    expect(deleteItem).toBeDefined();
    expect(deleteItem.role).toBe('destructive');

    // Executing delete action calls onDeleteThread
    deleteItem.action();
    expect(onDelete).toHaveBeenCalledWith('th-1');

    // Archived count badge is shown
    expect(screen.getByRole('button', { name: /Archived threads, 5 archived/ })).toBeInTheDocument();
  });
});
