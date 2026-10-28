import React, { useMemo, useRef, useState, useEffect } from 'react';
import type { FilesEntry } from '../../../types';
import {
  FolderIcon,
  FolderOpenIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  getFileIcon,
  FolderSearchIcon,
  ExternalLinkIcon,
  CopyIcon,
} from './FileIcons';
import { SidebarContextMenu } from '../../sidebar/SidebarFooter';
import type { ContextMenuState, MenuItem } from '../../sidebar/types';
import { getRevealTitle } from './CodeEditorPane';

export interface FlatTreeItem {
  entry: FilesEntry;
  depth: number;
  currentPath: string;
  parentId: string | null;
  isExpanded: boolean;
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface FilesTreePanelProps {
  rootEntry: FilesEntry | null;
  folderChildren: Map<string, FilesEntry[]>;
  expandedFolders: Set<string>;
  loadingFolders: Set<string>;
  activeFileId: string | null;
  currentWsId: string | null;
  resourceId: string | null;
  loading: boolean;
  treeWidth: number;
  onToggleFolder: (folderEntryId: string, folderRelativePath: string) => void;
  onOpenFile: (entry: FilesEntry, parentPath?: string) => void;
  onSplitterPointerDown: (e: React.PointerEvent) => void;
  onRevealFile?: (relativePath: string) => void;
  onOpenDefaultApp?: (relativePath: string) => void;
}

export const FilesTreePanel: React.FC<FilesTreePanelProps> = ({
  rootEntry,
  folderChildren,
  expandedFolders,
  loadingFolders,
  activeFileId,
  currentWsId,
  resourceId,
  loading,
  treeWidth,
  onToggleFolder,
  onOpenFile,
  onSplitterPointerDown,
  onRevealFile,
  onOpenDefaultApp,
}) => {
  const treeButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  useEffect(() => {
    if (!contextMenu) return;

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.ui-menu')) return;
      setContextMenu(null);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null);
      }
    };

    const handleResize = () => {
      setContextMenu(null);
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
    };
  }, [contextMenu]);

  const handleContextMenu = (e: React.MouseEvent, entry: FilesEntry, relativePath: string) => {
    const isDir = entry.kind === 'directory';
    const revealTitle = getRevealTitle();

    const primaryActions: MenuItem[] = [
      {
        id: 'reveal-in-explorer',
        title: revealTitle,
        icon: <FolderSearchIcon size={14} />,
        action: () => {
          onRevealFile?.(relativePath);
        },
      },
    ];

    if (!isDir) {
      primaryActions.push({
        id: 'open-default-app',
        title: 'Open with Default App',
        icon: <ExternalLinkIcon size={14} />,
        action: () => {
          onOpenDefaultApp?.(relativePath);
        },
      });
    }

    const secondaryActions: MenuItem[] = [
      {
        id: 'copy-relative-path',
        title: 'Copy Relative Path',
        icon: <CopyIcon size={14} />,
        action: () => {
          void navigator.clipboard?.writeText(relativePath);
        },
      },
    ];

    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      header: {
        title: entry.displayName,
        subtitle: relativePath,
      },
      sections: [primaryActions, secondaryActions],
      targetId: entry.entryId,
    });
  };

  // Flattened Tree Items for Keyboard Navigation
  const flatVisibleItems: FlatTreeItem[] = useMemo(() => {
    if (!rootEntry) return [];
    const items: FlatTreeItem[] = [];

    const visited = new Set<string>();
    const traverse = (parentId: string, depth: number, currentPath: string) => {
      if (visited.has(parentId) || depth > 40) return;
      visited.add(parentId);
      const children = folderChildren.get(parentId);
      if (!children) return;

      for (const child of children) {
        if (child.entryId === parentId) continue;
        const isDir = child.kind === 'directory';
        const isExpanded = expandedFolders.has(child.entryId);
        const childPath = currentPath ? `${currentPath}/${child.displayName}` : child.displayName;

        items.push({
          entry: child,
          depth,
          currentPath: childPath,
          parentId,
          isExpanded,
        });

        if (isDir && isExpanded && !visited.has(child.entryId)) {
          traverse(child.entryId, depth + 1, childPath);
        }
      }
    };

    traverse(rootEntry.entryId, 0, '');
    return items;
  }, [rootEntry, folderChildren, expandedFolders]);

  const handleTreeKeyDown = (e: React.KeyboardEvent, item: FlatTreeItem) => {
    const idx = flatVisibleItems.findIndex((x) => x.entry.entryId === item.entry.entryId);
    if (idx < 0) return;
    const isDir = item.entry.kind === 'directory';

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        const nextItem = flatVisibleItems[Math.min(idx + 1, flatVisibleItems.length - 1)];
        if (nextItem) {
          treeButtonRefs.current.get(nextItem.entry.entryId)?.focus();
        }
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const prevItem = flatVisibleItems[Math.max(idx - 1, 0)];
        if (prevItem) {
          treeButtonRefs.current.get(prevItem.entry.entryId)?.focus();
        }
        break;
      }
      case 'ArrowRight': {
        if (!isDir) return;
        e.preventDefault();
        if (!item.isExpanded) {
          onToggleFolder(item.entry.entryId, item.currentPath);
        } else {
          const nextItem = flatVisibleItems[idx + 1];
          if (nextItem && nextItem.parentId === item.entry.entryId) {
            treeButtonRefs.current.get(nextItem.entry.entryId)?.focus();
          }
        }
        break;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        if (isDir && item.isExpanded) {
          onToggleFolder(item.entry.entryId, item.currentPath);
        } else if (item.parentId) {
          treeButtonRefs.current.get(item.parentId)?.focus();
        }
        break;
      }
      case 'Enter':
      case ' ': {
        e.preventDefault();
        if (isDir) {
          onToggleFolder(item.entry.entryId, item.currentPath);
        } else {
          onOpenFile(item.entry, item.currentPath);
        }
        break;
      }
      case 'Home': {
        e.preventDefault();
        const first = flatVisibleItems[0];
        if (first) {
          treeButtonRefs.current.get(first.entry.entryId)?.focus();
        }
        break;
      }
      case 'End': {
        e.preventDefault();
        const last = flatVisibleItems[flatVisibleItems.length - 1];
        if (last) {
          treeButtonRefs.current.get(last.entry.entryId)?.focus();
        }
        break;
      }
    }
  };

  const renderTreeEntries = (
    parentId: string,
    depth = 0,
    currentPath = '',
    ancestors = new Set<string>()
  ): React.ReactNode => {
    if (ancestors.has(parentId) || depth > 40) {
      return null;
    }
    const currentAncestors = new Set(ancestors).add(parentId);
    const entries = folderChildren.get(parentId);

    if (!entries) {
      if (loadingFolders.has(parentId)) {
        return (
          <div
            className="files-tree-notice"
            style={{ paddingLeft: `${depth * 14 + 20}px` }}
          >
            Reading…
          </div>
        );
      }
      return null;
    }

    if (entries.length === 0) {
      return (
        <div
          className="files-tree-notice"
          style={{ paddingLeft: `${depth * 14 + 20}px` }}
        >
          Empty
        </div>
      );
    }

    return entries.map((entry) => {
      const isDir = entry.kind === 'directory';
      const isExpanded = expandedFolders.has(entry.entryId);
      const isSelected = activeFileId === entry.entryId;
      const pathForEntry = currentPath ? `${currentPath}/${entry.displayName}` : entry.displayName;

      const flatItem: FlatTreeItem = {
        entry,
        depth,
        currentPath: pathForEntry,
        parentId,
        isExpanded,
      };

      return (
        <React.Fragment key={entry.entryId}>
          <button
            type="button"
            ref={(el) => {
              if (el) treeButtonRefs.current.set(entry.entryId, el);
              else treeButtonRefs.current.delete(entry.entryId);
            }}
            draggable={!isDir}
            className={`files-tree-row${isSelected ? ' active' : ''}`}
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
            onKeyDown={(e) => handleTreeKeyDown(e, flatItem)}
            onDragStart={(event) => {
              if (isDir || !currentWsId || !resourceId) return;
              event.dataTransfer.setData(
                'application/x-kite-files-entry',
                JSON.stringify({ workspaceId: currentWsId, resourceId, entryId: entry.entryId })
              );
              event.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => {
              if (isDir) {
                onToggleFolder(entry.entryId, pathForEntry);
              } else {
                onOpenFile(entry, currentPath);
              }
            }}
            onDoubleClick={(e) => {
              e.preventDefault();
              if (!isDir && onOpenDefaultApp) {
                onOpenDefaultApp(pathForEntry);
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleContextMenu(e, entry, pathForEntry);
            }}
            title={
              entry.byteSize !== undefined
                ? `${entry.displayName} · ${formatBytes(entry.byteSize)}`
                : entry.displayName
            }
          >
            <span aria-hidden="true" className="files-tree-chevron">
              {isDir ? (
                isExpanded ? (
                  <ChevronDownIcon size={11} />
                ) : (
                  <ChevronRightIcon size={11} />
                )
              ) : null}
            </span>
            <span aria-hidden="true" className="files-tree-icon">
              {isDir ? (
                isExpanded ? (
                  <FolderOpenIcon size={13} className="files-tree-icon-folder" />
                ) : (
                  <FolderIcon size={13} className="files-tree-icon-folder" />
                )
              ) : (
                getFileIcon(entry.displayName, 13)
              )}
            </span>
            <span className="files-tree-name">{entry.displayName}</span>
            {entry.byteSize !== undefined && (
              <span className="files-tree-size">
                {formatBytes(entry.byteSize)}
              </span>
            )}
          </button>
          {isDir && isExpanded && entry.entryId !== parentId && !currentAncestors.has(entry.entryId) && (
            renderTreeEntries(entry.entryId, depth + 1, pathForEntry, currentAncestors)
          )}
        </React.Fragment>
      );
    });
  };

  return (
    <>
      <section
        aria-label={`${rootEntry?.displayName || 'Workspace'} files`}
        className="files-tree-panel scroll-quiet"
        style={{ width: `${treeWidth}px`, minWidth: '150px' }}
      >
        <div
          className="files-tree"
          role="tree"
          aria-label="Files and folders"
          tabIndex={0}
        >
          {rootEntry ? (
            renderTreeEntries(rootEntry.entryId, 0)
          ) : loading ? (
            <div className="files-tree-notice">Loading workspace…</div>
          ) : (
            <div className="files-tree-notice">No files available</div>
          )}
        </div>
      </section>

      {/* Draggable Splitter */}
      <div
        className="files-splitter"
        onPointerDown={onSplitterPointerDown}
      />

      <SidebarContextMenu
        contextMenu={contextMenu}
        onClose={() => setContextMenu(null)}
      />
    </>
  );
};
