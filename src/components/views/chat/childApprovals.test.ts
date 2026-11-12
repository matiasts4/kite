import { createElement } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SideChatPane } from './SideChatPane';
import { SingleThreadPane } from './SingleThreadPane';
import { bringBackAllowed, childApprovals, childStopIds, directMessageNotice } from './childApprovals';
import type { ApprovalRequest, ExtendedChatThread } from './types';
import type { ChatItem } from '../../../types';

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

const approval: ApprovalRequest = {
  id: 'apr-1',
  toolName: 'shell',
  title: 'Run tests',
  detail: 'npm test',
  risk: 'command',
  impact: 'local',
};

function userItem(): ChatItem {
  return {
    id: 'user-1',
    kind: 'user',
    text: 'hello',
    title: null,
    detail: null,
    status: null,
    streaming: false,
    exitCode: null,
    createdAtUnixMs: 1,
    attachments: [],
  };
}

function thread(partial: Partial<ExtendedChatThread> = {}): ExtendedChatThread {
  return {
    schemaVersion: 1,
    revision: '1',
    id: 'thread-1',
    profileId: null,
    provider: 'grok',
    title: 'Parent',
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

function renderPane(partial: {
  thread?: ExtendedChatThread;
  running?: boolean;
  prompt?: string;
  onSend?: () => void;
  onStop?: () => void;
  onStopThread?: (threadId: string) => void;
  onChangePrompt?: (value: string) => void;
  onApprovalDecision?: (decision: 'allowOnce' | 'allowForSession' | 'deny' | 'denyAndStop', reqId: string) => void;
  knownThreadsList?: ExtendedChatThread[];
} = {}) {
  return render(createElement(SingleThreadPane, {
    thread: partial.thread ?? thread(),
    workspaceId: null,
    isFocused: true,
    isMulti: false,
    running: partial.running ?? false,
    prompt: partial.prompt ?? '',
    attachments: [],
    liveRunsCount: 0,
    dynamicModels: [],
    editingTitleId: null,
    titleInput: '',
    knownThreadsList: partial.knownThreadsList ?? [],
    onFocus: () => undefined,
    onClosePane: () => undefined,
    onNewThread: () => undefined,
    onStartRename: () => undefined,
    onSaveRename: () => undefined,
    onChangeTitleInput: () => undefined,
    onCancelRename: () => undefined,
    onChangePrompt: partial.onChangePrompt ?? (() => undefined),
    onSend: partial.onSend ?? (() => undefined),
    onStop: partial.onStop ?? (() => undefined),
    onStopThread: partial.onStopThread,
    onPickAttachments: () => undefined,
    onStageFiles: () => undefined,
    onStagePaths: () => undefined,
    onRemoveAttachment: () => undefined,
    onUpdateConfig: () => undefined,
    onApprovalDecision: partial.onApprovalDecision ?? (() => undefined),
  }));
}

describe('child approvals', () => {
  it('surfaces a child approval labeled with the child title', () => {
    expect(childApprovals('parent', [
      { id: 'child', title: 'Reviewer', parentThreadId: 'parent', pendingApproval: approval },
      { id: 'other', title: 'Nope', parentThreadId: 'else', pendingApproval: approval },
      { id: 'quiet', title: 'Quiet', parentThreadId: 'parent', pendingApproval: null },
      { id: 'side', title: 'Side', parentThreadId: 'parent', pendingApproval: approval, sideChat: true },
    ])).toEqual([{ threadId: 'child', title: 'Reviewer', approval }]);
  });

  it('stops every child subagent and still stops the parent', () => {
    expect(childStopIds('parent', [
      { id: 'c1', parentThreadId: 'parent' },
      { id: 'c2', parentThreadId: 'parent', pendingApproval: null },
      { id: 'side', parentThreadId: 'parent', sideChat: true },
      { id: 'other', parentThreadId: 'nope' },
      { id: 'parent', parentThreadId: 'parent' },
    ])).toEqual(['c1', 'c2']);

    const onStop = vi.fn();
    const onStopThread = vi.fn();
    renderPane({
      running: true,
      onStop,
      onStopThread,
      knownThreadsList: [
        thread({ id: 'c1', title: 'Child', parentThreadId: 'thread-1' }),
        thread({ id: 'other', title: 'Other', parentThreadId: 'elsewhere' }),
        thread({ id: 'side', title: 'Side', parentThreadId: 'thread-1', sideChat: true }),
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStopThread).toHaveBeenCalledTimes(1);
    expect(onStopThread).toHaveBeenCalledWith('c1');
  });

  it('answers the child approval from the parent composer area', () => {
    const onApprovalDecision = vi.fn();
    renderPane({
      onApprovalDecision,
      knownThreadsList: [
        thread({
          id: 'child-1',
          title: 'Reviewer',
          parentThreadId: 'thread-1',
          pendingApproval: approval,
        }),
      ],
    });
    expect(screen.getByLabelText('Reviewer')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(onApprovalDecision).toHaveBeenCalledWith('allowOnce', 'apr-1');
  });

  it('does not send a direct message to an agent-started child', () => {
    expect(directMessageNotice({ startedByAgent: true, parentThreadId: 'parent' })).toBe('Message the parent thread.');
    expect(directMessageNotice({ startedByAgent: true, parentThreadId: null })).toBeNull();
    expect(directMessageNotice({ startedByAgent: false, parentThreadId: 'parent' })).toBeNull();

    const onSend = vi.fn();
    renderPane({
      prompt: 'hello',
      onSend,
      thread: thread({ startedByAgent: true, parentThreadId: 'parent-1', items: [userItem()] }),
    });
    expect(screen.getByText('Message the parent thread.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('still sends on a normal thread', () => {
    const onSend = vi.fn();
    renderPane({
      prompt: 'hello',
      onSend,
      thread: thread({ items: [userItem()] }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('disables bring back while the parent is running', () => {
    expect(bringBackAllowed(false)).toBe(true);
    expect(bringBackAllowed(true)).toBe(false);
    const onBringBack = vi.fn();
    const running = render(createElement(SideChatPane, {
      question: 'side note',
      parentRunning: true,
      onBringBack,
      onClose: () => undefined,
    }));
    const bringBack = screen.getByRole('button', { name: 'Bring back' });
    expect(bringBack).toBeDisabled();
    fireEvent.click(bringBack);
    expect(onBringBack).not.toHaveBeenCalled();
    running.unmount();

    const onChangePrompt = vi.fn();
    renderPane({ running: true, onChangePrompt });
    act(() => {
      window.dispatchEvent(new CustomEvent('kite:side-chat', { detail: { threadId: 'thread-1', question: 'side note' } }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Bring back' }));
    expect(onChangePrompt).not.toHaveBeenCalled();
  });
});
