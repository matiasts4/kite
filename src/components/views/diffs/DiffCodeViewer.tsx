import React from 'react';
import type { FileDiffContentsLoader } from '@pierre/diffs';
import { KiteDiffView } from '../../diffs/KiteDiffView';
import type { DiffData } from '../chat/types';

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
    <KiteDiffView
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
  );
});
