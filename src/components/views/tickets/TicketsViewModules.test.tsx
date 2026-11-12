import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  readStoredView,
  persistStoredView,
  readStoredIssues,
  persistIssuesWithBackup,
  readStoredBackup,
  readStoredLabels,
  persistLabels,
  readStoredProjects,
  persistProjects,
  readStoredConnections,
  persistConnections,
  PRIMARY_STORAGE_KEY,
  BACKUP_STORAGE_KEY,
} from './ticketStorage';
import { TicketsHeaderBar } from './TicketsHeaderBar';
import { TicketsBoardView } from './TicketsBoardView';
import { TicketsListView } from './TicketsListView';
import { TicketContextMenu } from './TicketContextMenu';
import type { TicketIssue, TicketProject } from './types';

describe('ticketStorage module', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reads and writes view mode correctly', () => {
    expect(PRIMARY_STORAGE_KEY).toBe('KITE_STORAGE_TICKETS_ISSUES');
    expect(BACKUP_STORAGE_KEY).toBe('KITE_STORAGE_TICKETS_BACKUP');
    expect(readStoredView()).toBe('board');
    persistStoredView('list');
    expect(readStoredView()).toBe('list');
  });

  it('reads and writes issues and maintains backup', () => {
    const initialIssues: TicketIssue[] = [
      {
        id: 'KITE-1',
        uuid: 'u-1',
        revision: 1,
        title: 'Task 1',
        description: '',
        state: 'To Do',
        priority: 'Medium',
        assignee: null,
        delegate: null,
        projectId: null,
        labels: [],
        blocks: [],
        relatedTo: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    persistIssuesWithBackup(initialIssues);
    expect(readStoredIssues()).toHaveLength(1);
    expect(readStoredIssues()[0].title).toBe('Task 1');

    const updatedIssues: TicketIssue[] = [
      ...initialIssues,
      {
        id: 'KITE-2',
        uuid: 'u-2',
        revision: 1,
        title: 'Task 2',
        description: '',
        state: 'In Progress',
        priority: 'High',
        assignee: null,
        delegate: null,
        projectId: null,
        labels: [],
        blocks: [],
        relatedTo: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    persistIssuesWithBackup(updatedIssues);
    expect(readStoredIssues()).toHaveLength(2);

    const backup = readStoredBackup();
    expect(backup).not.toBeNull();
    expect(backup).toHaveLength(1);
    expect(backup![0].title).toBe('Task 1');
  });

  it('reads and writes labels, projects, and connections', () => {
    expect(readStoredLabels()).toHaveLength(4);
    persistLabels([{ id: 'lbl-custom', name: 'Custom' }]);
    expect(readStoredLabels()).toEqual([{ id: 'lbl-custom', name: 'Custom' }]);

    expect(readStoredProjects()).toHaveLength(2);
    persistProjects([{ id: 'p-1', name: 'Alpha' }]);
    expect(readStoredProjects()).toEqual([{ id: 'p-1', name: 'Alpha' }]);

    expect(readStoredConnections()).toEqual([]);
    persistConnections([{ id: 'c-1', name: 'MCP 1', readOnly: false, revokedAt: null }]);
    expect(readStoredConnections()).toHaveLength(1);
  });
});

describe('TicketsHeaderBar component', () => {
  it('renders breadcrumb and action buttons', async () => {
    const user = userEvent.setup();
    const onNewTask = vi.fn();
    const onSearchChange = vi.fn();

    render(
      <TicketsHeaderBar
        activeView="board"
        hasSelectedIssue={false}
        statusFilter="all"
        filteredIssues={[]}
        onSelectStatusFilter={vi.fn()}
        searchQuery=""
        onSearchQueryChange={onSearchChange}
        showArchived={false}
        onToggleShowArchived={vi.fn()}
        onViewChange={vi.fn()}
        onOpenMetadata={vi.fn()}
        onOpenMcp={vi.fn()}
        onRestoreBackup={vi.fn()}
        onNewTask={onNewTask}
      />
    );

    expect(screen.getByText('Tasks')).toBeInTheDocument();
    const newTaskBtn = screen.getByRole('button', { name: /new task/i });
    await user.click(newTaskBtn);
    expect(onNewTask).toHaveBeenCalled();
  });
});

describe('TicketsBoardView component', () => {
  it('renders columns and empty state hint', () => {
    render(
      <TicketsBoardView
        filteredIssues={[]}
        runsMap={new Map()}
        searchQuery=""
        onSelectIssue={vi.fn()}
        onMoveIssue={vi.fn()}
        onNewTaskInColumn={vi.fn()}
        onContextMenu={vi.fn()}
      />
    );

    expect(screen.getByText(/Create a task here or ask Kite by voice/i)).toBeInTheDocument();
  });
});

describe('TicketsListView component', () => {
  it('renders list items and projects', () => {
    const sampleIssues: TicketIssue[] = [
      {
        id: 'KITE-10',
        uuid: 'u-10',
        revision: 1,
        title: 'Review PR #42',
        description: '',
        state: 'To Do',
        priority: 'High',
        assignee: 'dev1',
        delegate: null,
        projectId: 'proj-1',
        labels: ['Frontend'],
        blocks: [],
        relatedTo: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const sampleProjects: TicketProject[] = [
      { id: 'proj-1', name: 'Core Engine' },
    ];

    render(
      <TicketsListView
        filteredIssues={sampleIssues}
        projects={sampleProjects}
        statusFilter="all"
        searchQuery=""
        onSelectIssue={vi.fn()}
        onNewTaskInColumn={vi.fn()}
        onContextMenu={vi.fn()}
      />
    );

    expect(screen.getByText('Review PR #42')).toBeInTheDocument();
    expect(screen.getByText('Core Engine')).toBeInTheDocument();
  });
});

describe('TicketContextMenu component', () => {
  it('renders menu when contextMenu is non-null', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSelectIssue = vi.fn();

    const sampleIssue: TicketIssue = {
      id: 'KITE-20',
      uuid: 'u-20',
      revision: 1,
      title: 'Context task',
      description: '',
      state: 'To Do',
      priority: 'Low',
      assignee: null,
      delegate: null,
      projectId: null,
      labels: [],
      blocks: [],
      relatedTo: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    render(
      <TicketContextMenu
        contextMenu={{ issue: sampleIssue, x: 100, y: 150 }}
        onClose={onClose}
        onSelectIssue={onSelectIssue}
        onDispatch={vi.fn()}
        onMoveIssue={vi.fn()}
        onArchiveIssue={vi.fn()}
      />
    );

    const openBtn = screen.getByText('Open');
    await user.click(openBtn);
    expect(onSelectIssue).toHaveBeenCalledWith('KITE-20');
  });
});
