import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SwarmBoardInspector } from './SwarmBoardInspector';
import type { SwarmState } from '../../../types';

const sampleSwarm: SwarmState = {
  swarmId: 'swarm-42',
  title: 'Checkout Swarm',
  members: [
    {
      name: 'parser',
      role: 'API Parser',
      model: 'gemini-2.5-flash',
      provider: 'gemini',
      workspaceMode: 'share',
      state: 'working',
      currentActivity: 'Running Vitest on checkout.ts',
      subagentId: 'sub-parser',
      channels: ['main', 'api'],
    },
    {
      name: 'reviewer',
      role: 'Security Reviewer',
      model: 'grok-3-mini',
      provider: 'grok',
      workspaceMode: 'branch',
      state: 'waiting',
      subagentId: 'sub-reviewer',
      channels: ['main'],
    },
    {
      name: 'docs',
      role: 'Docs Writer',
      model: 'claude-3-5-haiku',
      provider: 'claude',
      workspaceMode: 'inherit',
      state: 'stopped',
      channels: ['main', 'docs'],
    },
    {
      name: 'monitor',
      role: 'Swarm Monitor',
      model: 'gemini-2.5-flash',
      provider: 'gemini',
      workspaceMode: 'inherit',
      state: 'killed',
      channels: ['main'],
    },
  ],
  channels: [
    { name: 'main', topic: 'Main coordination' },
    { name: 'api', topic: 'API schema channel' },
    { name: 'docs', topic: 'Documentation channel' },
  ],
  posts: [
    {
      seq: 1,
      author: 'coordinator',
      channel: 'main',
      text: '@parser please parse schema first',
      mentions: ['parser'],
      createdAtUnixMs: 1_700_000_001_000,
    },
    {
      seq: 2,
      author: 'parser',
      channel: 'api',
      text: 'Parsed routes, handing to @reviewer (see #1)',
      mentions: ['reviewer'],
      createdAtUnixMs: 1_700_000_004_000,
    },
    {
      seq: 3,
      author: 'monitor',
      channel: 'main',
      text: '[stall] checking @docs progress from #2',
      mentions: ['docs'],
      createdAtUnixMs: 1_700_000_008_000,
    },
  ],
};

describe('SwarmBoardInspector', () => {
  it('renders Board Feed with channel filters, #seq pills, and clickable @mention pills', () => {
    const onInspectWorker = vi.fn();
    const scrollIntoViewMock = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewMock;

    render(
      <SwarmBoardInspector
        swarmState={sampleSwarm}
        parentModelLabel="Opus 4.6"
        onInspectWorker={onInspectWorker}
      />,
    );

    expect(screen.getByText('Checkout Swarm')).toBeInTheDocument();
    expect(screen.getByText(/Coordinator: Opus 4\.6/i)).toBeInTheDocument();

    // All posts initially visible
    expect(screen.getByTestId('swarm-post-1')).toBeInTheDocument();
    expect(screen.getByTestId('swarm-post-2')).toBeInTheDocument();

    // Filter by #api channel
    fireEvent.click(screen.getByRole('button', { name: '#api' }));
    expect(screen.queryByTestId('swarm-post-1')).toBeNull();
    expect(screen.getByTestId('swarm-post-2')).toBeInTheDocument();

    // Reset filter to All
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByTestId('swarm-post-1')).toBeInTheDocument();

    // Click #1 sequence pill -> scrolls post #1 into view
    fireEvent.click(screen.getByRole('button', { name: '#1' }));
    expect(scrollIntoViewMock).toHaveBeenCalled();

    // Click @reviewer mention pill -> opens worker stream
    fireEvent.click(screen.getAllByRole('button', { name: '@reviewer' })[0]);
    expect(onInspectWorker).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'reviewer' }),
    );
  });

  it('renders Roster with all 4 state badges, workspace modes, model badges, and Activity Graph edges', () => {
    const onInspectWorker = vi.fn();

    render(
      <SwarmBoardInspector
        swarmState={sampleSwarm}
        parentModelLabel="Opus 4.6"
        onInspectWorker={onInspectWorker}
      />,
    );

    // Switch to Roster
    fireEvent.click(screen.getByRole('tab', { name: /Roster \(4\)/i }));

    expect(screen.getByText(/Running Vitest on checkout\.ts/i)).toBeInTheDocument();
    expect(screen.getByText(/Sleeping on board \(0 tokens\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Stopped \(wakes on @mention\)/i)).toBeInTheDocument();
    expect(screen.getByText('Killed')).toBeInTheDocument();
    expect(screen.getByText('share')).toBeInTheDocument();
    expect(screen.getByText('branch')).toBeInTheDocument();

    // Inspect @parser stream
    fireEvent.click(screen.getByRole('button', { name: /Inspect @parser/i }));
    expect(onInspectWorker).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'parser' }),
    );

    // Switch to Activity Graph
    fireEvent.click(screen.getByRole('tab', { name: /Activity Graph/i }));
    const graph = screen.getByTestId('swarm-activity-graph');
    expect(graph).toBeInTheDocument();
    expect(graph.textContent).toContain('Coordinator');
    expect(graph.textContent).toContain('@parser');
    expect(graph.textContent).toContain('stall');
  });
});
