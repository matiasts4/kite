export const EFFORT_BAR_PITCH = 4;
export const EFFORT_BAR_WIDTH = 2;
export const EFFORT_GLYPH_HEIGHT = 14;

const NAMED = new Set(['max', 'ultra']);

export function effortBarHeights(levelCount: number): number[] {
  const count = Math.max(0, levelCount);
  return Array.from({ length: count }, (_, index) => {
    if (count === 1) return 8;
    const step = (EFFORT_GLYPH_HEIGHT - 4) / (count - 1);
    return Math.round(4 + step * index);
  });
}

export function resolveEffortGlyph(levels: string[], selected: string | null) {
  const ordinary = levels.filter((level) => !NAMED.has(level.toLowerCase()));
  const bars = ordinary.length >= 2 ? ordinary : levels;
  const selectedIndex = Math.max(
    0,
    bars.findIndex((level) => level.toLowerCase() === (selected ?? '').toLowerCase())
  );
  const named = levels.find((level) => NAMED.has(level.toLowerCase()) && level.toLowerCase() === (selected ?? '').toLowerCase());
  return {
    disabled: levels.length < 2,
    reason: levels.length < 2 ? 'does not advertise reasoning effort levels.' : null,
    heights: effortBarHeights(bars.length),
    filledUntil: selectedIndex,
    namedLabel: named ?? null,
  };
}
