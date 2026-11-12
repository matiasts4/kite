import { describe, expect, it } from 'vitest';
import {
  activityIconKind,
  activityTraceLabel,
  approvalWaitLabel,
  opensInFilesSidebar,
  commandStatusLabel,
  interruptedTurnLine,
  liveStageLabel,
  splitTraceLabel,
  summarizeWorkBurst,
  toolExpandedBody,
  turnStartUnixMs,
  workedForLine,
  compactingForLine,
  workingLine,
  type ActivityItem,
} from './activityPresentation';

function item(partial: ActivityItem): ActivityItem {
  return partial;
}

describe('working line', () => {
  it('reads Working · plus a live timer when the turn has a start', () => {
    expect(workingLine(1_000, 4_200)).toBe('Working · 3s');
    expect(workingLine(1_000, 16_000)).toBe('Working · 15s');
    expect(workingLine(1_000, 126_000)).toBe('Working · 2m 5s');
  });

  it('reads Compacting · with the same clock', () => {
    expect(compactingForLine(1_000, 126_000)).toBe('Compacting · 2m 5s');
    expect(compactingForLine(null, 5_000)).toBe('Compacting…');
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

describe('live stage', () => {
  it('claims nothing until the provider has sent something this turn', () => {
    expect(liveStageLabel([])).toBeNull();
    expect(liveStageLabel([item({ kind: 'user', text: 'go' })])).toBeNull();
    expect(
      liveStageLabel([item({ kind: 'user', text: 'go' }), item({ kind: 'reasoning', text: '  ', streaming: true })]),
    ).toBeNull();
  });

  it('reads Thinking only once thought text exists', () => {
    expect(
      liveStageLabel([item({ kind: 'user', text: 'go' }), item({ kind: 'reasoning', text: 'Looking at tests.', streaming: true })]),
    ).toBe('Thinking');
  });

  it('names the latest tool and then the reply being written', () => {
    expect(
      liveStageLabel([item({ kind: 'user', text: 'go' }), item({ kind: 'tool', title: 'Read src/main.ts', status: 'running' })]),
    ).toMatch(/main\.ts/);
    expect(
      liveStageLabel([
        item({ kind: 'user', text: 'go' }),
        item({ kind: 'tool', title: 'Read src/main.ts', status: 'completed' }),
        item({ kind: 'assistant', text: 'Here is', streaming: true }),
      ]),
    ).toBe('Writing');
  });

  it('keeps approval wait wording', () => {
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

  it('puts the action in one sentence', () => {
    expect(activityTraceLabel(item({ kind: 'tool', title: 'Read', detail: 'src/main.ts' }))).toBe(
      'Read src/main.ts',
    );
    expect(activityTraceLabel(item({ kind: 'tool', toolKind: 'fileChange', filePath: 'src/a.ts' }))).toBe(
      'src/a.ts',
    );
    expect(
      activityTraceLabel(item({ kind: 'command', command: 'git status', status: 'running', streaming: true })),
    ).toBe('Running git');
    expect(activityTraceLabel(item({ kind: 'tool', toolKind: 'webSearch', detail: 'kite radius' }))).toBe(
      'Searched kite radius',
    );
    expect(activityTraceLabel(item({ kind: 'tool', title: 'grep', detail: 'chat-work-entry' }))).toBe(
      'Searched chat-work-entry',
    );
    expect(
      activityTraceLabel(
        item({
          kind: 'tool',
          title: 'read file',
          toolName: 'read_file',
          detail:
            '{\n  "Path": "C:\\\\Users\\\\PC\\\\.gemini\\\\antigravity-cli\\\\mcp\\\\engram\\\\mem_current_project.json"\n}\n\n1 lines, 569 bytes',
          text: '1 lines, 569 bytes',
        }),
      ),
    ).toBe('Read mcp/engram/mem_current_project.json');
    expect(
      activityTraceLabel(
        item({
          kind: 'tool',
          title: 'engram · mem_search',
          toolName: 'call_mcp_tool',
          serverName: 'engram',
          toolKind: 'mcpToolCall',
          detail:
            '{"Arguments":{"project":"kite","query":"notification notificaciones"},"ServerName":"engram","ToolName":"mem_search"}',
        }),
      ),
    ).toBe('engram · mem_search notification notificaciones');
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

  it('sends a created markdown or image to the files sidebar', () => {
    expect(
      opensInFilesSidebar(
        item({
          kind: 'tool',
          title: 'write file',
          toolName: 'write_file',
          detail: '{"Path":"C:/Users/PC/.gemini/antigravity-cli/brain/walkthrough.md"}',
        }),
      ),
    ).toBe(true);
    expect(
      opensInFilesSidebar(
        item({
          kind: 'tool',
          title: 'screenshot',
          filePath: 'C:/Users/PC/.gemini/antigravity-cli/brain/shot.png',
        }),
      ),
    ).toBe(true);
    expect(
      opensInFilesSidebar(
        item({ kind: 'tool', title: 'read file', toolName: 'read_file', filePath: 'src/notifications/foo.ts' }),
      ),
    ).toBe(false);
    expect(opensInFilesSidebar(item({ kind: 'command', command: 'Test-Path .codegraph' }))).toBe(false);
  });

  it('uses Worked for when a duration exists and does not invent one', () => {
    expect(workedForLine(4.2)).toBe('Worked for 4.2s');
    expect(workedForLine(125)).toBe('Worked for 2m 5s');
    expect(workedForLine(null)).toBeNull();
    expect(interruptedTurnLine(12)).toBe('You stopped after 12s');
    expect(interruptedTurnLine(null)).toBe('You stopped this response');
  });

  it('builds expandable tool details from command line, MCP parameters, and output', () => {
    expect(
      toolExpandedBody(
        item({
          kind: 'tool',
          toolKind: 'commandExecution',
          command: 'Get-ChildItem -Path odd/tasks, .kite/tasks | Select-Object FullName',
          text: '',
          status: 'completed',
        }),
      ),
    ).toBe('$ Get-ChildItem -Path odd/tasks, .kite/tasks | Select-Object FullName');

    expect(
      toolExpandedBody(
        item({
          kind: 'tool',
          toolKind: 'mcpToolCall',
          serverName: 'gentle-ai-engram_engram',
          title: 'gentle-ai-engram_engram · mem_current_project',
          detail: '{\n  "Arguments": {},\n  "ServerName": "gentle-ai-engram_engram",\n  "ToolName": "mem_current_project"\n}',
          text: '',
          status: 'failed',
        }),
      ),
    ).toContain('"ToolName": "mem_current_project"');

    expect(
      toolExpandedBody(
        item({
          kind: 'tool',
          title: 'read file',
          toolName: 'read_file',
          detail: '{"Path":"src/notifications/foo.ts"}',
          text: '1 lines, 569 bytes',
          status: 'completed',
        }),
      ),
    ).toBe('');
  });
});

describe('tool labels', () => {
  it('reads an MCP tool as server · tool', () => {
    expect(activityTraceLabel(item({ kind: 'tool', title: 'codegraph__codegraph_explore' }))).toBe('codegraph · explore');
    expect(activityTraceLabel(item({ kind: 'tool', title: 'mcp__engram__mem_search' }))).toBe('engram · mem search');
  });

  it('reads a regex where a name should be as a search', () => {
    expect(activityTraceLabel(item({ kind: 'tool', title: 'Status:|pending|open' }))).toBe('Searched Status:|pending|open');
    expect(activityTraceLabel(item({ kind: 'command', title: 'mention|regenerateTitle', status: 'completed', exitCode: 0 }))).toBe(
      'Searched mention|regenerateTitle',
    );
  });

  it('keeps real commands as Ran <program>', () => {
    expect(activityTraceLabel(item({ kind: 'command', title: 'git status -sb', status: 'completed', exitCode: 0 }))).toBe('Ran git');
  });

  it('splits a verb from its target', () => {
    expect(splitTraceLabel('Read src/main.ts')).toEqual({ verb: 'Read', target: 'src/main.ts' });
    expect(splitTraceLabel('Execute git branch')).toEqual({ verb: 'Execute', target: 'git branch' });
    expect(splitTraceLabel('codegraph · explore')).toEqual({ verb: 'codegraph', target: 'explore' });
    expect(splitTraceLabel('Changed files')).toEqual({ verb: null, target: 'Changed files' });
  });

  it('maps ACP toolKind values and MCP names to their semantic icons', () => {
    expect(activityIconKind(item({ kind: 'tool', toolKind: 'read', title: 'src/main.ts' }))).toBe('read');
    expect(activityIconKind(item({ kind: 'tool', toolKind: 'edit', title: 'src/main.ts' }))).toBe('edit');
    expect(activityIconKind(item({ kind: 'tool', toolKind: 'execute', title: 'Execute `git status`' }))).toBe('shell');
    expect(activityIconKind(item({ kind: 'tool', toolKind: 'search', title: 'set_chat_thread_pinned' }))).toBe(
      'code-search',
    );
    expect(activityIconKind(item({ kind: 'tool', toolKind: 'fetch', title: 'https://example.com' }))).toBe('web');
    expect(activityIconKind(item({ kind: 'tool', title: 'engram · mem save' }))).toBe('mcp');
    expect(activityTraceLabel(item({ kind: 'tool', toolKind: 'execute', title: 'Execute `git status`', status: 'completed' }))).toBe(
      'Ran git',
    );
  });
});