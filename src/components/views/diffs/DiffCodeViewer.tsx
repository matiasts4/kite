import React, { useMemo } from 'react';
import type { DiffData, DiffLine } from '../chat/types';

export interface DiffCodeViewerProps {
  diff: DiffData | null;
  layout: 'unified' | 'split';
  wordWrap: boolean;
}

interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
  isHunk?: boolean;
  hunkText?: string;
}

export const DiffCodeViewer = React.memo<DiffCodeViewerProps>(({
  diff,
  layout,
  wordWrap,
}) => {
  // 1. Filter out raw meta lines (diff --git, index, ---, +++)
  const meaningfulLines = useMemo(() => {
    if (!diff || !diff.lines) return [];
    return diff.lines.filter((line) => line.kind !== 'meta');
  }, [diff]);

  // 2. Build Split Rows for Side-by-Side view
  const splitRows = useMemo(() => {
    if (layout !== 'split') return [];
    const rows: SplitRow[] = [];

    let i = 0;
    while (i < meaningfulLines.length) {
      const line = meaningfulLines[i];

      if (line.kind === 'hunk') {
        rows.push({
          left: null,
          right: null,
          isHunk: true,
          hunkText: line.text,
        });
        i++;
        continue;
      }

      if (line.kind === 'context') {
        rows.push({
          left: line,
          right: line,
        });
        i++;
        continue;
      }

      // Collect contiguous removed and added lines
      const removedBlock: DiffLine[] = [];
      const addedBlock: DiffLine[] = [];

      while (
        i < meaningfulLines.length &&
        (meaningfulLines[i].kind === 'removed' || meaningfulLines[i].kind === 'added')
      ) {
        if (meaningfulLines[i].kind === 'removed') {
          removedBlock.push(meaningfulLines[i]);
        } else {
          addedBlock.push(meaningfulLines[i]);
        }
        i++;
      }

      const maxCount = Math.max(removedBlock.length, addedBlock.length);
      for (let j = 0; j < maxCount; j++) {
        rows.push({
          left: removedBlock[j] || null,
          right: addedBlock[j] || null,
        });
      }
    }

    return rows;
  }, [meaningfulLines, layout]);

  if (!diff || meaningfulLines.length === 0) {
    return (
      <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-secondary, #64748b)', fontSize: '11px' }}>
        No changes in this file or file is empty.
      </div>
    );
  }

  // 3. Render Split Mode
  if (layout === 'split') {
    return (
      <div className={`diff-code-container ${wordWrap ? 'wrap-enabled' : ''}`}>
        <div className="diff-split-table">
          {splitRows.map((row, idx) => {
            if (row.isHunk) {
              return (
                <div key={`hunk-${idx}`} className="diff-hunk-row">
                  <span className="diff-hunk-pill">{row.hunkText}</span>
                </div>
              );
            }

            const leftKind = row.left?.kind;
            const rightKind = row.right?.kind;

            return (
              <div key={`split-${idx}`} className="diff-split-row">
                {/* Left Column (Original / Removed) */}
                <div className={`diff-split-side left ${leftKind || ''}`}>
                  <span className={`diff-gutter-num ${leftKind || ''}`}>
                    {row.left?.oldNumber ?? ''}
                  </span>
                  <span className={`diff-gutter-marker ${leftKind || ''}`}>
                    {leftKind === 'removed' ? '-' : ' '}
                  </span>
                  <span className={`diff-code-cell ${leftKind || ''}`}>
                    {row.left ? (row.left.text.length === 0 ? ' ' : row.left.text) : ''}
                  </span>
                </div>

                {/* Right Column (Modified / Added) */}
                <div className={`diff-split-side right ${rightKind || ''}`}>
                  <span className={`diff-gutter-num ${rightKind || ''}`}>
                    {row.right?.newNumber ?? ''}
                  </span>
                  <span className={`diff-gutter-marker ${rightKind || ''}`}>
                    {rightKind === 'added' ? '+' : ' '}
                  </span>
                  <span className={`diff-code-cell ${rightKind || ''}`}>
                    {row.right ? (row.right.text.length === 0 ? ' ' : row.right.text) : ''}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // 4. Render Unified Mode
  return (
    <div className={`diff-code-container ${wordWrap ? 'wrap-enabled' : ''}`}>
      <div className="diff-table">
        {meaningfulLines.map((line, idx) => {
          if (line.kind === 'hunk') {
            return (
              <div key={`hunk-${idx}`} className="diff-hunk-row">
                <span className="diff-hunk-pill">{line.text}</span>
              </div>
            );
          }

          const marker = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' ';
          const rowClass = `diff-row ${line.kind}`;

          return (
            <div key={`line-${idx}`} className={rowClass}>
              <span className="diff-gutter-num">{line.oldNumber ?? ''}</span>
              <span className="diff-gutter-num">{line.newNumber ?? ''}</span>
              <span className="diff-gutter-marker">{marker}</span>
              <span className="diff-code-cell">
                {line.text.length === 0 ? ' ' : line.text}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
});

