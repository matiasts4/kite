import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type {
  CellSnapshot,
  CursorSnapshot,
  GridState,
  RenderSnapshot,
  TerminalMouseMode,
} from './terminalCanvasTypes';
import type { DecodedBinaryGridSnapshot } from './binarySnapshotDecoder';
import { getActiveAgentTerminals, markTerminalExited } from '../../../../lib/terminalRegistry';

const { decodeCalls, decodeResults } = vi.hoisted(() => ({
  decodeCalls: [] as Array<{ target: GridState | null }>,
  decodeResults: [] as DecodedBinaryGridSnapshot[],
}));

vi.mock('./binarySnapshotDecoder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./binarySnapshotDecoder')>();
  return {
    ...actual,
    decodeBinarySnapshotIntoGrid: (bytes: Uint8Array, target: GridState | null) => {
      decodeCalls.push({ target });
      const decoded = actual.decodeBinarySnapshotIntoGrid(bytes, target);
      decodeResults.push(decoded);
      return decoded;
    },
  };
});

vi.mock('../../../../lib/ipc', () => ({
  invokeCommand: vi.fn(),
  isTauriEnvironment: () => false,
}));

import { invokeCommand } from '../../../../lib/ipc';
import { encodeBinarySnapshot } from './binarySnapshotDecoder';
import {
  MAX_ROW_CACHE_ENTRIES,
  updateTerminalRowCache,
  useTerminalSnapshotPoller,
  type UseTerminalSnapshotPollerOptions,
} from './useTerminalSnapshotPoller';

function cell(overrides: Partial<CellSnapshot> = {}): CellSnapshot {
  return {
    ch: ' ',
    width: 1,
    fg: [250, 250, 250],
    bg: [10, 10, 10],
    hasBg: false,
    bold: false,
    italic: false,
    underline: false,
    inverse: false,
    dim: false,
    ...overrides,
  };
}

function ref<T>(value: T): { current: T } {
  return { current: value };
}

const COLS = 8;
const ROWS = 3;

function frame(
  seq: number,
  full: boolean,
  rows: Array<{ idx: number; text: string }>,
  extra: Partial<RenderSnapshot> = {}
): RenderSnapshot {
  return {
    seq,
    cols: COLS,
    rows: ROWS,
    alternateScreen: false,
    cursor: { visible: true, col: 0, row: 0, shape: 'block' },
    full,
    dirtyRows: rows.map(({ idx, text }) => ({
      rowIdx: idx,
      wrapped: false,
      cells: Array.from({ length: COLS }, (_unused, index) =>
        cell({ ch: text[index] ?? ' ' })
      ),
    })),
    ...extra,
  };
}

function makeOptions(overrides: Partial<UseTerminalSnapshotPollerOptions> = {}) {
  const matrixRef = ref<CellSnapshot[][]>([]);
  const options: UseTerminalSnapshotPollerOptions = {
    sessionId: 'grid-reuse-session',
    workspaceId: 'ws-grid',
    engine: 'terminal',
    matrixRef,
    cursorRef: ref<CursorSnapshot>({ visible: true, col: 0, row: 0, shape: 'block' }),
    alternateScreenRef: ref(false),
    applicationCursorRef: ref(false),
    bracketedPasteRef: ref(false),
    mouseModeRef: ref<TerminalMouseMode>('none'),
    sgrMouseRef: ref(false),
    sgrPixelsMouseRef: ref(false),
    focusReportingRef: ref(false),
    win32InputModeRef: ref(false),
    kittyKeyboardFlagsRef: ref(0),
    scrollbackOffsetRef: ref(0),
    appliedPtyColsRef: ref(0),
    appliedPtyRowsRef: ref(0),
    isFocusedRef: ref(true),
    scheduleRender: vi.fn(),
    lastSeqRef: ref(0),
    hasNotifiedExitRef: ref(false),
    preferBinarySnapshot: true,
    ...overrides,
  };
  return { options, matrixRef };
}

function mockBinaryPolls(frames: Uint8Array[]) {
  let index = 0;
  (invokeCommand as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (command: string) => {
      if (command !== 'poll_terminal_snapshot_bin') return Promise.resolve(null);
      const next = frames[index];
      index += 1;
      return Promise.resolve(next ?? new Uint8Array(0));
    }
  );
}

describe('useTerminalSnapshotPoller packed grid reuse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    decodeCalls.length = 0;
    decodeResults.length = 0;
  });

  afterEach(() => {
    markTerminalExited('grid-reuse-session');
  });

  it('seeds the persistent packed grid on the first frame and reuses it afterwards', async () => {
    mockBinaryPolls([
      encodeBinarySnapshot(frame(1, true, [{ idx: 0, text: 'A' }, { idx: 1, text: 'C' }])),
      encodeBinarySnapshot(frame(2, false, [{ idx: 0, text: 'B' }])),
    ]);
    const { options, matrixRef } = makeOptions();
    const { result } = renderHook(() => useTerminalSnapshotPoller(options));

    await waitFor(() => expect(matrixRef.current[0]?.[0]?.ch).toBe('A'));
    const firstCell = matrixRef.current[0][0];
    const firstRow = matrixRef.current[0];

    act(() => result.current.immediatePoll());
    await waitFor(() => expect(matrixRef.current[0]?.[0]?.ch).toBe('B'));

    expect(decodeCalls).toHaveLength(2);
    expect(decodeCalls[0].target).toBeNull();
    expect(decodeCalls[1].target).toBe(decodeResults[0].grid);
    expect(decodeResults[1].grid).toBe(decodeResults[0].grid);
    expect(decodeResults[1].grid.rows[0].cells[0]).toBe(firstCell);
    expect(matrixRef.current[0]).toBe(firstRow);
    expect(matrixRef.current[0][0]).toBe(firstCell);
    expect(matrixRef.current[1][0].ch).toBe('C');
  });

  it('never decodes a stale frame into the live grid', async () => {
    mockBinaryPolls([
      encodeBinarySnapshot(frame(5, true, [{ idx: 0, text: 'A' }, { idx: 1, text: 'C' }])),
      encodeBinarySnapshot(frame(3, false, [{ idx: 0, text: 'Z' }])),
    ]);
    const { options, matrixRef } = makeOptions();
    const { result } = renderHook(() => useTerminalSnapshotPoller(options));

    await waitFor(() => expect(matrixRef.current[0]?.[0]?.ch).toBe('A'));
    const firstCell = matrixRef.current[0][0];

    act(() => result.current.immediatePoll());
    await waitFor(() => expect(decodeCalls).toHaveLength(2));

    expect(decodeCalls[1].target).toBeNull();
    expect(decodeResults[1].grid).not.toBe(decodeResults[0].grid);
    expect(matrixRef.current[0][0]).toBe(firstCell);
    expect(matrixRef.current[0][0].ch).toBe('A');
  });

  it('records observed PTY bytes carried by the binary frame metadata', async () => {
    const sessionId = 'grid-reuse-observe-bytes';
    mockBinaryPolls([
      encodeBinarySnapshot(
        frame(1, true, [{ idx: 0, text: 'A' }], {
          observedBytesBase64: btoa('OpenCode v0.2.0\n'),
        })
      ),
    ]);
    const { options } = makeOptions({ sessionId });
    renderHook(() => useTerminalSnapshotPoller(options));

    try {
      await waitFor(() => {
        const found = getActiveAgentTerminals().find((term) => term.sessionId === sessionId);
        expect(found?.engine).toBe('open-code');
      });
    } finally {
      markTerminalExited(sessionId);
    }
  });

  it('records observed PTY text carried by the binary frame metadata', async () => {
    const sessionId = 'grid-reuse-observe-text';
    mockBinaryPolls([
      encodeBinarySnapshot(
        frame(1, true, [{ idx: 0, text: 'A' }], {
          observedText: 'Claude Code v1.0.0\n',
        })
      ),
    ]);
    const { options } = makeOptions({ sessionId });
    renderHook(() => useTerminalSnapshotPoller(options));

    try {
      await waitFor(() => {
        const found = getActiveAgentTerminals().find((term) => term.sessionId === sessionId);
        expect(found?.engine).toBe('claude-code');
      });
    } finally {
      markTerminalExited(sessionId);
    }
  });

  it('bounds rowCacheRef to MAX_ROW_CACHE_ENTRIES and avoids cloning unchanged rows', async () => {
    const rowCacheRef = ref<Map<number, CellSnapshot[]>>(new Map());
    mockBinaryPolls([
      encodeBinarySnapshot(frame(1, true, [{ idx: 0, text: 'HELLO' }, { idx: 1, text: 'WORLD' }])),
      encodeBinarySnapshot(frame(2, false, [{ idx: 0, text: 'CHANGED' }])),
    ]);
    const { options } = makeOptions({ rowCacheRef });
    const { result } = renderHook(() => useTerminalSnapshotPoller(options));

    await waitFor(() => expect(rowCacheRef.current.get(0)?.[0]?.ch).toBe('H'));
    const unchangedRow1Ref = rowCacheRef.current.get(1);
    expect(unchangedRow1Ref?.slice(0, 5).map((c) => c.ch).join('')).toBe('WORLD');

    act(() => result.current.immediatePoll());
    await waitFor(() => expect(rowCacheRef.current.get(0)?.[0]?.ch).toBe('C'));

    // Unchanged row 1 must keep the exact same cached reference without re-cloning cells.
    expect(rowCacheRef.current.get(1)).toBe(unchangedRow1Ref);
    expect(rowCacheRef.current.get(0)?.slice(0, 7).map((c) => c.ch).join('')).toBe('CHANGED');

    // Fill cache well past MAX_ROW_CACHE_ENTRIES and verify strict LRU bound.
    const cache = new Map<number, CellSnapshot[]>();
    const row = Array.from({ length: 4 }, (_, i) => cell({ ch: String(i) }));
    for (let offset = 0; offset < MAX_ROW_CACHE_ENTRIES + 120; offset += 1) {
      updateTerminalRowCache(cache, [row], offset, {
        full: false,
        scrollbackChanged: true,
        packed: false,
      });
    }
    expect(cache.size).toBe(MAX_ROW_CACHE_ENTRIES);
    // Non-packed immutable rows are stored directly without per-cell cloning.
    const latestRelRow = -(MAX_ROW_CACHE_ENTRIES + 119);
    expect(cache.get(latestRelRow)).toBe(row);
  });
});
