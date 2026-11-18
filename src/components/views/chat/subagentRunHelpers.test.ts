import { describe, expect, it } from 'vitest';
import type { ChatItem, SubagentRun } from '../../../types';
import { humanizeActivityText, isItemRunning, structuredReportToMarkdown } from './subagentRunHelpers';

const report = JSON.stringify({
  findings: [
    {
      location: 'src/a.rs:10',
      severity: 'warning',
      claim: 'Leaks a handle',
      evidence: ['Read a.rs', 'Checked drop order'],
    },
    { location: 'src/b.rs:2', severity: 'info', claim: 'Fine' },
  ],
});

describe('humanizeActivityText', () => {
  it('keeps ordinary text untouched', () => {
    expect(humanizeActivityText('  Running tests ')).toBe('Running tests');
    expect(humanizeActivityText(null)).toBe('');
  });

  it('summarizes findings reports instead of showing JSON', () => {
    expect(humanizeActivityText(report)).toBe('Reported 2 findings');
  });

  it('never shows truncated JSON', () => {
    expect(humanizeActivityText('{"findings":[{"location":"src-tauri/src/chat/th')).toBe(
      'Returned a structured report',
    );
  });

  it('surfaces the message of a JSON error payload', () => {
    expect(humanizeActivityText('{"error":"quota exceeded"}')).toBe('quota exceeded');
  });
});

describe('structuredReportToMarkdown', () => {
  it('renders findings as a numbered list', () => {
    const md = structuredReportToMarkdown(report) ?? '';
    expect(md).toContain('**Findings (2)**');
    expect(md).toContain('1. **WARNING** · `src/a.rs:10`');
    expect(md).toContain('   Leaks a handle');
    expect(md).toContain('   - Checked drop order');
    expect(md).not.toContain('{"findings"');
  });

  it('pretty-prints other JSON payloads in a code block', () => {
    expect(structuredReportToMarkdown('{"ok":true}')).toBe('```json\n{\n  "ok": true\n}\n```');
  });

  it('leaves ordinary prose alone', () => {
    expect(structuredReportToMarkdown('All checks passed.')).toBeNull();
    expect(structuredReportToMarkdown('{not json')).toBeNull();
  });
});

describe('isItemRunning', () => {
  it('never treats stale item.streaming=true as running when paired run is terminal', () => {
    const staleItem: ChatItem = {
      id: 't_267',
      kind: 'tool',
      text: '',
      title: 'Subagent · Verifier',
      detail: '',
      status: 'failed',
      streaming: true,
      exitCode: null,
      createdAtUnixMs: 1_000,
      attachments: [],
      toolKind: 'subagent',
      subagentMeta: {
        subagentId: 'sub-1',
        action: 'spawn',
        role: 'Verifier',
        status: 'running',
        stepCount: 5,
      },
    };
    const killedRun: SubagentRun = {
      subagentId: 'sub-1',
      parentThreadId: 'parent-1',
      parentToolCallId: 't_267',
      role: 'Verifier',
      status: 'killed',
      stepCount: 5,
      items: [],
      startedAtUnixMs: 1_000,
      updatedAtUnixMs: 2_000,
      completedAtUnixMs: 2_000,
    };
    expect(isItemRunning(staleItem, killedRun)).toBe(false);
    expect(isItemRunning(staleItem, { ...killedRun, status: 'completed' })).toBe(false);
  });
});
