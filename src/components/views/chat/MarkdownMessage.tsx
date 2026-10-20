import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CheckIcon, CopyIcon } from './ChatIcons';
import { openFileInRightDock } from '../../../lib/filePreviewNav';

function isFilePathCandidate(text: string): boolean {
  let trimmed = text.trim();
  if (!trimmed || trimmed.length > 1024 || /[\r\n]/.test(trimmed)) return false;
  trimmed = trimmed.replace(/^['"`]+|['"`]+$/g, '').trim();
  if (!trimmed) return false;
  if (/^https?:\/\//i.test(trimmed)) return false;
  if (/^file:\/\//i.test(trimmed)) return true;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true;
  if (/^(\.{1,2}[\\/]|[a-zA-Z0-9_@.-]+[\\/])/.test(trimmed)) return true;
  if (/^[a-zA-Z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|mdx|rs|toml|css|scss|html|py|go|ya?ml|sh|bat|cmd|sql|xml|env|log|png|jpe?g|gif|webp|svg|ico|bmp|tiff?|avif|pdf)(?::\d+(?::\d+)?)?$/i.test(trimmed)) return true;
  return false;
}

const PATH_REGEX = /((?:file:\/\/[^\s"'`<>]+|[a-zA-Z]:[\\/][^\s"'`<>()]+|(?:\.{1,2}[\\/]|[a-zA-Z0-9_@.-]+[\\/])[^\s"'`<>()]+|[a-zA-Z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|mdx|rs|toml|css|scss|html|py|go|ya?ml|sh|bat|cmd|sql|xml|env|log|png|jpe?g|gif|webp|svg|ico|bmp|tiff?|avif|pdf)(?::\d+(?::\d+)?)?))/gi;

function renderPlainTextWithPaths(text: string, baseKey: string | number, workspaceId?: string | null): React.ReactNode {
  const parts = text.split(PATH_REGEX);
  if (parts.length <= 1) return text;
  return parts.map((part, pIdx) => {
    if (isFilePathCandidate(part)) {
      const cleanCandidate = part.replace(/^['"`]+|['"`]+$/g, '').trim();
      return (
        <span
          key={`${baseKey}-p-${pIdx}`}
          className="md-path"
          title="Ctrl + Click para previsualizar archivo"
          onClick={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.button === 0) {
              e.preventDefault();
              e.stopPropagation();
              openFileInRightDock({
                candidate: cleanCandidate,
                workspaceId: workspaceId || null,
                collapseTree: true,
              });
            }
          }}
        >
          {part}
        </span>
      );
    }
    return part;
  });
}

function withPaths(children: React.ReactNode, workspaceId?: string | null): React.ReactNode {
  return React.Children.map(children, (child, i) =>
    typeof child === 'string' ? renderPlainTextWithPaths(child, i, workspaceId) : child
  );
}

const CodeBlock: React.FC<{ lang: string; code: string }> = ({ lang, code }) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-codeblock">
      <div className="md-codeblock__bar">
        <span className="md-codeblock__lang">{lang || 'code'}</span>
        <button
          type="button"
          className="md-codeblock__copy"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? <CheckIcon size={12} style={{ color: 'var(--status-running)' }} /> : <CopyIcon size={12} />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
};

function isFileHref(href: string): boolean {
  return (
    href.startsWith('file://') ||
    href.startsWith('/') ||
    href.startsWith('./') ||
    (href.includes('.') && !href.startsWith('http'))
  );
}

export const MarkdownMessage: React.FC<{ text: string; workspaceId?: string | null }> = ({
  text,
  workspaceId,
}) => {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => url}
        components={{
          p: ({ children }) => <p>{withPaths(children, workspaceId)}</p>,
          li: ({ children }) => <li>{withPaths(children, workspaceId)}</li>,
          td: ({ children }) => <td>{withPaths(children, workspaceId)}</td>,
          th: ({ children }) => <th>{withPaths(children, workspaceId)}</th>,
          blockquote: ({ children }) => <blockquote>{children}</blockquote>,
          table: ({ children }) => (
            <div className="md-table-wrap">
              <table>{children}</table>
            </div>
          ),
          a: ({ href = '', children }) => {
            const isFile = isFileHref(href);
            return (
              <a
                href={href}
                title={isFile ? 'Click para previsualizar archivo' : undefined}
                target={isFile ? undefined : '_blank'}
                rel="noreferrer noopener"
                onClick={(e) => {
                  if (isFile) {
                    e.preventDefault();
                    openFileInRightDock({
                      candidate: href,
                      workspaceId: workspaceId || null,
                      collapseTree: true,
                    });
                  }
                }}
              >
                {children}
              </a>
            );
          },
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            const raw = String(children ?? '');
            const match = /language-([\w-]+)/.exec(className || '');
            const isBlock = Boolean(match) || raw.includes('\n');
            if (isBlock) {
              return <CodeBlock lang={match?.[1] ?? ''} code={raw.replace(/\n$/, '')} />;
            }
            const isPath = isFilePathCandidate(raw);
            return (
              <code
                className={`md-inline-code${isPath ? ' md-inline-code--path' : ''}`}
                title={isPath ? 'Ctrl + Click para previsualizar archivo' : undefined}
                onClick={
                  isPath
                    ? (e) => {
                        if ((e.ctrlKey || e.metaKey) && e.button === 0) {
                          e.preventDefault();
                          e.stopPropagation();
                          openFileInRightDock({
                            candidate: raw,
                            workspaceId: workspaceId || null,
                            collapseTree: true,
                          });
                        }
                      }
                    : undefined
                }
              >
                {raw}
              </code>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
};
