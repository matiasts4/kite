import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MotionProvider } from '../../../motion/standard/context';
import { ThreadGrid } from './ThreadGrid';
import type { ExtendedChatThread } from './types';

vi.mock('../../../lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/ipc')>();
  return {
    ...actual,
    invokeCommand: vi.fn().mockResolvedValue(null),
    listWorkspaceBranches: vi.fn().mockResolvedValue({ branches: ['main'], current: 'main' }),
    switchWorkspaceBranch: vi.fn().mockResolvedValue({ branches: ['main'], current: 'main' }),
    createWorkspaceBranch: vi.fn().mockResolvedValue({ branches: ['main'], current: 'main' }),
    listConnections: vi.fn().mockResolvedValue([]),
  };
});

function createThread(id: string, title: string): ExtendedChatThread {
  return {
    schemaVersion: 1,
    revision: '1',
    id,
    profileId: null,
    provider: 'claude',
    title,
    items: [
      {
        id: `${id}-m1`,
        kind: 'user',
        text: `Prompt for ${title}`,
        title: null,
        detail: null,
        status: null,
        streaming: false,
        exitCode: null,
        createdAtUnixMs: 1000,
        attachments: [],
      },
    ],
    mode: 'acceptEdits',
    plan: false,
    model: null,
    status: 'idle',
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    workspaceId: 'ws-1',
    pinned: false,
    createdAtUnixMs: 1000,
    updatedAtUnixMs: 1000,
  };
}

describe('ThreadGrid transitions', () => {
  afterEach(() => {
    cleanup();
  });

  it('crossfades single-pane thread swaps while marking exiting panes inert and hidden from assistive tech', () => {
    const t1 = createThread('t1', 'First Thread');
    const t2 = createThread('t2', 'Second Thread');
    const sharedProps = {
      focusedThreadId: 't1',
      threadsMap: { t1, t2 },
      isRunning: {},
      attachmentsMap: {},
      promptMap: {},
      workspaceId: 'ws-1',
      workspaceName: 'Workspace',
      workspaces: [{ id: 'ws-1', name: 'Workspace' }],
      liveRunsCount: 0,
      dynamicModelsMap: {},
      activeDropdown: null,
      editingTitleId: null,
      titleInput: '',
      showHistoryPopover: false,
      knownThreadsList: [t1, t2],
      onFocusThread: vi.fn(),
      onClosePane: vi.fn(),
      onToggleSplit: vi.fn(),
      onToggleHistory: vi.fn(),
      onNewThread: vi.fn(),
      onSelectHistoryThread: vi.fn(),
      onPinThread: vi.fn(),
      onArchiveThread: vi.fn(),
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
      onDropdownToggle: vi.fn(),
      onUpdateConfig: vi.fn(),
      onApprovalDecision: vi.fn(),
    };

    const { rerender } = render(
      createElement(
        MotionProvider,
        null,
        createElement(ThreadGrid, {
          ...sharedProps,
          gridThreadIds: ['t1'],
          focusedThreadId: 't1',
        })
      )
    );

    expect(screen.getByText('Prompt for First Thread')).toBeInTheDocument();
    const initialFirstCell = document.querySelector('[data-thread-grid-cell="t1"]') as HTMLElement | null;
    expect(initialFirstCell?.style.width).toBe('100%');
    expect(initialFirstCell?.style.height).toBe('100%');

    rerender(
      createElement(
        MotionProvider,
        null,
        createElement(ThreadGrid, {
          ...sharedProps,
          gridThreadIds: ['t2'],
          focusedThreadId: 't2',
        })
      )
    );

    expect(screen.getByText('Prompt for Second Thread')).toBeInTheDocument();
    const firstCell = document.querySelector('[data-thread-grid-cell="t1"]');
    const secondCell = document.querySelector('[data-thread-grid-cell="t2"]');
    expect(secondCell).not.toBeNull();
    expect(secondCell).toHaveAttribute('data-motion-present', 'true');
    if (firstCell) {
      expect(firstCell).toHaveAttribute('aria-hidden', 'true');
      expect((firstCell as HTMLElement & { inert: boolean }).inert).toBe(true);
    }
  });
});
