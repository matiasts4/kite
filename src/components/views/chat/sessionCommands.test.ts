import { describe, expect, it } from 'vitest';
import { consumeFreshContext, resolveSessionCommand } from './sessionCommands';

const COMPACT_REFUSAL = 'This provider cannot compact.';

describe('session commands', () => {
  it('asks to compact only when /compact is the whole trimmed message on codex or claude', () => {
    expect(resolveSessionCommand('/compact', 'codex')).toEqual({ kind: 'compact' });
    expect(resolveSessionCommand('  /compact  ', 'claude')).toEqual({ kind: 'compact' });
    expect(resolveSessionCommand('/compact', 'grok')).toEqual({
      kind: 'refuse-compact',
      notice: COMPACT_REFUSAL,
    });
    expect(resolveSessionCommand('/compact', 'opencode')).toEqual({
      kind: 'refuse-compact',
      notice: COMPACT_REFUSAL,
    });
    expect(resolveSessionCommand('/compact', 'cursor')).toEqual({
      kind: 'refuse-compact',
      notice: COMPACT_REFUSAL,
    });
    expect(resolveSessionCommand('please /compact', 'codex')).toEqual({ kind: 'message' });
    expect(resolveSessionCommand('/compact now', 'claude')).toEqual({ kind: 'message' });
    expect(resolveSessionCommand('/Compact', 'codex')).toEqual({ kind: 'message' });
  });

  it('arms /clear only for the whole trimmed message and does not drop earlier messages', () => {
    expect(resolveSessionCommand('/clear', 'grok')).toEqual({
      kind: 'arm-clear',
      dropEarlierMessages: false,
    });
    expect(resolveSessionCommand('  /clear\n', 'codex')).toEqual({
      kind: 'arm-clear',
      dropEarlierMessages: false,
    });
    expect(resolveSessionCommand('later /clear', 'claude')).toEqual({ kind: 'message' });
    expect(resolveSessionCommand('/clear now', 'grok')).toEqual({ kind: 'message' });
    expect(resolveSessionCommand('/clear\n$review', 'grok')).toEqual({ kind: 'message' });
  });

  it('marks one following send as fresh context and then clears the armed flag', () => {
    const consumed = consumeFreshContext(true);
    expect(consumed).toEqual({ freshContext: true, armed: false });
    expect(consumeFreshContext(consumed.armed)).toEqual({ freshContext: false, armed: false });
    expect(consumeFreshContext(false)).toEqual({ freshContext: false, armed: false });
  });
});
