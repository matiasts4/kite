import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { VoiceCallBar } from './VoiceCallBar';
import { VoiceSpeedPopover } from './VoiceSpeedPopover';

describe('VoiceCallBar & VoiceSpeedPopover (S3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders agent speaker equalizer, tabular mm:ss timer from startedAt, and hides duplicate call actions by default', () => {
    const startedAt = Date.now() - 84_000; // 01:24
    render(
      <VoiceCallBar
        activeSpeaker="agent"
        speakerLevel={0.75}
        startedAt={startedAt}
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );

    expect(screen.getByTestId('voice-teleprompter-call-bar')).toBeInTheDocument();
    const speaker = screen.getByTestId('live-turn-speaker');
    expect(speaker).toHaveAttribute('data-speaker', 'agent');
    expect(speaker).toHaveTextContent('Argos');
    expect(speaker.querySelectorAll('.kite-voice-eq-bar')).toHaveLength(3);

    const timer = screen.getByTestId('voice-call-timer');
    expect(timer).toHaveTextContent('01:24');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(timer).toHaveTextContent('01:25');

    // Default showCallActions=false prevents duplicating VoiceModeFooterBar controls
    expect(screen.queryByTestId('voice-call-mic-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('voice-call-speaker-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('voice-call-end')).not.toBeInTheDocument();
  });

  it('switches speaker indicator to user mic badge and displays linkPhase states', () => {
    const { rerender } = render(
      <VoiceCallBar
        activeSpeaker="you"
        linkPhase="connecting"
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );

    const speaker = screen.getByTestId('live-turn-speaker');
    expect(speaker).toHaveAttribute('data-speaker', 'you');
    expect(speaker).toHaveTextContent('Tú');
    expect(speaker.querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('voice-call-timer')).toHaveTextContent('Conectando…');

    rerender(
      <VoiceCallBar
        activeSpeaker="agent"
        linkPhase="reconnecting"
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );
    expect(screen.getByTestId('voice-call-timer')).toHaveTextContent('Reconectando…');
  });

  it('toggles collapse aria-expanded and optional compact call actions when showCallActions is true', () => {
    const onToggleCollapse = vi.fn();
    const onToggleMic = vi.fn();
    const onToggleSpeaker = vi.fn();
    const onEnd = vi.fn();

    render(
      <VoiceCallBar
        startedAt={Date.now()}
        playbackSpeed={1.25}
        onChangePlaybackSpeed={vi.fn()}
        collapsed={true}
        onToggleCollapse={onToggleCollapse}
        showCallActions={true}
        micMuted={true}
        speakerMuted={false}
        onToggleMicMuted={onToggleMic}
        onToggleSpeakerMuted={onToggleSpeaker}
        onEndSession={onEnd}
      />,
    );

    const collapseBtn = screen.getByTestId('voice-teleprompter-collapse');
    expect(collapseBtn).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(collapseBtn);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);

    const micBtn = screen.getByTestId('voice-call-mic-toggle');
    expect(micBtn).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(micBtn);
    expect(onToggleMic).toHaveBeenCalledTimes(1);

    const speakerBtn = screen.getByTestId('voice-call-speaker-toggle');
    expect(speakerBtn).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(speakerBtn);
    expect(onToggleSpeaker).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('voice-call-end'));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('opens VoiceSpeedPopover with discrete 0..5 range slider, updates speed, and avoids raw <select>', () => {
    const onChange = vi.fn();
    const { container } = render(
      <VoiceSpeedPopover playbackSpeed={1} onChangePlaybackSpeed={onChange} />,
    );

    const trigger = screen.getByTestId('voice-speed-trigger');
    expect(trigger).toHaveClass('rounded-pill');
    expect(trigger).toHaveTextContent('1.0x');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const popover = screen.getByTestId('voice-speed-popover');
    expect(popover).toHaveAttribute('role', 'dialog');
    expect(container.querySelector('select')).toBeNull();
    expect(popover.querySelector('select')).toBeNull();

    const slider = screen.getByTestId('voice-speed-slider') as HTMLInputElement;
    expect(slider).toHaveAttribute('min', '0');
    expect(slider).toHaveAttribute('max', '5');
    expect(slider.value).toBe('1');

    fireEvent.change(slider, { target: { value: '2' } });
    expect(onChange).toHaveBeenCalledWith(1.25);
    expect(popover).toHaveTextContent('1.25x');

    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(1.5);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('voice-speed-popover')).not.toBeInTheDocument();
  });
});
