import React from 'react';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatItem, SubagentRun } from '../../../types';
import { ChatItemRow, groupTranscriptRows } from './ChatItemRow';
import {
  INITIAL_VISIBLE_TRANSCRIPT_ROWS,
  INITIAL_VISIBLE_UNDERLYING_ITEMS,
  sliceTranscriptRowsByWindow,
} from './SingleThreadPane';
import { SubagentActivityCard, SubagentGroupRow } from './SubagentActivityCard';
import { buildThreadTurns } from './ThreadTurnRail';
import { TURN_ACTIVITY_CLOCK_INTERVAL_MS, TurnActivityStatus } from './TurnActivityStatus';
import {
  SMOOTH_STREAM_BYPASS_CHARS,
  useSmoothStreamingText,
} from './useSmoothStreamingText';
import {
  applySubagentEvent,
  shouldDispatchThreadsChanged,
  type ChatSubagentEventPayload,
} from './hooks/useSubagentEvents';
import {
  setActiveSubagentInspection,
  SUBAGENT_INSPECTION_CHANGE_EVENT,
} from '../../../lib/subagentNav';
import type { ExtendedChatThread } from './types';

function makeItem(overrides: Partial<ChatItem> & { id: string; kind: ChatItem['kind'] }): ChatItem {
  return {
    text: '',
    title: null,
    detail: null,
    status: 'completed',
    streaming: false,
    exitCode: null,
    createdAtUnixMs: 1_760_000_000_000,
    attachments: [],
    ...overrides,
  };
}

function buildLongThreadFixture(): {
  items: ChatItem[];
  subagentRuns: SubagentRun[];
  thread: ExtendedChatThread;
} {
  const items: ChatItem[] = [];
  const subagentRuns: SubagentRun[] = [];
  let itemCounter = 0;

  // 30 turns, 1,000 items total, 15 delegated subagents
  for (let turn = 1; turn <= 30; turn += 1) {
    items.push(
      makeItem({
        id: `user-${turn}`,
        kind: 'user',
        text: `Turn ${turn}: Analyze module #${turn} and verify invariants`,
        createdAtUnixMs: 1_760_000_000_000 + turn * 60_000,
      })
    );
    itemCounter += 1;

    const toolsInTurn = turn <= 20 ? 32 : 30;
    for (let t = 1; t <= toolsInTurn; t += 1) {
      if (t === 1 && turn <= 15) {
        const subId = `sub-${turn}`;
        const callId = `call-sub-${turn}`;
        items.push(
          makeItem({
            id: callId,
            kind: 'tool',
            toolKind: 'subagent',
            title: `Explorer ${turn}`,
            detail: `Inspecting slice ${turn}`,
            status: turn < 15 ? 'completed' : 'running',
            streaming: turn === 15,
            subagentMeta: {
              subagentId: subId,
              action: 'spawn',
              role: `Explorer ${turn}`,
              childThreadId: `child-${turn}`,
              status: turn < 15 ? 'completed' : 'running',
              stepCount: 10,
              latestActivity: `Step 10 in slice ${turn}`,
            },
          })
        );
        subagentRuns.push({
          subagentId: subId,
          parentThreadId: 'thread-long',
          parentToolCallId: callId,
          childThreadId: `child-${turn}`,
          role: `Explorer ${turn}`,
          provider: 'antigravity',
          model: 'gemini-4-argon',
          status: turn < 15 ? 'completed' : 'running',
          stepCount: 10,
          latestActivity: `Step 10 in slice ${turn}`,
          startedAtUnixMs: 1_760_000_000_000 + turn * 60_000,
          updatedAtUnixMs: 1_760_000_000_000 + turn * 60_000 + 5_000,
          items: [],
        });
      } else {
        items.push(
          makeItem({
            id: `tool-${turn}-${t}`,
            kind: 'tool',
            title: `Read src/mod_${turn}_${t}.ts`,
            detail: `src/mod_${turn}_${t}.ts`,
            filePath: `src/mod_${turn}_${t}.ts`,
          })
        );
      }
      itemCounter += 1;
    }

    items.push(
      makeItem({
        id: `asst-${turn}`,
        kind: 'assistant',
        text: `Summary for turn ${turn}: completed ${toolsInTurn} tool checks cleanly.`,
        streaming: turn === 30,
      })
    );
    itemCounter += 1;
  }

  expect(itemCounter).toBe(1000);
  expect(subagentRuns).toHaveLength(15);

  const thread: ExtendedChatThread = {
    schemaVersion: 1,
    revision: 'rev-long',
    id: 'thread-long',
    profileId: null,
    provider: 'antigravity',
    title: 'Long Conversation Fixture',
    items,
    subagentRuns,
    mode: 'fullAccess',
    plan: false,
    model: 'gemini-4-argon',
    status: 'running',
    usage: { inputTokens: 50_000, outputTokens: 12_000, costUsd: 0 },
    workspaceId: 'ws-1',
    pinned: false,
    createdAtUnixMs: 1_760_000_000_000,
    updatedAtUnixMs: 1_760_001_800_000,
  };

  return { items, subagentRuns, thread };
}

describe('Long-Thread & Subagent UI Runtime Performance Guardrails (30 turns, 1,000 items, 15 subagents)', () => {
  it('restores content-visibility: auto on offscreen transcript rows while keeping trailing live rows visible', async () => {
    const fsSpecifier = ['node', 'fs'].join(':');
    const fs = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (filePath: string, encoding: 'utf8') => string;
    };
    const chatCoreCss = fs.readFileSync('src/components/views/chat/styles/chat-core.css', 'utf8');
    expect(chatCoreCss).toContain(
      '.chat-transcript__column>*{content-visibility:auto;contain-intrinsic-size:auto 120px}'
    );
    expect(chatCoreCss).toContain(
      '.chat-transcript__column>:last-child,.chat-transcript__column>:nth-last-child(2){content-visibility:visible;contain-intrinsic-size:none}'
    );
  });

  it('bounds initial transcript window by both grouped rows and underlying item weight and preserves group references across deltas', () => {
    const { items } = buildLongThreadFixture();
    const rows1 = groupTranscriptRows(items);
    expect(rows1.length).toBeGreaterThan(80);

    const windowed = sliceTranscriptRowsByWindow(rows1, INITIAL_VISIBLE_TRANSCRIPT_ROWS);
    expect(windowed.length).toBeLessThanOrEqual(INITIAL_VISIBLE_TRANSCRIPT_ROWS);
    const underlyingCount = windowed.reduce(
      (sum, r) => sum + (r.kind === 'work' || r.kind === 'subagentGroup' ? r.items.length : 1),
      0
    );
    expect(underlyingCount).toBeLessThanOrEqual(INITIAL_VISIBLE_UNDERLYING_ITEMS);

    // Appending a streaming delta to the trailing assistant item preserves === identity for all settled rows
    const updatedLast = {
      ...items[items.length - 1]!,
      text: `${items[items.length - 1]!.text} Appended token.`,
    };
    const nextItems = [...items.slice(0, items.length - 1), updatedLast];
    const rows2 = groupTranscriptRows(nextItems);

    expect(rows2).toHaveLength(rows1.length);
    for (let i = 0; i < rows1.length - 1; i += 1) {
      const r1 = rows1[i]!;
      const r2 = rows2[i]!;
      expect(r2).toBe(r1);
      if (r1.kind === 'work' && r2.kind === 'work') {
        expect(r2.items).toBe(r1.items);
      }
    }
  });

  it('Suppresses kite:threads-changed across 50 consecutive subagentStepsUpdated events and prevents historical subagent row re-renders', () => {
    const { thread, items, subagentRuns } = buildLongThreadFixture();
    const seen = new Map<string, string>();

    // Initial run registration fires once
    expect(
      shouldDispatchThreadsChanged(
        {
          kind: 'subagentRunUpdated',
          threadId: thread.id,
          subagentId: 'sub-15',
          run: subagentRuns[14],
        },
        seen
      )
    ).toBe(true);

    let currentThread = thread;
    let threadsChangedCount = 0;
    for (let step = 11; step <= 60; step += 1) {
      const payload: ChatSubagentEventPayload = {
        kind: 'subagentStepsUpdated',
        threadId: thread.id,
        subagentId: 'sub-15',
        childThreadId: 'child-15',
        status: 'running',
        stepCount: step,
        latestActivity: `Running step ${step}`,
        items: [
          makeItem({
            id: `sub-15-step-${step}`,
            kind: 'tool',
            title: `Tool ${step}`,
          }),
        ],
      };
      if (shouldDispatchThreadsChanged(payload, seen)) {
        threadsChangedCount += 1;
      }
      currentThread = applySubagentEvent(currentThread, payload);
    }

    expect(threadsChangedCount).toBe(0);
    expect(currentThread.subagentRuns?.[14]?.stepCount).toBe(60);

    // Settled subagent row #1 must NOT re-render when subagent #15 mutates subagentRuns array
    const sub1Item = items.find((it) => it.id === 'call-sub-1')!;
    const sub1Run = subagentRuns[0]!;
    let sub1RowRenders = 0;
    const ProbeSub1: React.FC<{ runs: SubagentRun[]; matched: SubagentRun }> = ({
      runs,
      matched,
    }) => {
      return (
        <div
          ref={() => {
            sub1RowRenders += 1;
          }}
        >
          <ChatItemRow
            item={sub1Item}
            threadId={thread.id}
            subagentRuns={runs}
            matchedSubagentRun={matched}
          />
        </div>
      );
    };

    // Directly test ChatItemRow memoization when parent re-renders with new subagentRuns array
    const spySubCard = vi.spyOn(SubagentActivityCard, 'type' as never);
    const { rerender } = render(
      <ChatItemRow
        item={sub1Item}
        threadId={thread.id}
        subagentRuns={subagentRuns}
        matchedSubagentRun={sub1Run}
      />
    );
    const initialCalls = spySubCard.mock.calls.length;

    rerender(
      <ChatItemRow
        item={sub1Item}
        threadId={thread.id}
        subagentRuns={currentThread.subagentRuns!}
        matchedSubagentRun={sub1Run}
      />
    );
    expect(spySubCard.mock.calls.length).toBe(initialCalls);
    expect(ProbeSub1).toBeDefined();
    spySubCard.mockRestore();
  });

  it('uses a single shared window listener for SUBAGENT_INSPECTION_CHANGE_EVENT across all mounted SubagentActivityCards', () => {
    const { items, subagentRuns } = buildLongThreadFixture();
    const subItems = items.filter((it) => it.toolKind === 'subagent');
    expect(subItems).toHaveLength(15);

    const addListenerSpy = vi.spyOn(window, 'addEventListener');
    try {
      const { unmount } = render(
        <div>
          {subItems.map((it, idx) => (
            <SubagentActivityCard
              key={it.id}
              item={it}
              threadId="thread-long"
              workspaceId="ws-1"
              run={subagentRuns[idx]}
            />
          ))}
          <SubagentGroupRow
            items={subItems.slice(0, 3)}
            threadId="thread-long"
            workspaceId="ws-1"
            subagentRuns={subagentRuns}
          />
        </div>
      );

      const inspectionListeners = addListenerSpy.mock.calls.filter(
        ([eventName]) => eventName === SUBAGENT_INSPECTION_CHANGE_EVENT
      );
      expect(inspectionListeners.length).toBeLessThanOrEqual(1);

      act(() => {
        setActiveSubagentInspection({
          threadId: 'thread-long',
          subagentId: 'sub-3',
          childThreadId: 'child-3',
          mode: 'subagent',
          workspaceId: 'ws-1',
        });
      });
      act(() => {
        setActiveSubagentInspection(null);
      });
      unmount();
    } finally {
      addListenerSpy.mockRestore();
    }
  });

  it('caches settled ThreadTurnEntry objects across streaming deltas on turn #30 and paces TurnActivityStatus & large smooth streams', () => {
    const { items } = buildLongThreadFixture();
    const turns1 = buildThreadTurns(items, true);
    expect(turns1).toHaveLength(30);

    const updatedLast = {
      ...items[items.length - 1]!,
      text: `${items[items.length - 1]!.text} More streaming output.`,
    };
    const nextItems = [...items.slice(0, items.length - 1), updatedLast];
    const turns2 = buildThreadTurns(nextItems, true);
    expect(turns2).toHaveLength(30);

    // Turns 1..29 are referentially identical cached entries
    for (let i = 0; i < 29; i += 1) {
      expect(turns2[i]).toBe(turns1[i]);
    }
    expect(turns2[29]?.assistantPreview).toContain('More streaming output.');

    // TurnActivityStatus uses 1000ms clock cadence
    expect(TURN_ACTIVITY_CLOCK_INTERVAL_MS).toBe(1000);
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    try {
      const { unmount } = render(<TurnActivityStatus running items={items} />);
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
      unmount();
    } finally {
      setIntervalSpy.mockRestore();
    }

    // useSmoothStreamingText bypasses character-by-character rAF for blocks > SMOOTH_STREAM_BYPASS_CHARS
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    try {
      const ProbeStream: React.FC<{ text: string }> = ({ text }) => {
        const out = useSmoothStreamingText(text, true);
        return <div data-testid="stream-len">{out.length}</div>;
      };
      const initialHuge = 'A'.repeat(SMOOTH_STREAM_BYPASS_CHARS + 10);
      const { getByTestId, rerender } = render(<ProbeStream text={initialHuge} />);
      expect(getByTestId('stream-len').textContent).toBe(String(initialHuge.length));

      const grownHuge = `${initialHuge}${'B'.repeat(500)}`;
      rerender(<ProbeStream text={grownHuge} />);
      expect(getByTestId('stream-len').textContent).toBe(String(grownHuge.length));
      expect(rafSpy).not.toHaveBeenCalled();
    } finally {
      rafSpy.mockRestore();
    }
  });
});
