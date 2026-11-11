import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useTranscriptLiveEdge } from './useTranscriptMotion';

type Callback = () => void;
const observers: Array<{ cb: Callback; disconnect: ReturnType<typeof vi.fn> }> = [];

class FakeResizeObserver {
  disconnect = vi.fn();
  constructor(cb: Callback) {
    observers.push({ cb, disconnect: this.disconnect });
  }
  observe() {}
  unobserve() {}
}

function Harness({ mounted, edge = true }: { mounted: boolean; edge?: boolean }) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const atLiveEdgeRef = useRef(edge);
  useTranscriptLiveEdge(transcriptRef, 'thread-1', atLiveEdgeRef);
  return mounted ? (
    <div data-testid="scroller" className="chat-transcript" ref={transcriptRef}>
      <div className="chat-transcript__column" />
    </div>
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
  });

  it('does not re-attach on unrelated re-renders and disconnects on unmount', () => {
    const { rerender, unmount } = render(<Harness mounted />);
    rerender(<Harness mounted />);
    expect(observers).toHaveLength(1);
    unmount();
    expect(observers[0].disconnect).toHaveBeenCalled();
  });
});
