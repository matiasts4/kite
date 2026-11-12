import React, { useRef, useState, useEffect } from 'react';
import type { GitFileChange } from '../files/gitTypes';
import { STATUS_LETTERS, splitPath } from '../files/gitTypes';
import {
  CopyGlyph,
  CheckGlyph,
} from '../../dockIcons';
import {
  FileTextIcon,
  PlusIcon,
  MinusIcon,
  Undo2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronDownIcon,
} from '../files/FileIcons';
import { useDiffsMenuPresence } from './diffsMotion';

export interface DiffFocusedHeaderProps {
  activeSelectedFile: GitFileChange;
  displayedFiles: GitFileChange[];
  currentIndex: number;
  onPrevFile: () => void;
  onNextFile: () => void;
  onSelectDiffPath: (path: string) => void;
  activeStats: { additions: number; deletions: number };
  copiedPath: boolean;
  onCopyPath: (path: string) => void;
  onOpenFileInEditor?: (filePath: string) => void;
  gitBusy: string | null;
  onToggleStage: (file: GitFileChange, staged: boolean) => void | Promise<void>;
  onDiscardChanges: (file: GitFileChange) => void | Promise<void>;
}

export const DiffFocusedHeader: React.FC<DiffFocusedHeaderProps> = ({
  activeSelectedFile,
  displayedFiles,
  currentIndex,
  onPrevFile,
  onNextFile,
  onSelectDiffPath,
  activeStats,
  copiedPath,
  onCopyPath,
  onOpenFileInEditor,
  gitBusy,
  onToggleStage,
  onDiscardChanges,
}) => {
  const [showDiscardConfirm, setShowDiscardConfirm] = useState<boolean>(false);
  const quickJumpRef = useRef<HTMLDivElement>(null);
  const [quickJumpOpen, setQuickJumpOpen] = useState<boolean>(false);
  const quickJumpPresence = useDiffsMenuPresence(quickJumpOpen);
  const [quickJumpFilter, setQuickJumpFilter] = useState<string>('');

  useEffect(() => {
    if (!quickJumpOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (quickJumpRef.current && !quickJumpRef.current.contains(e.target as Node)) {
        setQuickJumpOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setQuickJumpOpen(false);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [quickJumpOpen]);

  const quickJumpFilteredFiles = React.useMemo(() => {
    if (!quickJumpFilter.trim()) return displayedFiles;
    const q = quickJumpFilter.toLowerCase();
    return displayedFiles.filter((f) => f.path.toLowerCase().includes(q));
  }, [displayedFiles, quickJumpFilter]);

  const { name, directory } = splitPath(activeSelectedFile.path);
  const letter = (STATUS_LETTERS as Record<string, string>)[activeSelectedFile.status] || 'M';

  return (
    <>
      <header className="diff-focused-header">
        <div className="diff-focused-header-left">
          {/* File Stepper buttons for reviewing one-by-one */}
          {displayedFiles.length > 1 && (
            <div className="diff-stepper-group">
              <button
                type="button"
                className="diff-stepper-btn"
                disabled={currentIndex <= 0}
                onClick={onPrevFile}
                title="Previous file (Alt+Left)"
                aria-label="Previous file"
              >
                <ChevronLeftIcon size={11} />
              </button>
              <button
                type="button"
                className="diff-stepper-btn"
                disabled={currentIndex >= displayedFiles.length - 1}
                onClick={onNextFile}
                title="Next file (Alt+Right)"
                aria-label="Next file"
              >
                <ChevronRightIcon size={11} />
              </button>
            </div>
          )}

          <span
            className={`diff-status-pill ${activeSelectedFile.status}`}
            title={`Status: ${activeSelectedFile.status}`}
          >
            {letter}
          </span>

          <div className="diff-file-path" title={activeSelectedFile.path}>
            {directory ? (
              <span className="diff-file-dir" dir="rtl">
                <bdi dir="ltr">{directory}/</bdi>
              </span>
            ) : null}
            <span className="diff-file-name">{name}</span>
          </div>

          {(activeStats.additions > 0 || activeStats.deletions > 0) && (
            <span className="diffs-stat-badge">
              {activeStats.additions > 0 && (
                <span className="diffs-stat-add">+{activeStats.additions}</span>
              )}
              {activeStats.deletions > 0 && (
                <span className="diffs-stat-del">-{activeStats.deletions}</span>
              )}
            </span>
          )}
        </div>

        <div className="diff-focused-header-right">
          {/* Sleek File Counter & Quick Jump Menu */}
          {displayedFiles.length > 1 && (
            <div className="diff-quick-jump-wrapper" ref={quickJumpRef}>
              <button
                type="button"
                className="diff-counter-pill"
                onClick={() => setQuickJumpOpen((v) => !v)}
                title="Jump to file"
                aria-label="Open jump to file menu"
              >
                <span>{currentIndex >= 0 ? `${currentIndex + 1} of ${displayedFiles.length}` : `${displayedFiles.length} files`}</span>
                <ChevronDownIcon size={10} style={{ opacity: 0.6 }} />
              </button>

              {/* Hidden native select for test and screen reader compatibility */}
              <select
                className="diffs-stepper-file-selector"
                value={activeSelectedFile.path}
                onChange={(e) => onSelectDiffPath(e.target.value)}
                aria-label="Jump to file"
              >
                {displayedFiles.map((f, idx) => (
                  <option key={f.path} value={f.path}>
                    {idx + 1}. {f.path}
                  </option>
                ))}
              </select>

              {quickJumpPresence.mounted && (
                <div
                  className={`diff-quick-jump-popover${
                    quickJumpPresence.motionClass ? ` ${quickJumpPresence.motionClass}` : ''
                  }`}
                >
                  <input
                    type="text"
                    className="diff-quick-jump-search"
                    placeholder="Search changed files…"
                    value={quickJumpFilter}
                    onChange={(e) => setQuickJumpFilter(e.target.value)}
                    autoFocus
                  />
                  <ul className="diff-quick-jump-list scroll-quiet">
                    {quickJumpFilteredFiles.map((f) => {
                      const { name: fName, directory: fDir } = splitPath(f.path);
                      const fLetter = (STATUS_LETTERS as Record<string, string>)[f.status] || 'M';
                      const isCur = f.path === activeSelectedFile.path;
                      return (
                        <li key={f.path}>
                          <button
                            type="button"
                            className={`diff-quick-jump-item ${isCur ? 'active' : ''}`}
                            onClick={() => {
                              onSelectDiffPath(f.path);
                              setQuickJumpOpen(false);
                              setQuickJumpFilter('');
                            }}
                          >
                            <span
                              className={`diff-status-pill ${f.status}`}
                              style={{ width: 14, height: 14, fontSize: 8 }}
                            >
                              {fLetter}
                            </span>
                            <span className="diff-quick-jump-path">
                              {fDir && <span className="diff-quick-jump-dir">{fDir}/</span>}
                              <span className="diff-quick-jump-name">{fName}</span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            className="diff-card-btn"
            onClick={() => onCopyPath(activeSelectedFile.path)}
            title={copiedPath ? 'Path copied!' : 'Copy relative path'}
            aria-label="Copy relative path"
          >
            {copiedPath ? <CheckGlyph size={12} /> : <CopyGlyph size={12} />}
          </button>

          {activeSelectedFile.status !== 'deleted' && onOpenFileInEditor && (
            <button
              type="button"
              className="diff-card-btn"
              onClick={() => onOpenFileInEditor(activeSelectedFile.path)}
              title="Open file in editor"
              aria-label="Open file in editor"
            >
              <FileTextIcon size={12} />
            </button>
          )}

          {activeSelectedFile.status !== 'untracked' && (
            <button
              type="button"
              className="diff-card-btn danger"
              disabled={gitBusy !== null}
              onClick={() => setShowDiscardConfirm(true)}
              title="Discard changes"
              aria-label="Discard changes"
            >
              <Undo2Icon size={12} />
            </button>
          )}

          <button
            type="button"
            className="diff-card-btn"
            disabled={gitBusy !== null}
            onClick={() => void onToggleStage(activeSelectedFile, activeSelectedFile.staged)}
            title={activeSelectedFile.staged ? 'Unstage file' : 'Stage file'}
            aria-label={activeSelectedFile.staged ? 'Unstage file' : 'Stage file'}
          >
            {activeSelectedFile.staged ? <MinusIcon size={12} /> : <PlusIcon size={12} />}
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
                void onDiscardChanges(activeSelectedFile);
              }}
            >
              Confirm Discard
            </button>
          </div>
        </div>
      )}
    </>
  );
};
