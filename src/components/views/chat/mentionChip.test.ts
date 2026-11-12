import { describe, expect, it } from 'vitest';
import { CITATION_START, decodeCitation, deleteCitationKey, encodeCitation } from './citationChip';
import {
  deleteComposerChipKey,
  deleteMentionKey,
  encodeMention,
  expandMentions,
  filterMentionMenu,
  insertDropAtCaret,
  insertMentionAtCaret,
  insertThreadReference,
  mentionClipboard,
  mentionFromDrop,
  mentionFromTerminalExcerpt,
  mentionQueryAt,
  terminalExcerptLabel,
} from './mentionChip';

const FILE_MIME = 'application/x-kite-files-entry';
const THREAD_MIME = 'application/x-kite-thread';
const TERMINAL_LABEL = 'Terminal 1 \u00B7 lines 12\u201328';

describe('mention chips', () => {
  it('filters files, thread titles, and model names, and defaults missing lists to empty', () => {
    const sources = {
      files: ['src/main.rs', 'README.md'],
      threads: [
        { id: 'auth-1', title: 'Auth flow' },
        { id: 'bill-2', title: 'Billing' },
      ],
      models: ['gpt-5', 'claude-sonnet'],
    };

    expect(filterMentionMenu('', sources).map((row) => row.menuLabel)).toEqual([
      'src/main.rs',
      'README.md',
      'Auth flow',
      'Billing',
      'gpt-5',
      'claude-sonnet',
    ]);
    expect(filterMentionMenu('src', sources).map((row) => row.id)).toEqual(['src/main.rs']);
    expect(filterMentionMenu('auth', sources)).toEqual([
      { kind: 'thread', id: 'auth-1', label: 'auth-1', menuLabel: 'Auth flow' },
    ]);
    expect(filterMentionMenu('GPT', sources).map((row) => row.id)).toEqual(['gpt-5']);
    expect(filterMentionMenu('missing', sources)).toEqual([]);
    expect(filterMentionMenu('src')).toEqual([]);
    expect(filterMentionMenu('src', {})).toEqual([]);
    expect(filterMentionMenu('src', { files: undefined, threads: undefined, models: undefined })).toEqual([]);
  });

  it('inserts a thread reference chip and returns the same thread list', () => {
    const threads = Object.freeze([{ id: 'auth-1', title: 'Auth flow' }]);
    const before = threads.map((thread) => ({ ...thread }));
    const next = insertThreadReference(threads, 'see ', 4, 4, { id: 'auth-1', title: 'Auth flow' });
    const token = next.text.slice(4, next.caret);

    expect(next.threads).toBe(threads);
    expect(next.threads[0]).toBe(threads[0]);
    expect(threads).toEqual(before);
    expect(next.text.startsWith('see ')).toBe(true);
    expect(next.text).not.toContain('@auth-1');
    expect(next.text).not.toContain('@Auth');
    expect(token.startsWith('\u{E002}')).toBe(true);
    expect(token).not.toContain(CITATION_START);
    expect(decodeCitation(token)).toBeNull();
    expect(expandMentions(token)).toBe('[auth-1](thread:auth-1)');
  });

  it('inserts a dropped file or thread chip at the caret instead of a bare @path', () => {
    const file = insertDropAtCaret(
      'Hello world',
      6,
      6,
      FILE_MIME,
      JSON.stringify({ relativePath: 'src/main.rs' }),
    );
    expect(file).not.toBeNull();
    expect(file?.text.startsWith('Hello ')).toBe(true);
    expect(file?.text.endsWith('world')).toBe(true);
    expect(file?.text).not.toContain('@src/main.rs');
    expect(expandMentions(file?.text ?? '')).toBe('Hello [src/main.rs](src/main.rs)world');

    const tree = mentionFromDrop(
      FILE_MIME,
      JSON.stringify({ workspaceId: 'ws', resourceId: 'res', entryId: 'src/lib.rs' }),
    );
    expect(tree).toEqual({ kind: 'file', id: 'src/lib.rs', label: 'src/lib.rs' });

    const thread = insertDropAtCaret('Note', 4, 4, THREAD_MIME, 'auth-1');
    expect(thread?.text).not.toContain('@auth-1');
    expect(expandMentions(thread?.text ?? '')).toBe('Note[auth-1](thread:auth-1)');
    expect(insertDropAtCaret('Hello', 1, 1, 'text/plain', 'src/main.rs')).toBeNull();
  });

  it('removes a mention chip with one Backspace or Delete and leaves a citation chip on that path', () => {
    const inserted = insertMentionAtCaret('Hello world', 6, 6, {
      kind: 'file',
      id: 'src/main.rs',
      label: 'src/main.rs',
    });

    expect(deleteMentionKey(inserted.text, inserted.caret, inserted.caret, 'Backspace')).toEqual({
      text: 'Hello world',
      caret: 6,
    });
    expect(deleteMentionKey(inserted.text, 6, 6, 'Delete')).toEqual({
      text: 'Hello world',
      caret: 6,
    });
    expect(deleteComposerChipKey(inserted.text, inserted.caret, inserted.caret, 'Backspace')).toEqual({
      text: 'Hello world',
      caret: 6,
    });

    const citation = insertMentionAtCaret('Hello world', 0, 0, {
      kind: 'model',
      id: 'gpt-5',
      label: 'gpt-5',
    });
    const quoted = `${citation.text}${encodeCitation({ messageId: 'm', quote: 'the patch', comment: '' })}`;
    const citationOnly = encodeCitation({ messageId: 'm', quote: 'the patch', comment: '' });
    const wrapped = `Hello ${citationOnly} world`;
    expect(deleteComposerChipKey(wrapped, 6 + citationOnly.length, 6 + citationOnly.length, 'Backspace')).toEqual(
      deleteCitationKey(wrapped, 6 + citationOnly.length, 6 + citationOnly.length, 'Backspace'),
    );
    expect(quoted).toContain('\u{E002}');
  });

  it('keeps the mention token in app and serializes a markdown link outside', () => {
    const token = encodeMention({ kind: 'model', id: 'gpt-5', label: 'gpt-5' });
    const draft = `Use ${token} please`;
    const copied = mentionClipboard(draft);

    expect(copied.inApp).toBe(draft);
    expect(copied.inApp).toContain(token);
    expect(copied.external).toBe('Use [gpt-5](model:gpt-5) please');
    expect(copied.external).not.toContain('\u{E002}');
    expect(copied.external).not.toContain(token);
    expect(expandMentions(copied.external)).toBe(copied.external);
  });

  it('labels a terminal excerpt Terminal 1 · lines 12–28', () => {
    expect(terminalExcerptLabel({ terminalId: '1', startLine: 12, endLine: 28 })).toBe(TERMINAL_LABEL);
    expect(
      terminalExcerptLabel({ terminalId: 'term-a', label: 'Terminal 1', startLine: 12, endLine: 28 }),
    ).toBe(TERMINAL_LABEL);

    const mention = mentionFromTerminalExcerpt({ terminalId: '1', startLine: 12, endLine: 28 });
    expect(mention).toEqual({
      kind: 'terminal',
      id: '1',
      label: '',
      startLine: 12,
      endLine: 28,
    });
    const token = encodeMention(mention!);
    expect(expandMentions(token)).toBe(`[${TERMINAL_LABEL}](terminal:1#L12-L28)`);
    expect(mentionFromTerminalExcerpt({ terminalId: '', startLine: 12, endLine: 28 })).toBeNull();
    expect(mentionFromTerminalExcerpt(null)).toBeNull();
  });

  it('reads an @ query only when @ starts a token', () => {
    expect(mentionQueryAt('see @src', 8)).toEqual({ start: 4, query: 'src' });
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQueryAt('email@domain', 12)).toBeNull();
    const replaced = insertMentionAtCaret('see @src please', 4, 8, {
      kind: 'file',
      id: 'src/main.rs',
      label: 'src/main.rs',
    });
    expect(replaced.text.startsWith('see ')).toBe(true);
    expect(replaced.text.endsWith(' please')).toBe(true);
    expect(replaced.text).not.toContain('@src');
  });
});
