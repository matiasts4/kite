/** Inserts a quoted passage into a draft at the caret. The rest of the draft stays. */
export function insertQuoteAtCaret(
  draft: string,
  start: number,
  end: number,
  passage: string,
): { text: string; caret: number } {
  const body = passage.trim();
  if (!body) return { text: draft, caret: Math.max(0, Math.min(start, draft.length)) };
  const quote = body
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
  const block = `${quote}\n`;
  const safeStart = Math.max(0, Math.min(start, draft.length));
  const safeEnd = Math.max(safeStart, Math.min(end, draft.length));
  return {
    text: draft.slice(0, safeStart) + block + draft.slice(safeEnd),
    caret: safeStart + block.length,
  };
}
