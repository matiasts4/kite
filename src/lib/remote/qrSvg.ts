export interface QrMatrixResult {
  version: number;
  size: number;
  modules: boolean[][];
  svgPath: string;
}

interface QrVersionSpec {
  version: number;
  totalCodewords: number;
  ecPerBlock: number;
  g1Blocks: number;
  g1Data: number;
  g2Blocks: number;
  g2Data: number;
  alignment: readonly number[];
}

// ISO/IEC 18004 Error Correction Level M tables for Versions 1..=10.
const VERSION_SPECS: readonly QrVersionSpec[] = [
  { version: 1, totalCodewords: 26, ecPerBlock: 10, g1Blocks: 1, g1Data: 16, g2Blocks: 0, g2Data: 0, alignment: [] },
  { version: 2, totalCodewords: 44, ecPerBlock: 16, g1Blocks: 1, g1Data: 28, g2Blocks: 0, g2Data: 0, alignment: [6, 18] },
  { version: 3, totalCodewords: 70, ecPerBlock: 26, g1Blocks: 1, g1Data: 44, g2Blocks: 0, g2Data: 0, alignment: [6, 22] },
  { version: 4, totalCodewords: 100, ecPerBlock: 18, g1Blocks: 2, g1Data: 32, g2Blocks: 0, g2Data: 0, alignment: [6, 26] },
  { version: 5, totalCodewords: 134, ecPerBlock: 24, g1Blocks: 2, g1Data: 43, g2Blocks: 0, g2Data: 0, alignment: [6, 30] },
  { version: 6, totalCodewords: 172, ecPerBlock: 16, g1Blocks: 4, g1Data: 27, g2Blocks: 0, g2Data: 0, alignment: [6, 34] },
  { version: 7, totalCodewords: 196, ecPerBlock: 18, g1Blocks: 4, g1Data: 31, g2Blocks: 0, g2Data: 0, alignment: [6, 22, 38] },
  { version: 8, totalCodewords: 242, ecPerBlock: 22, g1Blocks: 2, g1Data: 38, g2Blocks: 2, g2Data: 39, alignment: [6, 24, 42] },
  { version: 9, totalCodewords: 292, ecPerBlock: 22, g1Blocks: 3, g1Data: 36, g2Blocks: 2, g2Data: 37, alignment: [6, 26, 46] },
  { version: 10, totalCodewords: 346, ecPerBlock: 26, g1Blocks: 4, g1Data: 43, g2Blocks: 1, g2Data: 44, alignment: [6, 28, 50] },
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsComputeEcc(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGeneratorPoly(ecCount);
  const rem = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i += 1) {
    const factor = data[i] ^ rem[0];
    for (let j = 0; j < ecCount - 1; j += 1) {
      rem[j] = rem[j + 1];
    }
    rem[ecCount - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecCount; j += 1) {
        rem[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return rem;
}

function maxByteCapacity(spec: QrVersionSpec): number {
  const totalData = spec.g1Blocks * spec.g1Data + spec.g2Blocks * spec.g2Data;
  const headerBits = 4 + (spec.version >= 10 ? 16 : 8);
  return Math.floor((totalData * 8 - headerBits) / 8);
}

function selectVersion(byteLength: number): QrVersionSpec {
  for (const spec of VERSION_SPECS) {
    if (byteLength <= maxByteCapacity(spec)) {
      return spec;
    }
  }
  const maxAllowed = maxByteCapacity(VERSION_SPECS[VERSION_SPECS.length - 1]);
  throw new Error(
    `QR payload (${byteLength} UTF-8 bytes) exceeds Version 10 Level M limit (${maxAllowed} bytes).`
  );
}

function pushBits(bits: number[], value: number, bitCount: number): void {
  for (let i = bitCount - 1; i >= 0; i -= 1) {
    bits.push((value >>> i) & 1);
  }
}

function buildInterleavedCodewords(bytes: Uint8Array, spec: QrVersionSpec): Uint8Array {
  const totalDataCodewords = spec.g1Blocks * spec.g1Data + spec.g2Blocks * spec.g2Data;
  const totalDataBits = totalDataCodewords * 8;
  const bits: number[] = [];

  // Byte mode indicator (0100) + character count
  pushBits(bits, 0b0100, 4);
  pushBits(bits, bytes.length, spec.version >= 10 ? 16 : 8);
  for (let i = 0; i < bytes.length; i += 1) {
    pushBits(bits, bytes[i], 8);
  }

  // Terminator (up to 4 zero bits) and byte alignment padding
  const terminatorLen = Math.min(4, totalDataBits - bits.length);
  for (let i = 0; i < terminatorLen; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataBytes = new Uint8Array(totalDataCodewords);
  let byteIdx = 0;
  for (let i = 0; i < bits.length; i += 8) {
    let val = 0;
    for (let b = 0; b < 8; b += 1) {
      val = (val << 1) | bits[i + b];
    }
    dataBytes[byteIdx++] = val;
  }

  const padBytes = [0xec, 0x11];
  let padToggle = 0;
  while (byteIdx < totalDataCodewords) {
    dataBytes[byteIdx++] = padBytes[padToggle % 2];
    padToggle += 1;
  }

  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < spec.g1Blocks; i += 1) {
    const block = dataBytes.slice(offset, offset + spec.g1Data);
    offset += spec.g1Data;
    dataBlocks.push(block);
    eccBlocks.push(rsComputeEcc(block, spec.ecPerBlock));
  }
  for (let i = 0; i < spec.g2Blocks; i += 1) {
    const block = dataBytes.slice(offset, offset + spec.g2Data);
    offset += spec.g2Data;
    dataBlocks.push(block);
    eccBlocks.push(rsComputeEcc(block, spec.ecPerBlock));
  }

  const out = new Uint8Array(spec.totalCodewords);
  let outIdx = 0;
  const maxDataLen = Math.max(spec.g1Data, spec.g2Data);
  for (let i = 0; i < maxDataLen; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) {
        out[outIdx++] = block[i];
      }
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const ecc of eccBlocks) {
      out[outIdx++] = ecc[i];
    }
  }
  return out;
}

function createMatrix(size: number): boolean[][] {
  return Array.from({ length: size }, () => Array<boolean>(size).fill(false));
}

function setFunctionModule(
  modules: boolean[][],
  isFunction: boolean[][],
  r: number,
  c: number,
  dark: boolean
): void {
  modules[r][c] = dark;
  isFunction[r][c] = true;
}

function drawFinderWithSeparator(
  modules: boolean[][],
  isFunction: boolean[][],
  size: number,
  topRow: number,
  leftCol: number
): void {
  for (let dr = -1; dr <= 7; dr += 1) {
    const r = topRow + dr;
    if (r < 0 || r >= size) continue;
    for (let dc = -1; dc <= 7; dc += 1) {
      const c = leftCol + dc;
      if (c < 0 || c >= size) continue;
      const inFinder = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      const isDark =
        inFinder &&
        (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
      setFunctionModule(modules, isFunction, r, c, isDark);
    }
  }
}

function drawAlignmentPattern(
  modules: boolean[][],
  isFunction: boolean[][],
  centerRow: number,
  centerCol: number
): void {
  for (let dr = -2; dr <= 2; dr += 1) {
    for (let dc = -2; dc <= 2; dc += 1) {
      const dist = Math.max(Math.abs(dr), Math.abs(dc));
      setFunctionModule(modules, isFunction, centerRow + dr, centerCol + dc, dist !== 1);
    }
  }
}

function drawVersionInfo(
  modules: boolean[][],
  isFunction: boolean[][],
  size: number,
  version: number
): void {
  if (version < 7) return;
  let rem = version << 12;
  for (let i = 17; i >= 12; i -= 1) {
    if ((rem >>> i) & 1) {
      rem ^= 0x1f25 << (i - 12);
    }
  }
  const bits = (version << 12) | rem;
  for (let k = 0; k < 18; k += 1) {
    const dark = ((bits >>> k) & 1) === 1;
    const a = Math.floor(k / 3);
    const b = k % 3;
    setFunctionModule(modules, isFunction, a, size - 11 + b, dark);
    setFunctionModule(modules, isFunction, size - 11 + b, a, dark);
  }
}

function computeFormatBitsLevelM(mask: number): number {
  // Error Correction Level M indicator is 00.
  const data = mask & 0x7;
  let rem = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if ((rem >>> i) & 1) {
      rem ^= 0x537 << (i - 10);
    }
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormatInfo(
  modules: boolean[][],
  isFunction: boolean[][],
  size: number,
  mask: number
): void {
  const bits = computeFormatBitsLevelM(mask);

  // Copy 1 (around top-left finder)
  for (let i = 0; i <= 5; i += 1) {
    setFunctionModule(modules, isFunction, 8, i, ((bits >>> (14 - i)) & 1) === 1);
  }
  setFunctionModule(modules, isFunction, 8, 7, ((bits >>> 8) & 1) === 1);
  setFunctionModule(modules, isFunction, 8, 8, ((bits >>> 7) & 1) === 1);
  setFunctionModule(modules, isFunction, 7, 8, ((bits >>> 6) & 1) === 1);
  for (let i = 0; i <= 5; i += 1) {
    setFunctionModule(modules, isFunction, 5 - i, 8, ((bits >>> (5 - i)) & 1) === 1);
  }

  // Copy 2 (bottom-left and top-right)
  for (let i = 0; i < 7; i += 1) {
    setFunctionModule(modules, isFunction, size - 1 - i, 8, ((bits >>> (14 - i)) & 1) === 1);
  }
  for (let i = 0; i < 8; i += 1) {
    setFunctionModule(modules, isFunction, 8, size - 8 + i, ((bits >>> (7 - i)) & 1) === 1);
  }
}

function setupFunctionPatterns(spec: QrVersionSpec): {
  size: number;
  modules: boolean[][];
  isFunction: boolean[][];
} {
  const size = spec.version * 4 + 17;
  const modules = createMatrix(size);
  const isFunction = createMatrix(size);

  drawFinderWithSeparator(modules, isFunction, size, 0, 0);
  drawFinderWithSeparator(modules, isFunction, size, 0, size - 7);
  drawFinderWithSeparator(modules, isFunction, size, size - 7, 0);

  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    setFunctionModule(modules, isFunction, 6, i, dark);
    setFunctionModule(modules, isFunction, i, 6, dark);
  }

  const coords = spec.alignment;
  for (let i = 0; i < coords.length; i += 1) {
    for (let j = 0; j < coords.length; j += 1) {
      const isCorner =
        (i === 0 && j === 0) ||
        (i === 0 && j === coords.length - 1) ||
        (i === coords.length - 1 && j === 0);
      if (!isCorner) {
        drawAlignmentPattern(modules, isFunction, coords[i], coords[j]);
      }
    }
  }

  // Dark module and format/version function reservations
  setFunctionModule(modules, isFunction, size - 8, 8, true);
  drawFormatInfo(modules, isFunction, size, 0);
  drawVersionInfo(modules, isFunction, size, spec.version);

  return { size, modules, isFunction };
}

function placeCodewords(
  modules: boolean[][],
  isFunction: boolean[][],
  size: number,
  codewords: Uint8Array
): void {
  const totalBits = codewords.length * 8;
  let bitIndex = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let offset = 0; offset < 2; offset += 1) {
        const col = right - offset;
        if (isFunction[row][col]) continue;
        let dark = false;
        if (bitIndex < totalBits) {
          const byteVal = codewords[bitIndex >>> 3];
          const bitShift = 7 - (bitIndex & 7);
          dark = ((byteVal >>> bitShift) & 1) === 1;
          bitIndex += 1;
        }
        modules[row][col] = dark;
      }
    }
    upward = !upward;
  }
}

function isMaskMatch(mask: number, r: number, c: number): boolean {
  if (mask === 0) return (r + c) % 2 === 0;
  if (mask === 1) return r % 2 === 0;
  if (mask === 2) return c % 3 === 0;
  if (mask === 3) return (r + c) % 3 === 0;
  if (mask === 4) return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
  if (mask === 5) return ((r * c) % 2) + ((r * c) % 3) === 0;
  if (mask === 6) return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
  return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
}

function applyMask(
  baseModules: boolean[][],
  isFunction: boolean[][],
  size: number,
  mask: number
): boolean[][] {
  const masked = baseModules.map((row) => row.slice());
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (!isFunction[r][c] && isMaskMatch(mask, r, c)) {
        masked[r][c] = !masked[r][c];
      }
    }
  }
  drawFormatInfo(masked, isFunction, size, mask);
  return masked;
}

const FINDER_PENALTY_PATTERNS = [
  [true, false, true, true, true, false, true, false, false, false, false],
  [false, false, false, false, true, false, true, true, true, false, true],
] as const;

function scoreLineRunsAndPatterns(line: boolean[]): number {
  let score = 0;
  let runColor = line[0];
  let runLen = 1;
  for (let i = 1; i < line.length; i += 1) {
    if (line[i] === runColor) {
      runLen += 1;
    } else {
      if (runLen >= 5) score += 3 + (runLen - 5);
      runColor = line[i];
      runLen = 1;
    }
  }
  if (runLen >= 5) score += 3 + (runLen - 5);

  for (let i = 0; i <= line.length - 11; i += 1) {
    for (const pattern of FINDER_PENALTY_PATTERNS) {
      let matched = true;
      for (let k = 0; k < 11; k += 1) {
        if (line[i + k] !== pattern[k]) {
          matched = false;
          break;
        }
      }
      if (matched) score += 40;
    }
  }
  return score;
}

function computePenalty(modules: boolean[][], size: number): number {
  let penalty = 0;
  const colLine = new Array<boolean>(size);
  for (let i = 0; i < size; i += 1) {
    penalty += scoreLineRunsAndPatterns(modules[i]);
    for (let r = 0; r < size; r += 1) colLine[r] = modules[r][i];
    penalty += scoreLineRunsAndPatterns(colLine);
  }

  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const color = modules[r][c];
      if (color === modules[r][c + 1] && color === modules[r + 1][c] && color === modules[r + 1][c + 1]) {
        penalty += 3;
      }
    }
  }

  let darkCount = 0;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (modules[r][c]) darkCount += 1;
    }
  }
  const percent = (darkCount * 100) / (size * size);
  return penalty + Math.floor(Math.abs(percent - 50) / 5) * 10;
}

function modulesToSvgPath(modules: boolean[][], size: number): string {
  const segments: string[] = [];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (modules[r][c]) {
        segments.push(`M${c} ${r}h1v1h-1z`);
      }
    }
  }
  return segments.join('');
}

/**
 * Generates a deterministic ISO/IEC 18004 QR code matrix (Byte mode, EC Level M, Versions 1..=10)
 * and a single compound SVG `<path>` string for crisp vector rendering.
 */
export function generateQrSvgData(text: string): QrMatrixResult {
  const bytes = new TextEncoder().encode(text);
  const spec = selectVersion(bytes.length);
  const codewords = buildInterleavedCodewords(bytes, spec);
  const { size, modules: baseModules, isFunction } = setupFunctionPatterns(spec);

  placeCodewords(baseModules, isFunction, size, codewords);

  let bestPenalty = Number.POSITIVE_INFINITY;
  let bestModules = baseModules;

  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = applyMask(baseModules, isFunction, size, mask);
    const penalty = computePenalty(candidate, size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestModules = candidate;
    }
  }

  return {
    version: spec.version,
    size,
    modules: bestModules,
    svgPath: modulesToSvgPath(bestModules, size),
  };
}
