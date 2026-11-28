import { describe, expect, it } from 'vitest';
import type { ChatItem, SubagentRun } from '../../../types';
import {
  dedupeSubagentRuns,
  extractStartedChildThreadId,
  humanizeActivityText,
  isHookBlockedInvokeNoise,
  isItemFailed,
  isItemRunning,
  isSuppressedSubagentNoiseItem,
  isWaitTimeoutReceiptText,
  matchSubagentRun,
  structuredReportToMarkdown,
} from './subagentRunHelpers';
import { groupTranscriptRows } from './chatItemHelpers';

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

describe('dedupeSubagentRuns and matchSubagentRun parallel collision recovery', () => {
  it('collapses a 0-step running dispatch-subagent duplicate into the completed multi-step run regardless of order', () => {
    const ghostRunningFirst: SubagentRun = {
      subagentId: '0624eee8-fd28-464b-8ee7-c57a763d1c84',
      parentThreadId: 'parent-1',
      parentToolCallId: 'dispatch-subagent-0624eee8-fd28-464b-8ee7-c57a763d1c84',
      childThreadId: '0624eee8-fd28-464b-8ee7-c57a763d1c84',
      role: 'T3 Consultative Argos Brain Writer',
      status: 'running',
      stepCount: 0,
      items: [],
      startedAtUnixMs: 1_010,
      updatedAtUnixMs: 1_010,
    };
    const completedRealSecond: SubagentRun = {
      subagentId: '0624eee8-fd28-464b-8ee7-c57a763d1c84',
      parentThreadId: 'parent-1',
      parentToolCallId: 't_7301502a_293',
      childThreadId: '0624eee8-fd28-464b-8ee7-c57a763d1c84',
      role: 'T3 Consultative Argos Brain Writer',
      status: 'completed',
      stepCount: 167,
      latestActivity: 'All tests passed',
      items: [],
      startedAtUnixMs: 1_000,
      updatedAtUnixMs: 2_000,
      completedAtUnixMs: 2_000,
    };

    const dedupedA = dedupeSubagentRuns([ghostRunningFirst, completedRealSecond]);
    expect(dedupedA).toHaveLength(1);
    expect(dedupedA[0]?.status).toBe('completed');
    expect(dedupedA[0]?.stepCount).toBe(167);
    expect(dedupedA[0]?.parentToolCallId).toBe('t_7301502a_293');

    const dedupedB = dedupeSubagentRuns([completedRealSecond, ghostRunningFirst]);
    expect(dedupedB).toHaveLength(1);
    expect(dedupedB[0]?.status).toBe('completed');
    expect(dedupedB[0]?.stepCount).toBe(167);
  });

  it('matches a cross-contaminated timeline card by its started thread:<cid> receipt text instead of the hijacked subagentMeta', () => {
    const runs: SubagentRun[] = [
      {
        subagentId: '46b62a9f-e426-480f-8647-26a4ab4e12e0',
        parentThreadId: 'parent-1',
        parentToolCallId: 't_7301502a_326',
        childThreadId: '46b62a9f-e426-480f-8647-26a4ab4e12e0',
        role: 'T7 Call Resilience & Device Recovery Writer',
        status: 'completed',
        stepCount: 26,
        items: [],
        startedAtUnixMs: 1_000,
        updatedAtUnixMs: 2_000,
        completedAtUnixMs: 2_000,
      },
      {
        subagentId: 'e423c515-f5d8-48f8-b815-8b43f9ce93d1',
        parentThreadId: 'parent-1',
        parentToolCallId: 't_7301502a_326',
        childThreadId: 'e423c515-f5d8-48f8-b815-8b43f9ce93d1',
        role: 'T6 PTT Hotkey & Disambiguation v2 Writer',
        status: 'running',
        stepCount: 49,
        items: [],
        startedAtUnixMs: 1_005,
        updatedAtUnixMs: 2_500,
      },
    ];
    const contaminatedT7Card: ChatItem = {
      id: 't_7301502a_326',
      kind: 'tool',
      toolName: 'call_mcp_tool',
      toolKind: 'subagent',
      title: 'T7 Call Resilience & Device Recovery Writer',
      text: 'started thread:46b62a9f-e426-480f-8647-26a4ab4e12e0\n[subagent_id: thread:46b62a9f-e426-480f-8647-26a4ab4e12e0]',
      detail: 'Spec: T7',
      status: 'running',
      streaming: false,
      exitCode: null,
      createdAtUnixMs: 1_000,
      attachments: [],
      subagentMeta: {
        subagentId: 'e423c515-f5d8-48f8-b815-8b43f9ce93d1',
        childThreadId: 'e423c515-f5d8-48f8-b815-8b43f9ce93d1',
        action: 'spawn',
        role: 'T7 Call Resilience & Device Recovery Writer',
        status: 'running',
        stepCount: 49,
      },
    };

    const matched = matchSubagentRun(contaminatedT7Card, runs);
    expect(matched?.subagentId).toBe('46b62a9f-e426-480f-8647-26a4ab4e12e0');
    expect(matched?.status).toBe('completed');
    expect(isItemRunning(contaminatedT7Card, matched)).toBe(false);
  });

  it('recognizes wait-timeout receipts, suppresses hook/superseded noise in groupTranscriptRows, and extracts thread IDs from timeout JSON', () => {
    const timeoutJson = JSON.stringify({
      op: 'wait',
      status: 'failed',
      error: 'timeout',
      address: 'thread:46b62a9f-e426-480f-8647-26a4ab4e12e0',
      submitted: false,
    });
    expect(isWaitTimeoutReceiptText(timeoutJson)).toBe(true);
    expect(
      isWaitTimeoutReceiptText('Subagent thread:child-1 is still running after 120000ms wait slice.'),
    ).toBe(true);
    expect(extractStartedChildThreadId(timeoutJson)).toBe('46b62a9f-e426-480f-8647-26a4ab4e12e0');
    expect(
      isItemFailed(
        {
          id: 'call_timeout_raw',
          kind: 'tool',
          toolKind: 'subagent',
          toolName: 'kite_subagent_run',
          title: 'Long Worker',
          text: timeoutJson,
          detail: '',
          status: 'failed',
          streaming: false,
          exitCode: 1,
          createdAtUnixMs: 1_000,
          attachments: [],
          subagentMeta: {
            subagentId: 'call_timeout_raw',
            action: 'spawn',
            role: 'Long Worker',
            status: 'failed',
            stepCount: 0,
          },
        },
        null,
      ),
    ).toBe(false);

    const hookBlocked: ChatItem = {
      id: 'call_hook_1',
      kind: 'tool',
      toolKind: 'subagent',
      title: 'Run invoke_subagent',
      text: 'Blocked by Pre-Tool Hook: native `invoke_subagent` is blocked in Thread Mode.',
      detail: '',
      status: 'failed',
      streaming: false,
      exitCode: 1,
      createdAtUnixMs: 1_000,
      attachments: [],
      subagentMeta: {
        subagentId: 'call_hook_1',
        action: 'spawn',
        role: 'Subagent',
        status: 'failed',
        stepCount: 0,
      },
    };
    const zeroStepSuperseded: ChatItem = {
      id: 'call_retry_fail',
      kind: 'tool',
      toolKind: 'subagent',
      toolName: 'kite_subagent_run',
      title: 'Worker',
      text: 'Transient spawn error',
      detail: '',
      status: 'failed',
      streaming: false,
      exitCode: 1,
      createdAtUnixMs: 1_500,
      attachments: [],
      subagentMeta: {
        subagentId: 'call_retry_fail',
        action: 'spawn',
        role: 'Worker',
        status: 'failed',
        stepCount: 0,
      },
    };
    const realSucceeded: ChatItem = {
      id: 'call_real_ok',
      kind: 'tool',
      toolKind: 'subagent',
      toolName: 'kite_subagent_run',
      title: 'Worker',
      text: 'Done',
      detail: '',
      status: 'completed',
      streaming: false,
      exitCode: 0,
      createdAtUnixMs: 2_000,
      attachments: [],
      subagentMeta: {
        subagentId: 'child-real-ok',
        childThreadId: 'child-real-ok',
        action: 'spawn',
        role: 'Worker',
        status: 'completed',
        stepCount: 3,
      },
    };

    expect(isHookBlockedInvokeNoise(hookBlocked)).toBe(true);
    expect(isSuppressedSubagentNoiseItem(zeroStepSuperseded, [zeroStepSuperseded, realSucceeded])).toBe(
      true,
    );
    expect(isItemFailed(zeroStepSuperseded, {
      subagentId: 'child-real-ok',
      parentThreadId: 'p1',
      parentToolCallId: 'call_retry_fail',
      role: 'Worker',
      status: 'running',
      stepCount: 2,
      items: [],
      startedAtUnixMs: 1_500,
      updatedAtUnixMs: 2_000,
    })).toBe(false);

    const rows = groupTranscriptRows([hookBlocked, zeroStepSuperseded, realSucceeded]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ kind: 'item', item: realSucceeded });
  });
});
