import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createWorkspaceGitService, STATUS_LETTERS, splitPath } from '../files/gitTypes';
import { useWorkspaceGit } from '../files/useWorkspaceGit';
import { DiffFileCard } from './DiffFileCard';
import { DiffFileTree } from './DiffFileTree';
import { DiffCodeViewer } from './DiffCodeViewer';
import {
  ColumnsGlyph,
  RowsGlyph,
  WrapTextGlyph,
  FolderTreeGlyph,
  ChevronsUpDownGlyph,
  ChevronsDownUpGlyph,
  CopyGlyph,
  CheckGlyph,
  ListGlyph,
} from '../../dockIcons';
import {
  FolderIcon,
  CheckIcon,
  AlertCircleIcon,
  CloseIcon,
  FileTextIcon,
  PlusIcon,
  MinusIcon,
  Undo2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  MoreHorizontalIcon,
} from '../files/FileIcons';
import { RefreshIcon } from '../../code/codeIcons';
import { SpinnerIcon } from '../chat/ChatIcons';
import './diffs.css';
import { useDiffsMenuPresence } from './diffsMotion';

export interface DiffsViewProps {
  workspaceId: string | null;
  workspaces?: Array<{ id: string; name?: string; displayName?: string }>;
  onSelectWorkspace?: (id: string) => void;
  onOpenFileInEditor?: (filePath: string) => void;
}

export const DiffsView: React.FC<DiffsViewProps> = ({
  workspaceId,
  workspaces = [],
  onSelectWorkspace,
  onOpenFileInEditor,
}) => {
  const [currentWsId, setCurrentWsId] = useState<string | null>(() => {
    return (
      workspaceId ||
      (typeof window !== 'undefined' ? localStorage.getItem('kite.selectedWorkspaceId') : null)
    );
  });

  useEffect(() => {
    if (workspaceId) {
      setCurrentWsId(workspaceId);
    }
  }, [workspaceId]);

  // Auto-select workspace if none is selected
  useEffect(() => {
    if (!currentWsId && workspaces && workspaces.length > 0) {
      const saved = typeof window !== 'undefined' ? localStorage.getItem('kite.selectedWorkspaceId') : null;
      const target = (saved && workspaces.some((w) => w.id === saved)) ? saved : workspaces[0].id;
      setCurrentWsId(target);
      onSelectWorkspace?.(target);
    }
  }, [currentWsId, workspaces, onSelectWorkspace]);

  // Persist selected workspace
  useEffect(() => {
    if (currentWsId) {
      try {
        localStorage.setItem('kite.selectedWorkspaceId', currentWsId);
      } catch {}
    }
  }, [currentWsId]);

  const [isFolderMenuOpen, setIsFolderMenuOpen] = useState<boolean>(false);
  const folderMenuPresence = useDiffsMenuPresence(isFolderMenuOpen);
  const activeWorkspaceName = useMemo(() => {
    if (!currentWsId) return null;
    const found = workspaces?.find((w) => w.id === currentWsId);
    return found?.displayName || found?.name || 'Workspace';
  }, [currentWsId, workspaces]);

  const gitService = useMemo(() => createWorkspaceGitService(), []);
  const {
    gitChanges,
    gitLoading,
    gitError,
    selectedDiffPath,
    diffData,
    diffLoading,
    diffError,
    gitBusy,
    gitWriteError,
    commitDraft,
    setCommitDraft,
    setSelectedDiffPath,
    setGitWriteError,
    refreshGit,
    handleToggleStage,
    handleStageAll,
    handleUnstageAll,
    handleDiscardChanges,
    handleCommit,
  } = useWorkspaceGit(currentWsId);

  // Layout & Visibility preferences with localStorage
  const [layout, setLayout] = useState<'unified' | 'split'>(() => {
    try {
      const saved = localStorage.getItem('kite.diffs.layout.v1');
      if (saved === 'unified' || saved === 'split') return saved;
    } catch {}
    return 'unified';
  });

  const [wordWrap, setWordWrap] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('kite.diffs.wordwrap.v1');
      if (saved !== null) return saved === 'true';
    } catch {}
    return true; // Default to true so lines are never clipped!
  });

  const [fileTreeOpen, setFileTreeOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('kite.diffs.filetree.v1');
      if (saved !== null) return saved === 'true';
    } catch {}
    return true; // Default to true so changed files are immediately visible!
  });

  const [viewMode, setViewMode] = useState<'focused' | 'stream'>(() => {
    try {
      const saved = localStorage.getItem('kite.diffs.viewmode.v1');
      if (saved === 'focused' || saved === 'stream') return saved;
    } catch {}
    return 'stream'; // Default to stream with all cards collapsed for instant load and easy one-by-one review
  });

  const [filter, setFilter] = useState<'all' | 'staged' | 'unstaged'>('all');
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [copiedPath, setCopiedPath] = useState<boolean>(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState<boolean>(false);

  // Responsive dock width observer & more menu state
  const containerRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const quickJumpRef = useRef<HTMLDivElement>(null);
  const [isNarrow, setIsNarrow] = useState<boolean>(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState<boolean>(false);
  const moreMenuPresence = useDiffsMenuPresence(moreMenuOpen);
  const [quickJumpOpen, setQuickJumpOpen] = useState<boolean>(false);
  const quickJumpPresence = useDiffsMenuPresence(quickJumpOpen);
  const [quickJumpFilter, setQuickJumpFilter] = useState<string>('');

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setIsNarrow(entry.contentRect.width < 500);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!moreMenuOpen && !quickJumpOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (moreMenuOpen && moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
      if (quickJumpOpen && quickJumpRef.current && !quickJumpRef.current.contains(e.target as Node)) {
        setQuickJumpOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (moreMenuOpen) setMoreMenuOpen(false);
        if (quickJumpOpen) setQuickJumpOpen(false);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [moreMenuOpen, quickJumpOpen]);

  useEffect(() => {
    try {
      localStorage.setItem('kite.diffs.layout.v1', layout);
    } catch {}
  }, [layout]);

  useEffect(() => {
    try {
      localStorage.setItem('kite.diffs.wordwrap.v1', String(wordWrap));
    } catch {}
  }, [wordWrap]);

  useEffect(() => {
    try {
      localStorage.setItem('kite.diffs.filetree.v1', String(fileTreeOpen));
    } catch {}
  }, [fileTreeOpen]);

  useEffect(() => {
    try {
      localStorage.setItem('kite.diffs.viewmode.v1', viewMode);
    } catch {}
  }, [viewMode]);

  // Staged / Unstaged grouping
  const allFiles = gitChanges?.files || [];
  const stagedFiles = useMemo(() => allFiles.filter((f) => f.staged), [allFiles]);
  const unstagedFiles = useMemo(() => allFiles.filter((f) => f.unstaged), [allFiles]);
  const hasNoStaged = stagedFiles.length === 0;

  // Filtered files
  const displayedFiles = useMemo(() => {
    if (filter === 'staged') return stagedFiles;
    if (filter === 'unstaged') return unstagedFiles;
    return allFiles;
  }, [filter, stagedFiles, unstagedFiles, allFiles]);

  // Auto-select first file if none selected or selected file filtered out
  useEffect(() => {
    if (displayedFiles.length > 0) {
      if (!selectedDiffPath || !displayedFiles.some((f) => f.path === selectedDiffPath)) {
        setSelectedDiffPath(displayedFiles[0].path);
      }
    }
  }, [displayedFiles, selectedDiffPath, setSelectedDiffPath]);

  const activeSelectedFile = useMemo(() => {
    if (!selectedDiffPath) return displayedFiles[0] || null;
    return displayedFiles.find((f) => f.path === selectedDiffPath) || displayedFiles[0] || null;
  }, [selectedDiffPath, displayedFiles]);

  // Stepper navigation in Focused mode
  const currentIndex = useMemo(() => {
    if (!activeSelectedFile) return -1;
    return displayedFiles.findIndex((f) => f.path === activeSelectedFile.path);
  }, [displayedFiles, activeSelectedFile]);

  const handlePrevFile = useCallback(() => {
    if (currentIndex > 0) {
      setSelectedDiffPath(displayedFiles[currentIndex - 1].path);
    }
  }, [currentIndex, displayedFiles, setSelectedDiffPath]);

  const handleNextFile = useCallback(() => {
    if (currentIndex < displayedFiles.length - 1) {
      setSelectedDiffPath(displayedFiles[currentIndex + 1].path);
    }
  }, [currentIndex, displayedFiles, setSelectedDiffPath]);

  // Keyboard navigation Alt+Left and Alt+Right for reviewing files file-by-file
  useEffect(() => {
    if (viewMode !== 'focused') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'textarea' || tag === 'input' || tag === 'select') return;

      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        handlePrevFile();
      } else if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        handleNextFile();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [viewMode, handlePrevFile, handleNextFile]);

  // Filtered files for Quick Jump Menu
  const quickJumpFilteredFiles = useMemo(() => {
    if (!quickJumpFilter.trim()) return displayedFiles;
    const q = quickJumpFilter.toLowerCase();
    return displayedFiles.filter((f) => f.path.toLowerCase().includes(q));
  }, [displayedFiles, quickJumpFilter]);

  // Reset expanded files when switching workspaces so all diffs start collapsed
  const currentWorkspaceRef = useRef<string | null>(null);
  useEffect(() => {
    if (currentWsId && currentWsId !== currentWorkspaceRef.current) {
      currentWorkspaceRef.current = currentWsId;
      setExpandedFiles(new Set());
    }
  }, [currentWsId]);

  // Pre-load adjacent diffs in background so next/prev switching is 0ms instant
  useEffect(() => {
    if (!currentWsId || displayedFiles.length <= 1 || currentIndex < 0) return;
    const toPreload = [
      displayedFiles[currentIndex - 1],
      displayedFiles[currentIndex + 1],
    ].filter(Boolean);

    for (const f of toPreload) {
      void gitService.readWorkspaceFileDiff(currentWsId, f.path, f.status === 'untracked');
    }
  }, [currentWsId, displayedFiles, currentIndex, gitService]);

  // Collapse / Expand All toggle (for Stream mode)
  const allCollapsed = useMemo(() => {
    if (displayedFiles.length === 0) return true;
    return displayedFiles.every((f) => !expandedFiles.has(f.path));
  }, [displayedFiles, expandedFiles]);

  const toggleAllCollapse = () => {
    if (allCollapsed) {
      setExpandedFiles(new Set(displayedFiles.map((f) => f.path)));
    } else {
      setExpandedFiles(new Set());
    }
  };

  const toggleFileCollapse = useCallback((path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleSelectFileFromTree = (path: string) => {
    setSelectedDiffPath(path);
    // Expand file if collapsed in stream mode
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      next.add(path);
      return next;
    });
    // If in stream mode, scroll to card
    if (viewMode === 'stream') {
      const targetEl = document.getElementById(`diff-file-${encodeURIComponent(path)}`);
      if (targetEl && typeof targetEl.scrollIntoView === 'function') {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  };

  // Stats for active selected file
  const activeStats = useMemo(() => {
    if (!diffData || !diffData.lines) return { additions: 0, deletions: 0 };
    let add = 0;
    let del = 0;
    for (const l of diffData.lines) {
      if (l.kind === 'added') add++;
      if (l.kind === 'removed') del++;
    }
    return { additions: add, deletions: del };
  }, [diffData]);

  const handleCopyPath = (path: string) => {
    navigator.clipboard.writeText(path);
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), 2000);
  };

  // Commit Submission
  const canCommit = Boolean(
    gitBusy === null &&
      commitDraft.trim().length > 0 &&
      allFiles.length > 0
  );

  const handleCommitSubmit = () => {
    if (!canCommit) return;
    void handleCommit(commitDraft.trim(), hasNoStaged);
  };

  const handleCommitKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleCommitSubmit();
    }
  };

  if (!currentWsId) {
    return (
      <div className="diffs-container">
        <div className="diffs-empty-state">
          <FolderIcon size={36} style={{ color: 'var(--text-secondary, #64748b)', marginBottom: '8px' }} />
          <p className="diffs-empty-title">No workspace selected</p>
          <p className="diffs-empty-desc">Select a project or workspace to review its git diffs.</p>
          {workspaces && workspaces.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '12px', width: '100%', maxWidth: '240px' }}>
              {workspaces.map((ws) => (
                <button
                  key={ws.id}
                  type="button"
                  className="diffs-filter-pill active"
                  style={{ justifyContent: 'flex-start', padding: '6px 12px', height: 'auto' }}
                  onClick={() => {
                    setCurrentWsId(ws.id);
                    onSelectWorkspace?.(ws.id);
                    try {
                      localStorage.setItem('kite.selectedWorkspaceId', ws.id);
                    } catch {}
                  }}
                >
                  <FolderIcon size={13} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ws.displayName ?? ws.name ?? 'Workspace'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (gitChanges === null && gitLoading) {
    return (
      <div className="diffs-container">
        <div className="diffs-empty-state">
          <SpinnerIcon size={24} style={{ color: 'var(--text-secondary, #94a3b8)' }} />
          <p className="diffs-empty-desc">Reading workspace git status…</p>
        </div>
      </div>
    );
  }

  if (gitChanges && !gitChanges.isRepo) {
    return (
      <div className="diffs-container">
        <div className="diffs-empty-state">
          <p className="diffs-empty-title">Not a git repository</p>
          <p className="diffs-empty-desc">
            The selected workspace folder is not part of a Git repository.
          </p>
        </div>
      </div>
    );
  }

  if (gitChanges === null && gitError !== null) {
    return (
      <div className="diffs-container">
        <div className="diffs-empty-state">
          <AlertCircleIcon size={32} style={{ color: 'var(--status-failed, #f43f5e)' }} />
          <p className="diffs-empty-title">Changes could not be read</p>
          <p className="diffs-empty-desc">{gitError}</p>
        </div>
      </div>
    );
  }

  const isClean = allFiles.length === 0;

  return (
    <div className="diffs-container" ref={containerRef}>
      {/* ------------------------------------------------------------------
         Top Zone 1: Commit Bar (at the top, exactly as requested)
         ------------------------------------------------------------------ */}
      <section className="diffs-commit-bar" aria-label="Git commit">
        <div className="diffs-commit-input-row">
          <textarea
            className="diffs-commit-textarea"
            placeholder="Commit message (Ctrl+Enter to commit)"
            value={commitDraft}
            disabled={gitBusy !== null}
            onChange={(e) => setCommitDraft(e.target.value)}
            onKeyDown={handleCommitKeyDown}
            rows={2}
            aria-label="Commit message"
          />
          <button
            type="button"
            className="primary-button diffs-commit-btn"
            disabled={!canCommit}
            onClick={handleCommitSubmit}
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
              disabled={gitBusy !== null || unstagedFiles.length === 0}
              onClick={() => void handleStageAll()}
            >
              Stage all
            </button>
            <span style={{ opacity: 0.3 }}>•</span>
            <button
              type="button"
              className="diffs-text-btn"
              disabled={gitBusy !== null || stagedFiles.length === 0}
              onClick={() => void handleUnstageAll()}
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
              {allFiles.length} changed {allFiles.length === 1 ? 'file' : 'files'}
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
              borderRadius: '4px',
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
              onClick={() => setGitWriteError(null)}
              aria-label="Dismiss error"
            >
              <CloseIcon size={10} />
            </button>
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------------
         Top Zone 2: Toolbar
         ------------------------------------------------------------------ */}
      <nav className="diffs-toolbar" aria-label="Diffs toolbar">
        {/* Left: Folder Picker & Filter Pills */}
        <div className="diffs-toolbar-left">
          {workspaces && workspaces.length > 0 && (
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                className="_folderButton"
                aria-expanded={isFolderMenuOpen}
                aria-haspopup="menu"
                aria-label={`Folder, ${activeWorkspaceName ?? 'none'}`}
                onClick={() => setIsFolderMenuOpen((prev) => !prev)}
                title="Switch diff folder"
                style={{
                  height: '24px',
                  padding: '0 8px',
                  fontSize: '11px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                  borderRadius: 'var(--radius-chip, 12px)',
                  background: 'var(--block-fill, rgba(255, 255, 255, 0.05))',
                  border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.08))',
                  color: 'var(--text-primary, #f1f5f9)',
                  cursor: 'pointer',
                  maxWidth: '160px',
                }}
              >
                <FolderIcon size={12} style={{ color: 'var(--accent, #6366f1)', flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {activeWorkspaceName ?? 'Select folder'}
                </span>
                <ChevronDownIcon size={10} style={{ opacity: 0.6, flexShrink: 0 }} />
              </button>

              {folderMenuPresence.mounted && (
                <>
                  <div
                    style={{ position: 'fixed', inset: 0, zIndex: 49 }}
                    onClick={() => setIsFolderMenuOpen(false)}
                  />
                  <div
                    role="menu"
                    aria-label="Select workspace folder"
                    className={`ui-menu diffs-overflow-menu diffs-overflow-menu--anchor-left scroll-quiet${
                      folderMenuPresence.motionClass ? ` ${folderMenuPresence.motionClass}` : ''
                    }`}
                    style={{
                      position: 'absolute',
                      top: 'calc(100% + 4px)',
                      marginTop: 0,
                      zIndex: 50,
                      minWidth: '200px',
                    }}
                  >
                    <div className="ui-menu__header" style={{ padding: '6px 10px' }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: '11px',
                          color: 'var(--text-primary, #f0f6fc)',
                        }}
                      >
                        Show diffs from
                      </div>
                    </div>
                    <div
                      style={{
                        height: '1px',
                        background: 'var(--separator, rgba(255,255,255,0.08))',
                        margin: '4px 0',
                      }}
                    />
                    {workspaces.map((ws) => (
                      <button
                        key={ws.id}
                        type="button"
                        role="menuitem"
                        className={`ui-menu__row${ws.id === currentWsId ? ' active' : ''}`}
                        style={{
                          width: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '8px',
                          padding: '6px 10px',
                          background: ws.id === currentWsId ? 'var(--hover-fill, rgba(255,255,255,0.08))' : 'transparent',
                          border: 'none',
                          color: 'var(--text-primary, #f0f6fc)',
                          fontSize: '11px',
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                        onClick={() => {
                          setCurrentWsId(ws.id);
                          onSelectWorkspace?.(ws.id);
                          try {
                            localStorage.setItem('kite.selectedWorkspaceId', ws.id);
                          } catch {}
                          setIsFolderMenuOpen(false);
                        }}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          <FolderIcon size={12} style={{ color: 'var(--accent, #6366f1)' }} />
                          <span>{ws.displayName ?? ws.name ?? 'Workspace'}</span>
                        </span>
                        {ws.id === currentWsId && <CheckIcon size={11} />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          <button
            type="button"
            className={`diffs-filter-pill ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
          >
            <span>All</span>
            <span style={{ opacity: 0.7, fontFamily: 'var(--font-mono, monospace)' }}>
              ({allFiles.length})
            </span>
          </button>
          <button
            type="button"
            className={`diffs-filter-pill ${filter === 'staged' ? 'active' : ''}`}
            onClick={() => setFilter('staged')}
          >
            <span>Staged</span>
            <span style={{ opacity: 0.7, fontFamily: 'var(--font-mono, monospace)' }}>
              ({stagedFiles.length})
            </span>
          </button>
          <button
            type="button"
            className={`diffs-filter-pill ${filter === 'unstaged' ? 'active' : ''}`}
            onClick={() => setFilter('unstaged')}
          >
            <span>Unstaged</span>
            <span style={{ opacity: 0.7, fontFamily: 'var(--font-mono, monospace)' }}>
              ({unstagedFiles.length})
            </span>
          </button>
        </div>

        {/* Right: Controls & Toggles */}
        <div className="diffs-toolbar-right">
          {/* Refresh git (SVG RefreshIcon, no emojis) */}
          <button
            type="button"
            className="diffs-tool-btn"
            onClick={() => {
              if (currentWsId) void refreshGit(currentWsId);
            }}
            title="Refresh changes"
            aria-label="Refresh changes"
          >
            <RefreshIcon size={12} className={gitLoading ? 'icon-spin' : ''} />
          </button>

          {!isNarrow ? (
            <>
              {/* View Presentation Mode Toggle: Focused vs Stream */}
              <button
                type="button"
                className={`diffs-filter-pill ${viewMode === 'focused' ? 'active' : ''}`}
                onClick={() => setViewMode((m) => (m === 'focused' ? 'stream' : 'focused'))}
                title={viewMode === 'focused' ? 'Switch to All Files Stream' : 'Switch to Focused File View'}
                aria-label="Toggle view mode"
                style={{ height: '22px', fontSize: '10.5px' }}
              >
                {viewMode === 'focused' ? 'Focused' : 'Stream'}
              </button>

              {/* Expand / Collapse All (active in Stream mode) */}
              {viewMode === 'stream' && displayedFiles.length > 0 && (
                <button
                  type="button"
                  className="diffs-tool-btn"
                  onClick={toggleAllCollapse}
                  title={allCollapsed ? 'Expand all files' : 'Collapse all files'}
                  aria-label={allCollapsed ? 'Expand all files' : 'Collapse all files'}
                >
                  {allCollapsed ? <ChevronsUpDownGlyph size={13} /> : <ChevronsDownUpGlyph size={13} />}
                </button>
              )}

              <div className="diffs-sep" />

              {/* View Mode Toggle: Unified vs Split */}
              <button
                type="button"
                className={`diffs-tool-btn ${layout === 'unified' ? 'active' : ''}`}
                onClick={() => setLayout('unified')}
                title="Unified diff view (stacked)"
                aria-label="Unified diff view"
              >
                <RowsGlyph size={13} />
              </button>
              <button
                type="button"
                className={`diffs-tool-btn ${layout === 'split' ? 'active' : ''}`}
                onClick={() => setLayout('split')}
                title="Split diff view (side-by-side)"
                aria-label="Split diff view"
              >
                <ColumnsGlyph size={13} />
              </button>

              <div className="diffs-sep" />

              {/* Word Wrap Toggle (crucial fix for truncated code lines!) */}
              <button
                type="button"
                className={`diffs-tool-btn ${wordWrap ? 'active' : ''}`}
                onClick={() => setWordWrap((v) => !v)}
                title={wordWrap ? 'Disable line wrapping' : 'Enable line wrapping'}
                aria-label={wordWrap ? 'Disable line wrapping' : 'Enable line wrapping'}
              >
                <WrapTextGlyph size={13} />
              </button>
            </>
          ) : (
            /* Compact Overflow Menu (•••) for Narrow Dock Widths */
            <div className="diffs-more-menu-wrapper" ref={moreMenuRef}>
              <button
                type="button"
                className={`diffs-tool-btn ${moreMenuOpen ? 'active' : ''}`}
                onClick={() => setMoreMenuOpen((v) => !v)}
                title="Diff display options"
                aria-label="Diff display options"
                aria-expanded={moreMenuOpen}
                aria-haspopup="menu"
              >
                <MoreHorizontalIcon size={13} />
              </button>

              {moreMenuPresence.mounted && (
                <div
                  role="menu"
                  aria-label="Diff display options"
                  className={`ui-menu diffs-overflow-menu scroll-quiet${
                    moreMenuPresence.motionClass ? ` ${moreMenuPresence.motionClass}` : ''
                  }`}
                >
                  <div className="ui-menu__header" role="presentation">
                    <span className="ui-menu__title">Diff options</span>
                  </div>
                  <div aria-hidden="true" className="ui-menu__rule" />

                  <div className="ui-menu__heading" role="presentation">
                    View mode
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    className={`ui-menu__row ${viewMode === 'focused' ? 'active' : ''}`}
                    onClick={() => {
                      setViewMode('focused');
                      setMoreMenuOpen(false);
                    }}
                  >
                    <span aria-hidden="true" className="ui-menu__icon">
                      <FileTextIcon size={12} />
                    </span>
                    <span className="ui-menu__label">
                      <span className="ui-menu__row-title">Focused</span>
                    </span>
                    {viewMode === 'focused' && (
                      <span className="ui-menu__status">
                        <CheckGlyph size={11} />
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={`ui-menu__row ${viewMode === 'stream' ? 'active' : ''}`}
                    onClick={() => {
                      setViewMode('stream');
                      setMoreMenuOpen(false);
                    }}
                  >
                    <span aria-hidden="true" className="ui-menu__icon">
                      <ListGlyph size={12} />
                    </span>
                    <span className="ui-menu__label">
                      <span className="ui-menu__row-title">Stream (All files)</span>
                    </span>
                    {viewMode === 'stream' && (
                      <span className="ui-menu__status">
                        <CheckGlyph size={11} />
                      </span>
                    )}
                  </button>

                  <div aria-hidden="true" className="ui-menu__rule" />
                  <div className="ui-menu__heading" role="presentation">
                    Diff layout
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    className={`ui-menu__row ${layout === 'unified' ? 'active' : ''}`}
                    onClick={() => {
                      setLayout('unified');
                      setMoreMenuOpen(false);
                    }}
                  >
                    <span aria-hidden="true" className="ui-menu__icon">
                      <RowsGlyph size={12} />
                    </span>
                    <span className="ui-menu__label">
                      <span className="ui-menu__row-title">Unified (Stacked)</span>
                    </span>
                    {layout === 'unified' && (
                      <span className="ui-menu__status">
                        <CheckGlyph size={11} />
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={`ui-menu__row ${layout === 'split' ? 'active' : ''}`}
                    onClick={() => {
                      setLayout('split');
                      setMoreMenuOpen(false);
                    }}
                  >
                    <span aria-hidden="true" className="ui-menu__icon">
                      <ColumnsGlyph size={12} />
                    </span>
                    <span className="ui-menu__label">
                      <span className="ui-menu__row-title">Split (Side by side)</span>
                    </span>
                    {layout === 'split' && (
                      <span className="ui-menu__status">
                        <CheckGlyph size={11} />
                      </span>
                    )}
                  </button>

                  <div aria-hidden="true" className="ui-menu__rule" />
                  <div className="ui-menu__heading" role="presentation">
                    Formatting
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    className={`ui-menu__row ${wordWrap ? 'active' : ''}`}
                    onClick={() => {
                      setWordWrap((w) => !w);
                    }}
                  >
                    <span aria-hidden="true" className="ui-menu__icon">
                      <WrapTextGlyph size={12} />
                    </span>
                    <span className="ui-menu__label">
                      <span className="ui-menu__row-title">Wrap lines</span>
                    </span>
                    {wordWrap && (
                      <span className="ui-menu__status">
                        <CheckGlyph size={11} />
                      </span>
                    )}
                  </button>

                  {viewMode === 'stream' && displayedFiles.length > 0 && (
                    <>
                      <div aria-hidden="true" className="ui-menu__rule" />
                      <div className="ui-menu__heading" role="presentation">
                        Cards
                      </div>
                      <button
                        type="button"
                        role="menuitem"
                        className="ui-menu__row"
                        onClick={() => {
                          toggleAllCollapse();
                          setMoreMenuOpen(false);
                        }}
                      >
                        <span aria-hidden="true" className="ui-menu__icon">
                          {allCollapsed ? (
                            <ChevronsUpDownGlyph size={12} />
                          ) : (
                            <ChevronsDownUpGlyph size={12} />
                          )}
                        </span>
                        <span className="ui-menu__label">
                          <span className="ui-menu__row-title">
                            {allCollapsed ? 'Expand all files' : 'Collapse all files'}
                          </span>
                        </span>
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* File Tree Drawer Toggle */}
          <button
            type="button"
            className={`diffs-tool-btn ${fileTreeOpen ? 'active' : ''}`}
            onClick={() => setFileTreeOpen((v) => !v)}
            title={fileTreeOpen ? 'Hide file tree' : 'Show file tree'}
            aria-label={fileTreeOpen ? 'Hide file tree' : 'Show file tree'}
          >
            <FolderTreeGlyph size={13} />
          </button>
        </div>
      </nav>

      {/* ------------------------------------------------------------------
         Body Area: File Tree + Diff Viewer (Focused or Stream)
         ------------------------------------------------------------------ */}
      <div className="diffs-body">
        {/* Collapsible File Tree Drawer (Open by default) */}
        {fileTreeOpen && displayedFiles.length > 0 && (
          <DiffFileTree
            files={displayedFiles}
            activePath={selectedDiffPath}
            onSelectFile={handleSelectFileFromTree}
          />
        )}

        {/* Clean Working Tree State */}
        {isClean ? (
          <div className="diffs-empty-state">
            <CheckIcon size={32} style={{ color: 'var(--status-running, #10b981)' }} />
            <p className="diffs-empty-title">Working tree clean</p>
            <p className="diffs-empty-desc">
              There are no modified, staged, or untracked files in this workspace.
            </p>
          </div>
        ) : displayedFiles.length === 0 ? (
          <div className="diffs-empty-state">
            <p className="diffs-empty-title">No files match the filter</p>
            <p className="diffs-empty-desc">
              No files found in the '{filter}' category.
            </p>
          </div>
        ) : viewMode === 'focused' && activeSelectedFile ? (
          /* Focused Single-File Master-Detail View */
          <div className="diffs-focused-pane">
            {/* Unified Focused File Header */}
            {(() => {
              const { name, directory } = splitPath(activeSelectedFile.path);
              const letter = STATUS_LETTERS[activeSelectedFile.status] || 'M';

              return (
                <header className="diff-focused-header">
                  <div className="diff-focused-header-left">
                    {/* File Stepper buttons for reviewing one-by-one */}
                    {displayedFiles.length > 1 && (
                      <div className="diff-stepper-group">
                        <button
                          type="button"
                          className="diff-stepper-btn"
                          disabled={currentIndex <= 0}
                          onClick={handlePrevFile}
                          title="Previous file (Alt+Left)"
                          aria-label="Previous file"
                        >
                          <ChevronLeftIcon size={11} />
                        </button>
                        <button
                          type="button"
                          className="diff-stepper-btn"
                          disabled={currentIndex >= displayedFiles.length - 1}
                          onClick={handleNextFile}
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
                          onChange={(e) => setSelectedDiffPath(e.target.value)}
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
                                const fLetter = STATUS_LETTERS[f.status] || 'M';
                                const isCur = f.path === activeSelectedFile.path;
                                return (
                                  <li key={f.path}>
                                    <button
                                      type="button"
                                      className={`diff-quick-jump-item ${isCur ? 'active' : ''}`}
                                      onClick={() => {
                                        setSelectedDiffPath(f.path);
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
                      onClick={() => handleCopyPath(activeSelectedFile.path)}
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
                      onClick={() => handleToggleStage(activeSelectedFile, activeSelectedFile.staged)}
                      title={activeSelectedFile.staged ? 'Unstage file' : 'Stage file'}
                      aria-label={activeSelectedFile.staged ? 'Unstage file' : 'Stage file'}
                    >
                      {activeSelectedFile.staged ? <MinusIcon size={12} /> : <PlusIcon size={12} />}
                    </button>
                  </div>
                </header>
              );
            })()}

            {/* Discard Confirmation Inline Alert */}
            {showDiscardConfirm && activeSelectedFile && (
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
                  Discard changes to <strong>{splitPath(activeSelectedFile.path).name}</strong>? Edits will be lost.
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
                      void handleDiscardChanges(activeSelectedFile);
                    }}
                  >
                    Confirm Discard
                  </button>
                </div>
              </div>
            )}

            {/* Focused Diff Code Viewer Content */}
            <div className="diffs-focused-content scroll-quiet" key={activeSelectedFile.path}>
              {diffLoading ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                    padding: '36px',
                    color: 'var(--text-secondary, #94a3b8)',
                    fontSize: '11.5px',
                  }}
                >
                  <SpinnerIcon size={15} />
                  <span>Loading diff for {splitPath(activeSelectedFile.path).name}…</span>
                </div>
              ) : diffError ? (
                <div style={{ padding: '16px', color: 'var(--status-failed, #f43f5e)', fontSize: '11.5px' }}>
                  {diffError}
                </div>
              ) : (
                <DiffCodeViewer diff={diffData} layout={layout} wordWrap={wordWrap} />
              )}
            </div>
          </div>
        ) : (
          /* Multi-File Continuous Stream (accordion cards with lazy loading) */
          <div className="diffs-stream scroll-quiet">
            {displayedFiles.map((file) => (
              <DiffFileCard
                key={file.path}
                file={file}
                workspaceId={currentWsId}
                gitService={gitService}
                collapsed={!expandedFiles.has(file.path)}
                layout={layout}
                wordWrap={wordWrap}
                busy={gitBusy !== null}
                onToggleCollapse={() => toggleFileCollapse(file.path)}
                onToggleStage={handleToggleStage}
                onDiscard={(target) => void handleDiscardChanges(target)}
                onOpenFile={(filePath) => {
                  if (onOpenFileInEditor) {
                    onOpenFileInEditor(filePath);
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
