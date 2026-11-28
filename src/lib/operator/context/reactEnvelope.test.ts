import { describe, it, expect, beforeEach } from 'vitest';
import {
  REACT_OBSERVATION_MAX_TOKENS,
  formatReactObservation,
  formatReactObservationBatch,
  formatReactObservationWithCtx,
} from './reactEnvelope';
import { ctxClient } from './ctxClient';
import type { ActionReceipt } from '../contract';

describe('reactEnvelope — Structured ReAct Observation Formatting', () => {
  beforeEach(() => {
    ctxClient.resetForTests();
  });

  it('formats peek_changes with diff hunks exceeding 400 chars while staying <= 450 tokens', () => {
    const longPatchLines = Array.from({ length: 18 }, (_, i) => `+  const line${i} = computeValue(${i});`).join('\n');
    const receipt: ActionReceipt = {
      actionIdx: 0,
      type: 'peek_changes',
      ok: true,
      summaryEs: 'Hay 3 archivos modificados en feat/response-thread.',
      data: {
        isRepo: true,
        branch: 'feat/response-thread',
        count: 3,
        files: [
          { path: 'src/lib/operator/contract.ts', status: 'modified', staged: false },
          { path: 'src/lib/operator/executor/actions/peekWorkspace.ts', status: 'modified', staged: true },
          { path: 'src/lib/operator/context/reactEnvelope.ts', status: 'added', staged: false },
        ],
        diffs: [
          {
            path: 'src/lib/operator/contract.ts',
            added: 18,
            removed: 2,
            hunks: ['@@ -114,5 +114,21 @@'],
            preview: longPatchLines,
          },
        ],
      },
    };

    const env = formatReactObservation(receipt);
    expect(env.text.length).toBeGreaterThan(400);
    expect(env.estimatedTokens).toBeLessThanOrEqual(REACT_OBSERVATION_MAX_TOKENS);
    expect(env.text.length).toBeLessThanOrEqual(REACT_OBSERVATION_MAX_TOKENS * 4);
    expect(env.text).toContain('[Observación peek_changes]');
    expect(env.text).toContain('src/lib/operator/contract.ts');
    expect(env.text).toContain('@@ -114,5 +114,21 @@');
    expect(env.text).toContain('+18/-2');
  });

  it('formats peek_search and read_finding preserving matches, content, and <<ccr:HASH>> pointer', () => {
    const searchReceipt: ActionReceipt = {
      actionIdx: 0,
      type: 'peek_search',
      ok: true,
      summaryEs: 'Encontré 2 coincidencias para "DraftExecutionPlan".',
      data: {
        query: 'DraftExecutionPlan',
        kind: 'symbol',
        matches: [
          { path: 'src/lib/operator/voice/voiceSessionStore.ts', line: 92, snippet: 'export type DraftExecutionPlan = DraftTaskProposal;' },
          { path: 'src/components/views/chat/ConsultativeDraftCard.tsx', line: 18, snippet: 'const planSteps = proposal.steps ?? [];' },
        ],
      },
    };

    const searchEnv = formatReactObservation(searchReceipt);
    expect(searchEnv.text).toContain('voiceSessionStore.ts:92');
    expect(searchEnv.text).toContain('DraftExecutionPlan');
    expect(searchEnv.estimatedTokens).toBeLessThanOrEqual(REACT_OBSERVATION_MAX_TOKENS);

    const findingReceipt: ActionReceipt = {
      actionIdx: 1,
      type: 'read_finding',
      ok: true,
      summaryEs: 'Recuperé el hallazgo del subagente Explorer.',
      data: {
        hashOrThreadId: '<<ccr:abcd1234>>',
        ccrHash: 'abcd1234',
        content: 'Hallazgo principal: run_check usa presets allowlisted.\nDetalle adicional confirmado.',
      },
    };

    const findingEnv = formatReactObservation(findingReceipt);
    expect(findingEnv.text).toContain('<<ccr:abcd1234>>');
    expect(findingEnv.text).toContain('presets allowlisted');
    expect(findingEnv.estimatedTokens).toBeLessThanOrEqual(REACT_OBSERVATION_MAX_TOKENS);
  });

  it('compacts oversized payloads deterministically and via formatReactObservationWithCtx', async () => {
    const hugeContent = Array.from({ length: 160 }, (_, i) => `fn item_${i}() -> Result<(), Error> { /* line ${i} */ }`).join('\n');
    const receipt: ActionReceipt = {
      actionIdx: 0,
      type: 'peek_files',
      ok: true,
      summaryEs: 'Inspeccioné archivo extenso.',
      data: {
        path: 'src-tauri/src/routines.rs',
        mode: 'full',
        content: hugeContent,
        ccrHash: 'deadbeef',
      },
    };

    const syncEnv = formatReactObservation(receipt);
    expect(syncEnv.truncated).toBe(true);
    expect(syncEnv.estimatedTokens).toBeLessThanOrEqual(REACT_OBSERVATION_MAX_TOKENS);
    expect(syncEnv.text).toContain('<<ccr:deadbeef>>');

    const asyncEnv = await formatReactObservationWithCtx(receipt);
    expect(asyncEnv.estimatedTokens).toBeLessThanOrEqual(REACT_OBSERVATION_MAX_TOKENS);
    expect(asyncEnv.text).toContain('routines.rs');
  });

  it('combines multiple hop receipts via formatReactObservationBatch', () => {
    const batch = formatReactObservationBatch([
      {
        actionIdx: 0,
        type: 'peek_agents',
        ok: true,
        summaryEs: 'Hay 1 subagente activo.',
        data: {
          subagents: [{ id: 'sub-1', role: 'Explorer', status: 'running', provider: 'claude' }],
          routines: [{ id: 'rot-1', name: 'Nightly QA', enabled: true }],
        },
      },
      {
        actionIdx: 1,
        type: 'peek_runs',
        ok: true,
        summaryEs: '1 ejecución reciente.',
        data: { runs: [{ turnId: 't-1', outcome: 'success' }] },
      },
    ]);

    expect(batch).toContain('[Observación peek_agents]');
    expect(batch).toContain('Explorer');
    expect(batch).toContain('[Observación peek_runs]');
  });
});
