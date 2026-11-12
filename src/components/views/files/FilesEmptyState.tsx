import React from 'react';
import { FolderIcon } from './FileIcons';

export interface FilesEmptyStateProps {
  workspacesList: Array<{ id: string; name: string }>;
  onSelectWorkspace?: (workspaceId: string) => void;
  onSetCurrentWsId: (workspaceId: string) => void;
}

export const FilesEmptyState: React.FC<FilesEmptyStateProps> = ({
  workspacesList,
  onSelectWorkspace,
  onSetCurrentWsId,
}) => {
  return (
    <div className="files-pane files-empty-state">
      <FolderIcon size={36} className="files-empty-icon" />
      <span style={{ fontWeight: 600, fontSize: '13px' }}>Select a workspace to view files</span>
      {workspacesList.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '12px', width: '100%', maxWidth: '240px' }}>
          {workspacesList.map((ws) => (
            <button
              key={ws.id}
              type="button"
              className="diffs-filter-pill active"
              style={{ justifyContent: 'flex-start', padding: '6px 12px', height: 'auto' }}
              onClick={() => {
                try {
                  localStorage.setItem('kite.selectedWorkspaceId', ws.id);
                } catch {}
                onSetCurrentWsId(ws.id);
                onSelectWorkspace?.(ws.id);
              }}
            >
              <FolderIcon size={13} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ws.name}</span>
            </button>
          ))}
        </div>
      ) : (
        <span style={{ fontSize: '11px', color: 'var(--text-secondary, #8b949e)', marginTop: '4px' }}>
          Add a folder in Code mode to start browsing files
        </span>
      )}
    </div>
  );
};
