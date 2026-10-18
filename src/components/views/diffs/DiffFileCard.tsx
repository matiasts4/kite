import React, { useState, useEffect, useMemo } from 'react';
import type { GitFileChange, WorkspaceGitService } from '../files/gitTypes';
import { STATUS_LETTERS, splitPath } from '../files/gitTypes';
import {
  FileTextIcon,
  ChevronDownIcon,
  PlusIcon,
  MinusIcon,
  Undo2Icon,
} from '../files/FileIcons';
import { CopyGlyph, CheckGlyph } from '../../dockIcons';
import { SpinnerIcon } from '../chat/ChatIcons';
import { DiffCodeViewer } from './DiffCodeViewer';
import type { DiffData } from '../chat/types';

export interface DiffFileCardProps {
  file: GitFileChange;
  workspaceId: string;
  gitService: WorkspaceGitService;
  collapsed: boolean;
  layout: 'unified' | 'split';
  wordWrap: boolean;
  busy: boolean;
  onToggleCollapse: () => void;
  onToggleStage: (file: GitFileChange, isStaged: boolean) => void;
  onDiscard: (file: GitFileChange) => void;
  onOpenFile: (filePath: string) => void;
}

export const DiffFileCard = React.memo<DiffFileCardProps>(({
  file,
  workspaceId,
  gitService,
  collapsed,
  layout,
  wordWrap,
  busy,
  onToggleCollapse,
  onToggleStage,
  onDiscard,
  onOpenFile,
}) => {
  const [diff, setDiff] = useState<DiffData | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState<boolean>(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState<boolean>(false);

  const { name, directory } = useMemo(() => splitPath(file.path), [file.path]);
  const letter = STATUS_LETTERS[file.status] || 'M';

  // Fetch file diff when expanded and not yet loaded (lazy loading prevents IPC flooding)
  useEffect(() => {
    if (collapsed) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    gitService
      .readWorkspaceFileDiff(workspaceId, file.path, file.status === 'untracked')
      .then((data) => {
        if (!cancelled) setDiff(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg = String((err as { message?: string })?.message || err || '');
          setError(msg || 'Could not load diff for this file.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId, file.path, file.status, gitService, collapsed]);

  // Calculate additions & deletions
  const stats = useMemo(() => {
    if (!diff || !diff.lines) return { additions: 0, deletions: 0 };
    let add = 0;
    let del = 0;
    for (const l of diff.lines) {
      if (l.kind === 'added') add++;
      if (l.kind === 'removed') del++;
    }
    return { additions: add, deletions: del };
  }, [diff]);

  const handleCopyPath = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(file.path);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  return (
    <article
      id={`diff-file-${encodeURIComponent(file.path)}`}
      className="diff-file-card"
      data-path={file.path}
      data-status={file.status}
    >
      {/* Sticky Header */}
      <header className="diff-file-card-header">
        <div
          className="diff-file-card-title-group"
          onClick={onToggleCollapse}
          title={collapsed ? 'Expand file diff' : 'Collapse file diff'}
        >
          <button
            type="button"
            className={`diff-chevron-btn ${collapsed ? 'collapsed' : ''}`}
            aria-label={collapsed ? 'Expand' : 'Collapse'}
          >
            <ChevronDownIcon size={12} />
          </button>

          <span
            className={`diff-status-pill ${file.status}`}
            title={`Status: ${file.status}`}
          >
            {letter}
          </span>

          <div className="diff-file-path">
            {directory ? (
              <span className="diff-file-dir" dir="rtl">
                <bdi dir="ltr">{directory}/</bdi>
              </span>
            ) : null}
            <span className="diff-file-name">{name}</span>
          </div>

          {/* Copy relative path button */}
          <button
            type="button"
            className="diff-card-btn"
            onClick={handleCopyPath}
            title={isCopied ? 'Path copied!' : 'Copy relative path'}
            aria-label="Copy relative path"
          >
            {isCopied ? <CheckGlyph size={12} /> : <CopyGlyph size={12} />}
          </button>
        </div>

        {/* Right Actions & Stats */}
        <div className="diff-file-card-actions">
          {(stats.additions > 0 || stats.deletions > 0) && (
            <span className="diffs-stat-badge">
              {stats.additions > 0 && (
                <span className="diffs-stat-add">+{stats.additions}</span>
              )}
              {stats.deletions > 0 && (
                <span className="diffs-stat-del">-{stats.deletions}</span>
              )}
            </span>
          )}

          {/* Open in Editor */}
          {file.status !== 'deleted' && (
            <button
              type="button"
              className="diff-card-btn"
              onClick={() => onOpenFile(file.path)}
              title="Open file in editor"
              aria-label="Open file in editor"
            >
              <FileTextIcon size={12} />
            </button>
          )}

          {/* Discard changes */}
          {file.status !== 'untracked' && (
            <button
              type="button"
              className="diff-card-btn danger"
              disabled={busy}
              onClick={() => setShowDiscardConfirm(true)}
              title="Discard changes"
              aria-label="Discard changes"
            >
              <Undo2Icon size={12} />
            </button>
          )}

          {/* Stage / Unstage toggle */}
          <button
            type="button"
            className="diff-card-btn"
            disabled={busy}
            onClick={() => onToggleStage(file, file.staged)}
            title={file.staged ? 'Unstage file' : 'Stage file'}
            aria-label={file.staged ? 'Unstage file' : 'Stage file'}
          >
            {file.staged ? <MinusIcon size={12} /> : <PlusIcon size={12} />}
          </button>
        </div>
      </header>

      {/* Discard Confirmation Inline Alert */}
      {showDiscardConfirm && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            background: 'rgba(244, 63, 94, 0.12)',
            borderBottom: '1px solid rgba(244, 63, 94, 0.25)',
            fontSize: '11.5px',
            color: '#fecdd3',
          }}
        >
          <span>
            Discard changes to <strong>{name}</strong>? Edits will be lost.
          </span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              className="diffs-text-btn"
              onClick={() => setShowDiscardConfirm(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="diffs-text-btn"
              style={{ color: '#f43f5e', fontWeight: 600 }}
              onClick={() => {
                setShowDiscardConfirm(false);
                onDiscard(file);
              }}
            >
              Confirm Discard
            </button>
          </div>
        </div>
      )}

      {/* Body / Code Content (rendered only when expanded) */}
      {!collapsed && (
        <div className="diff-file-card-content">
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '16px', color: 'var(--text-secondary, #64748b)', fontSize: '11px' }}>
              <SpinnerIcon size={13} />
              <span>Loading diff…</span>
            </div>
          ) : error ? (
            <div style={{ padding: '12px', color: 'var(--status-failed, #f43f5e)', fontSize: '11px' }}>
              {error}
            </div>
          ) : (
            <DiffCodeViewer diff={diff} layout={layout} wordWrap={wordWrap} />
          )}
        </div>
      )}
    </article>
  );
});
