import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SubagentInspectorView } from './SubagentInspectorView';
import type { ExtendedChatThread } from '../chat/types';
import type { ChatItem } from '../../../types';

const loadChatThreadMock = vi.fn();
const getThreadSubagentDetailMock = vi.fn();
const getThreadSwarmStateMock = vi.fn();
const sendSubagentMessageMock = vi.fn();
const stopSubagentRunMock = vi.fn();
const respondChatApprovalMock = vi.fn();
const swarmPostFromUiMock = vi.fn();
const swarmSwitchWorkerModelMock = vi.fn();
const swarmKillWorkerFromUiMock = vi.fn();

vi.mock('../../../lib/ipc/chat', () => ({
  loadChatThread: (...args: unknown[]) => loadChatThreadMock(...args),
  getThreadSubagentDetail: (...args: unknown[]) => getThreadSubagentDetailMock(...args),
  getThreadSwarmState: (...args: unknown[]) => getThreadSwarmStateMock(...args),
  sendSubagentMessage: (...args: unknown[]) => sendSubagentMessageMock(...args),
  stopSubagentRun: (...args: unknown[]) => stopSubagentRunMock(...args),
  respondChatApproval: (...args: unknown[]) => respondChatApprovalMock(...args),
  swarmPostFromUi: (...args: unknown[]) => swarmPostFromUiMock(...args),
  swarmSwitchWorkerModel: (...args: unknown[]) => swarmSwitchWorkerModelMock(...args),
  swarmKillWorkerFromUi: (...args: unknown[]) => swarmKillWorkerFromUiMock(...args),
}));

function makeItem(overrides: Partial<ChatItem> & { id: string; kind: ChatItem['kind'] }): ChatItem {
  return {
    text: '',
    title: null,
    detail: null,
    status: null,
    streaming: false,
    exitCode: null,
    createdAtUnixMs: 1_700_000_001_000,
    attachments: [],
    ...overrides,
  };
}

function makeThread(overrides: Partial<ExtendedChatThread> = {}): ExtendedChatThread {
  return {
    schemaVersion: 1,
    revision: 'rev-1',
    id: 'thread-main-1',
    profileId: null,
    title: 'Implement Orchestrator',
    workspaceId: 'ws-1',
    provider: 'claude',
    model: 'claude-opus-4-6',
    mode: 'acceptEdits',
    plan: false,
    status: 'running',
    pinned: false,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    createdAtUnixMs: 1_700_000_000_000,
    updatedAtUnixMs: 1_700_000_010_000,
    items: [],
    subagentRuns: [
      {
        subagentId: 'sub-1',
        parentThreadId: 'thread-main-1',
        parentToolCallId: 'call-1',
        childThreadId: 'thread-sub-1',
        role: 'Codebase Researcher',
        typeName: 'research',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        workspaceMode: 'inherit',
        status: 'running',
        prompt:
          'Inspect all chat normalization modules, inspect event routing, and summarize how subagents persist metadata.',
        latestActivity: 'Reading subagents.rs',
        stepCount: 3,
        startedAtUnixMs: Date.now() - 18_000,
        updatedAtUnixMs: Date.now() - 1_000,
        items: [
          makeItem({
            id: 'step-1',
            kind: 'tool',
            title: 'Read subagents.rs',
            detail: 'src-tauri/src/chat/subagents.rs',
            toolKind: 'read',
            filePath: 'src-tauri/src/chat/subagents.rs',
            status: 'completed',
          }),
          makeItem({
            id: 'step-2',
            kind: 'command',
            title: 'cargo test chat::',
            text: '205 passed',
            toolKind: 'commandExecution',
            status: 'running',
          }),
          makeItem({
            id: 'step-3',
            kind: 'assistant',
            text: 'Found **SubagentRun** normalization.',
          }),
        ],
      },
      {
        subagentId: 'sub-2',
        parentThreadId: 'thread-main-1',
        parentToolCallId: 'call-2',
        role: 'Verifier',
        typeName: 'worker',
        provider: 'codex',
        model: 'gpt-4o-mini',
        workspaceMode: 'share',
        status: 'completed',
        prompt: 'Verify Vite bundle builds cleanly.',
        stepCount: 1,
        startedAtUnixMs: Date.now() - 30_000,
        updatedAtUnixMs: Date.now() - 15_000,
        items: [
          makeItem({
            id: 'step-v1',
            kind: 'assistant',
            text: 'All checks passed.',
          }),
        ],
      },
    ],
    swarmState: {
      swarmId: 'swarm-1',
      title: 'Auth Swarm',
      members: [
        {
          name: 'parser',
          role: 'Parser Worker',
          model: 'gemini-2.5-flash',
          provider: 'gemini',
          workspaceMode: 'share',
          state: 'working',
          currentActivity: 'Parsing OAuth callback',
          subagentId: 'sub-1',
          channels: ['main', 'backend'],
        },
      ],
      posts: [
        {
          seq: 1,
          author: 'coordinator',
          channel: 'main',
          text: '@parser verify tokens',
          mentions: ['parser'],
          createdAtUnixMs: 1_700_000_005_000,
        },
      ],
      channels: [{ name: 'main' }, { name: 'backend' }],
    },
    ...overrides,
  };
}

describe('SubagentInspectorView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getThreadSubagentDetailMock.mockResolvedValue(null);
    getThreadSwarmStateMock.mockResolvedValue(null);
  });

  it('renders empty state when thread has no subagents or swarms', async () => {
    loadChatThreadMock.mockResolvedValueOnce(
      makeThread({ subagentRuns: [], swarmState: null }),
    );

    render(<SubagentInspectorView workspaceId="ws-1" selectedThreadId="thread-main-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('subagent-inspector-empty')).toBeInTheDocument();
    });
  });

  it('renders model hierarchy Main -> Subagent, collapsible TaskBriefCard, live steps, and parent link', async () => {
    const thread = makeThread();
    loadChatThreadMock.mockResolvedValueOnce(thread);

    const selectEvents: CustomEvent[] = [];
    const listener = (e: Event) => selectEvents.push(e as CustomEvent);
    window.addEventListener('kite:select-thread', listener);

    render(
      <SubagentInspectorView
        workspaceId="ws-1"
        selectedThreadId="thread-main-1"
        requestedTarget={{
          threadId: 'thread-main-1',
          subagentId: 'sub-1',
          mode: 'subagent',
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('subagent-model-hierarchy')).toBeInTheDocument();
    });

    const hierarchy = screen.getByTestId('subagent-model-hierarchy');
    expect(hierarchy.textContent).toMatch(/Main:\s*Opus 4\.6/);
    expect(hierarchy.textContent).toMatch(/Subagent:\s*Gemini 2\.5 Flash/);
    expect(screen.getByText('inherit')).toBeInTheDocument();

    // TaskBriefCard collapsed -> expanded toggle
    const briefToggle = screen.getByRole('button', { name: /Task Brief/i });
    expect(briefToggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(briefToggle);
    expect(briefToggle.getAttribute('aria-expanded')).toBe('true');
    expect(
      screen.getByText(/Inspect all chat normalization modules/i),
    ).toBeInTheDocument();

    // Subagent live steps rendered (work rows + markdown assistant block)
    expect(screen.getByText(/Found/i)).toBeInTheDocument();
    expect(screen.getByText('SubagentRun')).toBeInTheDocument();

    // Subagent switcher switches to second subagent
    fireEvent.click(screen.getByRole('button', { name: /Verifier/i }));
    await waitFor(() => {
      expect(screen.getByText('All checks passed.')).toBeInTheDocument();
    });

    // Parent breadcrumb link dispatches kite:select-thread
    fireEvent.click(screen.getByRole('button', { name: /Main Thread: Implement Orchestrator/i }));
    expect(selectEvents).toHaveLength(1);
    expect(selectEvents[0].detail).toEqual({ threadId: 'thread-main-1' });

    window.removeEventListener('kite:select-thread', listener);
  });

  it('switches to Swarm Board mode when swarm target is requested and drills down with Back to Swarm Roster', async () => {
    const thread = makeThread();
    loadChatThreadMock.mockResolvedValueOnce(thread);

    render(
      <SubagentInspectorView
        workspaceId="ws-1"
        selectedThreadId="thread-main-1"
        requestedTarget={{
          threadId: 'thread-main-1',
          swarmId: 'swarm-1',
          mode: 'swarm',
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('swarm-board-inspector')).toBeInTheDocument();
    });

    // Open Roster tab inside SwarmBoardInspector and drill down into @parser
    fireEvent.click(screen.getByRole('tab', { name: /Roster/i }));
    fireEvent.click(screen.getByRole('button', { name: /Inspect @parser/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Back to Swarm Roster/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Back to Swarm Roster/i }));
    expect(screen.getByTestId('swarm-board-inspector')).toBeInTheDocument();
  });

  it('sends follow-up steering messages and stops an active subagent run', async () => {
    const thread = makeThread();
    loadChatThreadMock.mockResolvedValueOnce(thread);
    sendSubagentMessageMock.mockResolvedValueOnce({
      ok: true,
      run: { ...thread.subagentRuns![0], status: 'running' },
    });
    stopSubagentRunMock.mockResolvedValueOnce({
      ok: true,
      run: { ...thread.subagentRuns![0], status: 'killed' },
    });

    render(
      <SubagentInspectorView
        workspaceId="ws-1"
        selectedThreadId="thread-main-1"
        requestedTarget={{
          threadId: 'thread-main-1',
          subagentId: 'sub-1',
          mode: 'subagent',
        }}
      />,
    );

    const input = await screen.findByPlaceholderText(/Message Codebase Researcher/i);
    fireEvent.change(input, { target: { value: 'Check edge case #2' } });
    fireEvent.submit(screen.getByTestId('subagent-steering-form'));

    await waitFor(() => {
      expect(sendSubagentMessageMock).toHaveBeenCalledWith(
        'thread-main-1',
        'sub-1',
        'Check edge case #2',
      );
    });

    fireEvent.click(screen.getByRole('button', { name: /Stop subagent/i }));
    await waitFor(() => {
      expect(stopSubagentRunMock).toHaveBeenCalledWith('thread-main-1', 'sub-1');
    });
  });

  it('shows inline failure diagnostics instead of waiting placeholder when a subagent run fails with zero steps', async () => {
    const failedThread = makeThread({
      subagentRuns: [
        {
          subagentId: 'sub-fail-1',
          parentThreadId: 'thread-main-1',
          parentToolCallId: 'call-fail-1',
          role: 'Grok subagent',
          provider: 'grok',
          model: 'grok-4',
          workspaceMode: 'inherit',
          status: 'failed',
          prompt: 'Audit auth layer',
          latestActivity: 'No model connected for provider grok',
          stepCount: 0,
          startedAtUnixMs: Date.now() - 2_000,
          updatedAtUnixMs: Date.now() - 1_000,
          items: [],
        },
      ],
      swarmState: null,
    });
    loadChatThreadMock.mockResolvedValueOnce(failedThread);

    render(
      <SubagentInspectorView
        workspaceId="ws-1"
        selectedThreadId="thread-main-1"
        requestedTarget={{
          threadId: 'thread-main-1',
          subagentId: 'sub-fail-1',
          mode: 'subagent',
        }}
      />,
    );

    const card = await screen.findByTestId('subagent-failure-card');
    expect(card.textContent).toContain('Subagent execution failed');
    expect(card.textContent).toContain('No model connected for provider grok');
    expect(screen.getByText('No steps captured before failure')).toBeInTheDocument();
    expect(screen.queryByText(/Waiting for subagent steps/i)).toBeNull();
  });

  it('deduplicates shell-wrapper and child-thread runs, hides single-run selector pills, and filters notice frames out of the step stream', async () => {
    const traceThread = makeThread({
      subagentRuns: [
        {
          subagentId: 't_shell_wrapper',
          parentThreadId: 'thread-main-1',
          parentToolCallId: 't_shell_wrapper',
          role: 'Package.json Reviewer',
          typeName: 'grok',
          provider: 'grok',
          model: 'grok-4.7-build-fast',
          workspaceMode: 'inherit',
          status: 'completed',
          prompt: 'Summarize package.json scripts in 3 bullets.',
          stepCount: 0,
          startedAtUnixMs: Date.now() - 30_000,
          updatedAtUnixMs: Date.now() - 2_000,
          items: [],
        },
        {
          subagentId: 'b52770b2',
          parentThreadId: 'thread-main-1',
          parentToolCallId: 't_shell_wrapper',
          childThreadId: 'b52770b2',
          role: 'Package.json Reviewer',
          typeName: 'grok',
          provider: 'grok',
          model: 'grok-4.7-build-fast',
          workspaceMode: 'inherit',
          status: 'completed',
          prompt: 'Summarize package.json scripts in 3 bullets.',
          stepCount: 2,
          startedAtUnixMs: Date.now() - 28_000,
          updatedAtUnixMs: Date.now() - 1_000,
          items: [
            makeItem({
              id: 'u-initial',
              kind: 'user',
              text: '[Subagent Role: Package.json Reviewer]\nSummarize package.json scripts in 3 bullets.',
            }),
            makeItem({
              id: 'notice-1',
              kind: 'notice' as ChatItem['kind'],
              text: 'grok sent an unknown frame (schema=jsonrpc,method,params)',
            }),
            makeItem({
              id: 'notice-2',
              kind: 'notice' as ChatItem['kind'],
              text: 'grok sent an unknown frame (schema=jsonrpc,method,params)',
            }),
            makeItem({
              id: 'r-1',
              kind: 'reasoning',
              text: 'Reviewing package.json in root to identify dev and test scripts.',
            }),
            makeItem({
              id: 'a-1',
              kind: 'assistant',
              text: '- **Dev**: `dev` starts Vite.\n- **Test**: `test` runs Vitest.',
            }),
          ],
        },
      ],
      swarmState: null,
    });
    loadChatThreadMock.mockResolvedValueOnce(traceThread);

    const { container } = render(
      <SubagentInspectorView workspaceId="ws-1" selectedThreadId="thread-main-1" />,
    );

    await waitFor(() => {
      expect(screen.getByText('Package.json Reviewer')).toBeInTheDocument();
    });

    expect(container.querySelector('.subagent-inspector__selector-strip')).toBeNull();
    expect(screen.queryByText('Tool')).toBeNull();
    expect(screen.queryByText(/grok sent an unknown frame/i)).toBeNull();
    expect(
      screen.getByText('Reviewing package.json in root to identify dev and test scripts.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/starts Vite/i)).toBeInTheDocument();
  });

  it('groups consecutive settled work steps, keeps empty Task Brief expanded until steps arrive, and hydrates past step 1', async () => {
    const stepOneRun = {
      subagentId: 'sub-stream-1',
      parentThreadId: 'thread-main-1',
      parentToolCallId: 'call-stream-1',
      childThreadId: 'child-stream-1',
      role: 'Deep Auditor',
      provider: 'gemini',
      model: 'gemini-3-flash',
      workspaceMode: 'inherit',
      status: 'running',
      prompt: 'Audit auth middleware and summarize findings.',
      stepCount: 2,
      startedAtUnixMs: Date.now() - 10_000,
      updatedAtUnixMs: Date.now() - 2_000,
      items: [
        makeItem({
          id: 's1',
          kind: 'tool',
          title: 'Read auth.ts',
          toolKind: 'read',
          filePath: 'src/auth.ts',
          status: 'completed',
        }),
      ],
    };
    const caughtUpRun = {
      ...stepOneRun,
      status: 'completed',
      stepCount: 2,
      items: [
        ...stepOneRun.items,
        makeItem({
          id: 's2',
          kind: 'command',
          title: 'vitest run auth.test.ts',
          toolKind: 'commandExecution',
          status: 'completed',
          exitCode: 0,
        }),
      ],
    };

    loadChatThreadMock.mockResolvedValueOnce(
      makeThread({ subagentRuns: [stepOneRun], swarmState: null }),
    );
    getThreadSubagentDetailMock.mockResolvedValueOnce(caughtUpRun);

    const selectEvents: CustomEvent[] = [];
    const listener = (e: Event) => selectEvents.push(e as CustomEvent);
    window.addEventListener('kite:select-thread', listener);

    const { container } = render(
      <SubagentInspectorView workspaceId="ws-1" selectedThreadId="thread-main-1" />,
    );

    await waitFor(() => {
      expect(getThreadSubagentDetailMock).toHaveBeenCalledWith('thread-main-1', 'sub-stream-1');
    });

    await waitFor(() => {
      expect(container.querySelector('.chat-work-group__toggle')).not.toBeNull();
    });

    const popOutBtn = screen.getByRole('button', { name: /Open subagent thread in main pane/i });
    fireEvent.click(popOutBtn);
    expect(selectEvents).toHaveLength(1);
    expect(selectEvents[0].detail).toEqual({ threadId: 'child-stream-1' });

    window.removeEventListener('kite:select-thread', listener);
  });

  it('renders inline child pendingApproval via ChatApprovalCard when child run is waiting and dispatches respondChatApproval', async () => {
    const waitingParent = makeThread({
      subagentRuns: [
        {
          subagentId: 'sub-wait-1',
          parentThreadId: 'thread-main-1',
          parentToolCallId: 'call-wait-1',
          childThreadId: 'child-wait-1',
          role: 'Migration Runner',
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          workspaceMode: 'inherit',
          status: 'waiting',
          prompt: 'Apply schema check',
          stepCount: 0,
          items: [],
          startedAtUnixMs: Date.now() - 4_000,
          updatedAtUnixMs: Date.now() - 500,
        },
      ],
      swarmState: null,
    });
    const waitingChild = makeThread({
      id: 'child-wait-1',
      parentThreadId: 'thread-main-1',
      pendingApproval: {
        id: 'apr-child-1',
        toolName: 'bash',
        title: 'Run cargo check',
        detail: 'cargo check --workspace',
        risk: 'command',
        impact: 'Runs compiler check',
      },
      subagentRuns: [],
      swarmState: null,
    });

    loadChatThreadMock
      .mockResolvedValueOnce(waitingParent)
      .mockResolvedValueOnce(waitingChild);
    respondChatApprovalMock.mockResolvedValueOnce(waitingChild);

    render(<SubagentInspectorView workspaceId="ws-1" selectedThreadId="thread-main-1" />);

    const briefToggle = await screen.findByRole('button', { name: /Task Brief/i });
    expect(briefToggle.getAttribute('aria-expanded')).toBe('true');

    const approvalWrap = await screen.findByTestId('subagent-child-approval');
    expect(approvalWrap).toHaveTextContent('Run cargo check');

    const allowBtn = screen.getByRole('button', { name: /^Allow$/i });
    fireEvent.click(allowBtn);
    await waitFor(() => {
      expect(respondChatApprovalMock).toHaveBeenCalledWith('child-wait-1', 'allowOnce', 'apr-child-1');
    });
  });
});
