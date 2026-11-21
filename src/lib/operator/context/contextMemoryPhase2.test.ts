import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  filterTerminalsForWorkspace,
  filterThreadsForWorkspace,
  formatWorkspaceRosterForPrompt,
  resetWorkspaceSnapshotCacheForTests,
} from './workspaceSnapshot';
import {
  loadWorkspaceEpisodicMemory,
  recordDelegation,
  reconcileDelegationsWithContext,
  formatEpisodicMemoryForPrompt,
  saveSessionClosureSummary,
  resetEpisodicMemoryCacheForTests,
} from './episodicMemory';
import { buildOperatorSystemPrompt } from '../planner/prompt';
import { saveZedMemoryNotes, saveOperatorConfig, DEFAULT_OPERATOR_CONFIG } from '../operatorConfig';
import { consultChats, type ChatIndexEntry } from '../chatIndex';
import { executeNarrateAction } from '../executor/actions/narrate';
import * as terminalRegistry from '../../terminalRegistry';

describe('SETH Voice Mode — Phase 2 (Workspace Isolation, Unified Inspection, Episodic Memory & Temporal Recall)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetWorkspaceSnapshotCacheForTests();
    resetEpisodicMemoryCacheForTests();
    vi.restoreAllMocks();
  });

  it('S5: strictly isolates terminals, threads, and local notes to the active workspace without leaking orphan/foreign items', () => {
    const terminals = [
      { sessionId: 't-a', workspaceId: 'ws-alpha', who: 'Nova' },
      { sessionId: 't-b', workspaceId: 'ws-beta', who: 'Orion' },
      { sessionId: 't-orphan', workspaceId: null, who: 'Ghost' },
    ];
    expect(filterTerminalsForWorkspace(terminals, 'ws-alpha').map((t) => t.who)).toEqual(['Nova']);

    const chats: any[] = [
      { id: 'c-a', title: 'Auth alpha', workspaceId: 'ws-alpha', provider: 'claude', status: 'running', updatedAtUnixMs: 200 },
      { id: 'c-b', title: 'Billing beta', workspaceId: 'ws-beta', provider: 'grok', status: 'idle', updatedAtUnixMs: 300 },
      { id: 'c-null', title: 'Unscoped', workspaceId: null, provider: 'codex', status: 'idle', updatedAtUnixMs: 400 },
    ];
    expect(filterThreadsForWorkspace(chats, 'ws-alpha').map((c) => c.id)).toEqual(['c-a']);

    saveZedMemoryNotes([
      { id: 'n1', content: 'Nota exclusiva de Alpha', createdAt: '2026-11-20', workspace: 'ws-alpha' },
      { id: 'n2', content: 'Nota secreta de Beta', createdAt: '2026-11-20', workspace: 'ws-beta' },
      { id: 'n3', content: 'Nota global compartida', createdAt: '2026-11-20' },
    ]);

    const prompt = buildOperatorSystemPrompt({
      workspaceId: 'ws-alpha',
      workspaceName: 'Alpha',
      mode: 'thread',
      activeTerminals: [{ sessionId: 't-a', who: 'Nova', engine: 'claude', state: 'working' }],
      activeThreads: [{ id: 'c-a', title: 'Auth alpha', provider: 'claude', status: 'running', updatedAtUnixMs: 200 }],
      activeSubagents: [{ id: 's-a', role: 'ODD Planner', provider: 'antigravity', status: 'running', updatedAtUnixMs: 250 }],
      autonomousAgents: [{ id: 'ag-1', name: 'Security Auditor', engine: 'claude', status: 'idle' }],
    });

    expect(prompt).toContain('Nota exclusiva de Alpha');
    expect(prompt).toContain('Nota global compartida');
    expect(prompt).not.toContain('Nota secreta de Beta');
    expect(prompt).toContain('Auth alpha');
    expect(prompt).toContain('ODD Planner');
    expect(prompt).toContain('Security Auditor');
    expect(prompt).not.toContain('Billing beta');
  });

  it('S4/S5: wires configured SETH persona identity and concise roster into buildOperatorSystemPrompt', () => {
    saveOperatorConfig({
      ...DEFAULT_OPERATOR_CONFIG,
      persona: {
        ...DEFAULT_OPERATOR_CONFIG.persona,
        name: 'SETH',
        builderCallMe: 'Alan',
        tone: 'direct',
        standingInstructions: 'Priorizar arquitectura limpia.',
      },
    });

    const prompt = buildOperatorSystemPrompt({
      workspaceId: 'ws-kite',
      workspaceName: 'kite',
      gitBranch: 'feat/response-thread',
      mode: 'thread',
    });

    expect(prompt).toContain('Eres SETH');
    expect(prompt).toContain('Alan');
    expect(prompt).toContain('feat/response-thread');
    expect(prompt).toContain('Priorizar arquitectura limpia.');
  });

  it('S5/S6: executeNarrateAction inspects subagents, autonomous agents, threads, and delegation ledger when target is not a PTY terminal', async () => {
    vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockReturnValue([]);

    // 1. Subagent named Nova
    const subReceipt = await executeNarrateAction({ target: 'Nova' }, 0, {
      workspaceId: 'ws-kite',
      activeSubagents: [
        { id: 'sub-1', role: 'Nova', provider: 'antigravity', status: 'running', updatedAtUnixMs: 1000 },
      ],
    });
    expect(subReceipt.ok).toBe(true);
    expect(subReceipt.summaryEs).toMatch(/subagente Nova.*trabajando activamente/i);

    // 2. Autonomous Agent named Security Auditor
    const agentReceipt = await executeNarrateAction({ target: 'Security Auditor' }, 0, {
      workspaceId: 'ws-kite',
      autonomousAgents: [
        { id: 'ag-1', name: 'Security Auditor', engine: 'claude', status: 'waiting' },
      ],
    });
    expect(agentReceipt.ok).toBe(true);
    expect(agentReceipt.summaryEs).toMatch(/agente autónomo Security Auditor.*esperando tu confirmación/i);

    // 3. Reconciled delegation ledger entry
    await recordDelegation('ws-kite', {
      kind: 'thread',
      name: 'Migración Auth',
      provider: 'claude',
      resourceId: 'thr-99',
      taskSummary: 'Migrar tokens OAuth',
      status: 'completed',
      outcomeSummary: 'Tests en verde',
    });
    const ledgerReceipt = await executeNarrateAction({ target: 'Migración Auth' }, 0, {
      workspaceId: 'ws-kite',
    });
    expect(ledgerReceipt.ok).toBe(true);
    expect(ledgerReceipt.summaryEs).toMatch(/Migración Auth.*ya terminó su tarea/i);
  });

  it('S6: persists workspace episodic memory across sessions and reconciles stale delegations with live state', async () => {
    const now = 1_750_000_000_000;
    await recordDelegation('ws-alpha', {
      kind: 'terminal',
      name: 'Nova',
      provider: 'claude',
      resourceId: 'sess-nova',
      taskSummary: 'Correr suite de integración',
      status: 'running',
      createdAt: now - 30 * 60 * 60 * 1000,
      updatedAt: now - 26 * 60 * 60 * 1000,
    });

    await saveSessionClosureSummary('ws-alpha', 'ses-yesterday', [
      {
        turnId: 't1',
        userPrompt: 'Lanza un hilo para refactorizar audio',
        source: 'voz',
        reply: 'Hilo creado.',
        receipts: [{ actionIdx: 0, type: 'launch_thread', ok: true, summaryEs: 'Hilo de refactor de audio creado.' }],
        createdAt: now - 24 * 60 * 60 * 1000,
      },
    ]);

    // Simulate reload (clear in-memory cache; read back from workspace-scoped persistence)
    resetEpisodicMemoryCacheForTests();
    const reloadedAlpha = await loadWorkspaceEpisodicMemory('ws-alpha');
    const reloadedBeta = await loadWorkspaceEpisodicMemory('ws-beta');

    expect(reloadedAlpha.delegations).toHaveLength(1);
    expect(reloadedAlpha.sessions).toHaveLength(1);
    expect(reloadedBeta.delegations).toHaveLength(0);
    expect(reloadedBeta.sessions).toHaveLength(0);

    // Reconcile against live context where terminal Nova already closed -> status transitions to completed!
    const reconciled = reconcileDelegationsWithContext(reloadedAlpha.delegations, {
      workspaceId: 'ws-alpha',
      activeTerminals: [],
    });
    expect(reconciled[0].status).toBe('completed');

    const promptBlock = formatEpisodicMemoryForPrompt(reloadedAlpha, { workspaceId: 'ws-alpha', activeTerminals: [] }, now);
    expect(promptBlock).toContain('MEMORIA EPISÓDICA DEL PROYECTO ACTUAL');
    expect(promptBlock).toContain('Nova (completed, ayer)');
    expect(promptBlock).toContain('Hilo de refactor de audio creado');
  });

  it('S6: consultChats resolves "continúa lo de ayer" to yesterday session without reading other chats', async () => {
    const now = 1_750_000_000_000;
    const HOUR = 60 * 60 * 1000;
    const entries: ChatIndexEntry[] = [
      { id: 'c-old', title: 'Setup inicial', cli: 'claude', updatedAtUnixMs: now - 120 * HOUR },
      { id: 'c-yesterday', title: 'Refactor voz SETH', cli: 'antigravity', updatedAtUnixMs: now - 22 * HOUR },
      { id: 'c-now', title: 'Chat actual', cli: 'grok', updatedAtUnixMs: now - 1 * HOUR },
    ];
    const readIds: string[] = [];
    const reader = {
      read(id: string) {
        readIds.push(id);
        return `Contenido de ${id}`;
      },
    };

    const res = await consultChats('continúa lo de ayer', { entries }, reader, { nowMs: now });
    expect(res.kind).toBe('read');
    expect(readIds).toEqual(['c-yesterday']);
    if (res.kind === 'read') {
      expect(res.entry.id).toBe('c-yesterday');
    }
  });

  it('S5: formatWorkspaceRosterForPrompt keeps output compact and strictly bounded', () => {
    const roster = formatWorkspaceRosterForPrompt({
      workspaceId: 'ws-1',
      activeTerminals: Array.from({ length: 12 }, (_, i) => ({
        sessionId: `s-${i}`,
        who: `Agent${i}`,
        engine: 'claude',
        state: 'working',
      })),
    });
    expect(roster).toContain('Terminales activas en este proyecto (8):');
    expect(roster).not.toContain('Agent9');
  });
});
