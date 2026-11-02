/**
 * Procedural Box, Block, Powerline & Braille Sprite Rasterizer for Kite Terminal Canvas
 *
 * Renders Unicode Box Drawing (U+2500..U+257F), Block Elements (U+2580..U+259F),
 * Record Dot (U+23FA), Powerline Separators (U+E0B0..U+E0BF), and Braille Patterns
 * (U+2800..U+28FF) with device-pixel-snapped geometry directly onto the 2D canvas.
 * Eliminates horizontal gaps, vertical tears, and font-fallback seams at any fractional cell width.
 */

export function isProceduralSpriteChar(codePoint: number): boolean {
  return (
    (codePoint >= 0x2500 && codePoint <= 0x259f) || // Box Drawing + Block Elements
    codePoint === 0x23fa ||                         // Record symbol ⏺
    (codePoint >= 0xe0b0 && codePoint <= 0xe0bf) || // Powerline separators
    (codePoint >= 0x2800 && codePoint <= 0x28ff)    // Braille Patterns
  );
}

// 128-entry lookup tables for U+2500..U+257F
// Each nibble = [up, right, down, left], values: 0 = none, 1 = light, 2 = heavy
const LIGHT_HEAVY: readonly number[] = [
  0x0101, 0x0202, 0x1010, 0x2020, 0x0000, 0x0000, 0x0000, 0x0000, // 00-07
  0x0000, 0x0000, 0x0000, 0x0000, 0x0110, 0x0210, 0x0120, 0x0220, // 08-0F
  0x0011, 0x0012, 0x0021, 0x0022, 0x1100, 0x1200, 0x2100, 0x2200, // 10-17
  0x1001, 0x1002, 0x2001, 0x2002, 0x1110, 0x1210, 0x2110, 0x1120, // 18-1F
  0x2120, 0x2210, 0x1220, 0x2220, 0x1011, 0x1012, 0x2011, 0x1021, // 20-27
  0x2021, 0x2012, 0x1022, 0x2022, 0x0111, 0x0112, 0x0211, 0x0212, // 28-2F
  0x0121, 0x0122, 0x0221, 0x0222, 0x1101, 0x1102, 0x1201, 0x1202, // 30-37
  0x2101, 0x2102, 0x2201, 0x2202, 0x1111, 0x1112, 0x1211, 0x1212, // 38-3F
  0x2111, 0x1121, 0x2121, 0x2112, 0x2211, 0x1122, 0x1221, 0x2212, // 40-47
  0x1222, 0x2122, 0x2221, 0x2222, 0x0000, 0x0000, 0x0000, 0x0000, // 48-4F
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, // 50-57
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, // 58-5F
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, // 60-67
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, // 68-6F
  0x0000, 0x0000, 0x0000, 0x0000, 0x0001, 0x1000, 0x0100, 0x0010, // 70-77
  0x0002, 0x2000, 0x0200, 0x0020, 0x0201, 0x1020, 0x0102, 0x2010, // 78-7F
];

const DOUBLE: readonly number[] = [
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0101, 0x1010, 0x0100, 0x0010, 0x0110, 0x0001, 0x0010, 0x0011, // 50-57
  0x0100, 0x1000, 0x1100, 0x0001, 0x1000, 0x1001, 0x0100, 0x1010, // 58-5F
  0x1110, 0x0001, 0x1010, 0x1011, 0x0101, 0x0010, 0x0111, 0x0101, // 60-67
  0x1000, 0x1101, 0x0101, 0x1010, 0x1111, 0x0000, 0x0000, 0x0000, // 68-6F
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
];

const SINGLES: readonly number[] = [
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0010, 0x0100, 0x0000, 0x0010, 0x0001, 0x0000, // 50-57
  0x1000, 0x0100, 0x0000, 0x1000, 0x0001, 0x0000, 0x1010, 0x0100, // 58-5F
  0x0000, 0x1010, 0x0001, 0x0000, 0x0010, 0x0101, 0x0000, 0x1000, // 60-67
  0x0101, 0x0000, 0x1010, 0x0101, 0x0000, 0x0000, 0x0000, 0x0000, // 68-6F
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
];

function decodeArms(val: number): [number, number, number, number] {
  return [(val >> 12) & 0xf, (val >> 8) & 0xf, (val >> 4) & 0xf, val & 0xf];
}

function drawDashedH(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  t: number,
  n: number,
  snap: (v: number) => number
): void {
  const seg = w / (n * 2);
  const sy = snap(y);
  const st = Math.max(t, 1);
  for (let i = 0; i < n; i++) {
    const sx = snap(x + i * seg * 2);
    const ex = snap(x + i * seg * 2 + seg);
    ctx.fillRect(sx, sy, Math.max(ex - sx, 1), st);
  }
}

function drawDashedV(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  h: number,
  t: number,
  n: number,
  snap: (v: number) => number
): void {
  const seg = h / (n * 2);
  const sx = snap(x);
  const st = Math.max(t, 1);
  for (let i = 0; i < n; i++) {
    const sy = snap(y + i * seg * 2);
    const ey = snap(y + i * seg * 2 + seg);
    ctx.fillRect(sx, sy, st, Math.max(ey - sy, 1));
  }
}

export function drawProceduralSprite(
  ctx: CanvasRenderingContext2D,
  codePoint: number,
  x: number,
  y: number,
  cellW: number,
  cellH: number,
  fgColor: string,
  dpr = 1,
  bold = false
): boolean {
  if (!isProceduralSpriteChar(codePoint)) {
    return false;
  }

  const safeDpr = dpr > 0 ? dpr : 1;
  const snap = (v: number) => Math.round(v * safeDpr) / safeDpr;

  const x0 = snap(x);
  const y0 = snap(y);
  const x1 = snap(x + cellW);
  const y1 = snap(y + cellH);
  const w = x1 - x0;
  const h = y1 - y0;

  ctx.save();
  ctx.fillStyle = fgColor;
  ctx.strokeStyle = fgColor;

  // 1. Box Drawing (U+2500..U+257F)
  if (codePoint >= 0x2500 && codePoint <= 0x257f) {
    const idx = codePoint - 0x2500;
    const basePx = Math.max(Math.round((h / 10) * safeDpr), 1);
    const light = (bold ? basePx * 2 : basePx) / safeDpr;
    const heavy = (basePx * 2) / safeDpr;

    const vOff = Math.round(((w - light) * 0.5) * safeDpr) / safeDpr;
    const hOff = Math.round(((h - light) * 0.5) * safeDpr) / safeDpr;
    const vOffH = Math.round(((w - heavy) * 0.5) * safeDpr) / safeDpr;
    const hOffH = Math.round(((h - heavy) * 0.5) * safeDpr) / safeDpr;

    const cx = x0 + vOff + light * 0.5;
    const cy = y0 + hOff + light * 0.5;

    // Dashed lines
    if (
      (idx >= 0x04 && idx <= 0x0b) ||
      (idx >= 0x4c && idx <= 0x4f)
    ) {
      if (idx === 0x04) drawDashedH(ctx, x0, y0 + hOff, w, light, 3, snap);
      else if (idx === 0x05) drawDashedH(ctx, x0, y0 + hOffH, w, heavy, 3, snap);
      else if (idx === 0x06) drawDashedV(ctx, x0 + vOff, y0, h, light, 3, snap);
      else if (idx === 0x07) drawDashedV(ctx, x0 + vOffH, y0, h, heavy, 3, snap);
      else if (idx === 0x08) drawDashedH(ctx, x0, y0 + hOff, w, light, 4, snap);
      else if (idx === 0x09) drawDashedH(ctx, x0, y0 + hOffH, w, heavy, 4, snap);
      else if (idx === 0x0a) drawDashedV(ctx, x0 + vOff, y0, h, light, 4, snap);
      else if (idx === 0x0b) drawDashedV(ctx, x0 + vOffH, y0, h, heavy, 4, snap);
      else if (idx === 0x4c) drawDashedH(ctx, x0, y0 + hOff, w, light, 2, snap);
      else if (idx === 0x4d) drawDashedH(ctx, x0, y0 + hOffH, w, heavy, 2, snap);
      else if (idx === 0x4e) drawDashedV(ctx, x0 + vOff, y0, h, light, 2, snap);
      else if (idx === 0x4f) drawDashedV(ctx, x0 + vOffH, y0, h, heavy, 2, snap);
      ctx.restore();
      return true;
    }

    // Rounded corners (╭ ╮ ╯ ╰)
    if (idx >= 0x6d && idx <= 0x70) {
      ctx.lineWidth = light;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      const r = Math.min(w, h) * 0.5;
      const k = 0.5522847498;
      const kr = r * k;
      if (idx === 0x6d) {
        // ╭
        ctx.moveTo(cx, y1);
        ctx.lineTo(cx, cy + r);
        ctx.bezierCurveTo(cx, cy + r - kr, cx + r - kr, cy, cx + r, cy);
        ctx.lineTo(x1, cy);
      } else if (idx === 0x6e) {
        // ╮
        ctx.moveTo(x0, cy);
        ctx.lineTo(cx - r, cy);
        ctx.bezierCurveTo(cx - r + kr, cy, cx, cy + r - kr, cx, cy + r);
        ctx.lineTo(cx, y1);
      } else if (idx === 0x6f) {
        // ╯
        ctx.moveTo(cx, y0);
        ctx.lineTo(cx, cy - r);
        ctx.bezierCurveTo(cx, cy - r + kr, cx - r + kr, cy, cx - r, cy);
        ctx.lineTo(x0, cy);
      } else if (idx === 0x70) {
        // ╰
        ctx.moveTo(x1, cy);
        ctx.lineTo(cx + r, cy);
        ctx.bezierCurveTo(cx + r - kr, cy, cx, cy - r + kr, cx, cy - r);
        ctx.lineTo(cx, y0);
      }
      ctx.stroke();
      ctx.restore();
      return true;
    }

    // Diagonals (╱ ╲ ╳)
    if (idx >= 0x71 && idx <= 0x73) {
      ctx.lineWidth = light;
      ctx.beginPath();
      if (idx === 0x71 || idx === 0x73) {
        ctx.moveTo(x1, y0);
        ctx.lineTo(x0, y1);
      }
      if (idx === 0x72 || idx === 0x73) {
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
      }
      ctx.stroke();
      ctx.restore();
      return true;
    }

    // Standard Light / Heavy / Double arms
    const lh = decodeArms(LIGHT_HEAVY[idx]);
    const db = decodeArms(DOUBLE[idx]);
    const sg = decodeArms(SINGLES[idx]);

    const u = lh[0] | sg[0];
    const r = lh[1] | sg[1];
    const d = lh[2] | sg[2];
    const l = lh[3] | sg[3];

    if (u > 0 || r > 0 || d > 0 || l > 0) {
      if (u === d && u !== 0 && l === 0 && r === 0 && db[0] === 0 && db[1] === 0 && db[2] === 0 && db[3] === 0) {
        const t = u === 2 ? heavy : light;
        const off = u === 2 ? vOffH : vOff;
        ctx.fillRect(x0 + off, y0, t, h);
      } else if (l === r && l !== 0 && u === 0 && d === 0 && db[0] === 0 && db[1] === 0 && db[2] === 0 && db[3] === 0) {
        const t = l === 2 ? heavy : light;
        const off = l === 2 ? hOffH : hOff;
        ctx.fillRect(x0, y0 + off, w, t);
      } else {
        const maxH = Math.max(l, r);
        const hExt = maxH === 2 ? heavy * 0.5 : maxH === 1 ? light * 0.5 : 0;
        const maxV = Math.max(u, d);
        const vExt = maxV === 2 ? heavy * 0.5 : maxV === 1 ? light * 0.5 : 0;

        if (u > 0) {
          const t = u === 2 ? heavy : light;
          const off = u === 2 ? vOffH : vOff;
          const bottom = snap(cy + (d === 0 ? hExt : 0));
          ctx.fillRect(x0 + off, y0, t, bottom - y0);
        }
        if (d > 0) {
          const t = d === 2 ? heavy : light;
          const off = d === 2 ? vOffH : vOff;
          const top = snap(cy - (u === 0 ? hExt : 0));
          ctx.fillRect(x0 + off, top, t, y1 - top);
        }
        if (l > 0) {
          const t = l === 2 ? heavy : light;
          const off = l === 2 ? hOffH : hOff;
          const right = snap(cx + (r === 0 ? vExt : 0));
          ctx.fillRect(x0, y0 + off, right - x0, t);
        }
        if (r > 0) {
          const t = r === 2 ? heavy : light;
          const off = r === 2 ? hOffH : hOff;
          const left = snap(cx - (l === 0 ? vExt : 0));
          ctx.fillRect(left, y0 + off, x1 - left, t);
        }
      }
    }

    // Double lines
    const [du, dr, dd, dl] = db;
    if (du > 0 || dr > 0 || dd > 0 || dl > 0) {
      const gap = Math.max(light, 2 / safeDpr);
      const t = light;
      const vx1 = snap(cx - gap * 0.5 - t);
      const vx2 = snap(cx + gap * 0.5);
      const hy1 = snap(cy - gap * 0.5 - t);
      const hy2 = snap(cy + gap * 0.5);

      if (du > 0 && dd > 0 && dl === 0 && dr === 0) {
        ctx.fillRect(vx1, y0, t, h);
        ctx.fillRect(vx2, y0, t, h);
      } else if (dl > 0 && dr > 0 && du === 0 && dd === 0) {
        ctx.fillRect(x0, hy1, w, t);
        ctx.fillRect(x0, hy2, w, t);
      } else {
        if (du > 0) {
          const endL = dl > 0 ? hy1 + t : dd > 0 ? cy : hy2 + t;
          const endR = dr > 0 ? hy1 + t : dd > 0 ? cy : hy2 + t;
          ctx.fillRect(vx1, y0, t, endL - y0);
          ctx.fillRect(vx2, y0, t, endR - y0);
        }
        if (dd > 0) {
          const startL = dl > 0 ? hy2 : du > 0 ? cy : hy1;
          const startR = dr > 0 ? hy2 : du > 0 ? cy : hy1;
          ctx.fillRect(vx1, startL, t, y1 - startL);
          ctx.fillRect(vx2, startR, t, y1 - startR);
        }
        if (dl > 0) {
          const endT = du > 0 ? vx1 + t : dr > 0 ? cx : vx2 + t;
          const endB = dd > 0 ? vx1 + t : dr > 0 ? cx : vx2 + t;
          ctx.fillRect(x0, hy1, endT - x0, t);
          ctx.fillRect(x0, hy2, endB - x0, t);
        }
        if (dr > 0) {
          const startT = du > 0 ? vx2 : dl > 0 ? cx : vx1;
          const startB = dd > 0 ? vx2 : dl > 0 ? cx : vx1;
          ctx.fillRect(startT, hy1, x1 - startT, t);
          ctx.fillRect(startB, hy2, x1 - startB, t);
        }
      }
    }

    ctx.restore();
    return true;
  }

  // 2. Block Elements (U+2580..U+259F)
  if (codePoint >= 0x2580 && codePoint <= 0x259f) {
    const idx = codePoint - 0x2580;
    if (idx === 0x00) {
      // ▀ Upper half
      ctx.fillRect(x0, y0, w, snap(h * 0.5));
    } else if (idx >= 0x01 && idx <= 0x08) {
      // ▁..█ Lower n/8
      const frac = idx / 8;
      const top = snap(y1 - h * frac);
      ctx.fillRect(x0, top, w, y1 - top);
    } else if (idx >= 0x09 && idx <= 0x0f) {
      // ▉..▏ Left (8 - (idx - 8))/8
      const eighths = 16 - idx;
      const frac = eighths / 8;
      ctx.fillRect(x0, y0, snap(w * frac), h);
    } else if (idx === 0x10) {
      // ▐ Right half
      const left = snap(x0 + w * 0.5);
      ctx.fillRect(left, y0, x1 - left, h);
    } else if (idx >= 0x11 && idx <= 0x13) {
      // ░ ▒ ▓ Shades
      ctx.globalAlpha = idx === 0x11 ? 0.25 : idx === 0x12 ? 0.5 : 0.75;
      ctx.fillRect(x0, y0, w, h);
    } else if (idx === 0x14) {
      // ▔ Upper 1/8
      ctx.fillRect(x0, y0, w, snap(h / 8));
    } else if (idx === 0x15) {
      // ▕ Right 1/8
      const left = snap(x1 - w / 8);
      ctx.fillRect(left, y0, x1 - left, h);
    } else if (idx >= 0x16 && idx <= 0x1f) {
      // Quadrants ▖..▟
      const qx = snap(x0 + w * 0.5);
      const qy = snap(y0 + h * 0.5);
      const lw = qx - x0;
      const rw = x1 - qx;
      const th = qy - y0;
      const bh = y1 - qy;
      const masks = [0b0100, 0b1000, 0b0001, 0b1101, 0b1001, 0b0111, 0b1011, 0b0010, 0b0110, 0b1110];
      const mask = masks[idx - 0x16];
      if ((mask & 1) !== 0) ctx.fillRect(x0, y0, lw, th);
      if ((mask & 2) !== 0) ctx.fillRect(qx, y0, rw, th);
      if ((mask & 4) !== 0) ctx.fillRect(x0, qy, lw, bh);
      if ((mask & 8) !== 0) ctx.fillRect(qx, qy, rw, bh);
    }
    ctx.restore();
    return true;
  }

  // 3. Record symbol ⏺ (U+23FA)
  if (codePoint === 0x23fa) {
    ctx.beginPath();
    ctx.arc(x0 + w * 0.5, y0 + h * 0.5, w * 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return true;
  }

  // 4. Powerline symbols (U+E0B0..U+E0BF)
  if (codePoint >= 0xe0b0 && codePoint <= 0xe0bf) {
    const idx = codePoint - 0xe0b0;
    const cy = y0 + h * 0.5;
    const basePx = Math.max(Math.round((h / 10) * safeDpr), 1);
    const thin = basePx / safeDpr;

    if (idx === 0x00) {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, cy);
      ctx.lineTo(x0, y1);
      ctx.closePath();
      ctx.fill();
    } else if (idx === 0x01 || idx === 0x09 || idx === 0x0d) {
      ctx.lineWidth = thin;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, cy);
      ctx.lineTo(x0, y1);
      ctx.stroke();
    } else if (idx === 0x02) {
      ctx.beginPath();
      ctx.moveTo(x1, y0);
      ctx.lineTo(x0, cy);
      ctx.lineTo(x1, y1);
      ctx.closePath();
      ctx.fill();
    } else if (idx === 0x03 || idx === 0x0b || idx === 0x0f) {
      ctx.lineWidth = thin;
      ctx.beginPath();
      ctx.moveTo(x1, y0);
      ctx.lineTo(x0, cy);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    } else if (idx === 0x04) {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.arc(x0, cy, Math.min(w, h * 0.5), -Math.PI * 0.5, Math.PI * 0.5);
      ctx.closePath();
      ctx.fill();
    } else if (idx === 0x05) {
      ctx.lineWidth = thin;
      ctx.beginPath();
      ctx.arc(x0, cy, Math.min(w, h * 0.5), -Math.PI * 0.5, Math.PI * 0.5);
      ctx.stroke();
    } else if (idx === 0x06) {
      ctx.beginPath();
      ctx.moveTo(x1, y0);
      ctx.arc(x1, cy, Math.min(w, h * 0.5), Math.PI * 0.5, -Math.PI * 0.5);
      ctx.closePath();
      ctx.fill();
    } else if (idx === 0x07) {
      ctx.lineWidth = thin;
      ctx.beginPath();
      ctx.arc(x1, cy, Math.min(w, h * 0.5), Math.PI * 0.5, -Math.PI * 0.5);
      ctx.stroke();
    } else if (idx === 0x08) {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x0, y1);
      ctx.closePath();
      ctx.fill();
    } else if (idx === 0x0a) {
      ctx.beginPath();
      ctx.moveTo(x1, y0);
      ctx.lineTo(x0, y1);
      ctx.lineTo(x1, y1);
      ctx.closePath();
      ctx.fill();
    } else if (idx === 0x0c) {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y0);
      ctx.lineTo(x0, y1);
      ctx.closePath();
      ctx.fill();
    } else if (idx === 0x0e) {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y0);
      ctx.lineTo(x1, y1);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    return true;
  }

  // 5. Braille Patterns (U+2800..U+28FF)
  if (codePoint >= 0x2800 && codePoint <= 0x28ff) {
    const bits = (codePoint - 0x2800) & 0xff;
    if (bits === 0) {
      ctx.restore();
      return true;
    }
    const dotW = Math.max(1 / safeDpr, snap(w * 0.22));
    const dotH = Math.max(1 / safeDpr, snap(h * 0.14));

    const colX = [x0 + w * 0.28, x0 + w * 0.72];
    const rowY = [
      y0 + h * 0.16,
      y0 + h * 0.38,
      y0 + h * 0.62,
      y0 + h * 0.84,
    ];

    const dotMap: ReadonlyArray<readonly [number, number, number]> = [
      [0, 0, 0],
      [1, 0, 1],
      [2, 0, 2],
      [3, 1, 0],
      [4, 1, 1],
      [5, 1, 2],
      [6, 0, 3],
      [7, 1, 3],
    ];

    for (const [bit, col, row] of dotMap) {
      if ((bits & (1 << bit)) !== 0) {
        ctx.fillRect(
          snap(colX[col] - dotW * 0.5),
          snap(rowY[row] - dotH * 0.5),
          dotW,
          dotH
        );
      }
    }

    ctx.restore();
    return true;
  }

  ctx.restore();
  return false;
}
