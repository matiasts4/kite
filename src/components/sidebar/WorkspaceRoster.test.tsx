import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceRoster } from './WorkspaceRoster';
import type { Workspace } from '../../types';
import type { WorkspaceSessionTab } from './types';

describe('WorkspaceRoster - Behavioral Tests', () => {
  const sampleWorkspaces: Workspace[] = [
    {
      id: 'ws-pinned',
      displayName: 'Main App',
      createdAtUnixMs: Date.now() - 100000,
      lastOpenedAtUnixMs: Date.now() - 1000,
      pinned: true,
      available: true,
    },
    {
      id: 'ws-unpinned',
      displayName: 'Docs Project',
      createdAtUnixMs: Date.now() - 200000,
      lastOpenedAtUnixMs: Date.now() - 50000,
      pinned: false,
      available: true,
    },
  ];

  const sampleSessions: Record<string, WorkspaceSessionTab[]> = {
    'ws-pinned': [
      { id: 'tab-1', title: 'Frontend Shell', isActive: true, paneCount: 2 },
      { id: 'tab-2', title: 'API Gateway', isActive: false, paneCount: 1 },
    ],
  };

  it('renders pinned and unpinned workspaces and session badges', () => {
    render(
      <WorkspaceRoster
        workspaces={sampleWorkspaces}
        selectedWorkspaceId="ws-pinned"
        onSelectWorkspace={vi.fn()}
        workspaceSessions={sampleSessions}
      />
    );

    expect(screen.getByText('Main App')).toBeInTheDocument();
    expect(screen.getByText('Docs Project')).toBeInTheDocument();

    // Auto-expanded session tabs for selected workspace
    expect(screen.getByText('Frontend Shell')).toBeInTheDocument();
    expect(screen.getByText('API Gateway')).toBeInTheDocument();
  });

  it('calls onSelectWorkspace when workspace row is clicked', async () => {
    const user = userEvent.setup();
    const onSelectWorkspace = vi.fn();

    render(
      <WorkspaceRoster
        workspaces={sampleWorkspaces}
        selectedWorkspaceId="ws-pinned"
        onSelectWorkspace={onSelectWorkspace}
      />
    );

    const docsRow = screen.getByText('Docs Project');
    await user.click(docsRow);

    expect(onSelectWorkspace).toHaveBeenCalledWith('ws-unpinned');
  });

  it('calls onSelectWorkspaceTab when a session tab is clicked', async () => {
    const user = userEvent.setup();
    const onSelectWorkspaceTab = vi.fn();

    render(
      <WorkspaceRoster
        workspaces={sampleWorkspaces}
        selectedWorkspaceId="ws-pinned"
        onSelectWorkspace={vi.fn()}
        onSelectWorkspaceTab={onSelectWorkspaceTab}
        workspaceSessions={sampleSessions}
      />
    );

    const apiTab = screen.getByText('API Gateway');
    await user.click(apiTab);

    expect(onSelectWorkspaceTab).toHaveBeenCalledWith('ws-pinned', 'tab-2');
  });

  it('renders empty state when workspaces list is empty', () => {
    render(
      <WorkspaceRoster
        workspaces={[]}
        selectedWorkspaceId={null}
        onSelectWorkspace={vi.fn()}
      />
    );

    expect(screen.getByText(/Add a folder or drop one here/i)).toBeInTheDocument();
  });

  it('only marks the active tab in the currently selected workspace, never in inactive workspaces', () => {
    const multiSessions: Record<string, WorkspaceSessionTab[]> = {
      'ws-pinned': [
        { id: 'tab-1', title: 'Window 4 Terminals', isActive: true, paneCount: 4 },
      ],
      'ws-unpinned': [
        { id: 'tab-2', title: 'Window 2 Terminals', isActive: true, paneCount: 2 },
      ],
    };

    const { rerender } = render(
      <WorkspaceRoster
        workspaces={sampleWorkspaces}
        selectedWorkspaceId="ws-pinned"
        onSelectWorkspace={vi.fn()}
        workspaceSessions={multiSessions}
      />
    );

    // When ws-pinned is selected, tab-1 is active; tab-2 in ws-unpinned must not be active
    const tab1Btn = screen.getByText('Window 4 Terminals').closest('button');
    expect(tab1Btn).toHaveAttribute('aria-current', 'page');
    expect(tab1Btn?.closest('.workspace-tab-row')).toHaveClass('workspace-tab-row--selected');

    // Switch selection to ws-unpinned
    rerender(
      <WorkspaceRoster
        workspaces={sampleWorkspaces}
        selectedWorkspaceId="ws-unpinned"
        onSelectWorkspace={vi.fn()}
        workspaceSessions={multiSessions}
      />
    );

    // Now tab-2 should be active, and tab-1 must NOT be active
    const tab2Btn = screen.getByText('Window 2 Terminals').closest('button');
    expect(tab2Btn).toHaveAttribute('aria-current', 'page');
    expect(tab2Btn?.closest('.workspace-tab-row')).toHaveClass('workspace-tab-row--selected');

    expect(tab1Btn).not.toHaveAttribute('aria-current', 'page');
    expect(tab1Btn?.closest('.workspace-tab-row')).not.toHaveClass('workspace-tab-row--selected');
  });

  it('marks only the first tab active as fallback when multiple tabs exist without explicit isActive, never all of them', () => {
    const fallbackSessions: Record<string, WorkspaceSessionTab[]> = {
      'ws-pinned': [
        { id: 'tab-1', title: 'Window 4 Terminals', paneCount: 4 },
        { id: 'tab-2', title: 'Window 2 Terminals', paneCount: 2 },
      ],
    };

    render(
      <WorkspaceRoster
        workspaces={sampleWorkspaces}
        selectedWorkspaceId="ws-pinned"
        onSelectWorkspace={vi.fn()}
        workspaceSessions={fallbackSessions}
      />
    );

    const tab1Btn = screen.getByText('Window 4 Terminals').closest('button');
    const tab2Btn = screen.getByText('Window 2 Terminals').closest('button');

    // Exactly one tab is active — tab 1 as fallback, tab 2 is NOT active
    expect(tab1Btn).toHaveAttribute('aria-current', 'page');
    expect(tab1Btn?.closest('.workspace-tab-row')).toHaveClass('workspace-tab-row--selected');

    expect(tab2Btn).not.toHaveAttribute('aria-current', 'page');
    expect(tab2Btn?.closest('.workspace-tab-row')).not.toHaveClass('workspace-tab-row--selected');
  });
  it('renders multi-pane session with disclosure chevron, brand logos, and individual pane sub-tree', async () => {
    const user = userEvent.setup();
    const onSelectWorkspaceTab = vi.fn();
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    const multiPaneSessions: Record<string, WorkspaceSessionTab[]> = {
      'ws-pinned': [
        {
          id: 'tab-multi',
          title: 'Orion (+2)',
          paneCount: 3,
          isActive: true,
          panes: [
            { id: 'pane-1', kind: 'terminal', label: 'Orion', engine: 'claude', isFocused: true },
            { id: 'pane-2', kind: 'terminal', label: 'Vega', engine: 'codex', isFocused: false },
            { id: 'pane-3', kind: 'terminal', label: 'Terminal 1', engine: 'powershell', isFocused: false },
          ],
        },
      ],
    };

    render(
      <WorkspaceRoster
        workspaces={sampleWorkspaces}
        selectedWorkspaceId="ws-pinned"
        onSelectWorkspace={vi.fn()}
        onSelectWorkspaceTab={onSelectWorkspaceTab}
        workspaceSessions={multiPaneSessions}
      />
    );

    // Main session row is rendered
    expect(screen.getByText('Orion (+2)')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();

    // Auto-expanded sub-tree shows each individual terminal pane
    expect(screen.getByText('Orion')).toBeInTheDocument();
    expect(screen.getByText('Vega')).toBeInTheDocument();
    expect(screen.getByText('Terminal 1')).toBeInTheDocument();
    expect(screen.getByText('claude')).toBeInTheDocument();
    expect(screen.getByText('codex')).toBeInTheDocument();
    expect(screen.getByText('shell')).toBeInTheDocument();

    // Clicking an individual pane focuses it via window event
    const vegaBtn = screen.getByText('Vega').closest('button');
    expect(vegaBtn).toBeTruthy();
    await user.click(vegaBtn!);

    expect(onSelectWorkspaceTab).toHaveBeenCalledWith('ws-pinned', 'tab-multi');
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'kite:operator-pane-layout',
        detail: {
          operation: 'focus',
          target: 'pane-2',
          workspaceId: 'ws-pinned',
        },
      })
    );

    // Toggle collapse/expand button
    const disclosureBtn = screen.getByLabelText(/Collapse.*terminals/i);
    await user.click(disclosureBtn);

    // Panes are collapsed
    expect(screen.queryByText('Vega')).not.toBeInTheDocument();

    dispatchSpy.mockRestore();
  });
});

