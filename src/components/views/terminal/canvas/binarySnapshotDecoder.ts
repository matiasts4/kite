import {
  type CellSnapshot,
  type CursorSnapshot,
  type GridRowState,
  type GridState,
  type PackedDirtyRowView,
  type RenderSnapshot,
  type RowSnapshot,
  type TerminalMouseMode,
} from './terminalCanvasTypes';

export const SNAPSHOT_BIN_HEADER_LEN = 32;
export const DEFAULT_FG: [number, number, number] = [250, 250, 250];
export const DEFAULT_BG: [number, number, number] = [10, 10, 10];

/** `mode_flags` bits that are not part of the base 32-byte header contract. */
const MODE_FLAG_APPLICATION_CURSOR = 0x40;
const MODE_FLAG_EXTENDED_META = 0x80;

/** `cursor_flags` bit 1. */
const CURSOR_FLAG_BLINK = 0x02;

export interface DecodedBinarySnapshot {
  snapshot: RenderSnapshot;
  exited: boolean;
  exitCode: number | null;
  syncOutput: boolean;
}

export interface DecodedBinaryGridSnapshot extends DecodedBinarySnapshot {
  grid: GridState;
}

/**
 * Metadata that does not fit in the packed cell records. It travels as a UTF-8 JSON
 * object appended after the overflow UTF-8 string table when `mode_flags` bit 7 is set.
 */
export interface ExtendedSnapshotMeta {
  title?: string | null;
  clipboardWrite?: string | null;
  mouseMode?: TerminalMouseMode;
  sgrMouse?: boolean;
  sgrPixelsMouse?: boolean;
  focusReporting?: boolean;
  win32InputMode?: boolean;
  kittyKeyboardFlags?: number;
  scrollbackOffset?: number;
  scrollbackDepth?: number;
  benchmarkActive?: boolean;
  /** Raw PTY output drained for the agent registry, already decoded as UTF-8 text. */
  observedText?: string | null;
  /** Raw PTY output drained for the agent registry, base64-encoded. */
  observedBytesBase64?: string | null;
}

export type BinaryPollPayloadResult =
  | { kind: 'data'; bytes: Uint8Array }
  | { kind: 'empty' }
  | { kind: 'missing' };

const sharedUtf8Decoder = new TextDecoder('utf-8');

/**
 * Classifies a `poll_terminal_snapshot_bin` result.
 *
 * - `data`: a non-empty packed payload that can be decoded.
 * - `empty`: the daemon reported no new dirty rows (`unchanged`), so callers must not
 *   fall back to the JSON poll.
 * - `missing`: no binary transport available (command absent, returned `null`, threw, or
 *   returned a non-binary value), so callers must fall back to `poll_terminal_snapshot`.
 */
export function classifyBinaryPollPayload(raw: unknown): BinaryPollPayloadResult {
  if (raw === null || raw === undefined) return { kind: 'missing' };

  if (Array.isArray(raw)) {
    if (raw.length === 0) return { kind: 'empty' };
    if (raw.length < SNAPSHOT_BIN_HEADER_LEN) return { kind: 'missing' };
    return { kind: 'data', bytes: Uint8Array.from(raw as number[]) };
  }

  if (raw instanceof ArrayBuffer) {
    if (raw.byteLength === 0) return { kind: 'empty' };
    if (raw.byteLength < SNAPSHOT_BIN_HEADER_LEN) return { kind: 'missing' };
    return { kind: 'data', bytes: new Uint8Array(raw) };
  }

  if (raw instanceof Uint8Array) {
    if (raw.byteLength === 0) return { kind: 'empty' };
    if (raw.byteLength < SNAPSHOT_BIN_HEADER_LEN) return { kind: 'missing' };
    return { kind: 'data', bytes: raw };
  }

  if (ArrayBuffer.isView(raw)) {
    if (raw.byteLength === 0) return { kind: 'empty' };
    if (raw.byteLength < SNAPSHOT_BIN_HEADER_LEN) return { kind: 'missing' };
    return {
      kind: 'data',
      bytes: new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
    };
  }

  return { kind: 'missing' };
}

function asView(data: ArrayBuffer | Uint8Array | DataView): {
  view: DataView;
  uint8: Uint8Array;
} {
  if (data instanceof DataView) {
    return {
      view: data,
      uint8: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    };
  }
  if (data instanceof Uint8Array) {
    return {
      view: new DataView(data.buffer, data.byteOffset, data.byteLength),
      uint8: data,
    };
  }
  return { view: new DataView(data), uint8: new Uint8Array(data) };
}

/**
 * Reads only the monotonic grid sequence from a `SNAPSHOT_BIN` header, so callers can
 * reject stale frames before decoding into a shared cell grid.
 */
export function readBinarySnapshotSeq(
  data: ArrayBuffer | Uint8Array | DataView
): number {
  const { view } = asView(data);
  if (view.byteLength < 8) {
    throw new Error(`Binary snapshot payload too small: ${view.byteLength} < 8`);
  }
  return Number(view.getBigUint64(0, true));
}

function createCell(): CellSnapshot {
  return {
    ch: '',
    width: 0,
    fg: DEFAULT_FG,
    bg: DEFAULT_BG,
    hasBg: false,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
  };
}

function readCellText(
  codepointOrSpan: number,
  attrs: number,
  overflowBytes: Uint8Array
): string {
  if ((attrs & 0x80) !== 0) {
    const offset = codepointOrSpan & 0x00ffffff;
    const len = (codepointOrSpan >>> 24) & 0xff;
    if (offset + len <= overflowBytes.byteLength) {
      return sharedUtf8Decoder.decode(overflowBytes.subarray(offset, offset + len));
    }
    return ' ';
  }
  return codepointOrSpan !== 0 ? String.fromCodePoint(codepointOrSpan) : '';
}

/**
 * Writes one packed 16-byte cell record into an existing cell slot.
 * Colors keep the shared default tuples when unchanged, so steady-state frames
 * allocate no per-cell objects.
 */
function writePackedCell(
  target: CellSnapshot,
  codepointOrSpan: number,
  fgRgba: number,
  bgRgba: number,
  width: number,
  attrs: number,
  overflowBytes: Uint8Array
): void {
  const ch = readCellText(codepointOrSpan, attrs, overflowBytes);
  if (target.ch !== ch) target.ch = ch;
  if (target.width !== width) target.width = width;

  if ((fgRgba & 0xff) === 0) {
    if (target.fg !== DEFAULT_FG) target.fg = DEFAULT_FG;
  } else {
    const r = (fgRgba >>> 24) & 0xff;
    const g = (fgRgba >>> 16) & 0xff;
    const b = (fgRgba >>> 8) & 0xff;
    const fg = target.fg;
    if (fg[0] !== r || fg[1] !== g || fg[2] !== b) target.fg = [r, g, b];
  }

  const hasBg = (bgRgba & 0xff) !== 0;
  if (target.hasBg !== hasBg) target.hasBg = hasBg;
  if (!hasBg) {
    if (target.bg !== DEFAULT_BG) target.bg = DEFAULT_BG;
  } else {
    const r = (bgRgba >>> 24) & 0xff;
    const g = (bgRgba >>> 16) & 0xff;
    const b = (bgRgba >>> 8) & 0xff;
    const bg = target.bg;
    if (bg[0] !== r || bg[1] !== g || bg[2] !== b) target.bg = [r, g, b];
  }

  const bold = (attrs & 0x01) !== 0;
  if (target.bold !== bold) target.bold = bold;
  const dim = (attrs & 0x02) !== 0;
  if (target.dim !== dim) target.dim = dim;
  const italic = (attrs & 0x04) !== 0;
  if (target.italic !== italic) target.italic = italic;
  const underline = (attrs & 0x08) !== 0;
  if (target.underline !== underline) target.underline = underline;
  const inverse = (attrs & 0x10) !== 0;
  if (target.inverse !== inverse) target.inverse = inverse;
}

function readExtendedMeta(
  uint8: Uint8Array,
  offset: number
): ExtendedSnapshotMeta | null {
  const length = uint8.byteLength - offset;
  if (length <= 0) return null;
  try {
    const text = sharedUtf8Decoder.decode(uint8.subarray(offset));
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as ExtendedSnapshotMeta;
  } catch {
    return null;
  }
}

function applyExtendedMeta(snapshot: RenderSnapshot, meta: ExtendedSnapshotMeta): void {
  if (meta.title !== undefined) snapshot.title = meta.title;
  if (meta.clipboardWrite !== undefined) snapshot.clipboardWrite = meta.clipboardWrite;
  if (meta.mouseMode !== undefined) snapshot.mouseMode = meta.mouseMode;
  if (typeof meta.sgrMouse === 'boolean') snapshot.sgrMouse = meta.sgrMouse;
  if (typeof meta.sgrPixelsMouse === 'boolean') snapshot.sgrPixelsMouse = meta.sgrPixelsMouse;
  if (typeof meta.focusReporting === 'boolean') snapshot.focusReporting = meta.focusReporting;
  if (typeof meta.win32InputMode === 'boolean') snapshot.win32InputMode = meta.win32InputMode;
  if (typeof meta.kittyKeyboardFlags === 'number') {
    snapshot.kittyKeyboardFlags = meta.kittyKeyboardFlags;
  }
  if (typeof meta.scrollbackOffset === 'number') snapshot.scrollbackOffset = meta.scrollbackOffset;
  if (typeof meta.scrollbackDepth === 'number') snapshot.scrollbackDepth = meta.scrollbackDepth;
  if (typeof meta.benchmarkActive === 'boolean') snapshot.benchmarkActive = meta.benchmarkActive;
  if (meta.observedText !== undefined) snapshot.observedText = meta.observedText;
  if (meta.observedBytesBase64 !== undefined) {
    snapshot.observedBytesBase64 = meta.observedBytesBase64;
  }
}

function createGrid(cols: number, rowCount: number): GridState {
  const rows: GridRowState[] = new Array(rowCount);
  for (let i = 0; i < rowCount; i += 1) rows[i] = { cells: [], wrapped: false };
  return { cols, rowCount, rows };
}

function decodeIntoGrid(
  data: ArrayBuffer | Uint8Array | DataView,
  targetGrid: GridState | null
): DecodedBinaryGridSnapshot {
  const { view, uint8 } = asView(data);

  if (view.byteLength < SNAPSHOT_BIN_HEADER_LEN) {
    throw new Error(
      `Binary snapshot payload too small: ${view.byteLength} < ${SNAPSHOT_BIN_HEADER_LEN}`
    );
  }

  // Header 0..32 bytes (Little-Endian)
  const seq = Number(view.getBigUint64(0, true));
  const cols = view.getUint16(8, true);
  const rows = view.getUint16(10, true);
  const cursorCol = view.getUint16(12, true);
  const cursorRow = view.getUint16(14, true);
  const cursorFlags = view.getUint8(16);
  const modeFlags = view.getUint8(17);
  const dirtyRowCount = view.getUint16(18, true);
  const totalCells = view.getUint32(20, true);
  const overflowUtf8Len = view.getUint32(24, true);
  const rawExitCode = view.getInt32(28, true);

  const cursorVisible = (cursorFlags & 0x01) !== 0;
  const cursorShapeCode = (cursorFlags >> 2) & 0x07;
  const cursorShape =
    cursorShapeCode === 2 ? 'bar' : cursorShapeCode === 1 ? 'underline' : 'block';

  const full = (modeFlags & 0x01) !== 0;
  const alternateScreen = (modeFlags & 0x02) !== 0;
  const mouseTracking = (modeFlags & 0x04) !== 0;
  const bracketedPaste = (modeFlags & 0x08) !== 0;
  const syncOutput = (modeFlags & 0x10) !== 0;
  const exited = (modeFlags & 0x20) !== 0;
  const applicationCursor = (modeFlags & MODE_FLAG_APPLICATION_CURSOR) !== 0;
  const exitCode = exited ? rawExitCode : null;

  const dirtyRowsEnd = SNAPSHOT_BIN_HEADER_LEN + dirtyRowCount * 4;
  const cellsEnd = dirtyRowsEnd + totalCells * 16;
  const overflowEnd = cellsEnd + overflowUtf8Len;

  if (view.byteLength < overflowEnd) {
    throw new Error(
      `Binary snapshot truncated: expected ${overflowEnd} bytes, got ${view.byteLength}`
    );
  }

  const overflowBytes = uint8.subarray(cellsEnd, overflowEnd);
  const meta =
    (modeFlags & MODE_FLAG_EXTENDED_META) !== 0 && uint8.byteLength > overflowEnd
      ? readExtendedMeta(uint8, overflowEnd)
      : null;

  const reusable =
    targetGrid !== null &&
    targetGrid.cols === cols &&
    targetGrid.rowCount === rows &&
    targetGrid.rows.length === rows;
  const grid = reusable ? (targetGrid as GridState) : createGrid(cols, rows);

  const dirtyRows: RowSnapshot[] = new Array(dirtyRowCount);
  const packedDirtyRows: PackedDirtyRowView[] = new Array(dirtyRowCount);
  let cellOffset = dirtyRowsEnd;

  for (let r = 0; r < dirtyRowCount; r += 1) {
    const entryOffset = SNAPSHOT_BIN_HEADER_LEN + r * 4;
    const rowIdx = view.getUint16(entryOffset, true);
    const rawCount = view.getUint16(entryOffset + 2, true);
    const wrapped = (rawCount & 0x8000) !== 0;
    const count = rawCount & 0x7fff;
    const rowByteOffset = cellOffset;

    const gridRow = rowIdx < grid.rows.length ? grid.rows[rowIdx] : undefined;

    let cells: CellSnapshot[];
    if (gridRow && gridRow.cells.length === count) {
      cells = gridRow.cells;
    } else {
      cells = new Array(count);
      for (let c = 0; c < count; c += 1) cells[c] = createCell();
    }

    for (let c = 0; c < count; c += 1) {
      const target = cells[c] ?? (cells[c] = createCell());
      writePackedCell(
        target,
        view.getUint32(cellOffset, true),
        view.getUint32(cellOffset + 4, true),
        view.getUint32(cellOffset + 8, true),
        view.getUint8(cellOffset + 12),
        view.getUint8(cellOffset + 13),
        overflowBytes
      );
      cellOffset += 16;
    }

    if (gridRow) {
      gridRow.cells = cells;
      gridRow.wrapped = wrapped;
    }

    packedDirtyRows[r] = {
      index: rowIdx,
      wrapped,
      cellCount: count,
      byteOffset: rowByteOffset,
    };
    dirtyRows[r] = { rowIdx, cells, wrapped };
  }

  const cursor: CursorSnapshot = {
    visible: cursorVisible,
    col: cursorCol,
    row: cursorRow,
    shape: cursorShape,
    blink: (cursorFlags & CURSOR_FLAG_BLINK) !== 0,
  };

  const snapshot: RenderSnapshot = {
    seq,
    cols,
    rows,
    alternateScreen,
    applicationCursor,
    bracketedPaste,
    mouseTracking,
    mouseMode: mouseTracking ? 'click' : 'none',
    cursor,
    dirtyRows,
    full,
    title: null,
    clipboardWrite: null,
    packedBuffer: view.buffer as ArrayBuffer,
    packedByteOffset: view.byteOffset,
    packedDirtyRows,
    overflowUtf8Offset: cellsEnd,
    overflowUtf8Length: overflowUtf8Len,
  };

  if (meta) applyExtendedMeta(snapshot, meta);

  return {
    snapshot,
    grid,
    exited,
    exitCode,
    syncOutput,
  };
}

/**
 * Decodes a 32-byte header + packed 16-byte cell records binary snapshot (`SNAPSHOT_BIN`)
 * into a typed `RenderSnapshot` with zero per-cell JSON object decoding.
 *
 * Every call allocates fresh cell objects; use `decodeBinarySnapshotIntoGrid` with a
 * persistent grid to reuse cell slots in place on steady-state frames.
 */
export function decodeBinarySnapshot(
  data: ArrayBuffer | Uint8Array | DataView
): DecodedBinarySnapshot {
  const { snapshot, exited, exitCode, syncOutput } = decodeIntoGrid(data, null);
  return { snapshot, exited, exitCode, syncOutput };
}

/**
 * Decodes a `SNAPSHOT_BIN` payload into a reusable `GridState`.
 *
 * When `targetGrid` matches the frame dimensions, every dirty row mutates the existing
 * `CellSnapshot` objects in place, so steady-state frames allocate no per-cell objects.
 * A mismatched grid is replaced with a freshly allocated one.
 */
export function decodeBinarySnapshotIntoGrid(
  data: ArrayBuffer | Uint8Array,
  targetGrid: GridState | null
): DecodedBinaryGridSnapshot {
  return decodeIntoGrid(data, targetGrid);
}

function buildExtendedMeta(snapshot: RenderSnapshot): ExtendedSnapshotMeta | null {
  const derivedMouseMode: TerminalMouseMode = snapshot.mouseTracking ? 'click' : 'none';
  const meta: ExtendedSnapshotMeta = {};
  let hasField = false;

  if (snapshot.title !== undefined) {
    meta.title = snapshot.title;
    hasField = true;
  }
  if (snapshot.clipboardWrite !== undefined) {
    meta.clipboardWrite = snapshot.clipboardWrite;
    hasField = true;
  }
  if (snapshot.mouseMode !== undefined && snapshot.mouseMode !== derivedMouseMode) {
    meta.mouseMode = snapshot.mouseMode;
    hasField = true;
  }
  if (snapshot.sgrMouse !== undefined) {
    meta.sgrMouse = snapshot.sgrMouse;
    hasField = true;
  }
  if (snapshot.sgrPixelsMouse !== undefined) {
    meta.sgrPixelsMouse = snapshot.sgrPixelsMouse;
    hasField = true;
  }
  if (snapshot.focusReporting !== undefined) {
    meta.focusReporting = snapshot.focusReporting;
    hasField = true;
  }
  if (snapshot.win32InputMode !== undefined) {
    meta.win32InputMode = snapshot.win32InputMode;
    hasField = true;
  }
  if (snapshot.kittyKeyboardFlags !== undefined) {
    meta.kittyKeyboardFlags = snapshot.kittyKeyboardFlags;
    hasField = true;
  }
  if (snapshot.scrollbackOffset !== undefined) {
    meta.scrollbackOffset = snapshot.scrollbackOffset;
    hasField = true;
  }
  if (snapshot.scrollbackDepth !== undefined) {
    meta.scrollbackDepth = snapshot.scrollbackDepth;
    hasField = true;
  }
  if (snapshot.benchmarkActive !== undefined) {
    meta.benchmarkActive = snapshot.benchmarkActive;
    hasField = true;
  }
  if (snapshot.observedText !== undefined) {
    meta.observedText = snapshot.observedText;
    hasField = true;
  }
  if (snapshot.observedBytesBase64 !== undefined) {
    meta.observedBytesBase64 = snapshot.observedBytesBase64;
    hasField = true;
  }

  return hasField ? meta : null;
}

/**
 * Encodes a `RenderSnapshot` into a binary `Uint8Array` following the `SNAPSHOT_BIN` spec.
 * Used for client-side serialization and round-trip parity tests.
 */
export function encodeBinarySnapshot(
  snapshot: RenderSnapshot,
  options?: { exited?: boolean; exitCode?: number | null; syncOutput?: boolean }
): Uint8Array {
  const exited = options?.exited ?? false;
  const exitCode = options?.exitCode ?? 0;
  const syncOutput = options?.syncOutput ?? false;

  const dirtyRowCount = snapshot.dirtyRows.length;
  let totalCells = 0;
  for (const r of snapshot.dirtyRows) {
    totalCells += r.cells.length;
  }

  const overflowChunks: Uint8Array[] = [];
  let overflowBytesTotal = 0;
  const encoder = new TextEncoder();

  // 16 bytes per cell
  const cellsBuffer = new Uint8Array(totalCells * 16);
  const cellsView = new DataView(cellsBuffer.buffer);
  let cellByteOffset = 0;

  for (const row of snapshot.dirtyRows) {
    for (const cell of row.cells) {
      let attrs = 0;
      if (cell.bold) attrs |= 0x01;
      if (cell.dim) attrs |= 0x02;
      if (cell.italic) attrs |= 0x04;
      if (cell.underline) attrs |= 0x08;
      if (cell.inverse) attrs |= 0x10;

      let codepointOrSpan = 0;
      if (cell.ch.length > 0) {
        const codePoints = Array.from(cell.ch);
        if (codePoints.length === 1 && (codePoints[0]?.codePointAt(0) ?? 0) <= 0x10ffff) {
          codepointOrSpan = codePoints[0]?.codePointAt(0) ?? 0;
        } else {
          attrs |= 0x80;
          const encoded = encoder.encode(cell.ch);
          const offset = overflowBytesTotal;
          const len = Math.min(255, encoded.length);
          overflowChunks.push(encoded);
          overflowBytesTotal += encoded.length;
          codepointOrSpan = (offset & 0x00ffffff) | ((len & 0xff) << 24);
        }
      }

      const isDefaultFg =
        cell.fg[0] === DEFAULT_FG[0] &&
        cell.fg[1] === DEFAULT_FG[1] &&
        cell.fg[2] === DEFAULT_FG[2];
      const fgAlpha = isDefaultFg ? 0x00 : 0xff;
      const fgRgba =
        ((cell.fg[0] << 24) >>> 0) |
        (cell.fg[1] << 16) |
        (cell.fg[2] << 8) |
        fgAlpha;

      const bgAlpha = cell.hasBg ? 0xff : 0x00;
      const bgRgba =
        ((cell.bg[0] << 24) >>> 0) |
        (cell.bg[1] << 16) |
        (cell.bg[2] << 8) |
        bgAlpha;

      cellsView.setUint32(cellByteOffset, codepointOrSpan, true);
      cellsView.setUint32(cellByteOffset + 4, fgRgba, true);
      cellsView.setUint32(cellByteOffset + 8, bgRgba, true);
      cellsView.setUint8(cellByteOffset + 12, cell.width);
      cellsView.setUint8(cellByteOffset + 13, attrs);
      cellsView.setUint16(cellByteOffset + 14, 0, true);
      cellByteOffset += 16;
    }
  }

  const shapeCode =
    snapshot.cursor.shape === 'underline' ? 1 : snapshot.cursor.shape === 'bar' ? 2 : 0;
  let cursorFlags = (shapeCode & 0x07) << 2;
  if (snapshot.cursor.visible) cursorFlags |= 0x01;
  if (snapshot.cursor.blink) cursorFlags |= CURSOR_FLAG_BLINK;

  const meta = buildExtendedMeta(snapshot);
  const metaBytes = meta ? encoder.encode(JSON.stringify(meta)) : null;

  let modeFlags = 0;
  if (snapshot.full) modeFlags |= 0x01;
  if (snapshot.alternateScreen) modeFlags |= 0x02;
  if (snapshot.mouseTracking) modeFlags |= 0x04;
  if (snapshot.bracketedPaste) modeFlags |= 0x08;
  if (syncOutput) modeFlags |= 0x10;
  if (exited) modeFlags |= 0x20;
  if (snapshot.applicationCursor) modeFlags |= MODE_FLAG_APPLICATION_CURSOR;
  if (metaBytes) modeFlags |= MODE_FLAG_EXTENDED_META;

  const totalLength =
    SNAPSHOT_BIN_HEADER_LEN +
    dirtyRowCount * 4 +
    cellsBuffer.byteLength +
    overflowBytesTotal +
    (metaBytes?.byteLength ?? 0);
  const out = new Uint8Array(totalLength);
  const outView = new DataView(out.buffer);

  // 32-byte header
  outView.setBigUint64(0, BigInt(snapshot.seq), true);
  outView.setUint16(8, snapshot.cols, true);
  outView.setUint16(10, snapshot.rows, true);
  outView.setUint16(12, snapshot.cursor.col, true);
  outView.setUint16(14, snapshot.cursor.row, true);
  outView.setUint8(16, cursorFlags);
  outView.setUint8(17, modeFlags);
  outView.setUint16(18, dirtyRowCount, true);
  outView.setUint32(20, totalCells, true);
  outView.setUint32(24, overflowBytesTotal, true);
  outView.setInt32(28, exited ? (exitCode ?? 0) : 0, true);

  // Dirty row descriptors
  let rowOffset = SNAPSHOT_BIN_HEADER_LEN;
  for (const row of snapshot.dirtyRows) {
    outView.setUint16(rowOffset, row.rowIdx, true);
    let count = row.cells.length;
    if (row.wrapped) count |= 0x8000;
    outView.setUint16(rowOffset + 2, count, true);
    rowOffset += 4;
  }

  // Cells
  out.set(cellsBuffer, rowOffset);
  let curOverflowOffset = rowOffset + cellsBuffer.byteLength;

  // Overflow string table
  for (const chunk of overflowChunks) {
    out.set(chunk, curOverflowOffset);
    curOverflowOffset += chunk.byteLength;
  }

  // Extended metadata tail
  if (metaBytes) {
    out.set(metaBytes, curOverflowOffset);
  }

  return out;
}
