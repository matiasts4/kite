import React, { useMemo, useRef, useState, useEffect } from 'react';
import { tokenizeLine } from './syntax';
import { CopyIcon, CheckIcon } from '../chat/ChatIcons';
import { ListTreeIcon } from './FileIcons';

export interface MarkdownPreviewPaneProps {
  text: string;
  relativePath: string;
  workspaceId?: string | null;
  onNavigateInternalFile?: (path: string) => void;
  showOutline?: boolean;
  onToggleOutline?: () => void;
}

export const MarkdownPreviewPane: React.FC<MarkdownPreviewPaneProps> = ({
  text,
  onNavigateInternalFile,
  showOutline = false,
  onToggleOutline,
}) => {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const [scrollProgress, setScrollProgress] = useState<number>(0);
  const [isNarrow, setIsNarrow] = useState<boolean>(false);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

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
              wordBreak: 'break-word',
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
      | { type: 'header'; level: number; text: string; id: string }
      | { type: 'code'; lang: string; code: string }
      | { type: 'quote'; alertType?: string; lines: string[] }
      | { type: 'list'; items: Array<{ checked?: boolean; text: string; ordered?: boolean }> }
      | { type: 'table'; headers: string[]; rows: string[][] }
      | { type: 'hr' }
      | { type: 'paragraph'; text: string }
    > = [];

    const headingCounts: Record<string, number> = {};
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
        const level = headerMatch[1].length;
        const headerText = headerMatch[2].trim();
        const baseSlug =
          headerText
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') || `section-${i}`;
        const count = (headingCounts[baseSlug] || 0) + 1;
        headingCounts[baseSlug] = count;
        const id = count > 1 ? `${baseSlug}-${count}` : baseSlug;

        parsedBlocks.push({
          type: 'header',
          level,
          text: headerText,
          id,
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

  // Headings for outline navigation
  const headings = useMemo(() => {
    return blocks
      .filter((b): b is { type: 'header'; level: number; text: string; id: string } => b.type === 'header')
      .map((b) => ({
        id: b.id,
        level: b.level,
        text: b.text,
      }));
  }, [blocks]);

  // Handle responsive layout detection
  useEffect(() => {
    if (!scrollContainerRef.current) return;
    const container = scrollContainerRef.current;

    const checkWidth = () => {
      setIsNarrow(container.clientWidth < 680);
    };

    checkWidth();

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setIsNarrow(entry.contentRect.width < 680);
        }
      });
      observer.observe(container);
      return () => observer.disconnect();
    } else {
      window.addEventListener('resize', checkWidth);
      return () => window.removeEventListener('resize', checkWidth);
    }
  }, []);

  // Track scroll reading progress and active section
  const handleScroll = () => {
    if (!scrollContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const max = scrollHeight - clientHeight;
    setScrollProgress(max > 0 ? Math.min(100, Math.max(0, (scrollTop / max) * 100)) : 0);

    if (headings.length === 0) return;
    const containerRect = scrollContainerRef.current.getBoundingClientRect();
    let current = headings[0].id;
    for (const h of headings) {
      const el = document.getElementById(h.id);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.top - containerRect.top <= 100) {
          current = h.id;
        }
      }
    }
    setActiveHeadingId(current);
  };

  const scrollToHeading = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveHeadingId(id);
    }
  };

  return (
    <div
      className="markdown-rendered-view"
      style={{
        display: 'flex',
        flexDirection: 'row',
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
        position: 'relative',
        userSelect: 'text',
        WebkitUserSelect: 'text',
      }}
    >
      {/* Primary Scroll Container (Pinned Scrollbar on the Right) */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="markdown-preview-scroll-container scroll-quiet"
        style={{
          flex: 1,
          height: '100%',
          minWidth: 0,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          position: 'relative',
          boxSizing: 'border-box',
          userSelect: 'text',
          WebkitUserSelect: 'text',
        }}
      >
        {/* Top Reading Progress Bar */}
        <div
          aria-hidden="true"
          style={{
            position: 'sticky',
            top: 0,
            left: 0,
            width: `${scrollProgress}%`,
            height: '2px',
            backgroundColor: 'var(--accent, #3b82f6)',
            transition: 'width 60ms linear',
            zIndex: 20,
            opacity: scrollProgress > 1 ? 0.9 : 0,
          }}
        />

        {/* Content Document Surface */}
        <article
          className="markdown-preview-content"
          style={{
            width: '100%',
            maxWidth: '850px',
            minWidth: 0,
            margin: '0 auto',
            padding: '24px 28px 80px 28px',
            boxSizing: 'border-box',
            color: 'var(--text-primary, #fafafa)',
            fontSize: '13.5px',
            lineHeight: '1.6',
            wordBreak: 'break-word',
            overflowWrap: 'break-word',
            userSelect: 'text',
            WebkitUserSelect: 'text',
          }}
        >
          {blocks.map((block, idx) => {
            if (block.type === 'header') {
              const Tag = `h${block.level}` as keyof JSX.IntrinsicElements;
              const isH1orH2 = block.level <= 2;
              return (
                <Tag
                  key={idx}
                  id={block.id}
                  style={{
                    marginTop: idx === 0 ? '0' : isH1orH2 ? '28px' : '20px',
                    marginBottom: '12px',
                    fontWeight: isH1orH2 ? 600 : 500,
                    fontSize:
                      block.level === 1
                        ? '1.75em'
                        : block.level === 2
                        ? '1.4em'
                        : block.level === 3
                        ? '1.18em'
                        : '1.05em',
                    borderBottom: isH1orH2
                      ? '1px solid var(--block-stroke, rgba(255,255,255,0.12))'
                      : undefined,
                    paddingBottom: isH1orH2 ? '6px' : undefined,
                    scrollMarginTop: '16px',
                    wordBreak: 'break-word',
                    overflowWrap: 'break-word',
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
                    margin: '24px 0',
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
                    maxWidth: '100%',
                    minWidth: 0,
                    boxSizing: 'border-box',
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
                    className="scroll-quiet"
                    style={{
                      padding: '10px 14px',
                      margin: 0,
                      overflowX: 'auto',
                      maxWidth: '100%',
                      boxSizing: 'border-box',
                      fontFamily: 'var(--font-mono, monospace)',
                      fontSize: '12px',
                      lineHeight: '1.45',
                    }}
                  >
                    {lines.map((line, lIdx) => (
                      <div key={lIdx} style={{ whiteSpace: 'pre' }}>
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
                    padding: '10px 16px',
                    borderLeft: `3px solid ${alertColor}`,
                    backgroundColor: 'var(--block-fill, rgba(255,255,255,0.03))',
                    borderRadius: '0 6px 6px 0',
                    maxWidth: '100%',
                    minWidth: 0,
                    boxSizing: 'border-box',
                    wordBreak: 'break-word',
                    overflowWrap: 'break-word',
                  }}
                >
                  {block.alertType && (
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: '11px',
                        color: alertColor,
                        marginBottom: '6px',
                        letterSpacing: '0.5px',
                      }}
                    >
                      {block.alertType}
                    </div>
                  )}
                  {block.lines.map((line, lIdx) => (
                    <p key={lIdx} style={{ margin: '4px 0', lineHeight: '1.5' }}>
                      {renderInline(line)}
                    </p>
                  ))}
                </blockquote>
              );
            }

            if (block.type === 'table') {
              return (
                <div
                  key={idx}
                  className="scroll-quiet"
                  style={{
                    margin: '16px 0',
                    maxWidth: '100%',
                    width: '100%',
                    minWidth: 0,
                    overflowX: 'auto',
                    boxSizing: 'border-box',
                    border: '1px solid var(--block-stroke, rgba(255,255,255,0.12))',
                    borderRadius: '6px',
                    background: 'var(--block-fill, rgba(255,255,255,0.02))',
                  }}
                >
                  <table
                    style={{
                      width: '100%',
                      minWidth: 'max-content',
                      borderCollapse: 'collapse',
                      fontSize: '12.5px',
                    }}
                  >
                    <thead>
                      <tr
                        style={{
                          borderBottom: '2px solid var(--block-stroke, rgba(255,255,255,0.15))',
                          background: 'var(--chip-fill, rgba(255,255,255,0.04))',
                        }}
                      >
                        {block.headers.map((h, hIdx) => (
                          <th
                            key={hIdx}
                            style={{
                              textAlign: 'left',
                              padding: '8px 14px',
                              fontWeight: 600,
                              whiteSpace: 'nowrap',
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
                            <td key={cIdx} style={{ padding: '8px 14px', verticalAlign: 'top' }}>
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
                    maxWidth: '100%',
                    minWidth: 0,
                    wordBreak: 'break-word',
                    overflowWrap: 'break-word',
                  }}
                >
                  {block.items.map((item, itIdx) => (
                    <li
                      key={itIdx}
                      style={{
                        margin: '4px 0',
                        display: item.checked !== undefined ? 'flex' : 'list-item',
                        alignItems: item.checked !== undefined ? 'center' : undefined,
                        gap: item.checked !== undefined ? '8px' : undefined,
                        wordBreak: 'break-word',
                        overflowWrap: 'break-word',
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
                <p
                  key={idx}
                  style={{
                    margin: '10px 0',
                    maxWidth: '100%',
                    minWidth: 0,
                    wordBreak: 'break-word',
                    overflowWrap: 'break-word',
                  }}
                >
                  {renderInline(block.text)}
                </p>
              );
            }

            return null;
          })}
        </article>
      </div>

      {/* Lateral Outline / Table of Contents */}
      {showOutline && (
        <>
          {isNarrow && (
            <div
              onClick={onToggleOutline}
              style={{
                position: 'absolute',
                inset: 0,
                background: 'rgba(0, 0, 0, 0.4)',
                zIndex: 35,
              }}
            />
          )}
          <aside
            className="markdown-outline-sidebar scroll-quiet"
            aria-label="Table of contents"
            style={{
              ...(isNarrow
                ? {
                    position: 'absolute',
                    top: 0,
                    right: 0,
                    bottom: 0,
                    width: '250px',
                    boxShadow: '-4px 0 20px rgba(0, 0, 0, 0.5)',
                    zIndex: 40,
                  }
                : {
                    width: '230px',
                    flexShrink: 0,
                    zIndex: 10,
                  }),
              display: 'flex',
              flexDirection: 'column',
              height: '100%',
              background: 'var(--pane, #16181d)',
              borderLeft: '1px solid var(--separator, rgba(255, 255, 255, 0.08))',
              overflow: 'hidden',
              boxSizing: 'border-box',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 12px',
                borderBottom: '1px solid var(--separator, rgba(255, 255, 255, 0.08))',
                fontSize: '11px',
                fontWeight: 600,
                color: 'var(--text-secondary, #8b949e)',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <ListTreeIcon size={12} />
                <span>Outline</span>
                {headings.length > 0 && (
                  <span
                    style={{
                      fontSize: '10px',
                      padding: '1px 5px',
                      borderRadius: '10px',
                      background: 'var(--chip-fill, rgba(255, 255, 255, 0.08))',
                      color: 'var(--text-primary)',
                    }}
                  >
                    {headings.length}
                  </span>
                )}
              </div>
              {onToggleOutline && (
                <button
                  type="button"
                  onClick={onToggleOutline}
                  title="Close outline"
                  aria-label="Close outline"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    padding: '2px 4px',
                    fontSize: '14px',
                    lineHeight: 1,
                    borderRadius: '4px',
                  }}
                >
                  ×
                </button>
              )}
            </div>

            <div
              className="scroll-quiet"
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '8px 6px',
                display: 'flex',
                flexDirection: 'column',
                gap: '2px',
              }}
            >
              {headings.length === 0 ? (
                <div style={{ padding: '16px 12px', color: 'var(--text-faint, #666)', fontSize: '11px', textAlign: 'center' }}>
                  No headings in this document
                </div>
              ) : (
                headings.map((h) => {
                  const isActive = activeHeadingId === h.id;
                  const indent = h.level === 1 ? 6 : h.level === 2 ? 14 : 22;
                  return (
                    <button
                      key={h.id}
                      type="button"
                      onClick={() => scrollToHeading(h.id)}
                      title={h.text}
                      style={{
                        textAlign: 'left',
                        border: 'none',
                        background: isActive ? 'var(--hover-fill, rgba(255, 255, 255, 0.08))' : 'transparent',
                        color: isActive ? 'var(--accent, #3b82f6)' : 'var(--text-secondary, #aaa)',
                        fontWeight: isActive ? 600 : h.level === 1 ? 500 : 400,
                        fontSize: h.level === 1 ? '11.5px' : '11px',
                        padding: `5px 8px 5px ${indent}px`,
                        borderRadius: '4px',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        display: 'block',
                        width: '100%',
                        transition: 'all 120ms ease',
                      }}
                    >
                      {h.text}
                    </button>
                  );
                })
              )}
            </div>
          </aside>
        </>
      )}
    </div>
  );
};
