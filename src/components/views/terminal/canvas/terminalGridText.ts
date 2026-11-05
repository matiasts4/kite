import { extractTerminalLinks } from '../../../../lib/terminalLinkNav';
import type { CellSnapshot } from './terminalCanvasTypes';

export interface GridLinkHit {
  row: number;
  startCol: number;
  endCol: number;
  kind: 'web' | 'file';
  text: string;
}

export interface GridFindHit {
  row: number;
  startCol: number;
  endCol: number;
}

function cellText(cell: CellSnapshot | undefined): string {
  if (!cell || cell.width === 0) return '';
  return cell.ch && cell.ch.length > 0 ? cell.ch : ' ';
}

/** A click on a wide continuation lands on the head cell. */
export function contentColumn(row: CellSnapshot[] | undefined, col: number): number {
  if (!row || col <= 0) return Math.max(0, col);
  let cursor = Math.min(col, row.length - 1);
  while (cursor > 0 && row[cursor] && row[cursor].width === 0) cursor -= 1;
  return cursor;
}

interface LogicalCell {
  row: number;
  col: number;
}

interface LogicalLine {
  text: string;
  cells: LogicalCell[];
}

function expandLogicalLine(
  matrix: CellSnapshot[][],
  wrapped: boolean[],
  row: number,
): LogicalLine {
  let head = row;
  while (head > 0 && wrapped[head - 1]) head -= 1;
  const cells: LogicalCell[] = [];
  let text = '';
  for (let r = head; r < matrix.length; r += 1) {
    const line = matrix[r] || [];
    for (let c = 0; c < line.length; c += 1) {
      const ch = cellText(line[c]);
      if (!ch) continue;
      for (let i = 0; i < ch.length; i += 1) {
        cells.push({ row: r, col: c });
        text += ch[i];
      }
    }
    if (!wrapped[r]) break;
  }
  return { text, cells };
}

function spanOnRow(
  matrix: CellSnapshot[][],
  logical: LogicalLine,
  from: number,
  to: number,
  row: number,
): { startCol: number; endCol: number } | null {
  let startCol = -1;
  let endCol = -1;
  const last = Math.min(to, logical.cells.length);
  for (let i = from; i < last; i += 1) {
    const cell = logical.cells[i];
    if (cell.row !== row) continue;
    const width = Math.max(1, matrix[row]?.[cell.col]?.width || 1);
    if (startCol < 0) startCol = cell.col;
    endCol = cell.col + width;
  }
  if (startCol < 0 || endCol <= startCol) return null;
  return { startCol, endCol };
}

export function findGridLink(
  matrix: CellSnapshot[][],
  wrapped: boolean[],
  row: number,
  col: number,
): GridLinkHit | null {
  if (row < 0 || row >= matrix.length) return null;
  const logical = expandLogicalLine(matrix, wrapped, row);
  if (!logical.text.trim()) return null;
  const clicked = contentColumn(matrix[row], col);
  for (const link of extractTerminalLinks(logical.text)) {
    let onClick = false;
    for (let i = link.start; i < link.end && i < logical.cells.length; i += 1) {
      const cell = logical.cells[i];
      if (cell.row === row && cell.col === clicked) {
        onClick = true;
        break;
      }
    }
    if (!onClick) continue;
    const slice = spanOnRow(matrix, logical, link.start, link.end, row);
    if (!slice) continue;
    return {
      row,
      startCol: slice.startCol,
      endCol: slice.endCol,
      kind: link.kind,
      text: link.text,
    };
  }
  return null;
}

export function collectFindHits(
  matrix: CellSnapshot[][],
  wrapped: boolean[],
  query: string,
): GridFindHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: GridFindHit[] = [];
  const seen = new Set<number>();
  for (let row = 0; row < matrix.length; row += 1) {
    if (seen.has(row)) continue;
    let head = row;
    while (head > 0 && wrapped[head - 1]) head -= 1;
    const logical = expandLogicalLine(matrix, wrapped, head);
    for (let r = head; r < matrix.length; r += 1) {
      seen.add(r);
      if (!wrapped[r]) break;
    }
    const hay = logical.text.toLowerCase();
    let from = 0;
    while (from < hay.length && hits.length < 200) {
      const idx = hay.indexOf(needle, from);
      if (idx < 0) break;
      const end = idx + needle.length;
      let currentRow = -1;
      let startCol = 0;
      let endCol = 0;
      const last = Math.min(end, logical.cells.length);
      for (let i = idx; i < last; i += 1) {
        const cell = logical.cells[i];
        const width = Math.max(1, matrix[cell.row]?.[cell.col]?.width || 1);
        if (cell.row !== currentRow) {
          if (currentRow >= 0) hits.push({ row: currentRow, startCol, endCol });
          currentRow = cell.row;
          startCol = cell.col;
          endCol = cell.col + width;
        } else {
          endCol = cell.col + width;
        }
      }
      if (currentRow >= 0) hits.push({ row: currentRow, startCol, endCol });
      from = idx + Math.max(1, needle.length);
    }
  }
  return hits;
}

/** Last nonempty visible lines, for the polite live region. */
export function visibleScreenText(
  matrix: CellSnapshot[][],
  maxLines = 12,
  maxChars = 800,
): string {
  const lines: string[] = [];
  for (let r = 0; r < matrix.length; r += 1) {
    let line = '';
    const row = matrix[r] || [];
    for (const cell of row) {
      if (!cell || cell.width === 0) continue;
      line += cell.ch && cell.ch.length > 0 ? cell.ch : ' ';
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const tail = lines.filter((line) => line.length > 0).slice(-maxLines);
  let text = tail.join('\n');
  if (text.length > maxChars) text = text.slice(-maxChars);
  return text;
}
