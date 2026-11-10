import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SingleThreadPane } from './SingleThreadPane';
import { ThreadUsageCard } from './ThreadUsageCard';
import { usageDetails } from './usageDetails';
import type { ExtendedChatThread } from './types';
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

function userItem(): ChatItem {
  return {
    id: 'user-1',
    kind: 'user',
    text: 'Count these words only if the provider reported usage',
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
    title: 'Thread',
    items: [userItem()],
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

function pane(threadValue: ExtendedChatThread) {
  return createElement(SingleThreadPane, {
    thread: threadValue,
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
  });
}

describe('usage details', () => {
  it('shows reported input, output, and context tokens', () => {
    expect(usageDetails({
      reported: true,
      inputTokens: 12,
      outputTokens: 3,
      contextWindowTokens: 100,
    }, 'ignore this transcript')).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      contextWindowTokens: 100,
    });
    render(createElement(ThreadUsageCard, {
      reported: true,
      inputTokens: 12,
      outputTokens: 3,
      contextWindowTokens: 100,
      transcriptText: 'hello '.repeat(40),
    }));
    const card = screen.getByLabelText('Thread usage');
    expect(card).toHaveTextContent('Input 12');
    expect(card).toHaveTextContent('Output 3');
    expect(card).toHaveTextContent('Context 100');
  });

  it('does not invent a token count when the record is missing', () => {
    const transcript = 'token '.repeat(80);
    expect(usageDetails(null, transcript)).toBeNull();
    expect(usageDetails(undefined, transcript)).toBeNull();
    expect(usageDetails({ inputTokens: 9, outputTokens: 9, contextWindowTokens: 9 }, transcript)).toBeNull();
    expect(usageDetails({
      reported: false,
      inputTokens: 0,
      outputTokens: 0,
      contextWindowTokens: 0,
    }, transcript)).toBeNull();
    const { container } = render(createElement(ThreadUsageCard, { transcriptText: transcript }));
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByLabelText('Thread usage')).not.toBeInTheDocument();
  });

  it('mounts a reported card in the thread header and leaves it out of the transcript', () => {
    const view = render(pane(thread({
      usageReported: true,
      contextWindowTokens: 100,
      usage: { inputTokens: 12, outputTokens: 3, costUsd: 0 },
    })));
    const card = screen.getByLabelText('Thread usage');
    expect(card).toHaveTextContent('Input 12');
    expect(card.closest('.chat-transcript')).toBeNull();
    expect(card.closest('.chat-thread-header')).not.toBeNull();

    view.rerender(pane(thread({
      usageReported: false,
      usage: { inputTokens: 40, outputTokens: 2, costUsd: 0 },
    })));
    expect(screen.queryByLabelText('Thread usage')).not.toBeInTheDocument();
  });
});
