import React, { useMemo } from 'react';
import type { FileDiffContentsLoader } from '@pierre/diffs';
import { KiteDiffView } from '../../diffs/KiteDiffView';
import {
  getDiffDataLineStat,
  parseDiffDataToFileMetadata,
} from '../../../lib/diffs/diffRendering';
import type { DiffData, DiffLine } from './types';

export interface UnifiedDiffViewProps {
  diff: DiffData | string;
  filePath?: string;
  oldPath?: string | null;
  status?: string;
  wordWrap?: boolean;
  ignoreWhitespace?: boolean;
  loadDiffFiles?: FileDiffContentsLoader;
}

export function parseDiffString(rawDiff: string): DiffData {
  const lines: DiffLine[] = [];
  const rawLines = rawDiff.split('\n');

  let oldLineNum = 1;
  let newLineNum = 1;

  for (const rawLine of rawLines) {
    if (rawLine.startsWith('@@')) {
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
    } else if (
      rawLine.startsWith('+++') ||
      rawLine.startsWith('---') ||
      rawLine.startsWith('diff --git') ||
      rawLine.startsWith('index ')
    ) {
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
    rawPatch: rawDiff,
    truncated: lines.length > 2000,
  };
}

export const UnifiedDiffView: React.FC<UnifiedDiffViewProps> = ({
  diff,
  filePath,
  oldPath,
  status,
  wordWrap = true,
  ignoreWhitespace = false,
  loadDiffFiles,
}) => {
  const fileDiff = useMemo(
    () =>
      parseDiffDataToFileMetadata(diff, {
        filePath,
        oldPath,
        status,
        ignoreWhitespace,
      }),
    [diff, filePath, oldPath, status, ignoreWhitespace]
  );

  const { additions, deletions } = useMemo(
    () =>
      getDiffDataLineStat(diff, {
        filePath,
        oldPath,
        status,
        ignoreWhitespace,
      }),
    [diff, filePath, oldPath, status, ignoreWhitespace]
  );

  const rawTextFallback =
    !fileDiff && typeof diff === 'string' && diff.trim().length > 0 ? diff : null;

  return (
    <figure
      aria-label={`Diff, ${additions} additions, ${deletions} deletions`}
      className="diff-view diff-view--modern"
    >
      {rawTextFallback !== null ? (
        <pre className="diff-view__fallback">{rawTextFallback}</pre>
      ) : (
        <KiteDiffView
          diff={diff}
          fileDiff={fileDiff}
          filePath={filePath}
          oldPath={oldPath}
          status={status}
          layout="unified"
          wordWrap={wordWrap}
          ignoreWhitespace={ignoreWhitespace}
          hideFileHeader={true}
          lineDiffType="word-alt"
          loadDiffFiles={loadDiffFiles}
          emptyMessage="No changes in this diff."
        />
      )}
    </figure>
  );
};
