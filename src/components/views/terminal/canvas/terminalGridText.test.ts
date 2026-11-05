import { describe, expect, it } from 'vitest';
import type { CellSnapshot } from './terminalCanvasTypes';
import { collectFindHits, findGridLink, visibleScreenText } from './terminalGridText';

function cell(ch: string, width = 1): CellSnapshot {
  return {
    ch,
    width,
    fg: [250, 250, 250],
    bg: [10, 10, 10],
    hasBg: false,
    bold: false,
    italic: false,
    underline: false,
    inverse: false,
    dim: false,
  };
}

describe('terminalGridText', () => {
  it('maps a wide continuation click onto the file link that follows', () => {
    const matrix = [[
      cell('你', 2),
      cell('', 0),
      cell('a', 1),
      cell('.', 1),
      cell('t', 1),
      cell('s', 1),
    ]];
    const hit = findGridLink(matrix, [false], 0, 2);
    expect(hit?.text).toBe('a.ts');
    expect(hit?.kind).toBe('file');
    expect(hit?.startCol).toBe(2);
  });

  it('joins a wrapped path and underlines only the hovered row', () => {
    const matrix = [
      [cell('s'), cell('r'), cell('c'), cell('/'), cell('f'), cell('o'), cell('o'), cell('/')],
      [cell('b'), cell('a'), cell('r'), cell('.'), cell('t'), cell('s')],
    ];
    const hit = findGridLink(matrix, [true, false], 1, 0);
    expect(hit?.text).toBe('src/foo/bar.ts');
    expect(hit?.row).toBe(1);
    expect(hit?.startCol).toBe(0);
    expect(hit?.endCol).toBe(6);
  });

  it('finds a match that crosses a wrapped row', () => {
    const matrix = [
      [cell('h'), cell('e'), cell('l'), cell('l'), cell('o'), cell('-')],
      [cell('n'), cell('e'), cell('e'), cell('d'), cell('l'), cell('e')],
    ];
    const hits = collectFindHits(matrix, [true, false], 'lo-nee');
    expect(hits.map((hit) => hit.row)).toEqual([0, 1]);
  });

  it('builds live text from nonempty rows and skips wide continuations', () => {
    const matrix = [
      [cell('你', 2), cell('', 0), cell('A')],
      [cell(' ')],
      [cell('next')],
      [cell(' ')],
    ];
    expect(visibleScreenText(matrix)).toBe('你A\nnext');
  });
});