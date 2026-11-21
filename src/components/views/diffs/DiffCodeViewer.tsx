import React, { Suspense } from 'react';
import type { FileDiffContentsLoader } from '@pierre/diffs';
import type { DiffData } from '../chat/types';

const LazyKiteDiffView = React.lazy(() =>
  import('../../diffs/KiteDiffView').then((m) => ({ default: m.KiteDiffView }))
);

export interface DiffCodeViewerProps {
  diff: DiffData | null;
  layout: 'unified' | 'split';
  wordWrap: boolean;
  ignoreWhitespace?: boolean;
  filePath?: string;
  oldPath?: string | null;
  status?: string;
  cacheKey?: string;
  loadDiffFiles?: FileDiffContentsLoader;
}

export const DiffCodeViewer = React.memo<DiffCodeViewerProps>(({
  diff,
  layout,
  wordWrap,
  ignoreWhitespace = false,
  filePath,
  oldPath,
  status,
  cacheKey,
  loadDiffFiles,
}) => {
  return (
    <Suspense fallback={<div className="kite-diff-surface kite-diff-surface--loading" />}>
      <LazyKiteDiffView
        diff={diff}
        filePath={filePath}
        oldPath={oldPath}
        status={status}
        layout={layout}
        wordWrap={wordWrap}
        ignoreWhitespace={ignoreWhitespace}
        hideFileHeader={true}
        lineDiffType="word-alt"
        cacheKey={cacheKey}
        loadDiffFiles={loadDiffFiles}
        emptyMessage="No changes in this file or file is empty."
      />
    </Suspense>
  );
});
