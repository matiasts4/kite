import React, { useMemo, useRef } from 'react';
import { getFileIcon } from './FileIcons';
import { tokenizeLine } from './syntax';

const LANGUAGE_NAMES: Record<string, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  json: 'JSON',
  css: 'CSS',
  html: 'HTML',
  rust: 'Rust',
  markdown: 'Markdown',
  python: 'Python',
  shell: 'Shell',
  plaintext: 'Plain Text',
};

function detectLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
      return 'javascript';
    case 'json':
      return 'json';
    case 'css':
      return 'css';
    case 'html':
      return 'html';
    case 'rs':
      return 'rust';
    case 'md':
      return 'markdown';
    case 'py':
      return 'python';
    case 'sh':
    case 'bash':
      return 'shell';
    default:
      return 'plaintext';
  }
}

export const SidePanelFileView: React.FC<{
  name: string;
  relativePath: string;
  text?: string;
  onClose?: () => void;
  onReload?: () => void;
}> = ({ name, relativePath, text = '', onClose, onReload }) => {
  return (
    <section aria-label={`${name} file`} className="side-panel-file" data-testid="side-panel-file">
      <header className="side-panel-file__header" title={relativePath}>
        <span aria-hidden="true" className="side-panel-file__glyph">
          {getFileIcon(name)}
        </span>
        <span className="side-panel-file__name">{name}</span>
        <span className="side-panel-file__path">{relativePath}</span>
      </header>
      <div className="side-panel-file__body">
        <pre className="files-code-text">
          {text}
        </pre>
        {(onClose || onReload) && (
          <div className="side-panel-file__actions">
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="files-toolbar-btn"
              >
                Close tab
              </button>
            )}
            {onReload && (
              <button
                type="button"
                onClick={onReload}
                className="files-toolbar-btn"
              >
                Reload
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
};

export const FilesCodeView: React.FC<{
  path: string;
  text: string;
  language?: string;
  isEditMode?: boolean;
  onTextChange?: (val: string) => void;
}> = ({ path, text, language, isEditMode = false, onTextChange }) => {
  const langKey = language || detectLanguage(path);
  const langName = LANGUAGE_NAMES[langKey] || 'Plain Text';
  const lines = useMemo(() => text.split(/\r?\n/), [text]);
  const lineCount = lines.length;

  const gutterRef = useRef<HTMLPreElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const handleTextareaScroll = () => {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  return (
    <div className="files-editor-container">
      {isEditMode ? (
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
              value={text}
              onChange={(e) => onTextChange?.(e.target.value)}
              onScroll={handleTextareaScroll}
              spellCheck={false}
              wrap="off"
            />
          </div>
        </div>
      ) : (
        <div className="files-code-scroll">
          <div className="files-code">
            <div
              aria-hidden="true"
              className="files-gutter"
            >
              {lines.map((_, idx) => (
                <span key={idx} className="files-gutter-line">
                  {idx + 1}
                </span>
              ))}
            </div>
            <pre className="files-code-text">
              {lines.map((line, lIdx) => (
                <div key={lIdx} className="files-code-line">
                  {tokenizeLine(line).map((tok, tIdx) => (
                    <span key={tIdx} className={tok.className}>
                      {tok.text}
                    </span>
                  ))}
                </div>
              ))}
            </pre>
          </div>
        </div>
      )}
      <footer className="files-status-bar">
        <span className="files-status-path" title={path}>
          {path}
        </span>
        <span className="files-status-position">
          {lineCount} {lineCount === 1 ? 'line' : 'lines'} · {langName}
        </span>
      </footer>
    </div>
  );
};
