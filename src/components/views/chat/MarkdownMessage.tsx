import React, { useContext, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CheckIcon, CopyIcon } from './ChatIcons';
import { openFileInRightDock } from '../../../lib/filePreviewNav';
import { openSidecarInRightDock, parseSidecarUri } from '../../../lib/sidecarNav';
import { MermaidDiagram } from '../../ui/MermaidDiagram';
import { toast } from '../../../lib/toast';

const MarkdownWorkspaceContext = React.createContext<string | null>(null);
const REMARK_PLUGINS = [remarkGfm];
const identityUrlTransform = (url: string) => url;

function isFilePathCandidate(text: string): boolean {
  let trimmed = text.trim();
  if (!trimmed || trimmed.length > 1024 || /[\r\n]/.test(trimmed)) return false;
  trimmed = trimmed.replace(/^['"`]+|['"`]+$/g, '').trim();
  if (!trimmed) return false;
  if (/^(?:https?|sidecar):\/\//i.test(trimmed)) return false;
  if (/^file:\/\//i.test(trimmed)) return true;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true;
  if (/^(\.{1,2}[\\/]|[a-zA-Z0-9_@.-]+[\\/])/.test(trimmed)) return true;
  if (/^[a-zA-Z0-9_.-]+\.(?:tsx|ts|jsx|json|js|mdx|md|rs|toml|css|scss|html|py|go|ya?ml|sh|bat|cmd|sql|xml|env|log|png|jpe?g|gif|webp|svg|ico|bmp|tiff?|avif|pdf)(?::\d+(?::\d+)?)?$/i.test(trimmed)) return true;
  return false;
}

const PATH_REGEX = /((?:(?:file|sidecar):\/\/[^\s"'`<>]+|[a-zA-Z]:[\\/][^\s"'`<>()]+|(?:\.{1,2}[\\/]|[a-zA-Z0-9_@.-]+[\\/])[^\s"'`<>()]+|[a-zA-Z0-9_.-]+\.(?:tsx|ts|jsx|json|js|mdx|md|rs|toml|css|scss|html|py|go|ya?ml|sh|bat|cmd|sql|xml|env|log|png|jpe?g|gif|webp|svg|ico|bmp|tiff?|avif|pdf)(?::\d+(?::\d+)?)?))/gi;

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
          title="Ctrl + Click to preview file"
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

const TABLE_BR_REGEX = /(<br\s*\/?>)/gi;

/** Converts literal `<br>` tags inside GFM table cells into `<br />` elements while preserving code spans and file-path links. */
function withTableCellFormatting(children: React.ReactNode, workspaceId?: string | null): React.ReactNode {
  return React.Children.map(children, (child, i) => {
    if (typeof child === 'string') {
      if (!/<br\s*\/?>/i.test(child)) {
        return renderPlainTextWithPaths(child, i, workspaceId);
      }
      return child.split(TABLE_BR_REGEX).map((part, pIdx) => {
        if (!part) return null;
        if (/^<br\s*\/?>$/i.test(part)) {
          return <br key={`${i}-br-${pIdx}`} />;
        }
        return renderPlainTextWithPaths(part, `${i}-t-${pIdx}`, workspaceId);
      });
    }
    if (
      React.isValidElement<{ children?: React.ReactNode }>(child) &&
      typeof child.type === 'string' &&
      child.type !== 'code' &&
      child.type !== 'pre' &&
      child.type !== 'a' &&
      child.props.children !== undefined
    ) {
      return React.cloneElement(
        child,
        undefined,
        withTableCellFormatting(child.props.children, workspaceId),
      );
    }
    return child;
  });
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
            void toast.copy(code, `Copied ${lang || 'code'} block`);
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

export function isFileHref(href: string): boolean {
  const trimmed = href.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('sidecar://')) return false;
  return (
    lower.startsWith('file://') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    (trimmed.includes('.') && !lower.startsWith('http'))
  );
}

function extractNodeText(node: React.ReactNode): string | undefined {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    const joined = node.map(extractNodeText).filter(Boolean).join('');
    return joined || undefined;
  }
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return extractNodeText(node.props.children);
  }
  return undefined;
}

// Keep ReactMarkdown component identities stable across renders so updating text or
// toggling citation state never unmounts/remounts paragraph DOM nodes during selection.
const MarkdownP: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const workspaceId = useContext(MarkdownWorkspaceContext);
  return <p>{withPaths(children, workspaceId)}</p>;
};

const MarkdownLi: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const workspaceId = useContext(MarkdownWorkspaceContext);
  return <li>{withPaths(children, workspaceId)}</li>;
};

const MarkdownTd: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const workspaceId = useContext(MarkdownWorkspaceContext);
  return <td>{withTableCellFormatting(children, workspaceId)}</td>;
};

const MarkdownTh: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const workspaceId = useContext(MarkdownWorkspaceContext);
  return <th>{withTableCellFormatting(children, workspaceId)}</th>;
};

const MarkdownBlockquote: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <blockquote>{children}</blockquote>
);

const MarkdownTable: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <div className="md-table-anchor">
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  </div>
);

const MarkdownA: React.FC<{ href?: string; children?: React.ReactNode }> = ({
  href = '',
  children,
}) => {
  const workspaceId = useContext(MarkdownWorkspaceContext);
  const trimmedHref = href.trim();
  if (trimmedHref.toLowerCase().startsWith('sidecar://')) {
    const parsed = parseSidecarUri(trimmedHref);
    const rawLabel = extractNodeText(children)?.trim();
    const cleanTitle =
      rawLabel && !rawLabel.toLowerCase().startsWith('sidecar://') ? rawLabel : undefined;

    return (
      <button
        type="button"
        className="md-sidecar-pill"
        data-sidecar-uri={trimmedHref}
        title={parsed ? `Open ${parsed.sidecarId} (${parsed.viewPath})` : 'Open extension panel'}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!parsed) return;
          openSidecarInRightDock({
            sidecarId: parsed.sidecarId,
            viewPath: parsed.viewPath,
            title: cleanTitle,
            workspaceId: workspaceId || null,
          });
        }}
      >
        <span className="md-sidecar-pill__dot" aria-hidden="true" />
        <span className="md-sidecar-pill__label">{children}</span>
      </button>
    );
  }

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
};

const MarkdownPre: React.FC<{ children?: React.ReactNode }> = ({ children }) => <>{children}</>;

const MarkdownCode: React.FC<{ className?: string; children?: React.ReactNode }> = ({
  className,
  children,
}) => {
  const workspaceId = useContext(MarkdownWorkspaceContext);
  const raw = Array.isArray(children)
    ? children.map((part) => String(part ?? '')).join('')
    : String(children ?? '');
  const match = /language-([\w-]+)/.exec(className || '');
  const lang = (match?.[1] ?? '').toLowerCase();
  const isBlock = Boolean(match) || raw.includes('\n');
  if (isBlock) {
    if (lang === 'mermaid') {
      return <MermaidDiagram code={raw.replace(/\n$/, '')} />;
    }
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
};

const MARKDOWN_COMPONENTS: Components = {
  p: MarkdownP,
  li: MarkdownLi,
  td: MarkdownTd,
  th: MarkdownTh,
  blockquote: MarkdownBlockquote,
  table: MarkdownTable,
  a: MarkdownA,
  pre: MarkdownPre,
  code: MarkdownCode,
};

export const MarkdownMessage: React.FC<{ text: string; workspaceId?: string | null }> = React.memo(
  ({ text, workspaceId = null }) => {
    return (
      <MarkdownWorkspaceContext.Provider value={workspaceId ?? null}>
        <div className="md-body">
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            urlTransform={identityUrlTransform}
            components={MARKDOWN_COMPONENTS}
          >
            {text}
          </ReactMarkdown>
        </div>
      </MarkdownWorkspaceContext.Provider>
    );
  },
);
MarkdownMessage.displayName = 'MarkdownMessage';
