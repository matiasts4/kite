import { insertCitationAtCaret, type CitationInput } from './citationChip';

/** Inserts an atomic citation chip at the caret. A string detail is a quote with no source id. */
export function insertQuoteAtCaret(
  draft: string,
  start: number,
  end: number,
  passage: CitationInput,
): { text: string; caret: number } {
  return insertCitationAtCaret(draft, start, end, passage);
}
