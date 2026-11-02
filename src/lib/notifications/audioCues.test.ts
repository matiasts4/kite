import { describe, it, expect, vi, beforeEach } from 'vitest';
import { playCompletionChime, playApprovalChime, resetAudioContextForTesting } from './audioCues';

describe('audioCues', () => {
  let mockOscillator: any;
  let mockGain: any;
  let mockAudioContext: any;

  beforeEach(() => {
    vi.clearAllMocks();
    resetAudioContextForTesting();

    mockOscillator = {
      type: 'sine',
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };

    mockGain = {
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };

    mockAudioContext = {
      currentTime: 10,
      state: 'running',
      resume: vi.fn().mockResolvedValue(undefined),
      createOscillator: vi.fn().mockReturnValue(mockOscillator),
      createGain: vi.fn().mockReturnValue(mockGain),
      destination: {},
    };

    (window as any).AudioContext = vi.fn().mockImplementation(() => mockAudioContext);
  });

  it('does nothing when enabled is false', () => {
    playCompletionChime(true, false);
    expect(mockAudioContext.createOscillator).not.toHaveBeenCalled();

    playApprovalChime(false);
    expect(mockAudioContext.createOscillator).not.toHaveBeenCalled();
  });

  it('synthesizes major triad chord for success turn completion', () => {
    playCompletionChime(true, true);

    // 3 notes for triad
    expect(mockAudioContext.createOscillator).toHaveBeenCalledTimes(3);
    expect(mockAudioContext.createGain).toHaveBeenCalledTimes(3);
    expect(mockOscillator.start).toHaveBeenCalledTimes(3);
    expect(mockOscillator.stop).toHaveBeenCalledTimes(3);
  });

  it('synthesizes minor chord for error turn completion', () => {
    playCompletionChime(false, true);

    // 2 notes for error tone
    expect(mockAudioContext.createOscillator).toHaveBeenCalledTimes(2);
    expect(mockOscillator.start).toHaveBeenCalledTimes(2);
  });

  it('synthesizes dual-tone prompt ping for approval requests', () => {
    playApprovalChime(true);

    // 2 notes for approval ping
    expect(mockAudioContext.createOscillator).toHaveBeenCalledTimes(2);
    expect(mockOscillator.start).toHaveBeenCalledTimes(2);
  });
});
