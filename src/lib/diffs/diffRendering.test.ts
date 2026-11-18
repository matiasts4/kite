import { describe, expect, it, vi } from 'vitest';
import {
  diffDataToRawPatch,
  getDiffDataLineStat,
  getFileDiffLineStat,
  hideWhitespaceChanges,
  isTestFilePath,
  parseDiffDataToFileMetadata,
} from './diffRendering';
import { createDiffFileContentsLoader } from './diffFileContents';
import {
  buildReadableLightTheme,
  KITE_DARK_SYNTAX_THEME,
  KITE_LIGHT_SYNTAX_THEME,
  resolveDiffThemeName,
  resolveKiteDiffThemes,
} from './readableSyntaxTheme';
import pierreLight from '@pierre/highlights/themes/pierre-light';

describe('readableSyntaxTheme', () => {
  it('resolves dark and light theme names cleanly', () => {
    expect(resolveDiffThemeName('dark')).toBe(KITE_DARK_SYNTAX_THEME);
    expect(resolveDiffThemeName('light')).toBe(KITE_LIGHT_SYNTAX_THEME);
    expect(resolveDiffThemeName('dark', 'tokyo-night')).toBe('tokyo-night');
    expect(resolveDiffThemeName('dark', 'aurora-studio')).toBe('tokyo-night');
    expect(resolveDiffThemeName('dark', 'nord')).toBe('nord');
    expect(resolveDiffThemeName('light', 'warm-atelier')).toBe('solarized-light');
    expect(resolveDiffThemeName('light', 'github-light')).toBe('github-light');
    expect(resolveKiteDiffThemes('dracula', 'catppuccin-latte')).toEqual({
      dark: 'dracula',
      light: 'catppuccin-latte',
    });
  });

  it('darkens low-contrast comment and punctuation tokens for kite-light', () => {
    const theme = buildReadableLightTheme(pierreLight);
    expect(theme.name).toBe(KITE_LIGHT_SYNTAX_THEME);
    expect(theme.appearance).toBe('light');
    expect(theme.style.syntax?.comment).toEqual({ color: '#52525b' });
    expect(theme.style.syntax?.punctuation).toEqual({ color: '#3f3f46' });
  });
});

describe('isTestFilePath', () => {
  it('matches standard test and spec file conventions without matching app files', () => {
    expect(isTestFilePath('src/components/DiffsView.test.tsx')).toBe(true);
    expect(isTestFilePath('src/lib/parser.spec.ts')).toBe(true);
    expect(isTestFilePath('pkg/runner_test.go')).toBe(true);
    expect(isTestFilePath('src/__tests__/app.ts')).toBe(true);
    expect(isTestFilePath('src/components/DiffsView.tsx')).toBe(false);
    expect(isTestFilePath('src/lib/testHelpers.ts')).toBe(false);
  });
});

describe('diffRendering', () => {
  it('reconstructs canonical patch and strips diff --git headers when parsing legacy DiffData', () => {
    const meta = parseDiffDataToFileMetadata(
      {
        truncated: false,
        lines: [
          { kind: 'meta', oldNumber: null, newNumber: null, text: 'diff --git a/index.html b/index.html' },
          { kind: 'hunk', oldNumber: null, newNumber: null, text: '@@ -1,2 +1,2 @@' },
          { kind: 'context', oldNumber: 1, newNumber: 1, text: '<!DOCTYPE html>' },
          { kind: 'removed', oldNumber: 2, newNumber: null, text: '<title>Old</title>' },
          { kind: 'added', oldNumber: null, newNumber: 2, text: '<title>New Clean Diff</title>' },
        ],
      },
      { filePath: 'index.html' }
    );

    expect(meta).not.toBeNull();
    expect(meta?.name).toBe('index.html');
    expect(getFileDiffLineStat(meta)).toEqual({ additions: 1, deletions: 1 });
  });

  it('compacts indentation-only changes around inserted lines while preserving real edits', () => {
    const patch = [
      'diff --git a/item.tsx b/item.tsx',
      '--- a/item.tsx',
      '+++ b/item.tsx',
      '@@ -40,5 +40,7 @@',
      ' <ItemContent>',
      '-  <ItemTitle>',
      '-    <h4>{name}</h4>',
      '-  </ItemTitle>',
      '+  {showName && (',
      '+    <ItemTitle>',
      '+      <h4>{name}</h4>',
      '+    </ItemTitle>',
      '+  )}',
      ' </ItemContent>',
      '@@ -80,1 +82,1 @@',
      '-const value = 1;',
      '+const value = 2;',
    ].join('\n');

    const shown = parseDiffDataToFileMetadata(patch, { filePath: 'item.tsx', cacheKey: 'k1' });
    const hidden = parseDiffDataToFileMetadata(patch, {
      filePath: 'item.tsx',
      cacheKey: 'k1',
      ignoreWhitespace: true,
    });

    expect(shown && getFileDiffLineStat(shown)).toEqual({ additions: 6, deletions: 4 });
    expect(hidden && getFileDiffLineStat(hidden)).toEqual({ additions: 3, deletions: 1 });
    expect(hidden?.hunks[0]?.hunkContent).toContainEqual({
      type: 'context',
      lines: 3,
      deletionLineIndex: 1,
      additionLineIndex: 2,
    });
    expect(shown?.cacheKey).toContain('k1:');
    expect(hidden?.cacheKey).toBe(`${shown?.cacheKey}:ignore-ws`);
    expect(hidden && hideWhitespaceChanges(shown!).hunks.length).toBe(2);
  });

  it('drops whole hunks when every edit in a hunk is whitespace-only', () => {
    const patch = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,1 +1,1 @@',
      '-const a =   1;',
      '+const a = 1;',
    ].join('\n');

    const hidden = parseDiffDataToFileMetadata(patch, { filePath: 'a.ts', ignoreWhitespace: true });
    expect(hidden?.hunks).toEqual([]);
    expect(getDiffDataLineStat(patch, { filePath: 'a.ts', ignoreWhitespace: true })).toEqual({
      additions: 0,
      deletions: 0,
    });
  });

  it('synthesizes patch from raw unified hunk string without git prefix', () => {
    const raw = ['--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1,1 +1,1 @@', '-old()', '+new()'].join('\n');
    expect(diffDataToRawPatch(raw, { filePath: 'src/app.ts' })).toContain('diff --git a/src/app.ts b/src/app.ts');
    const meta = parseDiffDataToFileMetadata(raw, { filePath: 'src/app.ts' });
    expect(meta?.name).toBe('src/app.ts');
    expect(getFileDiffLineStat(meta)).toEqual({ additions: 1, deletions: 1 });
  });
});

describe('createDiffFileContentsLoader', () => {
  it('loads and caches old/new file contents for context expansion', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      oldContent: 'line1\nold2\nline3\n',
      newContent: 'line1\nnew2\nline3\n',
    });
    const loader = createDiffFileContentsLoader('ws-1', fetcher);
    const meta = parseDiffDataToFileMetadata(
      [
        'diff --git a/src/demo.ts b/src/demo.ts',
        '--- a/src/demo.ts',
        '+++ b/src/demo.ts',
        '@@ -2,1 +2,1 @@',
        '-old2',
        '+new2',
      ].join('\n'),
      { filePath: 'src/demo.ts', cacheKey: 'demo' }
    )!;

    const first = await loader(meta);
    const second = await loader(meta);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('src/demo.ts', 'src/demo.ts');
    expect(first).toBe(second);
    expect(first.oldFile?.contents).toContain('old2');
    expect(first.newFile.contents).toContain('new2');
  });
});
