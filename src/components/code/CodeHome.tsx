import React from 'react';
import { FolderPlusIcon, PlusIcon } from './codeIcons';

export interface CodeHomeProps {
  onAddWorkspace: () => void;
  isAdding?: boolean;
}

export const CodeHome: React.FC<CodeHomeProps> = ({ onAddWorkspace, isAdding = false }) => {
  return (
    <section className="empty-surface pane empty-roster-surface">
      <span aria-hidden="true" className="empty-surface__icon">
        <FolderPlusIcon size={30} />
      </span>
      <div className="empty-surface__copy">
        <h1>No workspaces yet</h1>
        <p>A workspace is a folder on this PC — agents launch inside it.</p>
      </div>
      <div className="empty-surface__action">
        <button
          className="primary-button"
          onClick={onAddWorkspace}
          disabled={isAdding}
          type="button"
        >
          <PlusIcon size={14} />
          {isAdding ? 'Opening picker…' : 'Add Workspace'}
        </button>
      </div>
    </section>
  );
};
