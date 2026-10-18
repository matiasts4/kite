import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentDashboardView } from './AgentDashboardView';
import type { AgentDigest, AgentRow } from './AgentDashboardView';

// Mock ipc invokeCommand
vi.mock('../../../lib/ipc', () => ({
  listLiveChatRuns: vi.fn().mockResolvedValue([]),
  listAgents: vi.fn().mockResolvedValue([]),
  listAgentProfiles: vi.fn().mockResolvedValue([]),
  invokeCommand: vi.fn().mockResolvedValue({ success: true }),
}));

// Mock terminalRegistry
vi.mock('../../../lib/terminalRegistry', () => ({
  getActiveAgentTerminals: vi.fn().mockReturnValue([]),
  markTerminalExited: vi.fn(),
}));

import { invokeCommand } from '../../../lib/ipc';
import { markTerminalExited } from '../../../lib/terminalRegistry';

describe('AgentDashboardView - Behavioral Tests', () => {
  const sampleRows: AgentRow[] = [
    {
      id: 'term:sess-1',
      target: { kind: 'pane', leafId: 'leaf-1' },
      mark: { kind: 'engine', engine: 'antigravity', name: 'Antigravity' },
      title: 'Antigravity Optimizer',
      who: 'Antigravity',
      place: 'Core Workspace',
      latest: 'Analyzing benchmark results...',
      state: 'working',
      sinceUnixMs: Date.now() - 120000,
    },
    {
      id: 'term:sess-2',
      target: { kind: 'pane', leafId: 'leaf-2' },
      mark: { kind: 'engine', engine: 'claude-code', name: 'Claude Code' },
      title: 'Claude Reviewer',
      who: 'Claude Code',
      place: 'Core Workspace',
      latest: 'Waiting for permission to run git commit',
      state: 'waitingForYou',
      sinceUnixMs: Date.now() - 30000,
    },
    {
      id: 'term:sess-3',
      target: { kind: 'pane', leafId: 'leaf-3' },
      mark: { kind: 'engine', engine: 'codex', name: 'Codex' },
      title: 'Codex Shell',
      who: 'Codex',
      place: 'Core Workspace',
      latest: null,
      state: 'idle',
      sinceUnixMs: Date.now() - 600000,
    },
  ];

  const sampleDigest: AgentDigest = {
    rows: sampleRows,
    placeOrder: ['Core Workspace'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders summary headline and total agent count', () => {
    render(<AgentDashboardView digest={sampleDigest} />);

    // Total agents headline
    expect(screen.getAllByText('3').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('agents')).toBeInTheDocument();

    // Agent titles rendered
    expect(screen.getByText('Antigravity Optimizer')).toBeInTheDocument();
    expect(screen.getByText('Claude Reviewer')).toBeInTheDocument();
    expect(screen.getByText('Codex Shell')).toBeInTheDocument();
  });

  it('filters agent cards in real time using the search box', async () => {
    const user = userEvent.setup();
    render(<AgentDashboardView digest={sampleDigest} />);

    const searchInput = screen.getByPlaceholderText('Search agents');
    await user.type(searchInput, 'Claude');

    // Only Claude card should remain visible
    expect(screen.getByText('Claude Reviewer')).toBeInTheDocument();
    expect(screen.queryByText('Antigravity Optimizer')).toBeNull();
    expect(screen.queryByText('Codex Shell')).toBeNull();
  });

  it('filters agent cards by status chips', async () => {
    const user = userEvent.setup();
    render(<AgentDashboardView digest={sampleDigest} />);

    // Click 'Waiting on you' chip
    const waitingChip = screen.getByRole('button', { name: /waiting on you/i });
    await user.click(waitingChip);

    expect(screen.getByText('Claude Reviewer')).toBeInTheDocument();
    expect(screen.queryByText('Antigravity Optimizer')).toBeNull();
  });

  it('terminates terminal and dismisses card when card close button is clicked', async () => {
    const user = userEvent.setup();
    const terminateListener = vi.fn();
    window.addEventListener('kite:terminate-agent', terminateListener);

    render(<AgentDashboardView digest={sampleDigest} />);

    // Find dismiss button for Antigravity Optimizer
    const dismissBtn = screen.getByRole('button', { name: /close antigravity optimizer/i });
    await user.click(dismissBtn);

    // Antigravity should be terminated via backend IPC
    expect(invokeCommand).toHaveBeenCalledWith('terminate_terminal', {
      sessionId: 'sess-1',
      owner: 'user',
    });
    expect(markTerminalExited).toHaveBeenCalledWith('sess-1');
    expect(terminateListener).toHaveBeenCalled();
    window.removeEventListener('kite:terminate-agent', terminateListener);
  });

  it('triggers onCloseIdle when "Close idle" button is clicked', async () => {
    const user = userEvent.setup();
    const onCloseIdle = vi.fn();
    render(<AgentDashboardView digest={sampleDigest} onCloseIdle={onCloseIdle} />);

    const closeIdleBtn = screen.getByRole('button', { name: /close idle/i });
    await user.click(closeIdleBtn);

    expect(onCloseIdle).toHaveBeenCalledTimes(1);
    expect(invokeCommand).toHaveBeenCalledWith('terminate_terminal', {
      sessionId: 'sess-3',
      owner: 'user',
    });
    expect(markTerminalExited).toHaveBeenCalledWith('sess-3');
  });
});
