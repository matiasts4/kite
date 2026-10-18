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
});
