import {
  cloneFileDiffMetadata,
  parsePatchFiles,
  type ChangeContent,
  type ContextContent,
  type FileDiffMetadata,
  type Hunk,
} from '@pierre/diffs';
import type { DiffData } from '../../components/views/chat/types';

export interface DiffLineStat {
  additions: number;
  deletions: number;
}

export interface ConvertDiffOptions {
  filePath?: string;
  status?: string;
  oldPath?: string | null;
  cacheKey?: string;
  ignoreWhitespace?: boolean;
}

/**
 * Shadow DOM overrides injected into `@pierre/diffs` containers so surfaces,
 * gutter numbers, word-diff highlights, and expandable `N unmodified lines`
 * separators inherit Kite's dark/light palette tokens seamlessly.
 */
export const DIFF_SURFACE_THEME_UNSAFE_CSS = `
:host {
  --diffs-font-family: var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
  --diffs-header-font-family: var(--font-sans, system-ui, -apple-system, sans-serif);
  --diffs-font-size: 12px;
  --diffs-line-height: 20px;
  --diffs-tab-size: 2;
  --diffs-min-number-column-width: 3ch;
  --diffs-bg: var(--glass-nested-bg, var(--pane, #141414));
  --diffs-dark-bg: var(--glass-nested-bg, var(--pane, #141414));
  --diffs-light-bg: var(--glass-nested-bg, var(--pane, #ffffff));
  --diffs-fg: var(--code-plain, var(--text-primary, #fafafa));
  --diffs-fg-number-override: var(--code-gutter, var(--text-faint, #6e6e6e));
  --diffs-bg-context-override: transparent;
  --diffs-bg-context-gutter-override: transparent;
  --diffs-addition-color-override: var(--diff-addition, var(--status-running, #4ade80));
  --diffs-deletion-color-override: var(--diff-deletion, var(--status-failed, #ff6568));
  --diffs-bg-addition-override: color-mix(in srgb, var(--diff-addition, var(--status-running, #4ade80)) 14%, transparent);
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--diff-addition, var(--status-running, #4ade80)) 18%, transparent);
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--diff-addition, var(--status-running, #4ade80)) 28%, transparent);
  --diffs-bg-deletion-override: color-mix(in srgb, var(--diff-deletion, var(--status-failed, #ff6568)) 14%, transparent);
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--diff-deletion, var(--status-failed, #ff6568)) 18%, transparent);
  --diffs-bg-deletion-emphasis-override: color-mix(in srgb, var(--diff-deletion, var(--status-failed, #ff6568)) 28%, transparent);
  --diffs-bg-hover-override: color-mix(in srgb, var(--text-primary, #ffffff) 5%, transparent);
  --diffs-bg-separator-override: color-mix(in srgb, var(--text-primary, #ffffff) 6%, transparent);
}

[data-diffs] {
  background-color: var(--diffs-bg);
}

[data-diffs-header] {
  min-height: 32px;
  background-color: var(--glass-nested-bg, var(--pane, #141414));
  border-bottom: 1px solid var(--panel-stroke, rgba(255, 255, 255, 0.1));
}

[data-diffs-header][data-sticky] {
  background-color: var(--glass-sticky-pane-bg, var(--pane, #141414));
}

[data-background] [data-line-type="change-addition"] {
  --diffs-computed-diff-line-bg: var(--diffs-bg-addition-override);
}

[data-background] :is([data-gutter-buffer], [data-column-number])[data-line-type="change-addition"] {
  --diffs-computed-diff-line-bg: var(--diffs-bg-addition-number-override);
}

[data-background] [data-line-type="change-deletion"] {
  --diffs-computed-diff-line-bg: var(--diffs-bg-deletion-override);
}

[data-background] :is([data-gutter-buffer], [data-column-number])[data-line-type="change-deletion"] {
  --diffs-computed-diff-line-bg: var(--diffs-bg-deletion-number-override);
}

[data-separator="line-info"],
[data-separator="line-info-basic"],
[data-separator="metadata"] {
  height: 24px;
  min-height: 24px;
  font-size: 11px;
  color: var(--text-secondary, #a1a1a1);
  border-block: 1px solid color-mix(in srgb, var(--panel-stroke, rgba(255, 255, 255, 0.1)) 65%, transparent);
}

[data-separator="line-info"]:hover {
  color: var(--text-primary, #fafafa);
  --diffs-bg-separator: color-mix(in srgb, var(--accent, #5c8fff) 14%, transparent);
  background-color: color-mix(in srgb, var(--accent, #5c8fff) 14%, transparent);
}

[data-line-type="change-addition"] [data-diff-span],
[data-line-type="change-deletion"] [data-diff-span] {
  border-radius: var(--vl-radius-xs, 4px);
}
`;

const TEST_FILE_PATTERNS = [
  /(?:^|\/)__tests__\//i,
  /(?:^|\/)__mocks__\//i,
  /\.(?:test|spec)\.[^./]+$/i,
  /_(?:test|spec)\.[^./]+$/i,
];

/** Returns true when a repo-relative path represents a test or spec file. */
export function isTestFilePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').trim();
  if (!normalized) return false;
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function normalizeWhitespaceTokens(line: string): string {
  return line.replace(/[ \t]+/g, ' ').trim();
}

interface AlignedLinePair {
  delIdx: number;
  addIdx: number;
}

function computeNormalizedLineAlignment(
  deletions: readonly string[],
  additions: readonly string[]
): AlignedLinePair[] {
  const m = deletions.length;
  const n = additions.length;
  if (m === 0 || n === 0 || m * n > 25_000) {
    return [];
  }

  const normDel = deletions.map(normalizeWhitespaceTokens);
  const normAdd = additions.map(normalizeWhitespaceTokens);

  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    const row = dp[i]!;
    const nextRow = dp[i + 1]!;
    for (let j = n - 1; j >= 0; j--) {
      if (normDel[i] === normAdd[j]) {
        row[j] = (nextRow[j + 1] ?? 0) + 1;
      } else {
        const down = nextRow[j] ?? 0;
        const right = row[j + 1] ?? 0;
        row[j] = down >= right ? down : right;
      }
    }
  }

  const pairs: AlignedLinePair[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (normDel[i] === normAdd[j]) {
      pairs.push({ delIdx: i, addIdx: j });
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      i++;
    } else {
      j++;
    }
  }

  return pairs;
}

function pushMergedContent(
  target: (ContextContent | ChangeContent)[],
  entry: ContextContent | ChangeContent
): void {
  if (entry.type === 'context') {
    if (entry.lines <= 0) return;
    const prev = target[target.length - 1];
    if (
      prev &&
      prev.type === 'context' &&
      prev.deletionLineIndex + prev.lines === entry.deletionLineIndex &&
      prev.additionLineIndex + prev.lines === entry.additionLineIndex
    ) {
      prev.lines += entry.lines;
      return;
    }
    target.push({ ...entry });
    return;
  }

  if (entry.deletions <= 0 && entry.additions <= 0) return;
  const prev = target[target.length - 1];
  if (
    prev &&
    prev.type === 'change' &&
    prev.deletionLineIndex + prev.deletions === entry.deletionLineIndex &&
    prev.additionLineIndex + prev.additions === entry.additionLineIndex
  ) {
    prev.deletions += entry.deletions;
    prev.additions += entry.additions;
    return;
  }
  target.push({ ...entry });
}

function splitChangeContentIgnoringWhitespace(
  change: ChangeContent,
  deletionLines: readonly string[],
  additionLines: readonly string[]
): (ContextContent | ChangeContent)[] {
  const delSlice = deletionLines.slice(
    change.deletionLineIndex,
    change.deletionLineIndex + change.deletions
  );
  const addSlice = additionLines.slice(
    change.additionLineIndex,
    change.additionLineIndex + change.additions
  );

  const pairs = computeNormalizedLineAlignment(delSlice, addSlice);
  if (pairs.length === 0) {
    return [{ ...change }];
  }

  const out: (ContextContent | ChangeContent)[] = [];
  let prevDel = 0;
  let prevAdd = 0;

  for (const pair of pairs) {
    const gapDel = pair.delIdx - prevDel;
    const gapAdd = pair.addIdx - prevAdd;
    if (gapDel > 0 || gapAdd > 0) {
      pushMergedContent(out, {
        type: 'change',
        deletions: gapDel,
        deletionLineIndex: change.deletionLineIndex + prevDel,
        additions: gapAdd,
        additionLineIndex: change.additionLineIndex + prevAdd,
      });
    }
    pushMergedContent(out, {
      type: 'context',
      lines: 1,
      deletionLineIndex: change.deletionLineIndex + pair.delIdx,
      additionLineIndex: change.additionLineIndex + pair.addIdx,
    });
    prevDel = pair.delIdx + 1;
    prevAdd = pair.addIdx + 1;
  }

  const tailDel = delSlice.length - prevDel;
  const tailAdd = addSlice.length - prevAdd;
  if (tailDel > 0 || tailAdd > 0) {
    pushMergedContent(out, {
      type: 'change',
      deletions: tailDel,
      deletionLineIndex: change.deletionLineIndex + prevDel,
      additions: tailAdd,
      additionLineIndex: change.additionLineIndex + prevAdd,
    });
  }

  return out;
}

/**
 * Re-shapes diff hunks so indentation/whitespace-only paired line edits behave as
 * unchanged context lines while preserving original line offsets and indices.
 */
export function hideWhitespaceChanges(fileDiff: FileDiffMetadata): FileDiffMetadata {
  const next = cloneFileDiffMetadata(fileDiff);
  const newHunks: Hunk[] = [];
  let unifiedCursor = 0;
  let splitCursor = 0;
  let carriedCollapsedLines = 0;

  for (const hunk of next.hunks) {
    const rewrittenContent: (ContextContent | ChangeContent)[] = [];
    for (const seg of hunk.hunkContent) {
      if (seg.type === 'context') {
        pushMergedContent(rewrittenContent, seg);
      } else {
        const split = splitChangeContentIgnoringWhitespace(
          seg,
          next.deletionLines,
          next.additionLines
        );
        for (const piece of split) {
          pushMergedContent(rewrittenContent, piece);
        }
      }
    }

    let hunkAdds = 0;
    let hunkDels = 0;
    let hunkContext = 0;
    let unifiedLines = 0;
    let splitLines = 0;

    for (const seg of rewrittenContent) {
      if (seg.type === 'context') {
        hunkContext += seg.lines;
        unifiedLines += seg.lines;
        splitLines += seg.lines;
      } else {
        hunkAdds += seg.additions;
        hunkDels += seg.deletions;
        unifiedLines += seg.additions + seg.deletions;
        splitLines += Math.max(seg.additions, seg.deletions);
      }
    }

    if (hunkAdds === 0 && hunkDels === 0) {
      carriedCollapsedLines += hunk.collapsedBefore + hunkContext;
      continue;
    }

    const collapsedBefore = hunk.collapsedBefore + carriedCollapsedLines;
    carriedCollapsedLines = 0;

    if (collapsedBefore > 0) {
      unifiedCursor += 1;
      splitCursor += 1;
    }

    const updatedHunk: Hunk = {
      ...hunk,
      collapsedBefore,
      hunkContent: rewrittenContent,
      additionLines: hunkAdds,
      deletionLines: hunkDels,
      additionCount: hunkContext + hunkAdds,
      deletionCount: hunkContext + hunkDels,
      unifiedLineStart: unifiedCursor,
      unifiedLineCount: unifiedLines,
      splitLineStart: splitCursor,
      splitLineCount: splitLines,
    };

    unifiedCursor += unifiedLines;
    splitCursor += splitLines;
    newHunks.push(updatedHunk);
  }

  next.hunks = newHunks;
  next.unifiedLineCount = unifiedCursor;
  next.splitLineCount = splitCursor;
  if (next.cacheKey) {
    next.cacheKey = `${next.cacheKey}:ignore-ws`;
  }
  return next;
}

function normalizePathForHeader(filePath?: string): string {
  const cleaned = (filePath ?? 'diff.txt').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  return cleaned || 'diff.txt';
}

function synthesizeUnifiedPatchFromRawString(raw: string, filePath?: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^diff --git\s/m.test(trimmed)) {
    return trimmed;
  }

  const normalizedPath = normalizePathForHeader(filePath);
  const lines = trimmed.replace(/\r\n/g, '\n').split('\n');
  const hasFileHeaders =
    lines.some((l) => l.startsWith('--- ')) && lines.some((l) => l.startsWith('+++ '));
  if (hasFileHeaders) {
    return `diff --git a/${normalizedPath} b/${normalizedPath}\n${lines.join('\n')}`;
  }

  if (lines.some((l) => l.startsWith('@@'))) {
    return [
      `diff --git a/${normalizedPath} b/${normalizedPath}`,
      `--- a/${normalizedPath}`,
      `+++ b/${normalizedPath}`,
      ...lines,
    ].join('\n');
  }

  return '';
}

/**
 * Converts a Kite `DiffData` payload (preferring `rawPatch` when present, or
 * reconstructing a canonical unified patch from `lines`) for `@pierre/diffs`.
 */
export function diffDataToRawPatch(
  diff: DiffData | string | null | undefined,
  options?: Pick<ConvertDiffOptions, 'filePath' | 'status' | 'oldPath'>
): string | null {
  if (!diff) return null;

  if (typeof diff === 'string') {
    const patch = synthesizeUnifiedPatchFromRawString(diff, options?.filePath);
    return patch || null;
  }

  if (diff.rawPatch && diff.rawPatch.trim().length > 0) {
    return diff.rawPatch;
  }

  if (!diff.lines || diff.lines.length === 0) {
    return null;
  }

  const newPath = normalizePathForHeader(options?.filePath);
  const oldPath = normalizePathForHeader(options?.oldPath ?? newPath);
  const isNew = options?.status === 'added' || options?.status === 'untracked';
  const isDeleted = options?.status === 'deleted';

  const metaLines: string[] = [];
  const bodyLines: string[] = [];

  for (const line of diff.lines) {
    if (line.kind === 'meta') {
      if (line.text.startsWith('\\')) {
        bodyLines.push(line.text);
      } else {
        metaLines.push(line.text);
      }
      continue;
    }
    if (line.kind === 'hunk') {
      bodyLines.push(line.text);
    } else if (line.kind === 'added') {
      bodyLines.push(`+${line.text}`);
    } else if (line.kind === 'removed') {
      bodyLines.push(`-${line.text}`);
    } else {
      bodyLines.push(` ${line.text}`);
    }
  }

  if (bodyLines.length === 0) {
    return null;
  }

  const hasDiffHeader = metaLines.some((l) => l.startsWith('diff --git '));
  const hasMinusHeader = metaLines.some((l) => l.startsWith('--- '));
  const hasPlusHeader = metaLines.some((l) => l.startsWith('+++ '));
  const hasHunk = bodyLines.some((l) => l.startsWith('@@'));

  const header: string[] = [];
  if (!hasDiffHeader) {
    header.push(`diff --git a/${oldPath} b/${newPath}`);
    if (isNew) {
      header.push('new file mode 100644');
    } else if (isDeleted) {
      header.push('deleted file mode 100644');
    }
  }
  header.push(...metaLines);
  if (!hasMinusHeader) {
    header.push(isNew ? '--- /dev/null' : `--- a/${oldPath}`);
  }
  if (!hasPlusHeader) {
    header.push(isDeleted ? '+++ /dev/null' : `+++ b/${newPath}`);
  }

  if (!hasHunk) {
    let oldCount = 0;
    let newCount = 0;
    let firstOld = 1;
    let firstNew = 1;
    for (const line of diff.lines) {
      if (line.kind === 'context' || line.kind === 'removed') {
        if (oldCount === 0 && line.oldNumber != null) firstOld = line.oldNumber;
        oldCount++;
      }
      if (line.kind === 'context' || line.kind === 'added') {
        if (newCount === 0 && line.newNumber != null) firstNew = line.newNumber;
        newCount++;
      }
    }
    const oldSpec = oldCount === 0 ? '0,0' : `${firstOld},${oldCount}`;
    const newSpec = newCount === 0 ? '0,0' : `${firstNew},${newCount}`;
    bodyLines.unshift(`@@ -${oldSpec} +${newSpec} @@`);
  }

  return [...header, ...bodyLines].join('\n');
}

/**
 * Parses a raw patch string or Kite `DiffData` into a `@pierre/diffs`
 * `FileDiffMetadata` object ready for syntax highlighting and rendering.
 */
export function parseDiffDataToFileMetadata(
  diff: DiffData | string | null | undefined,
  options?: ConvertDiffOptions
): FileDiffMetadata | null {
  const rawPatch = diffDataToRawPatch(diff, options);
  if (!rawPatch) return null;

  try {
    const parsedPatches = parsePatchFiles(
      rawPatch,
      options?.cacheKey ? { cacheKeyPrefix: options.cacheKey } : undefined
    );
    const firstFile = parsedPatches.flatMap((patch) => patch.files)[0];
    if (!firstFile) return null;

    const normalizedFile: FileDiffMetadata =
      options?.filePath && (!firstFile.name || firstFile.name === 'diff.txt')
        ? {
            ...firstFile,
            name: normalizePathForHeader(options.filePath),
            ...(options.oldPath ? { prevName: normalizePathForHeader(options.oldPath) } : {}),
          }
        : firstFile;

    return options?.ignoreWhitespace ? hideWhitespaceChanges(normalizedFile) : normalizedFile;
  } catch {
    return null;
  }
}

export function getFileDiffLineStat(fileDiff: FileDiffMetadata | null | undefined): DiffLineStat {
  if (!fileDiff) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const hunk of fileDiff.hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return { additions, deletions };
}

export function getDiffDataLineStat(
  diff: DiffData | string | null | undefined,
  options?: { ignoreWhitespace?: boolean; filePath?: string; status?: string; oldPath?: string | null }
): DiffLineStat {
  if (!diff) return { additions: 0, deletions: 0 };

  if (options?.ignoreWhitespace || typeof diff === 'string' || diff.rawPatch) {
    const parsed = parseDiffDataToFileMetadata(diff, options);
    if (parsed) {
      return getFileDiffLineStat(parsed);
    }
  }

  if (typeof diff === 'string') {
    return { additions: 0, deletions: 0 };
  }

  let additions = 0;
  let deletions = 0;
  for (const line of diff.lines) {
    if (line.kind === 'added') additions++;
    else if (line.kind === 'removed') deletions++;
  }
  return { additions, deletions };
}
