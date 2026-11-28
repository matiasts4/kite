import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { VoicePickerModal } from './VoicePickerModal';
import { VOICE_PRESETS } from '../../../../lib/operator/config/voicePalettes';

describe('VoicePickerModal — Interactive Voice Carousel & Preview (T8 / S8)', () => {
  let originalAudioContext: unknown;
  let originalWebkitAudioContext: unknown;
  let createdOscillators: Array<{
    type: OscillatorType;
    frequency: { setValueAtTime: ReturnType<typeof vi.fn>; value: number };
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }>;
  let mockContextClose: ReturnType<typeof vi.fn>;
  let mockAudioState: AudioContextState;

  beforeEach(() => {
    vi.useFakeTimers();
    originalAudioContext = (window as any).AudioContext;
    originalWebkitAudioContext = (window as any).webkitAudioContext;

    createdOscillators = [];
    mockAudioState = 'running';
    mockContextClose = vi.fn().mockImplementation(async () => {
      mockAudioState = 'closed';
    });

    (window as any).AudioContext = vi.fn().mockImplementation(() => ({
      currentTime: 0,
      get state() {
        return mockAudioState;
      },
      destination: {},
      resume: vi.fn().mockResolvedValue(undefined),
      close: mockContextClose,
      createGain: vi.fn(() => ({
        gain: {
          value: 0,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
          cancelScheduledValues: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      })),
      createOscillator: vi.fn(() => {
        const osc = {
          type: 'sine' as OscillatorType,
          frequency: {
            value: 440,
            setValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        };
        createdOscillators.push(osc);
        return osc;
      }),
    }));
  });

  afterEach(() => {
    (window as any).AudioContext = originalAudioContext;
    (window as any).webkitAudioContext = originalWebkitAudioContext;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not render when isOpen is false', () => {
    render(
      <VoicePickerModal
        isOpen={false}
        onClose={vi.fn()}
        onSelectVoice={vi.fn()}
      />
    );
    expect(screen.queryByTestId('voice-picker')).not.toBeInTheDocument();
  });

  it('renders accessible dialog, ArgosOrb, initial voice preset, and morphing pill dots', () => {
    render(
      <VoicePickerModal
        isOpen={true}
        initialVoice="vega"
        onClose={vi.fn()}
        onSelectVoice={vi.fn()}
      />
    );

    const dialog = screen.getByTestId('voice-picker');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    const orb = screen.getByTestId('zed-orb');
    expect(orb).toHaveAttribute('data-figure', 'plasma-orb');
    expect(orb).toHaveAttribute('data-state', 'listening');

    expect(screen.getByTestId('voice-picker-name')).toHaveTextContent('Vega');
    expect(screen.getByText('Serena y precisa')).toBeInTheDocument();
    expect(screen.getByTestId('voice-picker-use')).toHaveTextContent('Usar Vega');
    expect(screen.getByTestId('voice-picker-dot-vega')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('voice-picker-dot-ara')).toHaveAttribute('aria-pressed', 'false');
  });

  it('navigates presets via chevron buttons and dot pills with wrap-around', () => {
    render(
      <VoicePickerModal
        isOpen={true}
        initialVoice="Ara"
        onClose={vi.fn()}
        onSelectVoice={vi.fn()}
      />
    );

    expect(screen.getByTestId('voice-picker-name')).toHaveTextContent('Ara');

    // Wrap backwards from Ara -> Luma
    fireEvent.click(screen.getByTestId('voice-picker-prev'));
    expect(screen.getByTestId('voice-picker-name')).toHaveTextContent(
      VOICE_PRESETS[VOICE_PRESETS.length - 1].name
    );

    // Wrap forwards from Luma -> Ara -> Vega
    fireEvent.click(screen.getByTestId('voice-picker-next'));
    expect(screen.getByTestId('voice-picker-name')).toHaveTextContent('Ara');

    fireEvent.click(screen.getByTestId('voice-picker-next'));
    expect(screen.getByTestId('voice-picker-name')).toHaveTextContent('Vega');

    // Direct dot selection
    fireEvent.click(screen.getByTestId('voice-picker-dot-nova'));
    expect(screen.getByTestId('voice-picker-name')).toHaveTextContent('Nova');
    expect(screen.getByTestId('voice-picker-use')).toHaveTextContent('Usar Nova');
  });

  it('supports ArrowLeft, ArrowRight, Enter, and Escape keyboard shortcuts', () => {
    const onClose = vi.fn();
    const onSelectVoice = vi.fn();

    render(
      <VoicePickerModal
        isOpen={true}
        initialVoice="Ara"
        onClose={onClose}
        onSelectVoice={onSelectVoice}
      />
    );

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByTestId('voice-picker-name')).toHaveTextContent('Vega');

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByTestId('voice-picker-name')).toHaveTextContent('Orion');

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByTestId('voice-picker-name')).toHaveTextContent('Vega');

    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onSelectVoice).toHaveBeenCalledTimes(1);
    expect(onSelectVoice).toHaveBeenCalledWith('Vega');
    expect(onClose).toHaveBeenCalledTimes(1);

    onSelectVoice.mockClear();
    onClose.mockClear();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onSelectVoice).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('plays harmonic Web Audio chord on switch, switches orb to speaking, and cleans up on switch/close', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <VoicePickerModal
        isOpen={true}
        initialVoice="Ara"
        volume={0.75}
        onClose={onClose}
        onSelectVoice={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId('voice-picker-next'));
    expect(createdOscillators.length).toBeGreaterThan(0);
    expect(screen.getByTestId('zed-orb')).toHaveAttribute('data-state', 'speaking');

    const firstBatchCount = createdOscillators.length;
    fireEvent.click(screen.getByTestId('voice-picker-next'));
    // Previous batch oscillators must stop cleanly before/when switching
    for (let i = 0; i < firstBatchCount; i += 1) {
      expect(createdOscillators[i].stop).toHaveBeenCalled();
    }

    // Preview naturally returns orb back to listening after chord duration
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(screen.getByTestId('zed-orb')).toHaveAttribute('data-state', 'listening');

    // Trigger another preview, then verify closing the modal stops oscillators and closes AudioContext
    fireEvent.click(screen.getByTestId('voice-picker-next'));
    expect(screen.getByTestId('zed-orb')).toHaveAttribute('data-state', 'speaking');

    rerender(
      <VoicePickerModal
        isOpen={false}
        initialVoice="Ara"
        volume={0.75}
        onClose={onClose}
        onSelectVoice={vi.fn()}
      />
    );

    for (const osc of createdOscillators) {
      expect(osc.stop).toHaveBeenCalled();
    }
    expect(mockContextClose).toHaveBeenCalled();
  });

  it('works cleanly without AudioContext and selects voice on CTA click or closes on backdrop click', () => {
    delete (window as any).AudioContext;
    delete (window as any).webkitAudioContext;

    const onClose = vi.fn();
    const onSelectVoice = vi.fn();

    render(
      <VoicePickerModal
        isOpen={true}
        initialVoice="Orion"
        onClose={onClose}
        onSelectVoice={onSelectVoice}
      />
    );

    fireEvent.click(screen.getByTestId('voice-picker-next'));
    expect(screen.getByTestId('voice-picker-name')).toHaveTextContent('Lyra');

    fireEvent.click(screen.getByTestId('voice-picker-use'));
    expect(onSelectVoice).toHaveBeenCalledWith('Lyra');
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    const backdrop = screen.getByTestId('voice-picker').parentElement as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
