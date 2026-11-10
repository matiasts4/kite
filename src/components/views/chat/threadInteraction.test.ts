import { createElement, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { invokeCommand } from '../../../lib/ipc';
import { resolvePrimaryAction, queueVisibleRows } from './composerPrimaryAction';
import { ChatRail } from './ChatRail';
import { SingleThreadPane } from './SingleThreadPane';
import type { ExtendedChatThread } from './types';
import type { ChatItem } from '../../../types';
import {
  applyShelfUndo,
  canSendDraft,
  dragBadge,
  fileRestoreAllowed,
  composerGoalStop,
  goalAfterStop,
  handoffChannel,
  handoffMessages,
  isFailedThread,
  pasteBecomesFile,
  recallPrompt,
  recordShelfUndo,
  restoreStash,
  shelfFor,
  shelfPlacement,
  compactSendText,
  sidebarThreads,
  slashIntent,
  visibleRosterThreads,
  stashDraft,
  stashFileRestorable,
  stashUploadRestore,
  undoShelf,
  type Shelf,
} from './threadInteraction';

vi.mock('../../../lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/ipc')>();
  return {
    ...actual,
    invokeCommand: vi.fn().mockResolvedValue(null),
    listWorkspaceBranches: vi.fn().mockResolvedValue({ branches: [], current: null }),
    switchWorkspaceBranch: vi.fn(),
    createWorkspaceBranch: vi.fn(),
    listConnections: vi.fn().mockResolvedValue([]),
  };
});

function railThread(partial: Partial<ExtendedChatThread> & Pick<ExtendedChatThread, 'id' | 'title'>): ExtendedChatThread {
  return {
    schemaVersion: 1,
    revision: '1',
    profileId: null,
    provider: 'grok',
    items: [],
    mode: 'acceptEdits',
    plan: false,
    model: null,
    status: 'idle',
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    workspaceId: null,
    pinned: false,
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
    ...partial,
  };
}

function userItem(): ChatItem {
  return {
    id: 'user-1',
    kind: 'user',
    text: 'Restore this turn',
    title: null,
    detail: null,
    status: null,
    streaming: false,
    exitCode: null,
    createdAtUnixMs: 1,
    attachments: [],
  };
}

function rail(props: {
  threads: ExtendedChatThread[];
  selectedThreadId?: string | null;
  onPinThread?: (threadId: string, pinned: boolean) => void;
  onArchiveThread?: (threadId: string) => void;
  onRestoredThread?: (threadId: string) => void;
  onRegenerateTitle?: (threadId: string) => void;
  titlePending?: boolean;
}) {
  return createElement(ChatRail, {
    threads: props.threads,
    selectedThreadId: props.selectedThreadId ?? null,
    onSelectThread: () => undefined,
    onNewThread: () => undefined,
    onPinThread: props.onPinThread ?? (() => undefined),
    onArchiveThread: props.onArchiveThread ?? (() => undefined),
    onRenameThread: () => undefined,
    onRestoredThread: props.onRestoredThread,
    onRegenerateTitle: props.onRegenerateTitle,
    titlePending: props.titlePending,
  });
}

describe('composer follow-up actions', () => {
  it('switches Interrupt to Queue and Steer, then Resume', () => {
    expect(resolvePrimaryAction({
      running: true, draftEmpty: true, paused: false, steerSupported: true, defaultFollowUp: 'queue', flip: false,
    })).toBe('interrupt');
    expect(resolvePrimaryAction({
      running: true, draftEmpty: false, paused: false, steerSupported: true, defaultFollowUp: 'queue', flip: false,
    })).toBe('queue');
    expect(resolvePrimaryAction({
      running: true, draftEmpty: false, paused: false, steerSupported: true, defaultFollowUp: 'queue', flip: true,
    })).toBe('steer');
    expect(resolvePrimaryAction({
      running: false, draftEmpty: true, paused: true, steerSupported: true, defaultFollowUp: 'queue', flip: false,
    })).toBe('resume');
  });

  it('keeps queued rows in FIFO order and hides the tail', () => {
    const rows = ['a', 'b', 'c', 'd'];
    expect(queueVisibleRows(rows, false).visible).toEqual(['a', 'b', 'c']);
    expect(queueVisibleRows(rows, false).hidden).toBe(1);
  });
});

describe('draft limits, stash, and recall', () => {
  it('converts a 32 KiB paste and blocks an over-long send', () => {
    expect(pasteBecomesFile(32 * 1024, 0, 100, false)).toBe(true);
    expect(pasteBecomesFile(10, 119_990, 20, false)).toBe(true);
    expect(pasteBecomesFile(32 * 1024, 0, 100, true)).toBe(false);
    expect(canSendDraft(120_001)).toBe(false);
  });

  it('stashes a draft and restores a single stash immediately', () => {
    const stashed = stashDraft([], 'remember this', 10);
    expect(stashed.cleared).toBe(true);
    expect(restoreStash(stashed.entries)).toEqual({ text: 'remember this', entries: [], openMenu: false });
  });

  it('walks sent prompts with ArrowUp and ArrowDown', () => {
    const older = recallPrompt(['one', 'two'], null, 'up');
    expect(older).toBe(1);
    expect(recallPrompt(['one', 'two'], older, 'down')).toBeNull();
  });
});

describe('shelves, slash commands, rewind, and handoff', () => {
  it('moves a running thread into Working and back to Active when it finishes', () => {
    const running = { id: 't', status: 'running' };
    expect(shelfFor(running, 0)).toBe('working');
    expect(shelfFor({ ...running, status: 'idle' }, 0)).toBe('active');
    expect(dragBadge('active', 'pinned')).toBe('Pin');
  });

  it('treats /goal as text on providers without a native loop', () => {
    expect(slashIntent('/goal tests pass', 'codex')).toBe('goal');
    expect(slashIntent('/goal tests pass', 'grok')).toBe('message');
    expect(slashIntent('/clear', 'grok')).toBe('clear');
  });

  it('refuses file restore outside an isolated checkout', () => {
    expect(fileRestoreAllowed(true, false)).toBe(false);
    expect(fileRestoreAllowed(true, true)).toBe(true);
  });

  it('keeps the new prompt and drops tool blobs from a handoff', () => {
    const kept = handoffMessages([
      { kind: 'user', text: 'original task' },
      { kind: 'tool', text: 'raw blob' },
      { kind: 'assistant', text: 'did the work' },
    ], 8);
    expect(kept.map((item) => item.kind)).toEqual(['user', 'assistant']);
  });

  it('still treats an exact /compact as compact', () => {
    expect(slashIntent('/compact', 'grok')).toBe('compact');
  });
});

describe('shelf undo', () => {
  const actions = ['Pin', 'Unpin', 'Settle', 'Snooze', 'Archive', 'draft-discard'] as const;

  it('restores the previous shelf and index for five seconds', () => {
    for (const action of actions) {
      const record = recordShelfUndo(action, 'b', { shelf: 'active', index: 1 }, 1_000);
      expect(record).toEqual({
        action,
        threadId: 'b',
        previous: { shelf: 'active', index: 1 },
        at: 1_000,
      });
      expect(undoShelf(record, 6_000)).toEqual({ shelf: 'active', index: 1 });
      expect(undoShelf(record, 6_001)).toBeNull();
    }
    expect(undoShelf(null, 6_000)).toBeNull();
  });

  it('puts a pinned thread back at its previous active index', () => {
    const record = recordShelfUndo('Pin', 'b', { shelf: 'active', index: 1 }, 1_000);
    const afterPin = [
      { id: 'a', shelf: 'active' as const },
      { id: 'c', shelf: 'pinned' as const },
      { id: 'b', shelf: 'pinned' as const },
    ];
    expect(applyShelfUndo(afterPin, record, 1_000)).toEqual([
      { id: 'a', shelf: 'active' },
      { id: 'b', shelf: 'active' },
      { id: 'c', shelf: 'pinned' },
    ]);
    expect(applyShelfUndo(afterPin, record, 6_001)).toEqual(afterPin);
  });

  it('reinserts an archived or discarded thread and leaves an expired undo unchanged', () => {
    const listed: Array<{ id: string; shelf: Shelf }> = [
      { id: 'a', shelf: 'active' },
      { id: 'c', shelf: 'active' },
    ];
    const archived = recordShelfUndo('Archive', 'b', { shelf: 'active', index: 1 }, 50);
    expect(applyShelfUndo(listed, archived, 50, { id: 'b', shelf: 'settled' })).toEqual([
      { id: 'a', shelf: 'active' },
      { id: 'b', shelf: 'active' },
      { id: 'c', shelf: 'active' },
    ]);
    expect(applyShelfUndo(listed, archived, 5_051, { id: 'b', shelf: 'settled' })).toEqual(listed);
    expect(applyShelfUndo(
      [{ id: 'a', shelf: 'active' }],
      recordShelfUndo('draft-discard', 'd', { shelf: 'active', index: 0 }, 0),
      0,
      { id: 'd', shelf: 'active' },
    )).toEqual([
      { id: 'd', shelf: 'active' },
      { id: 'a', shelf: 'active' },
    ]);
  });

  it('records settle and snooze placements', () => {
    expect(shelfPlacement([
      { id: 'a', pinned: true },
      { id: 'b', status: 'running' },
      { id: 'c', status: 'idle' },
    ], 'b', 0)).toEqual({ shelf: 'working', index: 0 });
    expect(applyShelfUndo(
      [
        { id: 'a', shelf: 'active' },
        { id: 'b', shelf: 'snoozed' },
      ],
      recordShelfUndo('Snooze', 'b', { shelf: 'active', index: 0 }, 0),
      0,
    )).toEqual([
      { id: 'b', shelf: 'active' },
      { id: 'a', shelf: 'active' },
    ]);
  });
});

describe('failed threads and side chats', () => {
  it('marks only a thread whose status is error as failed', () => {
    expect(isFailedThread({ status: 'error' }, 'empty')).toBe(true);
    expect(isFailedThread({ status: 'error' }, 'signed-out')).toBe(true);
    expect(isFailedThread({ status: 'idle' }, 'empty')).toBe(false);
    expect(isFailedThread({ status: 'idle' }, 'signed-out')).toBe(false);
    expect(isFailedThread({ status: 'running' }, null)).toBe(false);
  });

  it('keeps a failed dot for status error and leaves catalog state out of the rail', () => {
    const view = render(rail({ threads: [railThread({ id: 'broken', title: 'Broken', status: 'error' })] }));
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(document.querySelector('.chat-thread-row__dot--failed')).not.toBeNull();
    view.rerender(rail({ threads: [railThread({ id: 'idle', title: 'Idle thread', status: 'idle' })] }));
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
    expect(document.querySelector('.chat-thread-row__dot--failed')).toBeNull();
  });

  it('keeps side chats out of the live roster helper', () => {
    expect(visibleRosterThreads([
      { id: 'main', sideChat: false },
      { id: 'side', sideChat: true },
      { id: 'plain' },
    ]).map((thread) => thread.id)).toEqual(['main', 'plain']);
  });

  it('does not add a side chat to the sidebar', () => {
    expect(sidebarThreads([
      { id: 'main', sideChat: false },
      { id: 'side', sideChat: true },
    ]).map((thread) => thread.id)).toEqual(['main']);
    render(rail({
      threads: [
        railThread({ id: 'main', title: 'Main' }),
        railThread({ id: 'side', title: 'Side note', sideChat: true }),
      ],
    }));
    expect(screen.getByText('Main')).toBeInTheDocument();
    expect(screen.queryByText('Side note')).not.toBeInTheDocument();
  });

  it('keeps a parent side chat out of the rail and still lists a non-side child', () => {
    render(rail({
      threads: [
        railThread({ id: 'main', title: 'Main' }),
        railThread({ id: 'side', title: 'Side note', parentThreadId: 'main', sideChat: true }),
        railThread({ id: 'child', title: 'Child agent', parentThreadId: 'main', sideChat: false }),
      ],
    }));
    expect(screen.getByText('Main')).toBeInTheDocument();
    expect(screen.getByText('Child agent')).toBeInTheDocument();
    expect(screen.queryByText('Side note')).not.toBeInTheDocument();
  });

  it('offers Regenerate title only for the selected thread and disables it while pending', () => {
    const onRegenerateTitle = vi.fn();
    vi.mocked(invokeCommand).mockClear();
    const threads = [
      railThread({ id: 'main', title: 'Main' }),
      railThread({ id: 'other', title: 'Other' }),
    ];
    const view = render(rail({ threads, selectedThreadId: 'main', onRegenerateTitle }));
    const button = screen.getByRole('button', { name: 'Regenerate title' });
    expect(screen.getAllByRole('button', { name: 'Regenerate title' })).toHaveLength(1);
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onRegenerateTitle).toHaveBeenCalledTimes(1);
    expect(onRegenerateTitle).toHaveBeenCalledWith('main');
    expect(invokeCommand).not.toHaveBeenCalled();

    onRegenerateTitle.mockClear();
    view.rerender(rail({ threads, selectedThreadId: 'main', onRegenerateTitle, titlePending: true }));
    expect(screen.getByRole('button', { name: 'Regenerate title' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate title' }));
    expect(onRegenerateTitle).not.toHaveBeenCalled();
    expect(invokeCommand).not.toHaveBeenCalled();
  });

  it('does not render Regenerate title when the handler is missing', () => {
    render(rail({
      threads: [railThread({ id: 'main', title: 'Main' })],
      selectedThreadId: 'main',
    }));
    expect(screen.queryByRole('button', { name: 'Regenerate title' })).not.toBeInTheDocument();
  });
});

describe('rail undo toast', () => {
  it('undoes pin and archive from the toast and from Ctrl+Z or Cmd+Z', () => {
    const onPin = vi.fn();
    const onArchive = vi.fn();
    const onRestore = vi.fn();
    const view = render(rail({
      threads: [railThread({ id: 'main', title: 'Main' })],
      onPinThread: onPin,
      onArchiveThread: onArchive,
      onRestoredThread: onRestore,
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Pin Main' }));
    expect(onPin).toHaveBeenCalledWith('main', true);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onPin).toHaveBeenLastCalledWith('main', false);
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();

    view.rerender(rail({
      threads: [railThread({ id: 'main', title: 'Main', pinned: true })],
      onPinThread: onPin,
      onArchiveThread: onArchive,
      onRestoredThread: onRestore,
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Unpin Main' }));
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(onPin).toHaveBeenLastCalledWith('main', true);

    view.rerender(rail({
      threads: [railThread({ id: 'main', title: 'Main' })],
      onPinThread: onPin,
      onArchiveThread: onArchive,
      onRestoredThread: onRestore,
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive Main' }));
    expect(onArchive).toHaveBeenCalledWith('main');
    fireEvent.keyDown(window, { key: 'Z', metaKey: true });
    expect(onRestore).toHaveBeenCalledWith('main');
  });

  it('does not treat Ctrl+Shift+Z as undo', () => {
    const onPin = vi.fn();
    render(rail({
      threads: [railThread({ id: 'main', title: 'Main' })],
      onPinThread: onPin,
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Pin Main' }));
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(onPin).toHaveBeenCalledTimes(1);
  });
});

describe('stash files, goals, slash position, and handoff', () => {
  it('restores uploaded stash files only in the same environment and only for 24 hours', () => {
    expect(stashUploadRestore(0, 86_400_000, 'lab', 'lab')).toBe('restore');
    expect(stashUploadRestore(0, 86_400_001, 'lab', 'lab')).toBe('attach-again');
    expect(stashUploadRestore(0, 1_000, 'lab', 'other')).toBe('wrong-environment');
    expect(stashUploadRestore(0, 86_400_001, 'lab', 'other')).toBe('wrong-environment');
  });

  it('pauses a Codex goal and ends the Claude turn without dropping the goal', () => {
    expect(goalAfterStop('codex', 'tests pass')).toEqual({ goal: 'tests pass', paused: true, turnEnded: false });
    expect(goalAfterStop('claude', 'tests pass')).toEqual({ goal: 'tests pass', paused: false, turnEnded: true });
    expect(goalAfterStop('grok', 'tests pass')).toEqual({ goal: 'tests pass', paused: false, turnEnded: false });
  });

  it('lets the composer stop handler pause Codex and keep a Claude goal', () => {
    expect(composerGoalStop('codex', 'tests pass')).toEqual({ goal: 'tests pass', paused: true, turnEnded: false });
    expect(composerGoalStop('claude', 'tests pass')).toEqual({ goal: 'tests pass', paused: false, turnEnded: true });
    expect(composerGoalStop('grok', null)).toEqual({ goal: null, paused: false, turnEnded: false });
  });

  it('adds the file expiry result only when a stash recorded filesUploadedHere', () => {
    expect(stashFileRestorable({ savedAt: 0 }, 86_400_001, 'lab')).toBeNull();
    expect(stashFileRestorable({ savedAt: 0, filesUploadedHere: 'lab' }, 86_400_000, 'lab')).toBe('restore');
    expect(stashFileRestorable({ savedAt: 0, filesUploadedHere: 'lab' }, 86_400_001, 'lab')).toBe('attach-again');
    expect(stashFileRestorable({ savedAt: 1_000, filesUploadedHere: 'lab' }, 2_000, 'other')).toBe('wrong-environment');
    expect(stashFileRestorable({ savedAt: 0, filesUploadedHere: '' }, 86_400_001, 'lab')).toBeNull();
  });

  it('recognizes provider commands only at the start, and /model or a skill mention on any line', () => {
    expect(slashIntent('ship /goal now', 'codex')).toBe('message');
    expect(slashIntent('please /compact', 'codex')).toBe('message');
    expect(slashIntent('later /side', 'grok')).toBe('message');
    expect(slashIntent('/side look', 'grok')).toBe('side');
    expect(slashIntent('hello\n/model gpt-5', 'grok')).toBe('model');
    expect(slashIntent('use $review on this', 'claude')).toBe('skill');
    expect(slashIntent('/clear\n$review', 'grok')).toBe('clear');
    expect(slashIntent('/goal keep\n$review', 'codex')).toBe('goal');
    expect(slashIntent('/goal keep\n$review', 'grok')).toBe('skill');
  });

  it('keeps the new request intact and drops attachments, reasoning, and tool items', () => {
    const request = 'please do the new thing without shortening';
    const withFile = { kind: 'user', text: 'file note', attachments: [{ id: 'a' }] };
    const result = handoffMessages([
      { kind: 'user', text: 'original task that is long' },
      { kind: 'tool', text: 'raw blob' },
      { kind: 'reasoning', text: 'hidden trace' },
      withFile,
      { kind: 'command', text: 'npm test' },
    ], 12, request);
    expect(result).toEqual({
      selection: [{ kind: 'command', text: 'npm test' }],
      request,
      askedToCompact: false,
    });
    expect(withFile.attachments).toEqual([{ id: 'a' }]);
    expect(result.request).toBe(request);
    expect(result.request.length).toBe(request.length);

    const longRequest = 'x'.repeat(80);
    const bounded = handoffMessages([
      { kind: 'assistant', text: 'history that will not fit' },
    ], 5, longRequest);
    expect(bounded.selection).toEqual([]);
    expect(bounded.request).toBe(longRequest);
    expect(bounded.askedToCompact).toBe(false);
  });

  it('hands Codex a direct channel only when the installed version supports it', () => {
    expect(handoffChannel('codex', true)).toBe('direct');
    expect(handoffChannel('codex', false)).toBe('attributed');
    expect(handoffChannel('claude', true)).toBe('attributed');
    expect(handoffChannel('grok', true)).toBe('attributed');
  });
});

describe('composer fresh context and compact', () => {
  it('sends /compact only for codex and claude', () => {
    expect(compactSendText('codex')).toBe('/compact');
    expect(compactSendText('claude')).toBe('/compact');
    expect(compactSendText('grok')).toBeNull();
    expect(compactSendText('opencode')).toBeNull();
  });

  it('stores freshContext on the next real send and carries /compact without dropping earlier messages', async () => {
    const onSend = vi.fn();
    const thread = railThread({
      id: 'thread-1',
      title: 'Thread',
      provider: 'codex',
      items: [userItem()],
    });
    const props = {
      workspaceId: null,
      isFocused: true,
      isMulti: false,
      running: false,
      attachments: [],
      liveRunsCount: 0,
      dynamicModels: [],
      editingTitleId: null,
      titleInput: '',
      onFocus: () => undefined,
      onClosePane: () => undefined,
      onNewThread: () => undefined,
      onStartRename: () => undefined,
      onSaveRename: () => undefined,
      onChangeTitleInput: () => undefined,
      onCancelRename: () => undefined,
      onStop: () => undefined,
      onPickAttachments: () => undefined,
      onStageFiles: () => undefined,
      onStagePaths: () => undefined,
      onRemoveAttachment: () => undefined,
      onUpdateConfig: () => undefined,
      onApprovalDecision: () => undefined,
    };

    function Harness({
      provider,
      initial,
    }: {
      provider: ExtendedChatThread['provider'];
      initial: string;
    }) {
      const [prompt, setPrompt] = useState(initial);
      return createElement(SingleThreadPane, {
        thread: { ...thread, provider },
        prompt,
        onChangePrompt: setPrompt,
        onSend,
        ...props,
      });
    }

    vi.mocked(invokeCommand).mockClear();
    const view = render(createElement(Harness, { key: 'codex', provider: 'codex', initial: '/compact' }));
    expect(screen.getByText('Restore this turn')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('/compact');
    expect(screen.getByText('Restore this turn')).toBeInTheDocument();
    expect(invokeCommand).not.toHaveBeenCalledWith(
      'update_chat_configuration',
      expect.objectContaining({ freshContext: true }),
    );

    onSend.mockClear();
    vi.mocked(invokeCommand).mockClear();
    view.rerender(createElement(Harness, { key: 'grok', provider: 'grok', initial: '/compact' }));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText('This provider cannot compact.')).toBeInTheDocument();
    expect(screen.getByText('Restore this turn')).toBeInTheDocument();

    onSend.mockClear();
    vi.mocked(invokeCommand).mockClear();
    view.rerender(createElement(Harness, { key: 'clear', provider: 'claude', initial: '/clear' }));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(invokeCommand).not.toHaveBeenCalledWith(
      'update_chat_configuration',
      expect.objectContaining({ freshContext: true }),
    );
    expect(screen.getByText('New session')).toBeInTheDocument();
    expect(screen.getByText('Restore this turn')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(invokeCommand).toHaveBeenCalledWith('update_chat_configuration', {
      threadId: 'thread-1',
      freshContext: true,
    });
    expect(onSend).toHaveBeenCalled();
    expect(screen.getByText('Restore this turn')).toBeInTheDocument();
  });
});

describe('file restore on the thread row', () => {
  it('enables file restore only when the thread has an isolated checkout and the provider can rewind', () => {
    const thread = railThread({
      id: 'thread-1',
      title: 'Thread',
      items: [userItem()],
      isolatedCheckout: true,
      providerCanRewind: false,
    });
    const props = {
      workspaceId: null,
      isFocused: true,
      isMulti: false,
      running: false,
      prompt: '',
      attachments: [],
      liveRunsCount: 0,
      dynamicModels: [],
      editingTitleId: null,
      titleInput: '',
      onFocus: () => undefined,
      onClosePane: () => undefined,
      onNewThread: () => undefined,
      onStartRename: () => undefined,
      onSaveRename: () => undefined,
      onChangeTitleInput: () => undefined,
      onCancelRename: () => undefined,
      onChangePrompt: () => undefined,
      onSend: () => undefined,
      onStop: () => undefined,
      onPickAttachments: () => undefined,
      onStageFiles: () => undefined,
      onStagePaths: () => undefined,
      onRemoveAttachment: () => undefined,
      onUpdateConfig: () => undefined,
      onApprovalDecision: () => undefined,
    };
    const view = render(createElement(SingleThreadPane, { thread, ...props }));
    fireEvent.click(screen.getByTitle('Editar desde aquí'));
    expect(screen.getByRole('button', { name: 'Revertir archivos también' })).toBeDisabled();
    view.rerender(createElement(SingleThreadPane, {
      thread: { ...thread, isolatedCheckout: true, providerCanRewind: true },
      ...props,
    }));
    expect(screen.getByRole('button', { name: 'Revertir archivos también' })).toBeEnabled();
  });
});
