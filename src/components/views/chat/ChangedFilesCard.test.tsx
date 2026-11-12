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

  it('strips workspace root paths to repo-relative labels and opens single-file diff', () => {
    const onOpenFile = vi.fn();
    render(
      <ChangedFilesCard
        workspaceName="kite"
        files={[
          { path: 'C:\\Users\\PC\\Desktop\\Proyectos\\kite\\README.md', additions: 2, deletions: 2 },
        ]}
        onOpenFile={onOpenFile}
      />
    );

    const fileBtn = screen.getByRole('button', { name: /README\.md/i });
    expect(screen.getByText('README.md')).toBeInTheDocument();
    expect(screen.queryByText(/Proyectos\/kite/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Collapse folders' })).not.toBeInTheDocument();
    expect(screen.getAllByText('+2')).toHaveLength(2);
    expect(screen.getAllByText('-2')).toHaveLength(2);

    fireEvent.click(fileBtn);
    expect(onOpenFile).toHaveBeenCalledWith('C:\\Users\\PC\\Desktop\\Proyectos\\kite\\README.md');
  });
});
