import { describe, expect, it, vi } from 'vitest';
import {
  classifyForegroundOutputRefresh,
  createSyncOutputHold,
  foregroundRendererRiskOutputPrefersRenderRefresh,
  foregroundRewriteOutputPrefersRenderRefresh,
  splitAlternateScreenEnterChunk,
  stripTransientCursorShows,
  writeTerminalOutputWithRefresh,
} from './terminalSyncOutput';

describe('terminalSyncOutput', () => {
  it('passes ordinary chunks through without retaining them', () => {
    const hold = createSyncOutputHold();
    const out = hold.push('hello\r\n');
    expect(out.map((u) => new TextDecoder().decode(u))).toEqual(['hello\r\n']);
    expect(hold.pending).toBe(false);
    expect(hold.holding).toBe(false);
  });

  it('retains a DEC 2026 synchronized frame until the close marker arrives', () => {
    const hold = createSyncOutputHold();
    expect(hold.push('\x1b[?2026h\x1b[1;1Hframe-part-1')).toEqual([]);
    expect(hold.pending).toBe(true);
    expect(hold.holding).toBe(true);

    const out = hold.push('-part-2\x1b[?2026l');
    expect(out.length).toBe(1);
    expect(new TextDecoder().decode(out[0])).toBe('\x1b[?2026h\x1b[1;1Hframe-part-1-part-2\x1b[?2026l');
    expect(hold.pending).toBe(false);
    expect(hold.holding).toBe(false);
  });

  it('handles markers split across chunk boundaries', () => {
    const hold = createSyncOutputHold();
    expect(hold.push('prefix\x1b[?20').map((u) => new TextDecoder().decode(u))).toEqual(['prefix']);
    expect(hold.pending).toBe(true);
    expect(hold.holding).toBe(false);

    expect(hold.push('26hinside-\x1b[?20')).toEqual([]);
    expect(hold.holding).toBe(true);

    const out = hold.push('26lafter');
    expect(out.map((u) => new TextDecoder().decode(u))).toEqual([
      '\x1b[?2026hinside-\x1b[?2026l',
      'after',
    ]);
    expect(hold.pending).toBe(false);
  });

  it('strips transient cursor show sequences when cursor hides are also present', () => {
    const sample = '\x1b[?25l\x1b[1;1Hhello\x1b[?25h\x1b[2;1Hworld\x1b[?25l';
    const plan = classifyForegroundOutputRefresh(sample);
    expect(plan.stripTransientCursorShows).toBe(true);
    expect(stripTransientCursorShows(sample)).toBe('\x1b[?25l\x1b[1;1Hhello\x1b[2;1Hworld\x1b[?25l');
  });

  it('splits alternate-screen entry chunks so pending resizes apply before painting on ?1049h', () => {
    const data = 'normal-line\r\n\x1b[?1049h\x1b[1;1Halt-screen';
    const split = splitAlternateScreenEnterChunk(data, '', true);
    expect(split.splitBeforeChunkOffset).toBe('normal-line\r\n\x1b[?1049h'.length);
    expect(data.slice(0, split.splitBeforeChunkOffset!)).toBe('normal-line\r\n\x1b[?1049h');
    expect(data.slice(split.splitBeforeChunkOffset!)).toBe('\x1b[1;1Halt-screen');
  });

  it('classifies Windows ConPTY in-place rewrites and SGR/Unicode renderer-risk chunks', () => {
    expect(foregroundRewriteOutputPrefersRenderRefresh('progress 50%\rprogress 60%')).toBe(true);
    expect(foregroundRewriteOutputPrefersRenderRefresh('\x1b[2K\x1b[1Gupdated')).toBe(true);
    expect(foregroundRewriteOutputPrefersRenderRefresh('plain line\r\n')).toBe(false);

    expect(foregroundRendererRiskOutputPrefersRenderRefresh('\x1b[48;2;20;20;20mpanel\x1b[0m')).toBe(true);
    expect(foregroundRendererRiskOutputPrefersRenderRefresh('status 🚀 done')).toBe(true);
    expect(foregroundRendererRiskOutputPrefersRenderRefresh('ascii text only')).toBe(false);
  });

  it('refreshes dirty rows and schedules a follow-up RAF refresh on rewrite chunks', () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    let refreshListener: ((range?: { start: number; end: number }) => void) | null = null;
    const coreRefresh = vi.fn();
    const term = {
      rows: 30,
      buffer: {
        active: {
          type: 'alternate',
          cursorY: 4,
          baseY: 0,
          viewportY: 0,
        },
      },
      _core: {
        _inputHandler: {
          onRequestRefreshRows: (listener: (range?: { start: number; end: number }) => void) => {
            refreshListener = listener;
            return { dispose: () => {} };
          },
        },
        refresh: coreRefresh,
      },
      write: (_data: string, cb?: () => void) => {
        refreshListener?.({ start: 2, end: 8 });
        cb?.();
      },
      refresh: vi.fn(),
    } as any;

    const onParsed = vi.fn();
    writeTerminalOutputWithRefresh(term, '\x1b[2K\rrewritten', {
      forceViewportRefresh: true,
      followupViewportRefresh: true,
      shouldRefreshViewportSynchronously: () => true,
      onParsed,
    });

    expect(onParsed).toHaveBeenCalledTimes(1);
    expect(coreRefresh).toHaveBeenCalledWith(2, 8, true);
    expect(rafCallbacks.length).toBe(1);

    rafCallbacks[0](performance.now());
    expect(coreRefresh).toHaveBeenCalledWith(0, 29, true);
    vi.restoreAllMocks();
  });
});
