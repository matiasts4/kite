import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../../types';
import { filterTranscriptForVisibility } from './toolVisibility';

function item(partial: Partial<ChatItem> & Pick<ChatItem, 'id' | 'kind'>): ChatItem {
  return {
    text: '',
    title: null,
    detail: null,
    status: null,
    streaming: false,
    exitCode: null,
    createdAtUnixMs: 0,
    attachments: [],
    ...partial,
  };
}

describe('filterTranscriptForVisibility', () => {
  const items = [
    item({ id: 'u', kind: 'user', text: 'go' }),
    item({ id: 'ok', kind: 'tool', status: 'completed', title: 'Read a.ts' }),
    item({ id: 'bad', kind: 'tool', status: 'failed', title: 'Write b.ts' }),
    item({ id: 'wait', kind: 'tool', status: 'pending', title: 'Run tests' }),
    item({ id: 'err', kind: 'error', text: 'quota' }),
    item({ id: 'mid', kind: 'assistant', text: 'working' }),
    item({ id: 'final', kind: 'assistant', text: 'done' }),
  ];

  it('keeps failed tools, pending approvals, and errors when successful tools are hidden', () => {
    const visible = filterTranscriptForVisibility(items, 'hide-successful').map((row) => row.id);
    expect(visible).toEqual(['u', 'bad', 'wait', 'err', 'mid', 'final']);
  });

  it('hides work rows in Hide all and still renders approvals and errors', () => {
    const visible = filterTranscriptForVisibility(items, 'hide-all').map((row) => row.id);
    expect(visible).toEqual(['u', 'bad', 'wait', 'err', 'mid', 'final']);
  });

  it('keeps only the final assistant reply in Zen', () => {
    const visible = filterTranscriptForVisibility(items, 'zen').map((row) => row.id);
    expect(visible).toContain('final');
    expect(visible).not.toContain('mid');
    expect(visible).toContain('err');
    expect(visible).toContain('wait');
  });
});
