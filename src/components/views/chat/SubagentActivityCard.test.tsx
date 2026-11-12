import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ChatItem } from '../../../types';
import { SubagentActivityCard } from './SubagentActivityCard';
import { SwarmActivityCard } from './SwarmActivityCard';
import { OPEN_RIGHT_DOCK_SUBAGENT_EVENT, type OpenRightDockSubagentDetail } from '../../../lib/subagentNav';

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
});
