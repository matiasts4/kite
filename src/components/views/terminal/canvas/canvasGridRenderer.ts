import { resolveTerminalFontFamily, type TerminalAppearancePrefs } from '../../../../lib/terminalAppearancePrefs';
import { isProceduralSpriteChar, drawProceduralSprite } from '../../../../lib/terminalSprites';
import { isTerminalBenchmarkActive, recordFramePaint } from './terminalBenchMetrics';
import type { GridFindHit } from './terminalGridText';
import {
  type CellSnapshot,
  type CursorSnapshot,
  type HoveredLinkSpan,
  type SelectionPoint,
  DEFAULT_BG_HEX,
  DEFAULT_FG_HEX,
  SELECTION_BG,
  PAD_X,
  PAD_Y,
  isPrivateUseNerdIcon,
} from './terminalCanvasTypes';

export interface CanvasRenderState {
  canvas: HTMLCanvasElement;
  prefs: TerminalAppearancePrefs;
  matrix: CellSnapshot[][];
  cursor: CursorSnapshot;
  selection: { start: SelectionPoint | null; end: SelectionPoint | null };
  hoveredLink: HoveredLinkSpan | null;
  findHits?: GridFindHit[];
  activeFind?: number;
  isFocused: boolean;
  scrollbackOffset: number;
  cellW: number;
  cellH: number;
  baseline: number;
  gridRows: number;
  gridCols: number;
  /** null paints every row. An array paints only those row indexes. */
  dirtyRows?: number[] | null;
  cursorBlinkOn?: boolean;
  onPaintRow?: (row: number) => void;
}

export function renderCanvasGrid(state: CanvasRenderState): number {
  const {
    canvas,
    prefs,
    matrix,
    cursor,
    selection,
    hoveredLink,
    findHits,
    activeFind = -1,
    isFocused,
    scrollbackOffset,
    cellW,
    cellH,
    baseline,
    gridRows,
    gridCols,
    dirtyRows,
    cursorBlinkOn = true,
    onPaintRow,
  } = state;

  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return 0;

  const benchActive = isTerminalBenchmarkActive();
  const benchStart = benchActive ? performance.now() : 0;

  const rect = canvas.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return 0;

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const displayW = rect.width;
  const displayH = rect.height;
  const targetPixelW = Math.max(1, Math.round(displayW * dpr));
  const targetPixelH = Math.max(1, Math.round(displayH * dpr));

  const sizeChanged = canvas.width !== targetPixelW || canvas.height !== targetPixelH;
  if (sizeChanged) {
    canvas.width = targetPixelW;
    canvas.height = targetPixelH;
  }
  const partial = !sizeChanged && Array.isArray(dirtyRows) && dirtyRows.length > 0;
  const dirtySet = partial ? new Set(dirtyRows) : null;
  const paintRow = (row: number) => !dirtySet || dirtySet.has(row);

  const snap = (v: number) => Math.round(v * dpr) / dpr;

  ctx.save();
  ctx.scale(dpr, dpr);

  if (!partial) {
    ctx.fillStyle = DEFAULT_BG_HEX;
    ctx.fillRect(0, 0, displayW, displayH);
  }

  const fontFamily = resolveTerminalFontFamily(prefs.fontFamilyId);
  const fontSize = prefs.fontSize;
  const normalFont = `${fontSize}px ${fontFamily}`;
  const boldFont = `bold ${fontSize}px ${fontFamily}`;
  const italicFont = `italic ${fontSize}px ${fontFamily}`;
  const boldItalicFont = `bold italic ${fontSize}px ${fontFamily}`;

  const visibleRows = Math.min(matrix.length, gridRows);
  const visibleCols = gridCols;

  const innerH = Math.max(0, displayH - PAD_Y * 2);
  const spareY = Math.max(0, innerH - gridRows * cellH);
  const ox = PAD_X;
  const oy = PAD_Y + snap(spareY * 0.5);
  const spareYOffset = snap(spareY * 0.5);

  // Selection range normalization
  let selStart = selection.start;
  let selEnd = selection.end;
  let hasSelection = false;
  if (selStart && selEnd && (selStart.row !== selEnd.row || selStart.col !== selEnd.col)) {
    if (selStart.row > selEnd.row || (selStart.row === selEnd.row && selStart.col > selEnd.col)) {
      const tmp = selStart;
      selStart = selEnd;
      selEnd = tmp;
    }
    hasSelection = true;
  }

  // Pass 1: Batched cell backgrounds & selection highlights
  for (let r = 0; r < visibleRows; r++) {
    if (!paintRow(r)) continue;
    onPaintRow?.(r);
    const row = matrix[r];
    if (!row) continue;
    const y0 = snap(oy + r * cellH);
    if (partial) {
      ctx.fillStyle = DEFAULT_BG_HEX;
      ctx.fillRect(0, y0, displayW, snap(oy + (r + 1) * cellH) - y0);
    }
    const y1 = snap(oy + (r + 1) * cellH);
    const rh = y1 - y0;
    const maxCol = Math.min(row.length, visibleCols);

    let c = 0;
    while (c < maxCol) {
      const cell = row[c];
      if (!cell || cell.width === 0 || !cell.hasBg) {
        c++;
        continue;
      }
      const [br, bg, bb] = cell.bg;
      let endCol = c + Math.max(1, cell.width);
      while (endCol < maxCol) {
        const next = row[endCol];
        if (!next) break;
        if (next.width === 0) {
          endCol++;
          continue;
        }
        if (
          next.hasBg &&
          next.bg[0] === br &&
          next.bg[1] === bg &&
          next.bg[2] === bb
        ) {
          endCol += Math.max(1, next.width);
        } else {
          break;
        }
      }
      const x0 = snap(ox + c * cellW);
      const x1 = snap(ox + endCol * cellW);
      ctx.fillStyle = `rgb(${br},${bg},${bb})`;
      ctx.fillRect(x0, y0, x1 - x0, rh);
      c = endCol;
    }

    if (hasSelection && selStart && selEnd && r >= selStart.row && r <= selEnd.row) {
      const startC = Math.max(0, r === selStart.row ? selStart.col : 0);
      const endC = Math.min(visibleCols, r === selEnd.row ? selEnd.col : visibleCols);
      if (endC > startC) {
        const sx0 = snap(ox + startC * cellW);
        const sx1 = snap(ox + endC * cellW);
        ctx.fillStyle = SELECTION_BG;
        ctx.fillRect(sx0, y0, sx1 - sx0, rh);
      }
    }

    if (findHits && findHits.length > 0) {
      for (let i = 0; i < findHits.length; i += 1) {
        const hit = findHits[i];
        if (hit.row !== r || hit.endCol <= hit.startCol) continue;
        const fx0 = snap(ox + hit.startCol * cellW);
        const fx1 = snap(ox + Math.min(visibleCols, hit.endCol) * cellW);
        ctx.fillStyle = i === activeFind ? 'rgba(250, 204, 21, 0.45)' : 'rgba(250, 204, 21, 0.22)';
        ctx.fillRect(fx0, y0, Math.max(1, fx1 - fx0), rh);
      }
    }
  }

  // Pass 2: Procedural sprites, batched ASCII runs, Nerd Font icon fitting, non-ASCII glyphs & underlines
  let currentFont = '';
  let currentFill = '';

  for (let r = 0; r < visibleRows; r++) {
    if (!paintRow(r)) continue;
    const row = matrix[r];
    if (!row) continue;
    const py = oy + r * cellH;
    const textY = py + baseline;
    const maxCol = Math.min(row.length, visibleCols);

    let c = 0;
    while (c < maxCol) {
      const cell = row[c];
      if (!cell || cell.width === 0) {
        c++;
        continue;
      }

      const ch = cell.ch;
      const cp = ch ? ch.codePointAt(0) ?? 32 : 32;

      // Underline decoration
      if (cell.underline) {
        const fgCss = `rgb(${cell.fg[0]},${cell.fg[1]},${cell.fg[2]})`;
        if (currentFill !== fgCss) {
          ctx.fillStyle = fgCss;
          currentFill = fgCss;
        }
        const ux0 = snap(ox + c * cellW);
        const ux1 = snap(ox + (c + Math.max(1, cell.width)) * cellW);
        ctx.fillRect(ux0, snap(py + cellH - 2), ux1 - ux0, 1);
      }

      if (!ch || ch === ' ') {
        c++;
        continue;
      }

      const fgCss = `rgb(${cell.fg[0]},${cell.fg[1]},${cell.fg[2]})`;

      // Procedural sprite (Box Drawing, Block Elements, Braille, Powerline, Legacy computing)
      if (isProceduralSpriteChar(cp)) {
        if (cell.dim) ctx.globalAlpha = 0.6;
        drawProceduralSprite(
          ctx,
          cp,
          ox + c * cellW,
          py,
          cellW * Math.max(1, cell.width),
          cellH,
          fgCss,
          dpr,
          cell.bold
        );
        if (cell.dim) ctx.globalAlpha = 1;
        currentFill = '';
        c++;
        continue;
      }

      const targetFont = cell.bold
        ? cell.italic
          ? boldItalicFont
          : boldFont
        : cell.italic
          ? italicFont
          : normalFont;

      if (currentFont !== targetFont) {
        ctx.font = targetFont;
        currentFont = targetFont;
      }
      if (currentFill !== fgCss) {
        ctx.fillStyle = fgCss;
        currentFill = fgCss;
      }

      const isBatchableAscii = cp >= 0x20 && cp <= 0x7e && cell.width === 1;
      if (isBatchableAscii) {
        let runText = ch;
        let nextC = c + 1;
        while (nextC < maxCol) {
          const nextCell = row[nextC];
          if (!nextCell || nextCell.width !== 1) break;
          const nextCh = nextCell.ch || ' ';
          const nextCp = nextCh.codePointAt(0) ?? 32;
          if (
            nextCp < 0x20 ||
            nextCp > 0x7e ||
            nextCell.bold !== cell.bold ||
            nextCell.italic !== cell.italic ||
            nextCell.dim !== cell.dim ||
            nextCell.underline !== cell.underline ||
            nextCell.fg[0] !== cell.fg[0] ||
            nextCell.fg[1] !== cell.fg[1] ||
            nextCell.fg[2] !== cell.fg[2]
          ) {
            break;
          }
          if (nextCell.underline) {
            const ux0 = snap(ox + nextC * cellW);
            const ux1 = snap(ox + (nextC + 1) * cellW);
            ctx.fillRect(ux0, snap(py + cellH - 2), ux1 - ux0, 1);
          }
          runText += nextCh;
          nextC++;
        }
        if (cell.dim) ctx.globalAlpha = 0.6;
        ctx.fillText(runText, ox + c * cellW, textY);
        if (cell.dim) ctx.globalAlpha = 1;
        c = nextC;
      } else if (isPrivateUseNerdIcon(cp)) {
        const nextIsBlank =
          c + 1 < maxCol && (!row[c + 1] || !row[c + 1].ch || row[c + 1].ch === ' ');
        const availCells = nextIsBlank ? 1.45 : 1.0;
        const availW = availCells * cellW;
        const glyphW = ctx.measureText(ch).width;
        if (cell.dim) ctx.globalAlpha = 0.6;
        if (glyphW > availW && glyphW > 1) {
          const scale = availW / glyphW;
          ctx.save();
          ctx.translate(ox + c * cellW, textY);
          ctx.scale(scale, scale);
          ctx.fillText(ch, 0, 0);
          ctx.restore();
          currentFont = '';
          currentFill = '';
        } else {
          const offsetX = Math.max(0, (cellW - glyphW) * 0.5);
          ctx.fillText(ch, ox + c * cellW + offsetX, textY);
        }
        if (cell.dim) ctx.globalAlpha = 1;
        c++;
      } else {
        if (cell.dim) ctx.globalAlpha = 0.6;
        ctx.fillText(ch, ox + c * cellW, textY);
        if (cell.dim) ctx.globalAlpha = 1;
        c++;
      }
    }
  }

  // Pass 2.5: Hovered Ctrl+Click link underline
  if (
    hoveredLink &&
    hoveredLink.row >= 0 &&
    hoveredLink.row < visibleRows &&
    paintRow(hoveredLink.row)
  ) {
    const ly = snap(oy + (hoveredLink.row + 1) * cellH - 2);
    const lx0 = snap(ox + hoveredLink.startCol * cellW);
    const lx1 = snap(ox + hoveredLink.endCol * cellW);
    ctx.fillStyle = '#5c8fff';
    ctx.fillRect(lx0, ly, Math.max(2, lx1 - lx0), 1.5);
  }

  // Pass 3: Cursor
  if (
    cursor.visible &&
    scrollbackOffset === 0 &&
    cursor.row >= 0 &&
    cursor.row < visibleRows &&
    cursor.col >= 0 &&
    cursor.col < visibleCols &&
    cursorBlinkOn &&
    paintRow(cursor.row)
  ) {
    const curCell = matrix[cursor.row]?.[cursor.col];
    const curSpan = curCell && curCell.width > 1 ? curCell.width : 1;
    const cx = snap(ox + cursor.col * cellW);
    const cy = snap(oy + cursor.row * cellH);
    const cw = snap(ox + (cursor.col + curSpan) * cellW) - cx;
    const ch = snap(oy + (cursor.row + 1) * cellH) - cy;

    if (!isFocused) {
      ctx.strokeStyle = 'rgba(250, 250, 250, 0.45)';
      ctx.lineWidth = 1;
      ctx.strokeRect(cx + 0.5, cy + 0.5, Math.max(1, cw - 1), Math.max(1, ch - 1));
    } else {
      const shape = cursor.shape || prefs.cursorStyle || 'bar';
      ctx.fillStyle = DEFAULT_FG_HEX;
      if (shape === 'bar') {
        ctx.fillRect(cx, cy, Math.max(2, Math.round(2 * dpr) / dpr), ch);
      } else if (shape === 'underline') {
        ctx.fillRect(cx, cy + ch - 2, cw, 2);
      } else {
        ctx.fillRect(cx, cy, cw, ch);
        if (curCell && curCell.ch && curCell.ch !== ' ') {
          ctx.fillStyle = DEFAULT_BG_HEX;
          ctx.font = curCell.bold ? boldFont : normalFont;
          ctx.fillText(curCell.ch, ox + cursor.col * cellW, oy + cursor.row * cellH + baseline);
        }
      }
    }
  }

  // Pass 4: Scrollback indicator pill when scrolled up
  if (!partial && scrollbackOffset > 0) {
    const label = `↑ ${scrollbackOffset} lines`;
    ctx.font = `11px ${fontFamily}`;
    const badgeW = Math.ceil(ctx.measureText(label).width) + 14;
    const badgeH = 20;
    const bx = displayW - badgeW - 22;
    const by = 8;
    ctx.fillStyle = 'rgba(24, 24, 28, 0.88)';
    ctx.fillRect(bx, by, badgeW, badgeH);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + 0.5, by + 0.5, badgeW - 1, badgeH - 1);
    ctx.fillStyle = '#e8c87a';
    ctx.fillText(label, bx + 7, by + 14);
  }

  ctx.restore();
  if (benchActive) {
    const durationUs = Math.round((performance.now() - benchStart) * 1000);
    const rowsCount = Array.isArray(dirtyRows) ? dirtyRows.length : gridRows;
    recordFramePaint(durationUs, rowsCount);
  }
  return spareYOffset;
}
