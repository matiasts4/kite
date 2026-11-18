import { describe, it, expect } from 'vitest';
import type { GitFileChange } from '../files/gitTypes';
import { buildDiffFileTree, collectDiffTreeFolderPaths } from './diffFileTree.logic';

function makeFile(path: string, status: GitFileChange['status'] = 'modified'): GitFileChange {
  return {
    path,
    status,
    oldPath: null,
    staged: false,
    unstaged: true,
  };
}

describe('buildDiffFileTree', () => {
  it('sorts directories before files alphabetically and compresses linear folder chains', () => {
    const files = [
      makeFile('README.md'),
      makeFile('src/components/views/diffs/DiffsView.tsx'),
      makeFile('src/components/views/diffs/DiffCodeViewer.tsx'),
      makeFile('package.json'),
    ];

    const tree = buildDiffFileTree(files);
    expect(tree.map((node) => `${node.kind}:${node.name}`)).toEqual([
      'folder:src/components/views/diffs',
      'file:package.json',
      'file:README.md',
    ]);

    const compressedFolder = tree[0];
    expect(compressedFolder.kind).toBe('folder');
    if (compressedFolder.kind === 'folder') {
      expect(compressedFolder.path).toBe('src/components/views/diffs');
      expect(compressedFolder.fileCount).toBe(2);
      expect(compressedFolder.children.map((c) => c.name)).toEqual([
        'DiffCodeViewer.tsx',
        'DiffsView.tsx',
      ]);
    }
  });

  it('splits folders cleanly at branch points', () => {
    const files = [
      makeFile('src/lib/a.ts'),
      makeFile('src/components/b.ts'),
      makeFile('src/main.ts'),
    ];

    const tree = buildDiffFileTree(files);
    expect(tree).toHaveLength(1);
    const srcNode = tree[0];
    expect(srcNode.kind).toBe('folder');
    if (srcNode.kind === 'folder') {
      expect(srcNode.name).toBe('src');
      expect(srcNode.fileCount).toBe(3);
      expect(srcNode.children.map((c) => `${c.kind}:${c.name}`)).toEqual([
        'folder:components',
        'folder:lib',
        'file:main.ts',
      ]);
    }
    expect(collectDiffTreeFolderPaths(tree)).toEqual([
      'src',
      'src/components',
      'src/lib',
    ]);
  });

  it('filters files before constructing compressed folder chains', () => {
    const files = [
      makeFile('src/lib/a.ts'),
      makeFile('src/components/b.ts'),
    ];

    const tree = buildDiffFileTree(files, 'components');
    expect(tree).toHaveLength(1);
    expect(tree[0].kind).toBe('folder');
    if (tree[0].kind === 'folder') {
      expect(tree[0].name).toBe('src/components');
      expect(tree[0].fileCount).toBe(1);
    }
  });
});
