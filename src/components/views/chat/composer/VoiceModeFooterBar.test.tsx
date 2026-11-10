import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { VoiceModeFooterBar } from './VoiceModeFooterBar';
import { voiceSessionStore } from '../../../../lib/operator/voice/voiceSessionStore';
import { ttsNarrator } from '../../../../lib/operator/ttsNarrator';

vi.mock('../../../../lib/operator/operatorConfig', () => ({
  loadOperatorConfig: () => ({
    activeProvider: 'grok',
    ttsEngine: 'elevenlabs',
    persona: {
      name: 'Zed',
      voice: 'Ara',
      language: 'es',
    },
  }),
}));

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

  it('renders the locked brain model and voice engine from the Zed Assistant settings (S2)', () => {
    voiceSessionStore.startSession('thread-test-1', 'thread');

    render(<VoiceModeFooterBar threadId="thread-test-1" hasDraftText={false} />);

    const badge = screen.getByTestId('voice-locked-assistant-badge');
    expect(badge.tagName).toBe('SPAN'); // not a button: it cannot be changed mid-session
    expect(badge).toHaveTextContent('Zed · grok-4.7');
    expect(screen.getByTestId('voice-engine-badge')).toHaveTextContent('ElevenLabs');
    expect(screen.getByTestId('voice-live-status-pill')).toHaveTextContent('Escuchando…');
  });

  it('reuses the standard composer footer geometry (S7)', () => {
    render(<VoiceModeFooterBar threadId="thread-test-1" hasDraftText={false} />);

    const footer = screen.getByTestId('voice-mode-footer-bar');
    expect(footer).toHaveClass('kite-composer-footer');
    expect(footer.querySelector('.kite-composer-footer-left')).not.toBeNull();
    expect(footer.querySelector('.kite-composer-footer-right')).not.toBeNull();
    expect(screen.getByTestId('voice-locked-assistant-badge')).toHaveClass('kite-composer-control-pill');
  });

  it('updates the live status when thinking or speaking (S2)', () => {
    voiceSessionStore.startSession('thread-test-1', 'thread');
    render(<VoiceModeFooterBar threadId="thread-test-1" hasDraftText={false} />);

    act(() => {
      voiceSessionStore.setActiveTurnStage('planning', 'Planificando con Grok…');
    });
    expect(screen.getByTestId('voice-live-status-pill')).toHaveTextContent('Planificando con Grok…');

    act(() => {
      voiceSessionStore.setActiveTurnStage('speaking');
    });
    expect(screen.getByTestId('voice-live-status-pill')).toHaveTextContent('Hablando…');
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
});
