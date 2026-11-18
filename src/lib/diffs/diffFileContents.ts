import type {
  FileContents,
  FileDiffContentsLoader,
  FileDiffLoadedFiles,
  FileDiffMetadata,
} from '@pierre/diffs';

export interface DiffFileContentsPair {
  oldContent: string | null;
  newContent: string | null;
}

export type FetchDiffFileContents = (
  oldPath: string | null,
  newPath: string | null
) => Promise<DiffFileContentsPair>;

function toFileContents(name: string, contents: string, cacheKey: string): FileContents {
  return {
    name,
    contents,
    cacheKey,
  };
}

/**
 * Builds a `@pierre/diffs` `FileDiffContentsLoader` backed by Kite's workspace
 * git/file IPC so clicking `"N unmodified lines"` expands full surrounding context.
 */
export function createDiffFileContentsLoader(
  workspaceId: string,
  fetchContents: FetchDiffFileContents
): FileDiffContentsLoader {
  const cache = new Map<string, Promise<FileDiffLoadedFiles>>();

  return (fileDiff: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
    const newPath = fileDiff.name;
    const oldPath =
      fileDiff.type === 'new'
        ? null
        : fileDiff.prevName ?? (fileDiff.type === 'rename-pure' ? null : fileDiff.name);
    const cacheKey = `${workspaceId}:${oldPath ?? ''}:${newPath}:${fileDiff.cacheKey ?? ''}`;

    const existing = cache.get(cacheKey);
    if (existing) return existing;

    const promise = (async (): Promise<FileDiffLoadedFiles> => {
      const pair = await fetchContents(oldPath, newPath);
      if (fileDiff.type === 'rename-pure') {
        const content = pair.newContent ?? pair.oldContent ?? '';
        return {
          oldFile: null,
          newFile: toFileContents(newPath, content, `${cacheKey}:new`),
        };
      }

      if (pair.oldContent === null && pair.newContent === null) {
        throw new Error(`Unable to load surrounding context for ${newPath}`);
      }

      const oldContent =
        pair.oldContent ?? fileDiff.deletionLines.join('\n');
      const newContent =
        pair.newContent ?? fileDiff.additionLines.join('\n');

      return {
        oldFile: toFileContents(oldPath ?? newPath, oldContent, `${cacheKey}:old`),
        newFile: toFileContents(newPath, newContent, `${cacheKey}:new`),
      };
    })().catch((err) => {
      cache.delete(cacheKey);
      throw err;
    });

    cache.set(cacheKey, promise);
    return promise;
  };
}
