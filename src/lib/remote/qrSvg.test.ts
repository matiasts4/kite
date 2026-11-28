import { describe, expect, it } from 'vitest';
import { generateQrSvgData } from './qrSvg';

function assertFinderAt(modules: boolean[][], topRow: number, leftCol: number): void {
  for (let dr = 0; dr < 7; dr += 1) {
    for (let dc = 0; dc < 7; dc += 1) {
      const expected =
        dr === 0 ||
        dr === 6 ||
        dc === 0 ||
        dc === 6 ||
        (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
      expect(modules[topRow + dr][leftCol + dc]).toBe(expected);
    }
  }
}

function readFormatCopy1(modules: boolean[][]): boolean[] {
  return [
    modules[8][0],
    modules[8][1],
    modules[8][2],
    modules[8][3],
    modules[8][4],
    modules[8][5],
    modules[8][7],
    modules[8][8],
    modules[7][8],
    modules[5][8],
    modules[4][8],
    modules[3][8],
    modules[2][8],
    modules[1][8],
    modules[0][8],
  ];
}

function readFormatCopy2(modules: boolean[][]): boolean[] {
  const size = modules.length;
  return [
    modules[size - 1][8],
    modules[size - 2][8],
    modules[size - 3][8],
    modules[size - 4][8],
    modules[size - 5][8],
    modules[size - 6][8],
    modules[size - 7][8],
    modules[8][size - 8],
    modules[8][size - 7],
    modules[8][size - 6],
    modules[8][size - 5],
    modules[8][size - 4],
    modules[8][size - 3],
    modules[8][size - 2],
    modules[8][size - 1],
  ];
}

describe('generateQrSvgData', () => {
  it('places compliant 7x7 finder patterns, white separators, timing patterns, and dark module at 3 corners', () => {
    const uri = 'kite-remote://pair?v=1&host=192.168.1.42&port=17420&code=482910';
    const qr = generateQrSvgData(uri);
    const { size, modules } = qr;

    expect(modules.length).toBe(size);
    expect(modules.every((row) => row.length === size)).toBe(true);

    // Three 7x7 finder patterns
    assertFinderAt(modules, 0, 0);
    assertFinderAt(modules, 0, size - 7);
    assertFinderAt(modules, size - 7, 0);

    // 1-module white separators
    for (let i = 0; i < 8; i += 1) {
      expect(modules[7][i]).toBe(false);
      expect(modules[i][7]).toBe(false);
      expect(modules[7][size - 8 + i]).toBe(false);
      expect(modules[i][size - 8]).toBe(false);
      expect(modules[size - 8][i]).toBe(false);
      expect(modules[size - 8 + i][7]).toBe(false);
    }

    // Timing patterns on row 6 and col 6
    for (let i = 8; i < size - 8; i += 1) {
      expect(modules[6][i]).toBe(i % 2 === 0);
      expect(modules[i][6]).toBe(i % 2 === 0);
    }

    // Mandatory dark module
    expect(modules[size - 8][8]).toBe(true);

    // Dual format info copies match identically
    expect(readFormatCopy1(modules)).toEqual(readFormatCopy2(modules));
  });

  it('produces strictly deterministic output for identical inputs', () => {
    const uri =
      'kite-remote://pair?v=1&host=192.168.1.10&port=17420&hosts=192.168.1.10,100.64.0.12&code=123456&secret=0123456789abcdef0123456789abcdef&name=DEV-BOX';
    const first = generateQrSvgData(uri);
    const second = generateQrSvgData(uri);

    expect(first.version).toBe(second.version);
    expect(first.size).toBe(second.size);
    expect(first.svgPath).toBe(second.svgPath);
    expect(first.modules).toEqual(second.modules);
  });

  it('scales QR versions cleanly from short strings up to 180+ char kite-remote pairing URIs', () => {
    const shortQr = generateQrSvgData('kite');
    expect(shortQr.version).toBe(1);
    expect(shortQr.size).toBe(21);

    // Version 2 has alignment pattern centered at (18, 18)
    const v2Qr = generateQrSvgData('https://kite.local/pair');
    expect(v2Qr.version).toBe(2);
    expect(v2Qr.size).toBe(25);
    expect(v2Qr.modules[18][18]).toBe(true);
    expect(v2Qr.modules[17][18]).toBe(false);
    expect(v2Qr.modules[16][18]).toBe(true);

    // 185-char pairing URI -> Version 10 (57x57) with matching version info & alignment patterns
    const longUri =
      'kite-remote://pair?v=1&host=192.168.100.145&port=17420&hosts=192.168.100.145,100.101.102.103&code=948271&secret=abcdef0123456789abcdef0123456789&name=WORKSTATION-PRO-PRIMARY-HOST-01';
    expect(longUri.length).toBeGreaterThanOrEqual(180);

    const longQr = generateQrSvgData(longUri);
    expect(longQr.version).toBeGreaterThanOrEqual(9);
    expect(longQr.version).toBeLessThanOrEqual(10);
    expect(longQr.size).toBe(longQr.version * 4 + 17);
    expect(readFormatCopy1(longQr.modules)).toEqual(readFormatCopy2(longQr.modules));

    // Version 10 alignment center at (28, 28) when version === 10
    if (longQr.version === 10) {
      expect(longQr.modules[28][28]).toBe(true);
      expect(longQr.modules[27][28]).toBe(false);
      expect(longQr.modules[26][28]).toBe(true);
    }
  });

  it('emits valid M...h1v1h-1z SVG path tokens matching every dark module', () => {
    const qr = generateQrSvgData('kite-remote://pair?v=1&host=127.0.0.1&port=17420&code=000111');
    expect(qr.svgPath).toMatch(/^(M\d+ \d+h1v1h-1z)+$/);

    const pathSegments = qr.svgPath.match(/M\d+ \d+h1v1h-1z/g) ?? [];
    let darkCount = 0;
    for (const row of qr.modules) {
      for (const cell of row) {
        if (cell) darkCount += 1;
      }
    }
    expect(pathSegments.length).toBe(darkCount);
    expect(qr.svgPath.startsWith('M0 0h1v1h-1z')).toBe(true);
  });

  it('measures capacity in UTF-8 bytes and throws cleanly past Version 10 Level M limit', () => {
    const multiByte = 'á'.repeat(8); // 8 chars, 16 UTF-8 bytes (> V1 14-byte limit)
    expect(generateQrSvgData(multiByte).version).toBe(2);

    const maxV10 = 'a'.repeat(213);
    expect(generateQrSvgData(maxV10).version).toBe(10);

    expect(() => generateQrSvgData('a'.repeat(214))).toThrow(/exceeds Version 10 Level M limit/i);
  });
});
