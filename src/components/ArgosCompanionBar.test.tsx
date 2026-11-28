import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { ArgosCompanionBar } from './ArgosCompanionBar';
import { voiceSessionStore } from '../lib/operator/voice/voiceSessionStore';
import { ttsNarrator } from '../lib/operator/ttsNarrator';
import {
  acquireVoiceHostClaim,
  COMPANION_GLOBAL_HOTKEY_EVENT,
  getActiveVoiceHostClaim,
  resetCompanionTransferForTests,
} from '../lib/operator/voice/companionTransfer';
import { ctxClient } from '../lib/operator/context/ctxClient';

vi.mock('../lib/operator/ttsNarrator', () => ({
  ttsNarrator: {
    stop: vi.fn(),
    speak: vi.fn(),
  },
}));

describe('ArgosCompanionBar — Component Unit Tests', () => {
  beforeEach(() => {
    voiceSessionStore.stopSession();
    voiceSessionStore.setMicMuted(false);
    voiceSessionStore.setSpeakerMuted(false);
    voiceSessionStore.clearDraftProposal();
    voiceSessionStore.registerTextTurnExecutor(null);
    ctxClient.resetForTests();
    resetCompanionTransferForTests();
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders floating companion bar with semantic radii/heights when open and hides when closed', () => {
    const { rerender } = render(<ArgosCompanionBar open={false} />);
    expect(screen.queryByTestId('argos-companion-bar')).not.toBeInTheDocument();

    voiceSessionStore.startSession('thread-bar-1', 'orb');
    rerender(<ArgosCompanionBar open={true} threadId="thread-bar-1" />);

    const bar = screen.getByTestId('argos-companion-bar');
    expect(bar).toBeInTheDocument();
    expect(bar).toHaveClass('rounded-dialog');
    expect(screen.getByTestId('argos-companion-status')).toHaveTextContent('Argos · En vivo');
    expect(screen.getByTestId('argos-companion-waveform').children).toHaveLength(5);
    expect(screen.getByTestId('argos-companion-attach-context-btn')).toHaveClass(
      'h-7',
      'rounded-control'
    );
    expect(screen.getByTestId('argos-companion-input')).toHaveClass('h-8', 'rounded-control');
    expect(screen.getByTestId('argos-companion-end-btn')).toHaveClass('h-8', 'rounded-pill');
  });

  it('reflects confirmation and muted states truthfully in status pill', () => {
    voiceSessionStore.startSession('thread-bar-2', 'orb');
    render(<ArgosCompanionBar open={true} threadId="thread-bar-2" />);

    act(() => {
      voiceSessionStore.setDraftProposal('thread-bar-2', {
        proposalId: 'prop-1',
        status: 'awaiting_confirmation',
        targetKind: 'subagent',
        title: 'Ejecutar tests',
        taskBrief: 'Correr vitest',
        revision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    expect(screen.getByTestId('argos-companion-status')).toHaveTextContent(
      'Esperando tu confirmación…'
    );

    act(() => {
      voiceSessionStore.setMicMuted(true);
    });
    expect(screen.getByTestId('argos-companion-status')).toHaveTextContent('Micrófono en pausa');
  });

  it('toggles mic and speaker mutes and stops TTS on speaker mute', () => {
    voiceSessionStore.startSession('thread-bar-3', 'orb');
    render(<ArgosCompanionBar open={true} threadId="thread-bar-3" />);

    const micBtn = screen.getByTestId('argos-companion-mic-btn');
    fireEvent.click(micBtn);
    expect(voiceSessionStore.getSnapshot().micMuted).toBe(true);
    expect(micBtn).toHaveAttribute('aria-pressed', 'true');

    const speakerBtn = screen.getByTestId('argos-companion-speaker-btn');
    fireEvent.click(speakerBtn);
    expect(voiceSessionStore.getSnapshot().speakerMuted).toBe(true);
    expect(speakerBtn).toHaveAttribute('aria-pressed', 'true');
    expect(ttsNarrator.stop).toHaveBeenCalledTimes(1);
  });

  it('attaches visual context snapshot with 1 click and submits hybrid text input', async () => {
    document.title = 'ArgosWorkspace · Code';
    voiceSessionStore.startSession('thread-bar-4', 'orb');
    const onSendText = vi.fn();

    render(
      <ArgosCompanionBar
        open={true}
        threadId="thread-bar-4"
        onSendText={onSendText}
      />
    );

    fireEvent.click(screen.getByTestId('argos-companion-attach-context-btn'));

    const badge = await screen.findByTestId('argos-companion-context-badge');
    expect(badge).toHaveTextContent('ArgosWorkspace · Code');
    expect(badge).toHaveClass('h-7', 'rounded-control');

    const input = screen.getByTestId('argos-companion-input');
    fireEvent.change(input, { target: { value: 'Revisa este archivo' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(onSendText).toHaveBeenCalledTimes(1);
    });
    expect(onSendText.mock.calls[0][0]).toBe('Revisa este archivo');
    expect(onSendText.mock.calls[0][1]?.activeTitle).toBe('ArgosWorkspace · Code');
    expect(screen.queryByTestId('argos-companion-context-badge')).not.toBeInTheDocument();
  });

  it('transfers live call to Thread and stops session + releases claim on Finalizar', () => {
    voiceSessionStore.startSession('thread-bar-5', 'orb');
    acquireVoiceHostClaim('win-companion-1', 'thread-bar-5', { surface: 'companion' });
    const onTransferToThread = vi.fn();
    const onEndSession = vi.fn();

    render(
      <ArgosCompanionBar
        open={true}
        threadId="thread-bar-5"
        windowId="win-companion-1"
        onTransferToThread={onTransferToThread}
        onEndSession={onEndSession}
      />
    );

    fireEvent.click(screen.getByTestId('argos-companion-transfer-btn'));
    expect(voiceSessionStore.getSnapshot().activeSurface).toBe('thread');
    expect(getActiveVoiceHostClaim()?.surface).toBe('thread');
    expect(onTransferToThread).toHaveBeenCalledWith('thread-bar-5');

    fireEvent.click(screen.getByTestId('argos-companion-end-btn'));
    expect(ttsNarrator.stop).toHaveBeenCalled();
    expect(voiceSessionStore.getSnapshot().phase).toBe('inactive');
    expect(getActiveVoiceHostClaim()).toBeNull();
    expect(onEndSession).toHaveBeenCalledTimes(1);
  });

  it('toggles companion bar on Alt+Space and ignores IME composition events', () => {
    const onOpenChange = vi.fn();
    render(<ArgosCompanionBar defaultOpen={false} onOpenChange={onOpenChange} />);

    expect(screen.queryByTestId('argos-companion-bar')).not.toBeInTheDocument();

    // IME composition should NOT toggle
    fireEvent.keyDown(window, {
      key: ' ',
      code: 'Space',
      altKey: true,
      isComposing: true,
      keyCode: 229,
    });
    expect(screen.queryByTestId('argos-companion-bar')).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();

    // Real Alt+Space opens the bar
    fireEvent.keyDown(window, {
      key: ' ',
      code: 'Space',
      altKey: true,
    });
    expect(screen.getByTestId('argos-companion-bar')).toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledWith(true);

    // Second Alt+Space closes the bar
    fireEvent.keyDown(window, {
      key: ' ',
      code: 'Space',
      altKey: true,
    });
    expect(screen.queryByTestId('argos-companion-bar')).not.toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('summons companion bar with enriched context on OS global hotkey event while preserving VoiceHostSingletonClaim', async () => {
    document.title = 'Code · window.rs';
    acquireVoiceHostClaim('win-main', 'thread-os-1', { surface: 'orb' });
    const onOpenChange = vi.fn();

    render(
      <ArgosCompanionBar
        defaultOpen={false}
        onOpenChange={onOpenChange}
        threadId="thread-os-1"
        windowId="win-main"
      />
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(COMPANION_GLOBAL_HOTKEY_EVENT, {
          detail: { shortcut: 'Alt+Space', source: 'os-global-hotkey' },
        })
      );
    });

    expect(await screen.findByTestId('argos-companion-bar')).toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(await screen.findByTestId('argos-companion-context-badge')).toBeInTheDocument();
    expect(getActiveVoiceHostClaim()?.windowId).toBe('win-main');
  });
});
