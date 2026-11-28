import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  playVoiceConnectCue,
  playVoiceDisconnectCue,
  playVoiceErrorCue,
  playVoiceReadyCue,
  startVoiceReconnectPulse,
  _resetVoiceSoundCuesForTesting,
} from './voiceSoundCues';

interface CreatedOscillator {
  type: OscillatorType;
  frequency: {
    setValueAtTime: ReturnType<typeof vi.fn>;
    exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  };
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

interface CreatedGain {
  gain: {
    setValueAtTime: ReturnType<typeof vi.fn>;
    exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
    linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  };
  connect: ReturnType<typeof vi.fn>;
}

describe('voiceSoundCues — Synthesized Web Audio Cues (S4)', () => {
  let oscillators: CreatedOscillator[];
  let gains: CreatedGain[];
  let filters: Array<{
    type: BiquadFilterType;
    frequency: { setValueAtTime: ReturnType<typeof vi.fn> };
    connect: ReturnType<typeof vi.fn>;
  }>;
  let delays: Array<{
    delayTime: { setValueAtTime: ReturnType<typeof vi.fn> };
    connect: ReturnType<typeof vi.fn>;
  }>;
  let mockCtx: {
    currentTime: number;
    state: AudioContextState;
    destination: Record<string, unknown>;
    createOscillator: ReturnType<typeof vi.fn>;
    createGain: ReturnType<typeof vi.fn>;
    createBiquadFilter: ReturnType<typeof vi.fn>;
    createDelay: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  let originalAudioContext: unknown;
  let originalWebkitAudioContext: unknown;

  beforeEach(() => {
    vi.useFakeTimers();
    _resetVoiceSoundCuesForTesting();

    oscillators = [];
    gains = [];
    filters = [];
    delays = [];

    mockCtx = {
      currentTime: 10,
      state: 'running',
      destination: { kind: 'destination' },
      createOscillator: vi.fn(() => {
        const osc: CreatedOscillator = {
          type: 'sine',
          frequency: {
            setValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        };
        oscillators.push(osc);
        return osc;
      }),
      createGain: vi.fn(() => {
        const gainNode: CreatedGain = {
          gain: {
            setValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
            linearRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
        };
        gains.push(gainNode);
        return gainNode;
      }),
      createBiquadFilter: vi.fn(() => {
        const filter = {
          type: 'lowpass' as BiquadFilterType,
          frequency: { setValueAtTime: vi.fn() },
          connect: vi.fn(),
        };
        filters.push(filter);
        return filter;
      }),
      createDelay: vi.fn(() => {
        const delay = {
          delayTime: { setValueAtTime: vi.fn() },
          connect: vi.fn(),
        };
        delays.push(delay);
        return delay;
      }),
      resume: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockImplementation(async () => {
        mockCtx.state = 'closed';
      }),
    };

    originalAudioContext = (window as unknown as Record<string, unknown>).AudioContext;
    originalWebkitAudioContext = (window as unknown as Record<string, unknown>).webkitAudioContext;
    (window as unknown as Record<string, unknown>).AudioContext = vi.fn(() => mockCtx);
    (window as unknown as Record<string, unknown>).webkitAudioContext = undefined;
  });

  afterEach(() => {
    _resetVoiceSoundCuesForTesting();
    (window as unknown as Record<string, unknown>).AudioContext = originalAudioContext;
    (window as unknown as Record<string, unknown>).webkitAudioContext = originalWebkitAudioContext;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('schedules dual ascending sine sweeps through a 2200 Hz lowpass feedback delay bus on connect', () => {
    playVoiceConnectCue(1);

    expect(oscillators).toHaveLength(2);
    expect(oscillators[0].type).toBe('sine');
    expect(oscillators[1].type).toBe('sine');

    // Tone 1: 260 -> 310 Hz over 65ms at 0ms
    expect(oscillators[0].frequency.setValueAtTime).toHaveBeenCalledWith(260, 10);
    expect(oscillators[0].frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(
      310,
      expect.closeTo(10.065, 5),
    );
    expect(oscillators[0].start).toHaveBeenCalledWith(10);

    // Tone 2: 340 -> 420 Hz over 85ms at +55ms
    expect(oscillators[1].frequency.setValueAtTime).toHaveBeenCalledWith(
      340,
      expect.closeTo(10.055, 5),
    );
    expect(oscillators[1].frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(
      420,
      expect.closeTo(10.14, 5),
    );
    expect(oscillators[1].start).toHaveBeenCalledWith(expect.closeTo(10.055, 5));

    // Lowpass 2200 Hz + 90-100ms delay + 0.14-0.20 feedback bus
    expect(filters.length).toBeGreaterThanOrEqual(1);
    expect(filters[0].type).toBe('lowpass');
    expect(filters[0].frequency.setValueAtTime).toHaveBeenCalledWith(2200, 10);

    expect(delays.length).toBeGreaterThanOrEqual(1);
    const delayArg = delays[0].delayTime.setValueAtTime.mock.calls[0]?.[0];
    expect(delayArg).toBeGreaterThanOrEqual(0.09);
    expect(delayArg).toBeLessThanOrEqual(0.1);

    // At least one feedback gain node set in [0.14, 0.20]
    const feedbackGainSet = gains.some((g) =>
      g.gain.setValueAtTime.mock.calls.some(([val]) => val >= 0.14 && val <= 0.2),
    );
    expect(feedbackGainSet).toBe(true);
  });

  it('schedules dual descending sine sweeps on disconnect', () => {
    playVoiceDisconnectCue(0.8);

    expect(oscillators).toHaveLength(2);
    expect(oscillators[0].frequency.setValueAtTime).toHaveBeenCalledWith(380, 10);
    expect(oscillators[0].frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(
      320,
      expect.closeTo(10.065, 5),
    );
    expect(oscillators[1].frequency.setValueAtTime).toHaveBeenCalledWith(
      280,
      expect.closeTo(10.055, 5),
    );
    expect(oscillators[1].frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(
      220,
      expect.closeTo(10.14, 5),
    );
  });

  it('schedules low double-thud error cue at 0ms and +160ms', () => {
    playVoiceErrorCue(1);

    expect(oscillators).toHaveLength(2);
    expect(oscillators[0].frequency.setValueAtTime).toHaveBeenCalledWith(147, 10);
    expect(oscillators[0].frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(
      91,
      expect.closeTo(10.14, 5),
    );
    expect(oscillators[0].start).toHaveBeenCalledWith(10);

    expect(oscillators[1].frequency.setValueAtTime).toHaveBeenCalledWith(
      147,
      expect.closeTo(10.16, 5),
    );
    expect(oscillators[1].frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(
      91,
      expect.closeTo(10.32, 5),
    );
    expect(oscillators[1].start).toHaveBeenCalledWith(expect.closeTo(10.16, 5));
  });

  it('schedules soft ascending ready chime on post-speech rearm cue', () => {
    playVoiceReadyCue(0.9);

    expect(oscillators).toHaveLength(1);
    expect(oscillators[0].type).toBe('sine');
    expect(oscillators[0].frequency.setValueAtTime).toHaveBeenCalledWith(520, 10);
    expect(oscillators[0].frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(
      660,
      expect.closeTo(10.085, 5),
    );
  });

  it('suppresses audio synthesis when volume is 0 or negative and supports 0..100 scale', () => {
    playVoiceConnectCue(0);
    playVoiceDisconnectCue(-0.5);
    playVoiceErrorCue(0);
    expect(mockCtx.createOscillator).not.toHaveBeenCalled();

    // 50% passed as 0..100 scales equivalently to 0.5
    playVoiceConnectCue(50);
    expect(oscillators).toHaveLength(2);
    const halfScaleMaster = gains.find((g) =>
      g.gain.setValueAtTime.mock.calls.some(([val]) => Math.abs(val - 0.5) < 0.01),
    );
    expect(halfScaleMaster).toBeDefined();
  });

  it('handles unavailable AudioContext safely without throwing', () => {
    (window as unknown as Record<string, unknown>).AudioContext = undefined;
    (window as unknown as Record<string, unknown>).webkitAudioContext = undefined;

    expect(() => playVoiceConnectCue(1)).not.toThrow();
    expect(() => playVoiceDisconnectCue(1)).not.toThrow();
    expect(() => playVoiceErrorCue(1)).not.toThrow();
    const stop = startVoiceReconnectPulse(() => false, 1);
    expect(() => stop()).not.toThrow();
  });

  it('pulses reconnect cue after 1000ms and every 2000ms, honors isSuppressed, and cleans up on stop', () => {
    let suppressed = true;
    const stop = startVoiceReconnectPulse(() => suppressed, 0.9);

    // Not fired before 1000ms
    vi.advanceTimersByTime(999);
    expect(oscillators).toHaveLength(0);

    // At 1000ms, suppressed is true -> skipped
    vi.advanceTimersByTime(1);
    expect(oscillators).toHaveLength(0);

    // Unsuppress before next 2000ms tick
    suppressed = false;
    vi.advanceTimersByTime(2000);
    expect(oscillators).toHaveLength(1);
    expect(oscillators[0].frequency.setValueAtTime).toHaveBeenCalledWith(300, 10);
    expect(oscillators[0].frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(
      340,
      expect.closeTo(10.12, 5),
    );

    // Another 2000ms -> second pulse
    vi.advanceTimersByTime(2000);
    expect(oscillators).toHaveLength(2);

    // Stop clears timers and closes AudioContext cleanly
    stop();
    expect(mockCtx.close).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6000);
    expect(oscillators).toHaveLength(2);
  });
});
