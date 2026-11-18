import { createElement, useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SingleThreadPane } from './SingleThreadPane';
import { toast } from '../../../lib/toast';
import { composeRewoundPrompt, changedFilesForTurn } from './pane/threadTurnHelpers';
import {
  consumePendingDiffPreview,
  OPEN_RIGHT_DOCK_DIFFS_EVENT,
  type DiffPreviewRequest,
} from '../../../lib/diffPreviewNav';
import type { ExtendedChatThread } from './types';
import type { ChatItem } from '../../../types';

vi.mock('../../../lib/toast', () => ({ toast: { error: vi.fn() } }));

vi.mock('../../../lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/ipc')>();
  return {
    ...actual,
    invokeCommand: vi.fn().mockResolvedValue(null),
    listWorkspaceBranches: vi.fn().mockResolvedValue({ branches: ['main', 'feat-x'], current: 'main' }),
    switchWorkspaceBranch: vi.fn().mockResolvedValue({ branches: ['main', 'feat-x'], current: 'feat-x' }),
    createWorkspaceBranch: vi.fn().mockResolvedValue({ branches: ['main', 'feat-x', 'new-b'], current: 'new-b' }),
    listConnections: vi.fn().mockResolvedValue([]),
  };
});

function createThread(partial: Partial<ExtendedChatThread> = {}): ExtendedChatThread {
  return {
    schemaVersion: 1,
    revision: '1',
    id: 'thread-1',
    profileId: null,
    provider: 'claude',
    title: 'Test Thread',
    items: [],
    mode: 'acceptEdits',
    plan: false,
    model: null,
    status: 'idle',
    usage: { inputTokens: 10, outputTokens: 20, costUsd: 0 },
    workspaceId: 'ws-1',
    pinned: false,
    createdAtUnixMs: 1000,
    updatedAtUnixMs: 1000,
    ...partial,
  };
}

describe('SingleThreadPane component', () => {
  const defaultProps = {
    workspaceId: 'ws-1',
    workspaceName: 'Test Workspace',
    workspaces: [{ id: 'ws-1', name: 'Test Workspace' }],
    isFocused: true,
    isMulti: false,
    running: false,
    prompt: '',
    attachments: [],
    liveRunsCount: 0,
    dynamicModels: [],
    editingTitleId: null,
    titleInput: '',
    onFocus: vi.fn(),
    onClosePane: vi.fn(),
    onNewThread: vi.fn(),
    onStartRename: vi.fn(),
    onSaveRename: vi.fn(),
    onChangeTitleInput: vi.fn(),
    onCancelRename: vi.fn(),
    onChangePrompt: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    onPickAttachments: vi.fn(),
    onStageFiles: vi.fn(),
    onStagePaths: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onUpdateConfig: vi.fn(),
    onApprovalDecision: vi.fn(),
  };

  it('renders header, draft hero, and composer when empty', () => {
    const thread = createThread();
    render(createElement(SingleThreadPane, { thread, ...defaultProps }));

    const header = screen.getByRole('toolbar', { name: 'Thread header' });
    expect(header).toBeInTheDocument();
    expect(screen.getAllByText('Test Workspace').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Test Thread')).toBeInTheDocument();
  });

  it('renders safely when a persisted thread is missing the items array', () => {
    const thread = {
      ...createThread({ id: 'parent-done-missing-items', title: 'Completed Thread' }),
      items: undefined as unknown as ChatItem[],
    };
    render(createElement(SingleThreadPane, { thread, ...defaultProps }));

    expect(screen.getByRole('toolbar', { name: 'Thread header' })).toBeInTheDocument();
    expect(screen.getByText('Completed Thread')).toBeInTheDocument();
  });

  it('triggers onNewThread when clicking New thread button in header', () => {
    const onNewThread = vi.fn();
    const thread = createThread();
    render(createElement(SingleThreadPane, { thread, ...defaultProps, onNewThread }));

    const newBtn = screen.getByRole('button', { name: 'New thread' });
    fireEvent.click(newBtn);
    expect(onNewThread).toHaveBeenCalledTimes(1);
    expect(onNewThread).toHaveBeenCalledWith();
  });

  it('allows clicking title to start renaming', () => {
    const onStartRename = vi.fn();
    const thread = createThread({ id: 'thread-42', title: 'Renamable Title' });
    render(createElement(SingleThreadPane, { thread, ...defaultProps, onStartRename }));

    const titleWrap = screen.getByTitle('Click to rename chat');
    fireEvent.click(titleWrap);
    expect(onStartRename).toHaveBeenCalledWith('thread-42', 'Renamable Title');
  });

  it('renders rename input when editingTitleId matches', () => {
    const onChangeTitleInput = vi.fn();
    const onSaveRename = vi.fn();
    const thread = createThread({ id: 'thread-42', title: 'Renamable Title' });
    render(
      createElement(SingleThreadPane, {
        thread,
        ...defaultProps,
        editingTitleId: 'thread-42',
        titleInput: 'New Title Draft',
        onChangeTitleInput,
        onSaveRename,
      })
    );

    const input = screen.getByDisplayValue('New Title Draft');
    fireEvent.change(input, { target: { value: 'Changed Title' } });
    expect(onChangeTitleInput).toHaveBeenCalledWith('Changed Title');

    fireEvent.click(screen.getByTitle('Save title'));
    expect(onSaveRename).toHaveBeenCalled();
  });

  it('opens Diffs focused on turn changes when clicking Open diff or a file row', () => {
    const listener = vi.fn();
    const onEvent = (e: Event) => listener((e as CustomEvent<DiffPreviewRequest>).detail);
    window.addEventListener(OPEN_RIGHT_DOCK_DIFFS_EVENT, onEvent);

    const thread = createThread({
      items: [
        {
          id: 'u1',
          kind: 'user',
          text: 'Edit README',
          title: null,
          detail: null,
          status: null,
          streaming: false,
          exitCode: null,
          createdAtUnixMs: 1,
          attachments: [],
        },
        {
          id: 't1',
          kind: 'tool',
          text: '',
          title: 'Edit README.md',
          detail: null,
          status: 'completed',
          streaming: false,
          exitCode: null,
          createdAtUnixMs: 2,
          attachments: [],
          toolKind: 'fileChange',
          filePath: 'C:\\Users\\PC\\Desktop\\Proyectos\\Test Workspace\\README.md',
          addedLines: 2,
          removedLines: 2,
        },
      ],
    });

    render(createElement(SingleThreadPane, { thread, ...defaultProps }));

    const card = screen.getByRole('region', { name: '1 changed file' });
    fireEvent.click(within(card).getByRole('button', { name: 'Open diff' }));
    expect(listener).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      workspaceName: 'Test Workspace',
      focusPaths: ['C:\\Users\\PC\\Desktop\\Proyectos\\Test Workspace\\README.md'],
    });

    expect(within(card).queryByRole('button', { name: /README\.md/i })).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Expand changed files' }));
    fireEvent.click(within(card).getByRole('button', { name: /README\.md/i }));
    expect(listener).toHaveBeenLastCalledWith({
      workspaceId: 'ws-1',
      workspaceName: 'Test Workspace',
      focusPaths: ['C:\\Users\\PC\\Desktop\\Proyectos\\Test Workspace\\README.md'],
      selectedPath: 'C:\\Users\\PC\\Desktop\\Proyectos\\Test Workspace\\README.md',
    });

    consumePendingDiffPreview();
    window.removeEventListener(OPEN_RIGHT_DOCK_DIFFS_EVENT, onEvent);
  });

  it('keeps unassigned threads free of Code workspace fallback and forwards threadId when adding a folder', () => {
    const events: Array<{ threadId?: string }> = [];
    const onAddWs = (e: Event) => events.push((e as CustomEvent<{ threadId?: string }>).detail ?? {});
    window.addEventListener('kite:add-workspace', onAddWs);
    try {
      const onUpdateConfig = vi.fn();
      const thread = createThread({ id: 'thread-unassigned', workspaceId: null, items: [] });
      render(
        createElement(SingleThreadPane, {
          ...defaultProps,
          thread,
          workspaceId: 'ws-kite',
          workspaceName: 'kite',
          workspaces: [
            { id: 'ws-kite', name: 'kite' },
            { id: 'ws-local-name', name: 'Local' },
          ],
          onUpdateConfig,
        })
      );

      const header = screen.getByRole('toolbar', { name: 'Thread header' });
      expect(within(header).getByText('No folder')).toBeInTheDocument();
      expect(within(header).queryByText('kite')).not.toBeInTheDocument();

      const addFolderBtn = screen.getByRole('button', { name: 'Add a folder' });
      fireEvent.click(addFolderBtn);
      expect(events).toEqual([{ threadId: 'thread-unassigned' }]);

      // Selecting a folder from header updates thread workspaceId
      fireEvent.click(within(header).getByRole('button', { name: /No folder/i }));
      fireEvent.click(within(header).getByRole('button', { name: 'kite' }));
      expect(onUpdateConfig).toHaveBeenCalledWith({ workspaceId: 'ws-kite' });

      // Composer context strip must not confuse workspace named "Local" with null workspaceId
      fireEvent.click(screen.getByTitle('Select workspace environment'));
      const envDialog = screen.getByRole('dialog', { name: 'Workspace Environment' });
      const localNamedWsBtn = within(envDialog).getByRole('button', { name: 'Local' });
      expect(localNamedWsBtn.className).not.toContain('kite-context-menu-item--selected');
      fireEvent.click(within(envDialog).getByRole('button', { name: 'kite' }));
      expect(onUpdateConfig).toHaveBeenCalledWith({ workspaceId: 'ws-kite' });
    } finally {
      window.removeEventListener('kite:add-workspace', onAddWs);
    }
  });

  it('keeps real-time tool execution inside one unified ChatWorkGroup across invisible items and splits only on visible text', () => {
    const base = {
      title: null,
      detail: null,
      status: 'completed' as const,
      streaming: false,
      exitCode: null,
      createdAtUnixMs: 10,
      attachments: [],
    };
    const thread = createThread({
      status: 'running',
      items: [
        { ...base, id: 'u1', kind: 'user', status: null, text: 'Inspect files and run tests' },
        { ...base, id: 't1', kind: 'tool', toolKind: 'read', title: 'Read a.ts', filePath: 'src/a.ts', text: '' },
        { ...base, id: 't2', kind: 'tool', toolKind: 'read', title: 'Read b.ts', filePath: 'src/b.ts', text: '' },
        { ...base, id: 'n1', kind: 'notice' as ChatItem['kind'], text: 'unrecognized frame ping' },
        {
          ...base,
          id: 'note1',
          kind: 'note',
          text: 'The provider has not sent an update. Stop the turn if this stays quiet.',
        },
        { ...base, id: 'a-empty', kind: 'assistant', text: ' \n ' },
        { ...base, id: 'c1', kind: 'command', command: 'cargo test', title: 'cargo test', text: '', status: 'running', streaming: true },
      ],
    });

    const { container, rerender } = render(
      createElement(SingleThreadPane, { thread, ...defaultProps, running: true }),
    );

    const groups = container.querySelectorAll('.chat-work-group');
    expect(groups).toHaveLength(1);
    const toggle = groups[0]!.querySelector('.chat-work-group__toggle') as HTMLButtonElement;
    expect(toggle).toHaveTextContent('Running cargo');
    expect(groups[0]).toHaveClass('chat-work-group--live');

    fireEvent.click(toggle);
    const groupItems = groups[0]!.querySelector('.chat-work-group__items') as HTMLElement;
    expect(within(groupItems).getByTitle('Read src/a.ts')).toBeInTheDocument();
    expect(within(groupItems).getByTitle('Read src/b.ts')).toBeInTheDocument();
    expect(within(groupItems).getByTitle('Running cargo')).toBeInTheDocument();

    const splitThread = createThread({
      status: 'idle',
      items: [
        { ...base, id: 'u1', kind: 'user', status: null, text: 'Inspect and fix' },
        { ...base, id: 't1', kind: 'tool', toolKind: 'read', title: 'Read a.ts', filePath: 'src/a.ts', text: '' },
        { ...base, id: 'a-mid', kind: 'assistant', text: 'Found the bug, applying fix next.' },
        { ...base, id: 't2', kind: 'tool', toolKind: 'edit', title: 'Edit a.ts', filePath: 'src/a.ts', text: '' },
      ],
    });

    rerender(createElement(SingleThreadPane, { thread: splitThread, ...defaultProps, running: false }));
    expect(container.querySelectorAll('.chat-work-group')).toHaveLength(2);
    expect(screen.getByText('Found the bug, applying fix next.')).toBeInTheDocument();
  });

  it('queues messages while running, preserves them across thread switches, and supports expand, edit with draft restoration, and send now', () => {
    const onQueuePrompt = vi.fn();
    const onUpdateQueuedRuns = vi.fn();
    const onSendNowQueuedRun = vi.fn();
    const onSetAttachments = vi.fn();
    const onChangePrompt = vi.fn();

    const imgAtt = {
      resourceId: 'att-q1',
      displayName: 'mockup.png',
      isDirectory: false,
      byteSize: 1024,
      mimeType: 'image/png',
      previewDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    };

    const threadA = createThread({
      id: 'thread-a',
      title: 'Thread A',
      status: 'running',
      queuedRuns: [
        { id: 'q-1', text: 'First queued message', attachments: [imgAtt] },
        { id: 'q-2', text: 'Second queued message' },
        { id: 'q-3', text: 'Third queued message' },
        { id: 'q-4', text: 'Fourth queued message' },
      ],
    });
    const threadB = createThread({
      id: 'thread-b',
      title: 'Thread B',
      status: 'idle',
      queuedRuns: [],
    });

    const { rerender } = render(
      createElement(SingleThreadPane, {
        ...defaultProps,
        thread: threadA,
        running: true,
        prompt: 'Unsent current draft',
        attachments: [],
        onChangePrompt,
        onQueuePrompt,
        onUpdateQueuedRuns,
        onSendNowQueuedRun,
        onSetAttachments,
      })
    );

    const queueRegion = screen.getByRole('region', { name: 'Queued messages' });
    expect(within(queueRegion).getByText('Queued (4)')).toBeInTheDocument();
    expect(within(queueRegion).getByText('First queued message')).toBeInTheDocument();
    expect(within(queueRegion).getByText('mockup.png')).toBeInTheDocument();
    expect(within(queueRegion).queryByText('Fourth queued message')).not.toBeInTheDocument();

    // Expand beyond 3 items and collapse
    fireEvent.click(within(queueRegion).getByRole('button', { name: 'Show 1 more' }));
    expect(within(queueRegion).getByText('Fourth queued message')).toBeInTheDocument();
    fireEvent.click(within(queueRegion).getByRole('button', { name: 'Show less' }));
    expect(within(queueRegion).queryByText('Fourth queued message')).not.toBeInTheDocument();

    // In-place edit loads queued message + attachments and cancelling restores the unsent draft
    const editButtons = within(queueRegion).getAllByRole('button', { name: 'Edit' });
    fireEvent.click(editButtons[0]);
    expect(onChangePrompt).toHaveBeenCalledWith('First queued message');
    expect(onSetAttachments).toHaveBeenCalledWith([imgAtt]);
    expect(within(queueRegion).getByText('Editing')).toBeInTheDocument();

    fireEvent.click(within(queueRegion).getByRole('button', { name: 'Cancel' }));
    expect(onChangePrompt).toHaveBeenLastCalledWith('Unsent current draft');
    expect(onSetAttachments).toHaveBeenLastCalledWith([]);

    // Send now triggers immediate dispatch callback
    const sendNowButtons = within(queueRegion).getAllByRole('button', { name: 'Send now' });
    fireEvent.click(sendNowButtons[0]);
    expect(onSendNowQueuedRun).toHaveBeenCalledWith('q-1');

    // Switch to Thread B and back to Thread A -> queued messages remain intact
    rerender(
      createElement(SingleThreadPane, {
        ...defaultProps,
        thread: threadB,
        running: false,
        prompt: '',
      })
    );
    expect(screen.queryByRole('region', { name: 'Queued messages' })).not.toBeInTheDocument();

    rerender(
      createElement(SingleThreadPane, {
        ...defaultProps,
        thread: threadA,
        running: true,
        prompt: '',
      })
    );
    expect(screen.getByRole('region', { name: 'Queued messages' })).toBeInTheDocument();
    expect(screen.getByText('First queued message')).toBeInTheDocument();
  });

  it('toasts generic process failures instead of docking a banner', () => {
    const thread = createThread({
      turnFailure: { kind: 'processError', message: 'API error: dial tcp failed' },
    });
    render(createElement(SingleThreadPane, { thread, ...defaultProps }));
    expect(toast.error).toHaveBeenCalledWith('Thread error', 'API error: dial tcp failed');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('docks usage-limit failures above the composer without a toast', () => {
    vi.mocked(toast.error).mockClear();
    const thread = createThread({
      turnFailure: { kind: 'usageLimit', message: 'Quota reached', resetAtUnixMs: null },
    });
    render(createElement(SingleThreadPane, { thread, ...defaultProps }));
    expect(screen.getByRole('alert')).toHaveTextContent('Usage limit reached');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('hides the composer folder and branch context strip once the thread starts while keeping the thread header', async () => {
    const draftThread = createThread({ id: 'thread-strip', items: [] });
    const { rerender } = render(
      createElement(SingleThreadPane, {
        ...defaultProps,
        thread: draftThread,
        running: false,
      }),
    );

    expect(screen.getByTitle('Select workspace environment')).toBeInTheDocument();
    expect(screen.getByRole('toolbar', { name: 'Thread header' })).toBeInTheDocument();

    const startedThread = createThread({
      id: 'thread-strip',
      items: [
        {
          id: 'u-1',
          kind: 'user',
          text: 'Ship the fix',
          title: null,
          detail: null,
          status: null,
          streaming: false,
          exitCode: null,
          createdAtUnixMs: 100,
          attachments: [],
        },
      ],
    });

    rerender(
      createElement(SingleThreadPane, {
        ...defaultProps,
        thread: startedThread,
        running: true,
      }),
    );

    await waitFor(() => {
      expect(screen.queryByTitle('Select workspace environment')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('toolbar', { name: 'Thread header' })).toBeInTheDocument();
  });

  it('resets failure dismissal across thread switches and avoids re-toasting identical historical failures', () => {
    vi.mocked(toast.error).mockClear();

    const usageThreadA = createThread({
      id: 'thread-dismiss-a',
      turnFailure: { kind: 'usageLimit', message: 'Quota A', resetAtUnixMs: null },
    });
    const usageThreadB = createThread({
      id: 'thread-dismiss-b',
      turnFailure: { kind: 'usageLimit', message: 'Quota B', resetAtUnixMs: null },
    });
    const { rerender, unmount } = render(
      createElement(SingleThreadPane, { thread: usageThreadA, ...defaultProps })
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Quota A');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    rerender(createElement(SingleThreadPane, { thread: usageThreadB, ...defaultProps }));
    expect(screen.getByRole('alert')).toHaveTextContent('Quota B');
    unmount();

    const processThread = createThread({
      id: 'thread-revisit-toast',
      updatedAtUnixMs: 2000,
      turnFailure: { kind: 'processError', message: 'API error: lookup daily-cloudcode-pa failed' },
    });
    const firstMount = render(
      createElement(SingleThreadPane, { thread: processThread, ...defaultProps })
    );
    expect(toast.error).toHaveBeenCalledTimes(1);
    firstMount.unmount();

    const secondMount = render(
      createElement(SingleThreadPane, { thread: processThread, ...defaultProps })
    );
    expect(toast.error).toHaveBeenCalledTimes(1);
    secondMount.unmount();

    const newerFailure = createThread({
      id: 'thread-revisit-toast',
      updatedAtUnixMs: 3000,
      turnFailure: { kind: 'processError', message: 'API error: lookup daily-cloudcode-pa failed' },
    });
    render(createElement(SingleThreadPane, { thread: newerFailure, ...defaultProps }));
    expect(toast.error).toHaveBeenCalledTimes(2);
  });

  it('delegates queueing to onQueuePrompt without duplicating local rows and restores unsent draft after edit+save', () => {
    const onQueuePrompt = vi.fn();
    const onUpdateQueuedRuns = vi.fn();
    const initialThread = createThread({
      id: 'thread-q-edit',
      status: 'running',
      queuedRuns: [{ id: 'q-canonical-1', text: 'Original queued' }],
    });

    function QueueHarness() {
      const [prompt, setPrompt] = useState('Unsent current draft');
      const [attachments, setAttachments] = useState<any[]>([]);
      return createElement(SingleThreadPane, {
        ...defaultProps,
        thread: initialThread,
        running: true,
        prompt,
        attachments,
        onChangePrompt: setPrompt,
        onSetAttachments: setAttachments,
        onQueuePrompt,
        onUpdateQueuedRuns,
      });
    }

    render(createElement(QueueHarness));

    const queueRegion = screen.getByRole('region', { name: 'Queued messages' });
    fireEvent.click(within(queueRegion).getByRole('button', { name: 'Edit' }));
    const textbox = screen.getByRole('textbox');
    expect(textbox).toHaveValue('Original queued');
    fireEvent.change(textbox, { target: { value: 'Edited queued' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onUpdateQueuedRuns).toHaveBeenCalledWith(
      [{ id: 'q-canonical-1', text: 'Edited queued' }],
      undefined,
    );
    expect(screen.getByRole('textbox')).toHaveValue('Unsent current draft');

    fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
    expect(onQueuePrompt).toHaveBeenCalledWith('Unsent current draft', []);
    expect(within(queueRegion).getByText('Queued (1)')).toBeInTheDocument();
  });

  it('allows launching Voice Mode in a fresh thread while running and keeps ChatPlanPanel disabled while running', async () => {
    const { voiceSessionStore } = await import('../../../lib/operator/voice/voiceSessionStore');
    voiceSessionStore.stopSession();
    const onNewThread = vi.fn().mockResolvedValue('voice-thread-new');
    const thread = createThread({
      id: 'thread-busy',
      status: 'running',
      activePlan: {
        id: 'plan-1',
        revision: 1,
        markdown: '# Proposed Plan\n- Step 1',
        status: 'ready',
      },
    });

    render(
      createElement(SingleThreadPane, {
        ...defaultProps,
        thread,
        running: true,
        onNewThread,
      }),
    );

    const voiceBtn = screen.getByLabelText('Iniciar sesión de voz');
    expect(voiceBtn).not.toBeDisabled();
    fireEvent.click(voiceBtn);

    await waitFor(() => {
      expect(onNewThread).toHaveBeenCalledTimes(1);
      expect(voiceSessionStore.getSnapshot().boundThreadId).toBe('voice-thread-new');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Proposed Plan' }));
    expect(screen.getByRole('button', { name: 'Implement' })).toBeDisabled();

    voiceSessionStore.stopSession();
  });

  it('shows Resume when an interrupted idle thread has stoppedByBuilder and omits follow-up queue prompt on subagent threads with directNotice', () => {
    const stoppedThread = createThread({
      status: 'idle',
      stoppedByBuilder: true,
      queuedRuns: [],
    });
    const { rerender } = render(
      createElement(SingleThreadPane, {
        ...defaultProps,
        thread: stoppedThread,
        running: false,
      })
    );
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();

    const subagentThread = createThread({
      status: 'running',
      parentThreadId: 'parent-1',
      startedByAgent: true,
    });
    rerender(
      createElement(SingleThreadPane, {
        ...defaultProps,
        thread: subagentThread,
        running: true,
        onSteerPrompt: vi.fn(),
        onQueuePrompt: vi.fn(),
      })
    );
    expect(screen.getByText('Message the parent thread.')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Write a follow-up while your agent works…')).toBeNull();
  });
});

describe('threadTurnHelpers', () => {
  it('composeRewoundPrompt formats rewound and draft text correctly', () => {
    expect(composeRewoundPrompt('', 'rewound prompt')).toBe('rewound prompt');
    expect(composeRewoundPrompt('   ', 'rewound prompt')).toBe('rewound prompt');
    expect(composeRewoundPrompt('same text', 'same text')).toBe('same text');
    expect(composeRewoundPrompt('existing draft', 'rewound prompt')).toBe('existing draft\n\nrewound prompt');
  });

  it('changedFilesForTurn aggregates file changes from the last user turn', () => {
    const items: ChatItem[] = [
      {
        id: 'u1',
        kind: 'user',
        text: 'first prompt',
        title: null,
        detail: null,
        status: null,
        streaming: false,
        exitCode: null,
        createdAtUnixMs: 1,
        attachments: [],
      },
      {
        id: 'a1',
        kind: 'tool',
        filePath: 'src/file1.ts',
        toolKind: 'fileChange',
        addedLines: 5,
        removedLines: 2,
        text: '',
        title: null,
        detail: null,
        status: null,
        streaming: false,
        exitCode: null,
        createdAtUnixMs: 2,
        attachments: [],
      },
      {
        id: 'u2',
        kind: 'user',
        text: 'second prompt',
        title: null,
        detail: null,
        status: null,
        streaming: false,
        exitCode: null,
        createdAtUnixMs: 3,
        attachments: [],
      },
      {
        id: 'a2',
        kind: 'tool',
        filePath: 'src/file2.ts',
        toolKind: 'fileChange',
        addedLines: 10,
        removedLines: 0,
        text: '',
        title: null,
        detail: null,
        status: null,
        streaming: false,
        exitCode: null,
        createdAtUnixMs: 4,
        attachments: [],
      },
    ];

    const changed = changedFilesForTurn(items);
    expect(changed).toEqual([
      {
        path: 'src/file2.ts',
        additions: 10,
        deletions: 0,
      },
    ]);
  });

  it('changedFilesForTurn handles edit/delete/move toolKinds and unified diff fallback text', () => {
    const items: ChatItem[] = [
      {
        id: 'u1',
        kind: 'user',
        text: 'edit readme',
        title: null,
        detail: null,
        status: null,
        streaming: false,
        exitCode: null,
        createdAtUnixMs: 1,
        attachments: [],
      },
      {
        id: 'e1',
        kind: 'tool',
        filePath: 'C:\\Users\\PC\\Desktop\\Proyectos\\kite\\README.md',
        toolKind: 'edit',
        text: '@@ -30,2 +30,2 @@\n-old line 1\n-old line 2\n+new line 1\n+new line 2\n',
        title: 'Edit README.md',
        detail: null,
        status: 'completed',
        streaming: false,
        exitCode: null,
        createdAtUnixMs: 2,
        attachments: [],
      },
    ];

    expect(changedFilesForTurn(items)).toEqual([
      {
        path: 'C:\\Users\\PC\\Desktop\\Proyectos\\kite\\README.md',
        additions: 2,
        deletions: 2,
      },
    ]);
  });

  it('changedFilesForTurn keeps edits across internal dispatch wakeups and composer history skips them', async () => {
    const { extractUserPromptHistory } = await import('./composer/composerTextHelpers');
    const envelope = [
      '[kite from="thread:child-1"]',
      'This is another agent, not the person.',
      'To reply: kite dispatch send thread:child-1 "<reply>"',
      'Irreversible and privileged actions still wait for the person.',
      'BODY:',
      'state: done',
    ].join('\n');
    const items = [
      {
        id: 'u1',
        kind: 'user' as const,
        text: 'Inspect and update readme',
        title: null,
        detail: null,
        status: null,
        streaming: false,
        exitCode: null,
        createdAtUnixMs: 1,
        attachments: [],
      },
      {
        id: 'edit-1',
        kind: 'tool' as const,
        filePath: 'README.md',
        toolKind: 'edit' as const,
        addedLines: 3,
        removedLines: 1,
        text: '',
        title: 'Edit README.md',
        detail: null,
        status: 'completed' as const,
        streaming: false,
        exitCode: null,
        createdAtUnixMs: 2,
        attachments: [],
      },
      {
        id: 'u-wakeup',
        kind: 'user' as const,
        text: envelope,
        internalDispatch: true,
        title: null,
        detail: null,
        status: null,
        streaming: false,
        exitCode: null,
        createdAtUnixMs: 3,
        attachments: [],
      },
    ];

    expect(changedFilesForTurn(items)).toEqual([
      {
        path: 'README.md',
        additions: 3,
        deletions: 1,
      },
    ]);
    expect(extractUserPromptHistory(items)).toEqual(['Inspect and update readme']);
  });
});
