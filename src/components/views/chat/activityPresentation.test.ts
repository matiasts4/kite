import { describe, expect, it } from 'vitest';
import {
  approvalWaitLabel,
  commandStatusLabel,
  interruptedTurnLine,
  showThinkingPlaceholder,
  summarizeWorkBurst,
  turnStartUnixMs,
  workedForLine,
  workingLine,
  type ActivityItem,
} from './activityPresentation';

function item(partial: ActivityItem): ActivityItem {
  return partial;
}

describe('working line', () => {
  it('reads Working for plus a live timer when the turn has a start', () => {
    expect(workingLine(1_000, 4_200)).toBe('Working for 3.2s');
    expect(workingLine(1_000, 16_000)).toBe('Working for 15s');
  });

  it('reads Working… when the turn has no start', () => {
    expect(workingLine(null, 5_000)).toBe('Working…');
    expect(workingLine(0, 5_000)).toBe('Working…');
  });

  it('takes the start from the latest user message', () => {
    expect(
      turnStartUnixMs([
        item({ kind: 'user', createdAtUnixMs: 10 }),
        item({ kind: 'assistant', text: 'earlier' }),
        item({ kind: 'user', createdAtUnixMs: 50 }),
      ]),
    ).toBe(50);
  });
});

describe('thinking placeholder', () => {
  it('shows Thinking until the first tool, command, or reasoning row', () => {
    expect(showThinkingPlaceholder([], false)).toBe(true);
    expect(showThinkingPlaceholder([item({ kind: 'user', text: 'go' })], false)).toBe(true);
  });

  it('hides Thinking once an action row exists', () => {
    expect(showThinkingPlaceholder([item({ kind: 'tool', title: 'Read src/main.ts', status: 'running' })], false)).toBe(
      false,
    );
    expect(
      showThinkingPlaceholder([item({ kind: 'reasoning', text: 'Looking at the tests.', streaming: true })], false),
    ).toBe(false);
  });

  it('hides Thinking while an answer is already on screen', () => {
    expect(showThinkingPlaceholder([item({ kind: 'assistant', text: 'Here is the patch.' })], false)).toBe(false);
  });

  it('keeps Thinking beside a failed latest tool', () => {
    expect(showThinkingPlaceholder([item({ kind: 'tool', title: 'Read src/main.ts', status: 'failed' })], false)).toBe(
      true,
    );
  });

  it('stays hidden while approval is waiting', () => {
    expect(showThinkingPlaceholder([], true)).toBe(false);
    expect(approvalWaitLabel('Bash', 'bash')).toBe('Waiting for approval · Bash');
  });
});

describe('command rows and burst summaries', () => {
  it('reads Running, Ran, Failed, Declined, or Stopped plus the program', () => {
    expect(commandStatusLabel(item({ kind: 'command', command: 'git status', status: 'running', streaming: true }))).toBe(
      'Running git',
    );
    expect(commandStatusLabel(item({ kind: 'command', command: '/usr/bin/cargo test', status: 'completed' }))).toBe(
      'Ran cargo',
    );
    expect(commandStatusLabel(item({ kind: 'command', command: 'npm test', status: 'failed', exitCode: 1 }))).toBe(
      'Failed npm',
    );
    expect(commandStatusLabel(item({ kind: 'command', command: 'rm -rf dist', status: 'completed', detail: 'declined' }))).toBe(
      'Declined rm',
    );
    expect(commandStatusLabel(item({ kind: 'command', command: 'sleep 30', status: 'failed', exitCode: 130 }))).toBe(
      'Stopped sleep',
    );
  });

  it('collapses a finished burst to Read, Changed, Ran, and Searched', () => {
    expect(
      summarizeWorkBurst([
        item({ kind: 'tool', title: 'Read src/a.ts', filePath: 'src/a.ts' }),
        item({ kind: 'tool', title: 'Read src/b.ts', filePath: 'src/b.ts' }),
      ]),
    ).toBe('Read 2 files');
    expect(summarizeWorkBurst([item({ kind: 'tool', toolKind: 'fileChange', filePath: 'src/a.ts' })])).toBe(
      'Changed 1 file',
    );
    expect(
      summarizeWorkBurst([
        item({ kind: 'command', command: 'git status' }),
        item({ kind: 'command', command: 'cargo test' }),
      ]),
    ).toBe('Ran 2 commands');
    expect(
      summarizeWorkBurst([
        item({ kind: 'tool', toolKind: 'webSearch', title: 'web search' }),
        item({ kind: 'tool', title: 'grep chat', toolName: 'grep' }),
      ]),
    ).toBe('Searched 2 times');
  });

  it('uses Worked for when a duration exists and does not invent one', () => {
    expect(workedForLine(4.2)).toBe('Worked for 4.2s');
    expect(workedForLine(null)).toBeNull();
    expect(interruptedTurnLine(12)).toBe('You stopped after 12s');
    expect(interruptedTurnLine(null)).toBe('You stopped this response');
  });
});
