import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as ipc from '../../../ipc';
import { executePlan } from '../index';
import { voiceSessionStore } from '../../voice/voiceSessionStore';
import { saveArgosMemoryNotes } from '../../operatorConfig';

vi.mock('../../../ipc', () => ({
  isTauriEnvironment: vi.fn(() => true),
  invokeCommand: vi.fn().mockResolvedValue({}),
  getTicketSnapshot: vi.fn().mockResolvedValue({ schemaVersion: 1, revision: 1, issues: [] }),
  ticketCall: vi.fn().mockResolvedValue({
    ok: true,
    result: { id: 'KITE-201', title: 'QA Plan Step', state: 'To Do' },
  }),
  readWorkspaceChanges: vi.fn().mockResolvedValue({
    isRepo: true,
    branch: 'feat/response-thread',
    workspacePrefix: '',
    upstream: null,
    files: [],
  }),
}));

describe('S7 / T6 — Multi-Step DraftExecutionPlan Lifecycle & Execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    voiceSessionStore.clearDraftProposal('thread-multi-1');
    vi.mocked(ipc.isTauriEnvironment).mockReturnValue(true);
  });

  it('creates multi-step DraftExecutionPlan, refines a specific stepIndex, and disables steps cleanly', async () => {
    const proposeRes = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'propose_task',
            targetKind: 'subagent',
            title: 'Flujo completo',
            taskBrief: 'Ejecutar pasos encadenados',
            steps: [
              {
                stepId: 'step-1',
                title: 'Revisar cambios',
                action: { type: 'peek_changes', includeDiff: false },
              },
              {
                stepId: 'step-2',
                title: 'Guardar nota',
                action: {
                  type: 'manage_memory',
                  operation: 'remember',
                  text: 'Plan multi-paso ejecutado',
                },
                dependsOn: ['step-1'],
              },
              {
                stepId: 'step-3',
                title: 'Crear tarea',
                action: {
                  type: 'manage_tasks',
                  operation: 'create',
                  title: 'QA Plan Step',
                },
                dependsOn: ['step-1'],
              },
            ],
          },
        ],
      },
      { boundThreadId: 'thread-multi-1', workspaceId: 'ws-1' }
    );

    expect(proposeRes.overallSuccess).toBe(true);
    const created = voiceSessionStore.getDraftProposal('thread-multi-1');
    expect(created?.steps).toHaveLength(3);
    expect(created?.steps?.[0].status).toBe('pending');

    // Voice refinement: disable step 3 and rename step 2
    const refineRes = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'refine_proposal',
            stepIndex: 3,
            stepEnabled: false,
          },
          {
            type: 'refine_proposal',
            stepIndex: 2,
            stepTitle: 'Persistir nota del plan',
          },
        ],
      },
      { boundThreadId: 'thread-multi-1', workspaceId: 'ws-1' }
    );

    expect(refineRes.overallSuccess).toBe(true);
    const refined = voiceSessionStore.getDraftProposal('thread-multi-1');
    expect(refined?.steps?.[2].enabled).toBe(false);
    expect(refined?.steps?.[1].title).toBe('Persistir nota del plan');
    expect(refined?.steps?.[0].enabled).toBe(true);
  });

  it('executes enabled steps respecting dependsOn, skips disabled steps, and parallelizes independent waves', async () => {
    saveArgosMemoryNotes([]);
    await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'propose_task',
            targetKind: 'subagent',
            title: 'Plan con dependencias',
            taskBrief: 'Correr wave 1 y luego wave 2 en paralelo',
            steps: [
              {
                stepId: 's1',
                title: 'Inspeccionar cambios',
                action: { type: 'peek_changes' },
                enabled: true,
              },
              {
                stepId: 's2',
                title: 'Guardar recuerdo',
                action: {
                  type: 'manage_memory',
                  operation: 'remember',
                  text: 'Wave 2 completada',
                },
                dependsOn: ['s1'],
                enabled: true,
              },
              {
                stepId: 's3',
                title: 'Crear ticket',
                action: {
                  type: 'manage_tasks',
                  operation: 'create',
                  title: 'QA Plan Step',
                },
                dependsOn: ['s1'],
                enabled: true,
              },
              {
                stepId: 's4',
                title: 'Paso opcional deshabilitado',
                action: { type: 'manage_tasks', operation: 'list' },
                enabled: false,
              },
            ],
          },
        ],
      },
      { boundThreadId: 'thread-multi-1', workspaceId: 'ws-1' }
    );

    const confirmRes = await executePlan(
      {
        strategy: 'llm',
        actions: [{ type: 'confirm_proposal' }],
      },
      { boundThreadId: 'thread-multi-1', workspaceId: 'ws-1' }
    );

    expect(confirmRes.overallSuccess).toBe(true);
    const data = confirmRes.receipts[0].data as any;
    expect(data.multiStep).toBe(true);
    expect(data.stepResults).toHaveLength(4);
    expect(data.stepResults.find((s: any) => s.stepId === 's1').status).toBe('done');
    expect(data.stepResults.find((s: any) => s.stepId === 's2').status).toBe('done');
    expect(data.stepResults.find((s: any) => s.stepId === 's3').status).toBe('done');
    expect(data.stepResults.find((s: any) => s.stepId === 's4').status).toBe('skipped');
    expect(ipc.ticketCall).toHaveBeenCalledTimes(1);
    expect(confirmRes.receipts[0].spokenSummaryEs).toContain('3 de 3');
  });

  it('marks dependent steps as skipped when an upstream step fails', async () => {
    vi.mocked(ipc.ticketCall).mockResolvedValueOnce({ ok: false });

    await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'propose_task',
            targetKind: 'subagent',
            title: 'Plan con fallo en cadena',
            taskBrief: 'Paso 1 falla y Paso 2 debe omitirse',
            steps: [
              {
                stepId: 'fail-step',
                title: 'Crear ticket que falla',
                action: {
                  type: 'manage_tasks',
                  operation: 'create',
                  title: 'Fallará',
                },
              },
              {
                stepId: 'dep-step',
                title: 'Paso dependiente',
                action: {
                  type: 'manage_memory',
                  operation: 'remember',
                  text: 'No debería ejecutarse',
                },
                dependsOn: ['fail-step'],
              },
            ],
          },
        ],
      },
      { boundThreadId: 'thread-multi-1', workspaceId: 'ws-1' }
    );

    const confirmRes = await executePlan(
      {
        strategy: 'llm',
        actions: [{ type: 'confirm_proposal' }],
      },
      { boundThreadId: 'thread-multi-1', workspaceId: 'ws-1' }
    );

    expect(confirmRes.overallSuccess).toBe(false);
    const results = (confirmRes.receipts[0].data as any).stepResults;
    expect(results.find((s: any) => s.stepId === 'fail-step').status).toBe('failed');
    expect(results.find((s: any) => s.stepId === 'dep-step').status).toBe('skipped');
  });
});
