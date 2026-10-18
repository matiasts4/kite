import React, { useRef, useEffect } from 'react';
import {
  SaveIcon,
  RotateCcwIcon,
  AlertCircleIcon,
  CloseIcon,
  FileTextIcon,
  EyeIcon,
  PencilIcon,
  CodeIcon,
} from './FileIcons';
import { tokenizeLine } from './syntax';
import { MarkdownPreviewPane } from './MarkdownPreviewPane';

export interface OpenFileTab {
  entryId: string;
  name: string;
  relativePath: string;
  revision: string;
  draftText: string;
  initialText: string;
  encoding?: string;
  lineEnding?: string;
  previewData?: { mime: string; base64: string } | null;
  isPreview?: boolean;
}

interface CodeEditorPaneProps {
  openFiles: OpenFileTab[];
  activeFileId: string | null;
  activeTab: OpenFileTab | null;
  isModified: boolean;
  isSaving: boolean;
  autoSave: boolean;
  isEditMode: boolean;
  fileError: string | null;
  loadingContent: boolean;
  targetLine?: number | null;
  workspaceId?: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onSave: () => void;
  onToggleAutoSave: (val: boolean) => void;
  onToggleEditMode: () => void;
  onDiscardAndReload: () => void;
  onReloadFromDisk: () => void;
  onDraftChange: (text: string) => void;
  onNavigateInternalFile?: (path: string) => void;
}

export const CodeEditorPane: React.FC<CodeEditorPaneProps> = ({
  openFiles: _openFiles,
  activeFileId: _activeFileId,
  activeTab,
  isModified,
  isSaving,
  autoSave,
  isEditMode,
  fileError,
  loadingContent,
  targetLine,
  workspaceId,
  onSelectTab: _onSelectTab,
  onCloseTab,
  onSave,
  onToggleAutoSave,
  onToggleEditMode,
  onDiscardAndReload,
  onReloadFromDisk,
  onDraftChange,
  onNavigateInternalFile,
}) => {
  const gutterRef = useRef<HTMLPreElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeLineRef = useRef<HTMLDivElement | null>(null);

  // Check if current active tab is a Markdown file
  const isMarkdown = Boolean(
    activeTab && /\.(md|mdx|markdown)$/i.test(activeTab.name)
  );

  // Local state for Markdown view mode: 'preview' (rendered) vs 'code' (raw tokenized)
  const [mdViewMode, setMdViewMode] = React.useState<'preview' | 'code'>('preview');

  // Scroll to target line when provided; if markdown and targetLine is set, switch to code view
  useEffect(() => {
    if (targetLine && targetLine > 0) {
      if (isMarkdown) {
        setMdViewMode('code');
      }
      if (activeLineRef.current) {
        activeLineRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }, [targetLine, activeTab?.entryId, isMarkdown]);

  const handleTextareaScroll = () => {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  if (!activeTab) {
    return (
      <div className="files-empty-state">
        <FileTextIcon size={36} className="files-empty-icon" />
        {fileError ? (
          <div style={{ color: 'var(--accent-danger, #e06c75)', marginTop: '8px', textAlign: 'center', maxWidth: '320px', fontSize: '12px' }}>
            {fileError}
          </div>
        ) : (
          <span>Select a file from the explorer to view or edit</span>
        )}
      </div>
    );
  }

  const lines = activeTab.draftText.split(/\r?\n/);
  const lineCount = lines.length;

  return (
    <div className="files-editor">
      {/* Editor Toolbar (Single Unified Row) */}
      <div className="files-editor-toolbar" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        {!isEditMode ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, flex: '1 1 auto', overflow: 'hidden' }}>
              {isModified && <span className="files-tab-dot" title="Modified" />}
              <span
                className="files-current-name"
                title={activeTab.relativePath}
                style={{
                  fontWeight: 500,
                  fontSize: '12px',
                  color: 'var(--text-primary)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  fontStyle: activeTab.isPreview ? 'italic' : undefined,
                }}
              >
                {activeTab.name}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(activeTab.entryId);
                }}
                className="files-tab-close"
                aria-label={`Close ${activeTab.name}`}
                title={`Close ${activeTab.name}`}
                style={{
                  padding: '2px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                }}
              >
                <CloseIcon size={10} />
              </button>
              <span className="files-doc-status" style={{ fontSize: '11px', color: 'var(--text-muted, #888)', whiteSpace: 'nowrap', marginLeft: '2px' }}>
                {activeTab.previewData
                  ? activeTab.previewData.mime.startsWith('image/')
                    ? `Image (${activeTab.previewData.mime.replace('image/', '').replace('+xml', '').toUpperCase()})`
                    : activeTab.previewData.mime === 'application/pdf'
                    ? 'PDF Document'
                    : 'Preview'
                  : isMarkdown
                  ? mdViewMode === 'preview'
                    ? 'Preview'
                    : 'Markdown Source'
                  : `${lineCount} lines`}
              </span>
            </div>

            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
              {isMarkdown && (
                <div
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    background: 'var(--chip-fill, rgba(255,255,255,0.06))',
                    borderRadius: 'var(--radius-chip, 4px)',
                    padding: '2px',
                    gap: '2px',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setMdViewMode('preview')}
                    className={`files-toolbar-btn ${mdViewMode === 'preview' ? 'active' : ''}`}
                    title="View formatted markdown"
                    style={{
                      height: '24px',
                      padding: '0 8px',
                      fontSize: '11px',
                      background: mdViewMode === 'preview' ? 'var(--hover-fill, rgba(255,255,255,0.12))' : 'transparent',
                    }}
                  >
                    <EyeIcon size={12} />
                    <span>Rendered</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setMdViewMode('code')}
                    className={`files-toolbar-btn ${mdViewMode === 'code' ? 'active' : ''}`}
                    title="View raw markdown"
                    style={{
                      height: '24px',
                      padding: '0 8px',
                      fontSize: '11px',
                      background: mdViewMode === 'code' ? 'var(--hover-fill, rgba(255,255,255,0.12))' : 'transparent',
                    }}
                  >
                    <CodeIcon size={12} />
                    <span>Source</span>
                  </button>
                </div>
              )}

              {!activeTab.previewData && (
                <button
                  type="button"
                  onClick={onToggleEditMode}
                  className="files-toolbar-btn"
                  title="Edit this file"
                  style={{
                    height: '26px',
                    padding: '0 10px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '5px',
                    background: 'var(--accent-tint, rgba(59, 130, 246, 0.15))',
                    color: 'var(--accent, #3b82f6)',
                    borderRadius: 'var(--radius-chip, 4px)',
                    fontWeight: '500',
                  }}
                >
                  <PencilIcon size={11} />
                  <span>Edit</span>
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: '1 1 auto', overflow: 'hidden' }}>
              {isModified && <span className="files-tab-dot" title="Modified" />}
              <span
                className="files-current-name"
                title={activeTab.relativePath}
                style={{
                  fontWeight: 500,
                  fontSize: '12px',
                  color: 'var(--text-primary)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {activeTab.name}
              </span>
              <button
                type="button"
                disabled={!isModified || isSaving}
                onClick={onSave}
                className="files-toolbar-btn files-save-btn"
                title="Save changes (Ctrl+S)"
              >
                <SaveIcon size={12} />
                <span>{isSaving ? 'Saving…' : 'Save'}</span>
              </button>

              <span role="status" className="files-doc-status" style={{ fontSize: '11px', whiteSpace: 'nowrap' }}>
                {isModified ? 'Unsaved' : 'Saved'} · {activeTab.encoding || 'UTF-8'} ·{' '}
                {(activeTab.lineEnding || 'LF').toUpperCase()}
              </span>

              <label className="files-autosave-toggle">
                <input
                  type="checkbox"
                  checked={autoSave}
                  onChange={(e) => onToggleAutoSave(e.target.checked)}
                />
                <span>Auto-save</span>
              </label>

              {isModified && !isSaving && (
                <button
                  type="button"
                  onClick={onDiscardAndReload}
                  className="files-toolbar-btn"
                >
                  Discard
                </button>
              )}

              <button
                type="button"
                onClick={onReloadFromDisk}
                className="files-toolbar-btn"
                title="Reload from disk"
              >
                <RotateCcwIcon size={12} className={loadingContent ? 'icon-spin' : ''} />
                <span>Reload</span>
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <button
                type="button"
                onClick={onToggleEditMode}
                className="files-toolbar-btn"
                title="Exit edit mode and view preview"
                style={{
                  height: '26px',
                  padding: '0 10px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                  background: 'var(--hover-fill, rgba(255,255,255,0.08))',
                  borderRadius: 'var(--radius-chip, 4px)',
                }}
              >
                <EyeIcon size={12} />
                <span>Done</span>
              </button>
            </div>
          </>
        )}
      </div>

      {fileError && (
        <p className="files-editor-error" role="alert">
          <AlertCircleIcon size={13} className="files-editor-error-icon" />
          {fileError}
        </p>
      )}

      {/* Content Surface */}
      {activeTab.previewData ? (
        <div className="files-binary-preview">
          {activeTab.previewData.mime.startsWith('image/') ? (
            <img
              src={`data:${activeTab.previewData.mime};base64,${activeTab.previewData.base64}`}
              alt={activeTab.name}
              className="files-preview-image"
            />
          ) : activeTab.previewData.mime === 'application/pdf' ? (
            <iframe
              src={`data:application/pdf;base64,${activeTab.previewData.base64}`}
              title={activeTab.name}
              className="files-preview-pdf"
            />
          ) : (
            <div className="files-preview-generic">
              <FileTextIcon size={48} className="files-empty-icon" />
              <p>Preview available ({activeTab.previewData.mime})</p>
            </div>
          )}
        </div>
      ) : isEditMode ? (
        <div className="files-edit-area">
          <pre
            ref={gutterRef}
            aria-hidden="true"
            className="files-edit-gutter"
          >
            {Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}
          </pre>
          <div className="files-edit-surface">
            <textarea
              ref={textareaRef}
              className="files-edit-text"
              value={activeTab.draftText}
              onChange={(e) => onDraftChange(e.target.value)}
              onScroll={handleTextareaScroll}
              spellCheck={false}
              wrap="off"
            />
          </div>
        </div>
      ) : isMarkdown && mdViewMode === 'preview' ? (
        <MarkdownPreviewPane
          text={activeTab.draftText}
          relativePath={activeTab.relativePath}
          workspaceId={workspaceId}
          onNavigateInternalFile={onNavigateInternalFile}
        />
      ) : (
        <div className="files-code-scroll">
          <div className="files-code">
            <div aria-hidden="true" className="files-gutter">
              {lines.map((_, idx) => (
                <span
                  key={idx}
                  className={`files-gutter-line ${targetLine === idx + 1 ? 'files-gutter-line--active' : ''}`}
                >
                  {idx + 1}
                </span>
              ))}
            </div>
            <pre className="files-code-text">
              {lines.map((line, lIdx) => {
                const lineNum = lIdx + 1;
                const isTarget = targetLine === lineNum;
                return (
                  <div
                    key={lIdx}
                    ref={isTarget ? activeLineRef : undefined}
                    className={`files-code-line ${isTarget ? 'files-code-line--active' : ''}`}
                    style={isTarget ? { backgroundColor: 'var(--accent-tint, rgba(59, 130, 246, 0.2))' } : undefined}
                  >
                    {tokenizeLine(line).map((tok, tIdx) => (
                      <span key={tIdx} className={tok.className}>
                        {tok.text}
                      </span>
                    ))}
                  </div>
                );
              })}
            </pre>
          </div>
        </div>
      )}

      <footer className="files-status-bar">
        <span className="files-status-path" title={activeTab.relativePath}>
          {activeTab.relativePath}
        </span>
        <div className="files-status-meta">
          {activeTab.revision && (
            <span
              className="files-status-rev"
              title={`Revision: ${activeTab.revision}`}
            >
              rev:{activeTab.revision.slice(0, 8)}…
            </span>
          )}
          <span className="files-status-position">
            {lineCount} {lineCount === 1 ? 'line' : 'lines'} · {activeTab.name}
          </span>
        </div>
      </footer>
    </div>
  );
};
