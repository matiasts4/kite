import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type {
  FilesEntry,
  FilesResourceResponse,
  FilesDirectoryResponse,
  FilesTextResponse,
  FilesPreviewResponse,
  BootstrapResponse,
} from '../../types';
import { invokeCommand } from '../../lib/ipc';
import { toHex64String, isValidRevision64 } from './files/syntax';
import { FolderIcon } from './files/FileIcons';
import { CodeEditorPane, OpenFileTab } from './files/CodeEditorPane';
import { ChangesView } from './files/ChangesView';
import { FilesToolbar } from './files/FilesToolbar';
import { FilesTreePanel } from './files/FilesTreePanel';
import { useWorkspaceGit } from './files/useWorkspaceGit';
import { useFilesAutoSavePreference } from '../../lib/filesAutoSavePreference';
import {
  OPEN_RIGHT_DOCK_FILE_EVENT,
  consumePendingFilePreview,
  FilePreviewRequest,
} from '../../lib/filePreviewNav';
import './files.css';

interface ResolvedFileLink {
  workspaceId: string;
  resourceId: string;
  entryId: string;
  relativePath: string;
  displayName: string;
  line?: number | null;
  column?: number | null;
}

function externalUrlFromToken(text: string): string | null {
  const trimmed = text.trim().replace(/^['"`(<\[]+|['"`)>\].,;:]+$/g, '');
  if (!trimmed || /[\s<>]/.test(trimmed)) return null;
  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) return trimmed;
  return null;
}

function pathCandidateFromToken(text: string): string | null {
  const trimmed = text.trim().replace(/^['"`(<\[]+|['"`)>\].,;]+$/g, '');
  if (!trimmed || trimmed.length > 4096 || /[\r\n]/.test(trimmed)) return null;
  if (externalUrlFromToken(trimmed)) return null;
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.startsWith('./')) return trimmed;
  return null;
}

export interface FilesViewProps {
  workspaceId: string | null;
  workspaceName?: string;
  workspaces?: Array<{ id: string; name?: string; displayName?: string }>;
  onSelectWorkspace?: (workspaceId: string) => void;
  initialMode?: 'files' | 'changes';
}

interface BreadcrumbSegment {
  name: string;
  path: string;
  entryId?: string;
  isFolder: boolean;
  isFile: boolean;
}

export const FilesView: React.FC<FilesViewProps> = ({
  workspaceId,
  workspaceName,
  workspaces,
  onSelectWorkspace,
  initialMode = 'files',
}) => {
  const [currentWsId, setCurrentWsId] = useState<string | null>(() => {
    return (
      workspaceId ||
      (typeof window !== 'undefined' ? localStorage.getItem('bmone.selectedWorkspaceId') : null)
    );
  });
  const [mode, setMode] = useState<'files' | 'changes'>(initialMode);

  useEffect(() => {
    if (workspaceId) {
      setCurrentWsId(workspaceId);
    }
  }, [workspaceId]);

  const [workspacesList, setWorkspacesList] = useState<Array<{ id: string; name: string }>>(() =>
    (workspaces || []).map((w) => ({ id: w.id, name: w.name ?? w.displayName ?? 'Workspace' }))
  );

  useEffect(() => {
    if (workspaces && workspaces.length > 0) {
      setWorkspacesList(workspaces.map((w) => ({ id: w.id, name: w.name ?? w.displayName ?? 'Workspace' })));
      return;
    }
    invokeCommand<BootstrapResponse>('bootstrap')
      .then((res) => {
        if (res?.workspaces) {
          setWorkspacesList(res.workspaces.map((w) => ({ id: w.id, name: w.displayName })));
        }
      })
      .catch(() => {});
  }, [workspaces]);

  // Auto-select workspace if none is selected
  useEffect(() => {
    if (!currentWsId && workspacesList.length > 0) {
      const saved = typeof window !== 'undefined' ? localStorage.getItem('bmone.selectedWorkspaceId') : null;
      const target = (saved && workspacesList.some((w) => w.id === saved)) ? saved : workspacesList[0].id;
      setCurrentWsId(target);
      onSelectWorkspace?.(target);
    }
  }, [currentWsId, workspacesList, onSelectWorkspace]);

  // Persist selected workspace
  useEffect(() => {
    if (currentWsId) {
      try {
        localStorage.setItem('bmone.selectedWorkspaceId', currentWsId);
      } catch {}
    }
  }, [currentWsId]);

  const activeWorkspace = useMemo(() => {
    if (!currentWsId) return null;
    const found = workspacesList.find((w) => w.id === currentWsId);
    return found || { id: currentWsId, name: workspaceName || 'Workspace' };
  }, [currentWsId, workspacesList, workspaceName]);

  // Tree & Editor State
  const [resourceId, setResourceId] = useState<string | null>(null);
  const [rootEntry, setRootEntry] = useState<FilesEntry | null>(null);
  const [folderChildren, setFolderChildren] = useState<Map<string, FilesEntry[]>>(new Map());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [loadingFolders, setLoadingFolders] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const [pathToEntryId, setPathToEntryId] = useState<Map<string, string>>(new Map());
  const [activeFolderPath, setActiveFolderPath] = useState<string>('');

  const [openFiles, setOpenFiles] = useState<OpenFileTab[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [targetLine, setTargetLine] = useState<number | null>(null);

  const [showTree, setShowTree] = useState<boolean>(true);
  const [treeWidth, setTreeWidth] = useState<number>(240);
  const [isEditMode, setIsEditMode] = useState<boolean>(false);
  const [autoSave, setAutoSave] = useFilesAutoSavePreference();
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState<boolean>(false);

  const isResizingRef = useRef<boolean>(false);
  const activeTab = openFiles.find((f) => f.entryId === activeFileId) || null;
  const isModified = activeTab ? activeTab.draftText !== activeTab.initialText : false;

  // Git Controller
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
    handlePull,
    handlePush,
  } = useWorkspaceGit(currentWsId);

  // Initialize workspace files
  const initWorkspaceFiles = useCallback(async (wsId: string) => {
    setLoading(true);
    setErrorMessage(null);
    setFolderChildren(new Map());
    setExpandedFolders(new Set());
    setPathToEntryId(new Map());
    setActiveFolderPath('');
    try {
      const res = await invokeCommand<FilesResourceResponse>('ensure_files_resource', {
        supportedSchemaVersion: 1,
        workspaceId: wsId,
      });
      setResourceId(res.resourceId);
      setRootEntry(res.root);

      if (res.root && res.root.kind === 'directory') {
        const rootPathMap = new Map<string, string>([['', res.root.entryId]]);
        const dir = await invokeCommand<FilesDirectoryResponse>('list_files_directory', {
          supportedSchemaVersion: 1,
          workspaceId: wsId,
          resourceId: res.resourceId,
          parentEntryId: res.root.entryId,
          entryId: res.root.entryId,
        });

        for (const entry of dir.entries) {
          rootPathMap.set(entry.displayName, entry.entryId);
        }

        setPathToEntryId(rootPathMap);
        setFolderChildren(new Map([[res.root.entryId, dir.entries]]));
        setExpandedFolders(new Set([res.root.entryId]));
      }
    } catch (err: unknown) {
      const errObj = err as { message?: string };
      setErrorMessage(errObj?.message || 'Failed to initialize workspace files');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (currentWsId) {
      void initWorkspaceFiles(currentWsId);
    } else {
      setResourceId(null);
      setRootEntry(null);
      setFolderChildren(new Map());
      setOpenFiles([]);
      setActiveFileId(null);
      setPathToEntryId(new Map());
      setActiveFolderPath('');
    }
  }, [currentWsId, initWorkspaceFiles]);

  // Window Focus Auto-Refresh
  useEffect(() => {
    const handleFocus = () => {
      if (currentWsId) {
        void refreshGit(currentWsId);
      }
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [currentWsId, refreshGit]);

  // Menu State Sync
  useEffect(() => {
    const menuState = {
      supportedSchemaVersion: 1,
      ready: Boolean(currentWsId),
      blocked: !currentWsId,
      newItem: null,
      sidebarOpen: true,
      canShowFiles: Boolean(currentWsId && resourceId),
      canCheckForUpdates: false,
    };
    void invokeCommand('set_app_menu_state', menuState).catch(() => {});
    return () => {
      void invokeCommand('set_app_menu_state', {
        supportedSchemaVersion: 1,
        ready: false,
        blocked: true,
        newItem: null,
        sidebarOpen: false,
        canShowFiles: false,
        canCheckForUpdates: false,
      }).catch(() => {});
    };
  }, [currentWsId, resourceId]);

  // Toggle Folder
  const handleToggleFolder = useCallback(
    async (folderEntryId: string, folderRelativePath: string) => {
      if (!currentWsId || !resourceId) return;

      setActiveFolderPath(folderRelativePath);

      if (expandedFolders.has(folderEntryId)) {
        setExpandedFolders((prev) => {
          const next = new Set(prev);
          next.delete(folderEntryId);
          return next;
        });
        return;
      }

      setExpandedFolders((prev) => new Set(prev).add(folderEntryId));

      if (!folderChildren.has(folderEntryId)) {
        setLoadingFolders((prev) => new Set(prev).add(folderEntryId));
        try {
          const dir = await invokeCommand<FilesDirectoryResponse>('list_files_directory', {
            supportedSchemaVersion: 1,
            workspaceId: currentWsId,
            resourceId,
            parentEntryId: folderEntryId,
            entryId: folderEntryId,
          });

          setFolderChildren((prev) => new Map(prev).set(folderEntryId, dir.entries));
          setPathToEntryId((prevPath) => {
            const next = new Map(prevPath);
            for (const item of dir.entries) {
              const fullItemPath = folderRelativePath
                ? `${folderRelativePath}/${item.displayName}`
                : item.displayName;
              next.set(fullItemPath, item.entryId);
            }
            return next;
          });
        } catch (err: unknown) {
          const errObj = err as { message?: string };
          setErrorMessage(errObj?.message || 'Failed to list directory');
        } finally {
          setLoadingFolders((prev) => {
            const next = new Set(prev);
            next.delete(folderEntryId);
            return next;
          });
        }
      }
    },
    [currentWsId, resourceId, expandedFolders, folderChildren]
  );

  // Open File Candidate
  const openCandidate = useCallback(
    async (req: FilePreviewRequest) => {
      setMode('files');
      if (req.collapseTree) {
        setShowTree(false);
      }
      const origin = req.workspaceId || currentWsId
        ? { kind: 'workspace', workspaceId: req.workspaceId || currentWsId }
        : { kind: 'global' };

      setLoadingContent(true);
      setFileError(null);

      try {
        const link = await invokeCommand<ResolvedFileLink>('resolve_file_link', {
          supportedSchemaVersion: 1,
          origin,
          candidate: req.candidate,
        });

        if (!link?.entryId || !link.resourceId || !link.workspaceId) {
          throw new Error(`Could not resolve file: ${req.candidate}`);
        }

        const effectiveLine = link.line ?? req.line ?? null;
        setTargetLine(effectiveLine);

        if (link.workspaceId !== currentWsId && link.workspaceId !== 'global-files') {
          if (onSelectWorkspace) {
            onSelectWorkspace(link.workspaceId);
          }
          setCurrentWsId(link.workspaceId);
        }
        setResourceId(link.resourceId);

        const existing = openFiles.find(
          (f) => f.entryId === link.entryId || f.relativePath === link.relativePath
        );
        if (existing) {
          setActiveFileId(existing.entryId);
          setLoadingContent(false);
          return;
        }

        const isBinaryPreviewable = /\.(png|jpe?g|gif|webp|svg|ico|bmp|pdf|tiff|avif)$/i.test(
          link.displayName
        );

        if (isBinaryPreviewable) {
          try {
            const preview = await invokeCommand<FilesPreviewResponse>('read_files_preview', {
              supportedSchemaVersion: 1,
              workspaceId: link.workspaceId,
              resourceId: link.resourceId,
              entryId: link.entryId,
            });

            const newTab: OpenFileTab = {
              entryId: link.entryId,
              name: link.displayName,
              relativePath: link.relativePath,
              revision: '',
              draftText: '',
              initialText: '',
              previewData: { mime: preview.mime, base64: preview.base64 },
            };

            setOpenFiles((prev) => [...prev, newTab]);
            setActiveFileId(link.entryId);
            setLoadingContent(false);
            return;
          } catch {
            // Fall back to text
          }
        }

        try {
          const textRes = await invokeCommand<FilesTextResponse>('read_files_text', {
            supportedSchemaVersion: 1,
            workspaceId: link.workspaceId,
            resourceId: link.resourceId,
            entryId: link.entryId,
          });

          const newTab: OpenFileTab = {
            entryId: link.entryId,
            name: link.displayName,
            relativePath: link.relativePath,
            revision: textRes.revision || '',
            draftText: textRes.text,
            initialText: textRes.text,
            encoding: textRes.encoding,
            lineEnding: textRes.lineEnding,
            previewData: null,
          };

          setOpenFiles((prev) => [...prev, newTab]);
          setActiveFileId(link.entryId);
        } catch (err: unknown) {
          try {
            const preview = await invokeCommand<FilesPreviewResponse>('read_files_preview', {
              supportedSchemaVersion: 1,
              workspaceId: link.workspaceId,
              resourceId: link.resourceId,
              entryId: link.entryId,
            });

            const newTab: OpenFileTab = {
              entryId: link.entryId,
              name: link.displayName,
              relativePath: link.relativePath,
              revision: '',
              draftText: '',
              initialText: '',
              previewData: { mime: preview.mime, base64: preview.base64 },
            };

            setOpenFiles((prev) => [...prev, newTab]);
            setActiveFileId(link.entryId);
          } catch {
            const errObj = err as { message?: string };
            setFileError(errObj?.message || `Failed to open file: ${link.displayName}`);
          }
        }
      } catch (err: unknown) {
        const errObj = err as { message?: string };
        setFileError(errObj?.message || `Could not open ${req.candidate}`);
      } finally {
        setLoadingContent(false);
      }
    },
    [currentWsId, onSelectWorkspace, openFiles]
  );

  const handleOpenFile = useCallback(
    async (entry: FilesEntry, parentPath = '') => {
      const relPath = parentPath ? `${parentPath}/${entry.displayName}` : entry.displayName;
      await openCandidate({
        candidate: relPath,
        workspaceId: currentWsId,
        collapseTree: false,
      });
    },
    [currentWsId, openCandidate]
  );

  // Listen to navigation bus for file preview requests (from terminal, chat, etc.)
  useEffect(() => {
    const pending = consumePendingFilePreview();
    if (pending) {
      void openCandidate(pending);
    }

    const handleFilePreviewEvent = (e: Event) => {
      const customEvent = e as CustomEvent<FilePreviewRequest>;
      if (customEvent.detail) {
        void openCandidate(customEvent.detail);
      }
    };

    window.addEventListener(OPEN_RIGHT_DOCK_FILE_EVENT, handleFilePreviewEvent);
    return () => {
      window.removeEventListener(OPEN_RIGHT_DOCK_FILE_EVENT, handleFilePreviewEvent);
    };
  }, [openCandidate]);

  const handleCloseTab = (entryIdToClose: string) => {
    setOpenFiles((prev) => {
      const filtered = prev.filter((f) => f.entryId !== entryIdToClose);
      if (activeFileId === entryIdToClose) {
        const nextActive = filtered.length > 0 ? filtered[filtered.length - 1].entryId : null;
        setActiveFileId(nextActive);
      }
      return filtered;
    });
  };

  const handleSave = useCallback(async () => {
    if (!currentWsId || !resourceId || !activeTab) return;

    setIsSaving(true);
    setFileError(null);

    try {
      const hexRevision = await toHex64String(activeTab.revision, activeTab.initialText);
      if (!isValidRevision64(hexRevision)) {
        throw new Error('expectedRevision must be a valid 64-character hexadecimal SHA-256 string.');
      }

      const saved = await invokeCommand<FilesTextResponse>('save_files_text', {
        supportedSchemaVersion: 1,
        workspaceId: currentWsId,
        resourceId,
        entryId: activeTab.entryId,
        expectedRevision: hexRevision,
        text: activeTab.draftText,
      });

      const updatedRevision =
        saved.revision && isValidRevision64(saved.revision) ? saved.revision : hexRevision;

      setOpenFiles((prev) =>
        prev.map((f) =>
          f.entryId === activeTab.entryId
            ? {
                ...f,
                initialText: f.draftText,
                revision: updatedRevision,
              }
            : f
        )
      );

      setStatusMessage('File saved');
      setTimeout(() => setStatusMessage(null), 2500);
      void refreshGit(currentWsId);
    } catch (err: unknown) {
      const errObj = err as { message?: string };
      setFileError(errObj?.message || 'Failed to save file. Revision conflict or permission issue.');
    } finally {
      setIsSaving(false);
    }
  }, [currentWsId, resourceId, activeTab, refreshGit]);

  // Keyboard Shortcuts & AutoSave
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        if (activeTab && isModified && !isSaving) {
          e.preventDefault();
          void handleSave();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTab, isModified, isSaving, handleSave]);

  useEffect(() => {
    if (!autoSave || !isModified || isSaving || !activeTab) return;
    const timer = setTimeout(() => {
      void handleSave();
    }, 1200);
    return () => clearTimeout(timer);
  }, [autoSave, isModified, isSaving, activeTab?.draftText, handleSave]);

  // Splitter Resizing
  const handleSplitterPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    const startX = e.clientX;
    const startWidth = treeWidth;

    const handlePointerMove = (moveEvt: PointerEvent) => {
      if (!isResizingRef.current) return;
      const delta = moveEvt.clientX - startX;
      setTreeWidth(Math.max(150, Math.min(460, startWidth + delta)));
    };

    const handlePointerUp = () => {
      isResizingRef.current = false;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  // Breadcrumbs
  const breadcrumbSegments: BreadcrumbSegment[] = useMemo(() => {
    const rootName = activeWorkspace?.name || (rootEntry ? rootEntry.displayName : 'Workspace');
    const rootSeg: BreadcrumbSegment = {
      name: rootName,
      path: '',
      entryId: rootEntry?.entryId,
      isFolder: true,
      isFile: false,
    };

    const targetPath = activeTab ? activeTab.relativePath : activeFolderPath;
    if (!targetPath) return [rootSeg];

    const parts = targetPath.split('/').filter(Boolean);
    const segs: BreadcrumbSegment[] = [rootSeg];

    let accumulated = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      accumulated = accumulated ? `${accumulated}/${part}` : part;
      const isLast = i === parts.length - 1;
      const isFile = isLast && activeTab !== null && activeTab.relativePath === targetPath;
      const segEntryId = pathToEntryId.get(accumulated);

      segs.push({
        name: part,
        path: accumulated,
        entryId: segEntryId,
        isFolder: !isFile,
        isFile,
      });
    }

    return segs;
  }, [activeWorkspace, rootEntry, activeTab, activeFolderPath, pathToEntryId]);

  const handleBreadcrumbClick = (seg: BreadcrumbSegment) => {
    if (seg.isFile && activeTab) {
      setActiveFileId(activeTab.entryId);
      return;
    }
    if (seg.path === '') {
      setActiveFolderPath('');
      if (rootEntry && !expandedFolders.has(rootEntry.entryId)) {
        setExpandedFolders((prev) => new Set(prev).add(rootEntry.entryId));
      }
      return;
    }
    const folderEntryId = seg.entryId || pathToEntryId.get(seg.path);
    if (folderEntryId) {
      void handleToggleFolder(folderEntryId, seg.path);
    }
  };

  if (!currentWsId) {
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
                    localStorage.setItem('bmone.selectedWorkspaceId', ws.id);
                  } catch {}
                  setCurrentWsId(ws.id);
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
  }

  return (
    <div
      className="_panel files-pane"
      data-testid="side-files"
    >
      {/* Authentic Toolbar (_toolbar) */}
      <FilesToolbar
        currentWsId={currentWsId}
        activeWorkspaceName={activeWorkspace?.name}
        workspacesList={workspacesList}
        mode={mode}
        showTree={showTree}
        canToggleTree={mode === 'files' && openFiles.length > 0}
        gitChanges={gitChanges}
        gitBusy={gitBusy}
        loading={loading || gitLoading}
        statusMessage={statusMessage}
        errorMessage={errorMessage}
        onToggleTree={() => setShowTree((prev) => !prev)}
        onModeChange={setMode}
        onSelectWorkspace={(wsId) => {
          try {
            localStorage.setItem('bmone.selectedWorkspaceId', wsId);
          } catch {}
          if (onSelectWorkspace) {
            onSelectWorkspace(wsId);
          }
          setCurrentWsId(wsId);
        }}
        onPull={() => void handlePull()}
        onPush={() => void handlePush()}
        onRefresh={() => {
          if (currentWsId) {
            void initWorkspaceFiles(currentWsId);
            void refreshGit(currentWsId);
          }
        }}
      />

      {/* Main View Body */}
      {mode === 'changes' ? (
        <ChangesView
          workspaceName={activeWorkspace?.name}
          changes={gitChanges}
          loading={gitLoading}
          error={gitError}
          selectedPath={selectedDiffPath}
          diff={diffData}
          diffLoading={diffLoading}
          diffError={diffError}
          busy={gitBusy}
          writeError={gitWriteError}
          commitDraft={commitDraft}
          onCommitDraftChange={setCommitDraft}
          onSelectPath={(path) =>
            setSelectedDiffPath((prev) => (prev === path ? null : path))
          }
          onOpenPreview={(relPath) => {
            setMode('files');
            const name = relPath.split('/').pop() || relPath;
            const parent = relPath.includes('/')
              ? relPath.slice(0, relPath.lastIndexOf('/'))
              : '';
            void handleOpenFile(
              { entryId: relPath, displayName: name, kind: 'file' },
              parent
            );
          }}
          onToggleStage={handleToggleStage}
          onStageAll={() => void handleStageAll()}
          onUnstageAll={() => void handleUnstageAll()}
          onDiscardChanges={(file) => void handleDiscardChanges(file)}
          onCommit={(msg, stageAll) => void handleCommit(msg, stageAll)}
          onClearWriteError={() => setGitWriteError(null)}
        />
      ) : (
        <div
          className="files-workspace"
          onClick={(event) => {
            const target = event.target as HTMLElement | null;
            if (!target?.closest('.files-code-text')) return;
            const raw = target.textContent ?? '';
            const url = externalUrlFromToken(raw);
            if (url) {
              event.preventDefault();
              void invokeCommand('open_external_link', { url }).catch(() => {});
              return;
            }
            const candidate = pathCandidateFromToken(raw);
            if (!candidate || !currentWsId) return;
            const parent = candidate.includes('/')
              ? candidate.slice(0, candidate.lastIndexOf('/'))
              : '';
            const name = candidate.split('/').pop() || candidate;
            void handleOpenFile({ entryId: candidate, displayName: name, kind: 'file' }, parent);
          }}
        >
          {/* Hierarchical Tree Panel */}
          {showTree && (
            <FilesTreePanel
              rootEntry={rootEntry}
              folderChildren={folderChildren}
              expandedFolders={expandedFolders}
              loadingFolders={loadingFolders}
              activeFileId={activeFileId}
              currentWsId={currentWsId}
              resourceId={resourceId}
              loading={loading}
              treeWidth={treeWidth}
              onToggleFolder={handleToggleFolder}
              onOpenFile={handleOpenFile}
              onSplitterPointerDown={handleSplitterPointerDown}
            />
          )}

          {/* Code Editor and Viewer Pane */}
          <div className="files-main">
            {/* Hierarchical Breadcrumbs (visible when tree navigation is active) */}
            {showTree && (
              <nav
                aria-label="Breadcrumbs"
                className="files-breadcrumbs"
              >
                {breadcrumbSegments.map((seg, idx) => {
                  const isLast = idx === breadcrumbSegments.length - 1;
                  return (
                    <React.Fragment key={seg.path || 'root'}>
                      {idx > 0 && <span className="files-breadcrumb-sep">/</span>}
                      <button
                        type="button"
                        className={`files-breadcrumb-btn${isLast ? ' active' : ''}`}
                        onClick={() => handleBreadcrumbClick(seg)}
                        title={seg.path || seg.name}
                      >
                        {seg.name}
                      </button>
                    </React.Fragment>
                  );
                })}
              </nav>
            )}

            <CodeEditorPane
              openFiles={openFiles}
              activeFileId={activeFileId}
              activeTab={activeTab}
              isModified={isModified}
              isSaving={isSaving}
              autoSave={autoSave}
              isEditMode={isEditMode}
              fileError={fileError}
              loadingContent={loadingContent}
              targetLine={targetLine}
              workspaceId={currentWsId}
              onSelectTab={(id) => {
                setActiveFileId(id);
                setTargetLine(null);
              }}
              onCloseTab={handleCloseTab}
              onSave={() => void handleSave()}
              onToggleAutoSave={setAutoSave}
              onToggleEditMode={() => setIsEditMode(!isEditMode)}
              onNavigateInternalFile={(internalPath) => {
                void openCandidate({
                  candidate: internalPath,
                  workspaceId: currentWsId,
                  collapseTree: true,
                });
              }}
              onDiscardAndReload={() => {
                if (activeTab) {
                  setOpenFiles((prev) =>
                    prev.map((f) =>
                      f.entryId === activeTab.entryId ? { ...f, draftText: f.initialText } : f
                    )
                  );
                }
              }}
              onReloadFromDisk={() => {
                if (activeTab) {
                  void handleOpenFile({
                    entryId: activeTab.entryId,
                    displayName: activeTab.name,
                    kind: 'file',
                  });
                }
              }}
              onDraftChange={(newText) => {
                if (activeTab) {
                  setOpenFiles((prev) =>
                    prev.map((f) =>
                      f.entryId === activeTab.entryId ? { ...f, draftText: newText } : f
                    )
                  );
                }
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
};
