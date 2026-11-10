import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChangedFilesCard } from './ChangedFilesCard';

describe('ChangedFilesCard', () => {
  it('shows the file count, totals, and opens the turn diff', () => {
    const onOpenTurnDiff = vi.fn();
    render(
      <ChangedFilesCard
        files={[
          { path: 'src-tauri/src/chat/normalize.rs', additions: 18, deletions: 3 },
          { path: 'src/main.rs', additions: 1, deletions: 1 },
        ]}
        onOpenTurnDiff={onOpenTurnDiff}
      />
    );
    expect(screen.getByText('2 changed files')).toBeInTheDocument();
    expect(screen.getByText('+19')).toBeInTheDocument();
    expect(screen.getByText('-4')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open diff' }));
    expect(onOpenTurnDiff).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse folders' }));
    expect(screen.queryByText('src/main.rs')).not.toBeInTheDocument();
  });
});
