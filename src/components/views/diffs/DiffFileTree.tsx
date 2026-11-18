import React, { useState, useMemo, useCallback } from 'react';
import type { DiffLineStat } from '../../../lib/diffs/diffRendering';
import type { GitFileChange } from '../files/gitTypes';
import { STATUS_LETTERS } from '../files/gitTypes';
import {
  ChevronDownIcon,
  FolderIcon,
  FolderOpenIcon,
} from '../files/FileIcons';
import { DiffStatBadge } from '../../diffs/DiffStatBadge';
import { buildDiffFileTree, type DiffTreeNode } from './diffFileTree.logic';

export interface DiffFileTreeProps {
  files: GitFileChange[];
  activePath: string | null;
  onSelectFile: (path: string) => void;
  fileStats?: ReadonlyMap<string, DiffLineStat>;
}

export const DiffFileTree: React.FC<DiffFileTreeProps> = ({
  files,
  activePath,
  onSelectFile,
  fileStats,
}) => {
  const [search, setSearch] = useState('');
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());

  const treeNodes = useMemo(() => buildDiffFileTree(files, search), [files, search]);

  const filteredCount = useMemo(() => {
    if (!search.trim()) return files.length;
    const query = search.trim().toLowerCase();
    return files.filter((f) => f.path.toLowerCase().includes(query)).length;
  }, [files, search]);

  const toggleFolder = useCallback((folderPath: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      return next;
    });
  }, []);

  const renderNodes = (nodes: DiffTreeNode[], depth: number): React.ReactNode => {
    return nodes.map((node) => {
      const indentPx = 8 + depth * 12;

      if (node.kind === 'folder') {
        const isCollapsed = !search.trim() && collapsedFolders.has(node.path);
        return (
          <li key={node.id} className="diffs-tree-folder">
            <button
              type="button"
              className="diffs-tree-folder-btn"
              style={{ paddingLeft: `${indentPx}px` }}
              onClick={() => toggleFolder(node.path)}
              aria-expanded={!isCollapsed}
              title={`${node.path} (${node.fileCount} ${node.fileCount === 1 ? 'file' : 'files'})`}
            >
              <span
                className={`diffs-tree-folder-chevron ${isCollapsed ? 'collapsed' : ''}`}
                aria-hidden="true"
              >
                <ChevronDownIcon size={10} />
              </span>
              {isCollapsed ? <FolderIcon size={12} /> : <FolderOpenIcon size={12} />}
              <span className="diffs-tree-folder-label">{node.name}</span>
            </button>
            {!isCollapsed && (
              <ul className="diffs-tree-list" style={{ padding: 0, overflow: 'visible' }}>
                {renderNodes(node.children, depth + 1)}
              </ul>
            )}
          </li>
        );
      }

      const { file } = node;
      const letter = STATUS_LETTERS[file.status] || 'M';
      const isSelected = activePath === file.path;
      const stat = fileStats?.get(file.path);

      return (
        <li key={node.id}>
          <button
            type="button"
            className={`diffs-tree-item ${isSelected ? 'selected' : ''}`}
            style={{ paddingLeft: `${indentPx}px` }}
            onClick={() => onSelectFile(file.path)}
            title={file.path}
          >
            <span
              className={`diff-status-pill ${file.status}`}
              style={{ width: '15px', height: '15px', fontSize: '9px' }}
            >
              {letter}
            </span>
            <span
              className="diffs-tree-file-name"
              style={{ fontWeight: isSelected ? 600 : 400 }}
            >
              {node.name}
            </span>
            {stat && (
              <DiffStatBadge additions={stat.additions} deletions={stat.deletions} compact />
            )}
            {file.staged && (
              <span className="diffs-tree-staged-dot" title="Staged" aria-label="Staged" />
            )}
          </button>
        </li>
      );
    });
  };

  return (
    <aside className="diffs-file-tree" aria-label="Modified files navigation">
      <div className="diffs-file-tree-header">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: '11px',
            fontWeight: 600,
            color: 'var(--text-secondary, #94a3b8)',
          }}
        >
          <span>Files</span>
          <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '10.5px' }}>
            {filteredCount} of {files.length}
          </span>
        </div>
        <input
          type="text"
          className="diffs-tree-search"
          placeholder="Filter files…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Filter files"
        />
      </div>

      <ul className="diffs-tree-list scroll-quiet">{renderNodes(treeNodes, 0)}</ul>
    </aside>
  );
};
