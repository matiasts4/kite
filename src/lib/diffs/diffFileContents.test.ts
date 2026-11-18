import { describe, it, expect, vi } from 'vitest';
import type { FileDiffMetadata } from '@pierre/diffs';
import { createDiffFileContentsLoader } from './diffFileContents';

function makeMetadata(overrides: Partial<FileDiffMetadata> = {}): FileDiffMetadata {
  return {
    name: 'src/app.ts',
    type: 'change',
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    deletionLines: ['old line'],
    additionLines: ['new line'],
    ...overrides,
  } as FileDiffMetadata;
}

describe('createDiffFileContentsLoader', () => {
  it('loads old and new file contents and caches repeated lookups per cache key', async () => {
    const fetchContents = vi.fn().mockResolvedValue({
      oldContent: 'line1\nold line\nline3',
      newContent: 'line1\nnew line\nline3',
    });

    const loader = createDiffFileContentsLoader('ws-1', fetchContents);
    const meta = makeMetadata({ cacheKey: 'v1' });

    const first = await loader(meta);
    const second = await loader(meta);

    expect(fetchContents).toHaveBeenCalledTimes(1);
    expect(fetchContents).toHaveBeenCalledWith('src/app.ts', 'src/app.ts');
    expect(first).toBe(second);
    expect(first.oldFile?.contents).toContain('old line');
    expect(first.newFile?.contents).toContain('new line');
  });

  it('evicts failed promises from cache and handles rename-pure without errors', async () => {
    const fetchContents = vi
      .fn()
      .mockResolvedValueOnce({ oldContent: null, newContent: null })
      .mockResolvedValueOnce({ oldContent: null, newContent: 'moved file' });

    const loader = createDiffFileContentsLoader('ws-1', fetchContents);
    const renameMeta = makeMetadata({
      name: 'src/moved.ts',
      prevName: 'src/old.ts',
      type: 'rename-pure',
    });

    await expect(loader(makeMetadata())).rejects.toThrow(/Unable to load surrounding context/);
    const renamed = await loader(renameMeta);
    expect(renamed.oldFile).toBeNull();
    expect(renamed.newFile?.contents).toBe('moved file');
  });
});
