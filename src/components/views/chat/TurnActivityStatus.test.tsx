import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TurnActivityStatus } from './TurnActivityStatus';
import { SingleThreadPane } from './SingleThreadPane';
import { AgentChatSurface } from '../agents/AgentChatShell';
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

function thread(partial: Partial<ExtendedChatThread> = {}): ExtendedChatThread {
  return {
    schemaVersion: 1,
    revision: '1',
    id: 'thread-1',
    profileId: null,
    provider: 'grok',
    title: 'Thread',
    items: [],
    mode: 'acceptEdits',
    plan: false,
    model: null,
    status: 'running',
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    workspaceId: null,
    pinned: false,
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
    ...partial,
  };
}

describe('TurnActivityStatus', () => {
  it('shows Working… and Thinking until an action exists, with no bouncing dots', () => {
    const { container, rerender } = render(<TurnActivityStatus running items={[]} />);
    expect(screen.getByText('Working…')).toBeInTheDocument();
    expect(screen.getByText('Thinking')).toBeInTheDocument();
    expect(container.querySelector('.chat-working-row__dots')).toBeNull();

    const tool: ChatItem = {
      id: 'tool-1',
      kind: 'tool',
      text: '',
      title: 'Read src/main.ts',
      detail: 'src/main.ts',
      status: 'running',
      streaming: true,
      exitCode: null,
      createdAtUnixMs: 1,
      attachments: [],
    };
    rerender(<TurnActivityStatus running items={[tool]} />);
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument();
    expect(screen.getByText('Working…')).toBeInTheDocument();
  });

  it('keeps approval waiting distinct from Thinking and Working', () => {
    render(
      <TurnActivityStatus
        running={false}
        pendingApproval={{ title: 'Bash', toolName: 'bash' }}
        items={[]}
      />,
    );
    expect(screen.getByText('Waiting for approval · Bash')).toBeInTheDocument();
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument();
    expect(screen.queryByText(/Working/)).not.toBeInTheDocument();
  });

  it('reads You stopped after when the turn was interrupted', () => {
    render(
      <TurnActivityStatus running={false} interrupted durationSeconds={8} items={[]} />,
    );
    expect(screen.getByText('You stopped after 8.0s')).toBeInTheDocument();
  });
});

describe('both transcript surfaces', () => {
  const runningThread = thread({
    items: [
      {
        id: 'user-1',
        kind: 'user',
        text: 'Ship the timer',
        title: null,
        detail: null,
        status: null,
        streaming: false,
        exitCode: null,
        createdAtUnixMs: Date.now() - 2000,
        attachments: [],
      },
    ],
  });

  it('shows the working line in the thread pane', () => {
    render(
      <SingleThreadPane
        thread={runningThread}
        workspaceId={null}
        isFocused
        isMulti={false}
        running
        prompt=""
        attachments={[]}
        liveRunsCount={0}
        dynamicModels={[]}
        editingTitleId={null}
        titleInput=""
        onFocus={() => undefined}
        onClosePane={() => undefined}
        onNewThread={() => undefined}
        onStartRename={() => undefined}
        onSaveRename={() => undefined}
        onChangeTitleInput={() => undefined}
        onCancelRename={() => undefined}
        onChangePrompt={() => undefined}
        onSend={() => undefined}
        onStop={() => undefined}
        onPickAttachments={() => undefined}
        onStageFiles={() => undefined}
        onStagePaths={() => undefined}
        onRemoveAttachment={() => undefined}
        onUpdateConfig={() => undefined}
        onApprovalDecision={() => undefined}
      />,
    );
    expect(document.querySelector('.chat-turn-activity__working')?.textContent ?? '').toMatch(/Working ·/);
    expect(screen.getByText('Thinking')).toBeInTheDocument();
    expect(screen.queryByText('Thinking…')).not.toBeInTheDocument();
  });

  it('shows the working line in the agent shell', () => {
    render(
      <AgentChatSurface
        agentId="agent-1"
        agentName="Builder"
        engineLabel="Grok"
        activeThread={runningThread}
        tabs={[]}
        selectedId={runningThread.id}
        isDraft={false}
        running
        prompt=""
        attachments={[]}
        totalTokens={0}
        dynamicModels={[]}
        onNew={() => undefined}
        onSelect={() => undefined}
        onRename={() => undefined}
        onArchive={() => undefined}
        onChangePrompt={() => undefined}
        onSend={() => undefined}
        onStop={() => undefined}
        onPickAttachments={() => undefined}
        onStageFiles={() => undefined}
        onStagePaths={() => undefined}
        onRemoveAttachment={() => undefined}
        onUpdateConfig={() => undefined}
      />,
    );
    expect(document.querySelector('.chat-turn-activity__working')?.textContent ?? '').toMatch(/Working ·/);
    expect(screen.getByText('Thinking')).toBeInTheDocument();
    expect(screen.queryByText('Thinking…')).not.toBeInTheDocument();
  });
});
