import React, { useMemo } from 'react';
import {
  type FileDiffContentsLoader,
  type FileDiffMetadata,
  type FileDiffOptions,
  type LineDiffTypes,
} from '@pierre/diffs';
import { FileDiff } from '@pierre/diffs/react';
import { DiffWorkerPoolProvider } from './DiffWorkerPoolProvider';
import type { DiffData } from '../views/chat/types';
import {
  DIFF_SURFACE_THEME_UNSAFE_CSS,
  parseDiffDataToFileMetadata,
} from '../../lib/diffs/diffRendering';
import {
  ensureReadableLightDiffTheme,
  resolveKiteDiffThemes,
} from '../../lib/diffs/readableSyntaxTheme';
import { PREFERRED_DIFF_HIGHLIGHTER } from '../../lib/diffs/syntaxHighlighting';
import { useKiteThemeVisualState } from '../../lib/diffs/useKiteThemeMode';

export interface KiteDiffViewProps {
  diff?: DiffData | string | null;
  fileDiff?: FileDiffMetadata | null;
  filePath?: string;
  oldPath?: string | null;
  status?: string;
  layout?: 'unified' | 'split';
  wordWrap?: boolean;
  ignoreWhitespace?: boolean;
  hideFileHeader?: boolean;
  lineDiffType?: LineDiffTypes;
  cacheKey?: string;
  loadDiffFiles?: FileDiffContentsLoader;
  truncated?: boolean;
  className?: string;
  emptyMessage?: string;
  expandUnchanged?: boolean;
}

/**
 * Shared Kite diff surface powered by `@pierre/diffs`: renders a single
 * line-number gutter in unified mode, WASM syntax highlighting, intra-line
 * word-level diff highlights, and clickable `N unmodified lines` separators.
 */
export const KiteDiffView: React.FC<KiteDiffViewProps> = ({
  diff,
  fileDiff: providedFileDiff,
  filePath,
  oldPath,
  status,
  layout = 'unified',
  wordWrap = true,
  ignoreWhitespace = false,
  hideFileHeader = true,
  lineDiffType = 'word-alt',
  cacheKey,
  loadDiffFiles,
  truncated = false,
  className,
  emptyMessage = 'No text diff available for this file.',
  expandUnchanged = false,
}) => {
  ensureReadableLightDiffTheme();

  const themeState = useKiteThemeVisualState();
  const diffThemes = useMemo(
    () => resolveKiteDiffThemes(themeState.darkThemeId, themeState.lightThemeId),
    [themeState.darkThemeId, themeState.lightThemeId]
  );

  const resolvedFileDiff = useMemo<FileDiffMetadata | null>(() => {
    if (providedFileDiff) return providedFileDiff;
    return parseDiffDataToFileMetadata(diff, {
      filePath,
      oldPath,
      status,
      cacheKey,
      ignoreWhitespace,
    });
  }, [providedFileDiff, diff, filePath, oldPath, status, cacheKey, ignoreWhitespace]);

  const options = useMemo<FileDiffOptions<undefined, undefined>>(
    () => ({
      diffStyle: layout === 'split' ? 'split' : 'unified',
      diffIndicators: 'bars',
      disableBackground: false,
      hunkSeparators: 'line-info',
      expandUnchanged,
      overflow: wordWrap ? 'wrap' : 'scroll',
      disableFileHeader: hideFileHeader,
      theme: diffThemes,
      themeType: themeState.mode,
      preferredHighlighter: PREFERRED_DIFF_HIGHLIGHTER,
      lineDiffType,
      unsafeCSS: DIFF_SURFACE_THEME_UNSAFE_CSS,
      ...(loadDiffFiles ? { loadDiffFiles } : {}),
    }),
    [layout, expandUnchanged, wordWrap, hideFileHeader, diffThemes, themeState.mode, lineDiffType, loadDiffFiles]
  );

  const isTruncated =
    truncated || (typeof diff === 'object' && diff !== null && Boolean(diff.truncated));

  if (!resolvedFileDiff) {
    return (
      <div className={`kite-diff-surface kite-diff-surface--empty ${className ?? ''}`.trim()}>
        <div className="kite-diff-empty">{emptyMessage}</div>
      </div>
    );
  }

  if (ignoreWhitespace && resolvedFileDiff.hunks.length === 0) {
    return (
      <div className={`kite-diff-surface kite-diff-surface--empty ${className ?? ''}`.trim()}>
        <div className="kite-diff-empty">
          Only whitespace or indentation changes in this file.
        </div>
      </div>
    );
  }

  const surfaceStyle = useMemo<React.CSSProperties | undefined>(() => {
    const vars: Record<string, string> = {};
    if (themeState.diffAdded) vars['--diff-addition'] = themeState.diffAdded;
    if (themeState.diffRemoved) vars['--diff-deletion'] = themeState.diffRemoved;
    if (themeState.codeFont) vars['--font-mono'] = themeState.codeFont;
    return Object.keys(vars).length > 0 ? (vars as React.CSSProperties) : undefined;
  }, [themeState.diffAdded, themeState.diffRemoved, themeState.codeFont]);

  return (
    <div
      className={`kite-diff-surface ${layout === 'split' ? 'kite-diff-surface--split' : 'kite-diff-surface--unified'} ${wordWrap ? 'wrap-enabled' : 'wrap-disabled'} ${className ?? ''}`.trim()}
      data-diff-layout={layout}
      data-word-wrap={wordWrap ? 'true' : 'false'}
      data-palette={themeState.palette}
      data-daltonized-diffs={themeState.daltonized ? 'true' : 'false'}
      style={surfaceStyle}
    >
      <DiffWorkerPoolProvider>
        <FileDiff fileDiff={resolvedFileDiff} options={options} />
      </DiffWorkerPoolProvider>
      {isTruncated && (
        <div className="diff-truncated-banner">
          Diff truncated to preserve interface responsiveness.
        </div>
      )}
    </div>
  );
};
