import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BG,
  DEFAULT_FG,
  decodeBinarySnapshot,
  decodeBinarySnapshotIntoGrid,
  encodeBinarySnapshot,
} from './binarySnapshotDecoder';
import type { CellSnapshot, RenderSnapshot } from './terminalCanvasTypes';

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

/** The legacy JSON `RenderSnapshot` shape the packed frame must reproduce exactly. */
function legacyJsonSnapshot(): RenderSnapshot {
  return {
    seq: 77,
    cols: 40,
    rows: 4,
    alternateScreen: true,
    applicationCursor: true,
    bracketedPaste: true,
    mouseTracking: true,
    mouseMode: 'drag',
    sgrMouse: true,
    sgrPixelsMouse: false,
    focusReporting: true,
    win32InputMode: true,
    kittyKeyboardFlags: 2,
    scrollbackOffset: 8,
    scrollbackDepth: 640,
    cursor: { visible: true, col: 9, row: 2, shape: 'underline', blink: true },
    full: true,
    title: 'build running',
    clipboardWrite: 'npm run build',
    dirtyRows: [
      {
        rowIdx: 0,
        wrapped: false,
        cells: [
          cell({ ch: 'A', bold: true, fg: [1, 2, 3] }),
          cell({ ch: '🚀', width: 2 }),
          cell({ ch: '', width: 0 }),
        ],
      },
      {
        rowIdx: 2,
        wrapped: true,
        cells: [cell({ ch: 'B', hasBg: true, bg: [9, 9, 9], inverse: true })],
      },
    ],
  };
}

describe('SNAPSHOT_BIN spec parity', () => {
  it('decodes the exact grid, wide span, cursor, modes and seq of the JSON RenderSnapshot', () => {
    const original = legacyJsonSnapshot();
    const decoded = decodeBinarySnapshot(encodeBinarySnapshot(original));

    expect(decoded.snapshot.seq).toBe(original.seq);
    expect(decoded.snapshot.cols).toBe(original.cols);
    expect(decoded.snapshot.rows).toBe(original.rows);
    expect(decoded.snapshot.full).toBe(true);
    expect(decoded.snapshot.alternateScreen).toBe(original.alternateScreen);
    expect(decoded.snapshot.applicationCursor).toBe(original.applicationCursor);
    expect(decoded.snapshot.bracketedPaste).toBe(original.bracketedPaste);
    expect(decoded.snapshot.mouseTracking).toBe(original.mouseTracking);
    expect(decoded.snapshot.mouseMode).toBe(original.mouseMode);
    expect(decoded.snapshot.sgrMouse).toBe(true);
    expect(decoded.snapshot.sgrPixelsMouse).toBe(false);
    expect(decoded.snapshot.focusReporting).toBe(true);
    expect(decoded.snapshot.win32InputMode).toBe(true);
    expect(decoded.snapshot.kittyKeyboardFlags).toBe(2);
    expect(decoded.snapshot.scrollbackOffset).toBe(8);
    expect(decoded.snapshot.scrollbackDepth).toBe(640);
    expect(decoded.snapshot.cursor).toEqual(original.cursor);
    expect(decoded.snapshot.title).toBe('build running');
    expect(decoded.snapshot.clipboardWrite).toBe('npm run build');
    expect(decoded.exited).toBe(false);
    expect(decoded.exitCode).toBeNull();

    const firstRow = decoded.snapshot.dirtyRows.find((row) => row.rowIdx === 0);
    expect(firstRow?.wrapped).toBe(false);
    expect(firstRow?.cells.map((entry) => entry.ch)).toEqual(['A', '🚀', '']);
    expect(firstRow?.cells[0].bold).toBe(true);
    expect(firstRow?.cells[0].fg).toEqual([1, 2, 3]);
    expect(firstRow?.cells[1].width).toBe(2);
    expect(firstRow?.cells[2].width).toBe(0);

    const wideRow = decoded.snapshot.dirtyRows.find((row) => row.rowIdx === 2);
    expect(wideRow?.wrapped).toBe(true);
    expect(wideRow?.cells[0].ch).toBe('B');
    expect(wideRow?.cells[0].hasBg).toBe(true);
    expect(wideRow?.cells[0].bg).toEqual([9, 9, 9]);
    expect(wideRow?.cells[0].inverse).toBe(true);
  });

  it('mutates a persistent grid in place so steady-state frames allocate no new cells', () => {
    const full = legacyJsonSnapshot();
    const delta: RenderSnapshot = {
      ...legacyJsonSnapshot(),
      seq: 78,
      full: false,
      title: null,
      clipboardWrite: null,
      cursor: { visible: true, col: 10, row: 2, shape: 'underline', blink: true },
      dirtyRows: [
        {
          rowIdx: 0,
          wrapped: false,
          cells: [cell({ ch: 'Z' }), cell({ ch: '🚀', width: 2 }), cell({ ch: '', width: 0 })],
        },
      ],
    };

    const first = decodeBinarySnapshotIntoGrid(encodeBinarySnapshot(full), null);
    const keptCell = first.grid.rows[0].cells[0];
    const keptRow = first.grid.rows[0].cells;

    const second = decodeBinarySnapshotIntoGrid(encodeBinarySnapshot(delta), first.grid);

    expect(second.grid).toBe(first.grid);
    expect(second.grid.rows[0].cells).toBe(keptRow);
    expect(second.grid.rows[0].cells[0]).toBe(keptCell);
    expect(keptCell.ch).toBe('Z');
    expect(second.snapshot.seq).toBe(78);
  });

  it('carries observed PTY bytes for the agent registry through the metadata tail', () => {
    const observed = btoa('OpenCode v0.2.0\n');
    const original: RenderSnapshot = {
      ...legacyJsonSnapshot(),
      observedBytesBase64: observed,
      observedText: 'OpenCode v0.2.0\n',
    };

    const decoded = decodeBinarySnapshot(encodeBinarySnapshot(original));

    expect(decoded.snapshot.observedBytesBase64).toBe(observed);
    expect(decoded.snapshot.observedText).toBe('OpenCode v0.2.0\n');
  });

  it('omits the observed payload fields when the frame carries no raw output', () => {
    const decoded = decodeBinarySnapshot(encodeBinarySnapshot(legacyJsonSnapshot()));
    expect(decoded.snapshot.observedBytesBase64).toBeUndefined();
    expect(decoded.snapshot.observedText).toBeUndefined();
  });
});
