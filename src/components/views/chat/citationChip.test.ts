import { describe, expect, it } from 'vitest';
import { canSendDraft, DRAFT_CHAR_LIMIT } from './threadInteraction';
import {
  citationChipLabel,
  citationSendLength,
  clipboardChannels,
  deleteCitationKey,
  decodeCitation,
  encodeCitation,
  expandCitations,
  insertCitationAtCaret,
  readableQuoteWithoutSource,
} from './citationChip';

const passage = { messageId: 'a1', quote: 'the patch', comment: '' };

describe('assistant citation chips', () => {
  it('inserts an atomic citation at the caret instead of a markdown quote dump', () => {
    const next = insertCitationAtCaret('Hello world', 6, 6, passage);
    const token = next.text.slice(6, next.caret);

    expect(next.text.startsWith('Hello ')).toBe(true);
    expect(next.text.endsWith('world')).toBe(true);
    expect(next.text).not.toContain('> the patch');
    expect(next.caret).toBe(6 + token.length);
    expect(expandCitations(token)).toBe('> the patch');

    const fromString = insertCitationAtCaret('Hello world', 6, 6, 'the patch');
    expect(expandCitations(fromString.text.slice(6, fromString.caret))).toBe('> the patch');
    expect(fromString.text).not.toContain('> the patch');
    expect(decodeCitation(fromString.text.slice(6, fromString.caret))).toEqual({
      messageId: '',
      quote: 'the patch',
      comment: '',
    });
  });

  it('removes the whole chip with one Backspace or Delete', () => {
    const inserted = insertCitationAtCaret('Hello world', 6, 6, 'the patch');

    expect(deleteCitationKey(inserted.text, inserted.caret, inserted.caret, 'Backspace')).toEqual({
      text: 'Hello world',
      caret: 6,
    });
    expect(deleteCitationKey(inserted.text, 6, 6, 'Delete')).toEqual({
      text: 'Hello world',
      caret: 6,
    });

    const inside = deleteCitationKey(inserted.text, inserted.caret - 2, inserted.caret - 2, 'Backspace');
    expect(inside).toEqual({ text: 'Hello world', caret: 6 });
    expect(inside?.text).not.toContain('\u{E000}');
  });

  it('shows the comment in place of the quote preview', () => {
    const quote = 'Ship the timer before the summary.';
    expect(citationChipLabel({ quote, comment: '' })).toContain('Ship the timer');
    expect(citationChipLabel({ quote, comment: 'check this' })).toBe('check this');
    expect(citationChipLabel({ quote, comment: 'check this' })).not.toContain('Ship the timer');
  });

  it('keeps the token for an in-app copy and serializes markdown outside Kite', () => {
    const token = encodeCitation({
      messageId: 'a2',
      quote: 'line one\nline two',
      comment: 'look here',
    });
    const draft = `See ${token} please`;
    const copied = clipboardChannels(draft);

    expect(copied.inApp).toBe(draft);
    expect(copied.inApp).toContain(token);
    expect(copied.external).toBe('See > line one\n> line two\nlook here please');
    expect(copied.external).not.toContain('\u{E000}');
    expect(copied.external).not.toContain(token);
  });

  it('expands a citation to the quoted words plus the comment, and a second pass changes nothing', () => {
    const token = encodeCitation({
      messageId: 'a2',
      quote: 'line one\nline two',
      comment: 'look here',
    });
    const once = expandCitations(`before ${token} after`);

    expect(once).toBe('before > line one\n> line two\nlook here after');
    expect(expandCitations(once)).toBe(once);
    expect(expandCitations(encodeCitation({ messageId: 'a', quote: 'only words', comment: '' }))).toBe(
      '> only words',
    );
  });

  it('counts the expanded words toward 120000, not the token', () => {
    const token = encodeCitation({ messageId: 'm', quote: 'quoted words', comment: 'a note' });
    const expanded = expandCitations(token);
    expect(expanded).toBe('> quoted words\na note');
    expect(token.length).toBeGreaterThan(expanded.length);

    const atLimit = token + 'x'.repeat(DRAFT_CHAR_LIMIT - expanded.length);
    expect(citationSendLength(atLimit)).toBe(DRAFT_CHAR_LIMIT);
    expect(canSendDraft(citationSendLength(atLimit))).toBe(true);
    expect(canSendDraft(citationSendLength(`${atLimit}x`))).toBe(false);
    expect(atLimit.length).toBeGreaterThan(DRAFT_CHAR_LIMIT);
    expect(canSendDraft(atLimit.length)).toBe(false);
    expect(citationSendLength(expanded)).toBe(expanded.length);
  });

  it('leaves the saved quote readable when the source id is missing', () => {
    expect(readableQuoteWithoutSource({ messageId: '', quote: 'saved passage' })).toBe('saved passage');
    expect(readableQuoteWithoutSource({ messageId: 'gone', quote: 'saved passage' }, false)).toBe(
      'saved passage',
    );
  });
});
