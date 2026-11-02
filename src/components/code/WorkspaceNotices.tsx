import React from 'react';
import { CloseIcon } from './codeIcons';

export interface WorkspaceNoticesProps {
  operationError: string | null;
  persistenceWarning: string | null;
  failedSaveAttempts: number;
  onDismissError: () => void;
  onRetrySave: () => void;
}

export const WorkspaceNotices: React.FC<WorkspaceNoticesProps> = ({
  operationError,
  persistenceWarning,
  failedSaveAttempts,
  onDismissError,
  onRetrySave,
}) => {
  if (!operationError && !persistenceWarning) return null;

  return (
    <section className="workspace-notices" aria-label="Workspace notices">
      {operationError ? (
        <div className="workspace-notice workspace-notice--error" role="alert">
          <span>{operationError}</span>
          <button
            type="button"
            aria-label="Dismiss pane error"
            onClick={onDismissError}
          >
            <CloseIcon size={11} />
          </button>
        </div>
      ) : null}
      {persistenceWarning ? (
        <div className="workspace-notice workspace-notice--error" role="alert">
          <span>
            {persistenceWarning}
            {failedSaveAttempts > 1 ? (
              <small className="workspace-notice__attempts"> Retry {failedSaveAttempts - 1} also failed.</small>
            ) : null}
          </span>
          <button
            type="button"
            onClick={onRetrySave}
          >
            Retry save
          </button>
        </div>
      ) : null}
    </section>
  );
};
