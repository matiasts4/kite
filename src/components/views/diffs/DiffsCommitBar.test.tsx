import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DiffsCommitBar } from './DiffsCommitBar';

describe('DiffsCommitBar Component', () => {
  it('renders commit textarea and triggers submit on click', () => {
    const handleCommitSubmit = vi.fn();
    const setCommitDraft = vi.fn();
    const handleStageAll = vi.fn();
    const handleUnstageAll = vi.fn();
    const handleDismissWriteError = vi.fn();

    render(
      <DiffsCommitBar
        commitDraft="feat: add cool feature"
        setCommitDraft={setCommitDraft}
        gitBusy={null}
        canCommit={true}
        hasNoStaged={false}
        onCommitSubmit={handleCommitSubmit}
        onCommitKeyDown={vi.fn()}
        unstagedCount={2}
        stagedCount={3}
        totalFilesCount={5}
        onStageAll={handleStageAll}
        onUnstageAll={handleUnstageAll}
        gitWriteError="Failed to lock git repository"
        onDismissWriteError={handleDismissWriteError}
      />
    );

    expect(screen.getByPlaceholderText(/Commit message/i)).toHaveValue('feat: add cool feature');
    const commitBtn = screen.getByRole('button', { name: /^Commit$/i });
    expect(commitBtn).toBeEnabled();
    fireEvent.click(commitBtn);
    expect(handleCommitSubmit).toHaveBeenCalledTimes(1);

    expect(screen.getByText('5 changed files')).toBeInTheDocument();
    expect(screen.getByText('Failed to lock git repository')).toBeInTheDocument();

    const stageAllBtn = screen.getByRole('button', { name: /^Stage all$/i });
    fireEvent.click(stageAllBtn);
    expect(handleStageAll).toHaveBeenCalledTimes(1);
  });
});
