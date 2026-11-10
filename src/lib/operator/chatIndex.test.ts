import { describe, expect, it } from 'vitest';
import { consultChats, type ChatIndexEntry, type ChatReader } from './chatIndex';

const TRANSCRIPT_MARKER = 'FULL-TRANSCRIPT-BODY-SHOULD-NOT-LEAK';
const LONG_DECISION = `Ship the invoice fix.\n${'y'.repeat(400)}`;

const catalog: { entries: ChatIndexEntry[] } = {
  entries: [
    {
      id: 'billing-1',
      title: 'Billing',
      cli: 'codex',
      lastDecision: LONG_DECISION,
    },
    {
      id: 'auth-2',
      title: 'Auth',
      cli: 'claude-code',
      lastDecision: 'Keep the session cookie.',
    },
    {
      id: 'grok-3',
      title: 'Launch notes',
      cli: 'grok',
      lastDecision: 'Use the existing orb.',
    },
    {
      id: 'grok-4',
      title: 'Quota notes',
      cli: 'grok',
      lastDecision: 'Stay on the current account.',
    },
  ],
};

function readerTracking(bodies: Record<string, string | Error>): { reader: ChatReader; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    reader: {
      read(id: string) {
        calls.push(id);
        const body = bodies[id];
        if (body instanceof Error) throw body;
        if (body === undefined) throw new Error(`unexpected read ${id}`);
        return body;
      },
    },
  };
}

describe('consultChats', () => {
  it('gives a normal question the index and does not read any transcript', async () => {
    const { reader, calls } = readerTracking({
      'billing-1': `billing ${TRANSCRIPT_MARKER}`,
      'auth-2': `auth ${TRANSCRIPT_MARKER}`,
      'grok-3': `grok ${TRANSCRIPT_MARKER}`,
      'grok-4': `quota ${TRANSCRIPT_MARKER}`,
    });

    const reach = await consultChats('Open two terminals', catalog, reader);

    expect(calls).toEqual([]);
    expect(reach.kind).toBe('index');
    if (reach.kind !== 'index') return;
    expect(reach.entries).toEqual([
      {
        id: 'billing-1',
        title: 'Billing',
        cli: 'codex',
        lastDecision: 'Ship the invoice fix.',
      },
      {
        id: 'auth-2',
        title: 'Auth',
        cli: 'claude-code',
        lastDecision: 'Keep the session cookie.',
      },
      {
        id: 'grok-3',
        title: 'Launch notes',
        cli: 'grok',
        lastDecision: 'Use the existing orb.',
      },
      {
        id: 'grok-4',
        title: 'Quota notes',
        cli: 'grok',
        lastDecision: 'Stay on the current account.',
      },
    ]);
    expect(reach.entries.every((entry) => !('body' in entry))).toBe(true);
    expect(reach.text).toContain('Billing');
    expect(reach.text).toContain('codex');
    expect(reach.text).toContain('Ship the invoice fix.');
    expect(reach.text).not.toContain(TRANSCRIPT_MARKER);
    expect(reach.text).not.toContain('y'.repeat(40));
    expect(reach.text).not.toContain('\n');
  });

  it('reads the one named chat and no other', async () => {
    const { reader, calls } = readerTracking({
      'billing-1': `billing body ${TRANSCRIPT_MARKER}`,
      'auth-2': `auth body ${TRANSCRIPT_MARKER}`,
      'grok-3': `grok body ${TRANSCRIPT_MARKER}`,
      'grok-4': `quota body ${TRANSCRIPT_MARKER}`,
    });

    const reach = await consultChats('Review the inside of the billing chat', catalog, reader);

    expect(calls).toEqual(['billing-1']);
    expect(reach.kind).toBe('read');
    if (reach.kind !== 'read') return;
    expect(reach.entry).toEqual({
      id: 'billing-1',
      title: 'Billing',
      cli: 'codex',
      lastDecision: 'Ship the invoice fix.',
    });
    expect(reach.body).toBe(`billing body ${TRANSCRIPT_MARKER}`);
    expect(reach.text).toContain('Billing');
    expect(reach.text).toContain(`billing body ${TRANSCRIPT_MARKER}`);
    expect(reach.text).not.toContain('auth body');
    expect(reach.text).not.toContain('Keep the session cookie.');
  });

  it('says when nothing matches and does not read the catalog', async () => {
    const { reader, calls } = readerTracking({
      'billing-1': `billing ${TRANSCRIPT_MARKER}`,
      'auth-2': `auth ${TRANSCRIPT_MARKER}`,
      'grok-3': `grok ${TRANSCRIPT_MARKER}`,
      'grok-4': `quota ${TRANSCRIPT_MARKER}`,
    });

    const reach = await consultChats('Review the inside of the payroll chat', catalog, reader);

    expect(calls).toEqual([]);
    expect(reach.kind).toBe('miss');
    if (reach.kind !== 'miss') return;
    expect(reach.named).toBe('payroll');
    expect(reach.text).toBe('No matching chat for "payroll".');
    expect(reach.text).not.toContain(TRANSCRIPT_MARKER);
    expect(reach.text).not.toContain('Keep the session cookie.');
  });

  it('names the chat when the one read fails and does not read the rest', async () => {
    const { reader, calls } = readerTracking({
      'billing-1': new Error('disk offline'),
      'auth-2': `auth ${TRANSCRIPT_MARKER}`,
      'grok-3': `grok ${TRANSCRIPT_MARKER}`,
      'grok-4': `quota ${TRANSCRIPT_MARKER}`,
    });

    const reach = await consultChats('Review the inside of the billing chat', catalog, reader);

    expect(calls).toEqual(['billing-1']);
    expect(reach.kind).toBe('read-failed');
    if (reach.kind !== 'read-failed') return;
    expect(reach.entry.id).toBe('billing-1');
    expect(reach.entry.title).toBe('Billing');
    expect(reach.text).toBe('Could not read "Billing" (billing-1): disk offline');
    expect(reach.text).not.toContain(TRANSCRIPT_MARKER);
    expect(reach.text).not.toContain('Keep the session cookie.');
  });

  it('does not read when more than one chat matches', async () => {
    const { reader, calls } = readerTracking({
      'billing-1': `billing ${TRANSCRIPT_MARKER}`,
      'auth-2': `auth ${TRANSCRIPT_MARKER}`,
      'grok-3': `grok ${TRANSCRIPT_MARKER}`,
      'grok-4': `quota ${TRANSCRIPT_MARKER}`,
    });

    const reach = await consultChats('Review the grok chat', catalog, reader);

    expect(calls).toEqual([]);
    expect(reach.kind).toBe('not-one');
    if (reach.kind !== 'not-one') return;
    expect(reach.text).toBe('More than one chat matches. Not reading them.');
    expect(reach.text).not.toContain(TRANSCRIPT_MARKER);
  });
});
