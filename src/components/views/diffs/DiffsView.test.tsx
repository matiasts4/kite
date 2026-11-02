import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { DiffsView } from './DiffsView';
import { DiffCodeViewer } from './DiffCodeViewer';
import type { WorkspaceChanges } from '../files/gitTypes';
import type { DiffData } from '../chat/types';
import { MOTION_EXIT_MS } from '../../../motion/contract';

// Mock git service
const mockChanges: WorkspaceChanges = {
  isRepo: true,
  branch: 'main',
  workspacePrefix: '',
  upstream: null,
  files: [
    {
      path: 'index.html',
      status: 'modified',
      oldPath: null,
      staged: false,
      unstaged: true,
    },
    {
      path: 'src/main.ts',
      status: 'added',
      oldPath: null,
      staged: true,
      unstaged: false,
    },
  ],
};

const mockFileDiff: DiffData = {
  truncated: false,
  lines: [
    { kind: 'meta', oldNumber: null, newNumber: null, text: 'diff --git a/index.html b/index.html' },
    { kind: 'hunk', oldNumber: null, newNumber: null, text: '@@ -1,3 +1,3 @@' },
    { kind: 'context', oldNumber: 1, newNumber: 1, text: '<!DOCTYPE html>' },
    { kind: 'removed', oldNumber: 2, newNumber: null, text: '<title>Old</title>' },
    { kind: 'added', oldNumber: null, newNumber: 2, text: '<title>New Clean Diff</title>' },
  ],
};

vi.mock('../files/useWorkspaceGit', () => ({
  useWorkspaceGit: () => ({
    gitChanges: mockChanges,
    gitLoading: false,
    gitError: null,
    selectedDiffPath: 'index.html',
    diffData: mockFileDiff,
    diffLoading: false,
    diffError: null,
    gitBusy: null,
    gitWriteError: null,
    commitDraft: 'Initial commit message',
    setCommitDraft: vi.fn(),
    setSelectedDiffPath: vi.fn(),
    setGitWriteError: vi.fn(),
    refreshGit: vi.fn(),
    handleToggleStage: vi.fn(),
    handleStageAll: vi.fn(),
    handleUnstageAll: vi.fn(),
    handleDiscardChanges: vi.fn(),
    handleCommit: vi.fn(),
  }),
}));

vi.mock('../files/gitTypes', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../files/gitTypes');
  return {
    ...actual,
    createWorkspaceGitService: () => ({
      readWorkspaceChanges: vi.fn().mockResolvedValue(mockChanges),
      readWorkspaceFileDiff: vi.fn().mockResolvedValue(mockFileDiff),
      stageWorkspaceChanges: vi.fn(),
      stageAllWorkspaceChanges: vi.fn(),
      unstageWorkspaceChanges: vi.fn(),
      discardWorkspaceChanges: vi.fn(),
      commitWorkspaceChanges: vi.fn(),
    }),
  };
});

describe('DiffsView Component Tests', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders top commit bar with draft message and commit buttons', () => {
    render(<DiffsView workspaceId="ws-test" />);

    expect(screen.getByPlaceholderText(/Commit message/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Commit$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Stage all$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Unstage all$/i })).toBeInTheDocument();
  });

  it('renders filter pills and file cards', async () => {
    render(<DiffsView workspaceId="ws-test" />);

    expect(screen.getByRole('button', { name: /^All/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Staged/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Unstaged/ })).toBeInTheDocument();

    expect(screen.getAllByText('index.html').length).toBeGreaterThan(0);
    expect(screen.getAllByText('main.ts').length).toBeGreaterThan(0);
  });

  it('toggles file tree navigation panel when clicked', () => {
    render(<DiffsView workspaceId="ws-test" />);

    const treeToggle = screen.getByLabelText(/file tree/i);
    expect(treeToggle).toBeInTheDocument();

    // Default open
    expect(screen.getByPlaceholderText('Filter files…')).toBeInTheDocument();

    // Toggle close
    fireEvent.click(treeToggle);
    expect(screen.queryByPlaceholderText('Filter files…')).not.toBeInTheDocument();

    // Toggle open again
    fireEvent.click(treeToggle);
    expect(screen.getByPlaceholderText('Filter files…')).toBeInTheDocument();
  });

  it('toggles word wrap mode and updates button state', () => {
    render(<DiffsView workspaceId="ws-test" />);

    const wrapToggle = screen.getByLabelText(/line wrapping/i);
    expect(wrapToggle).toBeInTheDocument();

    fireEvent.click(wrapToggle);
    expect(localStorage.getItem('kite.diffs.wordwrap.v1')).toBe('false');
  });

  it('renders stepper navigation with file counter and allows selecting files in focused mode', () => {
    localStorage.setItem('kite.diffs.viewmode.v1', 'focused');
    render(<DiffsView workspaceId="ws-test" />);

    // In focused mode with multiple files, the stepper is rendered
    expect(screen.getByLabelText('Previous file')).toBeInTheDocument();
    expect(screen.getByLabelText('Next file')).toBeInTheDocument();
    expect(screen.getByText(/1 of 2/i)).toBeInTheDocument();

    const selector = screen.getByLabelText('Jump to file');
    expect(selector).toBeInTheDocument();
    fireEvent.change(selector, { target: { value: 'src/main.ts' } });
  });

  it('starts stream mode with all diff cards collapsed by default', () => {
    render(<DiffsView workspaceId="ws-test" />);

    // Both cards exist in the stream
    const cards = screen.getAllByRole('article');
    expect(cards.length).toBe(2);

    // Diffs should not be visible initially because cards start collapsed
    expect(screen.queryByText('<title>New Clean Diff</title>')).not.toBeInTheDocument();

    // Chevrons should have collapsed aria-label
    const chevrons = screen.getAllByLabelText('Expand');
    expect(chevrons.length).toBe(2);
  });

  it('expands a diff card when clicked and collapses it when clicked again', async () => {
    render(<DiffsView workspaceId="ws-test" />);

    // Initially collapsed
    expect(screen.queryByText('<title>New Clean Diff</title>')).not.toBeInTheDocument();

    // Click on index.html chevron to expand
    const chevrons = screen.getAllByLabelText('Expand');
    fireEvent.click(chevrons[0]);

    // Now diff content appears
    expect(await screen.findByText('<title>New Clean Diff</title>')).toBeInTheDocument();

    // Click again to collapse
    const collapseChevron = screen.getByLabelText('Collapse');
    fireEvent.click(collapseChevron);
    expect(screen.queryByText('<title>New Clean Diff</title>')).not.toBeInTheDocument();
  });

  it('toggles all diff cards using Expand all files / Collapse all files', async () => {
    render(<DiffsView workspaceId="ws-test" />);

    // Initially all collapsed
    const toggleBtn = screen.getByLabelText('Expand all files');
    expect(toggleBtn).toBeInTheDocument();

    // Click Expand all
    fireEvent.click(toggleBtn);

    // Now diff content for both files is loaded
    const diffTitles = await screen.findAllByText('<title>New Clean Diff</title>');
    expect(diffTitles.length).toBe(2);
    expect(screen.getByLabelText('Collapse all files')).toBeInTheDocument();

    // Click Collapse all
    fireEvent.click(screen.getByLabelText('Collapse all files'));
    expect(screen.queryByText('<title>New Clean Diff</title>')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Expand all files')).toBeInTheDocument();
  });

  it('expands file card when selected from file tree in stream mode', async () => {
    render(<DiffsView workspaceId="ws-test" />);

    // Initially collapsed
    expect(screen.queryByText('<title>New Clean Diff</title>')).not.toBeInTheDocument();

    // In file tree, click on main.ts
    const treeItems = screen.getAllByRole('button', { name: /main\.ts/i });
    fireEvent.click(treeItems[0]);

    // Now diff content for that file is loaded and rendered
    expect(await screen.findByText('<title>New Clean Diff</title>')).toBeInTheDocument();
  });

  it('opens authentic ui-menu overflow dropdown when narrow and handles selection and Escape', () => {
    let resizeCallback: (entries: Array<{ contentRect: { width: number } }>) => void = () => {};
    class MockResizeObserver {
      constructor(cb: (entries: Array<{ contentRect: { width: number } }>) => void) {
        resizeCallback = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver);

    render(<DiffsView workspaceId="ws-test" />);

    // Trigger narrow width (< 500px)
    fireEvent(window, new Event('resize'));
    // Use act to flush state update from ResizeObserver callback
    act(() => {
      resizeCallback([{ contentRect: { width: 380 } }]);
    });

    const moreBtn = screen.getByLabelText(/diff display options/i);
    expect(moreBtn).toBeInTheDocument();

    // Click to open menu
    fireEvent.click(moreBtn);

    const menu = screen.getByRole('menu', { name: /diff display options/i });
    expect(menu).toHaveClass('diffs-overflow-menu');
    expect(screen.getByText('Diff options')).toBeInTheDocument();
    expect(screen.getByText('Focused')).toBeInTheDocument();
    expect(screen.getByText('Stream (All files)')).toBeInTheDocument();
    expect(screen.getByText('Unified (Stacked)')).toBeInTheDocument();
    expect(screen.getByText('Split (Side by side)')).toBeInTheDocument();
    expect(screen.getByText('Wrap lines')).toBeInTheDocument();

    // Verify icons inside menu rows
    const menuRows = menu.querySelectorAll('.ui-menu__row');
    expect(menuRows.length).toBeGreaterThanOrEqual(5);
    menuRows.forEach((row) => {
      expect(row.querySelector('.ui-menu__icon')).toBeInTheDocument();
      expect(row.querySelector('.ui-menu__row-title')).toBeInTheDocument();
    });

    vi.useFakeTimers();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('menu', { name: /diff display options/i })).toHaveClass('diffs-pop-out');
    act(() => {
      vi.advanceTimersByTime(MOTION_EXIT_MS);
    });
    expect(screen.queryByRole('menu', { name: /diff display options/i })).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('renders workspace folder picker and switches workspaces on click', () => {
    const onSelect = vi.fn();
    const workspaces = [
      { id: 'ws-1', name: 'Frontend App', displayName: 'Frontend App' },
      { id: 'ws-2', name: 'Backend API', displayName: 'Backend API' },
    ];

    render(
      <DiffsView
        workspaceId="ws-1"
        workspaces={workspaces}
        onSelectWorkspace={onSelect}
      />
    );

    const folderBtn = screen.getByRole('button', { name: /Folder, Frontend App/i });
    expect(folderBtn).toBeInTheDocument();

    // Click to open menu
    fireEvent.click(folderBtn);
    expect(screen.getByRole('menu', { name: /Select workspace folder/i })).toBeInTheDocument();
    expect(screen.getByText('Backend API')).toBeInTheDocument();

    // Select second workspace
    fireEvent.click(screen.getByText('Backend API'));
    expect(onSelect).toHaveBeenCalledWith('ws-2');
    expect(localStorage.getItem('kite.selectedWorkspaceId')).toBe('ws-2');
  });

  it('auto-selects first workspace when workspaceId is null', () => {
    const onSelect = vi.fn();
    const workspaces = [
      { id: 'ws-auto', name: 'Auto Project', displayName: 'Auto Project' },
    ];

    render(
      <DiffsView
        workspaceId={null}
        workspaces={workspaces}
        onSelectWorkspace={onSelect}
      />
    );

    expect(onSelect).toHaveBeenCalledWith('ws-auto');
    expect(screen.getByText('Auto Project')).toBeInTheDocument();
  });
});

describe('DiffCodeViewer Component Tests', () => {
  it('renders meaningful lines without raw git meta headers', () => {
    const { container } = render(
      <DiffCodeViewer diff={mockFileDiff} layout="unified" wordWrap={true} />
    );

    // Meta header shouldn't be rendered as code row
    expect(container.textContent).not.toContain('diff --git');
    // Code lines should be rendered
    expect(container.textContent).toContain('<title>Old</title>');
    expect(container.textContent).toContain('<title>New Clean Diff</title>');
  });

  it('renders split side-by-side mode properly paired', () => {
    const { container } = render(
      <DiffCodeViewer diff={mockFileDiff} layout="split" wordWrap={false} />
    );

    expect(container.querySelector('.diff-split-table')).toBeInTheDocument();
    expect(container.textContent).toContain('<title>Old</title>');
    expect(container.textContent).toContain('<title>New Clean Diff</title>');
  });
});
