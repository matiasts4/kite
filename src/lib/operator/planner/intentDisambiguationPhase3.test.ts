import { describe, it, expect, beforeEach, vi } from 'vitest';
import { normalizeSpanishVoiceStt } from './voiceNormalizer';
import { analyzeClausePolarity } from './clausePolarity';
import { planTurnHeuristic } from './heuristic';
import {
  buildPendingDisambiguationState,
  detectPreExecutionDisambiguation,
  isProposalCancellation,
  isProposalConfirmation,
  resolvePendingDisambiguationReply,
} from './disambiguation';
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
    voiceSessionStore.clearDraftProposal('thr-voice');
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

  it('S4.1/T6: disambiguates inject_prompt on deictic targets ("esa terminal", "ahí", "al agente") or missing target', () => {
    const context = {
      mode: 'code',
      workspaceId: 'ws-kite',
      activeTerminals: [
        { sessionId: 's1', who: 'Nova', engine: 'grok', idx: 1, workspaceId: 'ws-kite' },
        { sessionId: 's2', who: 'Orion', engine: 'claude', idx: 2, workspaceId: 'ws-kite' },
      ],
    };

    const deicticClarification = detectPreExecutionDisambiguation(
      'corre npm test ahí',
      {
        strategy: 'llm',
        actions: [{ type: 'inject_prompt', target: 'ahí', prompt: 'npm test' }],
      },
      context
    );
    expect(deicticClarification).not.toBeNull();
    expect(deicticClarification?.missingSlot).toBe('target');
    expect(deicticClarification?.candidates).toEqual(['Nova', 'Orion']);
    expect(deicticClarification?.question).toContain('Nova');
    expect(deicticClarification?.question).toContain('Orion');
    expect(deicticClarification?.draftAction).toMatchObject({
      type: 'inject_prompt',
      prompt: 'npm test',
    });

    // Zod default target=1 when raw input only says "al agente" with no terminal index/name
    const defaultedClarification = detectPreExecutionDisambiguation(
      'mándale git status al agente',
      {
        strategy: 'llm',
        actions: [{ type: 'inject_prompt', target: 1, prompt: 'git status' }],
      },
      context
    );
    expect(defaultedClarification?.missingSlot).toBe('target');
    expect(defaultedClarification?.candidates).toEqual(['Nova', 'Orion']);
  });

  it('S4.1/T6: disambiguates inject_prompt and handoff_to_agent when multiple terminals share the same engine', () => {
    const context = {
      mode: 'code',
      workspaceId: 'ws-kite',
      activeTerminals: [
        { sessionId: 's1', who: 'Nova', engine: 'grok', idx: 1, workspaceId: 'ws-kite' },
        { sessionId: 's2', who: 'Vega', engine: 'grok', idx: 2, workspaceId: 'ws-kite' },
        { sessionId: 's3', who: 'Echo', engine: 'claude', idx: 3, workspaceId: 'ws-kite' },
      ],
    };

    // Two grok terminals active -> "grok" is ambiguous
    const injectSharedEngine = detectPreExecutionDisambiguation(
      'en la terminal de grok corre vitest',
      {
        strategy: 'llm',
        actions: [{ type: 'inject_prompt', target: 'grok', prompt: 'vitest' }],
      },
      context
    );
    expect(injectSharedEngine?.missingSlot).toBe('target');
    expect(injectSharedEngine?.candidates).toEqual(['Nova', 'Vega']);
    expect(injectSharedEngine?.question).toContain('grok');

    // Only one claude terminal active -> "claude" is unambiguous
    const injectUniqueEngine = detectPreExecutionDisambiguation(
      'en claude corre vitest',
      {
        strategy: 'llm',
        actions: [{ type: 'inject_prompt', target: 'claude', prompt: 'vitest' }],
      },
      context
    );
    expect(injectUniqueEngine).toBeNull();

    // Handoff source shared-engine ambiguity
    const handoffSourceAmbiguity = detectPreExecutionDisambiguation(
      'pásale el ODD de grok a un nuevo agente de claude',
      {
        strategy: 'heuristic',
        actions: [
          {
            type: 'handoff_to_agent',
            sourceTarget: 'grok',
            targetEngine: 'claude',
            spawnNew: true,
            artifactKind: 'odd',
          },
        ],
      },
      context
    );
    expect(handoffSourceAmbiguity?.missingSlot).toBe('target');
    expect(handoffSourceAmbiguity?.candidates).toEqual(['Nova', 'Vega']);

    // Handoff existing targetSession deictic ambiguity (spawnNew: false)
    const handoffTargetAmbiguity = detectPreExecutionDisambiguation(
      'pásale el ODD de Echo a esa terminal',
      {
        strategy: 'llm',
        actions: [
          {
            type: 'handoff_to_agent',
            sourceTarget: 'Echo',
            targetSession: 'esa terminal',
            spawnNew: false,
            artifactKind: 'odd',
          },
        ],
      },
      context
    );
    expect(handoffTargetAmbiguity?.missingSlot).toBe('target');
    expect(handoffTargetAmbiguity?.candidates).toEqual(['Nova', 'Vega', 'Echo']);

    // Spawning a new claude agent from an unambiguous source should NOT trigger ambiguity
    const handoffSpawnNewClear = detectPreExecutionDisambiguation(
      'pásale el ODD de Nova a un nuevo agente de claude',
      {
        strategy: 'heuristic',
        actions: [
          {
            type: 'handoff_to_agent',
            sourceTarget: 'Nova',
            targetEngine: 'claude',
            spawnNew: true,
            artifactKind: 'odd',
          },
        ],
      },
      context
    );
    expect(handoffSpawnNewClear).toBeNull();
  });

  it('S4.1/T6: supports multi-slot partial resolution when reply resolves target or task slot', () => {
    const context = {
      mode: 'code',
      workspaceId: 'ws-kite',
      activeTerminals: [
        { sessionId: 's1', who: 'Nova', engine: 'grok', idx: 1, workspaceId: 'ws-kite' },
        { sessionId: 's2', who: 'Orion', engine: 'claude', idx: 2, workspaceId: 'ws-kite' },
      ],
    };

    const initialClarification = detectPreExecutionDisambiguation(
      'inyecta ahí',
      {
        strategy: 'llm',
        actions: [{ type: 'inject_prompt', target: 'ahí', prompt: '' }],
      },
      context
    );
    expect(initialClarification?.missingSlot).toBe('target');

    const pendingTurn1 = buildPendingDisambiguationState('inyecta ahí', initialClarification!);

    // Partial reply: resolves target terminal ("a Orion"), but prompt/task is still missing
    const partial = resolvePendingDisambiguationReply('a Orion', pendingTurn1, context);
    expect(partial.status).toBe('partial');
    expect(partial.resolvedSlots).toEqual(['target']);
    expect(partial.missingSlots).toEqual(['task']);
    expect(partial.draftAction).toMatchObject({
      type: 'inject_prompt',
      target: 'Orion',
    });
    expect(partial.nextClarification?.missingSlot).toBe('task');
    expect(partial.nextClarification?.question).toContain('Orion');

    // Follow-up reply resolves the remaining task slot
    const pendingTurn2 = buildPendingDisambiguationState('a Orion', partial.nextClarification!);
    const completed = resolvePendingDisambiguationReply('corre npx vitest run', pendingTurn2, context);
    expect(completed.status).toBe('resolved');
    expect(completed.resolvedSlots).toEqual(['task']);
    expect(completed.missingSlots).toEqual([]);
    expect(completed.draftAction).toMatchObject({
      type: 'inject_prompt',
      target: 'Orion',
      prompt: 'corre npx vitest run',
    });

    // Single reply resolving BOTH target and task slots at once
    const combined = resolvePendingDisambiguationReply(
      'en la terminal 2 ejecuta git status',
      pendingTurn1,
      context
    );
    expect(combined.status).toBe('resolved');
    expect(combined.resolvedSlots).toEqual(['target', 'task']);
    expect(combined.draftAction).toMatchObject({
      type: 'inject_prompt',
      target: 'Orion',
      prompt: 'ejecuta git status',
    });
  });

  it('matches natural Spanish proposal confirmations at L0 while sending refinements and negations to their respective paths', async () => {
    expect(isProposalConfirmation('sí, quiero que lo lances.')).toBe(true);
    expect(isProposalConfirmation('sí, dale')).toBe(true);
    expect(isProposalConfirmation('sí, hazlo por favor')).toBe(true);
    expect(isProposalConfirmation('claro, lánzalo')).toBe(true);
    expect(isProposalConfirmation('quiero que lances el subagente')).toBe(true);

    // Refinements and negations must never be treated as bare confirmations
    expect(isProposalConfirmation('sí, pero hazlo con Claude')).toBe(false);
    expect(isProposalConfirmation('sí, mejor que arme el ODD')).toBe(false);
    expect(isProposalConfirmation('no lo lances')).toBe(false);
    expect(isProposalConfirmation('no, mejor no')).toBe(false);

    expect(isProposalCancellation('no, déjalo')).toBe(true);
    expect(isProposalCancellation('no, mejor no')).toBe(true);
    expect(isProposalCancellation('no, cancélalo')).toBe(true);

    vi.spyOn(ipc, 'invokeCommand').mockResolvedValue({
      status: 'queued',
      address: 'thread:sub-thr-1',
      threadId: 'sub-thr-1',
    } as any);

    const planSpy = vi.fn();
    const mockProvider: PlannerProvider = { id: 'antigravity', plan: planSpy };

    voiceSessionStore.setDraftProposal('thr-voice', {
      proposalId: 'prop-1795651197444-4m8i',
      status: 'awaiting_confirmation',
      targetKind: 'subagent',
      title: 'Corregir recorte superior del aura del asistente',
      taskBrief:
        'Localizar el componente de animación del asistente y revisar el recorte superior.',
      questionForUser:
        '¿Quieres que lance un subagente para localizar el componente del asistente y revisar ese recorte en el desvanecimiento superior?',
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    try {
      const turn = await runOperatorTurn('sí, quiero que lo lances.', {
        provider: mockProvider,
        context: {
          mode: 'thread',
          voiceSessionActive: true,
          workspaceId: 'ws-kite',
          boundThreadId: 'thr-voice',
        },
      });

      expect(planSpy).not.toHaveBeenCalled();
      expect(turn.strategy).toBe('heuristic');
      expect(turn.overallSuccess).toBe(true);
      expect(turn.plan.actions).toEqual([
        { type: 'confirm_proposal', proposalId: 'prop-1795651197444-4m8i' },
      ]);
      expect(turn.receipts[0]?.type).toBe('confirm_proposal');
      expect(turn.receipts[0]?.ok).toBe(true);
    } finally {
      voiceSessionStore.clearDraftProposal('thr-voice');
    }
  });
});
