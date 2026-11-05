export interface PtyGridSize {
  cols: number;
  rows: number;
}

export interface PtyResizeGate {
  inFlight: boolean;
  appliedCols: number;
  appliedRows: number;
  queued: PtyGridSize | null;
}

export interface PtyResizeDecision {
  gate: PtyResizeGate;
  send: PtyGridSize | null;
}

/**
 * Keep the latest grid while a resize is already in flight.
 * A startup layout often measures twice; dropping the second size leaves the
 * app drawn at the first, provisional grid until the user resizes by hand.
 */
export function requestPtyResize(
  gate: PtyResizeGate,
  cols: number,
  rows: number,
  force = false,
): PtyResizeDecision {
  if (gate.inFlight) {
    return { gate: { ...gate, queued: { cols, rows } }, send: null };
  }
  if (!force && cols === gate.appliedCols && rows === gate.appliedRows) {
    return { gate: { ...gate, queued: null }, send: null };
  }
  return {
    gate: {
      inFlight: true,
      appliedCols: cols,
      appliedRows: rows,
      queued: null,
    },
    send: { cols, rows },
  };
}

/**
 * One-shot SIGWINCH for TUIs that ignore a same-size restore.
 * Send one extra row, then the real grid, so AntiGravity/OpenCode redraw.
 */
export function planStartupNudge(
  cols: number,
  rows: number,
): { nudge: PtyGridSize; restore: PtyGridSize } | null {
  if (cols < 20 || rows < 5) return null;
  return {
    nudge: { cols, rows: rows + 1 },
    restore: { cols, rows },
  };
}

/** After the in-flight resize settles, send the grid that arrived meanwhile. */
export function finishPtyResize(gate: PtyResizeGate): PtyResizeDecision {
  const queued = gate.queued;
  if (!queued || (queued.cols === gate.appliedCols && queued.rows === gate.appliedRows)) {
    return {
      gate: { ...gate, inFlight: false, queued: null },
      send: null,
    };
  }
  return {
    gate: {
      inFlight: true,
      appliedCols: queued.cols,
      appliedRows: queued.rows,
      queued: null,
    },
    send: { cols: queued.cols, rows: queued.rows },
  };
}
