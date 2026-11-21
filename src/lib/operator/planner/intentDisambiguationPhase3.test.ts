import { describe, it, expect, beforeEach, vi } from 'vitest';
import { normalizeSpanishVoiceStt } from './voiceNormalizer';
import { analyzeClausePolarity } from './clausePolarity';
import { planTurnHeuristic } from './heuristic';
import { runOperatorTurn } from '../index';
import type { PlannerProvider } from '../providers/types';
import { voiceSessionStore } from '../voice/voiceSessionStore';
import { resetWorkspaceSnapshotCacheForTests } from '../context/workspaceSnapshot';
import { resetEpisodicMemoryCacheForTests } from '../context/episodicMemory';
import * as ipc from '../../ipc';

describe('SETH Voice Mode — Phase 3 (Spanish STT Phonetics, Clause Polarity, Surface Matrix & Active Disambiguation)', () => {
  beforeEach(() => {
    localStorage.clear();
    voiceSessionStore.clearPendingDisambiguation('__default__');
    voiceSessionStore.clearPendingDisambiguation('ws-kite');
    voiceSessionStore.clearPendingDisambiguation('thr-voice');
    resetWorkspaceSnapshotCacheForTests();
    resetEpisodicMemoryCacheForTests();
    vi.restoreAllMocks();
  });

  it('S7: normalizeSpanishVoiceStt corrects Spanish voice homophones while preserving intent', () => {
    expect(normalizeSpanishVoiceStt('Oye Seth, abre un threat con Clot para armar el o de de').normalized).toBe(
      'abre un thread con claude para armar el ODD'
    );
    expect(normalizeSpanishVoiceStt('Lanza su agente con anti gráviti para revisar permisos').normalized).toBe(
      'Lanza subagente con antigravity para revisar permisos'
    );
    expect(normalizeSpanishVoiceStt('Sierra a Orion').normalized).toBe('Cierra a Orion');
    expect(normalizeSpanishVoiceStt('dos. Terminales con códec').normalized).toBe('dos Terminales con codex');
  });

  it('S7: analyzeClausePolarity separates mixed polarity ("no cierres X, abre Y") from full negation', () => {
    const pureNeg = analyzeClausePolarity('no cierres las terminales');
    expect(pureNeg.isEntireUtteranceNegated).toBe(true);
    expect(pureNeg.hasMixedPolarity).toBe(false);
    expect(pureNeg.allowsClose).toBe(false);

    const mixed = analyzeClausePolarity('no cierres las terminales, abre un hilo con claude para revisar auth');
    expect(mixed.isEntireUtteranceNegated).toBe(false);
    expect(mixed.hasMixedPolarity).toBe(true);
    expect(mixed.allowsClose).toBe(false);
    expect(mixed.affirmativeText.toLowerCase()).toContain('abre un hilo con claude');

    const mixedClose = analyzeClausePolarity('no abras terminales, cierra a Orion');
    expect(mixedClose.hasMixedPolarity).toBe(true);
    expect(mixedClose.allowsClose).toBe(true);
    expect(mixedClose.affirmativeText.toLowerCase()).toContain('cierra a orion');
  });

  it('S7: planTurnHeuristic handles mixed polarity and phonetic Spanish STT for threads & subagents', () => {
    const mixedPlan = planTurnHeuristic('No cierres las terminales, abre un threat con Clot para revisar auth');
    expect(mixedPlan.actions).toHaveLength(1);
    expect(mixedPlan.actions[0]).toMatchObject({
      type: 'launch_thread',
      provider: 'claude',
    });

    const subPlan = planTurnHeuristic('Oye Seth, lanza su agente con anti gráviti para armar el o de de de voz');
    expect(subPlan.actions).toHaveLength(1);
    expect(subPlan.actions[0]).toMatchObject({
      type: 'spawn_subagent',
      provider: 'antigravity',
      via: 'thread',
      oddMode: true,
    });

    // Subagent without named provider must NOT force cli: 'grok'
    const neutralSub = planTurnHeuristic('Lanza un subagente para revisar los tests');
    expect(neutralSub.actions[0]).toMatchObject({
      type: 'spawn_subagent',
      via: 'thread',
    });
    expect((neutralSub.actions[0] as any).cli).toBeUndefined();
  });

  it('S7: in Thread/Voice Mode, "abre un agente de Claude..." routes to LLM with workspace roster instead of hijacking to Code terminals', async () => {
    vi.spyOn(ipc, 'invokeCommand').mockResolvedValue({ id: 'agent-thread-1', status: 'submitted' } as any);
    const planSpy = vi.fn().mockResolvedValue({
      rawText: JSON.stringify({
        reply: 'Delegando la revisión al agente Security Auditor.',
        actions: [
          {
            type: 'launch_agent',
            agentQuery: 'Security Auditor',
            provider: 'claude',
            body: 'Revisar permisos del módulo auth',
            oddMode: true,
          },
        ],
      }),
      latencyMs: 50,
      model: 'test-model',
    });
    const mockProvider: PlannerProvider = { id: 'mock-llm', plan: planSpy };

    await runOperatorTurn('abre un agente de Claude para revisar permisos', {
      provider: mockProvider,
      context: {
        mode: 'thread',
        voiceSessionActive: true,
        workspaceId: 'ws-kite',
        autonomousAgents: [{ id: 'ag-1', name: 'Security Auditor', engine: 'claude', status: 'idle' }],
      },
    });

    // Must NOT have been hijacked by heuristic open_terminals!
    expect(planSpy).toHaveBeenCalledTimes(1);
  });

  it('S8: asks at most ONE concrete clarification question when critical slot is missing and resolves or cancels on next turn', async () => {
    const planSpy = vi.fn();
    const mockProvider: PlannerProvider = { id: 'mock-llm', plan: planSpy };

    // Turn 1: Ambiguous "cierra esa" when 2 terminals are active in the workspace
    const turn1 = await runOperatorTurn('cierra esa', {
      provider: mockProvider,
      context: {
        mode: 'thread',
        workspaceId: 'ws-kite',
        boundThreadId: 'thr-voice',
        activeTerminals: [
          { sessionId: 's1', who: 'Nova', engine: 'claude', idx: 1, workspaceId: 'ws-kite' },
          { sessionId: 's2', who: 'Orion', engine: 'grok', idx: 2, workspaceId: 'ws-kite' },
        ],
      },
    });

    expect(turn1.plan.actions).toEqual([]);
    expect(turn1.plan.clarification?.missingSlot).toBe('target');
    expect(turn1.reply).toContain('Nova');
    expect(turn1.reply).toContain('Orion');
    expect(voiceSessionStore.getPendingDisambiguation('thr-voice')).not.toBeNull();

    // Turn 2: User cancels -> clears pending disambiguation without calling LLM or closing anything
    const turn2 = await runOperatorTurn('déjalo', {
      provider: mockProvider,
      context: {
        mode: 'thread',
        workspaceId: 'ws-kite',
        boundThreadId: 'thr-voice',
      },
    });

    expect(turn2.plan.actions).toEqual([]);
    expect(turn2.reply).toMatch(/cancelada/i);
    expect(voiceSessionStore.getPendingDisambiguation('thr-voice')).toBeNull();
    expect(planSpy).not.toHaveBeenCalled();
  });

  it('S8: passes active PendingDisambiguation to LLM on follow-up turn and enforces anti-loop (max 1 question)', async () => {
    const capturedSystemPrompts: string[] = [];
    const mockProvider: PlannerProvider = {
      id: 'mock-llm',
      plan: vi.fn(async (messages) => {
        capturedSystemPrompts.push(messages[0]?.content || '');
        if (capturedSystemPrompts.length === 1) {
          return {
            rawText: JSON.stringify({
              answer: '¿A qué agente se lo delego: Security Auditor o Docs Writer?',
              actions: [],
              clarification: {
                question: '¿A qué agente se lo delego: Security Auditor o Docs Writer?',
                missingSlot: 'target',
                candidates: ['Security Auditor', 'Docs Writer'],
              },
            }),
            latencyMs: 40,
            model: 'test-model',
          };
        }
        return {
          rawText: JSON.stringify({
            answer: 'Listo, entendido.',
            actions: [],
          }),
          latencyMs: 40,
          model: 'test-model',
        };
      }),
    };

    const ctx = {
      mode: 'thread',
      workspaceId: 'ws-kite',
      boundThreadId: 'thr-voice',
      autonomousAgents: [
        { id: 'a1', name: 'Security Auditor', engine: 'claude', status: 'idle' },
        { id: 'a2', name: 'Docs Writer', engine: 'grok', status: 'idle' },
      ],
    };

    // Turn 1 asks 1 concrete question
    const t1 = await runOperatorTurn('delega la revisión de permisos', { provider: mockProvider, context: ctx });
    expect(t1.plan.actions).toEqual([]);
    expect(t1.reply).toContain('Security Auditor');
    expect(voiceSessionStore.getPendingDisambiguation('thr-voice')).not.toBeNull();

    // Turn 2 receives DESAMBIGUACIÓN PENDIENTE in system prompt and clears pending afterwards
    await runOperatorTurn('al Security Auditor', { provider: mockProvider, context: ctx });
    expect(capturedSystemPrompts[1]).toContain('DESAMBIGUACIÓN PENDIENTE DEL TURNO ANTERIOR');
    expect(capturedSystemPrompts[1]).toContain('NO hagas otra pregunta de aclaración consecutiva');
    expect(voiceSessionStore.getPendingDisambiguation('thr-voice')).toBeNull();
  });
});
