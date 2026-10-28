import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

  it('triggers onOpenDefaultApp when double-clicking a file', () => {
    const folderChildren = new Map<string, FilesEntry[]>([
      [
        'root',
        [
          { entryId: 'f-video', displayName: 'demo.mp4', kind: 'file' },
        ],
      ],
    ]);

    const onOpenDefaultApp = vi.fn();

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
        onOpenDefaultApp={onOpenDefaultApp}
      />
    );

    const fileBtn = screen.getByText('demo.mp4').closest('button')!;
    fireEvent.doubleClick(fileBtn);

    expect(onOpenDefaultApp).toHaveBeenCalledWith('demo.mp4');
  });

  it('opens context menu on right click with Reveal in File Explorer and Open with Default App', () => {
    const folderChildren = new Map<string, FilesEntry[]>([
      [
        'root',
        [
          { entryId: 'f-video', displayName: 'presentation.mov', kind: 'file' },
        ],
      ],
    ]);

    const onRevealFile = vi.fn();
    const onOpenDefaultApp = vi.fn();

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
        onRevealFile={onRevealFile}
        onOpenDefaultApp={onOpenDefaultApp}
      />
    );

    const fileBtn = screen.getByText('presentation.mov').closest('button')!;
    fireEvent.contextMenu(fileBtn, { clientX: 100, clientY: 200 });

    // Menu header should show file name and subtitle
    expect(screen.getAllByText('presentation.mov').length).toBeGreaterThanOrEqual(2);

    // Menu options
    const revealOption = screen.getByText(/reveal in file explorer|reveal in finder|open in file manager/i);
    expect(revealOption).toBeInTheDocument();
    fireEvent.click(revealOption);
    expect(onRevealFile).toHaveBeenCalledWith('presentation.mov');

    // Reopen menu to test Open with Default App
    fireEvent.contextMenu(fileBtn, { clientX: 100, clientY: 200 });
    const openDefaultAppOption = screen.getByText('Open with Default App');
    expect(openDefaultAppOption).toBeInTheDocument();
    fireEvent.click(openDefaultAppOption);
    expect(onOpenDefaultApp).toHaveBeenCalledWith('presentation.mov');
  });
});
