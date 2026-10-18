import React, { useState, useEffect, useRef, useCallback } from 'react';
import { invokeCommand } from '../../../lib/ipc';
import { UnifiedDiffView } from './UnifiedDiffView';
import {
  CloseIcon,
  DiffIcon,
  FileCodeIcon,
  FolderIcon,
  GlobeIcon,
  RefreshIcon,
} from './ChatIcons';
import type { DiffData } from './types';

export interface InspectorTab {
  id: string;
  kind: 'files' | 'changes' | 'browser' | 'file';
  title: string;
  path?: string[];
  url?: string;
  line?: number;
}

export interface ThreadInspectorProps {
  threadId: string;
  workspaceId: string | null;
  workspaceName?: string;
  isOpen: boolean;
  onClose: () => void;
  width?: number;
  onWidthChange?: (width: number) => void;
  initialTab?: 'files' | 'changes' | 'browser';
  initialFilePath?: string;
}

interface WorkspaceFileEntry {
  path: string;
  isDirectory: boolean;
  byteSize?: number;
}

interface ChangedFileEntry {
  path: string;
  status: string;
  staged?: boolean;
}

export const ThreadInspector: React.FC<ThreadInspectorProps> = ({
  threadId: _threadId,
  workspaceId,
  workspaceName: _workspaceName,
  isOpen,
  onClose,
  width: controlledWidth,
  onWidthChange,
  initialTab = 'changes',
  initialFilePath,
}) => {
  const [tabs, setTabs] = useState<InspectorTab[]>(() => [
    { id: initialTab, kind: initialTab, title: initialTab === 'changes' ? 'Changes' : initialTab === 'files' ? 'Files' : 'Browser' },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>(initialTab);
  const [width, setWidth] = useState<number>(() => controlledWidth ?? 440);

  // Files tab state
  const [fileList, setFileList] = useState<WorkspaceFileEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [openedFileContent, setOpenedFileContent] = useState<string | null>(null);
  const [openedFilePath, setOpenedFilePath] = useState<string | null>(initialFilePath ?? null);

  // Changes tab state
  const [changesList, setChangesList] = useState<ChangedFileEntry[]>([]);
  const [_changesLoading, setChangesLoading] = useState(false);
  const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);
  const [fileDiffData, setFileDiffData] = useState<DiffData | null>(null);

  // Browser tab state
  const [browserUrl, setBrowserUrl] = useState<string>('http://localhost:3000');
  const [urlInput, setUrlInput] = useState<string>('http://localhost:3000');

  // Resize drag ref
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  // Sync width prop if controlled
  useEffect(() => {
    if (controlledWidth && controlledWidth !== width) {
      setWidth(controlledWidth);
    }
  }, [controlledWidth]);

  // Load changes when activeTab is changes
  const loadChanges = useCallback(async () => {
    if (!workspaceId) return;
    setChangesLoading(true);
    try {
      const res = await invokeCommand<{ files?: ChangedFileEntry[] }>('read_workspace_changes', { workspaceId });
      if (res?.files) {
        setChangesList(res.files);
      }
    } catch {
      // ignore
    } finally {
      setChangesLoading(false);
    }
  }, [workspaceId]);

  // Load workspace files when activeTab is files
  const loadFiles = useCallback(async () => {
    if (!workspaceId) return;
    setFilesLoading(true);
    try {
      const res = await invokeCommand<{ entries?: WorkspaceFileEntry[] }>('list_files_directory', {
        workspaceId,
        path: '',
      });
      if (res?.entries) {
        setFileList(res.entries);
      }
    } catch {
      // ignore
    } finally {
      setFilesLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (!isOpen) return;
    if (activeTab?.kind === 'changes') {
      void loadChanges();
    } else if (activeTab?.kind === 'files') {
      void loadFiles();
    }
  }, [isOpen, activeTab?.kind, loadChanges, loadFiles]);

  // Load diff when file selected
  useEffect(() => {
    if (!workspaceId || !selectedDiffPath) {
      setFileDiffData(null);
      return;
    }
    let cancelled = false;
    invokeCommand<DiffData>('read_workspace_file_diff', {
      workspaceId,
      path: selectedDiffPath,
    })
      .then((diff) => {
        if (!cancelled && diff?.lines) setFileDiffData(diff);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId, selectedDiffPath]);

  // Load file content when opened
  useEffect(() => {
    if (!workspaceId || !openedFilePath) {
      setOpenedFileContent(null);
      return;
    }
    let cancelled = false;
    invokeCommand<{ text?: string }>('read_files_text', {
      workspaceId,
      path: openedFilePath,
    })
      .then((res) => {
        if (!cancelled && typeof res?.text === 'string') {
          setOpenedFileContent(res.text);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId, openedFilePath]);

  const handleOpenTab = (kind: 'files' | 'changes' | 'browser') => {
    const existing = tabs.find((t) => t.kind === kind);
    if (existing) {
      setActiveTabId(existing.id);
    } else {
      const newTab: InspectorTab = {
        id: kind,
        kind,
        title: kind === 'changes' ? 'Changes' : kind === 'files' ? 'Files' : 'Browser',
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
    }
  };

  const handleOpenFile = (path: string) => {
    const fileName = path.split('/').pop() || path;
    const tabId = `file:${path}`;
    const existing = tabs.find((t) => t.id === tabId);
    if (existing) {
      setActiveTabId(existing.id);
    } else {
      const newTab: InspectorTab = {
        id: tabId,
        kind: 'file',
        title: fileName,
        path: [path],
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(tabId);
    }
    setOpenedFilePath(path);
  };

  const handleCloseTab = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const remaining = tabs.filter((t) => t.id !== id);
    if (remaining.length === 0) {
      onClose();
      return;
    }
    setTabs(remaining);
    if (activeTabId === id) {
      setActiveTabId(remaining[remaining.length - 1].id);
    }
  };

  // Resize handler
  const handlePointerDownResize = (e: React.PointerEvent) => {
    resizeRef.current = { startX: e.clientX, startWidth: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMoveResize = (e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    const delta = resizeRef.current.startX - e.clientX;
    const nextWidth = Math.max(320, Math.min(800, resizeRef.current.startWidth + delta));
    setWidth(nextWidth);
    onWidthChange?.(nextWidth);
  };

  const handlePointerUpResize = () => {
    resizeRef.current = null;
  };

  if (!isOpen) return null;

  return (
    <aside
      className="thread-inspector"
      style={{ width }}
      aria-label="Thread inspector"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      {/* Width Resize Handle */}
      <hr
        className="inspector-resize"
        aria-orientation="vertical"
        aria-label="Inspector width"
        tabIndex={0}
        onPointerDown={handlePointerDownResize}
        onPointerMove={handlePointerMoveResize}
        onPointerUp={handlePointerUpResize}
        onPointerCancel={handlePointerUpResize}
      />

      {/* Tabs Header */}
      <div className="inspector-tabs">
        <div className="inspector-tablist" role="tablist" aria-label="Inspector tabs">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className="inspector-tab"
              data-active={tab.id === activeTabId}
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab.id === activeTabId}
                tabIndex={tab.id === activeTabId ? 0 : -1}
                onClick={() => setActiveTabId(tab.id)}
                title={tab.title}
              >
                {tab.title}
              </button>
            </div>
          ))}
        </div>

        {activeTab && (
          <button
            type="button"
            aria-label={`Close ${activeTab.title}`}
            onClick={(e) => handleCloseTab(activeTab.id, e)}
            title="Close tab"
          >
            <CloseIcon size={12} />
          </button>
        )}

        <button
          className="inspector-hide"
          type="button"
          aria-label="Hide inspector"
          onClick={onClose}
          title="Hide inspector"
        >
          <CloseIcon size={14} />
        </button>
      </div>

      {/* Add Tab Actions */}
      <section className="inspector-actions" aria-label="Add inspector tab">
        <button
          type="button"
          disabled={!workspaceId}
          onClick={() => handleOpenTab('files')}
        >
          <FolderIcon size={12} />
          Files
        </button>
        <button
          type="button"
          disabled={!workspaceId}
          onClick={() => handleOpenTab('changes')}
        >
          <DiffIcon size={12} />
          Changes
        </button>
        <button
          type="button"
          disabled={!workspaceId}
          onClick={() => handleOpenTab('browser')}
        >
          <GlobeIcon size={12} />
          Browser
        </button>
      </section>

      {/* Tab Body */}
      {!workspaceId ? (
        <div className="inspector-notice">
          Add or reconnect this thread’s folder to review its files.
        </div>
      ) : activeTab?.kind === 'changes' ? (
        <div className="changes-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {selectedDiffPath && fileDiffData ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid var(--separator)' }}>
                <span style={{ fontSize: 'var(--text-row)', fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>
                  {selectedDiffPath}
                </span>
                <button
                  type="button"
                  className="chrome-button"
                  onClick={() => setSelectedDiffPath(null)}
                >
                  Back to list
                </button>
              </div>
              <section className="changes-panel__diff-scroll" style={{ flex: 1, overflow: 'auto' }}>
                <UnifiedDiffView diff={fileDiffData} />
              </section>
            </div>
          ) : changesList.length > 0 ? (
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px', fontSize: 'var(--text-caption)', color: 'var(--text-secondary)' }}>
                <span>Uncommitted changes ({changesList.length})</span>
                <button type="button" onClick={() => void loadChanges()} title="Refresh changes">
                  <RefreshIcon size={12} />
                </button>
              </div>
              {changesList.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  className="changed-file-row"
                  onClick={() => setSelectedDiffPath(file.path)}
                  style={{
                    textAlign: 'left',
                    width: '100%',
                    padding: '6px 8px',
                    borderRadius: 'var(--radius-chip)',
                    fontSize: 'var(--text-caption)',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-primary)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    background: 'var(--block-fill)',
                    border: '1px solid var(--block-stroke)',
                    marginBottom: '4px',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {file.path}
                  </span>
                  <span style={{ fontSize: 'var(--text-badge)', color: 'var(--warning-text)' }}>
                    {file.status}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="inspector-notice">
              <DiffIcon size={20} />
              <span>Workspace is clean — no uncommitted changes.</span>
            </div>
          )}
        </div>
      ) : activeTab?.kind === 'files' ? (
        <div className="inspector-files" style={{ flex: 1, overflowY: 'auto' }}>
          {fileList.length > 0 ? (
            <div className="inspector-file-list">
              {fileList.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => {
                    if (!entry.isDirectory) {
                      handleOpenFile(entry.path);
                    }
                  }}
                >
                  {entry.isDirectory ? <FolderIcon size={13} /> : <FileCodeIcon size={13} />}
                  <span>{entry.path}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="inspector-notice">
              {filesLoading ? 'Scanning files…' : 'No files found in workspace.'}
            </div>
          )}
        </div>
      ) : activeTab?.kind === 'file' ? (
        <div className="inspector-files" style={{ flex: 1, overflow: 'auto' }}>
          {openedFileContent !== null ? (
            <textarea
              readOnly
              className="inspector-code"
              value={openedFileContent}
              aria-label={activeTab.title}
            />
          ) : (
            <div className="inspector-notice">Reading file…</div>
          )}
        </div>
      ) : activeTab?.kind === 'browser' ? (
        <div className="inspector-browser" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <form
            className="inspector-toolbar"
            onSubmit={(e) => {
              e.preventDefault();
              setBrowserUrl(urlInput);
            }}
          >
            <input
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="http://localhost:3000"
            />
            <button type="submit">Go</button>
          </form>
          <div style={{ flex: 1, minHeight: 0 }}>
            <iframe
              src={browserUrl}
              title="Browser inspector"
              style={{ width: '100%', height: '100%', border: 'none' }}
              sandbox="allow-scripts allow-same-origin allow-forms"
            />
          </div>
        </div>
      ) : null}
    </aside>
  );
};
