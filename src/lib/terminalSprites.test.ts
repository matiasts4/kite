import { describe, it, expect, vi } from 'vitest';
import { isProceduralSpriteChar, drawProceduralSprite } from './terminalSprites';

describe('terminalSprites', () => {
  it('correctly identifies Box Drawing, Block Elements, Record Dot, Powerline, and Braille characters', () => {
    // Box Drawing
    expect(isProceduralSpriteChar('─'.charCodeAt(0))).toBe(true);
    expect(isProceduralSpriteChar('│'.charCodeAt(0))).toBe(true);
    expect(isProceduralSpriteChar('┌'.charCodeAt(0))).toBe(true);
    expect(isProceduralSpriteChar('╭'.charCodeAt(0))).toBe(true);
    expect(isProceduralSpriteChar('┄'.charCodeAt(0))).toBe(true);
    expect(isProceduralSpriteChar('╔'.charCodeAt(0))).toBe(true);

    // Block Elements
    expect(isProceduralSpriteChar('█'.charCodeAt(0))).toBe(true);
    expect(isProceduralSpriteChar('▀'.charCodeAt(0))).toBe(true);
    expect(isProceduralSpriteChar('▄'.charCodeAt(0))).toBe(true);
    expect(isProceduralSpriteChar('░'.charCodeAt(0))).toBe(true);

    // Record Dot & Powerline
    expect(isProceduralSpriteChar(0x23fa)).toBe(true);
    expect(isProceduralSpriteChar(0xe0b0)).toBe(true);

    // Braille Patterns
    expect(isProceduralSpriteChar('⠋'.charCodeAt(0))).toBe(true);
    expect(isProceduralSpriteChar('⠹'.charCodeAt(0))).toBe(true);
    expect(isProceduralSpriteChar(0x28ff)).toBe(true);

    // Normal ASCII & Unicode text
    expect(isProceduralSpriteChar('A'.charCodeAt(0))).toBe(false);
    expect(isProceduralSpriteChar('z'.charCodeAt(0))).toBe(false);
    expect(isProceduralSpriteChar('0'.charCodeAt(0))).toBe(false);
    expect(isProceduralSpriteChar(' '.charCodeAt(0))).toBe(false);
    expect(isProceduralSpriteChar('🚀'.codePointAt(0)!)).toBe(false);
  });

  it('draws procedural box, rounded corner, double line, block, and braille sprites onto a canvas 2d context', () => {
    const mockCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      bezierCurveTo: vi.fn(),
      closePath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      lineCap: 'butt',
      globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D;

    // 1. Box corner
    const drawnCorner = drawProceduralSprite(
      mockCtx,
      '┌'.charCodeAt(0),
      0,
      0,
      10,
      20,
      '#ffffff',
      1.25
    );
    expect(drawnCorner).toBe(true);
    expect(mockCtx.fillRect).toHaveBeenCalled();

    // 2. Rounded corner
    vi.clearAllMocks();
    const drawnRounded = drawProceduralSprite(
      mockCtx,
      '╭'.charCodeAt(0),
      0,
      0,
      10,
      20,
      '#ffffff',
      1.25
    );
    expect(drawnRounded).toBe(true);
    expect(mockCtx.bezierCurveTo).toHaveBeenCalled();
    expect(mockCtx.stroke).toHaveBeenCalled();

    // 3. Full block
    vi.clearAllMocks();
    const drawnBlock = drawProceduralSprite(
      mockCtx,
      '█'.charCodeAt(0),
      0,
      0,
      10,
      20,
      '#00ff00',
      1
    );
    expect(drawnBlock).toBe(true);
    expect(mockCtx.fillRect).toHaveBeenCalledWith(0, 0, 10, 20);

    // 4. Braille spinner
    vi.clearAllMocks();
    const drawnBraille = drawProceduralSprite(
      mockCtx,
      '⠋'.charCodeAt(0),
      0,
      0,
      10,
      20,
      '#5c8fff',
      1
    );
    expect(drawnBraille).toBe(true);
    expect(mockCtx.fillRect).toHaveBeenCalled();

    // 5. Non-sprite char
    const drawnAscii = drawProceduralSprite(
      mockCtx,
      'A'.charCodeAt(0),
      0,
      0,
      10,
      20,
      '#ffffff',
      1
    );
    expect(drawnAscii).toBe(false);
  });
});
