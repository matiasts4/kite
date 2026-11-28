import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  type FileDiffContentsLoader,
  type FileDiffMetadata,
  type FileDiffOptions,
  type LineDiffTypes,
} from '@pierre/diffs';
import { FileDiff, useWorkerPool } from '@pierre/diffs/react';
import type { WorkerPoolManager } from '@pierre/diffs/worker';
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

const poolIds = new WeakMap<WorkerPoolManager, number>();
let nextPoolId = 1;

function getPoolInstanceId(pool: WorkerPoolManager | undefined): number {
  if (!pool) return 0;
  let id = poolIds.get(pool);
  if (id === undefined) {
    id = nextPoolId++;
    poolIds.set(pool, id);
  }
  return id;
}

function isDocumentVisible(): boolean {
  if (typeof document === 'undefined') return true;
  return !document.hidden && document.visibilityState !== 'hidden';
}

function isElementAncestryVisible(el: HTMLElement | null): boolean {
  if (!isDocumentVisible()) return false;
  if (!el || !el.isConnected) return true;
  let current: HTMLElement | null = el;
  while (current) {
    if (current.hasAttribute('hidden')) return false;
    if (current.getAttribute('aria-hidden') === 'true') return false;
    if (
      current.classList.contains('mode-layer') &&
      !current.classList.contains('mode-layer--visible')
    ) {
      return false;
    }
    if (
      current.classList.contains('workspace-tab-layer') &&
      !current.classList.contains('workspace-tab-layer--active')
    ) {
      return false;
    }
    if (current.style.display === 'none' || current.style.visibility === 'hidden') {
      return false;
    }
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      const computed = window.getComputedStyle(current);
      if (computed.display === 'none' || computed.visibility === 'hidden') {
        return false;
      }
    }
    current = current.parentElement;
  }
  return true;
}

const PoolKeyedFileDiff: React.FC<{
  fileDiff: FileDiffMetadata;
  options: FileDiffOptions<undefined, undefined>;
}> = ({ fileDiff, options }) => {
  const pool = useWorkerPool();
  const lastLivePoolIdRef = useRef<number>(0);
  if (pool) {
    lastLivePoolIdRef.current = getPoolInstanceId(pool);
  }
  return <FileDiff key={lastLivePoolIdRef.current} fileDiff={fileDiff} options={options} />;
};

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

  const surfaceStyle = useMemo<React.CSSProperties | undefined>(() => {
    const vars: Record<string, string> = {};
    if (themeState.diffAdded) vars['--diff-addition'] = themeState.diffAdded;
    if (themeState.diffRemoved) vars['--diff-deletion'] = themeState.diffRemoved;
    if (themeState.codeFont) vars['--font-mono'] = themeState.codeFont;
    return Object.keys(vars).length > 0 ? (vars as React.CSSProperties) : undefined;
  }, [themeState.diffAdded, themeState.diffRemoved, themeState.codeFont]);

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [layerVisible, setLayerVisible] = useState<boolean>(false);
  const [ioVisible, setIoVisible] = useState<boolean>(true);
  const hasRenderableDiff = Boolean(
    resolvedFileDiff && !(ignoreWhitespace && resolvedFileDiff.hunks.length === 0)
  );

  useLayoutEffect(() => {
    if (!hasRenderableDiff) {
      setLayerVisible(false);
      return;
    }
    const el = surfaceRef.current;
    const syncVisibility = () => {
      const next = isElementAncestryVisible(el);
      setLayerVisible((prev) => (prev === next ? prev : next));
      if (!next) {
        setIoVisible(true);
      }
    };
    syncVisibility();

    const handleVisibilityChange = () => {
      syncVisibility();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    const mutationObserver =
      typeof MutationObserver !== 'undefined' && el
        ? new MutationObserver(() => syncVisibility())
        : null;
    if (mutationObserver && el) {
      let current: HTMLElement | null = el;
      while (current) {
        mutationObserver.observe(current, {
          attributes: true,
          attributeFilter: ['class', 'style', 'aria-hidden', 'hidden'],
        });
        current = current.parentElement;
      }
    }

    const intersectionObserver =
      typeof IntersectionObserver !== 'undefined' && el
        ? new IntersectionObserver((entries) => {
            const last = entries[entries.length - 1];
            if (last) {
              setIoVisible(last.isIntersecting);
            }
          })
        : null;
    if (intersectionObserver && el) {
      intersectionObserver.observe(el);
    }

    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      mutationObserver?.disconnect();
      intersectionObserver?.disconnect();
    };
  }, [hasRenderableDiff]);

  useEffect(() => {
    if (!layerVisible) {
      setIoVisible(true);
    }
  }, [layerVisible]);

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

  return (
    <div
      ref={surfaceRef}
      className={`kite-diff-surface ${layout === 'split' ? 'kite-diff-surface--split' : 'kite-diff-surface--unified'} ${wordWrap ? 'wrap-enabled' : 'wrap-disabled'} ${className ?? ''}`.trim()}
      data-diff-layout={layout}
      data-word-wrap={wordWrap ? 'true' : 'false'}
      data-palette={themeState.palette}
      data-daltonized-diffs={themeState.daltonized ? 'true' : 'false'}
      style={surfaceStyle}
    >
      {layerVisible ? (
        <DiffWorkerPoolProvider active={ioVisible}>
          <PoolKeyedFileDiff fileDiff={resolvedFileDiff} options={options} />
        </DiffWorkerPoolProvider>
      ) : null}
      {isTruncated && (
        <div className="diff-truncated-banner">
          Diff truncated to preserve interface responsiveness.
        </div>
      )}
    </div>
  );
};
