import React, { useState, useMemo } from 'react';
import type {
  GitFileChange,
  WorkspaceChanges,
} from './gitTypes';
import {
  STATUS_LETTERS,
  STATUS_LABELS,
  splitPath,
} from './gitTypes';
import {
  CheckIcon,
  AlertCircleIcon,
  FileTextIcon,
  CloseIcon,
  PlusIcon,
  MinusIcon,
  Undo2Icon,
} from './FileIcons';
import { UnifiedDiffView } from '../chat/UnifiedDiffView';
import { SpinnerIcon } from '../chat/ChatIcons';
import type { DiffData } from '../chat/types';

export interface ChangesViewProps {
  workspaceName?: string;
  changes: WorkspaceChanges | null;
  loading: boolean;
  error: string | null;
  selectedPath: string | null;
  diff: DiffData | null;
  diffLoading: boolean;
  diffError: string | null;
  busy: string | null;
  writeError: string | null;
  commitDraft: string;
  onCommitDraftChange: (draft: string) => void;
  onSelectPath: (path: string) => void;
  onOpenPreview: (path: string) => void;
  onToggleStage: (file: GitFileChange, isStaged: boolean) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onDiscardChanges: (file: GitFileChange) => void;
  onCommit: (message: string, stageAll: boolean) => void;
  onClearWriteError: () => void;
}

export const ChangesView: React.FC<ChangesViewProps> = ({
  workspaceName = 'Workspace',
  changes,
  loading,
  error,
  selectedPath,
  diff,
  diffLoading,
  diffError,
  busy,
  writeError,
  commitDraft,
  onCommitDraftChange,
  onSelectPath,
  onOpenPreview,
  onToggleStage,
  onStageAll,
  onUnstageAll,
  onDiscardChanges,
  onCommit,
  onClearWriteError,
}) => {
  const [discardCandidate, setDiscardCandidate] = useState<GitFileChange | null>(null);

  const { staged, unstaged, hasNoStaged } = useMemo(() => {
    if (!changes || !changes.files) {
      return { staged: [], unstaged: [], hasNoStaged: true };
    }
    const s = changes.files.filter((f) => f.staged);
    const u = changes.files.filter((f) => f.unstaged);
    return {
      staged: s,
      unstaged: u,
      hasNoStaged: s.length === 0,
    };
  }, [changes]);

  const canCommit = Boolean(
    busy === null &&
      commitDraft.trim().length > 0 &&
      changes?.files &&
      changes.files.length > 0
  );

  const handleCommitSubmit = () => {
    if (!canCommit) return;
    onCommit(commitDraft.trim(), hasNoStaged);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleCommitSubmit();
    }
  };

  // 1. Initial Loading State
  if (changes === null && loading) {
    return (
      <div className="_state" role="status">
        <span className="_stateSpinner icon-spin">⌛</span>
        <span className="_stateDesc">Reading git…</span>
      </div>
    );
  }

  // 2. Fatal Read Error
  if (changes === null && error !== null) {
    return (
      <div className="_state" role="alert">
        <AlertCircleIcon size={28} className="_stateIconError" />
        <h3 className="_stateTitle">Changes could not be read</h3>
        <p className="_stateDesc">{error}</p>
      </div>
    );
  }

  // 3. Not a Git Repository
  if (!changes || !changes.isRepo) {
    return (
      <div className="_state">
        <FileTextIcon size={28} className="_stateIconMuted" />
        <h3 className="_stateTitle">Not a git repository</h3>
        <p className="_stateDesc">
          {workspaceName} isn't inside a git repository, so there are no changes to show.
        </p>
      </div>
    );
  }

  // 4. Git Repo with Clean Working Tree
  const isClean = changes.files.length === 0;

  return (
    <div className="_changes">
      {/* Commit Box */}
      <div className="_commitBox">
        <textarea
          aria-label="Commit message"
          className="_commitMessage commit-message"
          disabled={busy !== null}
          onChange={(e) => onCommitDraftChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Commit message (Ctrl+Enter to commit)"
          rows={2}
          value={commitDraft}
        />
        <div className="_commitActions">
          <button
            type="button"
            className="files-save-btn files-toolbar-btn"
            disabled={!canCommit}
            onClick={handleCommitSubmit}
            title={
              hasNoStaged
                ? 'Stage every change in this folder and commit (Ctrl+Enter)'
                : 'Commit the staged changes (Ctrl+Enter)'
            }
          >
            <CheckIcon size={12} />
            <span>{hasNoStaged ? 'Commit All' : 'Commit'}</span>
          </button>
          <button
            type="button"
            className="files-toolbar-btn"
            style={{ marginLeft: 'auto', fontSize: '11px' }}
            onClick={() => {
              window.dispatchEvent(new CustomEvent('kite:open-right-dock-diffs'));
            }}
            title="Abrir en pestaña Diffs de pantalla completa"
          >
            Abrir en Diffs ↗
          </button>
          {busy !== null && (
            <span className="_busy" role="status">
              <SpinnerIcon size={12} />
              <span>{busy}</span>
            </span>
          )}
        </div>
      </div>

      {/* Problem Alert Banner */}
      {writeError && (
        <div className="_problem" role="alert">
          <AlertCircleIcon size={13} />
          <span>{writeError}</span>
          <button
            type="button"
            className="_problemDismiss"
            onClick={onClearWriteError}
            aria-label="Dismiss"
          >
            <CloseIcon size={10} />
          </button>
        </div>
      )}

      {/* Clean Tree Notification */}
      {isClean ? (
        <div className="_state">
          <CheckIcon size={28} className="_stateIconSuccess" />
          <h3 className="_stateTitle">No changes</h3>
          <p className="_stateDesc">The working tree is clean.</p>
        </div>
      ) : (
        <>
          {/* Change List */}
          <div className="_changeList scroll-quiet" data-has-diff={Boolean(selectedPath)}>
            {/* Staged Changes Group */}
            {staged.length > 0 && (
              <section aria-label="Staged Changes" className="_group">
                <header className="_groupHeader">
                  <span className="_groupTitle">STAGED</span>
                  <span className="_groupCount">{staged.length}</span>
                  <button
                    type="button"
                    className="_groupAction"
                    disabled={busy !== null}
                    onClick={onUnstageAll}
                  >
                    Unstage all
                  </button>
                </header>
                <ul className="_rows">
                  {staged.map((file) => (
                    <ChangeRow
                      key={`s:${file.path}`}
                      file={file}
                      isStaged={true}
                      selected={selectedPath === file.path}
                      busy={busy !== null}
                      onSelect={() => onSelectPath(file.path)}
                      onOpen={
                        file.status === 'deleted'
                          ? null
                          : () => onOpenPreview(file.path)
                      }
                      onDiscard={
                        file.status === 'untracked'
                          ? null
                          : () => setDiscardCandidate(file)
                      }
                      onToggleStage={() => onToggleStage(file, true)}
                    />
                  ))}
                </ul>
              </section>
            )}

            {/* Unstaged Changes Group */}
            {unstaged.length > 0 && (
              <section aria-label="Changes" className="_group">
                <header className="_groupHeader">
                  <span className="_groupTitle">CHANGES</span>
                  <span className="_groupCount">{unstaged.length}</span>
                  <button
                    type="button"
                    className="_groupAction"
                    disabled={busy !== null}
                    onClick={onStageAll}
                  >
                    Stage all
                  </button>
                </header>
                <ul className="_rows">
                  {unstaged.map((file) => (
                    <ChangeRow
                      key={`u:${file.path}`}
                      file={file}
                      isStaged={false}
                      selected={selectedPath === file.path}
                      busy={busy !== null}
                      onSelect={() => onSelectPath(file.path)}
                      onOpen={
                        file.status === 'deleted'
                          ? null
                          : () => onOpenPreview(file.path)
                      }
                      onDiscard={
                        file.status === 'untracked'
                          ? null
                          : () => setDiscardCandidate(file)
                      }
                      onToggleStage={() => onToggleStage(file, false)}
                    />
                  ))}
                </ul>
              </section>
            )}
          </div>

          {/* Selected File Diff Section */}
          {selectedPath && (
            <section aria-label={`Diff of ${selectedPath}`} className="_diff scroll-quiet">
              {diffLoading ? (
                <div className="_state" role="status">
                  <SpinnerIcon size={18} />
                  <span className="_stateDesc">Loading diff…</span>
                </div>
              ) : diffError ? (
                <p className="_diffError" role="alert">
                  {diffError}
                </p>
              ) : diff ? (
                <UnifiedDiffView diff={diff} />
              ) : null}
            </section>
          )}
        </>
      )}

      {/* Discard Confirmation Dialog */}
      {discardCandidate && (
        <div
          aria-label="Discard changes"
          aria-modal="true"
          className="_confirm"
          role="alertdialog"
        >
          <p>
            Discard changes to <strong>{splitPath(discardCandidate.path).name}</strong>? Your edits
            are replaced with the staged or committed version.
          </p>
          <div className="_confirmActions">
            <button
              type="button"
              className="files-toolbar-btn"
              onClick={() => setDiscardCandidate(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="files-toolbar-btn _btnDanger"
              onClick={() => {
                const target = discardCandidate;
                setDiscardCandidate(null);
                onDiscardChanges(target);
              }}
            >
              Discard Changes
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

interface ChangeRowProps {
  file: GitFileChange;
  isStaged: boolean;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onOpen: (() => void) | null;
  onDiscard: (() => void) | null;
  onToggleStage: () => void;
}

const ChangeRow: React.FC<ChangeRowProps> = ({
  file,
  isStaged,
  selected,
  busy,
  onSelect,
  onOpen,
  onDiscard,
  onToggleStage,
}) => {
  const { name, directory } = splitPath(file.path);
  const statusLabel = STATUS_LABELS[file.status] || file.status;
  const letter = STATUS_LETTERS[file.status] || 'M';

  return (
    <li className="_changeRow" data-selected={selected}>
      <button
        type="button"
        className="_changeSelect"
        aria-label={`${statusLabel} ${file.path}`}
        aria-pressed={selected}
        onClick={onSelect}
        title={
          file.oldPath
            ? `${statusLabel} from ${file.oldPath}`
            : `${statusLabel} — ${file.path}`
        }
      >
        <span
          aria-hidden="true"
          className="_changeLetter"
          data-git={file.status}
        >
          {letter}
        </span>
        <span className="_changeName">{name}</span>
        {directory ? (
          <span className="_changeDirectory">
            <bdi dir="ltr">{directory}</bdi>
          </span>
        ) : null}
      </button>

      <span className="_changeVerbs">
        {onOpen && (
          <button
            type="button"
            className="_verb"
            aria-label={`Open ${name}`}
            onClick={onOpen}
            title="Open file"
          >
            <FileTextIcon size={12} />
          </button>
        )}

        {onDiscard && (
          <button
            type="button"
            className="_verb"
            data-destructive="true"
            aria-label={`Discard changes to ${name}`}
            disabled={busy}
            onClick={onDiscard}
            title="Discard changes"
          >
            <Undo2Icon size={12} />
          </button>
        )}

        <button
          type="button"
          className="_verb"
          aria-label={`${isStaged ? 'Unstage' : 'Stage'} ${name}`}
          disabled={busy}
          onClick={onToggleStage}
          title={isStaged ? 'Unstage' : 'Stage'}
        >
          {isStaged ? <MinusIcon size={12} /> : <PlusIcon size={12} />}
        </button>
      </span>
    </li>
  );
};
