import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { Sidebar } from './Sidebar';

const { mockInvokeCommand } = vi.hoisted(() => ({
  mockInvokeCommand: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invokeCommand: mockInvokeCommand,
  isTauriEnvironment: () => true,
  subscribeEvent: vi.fn().mockResolvedValue(() => {}),
}));

describe('Sidebar agent availability probe caching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvokeCommand.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_agent_availability') {
        return { hasProbed: false, phase: 'initial', teammates: [] };
      }
      if (cmd === 'probe_agent_availability') {
        return { hasProbed: true, phase: 'ready', teammates: [{ engine: 'claude', installed: true }] };
      }
      if (cmd === 'list_agent_rail_activity') {
        return [];
      }
      return null;
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('probes agent availability only once across mode switches back to agent', async () => {
    const baseProps = {
      workspaces: [],
      agents: [{ id: 'a1', name: 'Agent 1', engine: 'claude', purpose: '', avatar: null, createdAtUnixMs: 1, pinned: false, order: 0 }],
      threads: [],
      selectedWorkspaceId: null,
      onSelectWorkspace: vi.fn(),
      selectedAgentId: 'a1',
      onSelectAgent: vi.fn(),
      selectedThreadId: null,
      onSelectThread: vi.fn(),
      accountName: 'Dev',
      accountTier: 'FREE',
      accountTierPaid: false,
      creditsLabel: undefined,
      onNewAgent: vi.fn(),
      onAddWorkspace: vi.fn(),
      onNewChat: vi.fn(),
      onNewAgentChat: vi.fn(),
      onCopyWorkspacePath: vi.fn(),
      onTogglePinWorkspace: vi.fn(),
      onTogglePinAgent: vi.fn(),
      onMoveAgent: vi.fn(),
      onDeleteAgent: vi.fn(),
      onOpenAgentSettings: vi.fn(),
      onRenameWorkspace: vi.fn(),
      onRemoveWorkspaceFromList: vi.fn(),
      onMoveWorkspace: vi.fn(),
      onNewWorkspaceSession: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenArchivedChats: vi.fn(),
      onConnectSsh: vi.fn(),
      appearance: 'dark' as const,
      onToggleAppearance: vi.fn(),
    };

    const { rerender } = render(<Sidebar {...baseProps} mode="agent" />);
    await waitFor(() => {
      const probes = mockInvokeCommand.mock.calls.filter(([c]) => c === 'probe_agent_availability');
      expect(probes).toHaveLength(1);
    });

    rerender(<Sidebar {...baseProps} mode="chat" />);
    rerender(<Sidebar {...baseProps} mode="agent" />);
    rerender(<Sidebar {...baseProps} mode="code" />);
    rerender(<Sidebar {...baseProps} mode="agent" />);

    await new Promise((r) => setTimeout(r, 20));
    const totalProbes = mockInvokeCommand.mock.calls.filter(([c]) => c === 'probe_agent_availability');
    expect(totalProbes).toHaveLength(1);
  });

  it('renders Routines button without fixed-square chrome-button class and defines auto-width CSS', async () => {
    render(
      <Sidebar
        mode="agent"
        workspaces={[]}
        agents={[
          {
            id: 'a1',
            name: 'Ship Guard',
            engine: 'antigravity',
            purpose: 'Prepare safe slices',
            avatar: null,
            createdAtUnixMs: 1,
            pinned: false,
            order: 0,
          },
        ]}
        threads={[]}
        selectedWorkspaceId={null}
        onSelectWorkspace={vi.fn()}
        selectedAgentId="a1"
        onSelectAgent={vi.fn()}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
        accountName="Dev"
        accountTier="FREE"
        accountTierPaid={false}
        onNewAgent={vi.fn()}
        onAddWorkspace={vi.fn()}
        onNewChat={vi.fn()}
        onNewAgentChat={vi.fn()}
        onCopyWorkspacePath={vi.fn()}
        onTogglePinWorkspace={vi.fn()}
        onTogglePinAgent={vi.fn()}
        onMoveAgent={vi.fn()}
        onDeleteAgent={vi.fn()}
        onOpenAgentSettings={vi.fn()}
        onRenameWorkspace={vi.fn()}
        onRemoveWorkspaceFromList={vi.fn()}
        onMoveWorkspace={vi.fn()}
        onNewWorkspaceSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenArchivedChats={vi.fn()}
        onConnectSsh={vi.fn()}
        appearance="dark"
        onToggleAppearance={vi.fn()}
      />
    );

    const routinesBtn = screen.getByRole('button', { name: 'Routines' });
    expect(routinesBtn).toHaveClass('sidebar__routines-button');
    expect(routinesBtn).not.toHaveClass('chrome-button');

    const fsSpecifier = ['node', 'fs'].join(':');
    const fsMod = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (filePath: string, encoding: 'utf8') => string;
    };
    const visualCss = fsMod.readFileSync('src/visual-language.css', 'utf8');
    expect(visualCss).toMatch(/\.sidebar__routines-button\s*\{[^}]*width:\s*auto/s);
    expect(visualCss).toMatch(/\.sidebar__routines-button\s*\{[^}]*white-space:\s*nowrap/s);
  });

  it('marks Sidebar Routines button active when routinesOpen is true', () => {
    render(
      <Sidebar
        mode="agent"
        routinesOpen={true}
        workspaces={[]}
        agents={[
          {
            id: 'a1',
            name: 'Ship Guard',
            engine: 'antigravity',
            purpose: 'Prepare safe slices',
            avatar: null,
            createdAtUnixMs: 1,
            pinned: false,
            order: 0,
          },
        ]}
        threads={[]}
        selectedWorkspaceId={null}
        onSelectWorkspace={vi.fn()}
        selectedAgentId="a1"
        onSelectAgent={vi.fn()}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
        accountName="Dev"
        accountTier="FREE"
        accountTierPaid={false}
        onNewAgent={vi.fn()}
        onAddWorkspace={vi.fn()}
        onNewChat={vi.fn()}
        onNewAgentChat={vi.fn()}
        onCopyWorkspacePath={vi.fn()}
        onTogglePinWorkspace={vi.fn()}
        onTogglePinAgent={vi.fn()}
        onMoveAgent={vi.fn()}
        onDeleteAgent={vi.fn()}
        onOpenAgentSettings={vi.fn()}
        onRenameWorkspace={vi.fn()}
        onRemoveWorkspaceFromList={vi.fn()}
        onMoveWorkspace={vi.fn()}
        onNewWorkspaceSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenArchivedChats={vi.fn()}
        onConnectSsh={vi.fn()}
        appearance="dark"
        onToggleAppearance={vi.fn()}
      />
    );

    const routinesBtn = screen.getByRole('button', { name: 'Routines' });
    expect(routinesBtn).toHaveAttribute('aria-pressed', 'true');
    expect(routinesBtn).toHaveClass('sidebar__routines-button--active');
  });
});
