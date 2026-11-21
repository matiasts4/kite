import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    expect(screen.queryByText('src/main.rs')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand changed files' }));
    expect(screen.getByText('src/main.rs')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse changed files' }));
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

    expect(screen.queryByText('README.md')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand changed files' }));
    const fileBtn = screen.getByRole('button', { name: /README\.md/i });
    expect(screen.getByText('README.md')).toBeInTheDocument();
    expect(screen.queryByText(/Proyectos\/kite/)).not.toBeInTheDocument();
    expect(screen.getAllByText('+2')).toHaveLength(2);
    expect(screen.getAllByText('-2')).toHaveLength(2);

    fireEvent.click(fileBtn);
    expect(onOpenFile).toHaveBeenCalledWith('C:\\Users\\PC\\Desktop\\Proyectos\\kite\\README.md');
  });

  it('supports flush composer-top variant that expands the file list upward above the anchored header', async () => {
    const onOpenTurnDiff = vi.fn();
    const onOpenFile = vi.fn();
    const { container } = render(
      <ChangedFilesCard
        variant="composer-top"
        workspaceName="kite"
        files={[
          { path: 'src/a.ts', additions: 4, deletions: 1 },
          { path: 'src/b.ts', additions: 2, deletions: 0 },
        ]}
        onOpenTurnDiff={onOpenTurnDiff}
        onOpenFile={onOpenFile}
      />
    );

    const strip = container.querySelector('[data-slot="composer-top-strip"]');
    expect(strip).not.toBeNull();
    expect(strip?.className).toContain('kite-composer-top-strip');
    expect(screen.getByText('2 changed files')).toBeInTheDocument();
    expect(screen.queryByText('src/a.ts')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand changed files' }));
    const fileItem = screen.getByText('src/a.ts');
    const header = strip?.querySelector('.changed-files-card__header');
    expect(fileItem).toBeInTheDocument();
    expect(header).not.toBeNull();
    // Upward expansion places the file list before the anchored header bar
    expect(fileItem.compareDocumentPosition(header!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    fireEvent.click(screen.getByRole('button', { name: /src\/a\.ts/i }));
    expect(onOpenFile).toHaveBeenCalledWith('src/a.ts');
    fireEvent.click(screen.getByRole('button', { name: 'Open diff' }));
    expect(onOpenTurnDiff).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse changed files' }));
    await waitFor(() => {
      expect(screen.queryByText('src/a.ts')).not.toBeInTheDocument();
    });
  });
});
