import type { CellSnapshot, GridState, RowSnapshot } from './terminalCanvasTypes';

export type SnapshotApplyPlan = 'apply' | 'ignore' | 'resync';

/**
 * A partial snapshot is a delta from the immediately previous frame.
 * An older seq would paint that delta onto a newer screen.
 * A skipped seq is a delta from a frame this canvas never applied.
 */
export function classifySnapshotApply(
  lastSeq: number,
  seq: number,
  full: boolean,
): SnapshotApplyPlan {
  if (seq < lastSeq) return 'ignore';
  if (!full && seq !== lastSeq + 1) return 'resync';
  return 'apply';
}

/** Copies every semantic field of `source` into `target` without allocating a new cell. */
export function copyCellInto(target: CellSnapshot, source: CellSnapshot): void {
  target.ch = source.ch;
  target.width = source.width;
  target.fg = source.fg;
  target.bg = source.bg;
  target.hasBg = source.hasBg;
  target.bold = source.bold;
  target.dim = source.dim;
  target.italic = source.italic;
  target.underline = source.underline;
  target.inverse = source.inverse;
}

function hasDirtyRow(dirtyRows: RowSnapshot[], rowIdx: number): boolean {
  for (const row of dirtyRows) {
    if (row.rowIdx === rowIdx) return true;
  }
  return false;
}

/**
 * Commits a frame into an existing cell matrix, reusing row arrays and cell objects
 * whenever the incoming row keeps the same width.
 *
 * Reusing the slots keeps long-lived `CellSnapshot` references stable, so steady-state
 * frames allocate no per-cell objects. `full` frames reset rows the frame does not cover,
 * matching the blank rows a freshly built matrix would have shown.
 */
export function commitDirtyRows(
  matrix: CellSnapshot[][],
  rows: number,
  dirtyRows: RowSnapshot[],
  full: boolean,
): CellSnapshot[][] {
  if (matrix.length !== rows) matrix.length = rows;

  if (full) {
    for (let i = 0; i < rows; i += 1) {
      if (!hasDirtyRow(dirtyRows, i)) matrix[i] = [];
    }
  }

  for (let i = 0; i < rows; i += 1) {
    if (!matrix[i]) matrix[i] = [];
  }

  for (const row of dirtyRows) {
    const rowIdx = row.rowIdx;
    if (rowIdx < 0 || rowIdx >= rows) continue;
    const previous = matrix[rowIdx];
    if (!previous || previous.length !== row.cells.length) {
      matrix[rowIdx] = row.cells;
      continue;
    }
    if (previous === row.cells) continue;
    for (let i = 0; i < row.cells.length; i += 1) {
      const source = row.cells[i];
      const target = previous[i];
      if (target) copyCellInto(target, source);
      else previous[i] = source;
    }
  }

  return matrix;
}

/**
 * Repoints a persistent packed grid at the cell arrays currently held by `matrix`, so the
 * next packed decode can mutate the same slots in place.
 */
export function syncGridState(
  grid: GridState,
  matrix: CellSnapshot[][],
  cols?: number,
): GridState {
  if (typeof cols === 'number') grid.cols = cols;
  const count = matrix.length;
  grid.rowCount = count;
  if (grid.rows.length > count) grid.rows.length = count;
  while (grid.rows.length < count) grid.rows.push({ cells: [], wrapped: false });

  for (let i = 0; i < count; i += 1) {
    let cells = matrix[i];
    if (!cells) {
      cells = [];
      matrix[i] = cells;
    }
    const row = grid.rows[i];
    if (row) row.cells = cells;
    else grid.rows[i] = { cells, wrapped: false };
  }

  return grid;
}
