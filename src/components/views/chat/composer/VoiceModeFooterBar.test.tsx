import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

  it('renders locked assistant model badge (non-editable as per S2)', () => {
    voiceSessionStore.startSession('thread-test-1', 'thread');

    render(<VoiceModeFooterBar threadId="thread-test-1" hasDraftText={false} />);

    const badge = screen.getByTestId('voice-locked-assistant-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('Zed · GROK · ElevenLabs');
  });

  it('renders disabled attach button in voice mode', () => {
    render(<VoiceModeFooterBar threadId="thread-test-1" hasDraftText={false} />);

    const attachBtn = screen.getByLabelText('Adjuntos desactivados');
    expect(attachBtn).toBeDisabled();
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
