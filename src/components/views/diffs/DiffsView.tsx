import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createWorkspaceGitService, splitPath } from '../files/gitTypes';
import { useWorkspaceGit } from '../files/useWorkspaceGit';
import { DiffFileCard } from './DiffFileCard';
import { DiffFileTree } from './DiffFileTree';
import { DiffCodeViewer } from './DiffCodeViewer';
import { DiffsCommitBar } from './DiffsCommitBar';
import { DiffsToolbar } from './DiffsToolbar';
import { DiffFocusedHeader } from './DiffFocusedHeader';
import {
  FolderIcon,
  CheckIcon,
  AlertCircleIcon,
} from '../files/FileIcons';
import { SpinnerIcon } from '../chat/ChatIcons';
import {
  type DiffPreviewRequest,
  OPEN_RIGHT_DOCK_DIFFS_EVENT,
  consumePendingDiffPreview,
  resolveRepoDiffPaths,
} from '../../../lib/diffPreviewNav';
import './diffs.css';

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
  const [turnFocusPaths, setTurnFocusPaths] = useState<string[] | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [copiedPath, setCopiedPath] = useState<boolean>(false);
  const [focusTick, setFocusTick] = useState<number>(0);
  const pendingFocusRequestRef = useRef<DiffPreviewRequest | null>(null);
  const focusSeqRef = useRef<number>(0);
  const pendingFocusRefreshSeqRef = useRef<number>(0);
  const isMountedRef = useRef<boolean>(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Responsive dock width observer
  const containerRef = useRef<HTMLDivElement>(null);
  const [isNarrow, setIsNarrow] = useState<boolean>(false);

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

  // Filtered files (scoped to thread turn paths when focused)
  const displayedFiles = useMemo(() => {
    if (turnFocusPaths && turnFocusPaths.length > 0) {
      const focusSet = new Set(turnFocusPaths);
      const focused = allFiles.filter((f) => focusSet.has(f.path));
      if (focused.length > 0) {
        return focused;
      }
    }
    if (filter === 'staged') return stagedFiles;
    if (filter === 'unstaged') return unstagedFiles;
    return allFiles;
  }, [turnFocusPaths, filter, stagedFiles, unstagedFiles, allFiles]);

  const isTurnFocusActive = useMemo(() => {
    if (!turnFocusPaths || turnFocusPaths.length === 0) return false;
    const focusSet = new Set(turnFocusPaths);
    return allFiles.some((f) => focusSet.has(f.path));
  }, [turnFocusPaths, allFiles]);

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

  // Reset expanded files when switching workspaces so all diffs start collapsed
  const currentWorkspaceRef = useRef<string | null>(null);
  useEffect(() => {
    if (currentWsId && currentWsId !== currentWorkspaceRef.current) {
      const previousWsId = currentWorkspaceRef.current;
      currentWorkspaceRef.current = currentWsId;
      if (previousWsId !== null && !pendingFocusRequestRef.current) {
        setTurnFocusPaths(null);
        setExpandedFiles(new Set());
      }
    }
  }, [currentWsId]);

  // Apply external focus requests dispatched from Thread ChangedFilesCard
  const acceptFocusRequest = useCallback(
    (req: DiffPreviewRequest) => {
      pendingFocusRequestRef.current = req;
      const targetWs = req.workspaceId ?? currentWsId;
      if (req.workspaceId && req.workspaceId !== currentWsId) {
        setCurrentWsId(req.workspaceId);
        onSelectWorkspace?.(req.workspaceId);
      }
      if (req.viewMode) {
        setViewMode(req.viewMode);
      }
      setFilter('all');
      if (targetWs) {
        const refreshResult = refreshGit(targetWs) as unknown;
        if (
          refreshResult &&
          typeof (refreshResult as Promise<unknown>).then === 'function'
        ) {
          const seq = ++focusSeqRef.current;
          pendingFocusRefreshSeqRef.current = seq;
          setFocusTick((n) => n + 1);
          Promise.resolve(refreshResult).finally(() => {
            if (pendingFocusRefreshSeqRef.current === seq) {
              pendingFocusRefreshSeqRef.current = 0;
              if (isMountedRef.current) {
                setFocusTick((n) => n + 1);
              }
            }
          });
        } else {
          pendingFocusRefreshSeqRef.current = 0;
          setFocusTick((n) => n + 1);
        }
      } else {
        pendingFocusRefreshSeqRef.current = 0;
        setFocusTick((n) => n + 1);
      }
    },
    [currentWsId, onSelectWorkspace, refreshGit]
  );

  useEffect(() => {
    const initial = consumePendingDiffPreview();
    if (initial) {
      acceptFocusRequest(initial);
    }
    const handleEvent = (e: Event) => {
      const detail = (e as CustomEvent<DiffPreviewRequest>).detail;
      const pending = consumePendingDiffPreview();
      const req = pending ?? detail;
      if (req) {
        acceptFocusRequest(req);
      }
    };
    window.addEventListener(OPEN_RIGHT_DOCK_DIFFS_EVENT, handleEvent);
    return () => window.removeEventListener(OPEN_RIGHT_DOCK_DIFFS_EVENT, handleEvent);
  }, [acceptFocusRequest]);

  useEffect(() => {
    const req = pendingFocusRequestRef.current;
    if (!req) return;
    if (!currentWsId) return;
    if (req.workspaceId && req.workspaceId !== currentWsId) return;

    const candidates = req.focusPaths?.length
      ? req.focusPaths
      : req.selectedPath
      ? [req.selectedPath]
      : [];
    if (candidates.length === 0) {
      pendingFocusRequestRef.current = null;
      pendingFocusRefreshSeqRef.current = 0;
      setTurnFocusPaths(null);
      return;
    }

    const waitingForRefresh =
      gitLoading || pendingFocusRefreshSeqRef.current !== 0;
    const repoPaths = allFiles.map((f) => f.path);
    const matched = resolveRepoDiffPaths(
      candidates,
      repoPaths,
      req.workspaceName ?? activeWorkspaceName,
      gitChanges?.workspacePrefix
    );

    if (matched.length > 0) {
      const primary =
        (req.selectedPath
          ? resolveRepoDiffPaths(
              [req.selectedPath],
              matched,
              req.workspaceName ?? activeWorkspaceName,
              gitChanges?.workspacePrefix
            )[0]
          : undefined) || matched[0];
      setTurnFocusPaths(matched);
      setFilter('all');
      setExpandedFiles(new Set(matched));
      setSelectedDiffPath(primary);
      if (!waitingForRefresh) {
        pendingFocusRequestRef.current = null;
      }
      if (typeof window !== 'undefined') {
        window.requestAnimationFrame(() => {
          const el = document.getElementById(`diff-file-${encodeURIComponent(primary)}`);
          if (el && typeof el.scrollIntoView === 'function') {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        });
      }
    } else if (!waitingForRefresh) {
      pendingFocusRequestRef.current = null;
      setTurnFocusPaths(null);
    }
  }, [
    allFiles,
    gitLoading,
    gitChanges?.workspacePrefix,
    activeWorkspaceName,
    currentWsId,
    setSelectedDiffPath,
    focusTick,
  ]);

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
      {/* Top Zone 1: Commit Bar */}
      <DiffsCommitBar
        commitDraft={commitDraft}
        setCommitDraft={setCommitDraft}
        gitBusy={gitBusy}
        canCommit={canCommit}
        hasNoStaged={hasNoStaged}
        onCommitSubmit={handleCommitSubmit}
        onCommitKeyDown={handleCommitKeyDown}
        unstagedCount={unstagedFiles.length}
        stagedCount={stagedFiles.length}
        totalFilesCount={allFiles.length}
        onStageAll={handleStageAll}
        onUnstageAll={handleUnstageAll}
        gitWriteError={gitWriteError}
        onDismissWriteError={() => setGitWriteError(null)}
      />

      {/* Top Zone 2: Toolbar */}
      <DiffsToolbar
        workspaces={workspaces}
        currentWsId={currentWsId}
        activeWorkspaceName={activeWorkspaceName}
        onSelectWorkspaceId={(id) => {
          pendingFocusRequestRef.current = null;
          setTurnFocusPaths(null);
          setCurrentWsId(id);
          onSelectWorkspace?.(id);
          try {
            localStorage.setItem('kite.selectedWorkspaceId', id);
          } catch {}
        }}
        filter={filter}
        setFilter={(nextFilter) => {
          pendingFocusRequestRef.current = null;
          setTurnFocusPaths(null);
          setFilter(nextFilter);
        }}
        allFilesCount={allFiles.length}
        stagedFilesCount={stagedFiles.length}
        unstagedFilesCount={unstagedFiles.length}
        gitLoading={gitLoading}
        onRefresh={() => {
          if (currentWsId) void refreshGit(currentWsId);
        }}
        isNarrow={isNarrow}
        viewMode={viewMode}
        setViewMode={setViewMode}
        layout={layout}
        setLayout={setLayout}
        wordWrap={wordWrap}
        setWordWrap={setWordWrap}
        fileTreeOpen={fileTreeOpen}
        setFileTreeOpen={setFileTreeOpen}
        allCollapsed={allCollapsed}
        onToggleAllCollapse={toggleAllCollapse}
        displayedFilesCount={displayedFiles.length}
      />

      {/* Focused Thread Turn Changes Bar */}
      {isTurnFocusActive && (
        <div className="diffs-turn-focus-bar" role="status" aria-label="Focused turn changes">
          <span className="diffs-turn-focus-bar__label">
            Showing {displayedFiles.length} {displayedFiles.length === 1 ? 'change' : 'changes'} from thread
          </span>
          <button
            type="button"
            className="diffs-turn-focus-bar__clear"
            onClick={() => {
              pendingFocusRequestRef.current = null;
              setTurnFocusPaths(null);
            }}
          >
            Show all ({allFiles.length})
          </button>
        </div>
      )}

      {/* Body Area: File Tree + Diff Viewer (Focused or Stream) */}
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
            <DiffFocusedHeader
              activeSelectedFile={activeSelectedFile}
              displayedFiles={displayedFiles}
              currentIndex={currentIndex}
              onPrevFile={handlePrevFile}
              onNextFile={handleNextFile}
              onSelectDiffPath={setSelectedDiffPath}
              activeStats={activeStats}
              copiedPath={copiedPath}
              onCopyPath={handleCopyPath}
              onOpenFileInEditor={onOpenFileInEditor}
              gitBusy={gitBusy}
              onToggleStage={handleToggleStage}
              onDiscardChanges={handleDiscardChanges}
            />

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
