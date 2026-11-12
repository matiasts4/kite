import { describe, expect, it } from 'vitest';
import { finishPtyResize, planStartupNudge, requestPtyResize, type PtyResizeGate } from './ptyResizeGate';

const idle: PtyResizeGate = {
  inFlight: false,
  appliedCols: 80,
  appliedRows: 24,
  queued: null,
};

describe('pty resize gate', () => {
  it('sends a new grid and ignores a repeat of the applied grid', () => {
    const sent = requestPtyResize(idle, 100, 30);
    expect(sent.send).toEqual({ cols: 100, rows: 30 });
    expect(sent.gate.inFlight).toBe(true);
    expect(sent.gate.appliedCols).toBe(100);

    const settled = finishPtyResize(sent.gate);
    const repeat = requestPtyResize(settled.gate, 100, 30);
    expect(repeat.send).toBeNull();
    expect(repeat.gate.queued).toBeNull();
    expect(repeat.gate.inFlight).toBe(false);
  });

  it('keeps the latest grid that arrives while a resize is in flight', () => {
    const first = requestPtyResize(idle, 90, 28);
    const queued = requestPtyResize(first.gate, 110, 36);
    expect(queued.send).toBeNull();
    expect(queued.gate.queued).toEqual({ cols: 110, rows: 36 });

    const finished = finishPtyResize(queued.gate);
    expect(finished.send).toEqual({ cols: 110, rows: 36 });
    expect(finished.gate.appliedCols).toBe(110);
    expect(finished.gate.inFlight).toBe(true);

    const settled = finishPtyResize(finished.gate);
    expect(settled.send).toBeNull();
    expect(settled.gate.inFlight).toBe(false);
  });

  it('still sends the applied grid when the caller forces a resize', () => {
    const forced = requestPtyResize(idle, 80, 24, true);
    expect(forced.send).toEqual({ cols: 80, rows: 24 });
  });

  it('plans a one-row startup nudge then the real grid', () => {
    expect(planStartupNudge(120, 36)).toEqual({
      nudge: { cols: 120, rows: 37 },
      restore: { cols: 120, rows: 36 },
    });
    expect(planStartupNudge(19, 24)).toBeNull();
  });
});
