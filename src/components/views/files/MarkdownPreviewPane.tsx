import React, { useMemo } from 'react';
import { tokenizeLine } from './syntax';
import { CopyIcon, CheckIcon } from '../chat/ChatIcons';

export interface MarkdownPreviewPaneProps {
  text: string;
  relativePath: string;
  workspaceId?: string | null;
  onNavigateInternalFile?: (path: string) => void;
}

export const MarkdownPreviewPane: React.FC<MarkdownPreviewPaneProps> = ({
  text,
  onNavigateInternalFile,
}) => {
  const [copiedIndex, setCopiedIndex] = React.useState<number | null>(null);

  const handleCopy = (code: string, idx: number) => {
    void navigator.clipboard.writeText(code);
    setCopiedIndex(idx);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  // Simple token parser for inline Markdown
  const renderInline = (line: string): React.ReactNode => {
    // Matches links [label](href), inline code `code`, bold **bold**, italic *italic*
    const regex = /(\[.*?\]\(.*?\)|\`[^\`]+\`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
    const tokens = line.split(regex);

    return tokens.map((token, i) => {
      if (token.startsWith('[') && token.includes('](') && token.endsWith(')')) {
        const match = token.match(/^\[(.*?)\]\((.*?)\)$/);
        if (match) {
          const label = match[1];
          const href = match[2];
          const isExternal = /^https?:\/\//i.test(href) || /^mailto:/i.test(href);

          return (
            <a
              key={i}
              href={href}
              onClick={(e) => {
                if (!isExternal && onNavigateInternalFile) {
                  e.preventDefault();
                  onNavigateInternalFile(href);
                }
              }}
              target={isExternal ? '_blank' : undefined}
              rel={isExternal ? 'noopener noreferrer' : undefined}
              style={{
                color: 'var(--accent, #3b82f6)',
                textDecoration: 'underline',
                cursor: 'pointer',
              }}
            >
              {label}
            </a>
          );
        }
      }

      if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
        return (
          <code
            key={i}
            style={{
              padding: '2px 5px',
              borderRadius: '4px',
              backgroundColor: 'var(--chip-fill, rgba(128, 128, 128, 0.15))',
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: '0.88em',
            }}
          >
            {token.slice(1, -1)}
          </code>
        );
      }

      if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
        return <strong key={i}>{token.slice(2, -2)}</strong>;
      }

      if (token.startsWith('*') && token.endsWith('*') && token.length > 2) {
        return <em key={i}>{token.slice(1, -1)}</em>;
      }

      return token;
    });
  };

  // Structured block parser
  const blocks = useMemo(() => {
    const rawLines = text.split(/\r?\n/);
    const parsedBlocks: Array<
      | { type: 'header'; level: number; text: string }
      | { type: 'code'; lang: string; code: string }
      | { type: 'quote'; alertType?: string; lines: string[] }
      | { type: 'list'; items: Array<{ checked?: boolean; text: string; ordered?: boolean }> }
      | { type: 'table'; headers: string[]; rows: string[][] }
      | { type: 'hr' }
      | { type: 'paragraph'; text: string }
    > = [];

    let i = 0;
    while (i < rawLines.length) {
      const line = rawLines[i];
      const trimmed = line.trim();

      // Horizontal Rule
      if (/^(---|\*\*\*|___)$/.test(trimmed)) {
        parsedBlocks.push({ type: 'hr' });
        i++;
        continue;
      }

      // Fenced code blocks
      if (trimmed.startsWith('```')) {
        const lang = trimmed.slice(3).trim();
        const codeLines: string[] = [];
        i++;
        while (i < rawLines.length && !rawLines[i].trim().startsWith('```')) {
          codeLines.push(rawLines[i]);
          i++;
        }
        if (i < rawLines.length) i++; // skip closing ```
        parsedBlocks.push({ type: 'code', lang, code: codeLines.join('\n') });
        continue;
      }

      // Headers (# Header)
      const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (headerMatch) {
        parsedBlocks.push({
          type: 'header',
          level: headerMatch[1].length,
          text: headerMatch[2].trim(),
        });
        i++;
        continue;
      }

      // Blockquotes / Alerts (> [!NOTE] ...)
      if (trimmed.startsWith('>')) {
        const quoteLines: string[] = [];
        let alertType: string | undefined;

        while (i < rawLines.length && rawLines[i].trim().startsWith('>')) {
          let content = rawLines[i].trim().slice(1).trim();
          const alertMatch = content.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i);
          if (alertMatch) {
            alertType = alertMatch[1].toUpperCase();
            content = content.replace(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i, '').trim();
          }
          if (content || quoteLines.length > 0) {
            quoteLines.push(content);
          }
          i++;
        }
        parsedBlocks.push({ type: 'quote', alertType, lines: quoteLines });
        continue;
      }

      // Table (starts with | and has divider)
      if (trimmed.startsWith('|') && trimmed.endsWith('|') && i + 1 < rawLines.length && rawLines[i + 1].includes('---')) {
        const headers = trimmed.slice(1, -1).split('|').map((h) => h.trim());
        i += 2; // skip header and divider
        const rows: string[][] = [];
        while (i < rawLines.length && rawLines[i].trim().startsWith('|')) {
          const rowCells = rawLines[i].trim().slice(1, -1).split('|').map((c) => c.trim());
          rows.push(rowCells);
          i++;
        }
        parsedBlocks.push({ type: 'table', headers, rows });
        continue;
      }

      // Lists (ordered or unordered or task lists)
      const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
      if (listMatch) {
        const listItems: Array<{ checked?: boolean; text: string; ordered?: boolean }> = [];
        while (i < rawLines.length) {
          const currentItemMatch = rawLines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
          if (!currentItemMatch) break;
          const itemText = currentItemMatch[3];
          const isTask = itemText.match(/^\[([ xX])\]\s*(.*)$/);
          if (isTask) {
            listItems.push({
              checked: isTask[1].toLowerCase() === 'x',
              text: isTask[2],
              ordered: /\d+\./.test(currentItemMatch[2]),
            });
          } else {
            listItems.push({
              text: itemText,
              ordered: /\d+\./.test(currentItemMatch[2]),
            });
          }
          i++;
        }
        parsedBlocks.push({ type: 'list', items: listItems });
        continue;
      }

      // Empty line
      if (!trimmed) {
        i++;
        continue;
      }

      // Paragraph
      const pLines: string[] = [];
      while (i < rawLines.length && rawLines[i].trim()) {
        const currentTrim = rawLines[i].trim();
        if (
          currentTrim.startsWith('#') ||
          currentTrim.startsWith('```') ||
          currentTrim.startsWith('>') ||
          /^(---|\*\*\*|___)$/.test(currentTrim) ||
          currentTrim.startsWith('|') ||
          /^(\s*)([-*+]|\d+\.)\s+/.test(rawLines[i])
        ) {
          break;
        }
        pLines.push(rawLines[i]);
        i++;
      }
      parsedBlocks.push({ type: 'paragraph', text: pLines.join(' ') });
    }

    return parsedBlocks;
  }, [text]);

  return (
    <div
      className="markdown-rendered-view scroll-quiet"
      style={{
        padding: '20px 24px',
        overflowY: 'auto',
        height: '100%',
        color: 'var(--text-primary, #fafafa)',
        fontSize: '13.5px',
        lineHeight: '1.6',
        maxWidth: '850px',
        margin: '0 auto',
      }}
    >
      {blocks.map((block, idx) => {
        if (block.type === 'header') {
          const Tag = `h${block.level}` as keyof JSX.IntrinsicElements;
          const isH1orH2 = block.level <= 2;
          return (
            <Tag
              key={idx}
              style={{
                marginTop: idx === 0 ? '0' : isH1orH2 ? '24px' : '16px',
                marginBottom: '10px',
                fontWeight: isH1orH2 ? 600 : 500,
                fontSize: block.level === 1 ? '1.75em' : block.level === 2 ? '1.4em' : block.level === 3 ? '1.18em' : '1.05em',
                borderBottom: isH1orH2 ? '1px solid var(--block-stroke, rgba(255,255,255,0.12))' : undefined,
                paddingBottom: isH1orH2 ? '6px' : undefined,
              }}
            >
              {renderInline(block.text)}
            </Tag>
          );
        }

        if (block.type === 'hr') {
          return (
            <hr
              key={idx}
              style={{
                margin: '20px 0',
                border: 0,
                borderTop: '1px solid var(--block-stroke, rgba(255,255,255,0.12))',
              }}
            />
          );
        }

        if (block.type === 'code') {
          const lines = block.code.split('\n');
          return (
            <div
              key={idx}
              style={{
                margin: '14px 0',
                borderRadius: '6px',
                border: '1px solid var(--block-stroke, rgba(255,255,255,0.12))',
                background: 'var(--block-fill, #16181d)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '4px 12px',
                  background: 'var(--chip-fill, rgba(255,255,255,0.06))',
                  borderBottom: '1px solid var(--block-stroke, rgba(255,255,255,0.12))',
                  fontSize: '11px',
                  color: 'var(--text-secondary, #8b949e)',
                }}
              >
                <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{block.lang || 'code'}</span>
                <button
                  type="button"
                  onClick={() => handleCopy(block.code, idx)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    background: 'none',
                    border: 'none',
                    color: 'inherit',
                    cursor: 'pointer',
                    fontSize: 'inherit',
                  }}
                >
                  {copiedIndex === idx ? (
                    <CheckIcon size={12} style={{ color: 'var(--status-running, #22c55e)' }} />
                  ) : (
                    <CopyIcon size={12} />
                  )}
                  <span>{copiedIndex === idx ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
              <pre
                style={{
                  padding: '10px 14px',
                  margin: 0,
                  overflowX: 'auto',
                  fontFamily: 'var(--font-mono, monospace)',
                  fontSize: '12px',
                  lineHeight: '1.45',
                }}
              >
                {lines.map((line, lIdx) => (
                  <div key={lIdx}>
                    {tokenizeLine(line).map((tok, tIdx) => (
                      <span key={tIdx} className={tok.className}>
                        {tok.text}
                      </span>
                    ))}
                  </div>
                ))}
              </pre>
            </div>
          );
        }

        if (block.type === 'quote') {
          const alertColor =
            block.alertType === 'IMPORTANT' || block.alertType === 'WARNING'
              ? 'var(--warning-text, #f59e0b)'
              : block.alertType === 'TIP'
              ? 'var(--success-text, #10b981)'
              : block.alertType === 'CAUTION'
              ? 'var(--error-text, #ef4444)'
              : 'var(--accent, #3b82f6)';

          return (
            <blockquote
              key={idx}
              style={{
                margin: '12px 0',
                padding: '8px 14px',
                borderLeft: `3px solid ${alertColor}`,
                backgroundColor: 'var(--block-fill, rgba(255,255,255,0.03))',
                borderRadius: '0 4px 4px 0',
              }}
            >
              {block.alertType && (
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: '11px',
                    color: alertColor,
                    marginBottom: '4px',
                    letterSpacing: '0.5px',
                  }}
                >
                  {block.alertType}
                </div>
              )}
              {block.lines.map((line, lIdx) => (
                <p key={lIdx} style={{ margin: '2px 0' }}>
                  {renderInline(line)}
                </p>
              ))}
            </blockquote>
          );
        }

        if (block.type === 'table') {
          return (
            <div key={idx} style={{ margin: '14px 0', overflowX: 'auto' }}>
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: '12.5px',
                }}
              >
                <thead>
                  <tr style={{ borderBottom: '2px solid var(--block-stroke, rgba(255,255,255,0.15))' }}>
                    {block.headers.map((h, hIdx) => (
                      <th
                        key={hIdx}
                        style={{
                          textAlign: 'left',
                          padding: '6px 12px',
                          fontWeight: 600,
                        }}
                      >
                        {renderInline(h)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rIdx) => (
                    <tr
                      key={rIdx}
                      style={{
                        borderBottom: '1px solid var(--block-stroke, rgba(255,255,255,0.08))',
                      }}
                    >
                      {row.map((cell, cIdx) => (
                        <td key={cIdx} style={{ padding: '6px 12px' }}>
                          {renderInline(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        if (block.type === 'list') {
          return (
            <ul
              key={idx}
              style={{
                margin: '8px 0 12px 20px',
                padding: 0,
                listStyleType: block.items[0]?.checked !== undefined ? 'none' : 'disc',
              }}
            >
              {block.items.map((item, itIdx) => (
                <li
                  key={itIdx}
                  style={{
                    margin: '3px 0',
                    display: item.checked !== undefined ? 'flex' : 'list-item',
                    alignItems: item.checked !== undefined ? 'center' : undefined,
                    gap: item.checked !== undefined ? '8px' : undefined,
                  }}
                >
                  {item.checked !== undefined && (
                    <input
                      type="checkbox"
                      checked={item.checked}
                      readOnly
                      style={{ cursor: 'default' }}
                    />
                  )}
                  <span>{renderInline(item.text)}</span>
                </li>
              ))}
            </ul>
          );
        }

        if (block.type === 'paragraph') {
          return (
            <p key={idx} style={{ margin: '8px 0' }}>
              {renderInline(block.text)}
            </p>
          );
        }

        return null;
      })}
    </div>
  );
};
