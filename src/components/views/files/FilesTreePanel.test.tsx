import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FilesTreePanel } from './FilesTreePanel';
import type { FilesEntry } from '../../../types';

describe('FilesTreePanel Tests', () => {
  const rootEntry: FilesEntry = {
    entryId: 'root',
    displayName: 'my-project',
    kind: 'directory',
  };

  it('renders root children and subfolders properly', () => {
    const folderChildren = new Map<string, FilesEntry[]>([
      [
        'root',
        [
          { entryId: 'f-1', displayName: 'src', kind: 'directory' },
          { entryId: 'f-2', displayName: 'README.md', kind: 'file', byteSize: 120 },
        ],
      ],
    ]);

    render(
      <FilesTreePanel
        rootEntry={rootEntry}
        folderChildren={folderChildren}
        expandedFolders={new Set(['root'])}
        loadingFolders={new Set()}
        activeFileId={null}
        currentWsId="ws-1"
        resourceId="res-1"
        loading={false}
        treeWidth={240}
        onToggleFolder={vi.fn()}
        onOpenFile={vi.fn()}
        onSplitterPointerDown={vi.fn()}
      />
    );

    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });

  it('safely handles recursive/cyclic folder structures without exceeding call stack', () => {
    // Simulate a cyclic bug where folder-1 has folder-1 as a child and is expanded
    const folderChildren = new Map<string, FilesEntry[]>([
      [
        'root',
        [
          { entryId: 'cycle-folder', displayName: 'cyclic', kind: 'directory' },
        ],
      ],
      [
        'cycle-folder',
        [
          { entryId: 'cycle-folder', displayName: 'cyclic', kind: 'directory' },
          { entryId: 'root', displayName: 'my-project', kind: 'directory' },
        ],
      ],
    ]);

    expect(() => {
      render(
        <FilesTreePanel
          rootEntry={rootEntry}
          folderChildren={folderChildren}
          expandedFolders={new Set(['root', 'cycle-folder'])}
          loadingFolders={new Set()}
          activeFileId={null}
          currentWsId="ws-1"
          resourceId="res-1"
          loading={false}
          treeWidth={240}
          onToggleFolder={vi.fn()}
          onOpenFile={vi.fn()}
          onSplitterPointerDown={vi.fn()}
        />
      );
    }).not.toThrow();

    expect(screen.getAllByText('cyclic').length).toBeGreaterThanOrEqual(1);
  });
});
