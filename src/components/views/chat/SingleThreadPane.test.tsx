import { createElement } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SingleThreadPane } from './SingleThreadPane';
import { composeRewoundPrompt, changedFilesForTurn } from './pane/threadTurnHelpers';
import {
  consumePendingDiffPreview,
  OPEN_RIGHT_DOCK_DIFFS_EVENT,
  type DiffPreviewRequest,
} from '../../../lib/diffPreviewNav';
import type { ExtendedChatThread } from './types';
import type { ChatItem } from '../../../types';

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
});
