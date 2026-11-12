import { describe, expect, it } from 'vitest';
import { normalizeSessionFrames, projectSession, type SessionFrame } from './projection';
import { SESSION_LIFECYCLES } from './types';

const CONTEXT = { provider: 'codex', schema: 'chat-session-v1' };

function fold(frames: SessionFrame[]) {
  return projectSession('thread-1', normalizeSessionFrames(frames, CONTEXT));
}

describe('session projection', () => {
  it('folds the same events twice into the same projection', () => {
    const frames: SessionFrame[] = [
      {
        sequence: 1,
        kind: 'started',
        atUnixMs: 1000,
        payload: {
          binding: {
            driver: 'codex',
            provider: 'codex',
            model: 'gpt-5',
            connectionId: 'conn-1',
          },
        },
      },
      { sequence: 2, kind: 'text', atUnixMs: 1001, payload: { itemId: 'answer', text: 'Hello' } },
      { sequence: 3, kind: 'text', atUnixMs: 1002, payload: { itemId: 'answer', text: ' world' } },
      { sequence: 4, kind: 'reasoning', atUnixMs: 1003, payload: { itemId: 'thought', text: 'Checking the tests.' } },
      {
        sequence: 5,
        kind: 'tool',
        atUnixMs: 1004,
        payload: {
          itemId: 'tool-1',
          toolName: 'shell',
          title: 'Run tests',
          status: 'completed',
          command: 'npm test',
          durationSeconds: 12,
        },
      },
      {
        sequence: 6,
        kind: 'plan',
        atUnixMs: 1005,
        payload: { plan: { id: 'plan-1', revision: 1, markdown: '# Plan', status: 'ready' } },
      },
      {
        sequence: 7,
        kind: 'approvalOpened',
        atUnixMs: 1006,
        payload: { requestId: 'req-1', kind: 'fileChange', title: 'Write file', risk: 'low', impact: 'One file' },
      },
      { sequence: 8, kind: 'approvalResolved', atUnixMs: 1007, payload: { requestId: 'req-1', decision: 'allowOnce' } },
      { sequence: 9, kind: 'usage', atUnixMs: 1008, payload: { inputTokens: 120, outputTokens: 30, costUsd: 0.02 } },
      { sequence: 10, kind: 'notice', atUnixMs: 1009, payload: { text: 'Stream ended.' } },
      { sequence: 11, kind: 'unknown-frame', atUnixMs: 1010, payload: { blob: 'x'.repeat(600) } },
    ];

    const normalized = normalizeSessionFrames(frames, CONTEXT);
    const first = projectSession('thread-1', normalized);
    const second = projectSession('thread-1', normalized);

    expect(first).toEqual(second);
    expect(first.items.map((item) => item.kind)).toEqual(['assistant', 'reasoning', 'tool', 'note', 'note']);
    expect(first.items[0].text).toBe('Hello world');
    expect(first.binding).toMatchObject({ driver: 'codex', model: 'gpt-5', connectionId: 'conn-1' });
    expect(first.plan?.id).toBe('plan-1');
    expect(first.pendingApprovals).toEqual([]);
    expect(first.approvalResolutions).toHaveLength(1);
    expect(first.usage).toEqual({ inputTokens: 120, outputTokens: 30, costUsd: 0.02 });
    expect(first.lifecycle).toBe('running');
    expect(first.lastSequence).toBe(11);
    expect(first.unknownEventCount).toBe(1);

    // The fold never mutates the events it receives, and it orders by sequence.
    expect(frames[1].payload).toEqual({ itemId: 'answer', text: 'Hello' });
    expect(projectSession('thread-1', [...normalized].reverse())).toEqual(first);
  });

  it('projects every lifecycle state', () => {
    for (const lifecycle of SESSION_LIFECYCLES) {
      const projection = fold([{ sequence: 1, kind: 'status', payload: { lifecycle } }]);
      expect(projection.lifecycle).toBe(lifecycle);
    }

    expect(projectSession('thread-1', []).lifecycle).toBe('creating');
  });

  it('turns an unknown event into a bounded notice with provider and schema metadata', () => {
    const projection = fold([
      { sequence: 1, kind: `mystery-${'k'.repeat(500)}`, payload: { blob: 'x'.repeat(10_000) } },
    ]);

    expect(projection.items).toHaveLength(1);
    const notice = projection.items[0];
    expect(notice.kind).toBe('note');
    expect(notice.text).toContain('codex');
    expect(notice.text).toContain('chat-session-v1');
    expect(notice.text.length).toBeLessThanOrEqual(512);
    expect(projection.unknownEventCount).toBe(1);
  });

  it('maps text, reasoning, tools, plans and errors onto the existing chat item shape', () => {
    const projection = fold([
      { sequence: 1, kind: 'text', payload: { itemId: 'answer', text: 'Hi', streaming: true } },
      { sequence: 2, kind: 'reasoning', payload: { itemId: 'thought', text: 'Thinking' } },
      {
        sequence: 3,
        kind: 'tool',
        payload: {
          itemId: 'tool-1',
          toolName: 'shell',
          title: 'Run tests',
          status: 'completed',
          command: 'npm test',
          filePath: 'src/app.ts',
          addedLines: 3,
          removedLines: 1,
          durationSeconds: 9,
        },
      },
      {
        sequence: 4,
        kind: 'plan',
        payload: { plan: { id: 'plan-1', revision: 2, markdown: '# Plan', status: 'implementing' } },
      },
      { sequence: 5, kind: 'error', payload: { text: 'The provider stopped.', title: 'Provider error' } },
    ]);

    expect(projection.items).toHaveLength(4);
    const [assistant, reasoning, tool, error] = projection.items;
    expect(assistant).toMatchObject({
      kind: 'assistant',
      text: 'Hi',
      streaming: true,
      title: null,
      detail: null,
      status: null,
      exitCode: null,
      attachments: [],
      createdAtUnixMs: 0,
    });
    expect(reasoning).toMatchObject({ kind: 'reasoning', text: 'Thinking' });
    expect(tool).toMatchObject({
      kind: 'tool',
      toolName: 'shell',
      title: 'Run tests',
      status: 'completed',
      command: 'npm test',
      filePath: 'src/app.ts',
      addedLines: 3,
      removedLines: 1,
      durationSeconds: 9,
    });
    expect(error).toMatchObject({ kind: 'error', text: 'The provider stopped.', title: 'Provider error' });
    expect(projection.plan).toEqual({ id: 'plan-1', revision: 2, markdown: '# Plan', status: 'implementing' });
    expect(projection.lifecycle).toBe('failed');
  });

  it('keeps approvals out of the transcript and ignores an unknown resolution', () => {
    const waiting = fold([
      { sequence: 1, kind: 'approvalOpened', payload: { requestId: 'req-1', kind: 'fileChange' } },
      { sequence: 2, kind: 'approvalResolved', payload: { requestId: 'req-other', decision: 'deny' } },
    ]);

    expect(waiting.lifecycle).toBe('waiting');
    expect(waiting.pendingApprovals).toHaveLength(1);
    expect(waiting.pendingApprovals[0].id).toBe('req-1');
    expect(waiting.approvalResolutions).toHaveLength(0);
    expect(waiting.items).toHaveLength(0);

    const denied = fold([
      { sequence: 1, kind: 'approvalOpened', payload: { requestId: 'req-1', kind: 'fileChange' } },
      { sequence: 2, kind: 'approvalResolved', payload: { requestId: 'req-1', decision: 'denyAndStop' } },
    ]);

    expect(denied.pendingApprovals).toHaveLength(0);
    expect(denied.lifecycle).toBe('interrupted');
  });

  it('projects a provider exit as completed, failed or resumable from the reported state', () => {
    expect(fold([{ sequence: 1, kind: 'exited', payload: { state: 'resumable' } }]).lifecycle).toBe('resumable');
    expect(fold([{ sequence: 1, kind: 'exited', payload: { code: 0 } }]).lifecycle).toBe('completed');

    const failed = fold([{ sequence: 1, kind: 'exited', payload: { code: 1, error: 'CLI is signed out.' } }]);
    expect(failed.lifecycle).toBe('failed');
    expect(failed.items[0]).toMatchObject({ kind: 'error', text: 'CLI is signed out.' });
  });
});
