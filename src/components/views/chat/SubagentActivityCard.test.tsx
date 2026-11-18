import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ChatItem } from '../../../types';
import { plainPreviewLine, SubagentActivityCard, SubagentGroupRow } from './SubagentActivityCard';
import { SwarmActivityCard } from './SwarmActivityCard';
import {
  OPEN_RIGHT_DOCK_SUBAGENT_EVENT,
  setActiveSubagentInspection,
  type OpenRightDockSubagentDetail,
} from '../../../lib/subagentNav';

describe('SubagentActivityCard and SwarmActivityCard', () => {
  it('renders a live subagent card with role, model, workspace, orbital spinner, shine preview, and dispatches dock event on click', () => {
    const dispatched: OpenRightDockSubagentDetail[] = [];
    const listener = (ev: Event) => {
      dispatched.push((ev as CustomEvent<OpenRightDockSubagentDetail>).detail);
    };
    window.addEventListener(OPEN_RIGHT_DOCK_SUBAGENT_EVENT, listener);

    const item: ChatItem = {
      id: 'call_sub_1',
      kind: 'tool',
      text: '',
      title: 'Codebase Explorer',
      detail: 'Reading src-tauri/src/chat/threads.rs',
      status: 'running',
      streaming: true,
      exitCode: null,
      createdAtUnixMs: Date.now() - 5000,
      attachments: [],
      toolKind: 'subagent',
      subagentMeta: {
        subagentId: 'sub_abc',
        action: 'spawn',
        role: 'Codebase Explorer',
        provider: 'grok',
        model: 'grok-3-mini',
        workspaceMode: 'branch',
        prompt: 'Inspect subagent normalization across all providers',
        status: 'running',
        childThreadId: 'thread_child_1',
        latestActivity: 'Reading src-tauri/src/chat/threads.rs',
        stepCount: 3,
      },
    };

    const { container } = render(
      <SubagentActivityCard item={item} threadId="thread-parent" workspaceId="ws-1" />,
    );

    const card = container.querySelector('[data-subagent-id="sub_abc"]');
    expect(card).not.toBeNull();
    expect(screen.getByText('Codebase Explorer')).toBeInTheDocument();
    expect(screen.getByText(/grok-3-mini/i)).toBeInTheDocument();
    expect(screen.getByText(/branch/i)).toBeInTheDocument();
    expect(container.querySelector('[data-testid="subagent-role-icon"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="agent-orbit-spinner"]')).not.toBeNull();
    expect(container.querySelector('.live-tool-shine')?.textContent).toContain(
      'Reading src-tauri/src/chat/threads.rs',
    );

    fireEvent.click(card!);
    expect(dispatched).toEqual([
      {
        threadId: 'thread-parent',
        subagentId: 'sub_abc',
        childThreadId: 'thread_child_1',
        mode: 'subagent',
        workspaceId: 'ws-1',
      },
    ]);

    window.removeEventListener(OPEN_RIGHT_DOCK_SUBAGENT_EVENT, listener);
  });

  it('renders a SwarmActivityCard with swarm title, worker states, latest post preview, and opens the swarm dock on click', () => {
    const dispatched: OpenRightDockSubagentDetail[] = [];
    const listener = (ev: Event) => {
      dispatched.push((ev as CustomEvent<OpenRightDockSubagentDetail>).detail);
    };
    window.addEventListener(OPEN_RIGHT_DOCK_SUBAGENT_EVENT, listener);

    const item: ChatItem = {
      id: 'call_swarm_1',
      kind: 'tool',
      text: '',
      title: 'Swarm post #2',
      detail: '',
      status: 'completed',
      streaming: false,
      exitCode: null,
      createdAtUnixMs: Date.now() - 2000,
      attachments: [],
      toolKind: 'swarm',
      swarmMeta: {
        swarmId: 'swarm_xyz',
        action: 'post_message',
        swarmTitle: 'Parser & Tests Swarm',
        channel: 'main',
        memberName: 'coordinator',
        postText: '@parser parse AC frames cleanly',
        seq: 2,
        mentions: ['@parser'],
      },
    };

    const { container } = render(
      <SwarmActivityCard
        item={item}
        threadId="thread-parent"
        workspaceId="ws-1"
        swarmState={{
          swarmId: 'swarm_xyz',
          title: 'Parser & Tests Swarm',
          coordinatorModel: 'claude-opus-4-6',
          members: [
            { name: 'parser', role: 'Parser', model: 'gemini-2.5-flash', state: 'working', channels: ['main'] },
            { name: 'verifier', role: 'Verifier', model: 'grok-3-mini', state: 'waiting', channels: ['main'] },
          ],
          posts: [
            { seq: 2, author: 'coordinator', channel: 'main', text: '@parser parse AC frames cleanly', mentions: ['@parser'], createdAtUnixMs: 10 },
          ],
          channels: [{ name: 'main' }],
        }}
      />,
    );

    const card = container.querySelector('[data-swarm-id="swarm_xyz"]');
    expect(card).not.toBeNull();
    expect(screen.getByText('Parser & Tests Swarm')).toBeInTheDocument();
    expect(screen.getByText('@parser')).toBeInTheDocument();
    expect(screen.getByText(/#2/)).toBeInTheDocument();

    fireEvent.click(card!);
    expect(dispatched).toEqual([
      {
        threadId: 'thread-parent',
        swarmId: 'swarm_xyz',
        mode: 'swarm',
        workspaceId: 'ws-1',
      },
    ]);

    window.removeEventListener(OPEN_RIGHT_DOCK_SUBAGENT_EVENT, listener);
  });

  it('renders unbacked failed CLI subagents statically without a dead chevron and syncs active highlight on backed cards', () => {
    setActiveSubagentInspection(null);
    const failedUnbacked: ChatItem = {
      id: 'call_sub_fail',
      kind: 'tool',
      text: '{"exit":2,"status":"rejected","error":"Provider grok is not signed in"}',
      title: 'Grok subagent',
      detail: '',
      status: 'failed',
      streaming: false,
      exitCode: 2,
      createdAtUnixMs: Date.now() - 2000,
      attachments: [],
      toolKind: 'subagent',
      subagentMeta: {
        subagentId: 'call_sub_fail',
        action: 'spawn',
        role: 'Grok subagent',
        provider: 'grok',
        prompt: 'Audit auth',
        status: 'failed',
        stepCount: 0,
      },
    };

    const { container } = render(
      <SubagentActivityCard item={failedUnbacked} threadId="thread-parent" workspaceId="ws-1" />,
    );
    const card = container.querySelector('[data-subagent-id="call_sub_fail"]');
    expect(card).not.toBeNull();
    expect(card?.tagName).toBe('DIV');
    expect(card?.className).toContain('chat-subagent-card--failed');
    expect(card?.className).toContain('chat-subagent-card--static');
    expect(container.querySelector('.chat-subagent-card__chevron')).toBeNull();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Provider grok is not signed in')).toBeInTheDocument();

    const backed: ChatItem = {
      id: 'call_sub_backed',
      kind: 'tool',
      text: '',
      title: 'Researcher',
      detail: '',
      status: 'completed',
      streaming: false,
      exitCode: 0,
      createdAtUnixMs: Date.now() - 1000,
      attachments: [],
      toolKind: 'subagent',
      subagentMeta: {
        subagentId: 'sub_backed_1',
        action: 'spawn',
        role: 'Researcher',
        childThreadId: 'thread_child_2',
        status: 'completed',
        stepCount: 0,
      },
    };
    const { container: backedContainer } = render(
      <SubagentActivityCard item={backed} threadId="thread-parent" workspaceId="ws-1" />,
    );
    fireEvent.click(backedContainer.querySelector('[data-subagent-id="sub_backed_1"]')!);
    expect(
      backedContainer.querySelector('[data-subagent-id="sub_backed_1"]')?.className,
    ).toContain('chat-subagent-card--active');
    setActiveSubagentInspection(null);
  });

  it('groups parallel settled subagents under a collapsible disclosure row', () => {
    const items: ChatItem[] = [
      {
        id: 's1',
        kind: 'tool',
        text: '',
        title: 'Schema Explorer',
        detail: '',
        status: 'completed',
        streaming: false,
        exitCode: 0,
        createdAtUnixMs: 10,
        attachments: [],
        toolKind: 'subagent',
        subagentMeta: { subagentId: 'sub-1', action: 'spawn', role: 'Schema Explorer', childThreadId: 'c1', status: 'completed', stepCount: 0 },
      },
      {
        id: 's2',
        kind: 'tool',
        text: '',
        title: 'Test Runner',
        detail: '',
        status: 'completed',
        streaming: false,
        exitCode: 0,
        createdAtUnixMs: 20,
        attachments: [],
        toolKind: 'subagent',
        subagentMeta: { subagentId: 'sub-2', action: 'spawn', role: 'Test Runner', childThreadId: 'c2', status: 'completed', stepCount: 0 },
      },
    ];
    render(<SubagentGroupRow items={items} threadId="thread-parent" workspaceId="ws-1" />);
    const toggle = screen.getByRole('button', { name: /Started 2 subagents/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Schema Explorer')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Schema Explorer')).toBeInTheDocument();
    expect(screen.getByText('Test Runner')).toBeInTheDocument();
  });

  it('does not mark SwarmActivityCard failed when exitCode is undefined and stays static without board data', () => {
    const swarmItem: ChatItem = {
      id: 'sw_unbacked',
      kind: 'tool',
      text: '',
      title: 'Swarm Coordination',
      detail: '',
      status: 'completed',
      streaming: false,
      exitCode: undefined as unknown as number | null,
      createdAtUnixMs: Date.now() - 1000,
      attachments: [],
      toolKind: 'swarm',
      swarmMeta: {
        swarmId: 'sw-empty',
        action: 'title',
      },
    };
    const { container } = render(
      <SwarmActivityCard item={swarmItem} threadId="thread-parent" swarmState={null} />,
    );
    const card = container.querySelector('[data-swarm-id="sw-empty"]');
    expect(card).not.toBeNull();
    expect(card?.tagName).toBe('DIV');
    expect(card?.className).toContain('chat-subagent-card--completed');
    expect(card?.className).not.toContain('chat-subagent-card--failed');
    expect(card?.className).toContain('chat-subagent-card--static');
  });

  it('deduplicates shell-wrapper and child-thread subagent items into a single inspectable card without raw CLI strings', () => {
    const items: ChatItem[] = [
      {
        id: 't_shell_wrapper',
        kind: 'tool',
        text: '',
        title: 'Package.json Reviewer',
        detail: '$ kite dispatch run --via thread --provider grok --role "Package.json Reviewer"',
        status: 'completed',
        streaming: false,
        exitCode: 0,
        durationSeconds: 30,
        createdAtUnixMs: 1000,
        attachments: [],
        toolKind: 'subagent',
        subagentMeta: {
          subagentId: 't_shell_wrapper',
          action: 'spawn',
          role: 'Package.json Reviewer',
          provider: 'grok',
          model: 'grok-4.7-build-fast',
          workspaceMode: 'inherit',
          prompt: 'Summarize package.json scripts in 3 bullets.',
          status: 'completed',
          stepCount: 0,
        },
      },
      {
        id: 'dispatch-subagent-b52770b2',
        kind: 'tool',
        text: '',
        title: 'Package.json Reviewer',
        detail: 'Summarize package.json scripts in 3 bullets.',
        status: 'completed',
        streaming: false,
        exitCode: 0,
        durationSeconds: 28,
        createdAtUnixMs: 1100,
        attachments: [],
        toolKind: 'subagent',
        subagentMeta: {
          subagentId: 'b52770b2',
          childThreadId: 'b52770b2',
          action: 'spawn',
          role: 'Package.json Reviewer',
          provider: 'grok',
          model: 'grok-4.7-build-fast',
          workspaceMode: 'inherit',
          prompt: 'Summarize package.json scripts in 3 bullets.',
          latestActivity: 'Reading package.json in project root',
          status: 'completed',
          stepCount: 3,
        },
      },
    ];

    const { container } = render(
      <SubagentGroupRow items={items} threadId="thread-parent" workspaceId="ws-1" />,
    );
    expect(screen.queryByText(/Started 2 subagents/i)).toBeNull();
    expect(container.querySelectorAll('.chat-subagent-card')).toHaveLength(1);
    expect(screen.getByText('Package.json Reviewer')).toBeInTheDocument();
    expect(screen.getByText('Reading package.json in project root')).toBeInTheDocument();
    expect(screen.queryByText(/\$ kite dispatch/i)).toBeNull();
  });

  it('strips markdown punctuation from previews, keeps waiting groups expanded, and ticks elapsed time on DOM ref', () => {
    vi.useFakeTimers();
    try {
      expect(
        plainPreviewLine('### Summary\n- Checked `package.json` & [**OAuth** flow](https://example.com)'),
      ).toBe('Summary Checked package.json & OAuth flow');

      const startedAt = Date.now() - 5_000;
      const items: ChatItem[] = [
        {
          id: 'sub_md_1',
          kind: 'tool',
          text: '',
          title: 'Security Reviewer',
          detail: '- Auditing `src/auth.ts` for **tokens**',
          status: 'waiting',
          streaming: false,
          exitCode: null,
          createdAtUnixMs: startedAt,
          attachments: [],
          toolKind: 'subagent',
          subagentMeta: {
            subagentId: 'sub_md_1',
            action: 'spawn',
            role: 'Security Reviewer',
            status: 'waiting',
            childThreadId: 'child-wait-1',
            latestActivity: '- **Blocked**: awaiting `cargo` approval',
            stepCount: 2,
          },
        },
        {
          id: 'sub_md_2',
          kind: 'tool',
          text: '',
          title: 'Docs Reviewer',
          detail: 'Inspecting README.md',
          status: 'running',
          streaming: true,
          exitCode: null,
          createdAtUnixMs: startedAt,
          attachments: [],
          toolKind: 'subagent',
          subagentMeta: {
            subagentId: 'sub_md_2',
            action: 'spawn',
            role: 'Docs Reviewer',
            status: 'running',
            childThreadId: 'child-run-2',
            latestActivity: 'Reading `README.md`',
            stepCount: 1,
          },
        },
      ];

      const { container } = render(
        <SubagentGroupRow items={items} threadId="thread-parent" workspaceId="ws-1" />,
      );

      expect(screen.getByTestId('subagent-disclosure-group')).toHaveClass('chat-subagent-group--expanded');
      expect(screen.getByText('Blocked: awaiting cargo approval')).toBeInTheDocument();
      expect(screen.getByText('Waiting')).toBeInTheDocument();
      const clock = container.querySelector('.chat-subagent-card__clock');
      expect(clock?.textContent).toBe('5s');
      vi.advanceTimersByTime(2000);
      expect(clock?.textContent).toBe('7s');
    } finally {
      vi.useRealTimers();
    }
  });
});
