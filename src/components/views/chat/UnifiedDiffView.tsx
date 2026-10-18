import React, { useMemo } from 'react';
import { DiffData, DiffLine } from './types';

export interface UnifiedDiffViewProps {
  diff: DiffData | string;
}

export function parseDiffString(rawDiff: string): DiffData {
  const lines: DiffLine[] = [];
  const rawLines = rawDiff.split('\n');

  let oldLineNum = 1;
  let newLineNum = 1;

  for (const rawLine of rawLines) {
    if (rawLine.startsWith('@@')) {
      // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      const match = rawLine.match(/@@\s*-(\d+)(?:,\d+)?\s*\+(\d+)(?:,\d+)?\s*@@/);
      if (match) {
        oldLineNum = parseInt(match[1], 10);
        newLineNum = parseInt(match[2], 10);
      }
      lines.push({
        kind: 'hunk',
        oldNumber: null,
        newNumber: null,
        text: rawLine,
      });
    } else if (rawLine.startsWith('+++') || rawLine.startsWith('---') || rawLine.startsWith('diff --git') || rawLine.startsWith('index ')) {
      lines.push({
        kind: 'meta',
        oldNumber: null,
        newNumber: null,
        text: rawLine,
      });
    } else if (rawLine.startsWith('+')) {
      lines.push({
        kind: 'added',
        oldNumber: null,
        newNumber: newLineNum++,
        text: rawLine.slice(1),
      });
    } else if (rawLine.startsWith('-')) {
      lines.push({
        kind: 'removed',
        oldNumber: oldLineNum++,
        newNumber: null,
        text: rawLine.slice(1),
      });
    } else {
      // Context line
      const text = rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine;
      lines.push({
        kind: 'context',
        oldNumber: oldLineNum++,
        newNumber: newLineNum++,
        text,
      });
    }
  }

  return {
    lines,
    truncated: lines.length > 2000,
  };
}

function getLineMarker(kind: DiffLine['kind']): string {
  switch (kind) {
    case 'added':
      return '+';
    case 'removed':
      return '-';
    default:
      return ' ';
  }
}

export const UnifiedDiffView: React.FC<UnifiedDiffViewProps> = ({ diff }) => {
  const data: DiffData = useMemo(() => {
    if (typeof diff === 'string') {
      return parseDiffString(diff);
    }
    return diff;
  }, [diff]);

  const { added, removed } = useMemo(() => {
    let add = 0;
    let rem = 0;
    for (const line of data.lines) {
      if (line.kind === 'added') add++;
      if (line.kind === 'removed') rem++;
    }
    return { added: add, removed: rem };
  }, [data.lines]);

  return (
    <figure
      aria-label={`Diff, ${added} additions, ${removed} deletions`}
      className="diff-view"
      style={{ overflowX: 'auto', maxWidth: '100%' }}
    >
      <table className="diff-view__table" style={{ width: '100%', tableLayout: 'auto' }}>
        <tbody>
          {data.lines.map((line, idx) => {
            const rowClass = `diff-line diff-line--${line.kind}`;
            return (
              <tr key={`${line.kind}-${idx}`} className={rowClass}>
                <td className="diff-line__number">{line.oldNumber ?? ''}</td>
                <td className="diff-line__number">{line.newNumber ?? ''}</td>
                <td className="diff-line__marker">{getLineMarker(line.kind)}</td>
                <td className="diff-line__text">
                  <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {line.text.length === 0 ? ' ' : line.text}
                  </pre>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {data.truncated && (
        <p className="diff-view__truncated" role="note">
          Diff truncated.
        </p>
      )}
    </figure>
  );
};
