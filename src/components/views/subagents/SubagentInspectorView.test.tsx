import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SubagentInspectorView } from './SubagentInspectorView';
import { getActiveSubagentInspection } from '../../../lib/subagentNav';

async function readInspectorCss(): Promise<string> {
  const fsSpecifier = ['node', 'fs'].join(':');
  const fs = (await import(/* @vite-ignore */ fsSpecifier)) as {
    readFileSync: (filePath: string, encoding: 'utf8') => string;
  };
  return fs.readFileSync('src/components/views/subagents/inspector.css', 'utf8');
}
import type { ExtendedChatThread } from '../chat/types';
import type { ChatItem } from '../../../types';

const loadChatThreadMock = vi.fn();
const getThreadSubagentDetailMock = vi.fn();
const getThreadSwarmStateMock = vi.fn();
const listAllSubagentRunsMock = vi.fn();
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
  listAllSubagentRuns: (...args: unknown[]) => listAllSubagentRunsMock(...args),
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
    listAllSubagentRunsMock.mockResolvedValue({
      runs: [],
      totalCount: 0,
      activeCount: 0,
      waitingCount: 0,
    });
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

    // TaskBriefCard collapsed -> expanded toggle inside user prompt turn bubble
    const promptTurn = screen.getByTestId('subagent-prompt-turn');
    expect(promptTurn.className).toContain('chat-user-row--bubble');
    const briefToggle = screen.getByRole('button', { name: /Task Brief/i });
    expect(briefToggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(briefToggle);
    expect(briefToggle.getAttribute('aria-expanded')).toBe('true');
    expect(
      screen.getByText(/Inspect all chat normalization modules/i),
    ).toBeInTheDocument();

    // Subagent live steps rendered inside main-thread transcript column
    const transcriptCol = screen.getByTestId('subagent-transcript-column');
    expect(transcriptCol.className).toContain('chat-transcript__column');
    expect(transcriptCol.querySelector('.chat-assistant-row')).not.toBeNull();
    expect(transcriptCol.querySelector('.chat-turn-activity')).not.toBeNull();
    expect(screen.getByText(/Found/i)).toBeInTheDocument();
    expect(screen.getByText('SubagentRun')).toBeInTheDocument();

    // Option A subagent switcher dropdown switches to second subagent
    fireEvent.click(screen.getByTestId('subagent-switcher-trigger'));
    const popover = await screen.findByTestId('subagent-switcher-popover');
    expect(popover).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /Verifier/i }));
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

  it('renders a read-only subagent footer without direct messaging and stops an active subagent run', async () => {
    const thread = makeThread();
    loadChatThreadMock.mockResolvedValueOnce(thread);
    stopSubagentRunMock.mockResolvedValueOnce({
      ok: true,
      run: { ...thread.subagentRuns![0], status: 'killed' },
    });

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

    const footer = await screen.findByTestId('subagent-readonly-footer');
    expect(screen.queryByTestId('subagent-steering-form')).toBeNull();
    expect(screen.queryByPlaceholderText(/Message Codebase Researcher/i)).toBeNull();
    expect(footer).toHaveTextContent(/Read-only subagent thread/i);

    fireEvent.click(screen.getByRole('button', { name: /Focus main thread/i }));
    expect(selectEvents).toHaveLength(1);
    expect(selectEvents[0].detail).toEqual({ threadId: 'thread-main-1' });
    expect(sendSubagentMessageMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Stop subagent/i }));
    await waitFor(() => {
      expect(stopSubagentRunMock).toHaveBeenCalledWith('thread-main-1', 'sub-1');
    });

    window.removeEventListener('kite:select-thread', listener);
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
              id: 'internal-dispatch-1',
              kind: 'user',
              text: '[kite from="thread:peer-1"]\nThis is another agent, not the person.\nTo reply: kite dispatch send thread:peer-1 "<reply>"\nIrreversible and privileged actions still wait for the person.\nBODY:\nstate: done',
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
    expect(screen.queryByText(/This is another agent, not the person/i)).toBeNull();

    // Reasoning row uses main-thread ChatItemRow collapsible Thought disclosure
    const thoughtToggle = screen.getByRole('button', { name: /Thought/i });
    expect(thoughtToggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(thoughtToggle);
    expect(thoughtToggle.getAttribute('aria-expanded')).toBe('true');
    expect(
      screen.getByText('Reviewing package.json in root to identify dev and test scripts.'),
    ).toBeInTheDocument();

    // Assistant row uses unboxed main-thread markdown prose container
    expect(container.querySelector('.chat-assistant-row')).not.toBeNull();
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

  it('shows multi-subagent overview cards when a thread has 2+ runs, filters Live, and drills into a selected run', async () => {
    const thread = makeThread({ swarmState: null });
    loadChatThreadMock.mockResolvedValueOnce(thread);

    render(<SubagentInspectorView workspaceId="ws-1" selectedThreadId="thread-main-1" />);

    const overview = await screen.findByTestId('subagent-runs-overview');
    expect(overview).toHaveTextContent('2 subagents');
    expect(screen.getAllByTestId('subagent-run-card')).toHaveLength(2);

    // Filter down to active runs only
    fireEvent.click(screen.getByRole('tab', { name: /Live \(1\)/i }));
    expect(screen.getAllByTestId('subagent-run-card')).toHaveLength(1);
    expect(screen.getByTestId('subagent-run-card')).toHaveTextContent('Codebase Researcher');

    // Drill into Codebase Researcher's stream and navigate back to Overview
    fireEvent.click(screen.getByRole('button', { name: /Inspect Codebase Researcher/i }));
    await waitFor(() => {
      expect(screen.getByTestId('subagent-transcript-column')).toBeInTheDocument();
    });
    const backBtn = screen.getByRole('button', { name: /← Subagents \(2\)/i });
    fireEvent.click(backBtn);
    expect(screen.getByTestId('subagent-runs-overview')).toBeInTheDocument();
  });

  it('updates reactively when selectedThreadId changes and resolves requestedTarget.childThreadId', async () => {
    const threadA = makeThread({ id: 'thread-a', title: 'Thread Alpha', swarmState: null });
    const threadB = makeThread({
      id: 'thread-b',
      title: 'Thread Beta',
      swarmState: null,
      subagentRuns: [
        {
          subagentId: 'sub-b-1',
          parentThreadId: 'thread-b',
          parentToolCallId: 'call-b-1',
          childThreadId: 'child-b-1',
          role: 'Database Reviewer',
          provider: 'grok',
          model: 'grok-4.7-build-fast',
          workspaceMode: 'inherit',
          status: 'completed',
          prompt: 'Check migrations.',
          stepCount: 1,
          startedAtUnixMs: Date.now() - 10_000,
          updatedAtUnixMs: Date.now() - 1_000,
          items: [
            makeItem({
              id: 'b-step-1',
              kind: 'assistant',
              text: 'All migrations valid.',
            }),
          ],
        },
      ],
    });
    loadChatThreadMock.mockImplementation(async (tid: string) => {
      if (tid === 'thread-a') return threadA;
      if (tid === 'thread-b') return threadB;
      return null;
    });

    const { rerender } = render(
      <SubagentInspectorView workspaceId="ws-1" selectedThreadId="thread-a" />,
    );
    await screen.findByTestId('subagent-runs-overview');

    rerender(<SubagentInspectorView workspaceId="ws-1" selectedThreadId="thread-b" />);
    await waitFor(() => {
      expect(screen.getByText('Database Reviewer')).toBeInTheDocument();
    });
    expect(screen.getByText('All migrations valid.')).toBeInTheDocument();

    // Child row clicks pass childThreadId without subagentId
    rerender(
      <SubagentInspectorView
        workspaceId="ws-1"
        selectedThreadId="thread-a"
        requestedTarget={{
          threadId: 'thread-a',
          childThreadId: 'thread-sub-1',
          mode: 'subagent',
        }}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('subagent-transcript-column')).toBeInTheDocument();
      expect(screen.getByTestId('subagent-switcher-trigger')).toHaveTextContent(
        'Codebase Researcher',
      );
      expect(screen.queryByText('All checks passed.')).not.toBeInTheDocument();
    });
  });

  it('supports combined All Threads view grouped by parent thread with drill-down and empty-thread shortcut', async () => {
    const emptyThread = makeThread({ id: 'thread-empty', subagentRuns: [], swarmState: null });
    const loadedOtherThread = makeThread({ id: 'thread-other', title: 'Other Feature', swarmState: null });
    loadChatThreadMock.mockImplementation(async (tid: string) => {
      if (tid === 'thread-empty') return emptyThread;
      if (tid === 'thread-other') return loadedOtherThread;
      return null;
    });
    listAllSubagentRunsMock.mockResolvedValue({
      totalCount: 2,
      activeCount: 1,
      waitingCount: 0,
      runs: [
        {
          threadId: 'thread-other',
          threadTitle: 'Other Feature',
          workspaceId: 'ws-1',
          parentProvider: 'claude',
          parentModel: 'claude-opus-4-6',
          hasPendingApproval: false,
          run: {
            ...loadedOtherThread.subagentRuns![0],
            parentThreadId: 'thread-other',
            items: [],
          },
        },
        {
          threadId: 'thread-remote',
          threadTitle: 'Remote Repo Audit',
          workspaceId: 'ws-2',
          parentProvider: 'gemini',
          parentModel: 'gemini-3-pro',
          hasPendingApproval: false,
          run: {
            ...loadedOtherThread.subagentRuns![1],
            subagentId: 'sub-remote-1',
            parentThreadId: 'thread-remote',
            items: [],
          },
        },
      ],
    });

    render(<SubagentInspectorView workspaceId="ws-1" selectedThreadId="thread-empty" />);

    const cta = await screen.findByRole('button', { name: /View 1 live across all threads/i });
    fireEvent.click(cta);

    const globalView = await screen.findByTestId('global-subagents-view');
    expect(globalView).toHaveTextContent('Other Feature');
    expect(globalView).toHaveTextContent('Remote Repo Audit');
    expect(screen.getAllByTestId('global-subagent-thread-group')).toHaveLength(2);

    // Project workspace filter narrows to ws-1
    fireEvent.click(screen.getByRole('tab', { name: /This project/i }));
    expect(screen.getAllByTestId('global-subagent-thread-group')).toHaveLength(1);
    fireEvent.click(screen.getByRole('tab', { name: /All projects/i }));

    // Clicking a card in global view drills into its detail stream with Back to All Subagents
    fireEvent.click(screen.getByRole('button', { name: /Inspect Codebase Researcher/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /← All Subagents/i })).toBeInTheDocument();
      expect(screen.getByTestId('subagent-transcript-column')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /← All Subagents/i }));
    expect(screen.getByTestId('global-subagents-view')).toBeInTheDocument();
  });

  it('displays parentModelLabel when subagent model is inherit and refreshes on kite:threads-changed', async () => {
    const initialThread = makeThread({
      id: 'thread-inherit',
      status: 'running',
      subagentRuns: [
        {
          subagentId: 'sub-inh-1',
          parentThreadId: 'thread-inherit',
          parentToolCallId: 'call-inh',
          role: 'Inherited Auditor',
          typeName: 'research',
          provider: 'claude',
          model: 'inherit',
          workspaceMode: 'inherit',
          status: 'running',
          prompt: 'Audit lock order.',
          stepCount: 0,
          startedAtUnixMs: Date.now() - 5_000,
          updatedAtUnixMs: Date.now() - 1_000,
          items: [],
        },
      ],
    });
    const settledThread = makeThread({
      id: 'thread-inherit',
      status: 'idle',
      subagentRuns: [
        {
          ...initialThread.subagentRuns![0],
          status: 'completed',
          stepCount: 1,
          completedAtUnixMs: Date.now(),
          items: [
            makeItem({
              id: 'asst-done',
              kind: 'assistant',
              text: 'Audit finished cleanly.',
              status: 'completed',
            }),
          ],
        },
      ],
    });

    loadChatThreadMock
      .mockResolvedValueOnce(initialThread)
      .mockResolvedValueOnce(settledThread);

    render(<SubagentInspectorView workspaceId="ws-1" selectedThreadId="thread-inherit" />);

    const hierarchy = await screen.findByTestId('subagent-model-hierarchy');
    expect(hierarchy).toHaveTextContent('Main: Opus 4.6 ➔ Subagent: Opus 4.6');
    expect(hierarchy.textContent).not.toMatch(/inherit/i);

    window.dispatchEvent(new Event('kite:threads-changed'));

    await waitFor(() => {
      expect(screen.getByText(/Audit finished cleanly\./i)).toBeInTheDocument();
    });
    expect(loadChatThreadMock).toHaveBeenCalledTimes(2);
  });

  it('renders SubagentRoleIcon and 4-dot orbital spinner without literal Working text in cards and inspector header', async () => {
    const runningThread = makeThread({
      id: 'thread-icons-1',
      status: 'running',
      subagentRuns: [
        {
          subagentId: 'sub-icon-1',
          parentThreadId: 'thread-icons-1',
          parentToolCallId: 'call-icon-1',
          role: 'Codebase Researcher',
          typeName: 'research',
          provider: 'antigravity',
          model: 'gemini-4-argon',
          workspaceMode: 'inherit',
          status: 'running',
          prompt: 'Map icons',
          stepCount: 1,
          startedAtUnixMs: Date.now() - 4_000,
          updatedAtUnixMs: Date.now(),
          items: [],
        },
        {
          subagentId: 'sub-icon-2',
          parentThreadId: 'thread-icons-1',
          parentToolCallId: 'call-icon-2',
          role: 'Security Auditor',
          typeName: 'review',
          provider: 'claude',
          model: 'claude-opus-4-6',
          workspaceMode: 'share',
          status: 'completed',
          prompt: 'Audit rules',
          stepCount: 2,
          startedAtUnixMs: Date.now() - 8_000,
          updatedAtUnixMs: Date.now() - 1_000,
          completedAtUnixMs: Date.now() - 1_000,
          items: [],
        },
      ],
    });
    loadChatThreadMock.mockResolvedValueOnce(runningThread);

    render(<SubagentInspectorView workspaceId="ws-1" selectedThreadId="thread-icons-1" />);

    const overview = await screen.findByTestId('subagent-runs-overview');
    const roleIcons = overview.querySelectorAll('[data-testid="subagent-role-icon"]');
    expect(roleIcons).toHaveLength(2);
    expect(roleIcons[0]).toHaveAttribute('data-role-kind', 'explore');
    expect(roleIcons[1]).toHaveAttribute('data-role-kind', 'review');
    expect(
      overview.querySelector('[data-testid="agent-status-indicator"][data-status="running"]')
    ).toBeInTheDocument();
    expect(overview.textContent).not.toMatch(/Working/i);

    fireEvent.click(screen.getByRole('button', { name: /Inspect Codebase Researcher/i }));
    await waitFor(() => {
      const headerIcons = document.querySelectorAll('.subagent-inspector__header [data-testid="subagent-role-icon"]');
      expect(headerIcons.length).toBeGreaterThanOrEqual(1);
      expect(
        document.querySelector(
          '.subagent-inspector__header [data-testid="agent-status-indicator"][data-status="running"]'
        )
      ).toBeInTheDocument();
      expect(document.querySelector('.subagent-inspector__header')?.textContent).not.toMatch(/Working/i);
    });

    fireEvent.click(screen.getByTestId('subagent-switcher-trigger'));
    const switcherPopover = await screen.findByTestId('subagent-switcher-popover');
    expect(switcherPopover.querySelectorAll('[data-testid="subagent-role-icon"]')).toHaveLength(2);
  });

  it('uses Option A switcher with search for 8 runs, distinguishes generic Subagent labels, and folds 3+ empty failed runs in overview', async () => {
    const manyRunsThread = makeThread({
      id: 'thread-many-1',
      swarmState: null,
      subagentRuns: [
        {
          subagentId: 'run-be',
          parentThreadId: 'thread-many-1',
          parentToolCallId: 'c-be',
          role: 'Backend Engineer',
          provider: 'antigravity',
          model: 'gemini-3.8-flash',
          workspaceMode: 'share',
          status: 'running',
          prompt: 'Refactor backend handlers',
          stepCount: 2,
          startedAtUnixMs: Date.now() - 10_000,
          updatedAtUnixMs: Date.now(),
          items: [
            makeItem({ id: 'be-1', kind: 'assistant', text: 'Working on backend.' }),
          ],
        },
        {
          subagentId: 'run-fe',
          parentThreadId: 'thread-many-1',
          parentToolCallId: 'c-fe',
          role: 'Frontend Engineer',
          provider: 'antigravity',
          model: 'gemini-3.8-flash',
          workspaceMode: 'share',
          status: 'completed',
          prompt: 'Update UI views',
          stepCount: 1,
          startedAtUnixMs: Date.now() - 20_000,
          updatedAtUnixMs: Date.now() - 5_000,
          items: [
            makeItem({ id: 'fe-1', kind: 'assistant', text: 'UI updated.' }),
          ],
        },
        ...[1, 2, 3, 4, 5, 6].map((n) => ({
          subagentId: `run-fail-${n}`,
          parentThreadId: 'thread-many-1',
          parentToolCallId: `c-fail-${n}`,
          role: 'Subagent',
          provider: 'antigravity',
          model: 'gemini-4-hydrogen',
          workspaceMode: 'inherit',
          status: 'failed',
          prompt: `Check module task #${n} in workspace`,
          latestActivity: `Timed out launching worker ${n}`,
          stepCount: 0,
          startedAtUnixMs: Date.now() - 30_000 - n * 1000,
          updatedAtUnixMs: Date.now() - 25_000 - n * 1000,
          items: [],
        })),
      ],
    });
    loadChatThreadMock.mockResolvedValueOnce(manyRunsThread);

    const { container } = render(
      <SubagentInspectorView workspaceId="ws-1" selectedThreadId="thread-many-1" />,
    );

    const overview = await screen.findByTestId('subagent-runs-overview');
    // Only the 2 meaningful runs appear directly; the 6 zero-step failed runs fold into a toggle.
    expect(overview.querySelectorAll('[data-testid="subagent-run-card"]')).toHaveLength(2);
    const failedToggle = screen.getByTestId('subagent-failed-group-toggle');
    expect(failedToggle).toHaveTextContent('6 empty failed attempts');

    fireEvent.click(failedToggle);
    expect(overview.querySelectorAll('[data-testid="subagent-run-card"]')).toHaveLength(8);
    expect(overview).toHaveTextContent('Check module task #1 in workspace');

    // Drill into Backend Engineer: header must never render .subagent-inspector__selector-strip
    fireEvent.click(screen.getByRole('button', { name: /Inspect Backend Engineer/i }));
    await waitFor(() => {
      expect(screen.getByTestId('subagent-switcher-trigger')).toHaveTextContent('Backend Engineer');
      expect(screen.getByTestId('subagent-switcher-trigger')).toHaveTextContent('1/8');
    });
    expect(container.querySelector('.subagent-inspector__selector-strip')).toBeNull();
    expect(container.querySelector('.subagent-inspector__scope-row')).toBeNull();

    // Open Option A popover, filter with search, and switch to Frontend Engineer
    fireEvent.click(screen.getByTestId('subagent-switcher-trigger'));
    const searchInput = await screen.findByLabelText('Filter subagents');
    fireEvent.change(searchInput, { target: { value: 'Frontend' } });
    fireEvent.click(screen.getByRole('option', { name: /Frontend Engineer/i }));
    await waitFor(() => {
      expect(screen.getByText('UI updated.')).toBeInTheDocument();
    });
  });

  it('shows Jump to latest only when scrolled away on an overflowing stream and clears inspection on unmount', async () => {
    const thread = makeThread({ swarmState: null });
    loadChatThreadMock.mockResolvedValueOnce(thread);

    const { container, unmount } = render(
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
      expect(screen.getByTestId('subagent-transcript-column')).toBeInTheDocument();
      expect(getActiveSubagentInspection()).toMatchObject({
        threadId: 'thread-main-1',
        subagentId: 'sub-1',
      });
    });

    const stream = container.querySelector('.subagent-inspector__stream') as HTMLDivElement;
    Object.defineProperty(stream, 'scrollHeight', { value: 600, configurable: true });
    Object.defineProperty(stream, 'clientHeight', { value: 250, configurable: true });
    Object.defineProperty(stream, 'scrollTop', { value: 50, writable: true, configurable: true });
    fireEvent.scroll(stream);

    const jumpBtn = await screen.findByRole('button', { name: /Jump to latest/i });
    fireEvent.click(jumpBtn);
    expect(screen.queryByRole('button', { name: /Jump to latest/i })).toBeNull();
    expect(stream.scrollTop).toBe(600);

    unmount();
    expect(getActiveSubagentInspection()).toBeNull();
  });

  it('renders subagent-switcher popover with an opaque surface background and no backdrop transparency', async () => {
    const inspectorCss = await readInspectorCss();
    const popoverBlock =
      inspectorCss.match(/\.subagent-switcher__popover\s*\{[^}]*\}/)?.[0] ?? '';
    expect(popoverBlock).toContain('var(--menu-plate');
    expect(popoverBlock).not.toContain('var(--glass-overlay-bg');
    expect(popoverBlock).toContain('backdrop-filter: none;');
  });

  it('auto-scrolls when an existing streaming subagent step grows without changing stepCount', async () => {
    const initialThread = makeThread({
      swarmState: null,
      subagentRuns: [
        {
          subagentId: 'sub-stream-1',
          parentThreadId: 'thread-main-1',
          parentToolCallId: 'call-1',
          role: 'Streaming Analyst',
          typeName: 'research',
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          workspaceMode: 'inherit',
          status: 'running',
          prompt: 'Analyze the module',
          startedAtUnixMs: Date.now() - 5000,
          updatedAtUnixMs: Date.now() - 1000,
          stepCount: 1,
          items: [
            makeItem({
              id: 'sub-msg-1',
              kind: 'assistant',
              text: 'Initial chunk.',
              streaming: true,
            }),
          ],
        },
      ],
    });
    loadChatThreadMock.mockResolvedValueOnce(initialThread);

    const { container } = render(
      <SubagentInspectorView
        workspaceId="ws-1"
        selectedThreadId="thread-main-1"
        requestedTarget={{
          threadId: 'thread-main-1',
          subagentId: 'sub-stream-1',
          mode: 'subagent',
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Initial chunk.')).toBeInTheDocument();
    });

    const stream = container.querySelector('.subagent-inspector__stream') as HTMLDivElement;
    let scrollHeight = 500;
    const clientHeight = 250;
    let scrollTop = 250;
    Object.defineProperty(stream, 'scrollHeight', { get: () => scrollHeight, configurable: true });
    Object.defineProperty(stream, 'clientHeight', { get: () => clientHeight, configurable: true });
    Object.defineProperty(stream, 'scrollTop', {
      get: () => scrollTop,
      set: (val: number) => {
        scrollTop = val;
      },
      configurable: true,
    });

    // Simulate the single existing assistant step streaming more lines (stepCount stays 1)
    scrollHeight = 860;
    loadChatThreadMock.mockResolvedValueOnce({
      ...initialThread,
      subagentRuns: [
        {
          ...initialThread.subagentRuns![0],
          updatedAtUnixMs: Date.now(),
          items: [
            makeItem({
              id: 'sub-msg-1',
              kind: 'assistant',
              text: 'Initial chunk.\n\nAppended streaming paragraph with findings.',
              streaming: true,
            }),
          ],
        },
      ],
    });
    window.dispatchEvent(new CustomEvent('kite:threads-changed'));

    await waitFor(() => {
      expect(screen.getByText(/Appended streaming paragraph/)).toBeInTheDocument();
      expect(scrollTop).toBe(860);
    });
  });
});
