import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ChatComposer } from './ChatComposer';
import { ChatItemRow } from './ChatItemRow';
import {
  buildVoiceSessionBoundaryItem,
  buildVoiceSessionSummaryItem,
  computeKaraokeWordProgress,
  flushPendingVoiceTranscriptTail,
  formatWorkedForLabel,
  liveVoiceStageItem,
  mergeTimeline,
  voiceTurnsToChatItems,
} from './voiceTranscript';
import { ConsultativeDraftCard } from './ConsultativeDraftCard';
import { ZedStripHost } from '../../ZedStrip';
import { voiceSessionStore } from '../../../lib/operator/voice/voiceSessionStore';
import { declarationFromCatalog } from './driverDeclaration';

vi.mock('../../../lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/ipc')>();
  return {
    ...actual,
    listConnections: vi.fn(async () => []),
    invokeCommand: vi.fn(async (cmd: string) => {
      if (cmd === 'read_dictation_availability') {
        return { canStart: true, canRequestPermission: false, guidance: '' };
      }
      if (cmd === 'start_dictation') return { ok: true };
      if (cmd === 'stop_dictation') return { ok: true };
      if (cmd === 'read_dictation') {
        return { phase: 'done', transcript: 'texto dictado' };
      }
      return {};
    }),
  };
});

vi.mock('../../../lib/operator/operatorConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/operator/operatorConfig')>();
  return {
    ...actual,
    loadOperatorConfig: () => ({
      ...actual.DEFAULT_OPERATOR_CONFIG,
      activeProvider: 'grok',
      ttsEngine: 'elevenlabs',
      persona: {
        ...actual.DEFAULT_ZED_PERSONA,
        name: 'Zed',
        voice: 'Ara',
        language: 'es',
      },
    }),
  };
});

describe('Thread Voice Mode — Integration & Surface Tests', () => {
  beforeEach(() => {
    voiceSessionStore.stopSession();
    voiceSessionStore.setMicMuted(false);
    voiceSessionStore.setSpeakerMuted(false);
    vi.clearAllMocks();
  });

  const baseComposerProps = {
    threadId: 'thread-test-vm',
    threadMode: 'fullAccess' as const,
    threadProvider: 'claude' as const,
    threadModel: 'claude-3-5-sonnet',
    declaration: declarationFromCatalog({ provider: 'claude', selectedModel: 'claude-3-5-sonnet' }),
    running: false,
    prompt: '',
    attachments: [],
    totalTokens: 1200,
    onChangePrompt: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    onPickAttachments: vi.fn(),
    onStageFiles: vi.fn(),
    onStagePaths: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onUpdateConfig: vi.fn(),
  };

  it('renders 32px Voice Mode trigger button in thread composer next to dictation (S1, S7)', () => {
    render(<ChatComposer {...baseComposerProps} />);

    const voiceBtn = screen.getByLabelText('Iniciar sesión de voz');
    expect(voiceBtn).toBeInTheDocument();
    expect(voiceBtn).toHaveClass('chat-voice-mode-control');
    expect(voiceBtn).toHaveClass('size-8'); // 32px standard control height
  });

  it('clicking Voice Mode button enters active voice mode and swaps footer (S1, S2)', () => {
    render(<ChatComposer {...baseComposerProps} />);

    const voiceBtn = screen.getByLabelText('Iniciar sesión de voz');
    fireEvent.click(voiceBtn);

    expect(voiceSessionStore.getSnapshot().phase).toBe('active');
    expect(voiceSessionStore.getSnapshot().boundThreadId).toBe('thread-test-vm');

    // Live voice status from VoiceModeFooterBar is displayed without Zed/model pills
    expect(screen.getByTestId('voice-live-status-pill')).toHaveTextContent('Escuchando en vivo');
    expect(screen.queryByTestId('voice-locked-assistant-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('voice-engine-badge')).not.toBeInTheDocument();
    // Normal model picker popover is hidden
    expect(screen.queryByTestId('model-picker-trigger')).not.toBeInTheDocument();
  });

  it('changes textarea placeholder to "Escribir en la sesión de voz…" while in Voice Mode (S3)', () => {
    voiceSessionStore.startSession('thread-test-vm', 'thread');

    render(<ChatComposer {...baseComposerProps} />);

    const textarea = screen.getByPlaceholderText('Escribir en la sesión de voz…');
    expect(textarea).toBeInTheDocument();
  });

  it('dispatches hybrid typed text to onSendVoiceTurn when submitted in Voice Mode (S3)', () => {
    voiceSessionStore.startSession('thread-test-vm', 'thread');
    const onSendVoiceTurn = vi.fn();

    render(
      <ChatComposer
        {...baseComposerProps}
        prompt="Abrime dos terminales con Grok"
        onSendVoiceTurn={onSendVoiceTurn}
      />
    );

    // Primary Send button appears because prompt is non-empty
    const sendBtn = screen.getByLabelText('Enviar a la sesión de voz');
    expect(sendBtn).toBeInTheDocument();

    fireEvent.click(sendBtn);
    expect(onSendVoiceTurn).toHaveBeenCalledWith('Abrime dos terminales con Grok');
  });

  it('mounts ComposerVoiceGlow when active and displays voice-error-tip with permission recovery (S1, S4)', async () => {
    const { invokeCommand } = await import('../../../lib/ipc');
    render(<ChatComposer {...baseComposerProps} />);

    expect(screen.queryByTestId('voice-speaking-glow')).not.toBeInTheDocument();

    act(() => {
      voiceSessionStore.setVoiceError({
        message: 'Permiso de micrófono requerido',
        at: Date.now(),
        openPrivacySettings: true,
      });
    });

    const tip = screen.getByTestId('voice-error-tip');
    expect(tip).toHaveTextContent('Permiso de micrófono requerido');
    const permBtn = screen.getByRole('button', { name: 'Permiso de micrófono' });
    fireEvent.click(permBtn);
    expect(invokeCommand).toHaveBeenCalledWith('request_dictation_permission');

    const closeBtn = screen.getByLabelText('Cerrar aviso de micrófono');
    fireEvent.click(closeBtn);
    expect(screen.queryByTestId('voice-error-tip')).not.toBeInTheDocument();

    act(() => {
      voiceSessionStore.startSession('thread-test-vm', 'thread');
    });
    expect(screen.getByTestId('voice-speaking-glow')).toHaveAttribute('data-active', 'true');
  });

  it('pauses continuous voice microphone during one-shot dictation and resumes after (S1)', async () => {
    // Continuous voice session is active in the background (e.g. on orb surface)
    voiceSessionStore.startSession(null, 'orb');
    expect(voiceSessionStore.getSnapshot().isPausedForDictation).toBe(false);

    render(<ChatComposer {...baseComposerProps} />);

    // Click dictation button in thread composer
    const dictateBtn = screen.getByLabelText('Dictate message');
    await fireEvent.click(dictateBtn);

    // Continuous voice is paused during dictation
    expect(voiceSessionStore.getSnapshot().isPausedForDictation).toBe(true);

    // Wait for dictation poll to finish and resume
    await waitFor(() => {
      expect(voiceSessionStore.getSnapshot().isPausedForDictation).toBe(false);
    });
  });

  it('projects voice turns as standard chat items: user, consult, action receipts, assistant (S4)', () => {
    const items = voiceTurnsToChatItems([
      {
        turnId: 'turn-101',
        userPrompt: 'Abrime dos terminales con Grok',
        source: 'voz',
        overallSuccess: true,
        receipts: [
          { actionIdx: 0, type: 'open_terminals', ok: true, summaryEs: '2 terminales con Grok abiertas', durationMs: 140 },
          { actionIdx: 1, type: 'launch_thread', ok: false, summaryEs: 'Hilo con Claude para auth', durationMs: 200 },
        ],
        consultChatsInfo: { kind: 'read', title: 'Configuracion de auth', cli: 'claude' },
        reply: 'Abrí 2 terminales con Grok.',
        createdAt: 1000,
      },
    ]);

    expect(items.map((item) => item.kind)).toEqual(['user', 'tool', 'tool', 'tool', 'assistant']);
    expect(items[0].text).toBe('Abrime dos terminales con Grok');
    expect(items[0].inputSource).toBe('voice');
    expect(items[1].title).toBe('Leyó el chat «Configuracion de auth»');
    expect(items[2]).toMatchObject({ title: '2 terminales con Grok abiertas', status: 'completed' });
    expect(items[3]).toMatchObject({ title: 'Hilo con Claude para auth', status: 'failed' });
    expect(items[4].text).toBe('Abrí 2 terminales con Grok.');
  });

  it('renders the live stage as a streaming reasoning item and interleaves by time (S4)', () => {
    const live = liveVoiceStageItem({ turnId: 'turn-9', stage: 'executing', detail: 'Ejecutando open_terminals…' });
    expect(live).toMatchObject({ kind: 'reasoning', streaming: true, text: 'Ejecutando open_terminals…' });

    const provider = [{ ...live, id: 'p1', kind: 'user' as const, streaming: false, createdAtUnixMs: 2000, text: 'hola' }];
    const voice = voiceTurnsToChatItems([
      { turnId: 't-early', userPrompt: 'antes', source: 'texto', createdAt: 1000 },
      { turnId: 't-late', userPrompt: 'después', source: 'texto', createdAt: 3000 },
    ]);
    expect(mergeTimeline(provider, voice).map((item) => item.text)).toEqual(['antes', 'hola', 'después']);
  });

  it('opens Voice Mode in a new conversation when the current thread already has content (S1)', async () => {
    const onStartVoiceMode = vi.fn();
    render(<ChatComposer {...baseComposerProps} onStartVoiceMode={onStartVoiceMode} />);

    fireEvent.click(screen.getByLabelText('Iniciar sesión de voz'));

    expect(onStartVoiceMode).toHaveBeenCalledTimes(1);
    // The pane decides which thread to bind; the composer must not bind the current one itself.
    expect(voiceSessionStore.getSnapshot().phase).toBe('inactive');
  });

  it('persists thread voice turns in voiceSessionStore across re-mounts (S6)', () => {
    voiceSessionStore.clearThreadVoiceTurns('thread-persist-1');

    voiceSessionStore.addThreadVoiceTurn('thread-persist-1', {
      turnId: 'vt-1',
      userPrompt: 'Hola asistente',
      source: 'voz',
      strategy: 'heuristic',
      providerId: 'local',
      durationMs: 80,
      overallSuccess: true,
      receipts: [],
      reply: '¡Hola! ¿En qué puedo ayudarte?',
      createdAt: Date.now(),
    });

    const turns = voiceSessionStore.getThreadVoiceTurns('thread-persist-1');
    expect(turns).toHaveLength(1);
    expect(turns[0].userPrompt).toBe('Hola asistente');
    expect(turns[0].reply).toBe('¡Hola! ¿En qué puedo ayudarte?');
  });

  it('mounts ZedStripHost engine in background when Thread Voice Mode starts with operatorOpen=false and hands off to orb on surface switch (S5, S7)', () => {
    render(
      <ZedStripHost
        call={{
          isActive: false,
          status: 'connected',
          toolCalls: [],
        }}
      />
    );

    // Initially inactive -> not mounted
    expect(screen.queryByTestId('zed-card')).not.toBeInTheDocument();

    // Activate Thread Voice Mode
    act(() => {
      voiceSessionStore.startSession('thread-live-1', 'thread');
    });

    // Engine is now mounted in background, with floating orb visually hidden on 'thread' surface
    const zedCard = screen.getByTestId('zed-card');
    expect(zedCard).toBeInTheDocument();
    expect(zedCard).toHaveStyle({ display: 'none' });

    // Switch surface to 'orb' (e.g. user navigates to Code mode) -> floating orb becomes visible
    act(() => {
      voiceSessionStore.setActiveSurface('orb');
    });
    expect(zedCard).not.toHaveStyle({ display: 'none' });
  });

  it('renders a subtle voice badge only on spoken user messages (S4)', () => {
    const items = voiceTurnsToChatItems([
      {
        turnId: 'vt-spoken',
        userPrompt: 'Abrí una terminal',
        source: 'voz',
        createdAt: 1000,
      },
      {
        turnId: 'vt-typed',
        userPrompt: 'Listo por texto',
        source: 'texto',
        createdAt: 2000,
      },
    ]);

    const { rerender } = render(<ChatItemRow item={items[0]} />);
    expect(screen.getByLabelText('Mensaje por voz')).toHaveTextContent('Voz');

    rerender(<ChatItemRow item={items[1]} />);
    expect(screen.queryByLabelText('Mensaje por voz')).not.toBeInTheDocument();
  });

  it('builds thread-scoped conversation history without cross-thread leakage or discarded captures (S10)', () => {
    voiceSessionStore.clearThreadVoiceTurns('thread-hist-a');
    voiceSessionStore.clearThreadVoiceTurns('thread-hist-b');

    voiceSessionStore.addThreadVoiceTurn('thread-hist-a', {
      turnId: 'h-1',
      userPrompt: 'Queremos armar notificaciones',
      source: 'voz',
      reply: 'Perfecto, ¿delegamos el ODD a un hilo con AntiGravity?',
      createdAt: 1000,
    });
    voiceSessionStore.addThreadVoiceTurn('thread-hist-a', {
      turnId: 'h-discard',
      userPrompt: '[captura de voz descartada: silencio]',
      source: 'voz',
      createdAt: 1500,
    });
    voiceSessionStore.addThreadVoiceTurn('thread-hist-b', {
      turnId: 'h-other',
      userPrompt: 'Otro hilo distinto',
      source: 'voz',
      reply: 'Respuesta de otro hilo',
      createdAt: 2000,
    });

    const historyA = voiceSessionStore.getConversationHistory('thread-hist-a');
    expect(historyA).toEqual([
      { role: 'user', content: 'Queremos armar notificaciones' },
      { role: 'assistant', content: 'Perfecto, ¿delegamos el ODD a un hilo con AntiGravity?' },
    ]);
  });

  it('projects delegated thread, subagent, and autonomous agent receipts with rich metadata (S4, S10)', () => {
    const items = voiceTurnsToChatItems([
      {
        turnId: 'vt-del-1',
        userPrompt: 'Delega el ODD a un subagente y al agente Security auditor',
        source: 'voz',
        receipts: [
          {
            actionIdx: 0,
            type: 'spawn_subagent',
            ok: true,
            summaryEs: 'Subagente «ODD Planner» con Antigravity con enfoque ODD iniciado.',
            durationMs: 120,
            data: { role: 'ODD Planner', provider: 'antigravity', oddMode: true, threadId: 'sub-thread-101' },
          },
          {
            actionIdx: 1,
            type: 'launch_agent',
            ok: true,
            summaryEs: 'Delegué la tarea al agente Security auditor (claude) con enfoque ODD.',
            durationMs: 95,
            data: { agentName: 'Security auditor', provider: 'claude', oddMode: true, threadId: 'agent-thread-202' },
          },
        ],
        reply: 'Listo, ambos están trabajando en segundo plano.',
        createdAt: 3000,
      },
    ]);

    const toolItems = items.filter((i) => i.kind === 'tool');
    expect(toolItems).toHaveLength(2);
    expect(toolItems[0].detail).toBe('Subagente · ODD Planner · antigravity · ODD · 120 ms');
    expect(toolItems[0].delegatedThreadId).toBe('sub-thread-101');
    expect(toolItems[1].detail).toBe('Agente · Security auditor · claude · ODD · 95 ms');
    expect(toolItems[1].delegatedThreadId).toBe('agent-thread-202');

    // Verify clicking a delegated receipt row opens the delegated thread via kite:select-thread
    const selected: unknown[] = [];
    const onSelect = (e: Event) => selected.push((e as CustomEvent).detail);
    window.addEventListener('kite:select-thread', onSelect);

    const { rerender } = render(<ChatItemRow item={toolItems[0]} />);
    fireEvent.click(screen.getByRole('button', { name: /Abrir hilo/i }));
    rerender(<ChatItemRow item={toolItems[1]} />);
    fireEvent.click(screen.getByRole('button', { name: /Abrir agente/i }));

    window.removeEventListener('kite:select-thread', onSelect);
    expect(selected).toEqual([
      { threadId: 'sub-thread-101', mode: 'chat' },
      { threadId: 'agent-thread-202', mode: 'agents' },
    ]);
  });

  it('orders live SubagentActivityCard between user/actions and assistant reply and deduplicates spawn_subagent receipt (S4, S10)', () => {
    const voiceItems = voiceTurnsToChatItems([
      {
        turnId: 'vt-sub-order',
        userPrompt: 'Lanza un subagente ODD Planner',
        source: 'voz',
        durationMs: 900,
        receipts: [
          {
            actionIdx: 0,
            type: 'open_terminals',
            ok: true,
            summaryEs: '1 terminal abierta',
            durationMs: 120,
          },
          {
            actionIdx: 1,
            type: 'spawn_subagent',
            ok: true,
            summaryEs: 'Subagente «ODD Planner» iniciado.',
            durationMs: 150,
            data: { role: 'ODD Planner', provider: 'antigravity', oddMode: true, threadId: 'child-sub-1' },
          },
        ],
        reply: 'Listo, lancé al subagente ODD Planner.',
        createdAt: 1000,
        completedAt: 1900,
      },
    ]);

    const providerItems = [
      {
        id: 'dispatch-subagent-child-sub-1',
        kind: 'tool' as const,
        text: '',
        title: 'ODD Planner',
        detail: 'Audit voice mode',
        status: 'running' as const,
        streaming: false,
        exitCode: null,
        createdAtUnixMs: 1450,
        attachments: [],
        toolName: 'dispatch_subagent',
        toolKind: 'subagent',
        subagentMeta: {
          subagentId: 'child-sub-1',
          childThreadId: 'child-sub-1',
          action: 'spawn' as const,
          role: 'ODD Planner',
          status: 'running' as const,
          stepCount: 0,
        },
      },
    ];

    const merged = mergeTimeline(providerItems, voiceItems);
    expect(merged.map((i) => i.id)).toEqual([
      'vt-sub-order:user',
      'vt-sub-order:action:0',
      'dispatch-subagent-child-sub-1',
      'vt-sub-order:assistant',
    ]);
  });

  it('anchors legacy subagent cards missing createdAtUnixMs between user and assistant instead of floating to top (S4)', () => {
    const voiceItems = voiceTurnsToChatItems([
      {
        turnId: 'vt-legacy',
        userPrompt: 'Revisa el roadmap con un subagente',
        source: 'voz',
        durationMs: 600,
        receipts: [
          {
            actionIdx: 0,
            type: 'spawn_subagent',
            ok: true,
            summaryEs: 'Subagente iniciado.',
            data: { role: 'ODD Planner', threadId: 'legacy-child-1' },
          },
        ],
        reply: 'Inicié el subagente.',
        createdAt: 2000,
      },
    ]);

    const legacyProviderItems = [
      {
        id: 'dispatch-subagent-legacy-child-1',
        kind: 'tool' as const,
        text: '',
        title: 'ODD Planner',
        detail: 'Legacy task',
        status: 'completed' as const,
        streaming: false,
        exitCode: null,
        createdAtUnixMs: undefined as unknown as number,
        attachments: [],
        toolName: 'dispatch_subagent',
        toolKind: 'subagent',
        subagentMeta: {
          subagentId: 'legacy-child-1',
          childThreadId: 'legacy-child-1',
          action: 'spawn' as const,
          role: 'ODD Planner',
          status: 'completed' as const,
          stepCount: 1,
        },
      },
    ];

    const merged = mergeTimeline(legacyProviderItems, voiceItems);
    expect(merged.map((i) => i.id)).toEqual([
      'vt-legacy:user',
      'dispatch-subagent-legacy-child-1',
      'vt-legacy:assistant',
    ]);
  });

  it('keeps failed or terminal spawn_subagent receipts when no live SubagentActivityCard exists (S4, S10)', () => {
    const voiceItems = voiceTurnsToChatItems([
      {
        turnId: 'vt-failed-sub',
        userPrompt: 'Lanza subagente',
        source: 'voz',
        receipts: [
          {
            actionIdx: 0,
            type: 'spawn_subagent',
            ok: false,
            summaryEs: 'No pude iniciar el subagente.',
            data: { threadId: 'missing-child' },
          },
        ],
        reply: 'Falló el lanzamiento.',
        createdAt: 5000,
        completedAt: 5200,
      },
    ]);

    const merged = mergeTimeline(
      [
        {
          id: 'other-provider-item',
          kind: 'assistant',
          text: 'previo',
          title: null,
          detail: null,
          status: 'completed',
          streaming: false,
          exitCode: null,
          createdAtUnixMs: 1000,
          attachments: [],
        },
      ],
      voiceItems
    );

    expect(merged.map((i) => i.id)).toEqual([
      'other-provider-item',
      'vt-failed-sub:user',
      'vt-failed-sub:action:0',
      'vt-failed-sub:assistant',
    ]);
  });

  it('renders ConsultativeDraftCard when awaiting confirmation and wires Confirmar / Cancelar actions (S3.2)', () => {
    const onConfirm = vi.fn();
    act(() => {
      voiceSessionStore.startSession('thread-draft-1', 'thread');
      voiceSessionStore.setDraftProposal('thread-draft-1', {
        proposalId: 'prop-thread-1',
        status: 'awaiting_confirmation',
        targetKind: 'subagent',
        title: 'Implementar notificaciones',
        taskBrief: 'Crear el servicio de notificaciones push con tests.',
        role: 'Backend Builder',
        provider: 'claude',
        oddMode: true,
        questionForUser: '¿Lo lanzamos con Claude en modo ODD?',
        revision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    try {
      render(<ConsultativeDraftCard threadId="thread-draft-1" onConfirm={onConfirm} />);

      const card = screen.getByTestId('consultative-draft-card');
      expect(card).toBeInTheDocument();
      expect(card).toHaveTextContent('Subagente');
      expect(card).toHaveTextContent('Backend Builder');
      expect(card).toHaveTextContent('Implementar notificaciones');
      expect(card).toHaveTextContent('¿Lo lanzamos con Claude en modo ODD?');

      fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
      expect(onConfirm).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
      expect(voiceSessionStore.getSnapshot().draftProposal).toBeNull();
      expect(screen.queryByTestId('consultative-draft-card')).not.toBeInTheDocument();
    } finally {
      voiceSessionStore.clearDraftProposal('thread-draft-1');
      voiceSessionStore.stopSession();
    }
  });

  it('formats worked-for duration labels cleanly only for >= 1000 ms and projects them onto receipts and turns (S4.2)', () => {
    expect(formatWorkedForLabel(undefined)).toBeNull();
    expect(formatWorkedForLabel(0)).toBeNull();
    expect(formatWorkedForLabel(999)).toBeNull();
    expect(formatWorkedForLabel(1500)).toBe('Trabajó 1.5 s');
    expect(formatWorkedForLabel(4000)).toBe('Trabajó 4 s');

    const items = voiceTurnsToChatItems([
      {
        turnId: 'vt-worked-1',
        userPrompt: 'Ejecuta los tests',
        source: 'voz',
        durationMs: 4000,
        receipts: [
          {
            actionIdx: 0,
            type: 'open_terminals',
            ok: true,
            summaryEs: '1 terminal abierta',
            durationMs: 1500,
          },
        ],
        reply: 'Listo, terminó en cuatro segundos.',
        createdAt: 1000,
        completedAt: 5000,
      },
    ]);

    const receiptItem = items.find((item) => item.id === 'vt-worked-1:action:0');
    const assistantItem = items.find((item) => item.id === 'vt-worked-1:assistant');
    expect(receiptItem?.detail).toBe('open_terminals · Trabajó 1.5 s');
    expect(receiptItem?.durationSeconds).toBe(1.5);
    expect(assistantItem?.detail).toBe('Trabajó 4 s');
    expect(assistantItem?.durationSeconds).toBe(4);
  });

  it('builds a post-call summary receipt card and appends it when includeSessionSummary is enabled (S4.2)', () => {
    expect(buildVoiceSessionSummaryItem([])).toBeNull();
    expect(
      buildVoiceSessionSummaryItem([
        {
          turnId: 'vt-aborted',
          userPrompt: 'hola',
          source: 'voz',
          interrupted: true,
          createdAt: 1000,
        },
      ]),
    ).toBeNull();

    const turns = [
      {
        turnId: 'vt-sum-1',
        userPrompt: 'Lanza al planificador',
        source: 'voz' as const,
        durationMs: 1500,
        overallSuccess: true,
        receipts: [
          {
            actionIdx: 0,
            type: 'spawn_subagent',
            ok: true,
            summaryEs: 'Subagente ODD Planner iniciado',
            durationMs: 800,
            data: { role: 'ODD Planner' },
          },
        ],
        reply: 'Subagente iniciado.',
        createdAt: 1000,
        completedAt: 2500,
      },
      {
        turnId: 'vt-sum-2',
        userPrompt: 'Abre una terminal',
        source: 'voz' as const,
        durationMs: 2500,
        overallSuccess: true,
        receipts: [
          {
            actionIdx: 0,
            type: 'open_terminals',
            ok: true,
            summaryEs: '1 terminal abierta',
            durationMs: 300,
          },
        ],
        reply: 'Terminal abierta.',
        createdAt: 3000,
        completedAt: 5500,
      },
    ];

    const summary = buildVoiceSessionSummaryItem(turns, 6000);
    expect(summary).toMatchObject({
      id: 'voice-session-summary',
      kind: 'tool',
      toolName: 'voice_session_summary',
      toolKind: 'dynamicToolCall',
      title: 'Resumen de sesión de voz · 2 turnos · 2 acciones',
      createdAtUnixMs: 6000,
    });
    expect(summary?.detail).toContain('Subagente ODD Planner iniciado');
    expect(summary?.detail).toContain('1 terminal abierta');
    expect(summary?.detail).toContain('Trabajó 4 s');

    const projectedWithSummary = voiceTurnsToChatItems(turns, {
      includeSessionSummary: true,
      sessionEndedAt: 6000,
    });
    expect(projectedWithSummary[projectedWithSummary.length - 1]?.id).toBe('voice-session-summary');
  });

  it('creates session boundary divider markers for start and end phases (S4.2)', () => {
    const startItem = buildVoiceSessionBoundaryItem('sess-1', 'started', 1000);
    const endItem = buildVoiceSessionBoundaryItem('sess-1', 'ended', 5000, 4000);
    const endNoDuration = buildVoiceSessionBoundaryItem('sess-2', 'ended', 7000);

    expect(startItem).toMatchObject({
      id: 'voice-session:sess-1:started',
      kind: 'note',
      title: 'Sesión de voz iniciada',
      text: 'Sesión de voz iniciada',
      createdAtUnixMs: 1000,
    });
    expect(endItem).toMatchObject({
      id: 'voice-session:sess-1:ended',
      kind: 'note',
      title: 'Sesión de voz finalizada · 4 s',
      text: 'Sesión de voz finalizada · 4 s',
      createdAtUnixMs: 5000,
    });
    expect(endNoDuration.title).toBe('Sesión de voz finalizada');
  });

  it('flushes pending transcript tail only when non-empty and not duplicating the last turn (S4.2)', () => {
    const existing = [
      {
        turnId: 'vt-last',
        userPrompt: 'Abrime una terminal',
        source: 'voz' as const,
        createdAt: 1000,
      },
    ];

    expect(flushPendingVoiceTranscriptTail('   ', 'thread-1', existing, 2000)).toBeNull();
    expect(flushPendingVoiceTranscriptTail('  abrime   una terminal ', 'thread-1', existing, 2000)).toBeNull();

    const flushed = flushPendingVoiceTranscriptTail('  y revisa los tests  ', 'thread-1', existing, 2500);
    expect(flushed).toMatchObject({
      turnId: 'tail-thread-1-2500',
      userPrompt: 'y revisa los tests',
      source: 'voz',
      strategy: 'tail_flush',
      interrupted: true,
      createdAt: 2500,
    });
  });

  it('computes karaoke word-by-word progress and spokenCharCount synced with playback speed (S4.2, S5)', () => {
    expect(computeKaraokeWordProgress('   ', 500, 1000)).toEqual({
      words: [],
      spokenCharCount: 0,
      progress: 0,
    });

    const text = 'Hola mundo cruel';
    const start = computeKaraokeWordProgress(text, 0, 3000);
    expect(start.progress).toBe(0);
    expect(start.spokenCharCount).toBe(0);
    expect(start.words.map((w) => w.state)).toEqual(['unspoken', 'unspoken', 'unspoken']);

    const mid = computeKaraokeWordProgress(text, 1500, 3000);
    expect(mid.progress).toBe(0.5);
    expect(mid.spokenCharCount).toBe(8);
    expect(mid.words).toEqual([
      { word: 'Hola', state: 'spoken' },
      { word: 'mundo', state: 'active' },
      { word: 'cruel', state: 'unspoken' },
    ]);

    const fast = computeKaraokeWordProgress(text, 1500, 3000, 2);
    expect(fast.progress).toBe(1);
    expect(fast.spokenCharCount).toBe(text.length);
    expect(fast.words.map((w) => w.state)).toEqual(['spoken', 'spoken', 'spoken']);

    const slow = computeKaraokeWordProgress(text, 1500, 3000, 0.5);
    expect(slow.progress).toBe(0.25);
    expect(slow.words).toEqual([
      { word: 'Hola', state: 'active' },
      { word: 'mundo', state: 'unspoken' },
      { word: 'cruel', state: 'unspoken' },
    ]);
  });
});
