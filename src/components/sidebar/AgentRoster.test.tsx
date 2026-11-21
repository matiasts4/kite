import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AgentRoster } from './AgentRoster';
import type { AgentProfile } from '../../types';

const makeAgent = (overrides: Partial<AgentProfile> = {}): AgentProfile => ({
  id: 'agent-1',
  name: 'Builder',
  engine: 'claude',
  purpose: 'Build features',
  avatar: null,
  createdAtUnixMs: 1000,
  pinned: false,
  order: 0,
  ...overrides,
});

describe('AgentRoster live activity indicators', () => {
  afterEach(() => {
    cleanup();
  });

  it('displays running count and needs-you badges from railActivity', () => {
    const agents = [
      makeAgent({ id: 'agent-run', name: 'Runner', pinned: true }),
      makeAgent({ id: 'agent-wait', name: 'Waiter', pinned: false }),
    ];

    render(
      <AgentRoster
        agents={agents}
        selectedAgentId={null}
        onSelectAgent={vi.fn()}
        onNewAgent={vi.fn()}
        railActivity={{
          'agent-run': { runningCount: 3, needsYou: false, atUnixMs: 2000 },
          'agent-wait': { runningCount: 0, needsYou: true, atUnixMs: 2000 },
        }}
      />
    );

    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Needs you')).toBeInTheDocument();
  });

  it('preserves active agentActivity when railActivity reports idle zeros', () => {
    const agents = [makeAgent({ id: 'agent-1', name: 'Builder' })];

    render(
      <AgentRoster
        agents={agents}
        selectedAgentId="agent-1"
        onSelectAgent={vi.fn()}
        onNewAgent={vi.fn()}
        agentActivity={{
          'agent-1': { runningCount: 2, needsYou: false, atUnixMs: 3000 },
        }}
        railActivity={{
          'agent-1': { runningCount: 0, needsYou: false, atUnixMs: 2500 },
        }}
      />
    );

    expect(screen.getByText('2')).toBeInTheDocument();
  });
});
