import React from 'react';
import { CheckIcon, AlertCircleIcon, CloseIcon } from '../files/FileIcons';
import { SpinnerIcon } from '../chat/ChatIcons';

export interface DiffsCommitBarProps {
  commitDraft: string;
  setCommitDraft: (val: string) => void;
  gitBusy: string | null;
  canCommit: boolean;
  hasNoStaged: boolean;
  onCommitSubmit: () => void;
  onCommitKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  unstagedCount: number;
  stagedCount: number;
  totalFilesCount: number;
  onStageAll: () => void | Promise<void>;
  onUnstageAll: () => void | Promise<void>;
  gitWriteError: string | null;
  onDismissWriteError: () => void;
}

export const DiffsCommitBar: React.FC<DiffsCommitBarProps> = ({
  commitDraft,
  setCommitDraft,
  gitBusy,
  canCommit,
  hasNoStaged,
  onCommitSubmit,
  onCommitKeyDown,
  unstagedCount,
  stagedCount,
  totalFilesCount,
  onStageAll,
  onUnstageAll,
  gitWriteError,
  onDismissWriteError,
}) => {
  return (
    <section className="diffs-commit-bar" aria-label="Git commit">
      <div className="diffs-commit-input-row">
        <textarea
          className="diffs-commit-textarea"
          placeholder="Commit message (Ctrl+Enter to commit)"
          value={commitDraft}
          disabled={gitBusy !== null}
          onChange={(e) => setCommitDraft(e.target.value)}
          onKeyDown={onCommitKeyDown}
          rows={2}
          aria-label="Commit message"
        />
        <button
          type="button"
          className="primary-button diffs-commit-btn"
          disabled={!canCommit}
          onClick={onCommitSubmit}
          title={
            hasNoStaged
              ? 'Stage all changes and commit (Ctrl+Enter)'
              : 'Commit staged changes (Ctrl+Enter)'
          }
        >
          <CheckIcon size={12} />
          <span>{hasNoStaged ? 'Commit All' : 'Commit'}</span>
        </button>
      </div>

      <div className="diffs-commit-subbar">
        <div className="diffs-staging-actions">
          <button
            type="button"
            className="diffs-text-btn"
            disabled={gitBusy !== null || unstagedCount === 0}
            onClick={() => void onStageAll()}
          >
            Stage all
          </button>
          <span style={{ opacity: 0.3 }}>•</span>
          <button
            type="button"
            className="diffs-text-btn"
            disabled={gitBusy !== null || stagedCount === 0}
            onClick={() => void onUnstageAll()}
          >
            Unstage all
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {gitBusy && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', color: 'var(--accent, #818cf8)' }}>
              <SpinnerIcon size={12} />
              <span>{gitBusy}</span>
            </span>
          )}
          <span>
            {totalFilesCount} changed {totalFilesCount === 1 ? 'file' : 'files'}
          </span>
        </div>
      </div>

      {/* Write Error Banner */}
      {gitWriteError && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '6px 10px',
            borderRadius: 'var(--vl-radius-xs, 4px)',
            background: 'rgba(244, 63, 94, 0.15)',
            border: '1px solid rgba(244, 63, 94, 0.3)',
            color: '#fecdd3',
            fontSize: '11px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <AlertCircleIcon size={13} />
            <span>{gitWriteError}</span>
          </div>
          <button
            type="button"
            className="diffs-text-btn"
            onClick={onDismissWriteError}
            aria-label="Dismiss error"
          >
            <CloseIcon size={10} />
          </button>
        </div>
      )}
    </section>
  );
};
