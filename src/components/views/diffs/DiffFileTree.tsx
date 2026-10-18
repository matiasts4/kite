import React, { useState, useMemo } from 'react';
import type { GitFileChange } from '../files/gitTypes';
import { STATUS_LETTERS, splitPath } from '../files/gitTypes';

export interface DiffFileTreeProps {
  files: GitFileChange[];
  activePath: string | null;
  onSelectFile: (path: string) => void;
}

export const DiffFileTree: React.FC<DiffFileTreeProps> = ({
  files,
  activePath,
  onSelectFile,
}) => {
  const [search, setSearch] = useState('');

  const filteredFiles = useMemo(() => {
    if (!search.trim()) return files;
    const query = search.toLowerCase();
    return files.filter((f) => f.path.toLowerCase().includes(query));
  }, [files, search]);

  return (
    <aside className="diffs-file-tree" aria-label="Modified files navigation">
      <div className="diffs-file-tree-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary, #94a3b8)' }}>
          <span>Files</span>
          <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '10.5px' }}>
            {filteredFiles.length} of {files.length}
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

      <ul className="diffs-tree-list">
        {filteredFiles.map((file) => {
          const { name, directory } = splitPath(file.path);
          const letter = STATUS_LETTERS[file.status] || 'M';
          const isSelected = activePath === file.path;

          return (
            <li key={file.path}>
              <button
                type="button"
                className={`diffs-tree-item ${isSelected ? 'selected' : ''}`}
                onClick={() => onSelectFile(file.path)}
                title={file.path}
              >
                <span
                  className={`diff-status-pill ${file.status}`}
                  style={{ width: '15px', height: '15px', fontSize: '9px' }}
                >
                  {letter}
                </span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {directory ? (
                    <span style={{ color: 'var(--text-secondary, #64748b)', marginRight: '4px' }}>
                      {directory}/
                    </span>
                  ) : null}
                  <span style={{ fontWeight: isSelected ? 600 : 400 }}>{name}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
};
