import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as ipc from '../../../ipc';
import { ctxClient } from '../../context/ctxClient';
import { ActionSchema } from '../../contract';
import { executePlan } from '../index';
import { sendUiAck, type UiBusRequestPayload } from '../ui-bus';

vi.mock('../../../ipc', () => ({
  isTauriEnvironment: vi.fn(() => true),
  invokeCommand: vi.fn().mockResolvedValue({}),
  readWorkspaceChanges: vi.fn(),
  readWorkspaceFileDiff: vi.fn(),
}));

describe('S5 / T5 — Diff Inspection, Allowlisted Verification Checks & App Navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctxClient.resetForTests();
    vi.mocked(ipc.isTauriEnvironment).mockReturnValue(true);
  });

  it('read_diff fetches file diff, stores full patch in CcrStore, and returns added/removed summary', async () => {
    vi.mocked(ipc.readWorkspaceChanges).mockResolvedValue({
      isRepo: true,
      branch: 'feat/response-thread',
      workspacePrefix: '',
      upstream: null,
      files: [
        {
          path: 'src-tauri/src/dispatch/hook.rs',
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
        { kind: 'hunk', oldNumber: null, newNumber: null, text: '@@ -40,2 +40,5 @@' },
        { kind: 'removed', oldNumber: 40, newNumber: null, text: 'let allow = true;' },
        { kind: 'added', oldNumber: null, newNumber: 40, text: 'if is_settled { return Err("settled"); }' },
        { kind: 'added', oldNumber: null, newNumber: 41, text: 'let allow = false;' },
      ],
    });

    const res = await executePlan(
      {
        strategy: 'llm',
        actions: [{ type: 'read_diff', path: 'hook.rs' }],
      },
      { workspaceId: 'ws-1' }
    );

    expect(res.overallSuccess).toBe(true);
    const receipt = res.receipts[0];
    expect(receipt.type).toBe('read_diff');
    const data = receipt.data as any;
    expect(data.diffs[0].added).toBe(2);
    expect(data.diffs[0].removed).toBe(1);
    expect(data.ccrHash).toBeTruthy();
    expect(await ctxClient.ccrRetrieve(data.ccrHash)).toContain('is_settled');
    expect(receipt.spokenSummaryEs).toContain('hook.rs');
    expect(receipt.spokenSummaryEs).toContain('2 líneas agregadas');
    expect(data.envelopeText).toContain('+2/-1');
  });

  it('run_check executes strictly allowlisted presets, rejects invalid presets/filters, and stores output in CcrStore', async () => {
    // Zod rejects non-allowlisted presets
    expect(
      ActionSchema.safeParse({ type: 'run_check', preset: 'rm_rf' }).success
    ).toBe(false);

    // Rejects shell injection in targetFilter
    const injectedRes = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'run_check',
            preset: 'vitest',
            targetFilter: 'src/lib/operator; rm -rf /',
          },
        ],
      },
      { workspaceId: 'ws-1' }
    );
    expect(injectedRes.overallSuccess).toBe(false);
    expect(injectedRes.receipts[0].error).toBe('unsafe_target_filter');
    expect(ipc.invokeCommand).not.toHaveBeenCalledWith('ctx_exec', expect.anything());

    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'ctx_exec') {
        return {
          ok: true,
          exitCode: 0,
          passed: 18,
          failed: 0,
          output: 'Test Files  3 passed (3)\nTests  18 passed (18)',
        };
      }
      return {};
    });

    const okRes = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'run_check',
            preset: 'vitest',
            targetFilter: 'src/lib/operator',
          },
        ],
      },
      { workspaceId: 'ws-1' }
    );
    expect(okRes.overallSuccess).toBe(true);
    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'ctx_exec',
      expect.objectContaining({
        preset: 'vitest',
        command: 'npx vitest run src/lib/operator',
      })
    );
    const data = okRes.receipts[0].data as any;
    expect(data.ccrHash).toBeTruthy();
    expect(await ctxClient.ccrRetrieve(data.ccrHash)).toContain('18 passed');
    expect(okRes.receipts[0].spokenSummaryEs).toContain('18');
  });

  it('navigate_view dispatches typed UI bus event and waits for ACK', async () => {
    const received: UiBusRequestPayload[] = [];
    const listener = (e: Event) => {
      const custom = e as CustomEvent<UiBusRequestPayload>;
      if (custom.detail.kind === 'navigate-view') {
        received.push(custom.detail);
        sendUiAck({
          reqId: custom.detail.reqId,
          ok: true,
          data: custom.detail.payload,
        });
      }
    };
    window.addEventListener('kite:op-request', listener);

    const res = await executePlan({
      strategy: 'llm',
      actions: [{ type: 'navigate_view', view: 'tasks', taskId: 'KITE-101' }],
    });

    window.removeEventListener('kite:op-request', listener);

    expect(res.overallSuccess).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].payload).toMatchObject({ view: 'tasks', taskId: 'KITE-101' });
    expect(res.receipts[0].spokenSummaryEs).toContain('Tasks');
  });
});
