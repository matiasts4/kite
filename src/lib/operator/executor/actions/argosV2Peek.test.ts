import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as ipc from '../../../ipc';
import { ctxClient } from '../../context/ctxClient';
import { upsertSubagentFinding, resetWorkingContextForTests } from '../../context/workingContext';
import {
  executePeekChangesAction,
  executePeekAgentsAction,
  executePeekSearchAction,
  executeReadFindingAction,
  isPeekActionType,
} from './peekWorkspace';
import { executePlan } from '../index';

vi.mock('../../../ipc', () => ({
  isTauriEnvironment: vi.fn(() => true),
  invokeCommand: vi.fn().mockResolvedValue({}),
  readWorkspaceChanges: vi.fn(),
  readWorkspaceFileDiff: vi.fn(),
  listAllSubagentRuns: vi.fn(),
  listAgentProfiles: vi.fn(),
  listRoutines: vi.fn(),
  getThreadSwarmState: vi.fn(),
}));

describe('S1 / T1 — Upgraded peek_changes, peek_agents, peek_search & read_finding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctxClient.resetForTests();
    resetWorkingContextForTests();
    vi.mocked(ipc.isTauriEnvironment).mockReturnValue(true);
  });

  it('recognizes peek_search and read_finding as ReAct peek action types', () => {
    expect(isPeekActionType('peek_search')).toBe(true);
    expect(isPeekActionType('read_finding')).toBe(true);
  });

  it('peek_changes fetches diff hunks via readWorkspaceFileDiff when includeDiff is true', async () => {
    vi.mocked(ipc.readWorkspaceChanges).mockResolvedValue({
      isRepo: true,
      branch: 'feat/response-thread',
      workspacePrefix: '',
      upstream: null,
      files: [
        {
          path: 'src/lib/operator/contract.ts',
          status: 'modified',
          oldPath: null,
          staged: false,
          unstaged: true,
        },
        {
          path: 'src/App.tsx',
          status: 'modified',
          oldPath: null,
          staged: false,
          unstaged: true,
        },
      ],
    });
    vi.mocked(ipc.readWorkspaceFileDiff).mockResolvedValue({
      truncated: false,
      lines: [
        { kind: 'hunk', oldNumber: null, newNumber: null, text: '@@ -10,2 +10,4 @@' },
        { kind: 'removed', oldNumber: 10, newNumber: null, text: 'const oldFlag = false;' },
        { kind: 'added', oldNumber: null, newNumber: 10, text: 'const newFlag = true;' },
        { kind: 'added', oldNumber: null, newNumber: 11, text: 'export const version = 2;' },
      ],
    });

    const receipt = await executePeekChangesAction(
      { type: 'peek_changes', includeDiff: true, path: 'contract.ts' },
      0,
      { workspaceId: 'ws-1' }
    );

    expect(receipt.ok).toBe(true);
    expect(ipc.readWorkspaceFileDiff).toHaveBeenCalledWith(
      'ws-1',
      'src/lib/operator/contract.ts',
      false
    );
    const data = receipt.data as any;
    expect(data.diffs).toHaveLength(1);
    expect(data.diffs[0]).toMatchObject({
      path: 'src/lib/operator/contract.ts',
      added: 2,
      removed: 1,
    });
    expect(data.diffs[0].hunks).toContain('@@ -10,2 +10,4 @@');
  });

  it('peek_agents refreshes live subagents, autonomous agents, routines, and swarm state via IPC', async () => {
    vi.mocked(ipc.listAllSubagentRuns).mockResolvedValue({
      totalCount: 1,
      activeCount: 1,
      waitingCount: 0,
      runs: [
        {
          threadId: 'thread-parent',
          threadTitle: 'Parent',
          run: {
            subagentId: 'child-1',
            childThreadId: 'child-1',
            parentThreadId: 'thread-parent',
            parentToolCallId: 'tc-1',
            role: 'Explorer',
            provider: 'claude',
            status: 'running',
            prompt: 'Audit files',
            stepCount: 1,
            items: [],
            startedAtUnixMs: 1000,
            updatedAtUnixMs: 2000,
          },
        },
      ],
    });
    vi.mocked(ipc.listAgentProfiles).mockResolvedValue([
      { id: 'agent-1', name: 'Nova', engine: 'claude', status: 'idle' } as any,
    ]);
    vi.mocked(ipc.listRoutines).mockResolvedValue({
      schemaVersion: 1,
      routines: [
        { id: 'rot-1', agentId: 'agent-1', name: 'Nightly Audit', enabled: true } as any,
      ],
      agentRevisions: [{ agentId: 'agent-1', revision: '0'.repeat(64) }],
      runNowAvailability: { available: true, reason: '' },
    });
    vi.mocked(ipc.getThreadSwarmState).mockResolvedValue({
      title: 'Core Swarm',
      members: [{ name: 'worker-1', status: 'working' }],
    } as any);

    const receipt = await executePeekAgentsAction(
      { type: 'peek_agents', scope: 'all' },
      0,
      { workspaceId: 'ws-1', boundThreadId: 'thread-parent' }
    );

    expect(receipt.ok).toBe(true);
    const data = receipt.data as any;
    expect(data.liveRefreshed).toBe(true);
    expect(data.subagents).toHaveLength(1);
    expect(data.subagents[0].role).toBe('Explorer');
    expect(data.autonomousAgents).toHaveLength(1);
    expect(data.autonomousAgents[0].name).toBe('Nova');
    expect(data.routinesCount).toBe(1);
    expect(data.swarmTitle).toBe('Core Swarm');
    expect(receipt.summaryEs).toContain('1 subagentes');
    expect(receipt.summaryEs).toContain('1 rutinas');
  });

  it('peek_search queries ctx_search / fallback files and returns bounded matches', async () => {
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'ctx_search') {
        return {
          matches: [
            {
              path: 'src/lib/operator/contract.ts',
              line: 120,
              snippet: 'export const PeekSearchActionSchema = ...',
            },
          ],
        };
      }
      return {};
    });

    const res = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'peek_search',
            query: 'PeekSearchActionSchema',
            kind: 'symbol',
            limit: 5,
          },
        ],
      },
      { workspaceId: 'ws-1' }
    );

    expect(res.overallSuccess).toBe(true);
    expect(res.receipts[0].type).toBe('peek_search');
    const data = res.receipts[0].data as any;
    expect(data.matches).toHaveLength(1);
    expect(data.matches[0].path).toBe('src/lib/operator/contract.ts');

    // Fallback search when Tauri is unavailable
    vi.mocked(ipc.isTauriEnvironment).mockReturnValue(false);
    ctxClient.registerFallbackFileContent(
      'src/example.ts',
      'export function runSampleCheck() {\n  return true;\n}'
    );
    const fallbackReceipt = await executePeekSearchAction(
      { type: 'peek_search', query: 'runSampleCheck', kind: 'text', limit: 5 },
      0,
      {}
    );
    expect(fallbackReceipt.ok).toBe(true);
    expect((fallbackReceipt.data as any).matches[0].path).toBe('src/example.ts');
  });

  it('read_finding retrieves compressed artifacts from CcrStore, SharedContext, or WorkingContext', async () => {
    vi.mocked(ipc.isTauriEnvironment).mockReturnValue(false);
    const hash = ctxClient.ccrStoreLocal('Linea 1 hallazgo\nLinea 2 detalle crítico');

    const ccrRes = await executePlan(
      {
        strategy: 'llm',
        actions: [{ type: 'read_finding', hashOrThreadId: `<<ccr:${hash}>>` }],
      },
      { boundThreadId: 'thread-1' }
    );

    expect(ccrRes.overallSuccess).toBe(true);
    expect(ccrRes.receipts[0].type).toBe('read_finding');
    expect((ccrRes.receipts[0].data as any).content).toContain('Linea 2 detalle crítico');

    upsertSubagentFinding('thread-1', {
      subagentId: 'child-42',
      role: 'Auditor',
      status: 'completed',
      taskSummary: 'Revisar hook.rs',
      findingsSummary: 'El guardia de estado rechazó mensajes tras settled.',
    });

    const wcReceipt = await executeReadFindingAction(
      { type: 'read_finding', hashOrThreadId: 'child-42' },
      0,
      { boundThreadId: 'thread-1' }
    );
    expect(wcReceipt.ok).toBe(true);
    expect((wcReceipt.data as any).content).toContain('guardia de estado');
  });
});
