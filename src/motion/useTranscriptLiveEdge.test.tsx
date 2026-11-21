import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { useTranscriptLiveEdge } from './useTranscriptMotion';

type Callback = () => void;
const observers: Array<{ cb: Callback; disconnect: ReturnType<typeof vi.fn>; targets: Element[] }> = [];

class FakeResizeObserver {
  disconnect = vi.fn();
  targets: Element[] = [];
  constructor(cb: Callback) {
    observers.push({ cb, disconnect: this.disconnect, targets: this.targets });
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve() {}
}

function Harness({
  mounted,
  edge = true,
  threadId = 'thread-1',
  contentKey,
  followTrigger,
  onPauseChange,
}: {
  mounted: boolean;
  edge?: boolean;
  threadId?: string;
  contentKey?: unknown;
  followTrigger?: unknown;
  onPauseChange?: (paused: boolean) => void;
}) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const atLiveEdgeRef = useRef(edge);
  const { handleScroll, syncLiveEdge } = useTranscriptLiveEdge(transcriptRef, threadId, atLiveEdgeRef, {
    contentKey,
    followTrigger,
    onPauseChange,
  });
  return mounted ? (
    <>
      <div
        data-testid="scroller"
        className="chat-transcript"
        ref={transcriptRef}
        onScroll={handleScroll}
      >
        <div className="chat-transcript__column" />
      </div>
      <button type="button" data-testid="sync" onClick={syncLiveEdge} />
    </>
  ) : null;
}

describe('useTranscriptLiveEdge', () => {
  beforeEach(() => {
    observers.length = 0;
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('attaches when the transcript mounts after the thread id was already set', () => {
    const { rerender } = render(<Harness mounted={false} />);
    expect(observers).toHaveLength(0);
    rerender(<Harness mounted />);
    expect(observers).toHaveLength(1);
    expect(observers[0].targets.length).toBeGreaterThanOrEqual(2);
  });

  it('does not re-attach on unrelated re-renders and disconnects on unmount', () => {
    const { rerender, unmount } = render(<Harness mounted />);
    rerender(<Harness mounted />);
    expect(observers).toHaveLength(1);
    unmount();
    expect(observers[0].disconnect).toHaveBeenCalled();
  });

  it('pins to scrollHeight on content updates and scroller resizes without delta drift, and snaps back on followTrigger', () => {
    const onPauseChange = vi.fn();
    let scrollHeight = 500;
    let clientHeight = 300;
    let scrollTop = 0;

    const { getByTestId, rerender } = render(
      <Harness
        mounted
        contentKey="k1"
        followTrigger="u1"
        onPauseChange={onPauseChange}
      />,
    );
    const scroller = getByTestId('scroller');
    Object.defineProperty(scroller, 'scrollHeight', { get: () => scrollHeight, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { get: () => clientHeight, configurable: true });
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => scrollTop,
      set: (val: number) => {
        scrollTop = Math.min(val, Math.max(0, scrollHeight - clientHeight));
      },
      configurable: true,
    });

    // Simulate content growing while pinned (even when column ResizeObserver has not fired)
    scrollHeight = 820;
    rerender(
      <Harness
        mounted
        contentKey="k2"
        followTrigger="u1"
        onPauseChange={onPauseChange}
      />,
    );
    expect(scrollTop).toBe(520);

    // Simulate scroller shrinking (e.g. composer or ChangedFilesCard expanding)
    clientHeight = 220;
    observers[0].cb();
    expect(scrollTop).toBe(600);

    // Simulate user scrolling up -> pauses auto-scroll
    scrollTop = 100;
    fireEvent.scroll(scroller);
    expect(onPauseChange).toHaveBeenLastCalledWith(true);

    scrollHeight = 980;
    rerender(
      <Harness
        mounted
        contentKey="k3"
        followTrigger="u1"
        onPauseChange={onPauseChange}
      />,
    );
    expect(scrollTop).toBe(100);

    // Sending a new message (followTrigger changes) re-pins to bottom
    rerender(
      <Harness
        mounted
        contentKey="k4"
        followTrigger="u2"
        onPauseChange={onPauseChange}
      />,
    );
    expect(onPauseChange).toHaveBeenLastCalledWith(false);
    expect(scrollTop).toBe(760);
  });

  it('pauses auto-scroll while the user has an active pointer selection inside the transcript', () => {
    let scrollHeight = 800;
    const clientHeight = 300;
    let scrollTop = 500;

    const { getByTestId, rerender } = render(
      <Harness mounted contentKey="k1" followTrigger="u1" />,
    );
    const scroller = getByTestId('scroller');
    Object.defineProperty(scroller, 'scrollHeight', { get: () => scrollHeight, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { get: () => clientHeight, configurable: true });
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => scrollTop,
      set: (val: number) => {
        scrollTop = Math.min(val, Math.max(0, scrollHeight - clientHeight));
      },
      configurable: true,
    });

    fireEvent.pointerDown(scroller);
    scrollHeight = 1100;
    rerender(<Harness mounted contentKey="k2" followTrigger="u1" />);
    expect(scrollTop).toBe(500);

    fireEvent.pointerUp(window);
    expect(scrollTop).toBe(800);
  });

  it('attaches pointer selection pause listeners when the scroller mounts after draft state', () => {
    const { getByTestId, rerender } = render(<Harness mounted={false} contentKey="draft" />);
    rerender(<Harness mounted contentKey="k1" followTrigger="u1" />);

    const scroller = getByTestId('scroller') as HTMLDivElement;
    let scrollHeight = 800;
    let scrollTop = 500;
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 300 });
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.min(value, Math.max(0, scrollHeight - 300));
      },
    });

    fireEvent.pointerDown(scroller);
    scrollHeight = 1100;
    rerender(<Harness mounted contentKey="k2" followTrigger="u1" />);
    expect(scrollTop).toBe(500);

    fireEvent.pointerUp(window);
    expect(scrollTop).toBe(800);
  });

  it('re-pins synchronously via syncLiveEdge when scroller clientHeight shrinks before ResizeObserver fires', () => {
    const scrollHeight = 820;
    let clientHeight = 300;
    let scrollTop = 520;

    const { getByTestId } = render(
      <Harness mounted contentKey="k1" followTrigger="u1" />,
    );
    const scroller = getByTestId('scroller');
    Object.defineProperty(scroller, 'scrollHeight', { get: () => scrollHeight, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { get: () => clientHeight, configurable: true });
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => scrollTop,
      set: (val: number) => {
        scrollTop = Math.min(val, Math.max(0, scrollHeight - clientHeight));
      },
      configurable: true,
    });

    // Shrink viewport height (e.g. composer wrapping to a new line) without firing ResizeObserver yet.
    clientHeight = 264;
    fireEvent.click(getByTestId('sync'));
    expect(scrollTop).toBe(556);

    // Once user scrolls up, syncLiveEdge respects paused state and does not snap back.
    scrollTop = 120;
    fireEvent.scroll(scroller);
    clientHeight = 240;
    fireEvent.click(getByTestId('sync'));
    expect(scrollTop).toBe(120);
  });

  it('ignores unrelated document selectionchange events and only resumes pinning after a transcript selection clears', () => {
    let scrollHeight = 800;
    const clientHeight = 300;
    let scrollTop = 480;
    const scrollWrites: number[] = [];

    const { getByTestId, rerender } = render(
      <Harness mounted contentKey="k1" followTrigger="u1" />,
    );
    const scroller = getByTestId('scroller');
    const column = scroller.querySelector('.chat-transcript__column') as HTMLDivElement;
    const textNode = document.createTextNode('assistant reply');
    column.appendChild(textNode);

    Object.defineProperty(scroller, 'scrollHeight', { get: () => scrollHeight, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { get: () => clientHeight, configurable: true });
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => scrollTop,
      set: (val: number) => {
        scrollWrites.push(val);
        scrollTop = Math.min(val, Math.max(0, scrollHeight - clientHeight));
      },
      configurable: true,
    });

    let selectionState: { isCollapsed: boolean; rangeCount: number; anchorNode: Node | null; focusNode: Node | null } = {
      isCollapsed: true,
      rangeCount: 0,
      anchorNode: null,
      focusNode: null,
    };
    const getSelectionSpy = vi
      .spyOn(window, 'getSelection')
      .mockImplementation(() => selectionState as unknown as Selection);

    // Unrelated selectionchange (e.g. caret moving in the composer textarea) must not touch scrollTop.
    document.dispatchEvent(new Event('selectionchange'));
    expect(scrollWrites).toHaveLength(0);
    expect(scrollTop).toBe(480);

    // Selecting text inside the transcript pauses auto-scroll during content growth.
    selectionState = {
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: textNode,
      focusNode: textNode,
    };
    document.dispatchEvent(new Event('selectionchange'));
    scrollHeight = 1000;
    rerender(<Harness mounted contentKey="k2" followTrigger="u1" />);
    expect(scrollWrites).toHaveLength(0);
    expect(scrollTop).toBe(480);

    // Clearing the transcript selection resumes pinning to the latest bottom edge.
    selectionState = {
      isCollapsed: true,
      rangeCount: 0,
      anchorNode: null,
      focusNode: null,
    };
    document.dispatchEvent(new Event('selectionchange'));
    expect(scrollWrites).toEqual([1000]);
    expect(scrollTop).toBe(700);

    getSelectionSpy.mockRestore();
  });
});
