import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { VoiceModeFooterBar } from './VoiceModeFooterBar';
import { voiceSessionStore } from '../../../../lib/operator/voice/voiceSessionStore';
import { ttsNarrator } from '../../../../lib/operator/ttsNarrator';

vi.mock('../../../../lib/operator/ttsNarrator', () => ({
  ttsNarrator: {
    stop: vi.fn(),
    speak: vi.fn(),
  },
}));

describe('VoiceModeFooterBar — Component Unit Tests', () => {
  beforeEach(() => {
    voiceSessionStore.stopSession();
    voiceSessionStore.setMicMuted(false);
    voiceSessionStore.setSpeakerMuted(false);
    vi.clearAllMocks();
  });

  it('hides Zed assistant and TTS pills inside Threads while showing live Spanish voice status (S2, S7)', () => {
    voiceSessionStore.startSession('thread-test-1', 'thread');

    render(<VoiceModeFooterBar threadId="thread-test-1" hasDraftText={false} />);

    expect(screen.queryByTestId('voice-locked-assistant-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('voice-engine-badge')).not.toBeInTheDocument();
    const statusPill = screen.getByTestId('voice-live-status-pill');
    expect(statusPill).toHaveTextContent('Escuchando en vivo');
    expect(statusPill).toHaveAttribute('data-tone', 'listening');
    expect(statusPill.querySelectorAll('.kite-voice-status__bar')).toHaveLength(3);
  });

  it('reuses the standard composer footer geometry (S7)', () => {
    render(<VoiceModeFooterBar threadId="thread-test-1" hasDraftText={false} />);

    const footer = screen.getByTestId('voice-mode-footer-bar');
    expect(footer).toHaveClass('kite-composer-footer');
    expect(footer.querySelector('.kite-composer-footer-left')).not.toBeNull();
    expect(footer.querySelector('.kite-composer-footer-right')).not.toBeNull();
    expect(screen.getByTestId('voice-live-status-pill')).toHaveClass('kite-voice-status');
  });

  it('updates the live status when thinking, transcribing, speaking, or muted (S2, S7)', () => {
    voiceSessionStore.startSession('thread-test-1', 'thread');
    render(<VoiceModeFooterBar threadId="thread-test-1" hasDraftText={false} />);

    act(() => {
      voiceSessionStore.setActiveTurnStage('planning', 'Planificando con Grok…');
    });
    expect(screen.getByTestId('voice-live-status-pill')).toHaveTextContent('Planificando con Grok…');
    expect(screen.getByTestId('voice-live-status-pill')).toHaveAttribute('data-tone', 'thinking');

    act(() => {
      voiceSessionStore.setActiveTurnStage('speaking');
    });
    expect(screen.getByTestId('voice-live-status-pill')).toHaveTextContent('Respondiendo en voz alta…');
    expect(screen.getByTestId('voice-live-status-pill')).toHaveAttribute('data-tone', 'speaking');

    act(() => {
      voiceSessionStore.setActiveTurnStage(undefined, undefined);
      voiceSessionStore.setMicMuted(true);
    });
    expect(screen.getByTestId('voice-live-status-pill')).toHaveTextContent('Micrófono en pausa');
    expect(screen.getByTestId('voice-live-status-pill')).toHaveAttribute('data-tone', 'muted');
  });

  it('toggles mic mute state on click', () => {
    voiceSessionStore.startSession('thread-test-1', 'thread');

    render(<VoiceModeFooterBar threadId="thread-test-1" hasDraftText={false} />);

    const micBtn = screen.getByLabelText('Silenciar micrófono');
    expect(micBtn).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(micBtn);
    expect(voiceSessionStore.getSnapshot().micMuted).toBe(true);
  });

  it('toggles speaker mute state and stops TTS when muted', () => {
    voiceSessionStore.startSession('thread-test-1', 'thread');

    render(<VoiceModeFooterBar threadId="thread-test-1" hasDraftText={false} />);

    const speakerBtn = screen.getByLabelText('Silenciar voz en altavoz');
    expect(speakerBtn).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(speakerBtn);
    expect(voiceSessionStore.getSnapshot().speakerMuted).toBe(true);
    expect(ttsNarrator.stop).toHaveBeenCalled();
  });

  it('renders Finalizar stadium pill and stops session on click', () => {
    voiceSessionStore.startSession('thread-test-1', 'thread');
    const onEnd = vi.fn();

    render(
      <VoiceModeFooterBar
        threadId="thread-test-1"
        hasDraftText={false}
        onEndSession={onEnd}
      />
    );

    const endBtn = screen.getByLabelText('Finalizar sesión de voz');
    expect(endBtn).toBeInTheDocument();
    expect(endBtn).toHaveTextContent('Finalizar');

    fireEvent.click(endBtn);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(voiceSessionStore.getSnapshot().phase).toBe('inactive');
  });

  it('dynamically swaps call controls to Send button when draft text is present (S3)', () => {
    const onSend = vi.fn();

    const { rerender } = render(
      <VoiceModeFooterBar
        threadId="thread-test-1"
        hasDraftText={false}
        onSendDraft={onSend}
      />
    );

    // Call controls visible, Send button not visible
    expect(screen.getByTestId('voice-call-controls')).toBeInTheDocument();
    expect(screen.queryByLabelText('Enviar a la sesión de voz')).not.toBeInTheDocument();

    // Rerender with hasDraftText = true
    rerender(
      <VoiceModeFooterBar
        threadId="thread-test-1"
        hasDraftText={true}
        onSendDraft={onSend}
      />
    );

    // Call controls swapped for primary Send button
    expect(screen.queryByTestId('voice-call-controls')).not.toBeInTheDocument();
    const sendBtn = screen.getByLabelText('Enviar a la sesión de voz');
    expect(sendBtn).toBeInTheDocument();

    fireEvent.click(sendBtn);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('shows truthful confirmation, hands-free reply, and mic-preparing states (S1.3, S3.4)', () => {
    voiceSessionStore.startSession('thread-test-1', 'thread');
    act(() => {
      voiceSessionStore.setVoiceRuntimeState({ isListening: true });
    });

    render(<VoiceModeFooterBar threadId="thread-test-1" hasDraftText={false} />);
    expect(screen.getByTestId('voice-live-status-pill')).toHaveTextContent('Escuchando en vivo');

    act(() => {
      voiceSessionStore.setHandsFreeReplyWindow(12_000);
    });
    expect(screen.getByTestId('voice-live-status-pill')).toHaveTextContent('Esperando tu respuesta…');

    act(() => {
      voiceSessionStore.setDraftProposal('thread-test-1', {
        proposalId: 'prop-1',
        status: 'awaiting_confirmation',
        targetKind: 'subagent',
        title: 'Auditar ODD',
        taskBrief: 'Revisar el roadmap',
        revision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    expect(screen.getByTestId('voice-live-status-pill')).toHaveTextContent('Esperando tu confirmación…');

    act(() => {
      voiceSessionStore.setVoiceRuntimeState({ isListening: false });
    });
    expect(screen.getByTestId('voice-live-status-pill')).toHaveTextContent('Preparando micrófono…');

    act(() => {
      voiceSessionStore.clearDraftProposal('thread-test-1');
      voiceSessionStore.setHandsFreeReplyWindow(0);
      voiceSessionStore.setVoiceRuntimeState({ isListening: true });
      voiceSessionStore.setActiveTurnStage('post_tts_guard');
    });
    expect(screen.getByTestId('voice-live-status-pill')).toHaveTextContent('Preparando micrófono…');

    act(() => {
      voiceSessionStore.setActiveTurnStage(undefined, undefined);
    });
  });

  it('displays mic flatline warning and Reconectar control when micFlatlined is true (T7, S4.1)', () => {
    voiceSessionStore.startSession('thread-test-1', 'thread');
    const onReconnectMic = vi.fn();

    const { rerender } = render(
      <VoiceModeFooterBar
        threadId="thread-test-1"
        micFlatlined={true}
        onReconnectMic={onReconnectMic}
      />
    );

    const statusPill = screen.getByTestId('voice-live-status-pill');
    expect(statusPill).toHaveTextContent('Sin señal de micrófono');
    expect(statusPill).toHaveAttribute('data-tone', 'paused');

    const reconnectBtn = screen.getByTestId('voice-reconnect-mic-btn');
    expect(reconnectBtn).toHaveTextContent('Reconectar');
    expect(reconnectBtn).toHaveClass('h-8', 'rounded-control');

    fireEvent.click(reconnectBtn);
    expect(onReconnectMic).toHaveBeenCalledTimes(1);

    // Without onReconnectMic, warning stays visible without the button
    rerender(<VoiceModeFooterBar threadId="thread-test-1" micFlatlined={true} />);
    expect(screen.getByTestId('voice-live-status-pill')).toHaveTextContent('Sin señal de micrófono');
    expect(screen.queryByTestId('voice-reconnect-mic-btn')).not.toBeInTheDocument();
  });

  it('renders playback speed badge/button and triggers onCyclePlaybackSpeed on click (T7, S4.1)', () => {
    voiceSessionStore.startSession('thread-test-1', 'thread');
    const onCyclePlaybackSpeed = vi.fn();

    const { rerender } = render(
      <VoiceModeFooterBar
        threadId="thread-test-1"
        playbackSpeed={1}
        onCyclePlaybackSpeed={onCyclePlaybackSpeed}
      />
    );

    const speedBtn = screen.getByTestId('voice-playback-speed-btn');
    expect(speedBtn).toHaveTextContent('1x');
    expect(speedBtn).toHaveClass('h-8', 'rounded-control');

    fireEvent.click(speedBtn);
    expect(onCyclePlaybackSpeed).toHaveBeenCalledTimes(1);

    rerender(
      <VoiceModeFooterBar
        threadId="thread-test-1"
        playbackSpeed={1.25}
        onCyclePlaybackSpeed={onCyclePlaybackSpeed}
      />
    );
    expect(screen.getByTestId('voice-playback-speed-btn')).toHaveTextContent('1.25x');
  });
});
