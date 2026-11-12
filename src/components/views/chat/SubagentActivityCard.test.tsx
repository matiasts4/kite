import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ChatItem } from '../../../types';
import { SubagentActivityCard, SubagentGroupRow } from './SubagentActivityCard';
import { SwarmActivityCard } from './SwarmActivityCard';
import {
  OPEN_RIGHT_DOCK_SUBAGENT_EVENT,
  setActiveSubagentInspection,
  type OpenRightDockSubagentDetail,
} from '../../../lib/subagentNav';

describe('SubagentActivityCard and SwarmActivityCard', () => {
  it('renders a live subagent card with role, model, workspace, ripple dot, shine preview, and dispatches dock event on click', () => {
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
    expect(container.querySelector('.chat-working-pulse')).not.toBeNull();
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
});
