import { describe, it, expect } from 'vitest';
import {
  decodeBinarySnapshot,
  decodeBinarySnapshotIntoGrid,
  classifyBinaryPollPayload,
  encodeBinarySnapshot,
  readBinarySnapshotSeq,
  SNAPSHOT_BIN_HEADER_LEN,
  DEFAULT_FG,
  DEFAULT_BG,
} from './binarySnapshotDecoder';
import { commitDirtyRows } from './snapshotApply';
import {
  type CellSnapshot,
  type GridState,
  type RenderSnapshot,
  type RowSnapshot,
} from './terminalCanvasTypes';

function cell(overrides: Partial<CellSnapshot> = {}): CellSnapshot {
  return {
    ch: ' ',
    width: 1,
    fg: DEFAULT_FG,
    bg: DEFAULT_BG,
    hasBg: false,
    bold: false,
    italic: false,
    underline: false,
    inverse: false,
    dim: false,
    ...overrides,
  };
}

/** Patches the two flag bytes of an encoded frame so individual bits can be exercised. */
function withFlags(bytes: Uint8Array, cursorFlags: number, modeFlags: number): Uint8Array {
  const copy = bytes.slice();
  copy[16] = cursorFlags;
  copy[17] = modeFlags;
  return copy;
}

function appendTrailing(bytes: Uint8Array, trailing: string): Uint8Array {
  const extra = new TextEncoder().encode(trailing);
  const out = new Uint8Array(bytes.byteLength + extra.byteLength);
  out.set(bytes, 0);
  out.set(extra, bytes.byteLength);
  return out;
}

describe('binarySnapshotDecoder', () => {
  it('decodes encoded snapshot with full field parity', () => {
    const original: RenderSnapshot = {
      seq: 142,
      cols: 80,
      rows: 24,
      alternateScreen: true,
      applicationCursor: true,
      bracketedPaste: true,
      mouseTracking: true,
      mouseMode: 'drag',
      sgrMouse: true,
      sgrPixelsMouse: true,
      focusReporting: true,
      win32InputMode: true,
      kittyKeyboardFlags: 3,
      scrollbackOffset: 12,
      scrollbackDepth: 400,
      benchmarkActive: true,
      title: 'kite — zsh',
      clipboardWrite: 'copied text',
      cursor: {
        visible: true,
        col: 12,
        row: 5,
        shape: 'bar',
        blink: true,
      },
      full: true,
      dirtyRows: [
        {
          rowIdx: 0,
          wrapped: false,
          cells: [
            cell({
              ch: 'K',
              fg: [255, 100, 50],
              bg: [20, 20, 20],
              hasBg: true,
              bold: true,
              underline: true,
            }),
            cell({ ch: 'i', italic: true }),
            cell({ ch: '', width: 0 }),
          ],
        },
        {
          rowIdx: 1,
          wrapped: true,
          cells: [cell({ ch: '🚀', width: 2 }), cell({ ch: '', width: 0 })],
        },
      ],
    };

    const encoded = encodeBinarySnapshot(original, {
      exited: false,
      exitCode: null,
      syncOutput: false,
    });

    const decoded = decodeBinarySnapshot(encoded);

    expect(decoded.snapshot.seq).toBe(original.seq);
    expect(decoded.snapshot.cols).toBe(original.cols);
    expect(decoded.snapshot.rows).toBe(original.rows);
    expect(decoded.snapshot.alternateScreen).toBe(original.alternateScreen);
    expect(decoded.snapshot.applicationCursor).toBe(original.applicationCursor);
    expect(decoded.snapshot.bracketedPaste).toBe(original.bracketedPaste);
    expect(decoded.snapshot.mouseTracking).toBe(original.mouseTracking);
    expect(decoded.snapshot.mouseMode).toBe(original.mouseMode);
    expect(decoded.snapshot.sgrMouse).toBe(original.sgrMouse);
    expect(decoded.snapshot.sgrPixelsMouse).toBe(original.sgrPixelsMouse);
    expect(decoded.snapshot.focusReporting).toBe(original.focusReporting);
    expect(decoded.snapshot.win32InputMode).toBe(original.win32InputMode);
    expect(decoded.snapshot.kittyKeyboardFlags).toBe(original.kittyKeyboardFlags);
    expect(decoded.snapshot.scrollbackOffset).toBe(original.scrollbackOffset);
    expect(decoded.snapshot.scrollbackDepth).toBe(original.scrollbackDepth);
    expect(decoded.snapshot.benchmarkActive).toBe(original.benchmarkActive);
    expect(decoded.snapshot.title).toBe(original.title);
    expect(decoded.snapshot.clipboardWrite).toBe(original.clipboardWrite);
    expect(decoded.snapshot.full).toBe(original.full);
    expect(decoded.exited).toBe(false);
    expect(decoded.exitCode).toBeNull();
    expect(decoded.syncOutput).toBe(false);

    expect(decoded.snapshot.cursor).toEqual(original.cursor);

    expect(decoded.snapshot.dirtyRows.length).toBe(original.dirtyRows.length);
    for (let r = 0; r < original.dirtyRows.length; r += 1) {
      const origRow = original.dirtyRows[r]!;
      const decRow = decoded.snapshot.dirtyRows[r]!;
      expect(decRow.rowIdx).toBe(origRow.rowIdx);
      expect(decRow.wrapped).toBe(origRow.wrapped);
      expect(decRow.cells.length).toBe(origRow.cells.length);

      for (let c = 0; c < origRow.cells.length; c += 1) {
        expect(decRow.cells[c]).toEqual(origRow.cells[c]);
      }
    }
  });

  it('reads cursor blink from bit 1 of cursor_flags', () => {
    const base: RenderSnapshot = {
      seq: 7,
      cols: 4,
      rows: 2,
      alternateScreen: false,
      cursor: { visible: true, col: 1, row: 1, shape: 'block', blink: true },
      full: true,
      dirtyRows: [{ rowIdx: 0, cells: [cell({ ch: 'A' })] }],
    };

    const blinking = decodeBinarySnapshot(
      withFlags(encodeBinarySnapshot(base), 0x01 | 0x02, 0x01)
    );
    expect(blinking.snapshot.cursor.blink).toBe(true);
    expect(blinking.snapshot.cursor.visible).toBe(true);

    const steady = decodeBinarySnapshot(
      withFlags(encodeBinarySnapshot(base), 0x01, 0x01)
    );
    expect(steady.snapshot.cursor.blink).toBe(false);
  });

  it('reads application cursor from bit 6 of mode_flags', () => {
    const base: RenderSnapshot = {
      seq: 8,
      cols: 4,
      rows: 2,
      alternateScreen: false,
      cursor: { visible: true, col: 0, row: 0, shape: 'block', blink: false },
      full: true,
      dirtyRows: [{ rowIdx: 0, cells: [cell({ ch: 'A' })] }],
    };

    const patched = withFlags(encodeBinarySnapshot(base), 0x01, 0x01 | 0x40);
    const decoded = decodeBinarySnapshot(patched);
    expect(decoded.snapshot.applicationCursor).toBe(true);

    const plain = decodeBinarySnapshot(withFlags(encodeBinarySnapshot(base), 0x01, 0x01));
    expect(plain.snapshot.applicationCursor).toBe(false);
  });

  it('decodes the extended metadata tail when bit 7 of mode_flags is set', () => {
    const snapshot: RenderSnapshot = {
      seq: 9,
      cols: 10,
      rows: 3,
      alternateScreen: false,
      cursor: { visible: true, col: 2, row: 1, shape: 'underline', blink: false },
      full: false,
      mouseMode: 'any',
      sgrMouse: true,
      sgrPixelsMouse: true,
      focusReporting: true,
      win32InputMode: true,
      kittyKeyboardFlags: 5,
      scrollbackOffset: 33,
      scrollbackDepth: 900,
      benchmarkActive: true,
      title: 'tail title',
      clipboardWrite: 'tail clipboard',
      dirtyRows: [{ rowIdx: 1, cells: [cell({ ch: 'x' })] }],
    };

    const encoded = encodeBinarySnapshot(snapshot);
    expect((encoded[17]! & 0x80) !== 0).toBe(true);

    const decoded = decodeBinarySnapshot(encoded);
    expect(decoded.snapshot.title).toBe('tail title');
    expect(decoded.snapshot.clipboardWrite).toBe('tail clipboard');
    expect(decoded.snapshot.mouseMode).toBe('any');
    expect(decoded.snapshot.sgrMouse).toBe(true);
    expect(decoded.snapshot.sgrPixelsMouse).toBe(true);
    expect(decoded.snapshot.focusReporting).toBe(true);
    expect(decoded.snapshot.win32InputMode).toBe(true);
    expect(decoded.snapshot.kittyKeyboardFlags).toBe(5);
    expect(decoded.snapshot.scrollbackOffset).toBe(33);
    expect(decoded.snapshot.scrollbackDepth).toBe(900);
    expect(decoded.snapshot.benchmarkActive).toBe(true);
  });

  it('ignores trailing bytes when bit 7 of mode_flags is clear', () => {
    const snapshot: RenderSnapshot = {
      seq: 10,
      cols: 4,
      rows: 1,
      alternateScreen: false,
      cursor: { visible: true, col: 0, row: 0, shape: 'block', blink: false },
      full: true,
      dirtyRows: [{ rowIdx: 0, cells: [cell({ ch: 'A' })] }],
    };

    const plain = encodeBinarySnapshot(snapshot);
    const tampered = appendTrailing(plain, '{"title":"should be ignored"}');
    const decoded = decodeBinarySnapshot(tampered);

    expect(decoded.snapshot.title).toBeNull();
    expect(decoded.snapshot.clipboardWrite).toBeNull();
    expect(decoded.snapshot.benchmarkActive).toBeUndefined();
    expect(decoded.snapshot.dirtyRows[0]?.cells[0]?.ch).toBe('A');
  });

  it('keeps decoding when bit 7 is set but no tail or an invalid tail is present', () => {
    const snapshot: RenderSnapshot = {
      seq: 11,
      cols: 4,
      rows: 1,
      alternateScreen: false,
      cursor: { visible: true, col: 0, row: 0, shape: 'block', blink: false },
      full: true,
      dirtyRows: [{ rowIdx: 0, cells: [cell({ ch: 'A' })] }],
    };

    const plain = encodeBinarySnapshot(snapshot);
    const flagOnly = withFlags(plain, 0x01, 0x01 | 0x80);
    expect(() => decodeBinarySnapshot(flagOnly)).not.toThrow();
    expect(decodeBinarySnapshot(flagOnly).snapshot.title).toBeNull();

    const corrupt = appendTrailing(withFlags(plain, 0x01, 0x01), '{"title":');
    expect(() => decodeBinarySnapshot(corrupt)).not.toThrow();
    expect(decodeBinarySnapshot(corrupt).snapshot.title).toBeNull();
    expect(decodeBinarySnapshot(corrupt).snapshot.dirtyRows[0]?.cells[0]?.ch).toBe('A');
  });

  it('exposes packed row views and packed buffer offsets for zero-object painting', () => {
    const snapshot: RenderSnapshot = {
      seq: 12,
      cols: 4,
      rows: 2,
      alternateScreen: false,
      cursor: { visible: true, col: 0, row: 0, shape: 'block', blink: false },
      full: true,
      dirtyRows: [
        { rowIdx: 0, wrapped: true, cells: [cell({ ch: 'a' }), cell({ ch: 'b' })] },
        { rowIdx: 1, wrapped: false, cells: [cell({ ch: 'c' })] },
      ],
    };

    const encoded = encodeBinarySnapshot(snapshot);
    const padded = new Uint8Array(encoded.byteLength + 16);
    padded.set(encoded, 8);
    const view = padded.subarray(8, 8 + encoded.byteLength);

    const decoded = decodeBinarySnapshot(view);
    const packed = decoded.snapshot.packedDirtyRows;
    expect(packed).toBeDefined();
    expect(packed!.length).toBe(2);
    expect(packed![0]).toEqual({
      index: 0,
      wrapped: true,
      cellCount: 2,
      byteOffset: SNAPSHOT_BIN_HEADER_LEN + 2 * 4,
    });
    expect(packed![1]!.byteOffset).toBe(packed![0]!.byteOffset + 2 * 16);
    expect(packed![1]!.cellCount).toBe(1);
    expect(decoded.snapshot.packedByteOffset).toBe(8);
    expect(decoded.snapshot.packedBuffer).toBe(padded.buffer);
    expect(decoded.snapshot.overflowUtf8Offset).toBe(
      SNAPSHOT_BIN_HEADER_LEN + 2 * 4 + 3 * 16
    );
    expect(decoded.snapshot.overflowUtf8Length).toBe(0);
  });

  it('supports multi-codepoint grapheme clusters via the overflow UTF-8 table', () => {
    // E.g. family emoji or combination emoji
    const complexGrapheme = '👨‍👩‍👧‍👦';
    const snapshot: RenderSnapshot = {
      seq: 1,
      cols: 40,
      rows: 10,
      alternateScreen: false,
      cursor: { visible: false, col: 0, row: 0, shape: 'block' },
      full: false,
      dirtyRows: [
        {
          rowIdx: 2,
          cells: [cell({ ch: complexGrapheme, width: 2, fg: [120, 200, 255] })],
        },
      ],
    };

    const bytes = encodeBinarySnapshot(snapshot, { exited: true, exitCode: 137 });
    const decoded = decodeBinarySnapshot(bytes);

    expect(decoded.exited).toBe(true);
    expect(decoded.exitCode).toBe(137);
    expect(decoded.snapshot.dirtyRows[0]?.cells[0]?.ch).toBe(complexGrapheme);
    expect(decoded.snapshot.dirtyRows[0]?.cells[0]?.fg).toEqual([120, 200, 255]);
    expect(decoded.snapshot.overflowUtf8Length).toBeGreaterThan(0);
  });

  it('rejects payloads smaller than 32-byte header', () => {
    const tooSmall = new Uint8Array(20);
    expect(() => decodeBinarySnapshot(tooSmall)).toThrowError(/too small/);
  });
});

describe('decodeBinarySnapshotIntoGrid', () => {
  const firstFrame: RenderSnapshot = {
    seq: 1,
    cols: 4,
    rows: 3,
    alternateScreen: false,
    cursor: { visible: true, col: 0, row: 0, shape: 'block', blink: false },
    full: true,
    dirtyRows: [
      { rowIdx: 0, wrapped: false, cells: [cell({ ch: 'A' }), cell({ ch: 'B' })] },
      { rowIdx: 1, wrapped: false, cells: [cell({ ch: 'C' })] },
    ],
  };

  const secondFrame: RenderSnapshot = {
    seq: 2,
    cols: 4,
    rows: 3,
    alternateScreen: false,
    cursor: { visible: true, col: 1, row: 0, shape: 'block', blink: false },
    full: false,
    dirtyRows: [
      {
        rowIdx: 0,
        wrapped: true,
        cells: [
          cell({ ch: 'Z', fg: [1, 2, 3], bold: true }),
          cell({ ch: 'B', bg: [9, 9, 9], hasBg: true }),
        ],
      },
    ],
  };

  it('allocates a full grid when no target grid is supplied', () => {
    const decoded = decodeBinarySnapshotIntoGrid(encodeBinarySnapshot(firstFrame), null);

    expect(decoded.grid.cols).toBe(4);
    expect(decoded.grid.rowCount).toBe(3);
    expect(decoded.grid.rows.length).toBe(3);
    expect(decoded.grid.rows[0]!.cells.map((c) => c.ch)).toEqual(['A', 'B']);
    expect(decoded.grid.rows[1]!.cells.map((c) => c.ch)).toEqual(['C']);
    expect(decoded.grid.rows[2]!.cells.length).toBe(0);
    expect(decoded.snapshot.dirtyRows[0]!.cells).toBe(decoded.grid.rows[0]!.cells);
    expect(decoded.exited).toBe(false);
    expect(decoded.exitCode).toBeNull();
  });

  it('mutates existing cell slots in place on steady-state frames', () => {
    const first = decodeBinarySnapshotIntoGrid(encodeBinarySnapshot(firstFrame), null);
    const rowZero = first.grid.rows[0]!;
    const sharedCells = rowZero.cells;
    const sharedCell = sharedCells[0]!;

    const second = decodeBinarySnapshotIntoGrid(encodeBinarySnapshot(secondFrame), first.grid);

    expect(second.grid).toBe(first.grid);
    expect(second.grid.rows[0]).toBe(rowZero);
    expect(second.grid.rows[0]!.cells).toBe(sharedCells);
    expect(second.grid.rows[0]!.cells[0]).toBe(sharedCell);

    expect(sharedCell.ch).toBe('Z');
    expect(sharedCell.bold).toBe(true);
    expect(sharedCell.fg).toEqual([1, 2, 3]);

    const secondCell = sharedCells[1]!;
    expect(secondCell.ch).toBe('B');
    expect(secondCell.hasBg).toBe(true);
    expect(secondCell.bg).toEqual([9, 9, 9]);

    expect(second.grid.rows[0]!.wrapped).toBe(true);
    expect(second.snapshot.dirtyRows[0]!.cells).toBe(sharedCells);
    expect(second.snapshot.seq).toBe(2);
  });

  it('reallocates the grid when the frame dimensions change', () => {
    const first = decodeBinarySnapshotIntoGrid(encodeBinarySnapshot(firstFrame), null);
    const sharedCell = first.grid.rows[0]!.cells[0]!;

    const widened: RenderSnapshot = {
      ...firstFrame,
      seq: 3,
      cols: 6,
      full: true,
    };
    const second = decodeBinarySnapshotIntoGrid(encodeBinarySnapshot(widened), first.grid);

    expect(second.grid).not.toBe(first.grid);
    expect(second.grid.cols).toBe(6);
    expect(second.grid.rows[0]!.cells).not.toBe(first.grid.rows[0]!.cells);
    expect(second.grid.rows[0]!.cells[0]).not.toBe(sharedCell);
    expect(second.grid.rows[0]!.cells[0]!.ch).toBe('A');
  });

  it('does not reuse cell objects in the standalone decoder', () => {
    const bytes = encodeBinarySnapshot(firstFrame);
    const a = decodeBinarySnapshot(bytes);
    const b = decodeBinarySnapshot(bytes);

    expect(b.snapshot.dirtyRows[0]!.cells[0]).not.toBe(a.snapshot.dirtyRows[0]!.cells[0]);
    expect(b.snapshot.dirtyRows[0]!.cells).not.toBe(a.snapshot.dirtyRows[0]!.cells);
  });

  it('keeps the returned grid in sync when a caller mutates it between frames', () => {
    const first = decodeBinarySnapshotIntoGrid(encodeBinarySnapshot(firstFrame), null);
    const grid: GridState = first.grid;
    grid.rows[0]!.cells.push(cell({ ch: '?' }));

    const second = decodeBinarySnapshotIntoGrid(encodeBinarySnapshot(secondFrame), grid);
    expect(second.grid.rows[0]!.cells.length).toBe(2);
    expect(second.grid.rows[0]!.cells.map((c) => c.ch)).toEqual(['Z', 'B']);
  });
});

describe('classifyBinaryPollPayload', () => {
  it('reports data for non-empty binary payloads', () => {
    const bytes = new Uint8Array(SNAPSHOT_BIN_HEADER_LEN);
    const buffer = bytes.buffer;

    const fromUint8 = classifyBinaryPollPayload(bytes);
    expect(fromUint8.kind).toBe('data');
    if (fromUint8.kind === 'data') expect(fromUint8.bytes).toBe(bytes);

    const fromBuffer = classifyBinaryPollPayload(buffer);
    expect(fromBuffer.kind).toBe('data');

    const fromView = classifyBinaryPollPayload(new DataView(buffer));
    expect(fromView.kind).toBe('data');

    const fromArray = classifyBinaryPollPayload(Array.from(bytes));
    expect(fromArray.kind).toBe('data');
    if (fromArray.kind === 'data') {
      expect(fromArray.bytes).toBeInstanceOf(Uint8Array);
      expect(fromArray.bytes).toEqual(bytes);
    }
  });

  it('reports empty for zero-length binary payloads', () => {
    expect(classifyBinaryPollPayload(new ArrayBuffer(0)).kind).toBe('empty');
    expect(classifyBinaryPollPayload(new Uint8Array(0)).kind).toBe('empty');
    expect(classifyBinaryPollPayload([]).kind).toBe('empty');
  });

  it('reports missing for absent, short, or non-binary payloads', () => {
    expect(classifyBinaryPollPayload(null).kind).toBe('missing');
    expect(classifyBinaryPollPayload(undefined).kind).toBe('missing');
    expect(classifyBinaryPollPayload([1, 2, 3, 4]).kind).toBe('missing');
    expect(classifyBinaryPollPayload(new Uint8Array(31)).kind).toBe('missing');
    expect(
      classifyBinaryPollPayload({ kind: 'unchanged', seq: 3 } as unknown as ArrayBuffer).kind
    ).toBe('missing');
  });
});

describe('readBinarySnapshotSeq', () => {
  it('reads the sequence from the header without decoding the grid', () => {
    const snapshot: RenderSnapshot = {
      seq: 987654321,
      cols: 4,
      rows: 1,
      alternateScreen: false,
      cursor: { visible: true, col: 0, row: 0, shape: 'block', blink: false },
      full: true,
      dirtyRows: [{ rowIdx: 0, cells: [cell({ ch: 'A' })] }],
    };

    const bytes = encodeBinarySnapshot(snapshot);
    const rawBuffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(rawBuffer).set(bytes);
    expect(readBinarySnapshotSeq(bytes)).toBe(987654321);
    expect(readBinarySnapshotSeq(rawBuffer)).toBe(987654321);
  });

  it('rejects payloads too small to hold the sequence', () => {
    expect(() => readBinarySnapshotSeq(new Uint8Array(4))).toThrowError(/too small/);
  });
});

describe('commitDirtyRows', () => {
  it('reuses existing row arrays and cell objects for repeated widths', () => {
    const keep0 = cell({ ch: 'A' });
    const keep1 = cell({ ch: 'B' });
    const untouched = cell({ ch: 'C' });
    const matrix: CellSnapshot[][] = [[keep0, keep1], [untouched]];
    const rowOne = matrix[1]!;

    const dirtyRows: RowSnapshot[] = [
      {
        rowIdx: 0,
        wrapped: true,
        cells: [cell({ ch: 'Z' }), cell({ ch: 'B', bold: true })],
      },
    ];

    const out = commitDirtyRows(matrix, 2, dirtyRows, false);

    expect(out).toBe(matrix);
    expect(matrix[0]![0]).toBe(keep0);
    expect(matrix[0]![1]).toBe(keep1);
    expect(keep0.ch).toBe('Z');
    expect(keep1.bold).toBe(true);
    expect(matrix[1]).toBe(rowOne);
  });

  it('replaces the row array when the incoming width changes', () => {
    const matrix: CellSnapshot[][] = [[cell({ ch: 'A' })]];
    const incoming = [cell({ ch: 'X' }), cell({ ch: 'Y' })];

    commitDirtyRows(matrix, 1, [{ rowIdx: 0, cells: incoming }], false);

    expect(matrix[0]).toBe(incoming);
    expect(matrix[0]).toHaveLength(2);
  });

  it('clears rows missing from a full frame and grows the matrix', () => {
    const matrix: CellSnapshot[][] = [[cell({ ch: 'A' })]];
    const row0 = matrix[0]!;

    commitDirtyRows(matrix, 3, [{ rowIdx: 0, cells: [cell({ ch: 'Z' })] }], true);

    expect(matrix).toHaveLength(3);
    expect(matrix[0]).toBe(row0);
    expect(row0[0]!.ch).toBe('Z');
    expect(matrix[1]).toEqual([]);
    expect(matrix[2]).toEqual([]);
  });

  it('ignores dirty rows outside the grid bounds', () => {
    const matrix: CellSnapshot[][] = [[cell({ ch: 'A' })]];
    commitDirtyRows(matrix, 1, [{ rowIdx: 9, cells: [cell({ ch: 'X' })] }], false);
    expect(matrix).toHaveLength(1);
    expect(matrix[0]![0]!.ch).toBe('A');
  });
});
