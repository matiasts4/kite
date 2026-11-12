import React from 'react';

export interface TerminalCanvasScrollbarProps {
  show: boolean;
  scrollbarTrackRef: React.Ref<HTMLDivElement>;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  thumbRatio: number;
  depth: number;
  offset: number;
}

export const TerminalCanvasScrollbar: React.FC<TerminalCanvasScrollbarProps> = ({
  show,
  scrollbarTrackRef,
  onPointerDown,
  thumbRatio,
  depth,
  offset,
}) => {
  if (!show) return null;

  const thumbHeightPct = Math.max(8, Math.round(thumbRatio * 100));
  const thumbTopPct = depth <= 0 ? 0 : ((depth - offset) / depth) * (100 - thumbHeightPct);

  return (
    <div
      ref={scrollbarTrackRef}
      className="terminal-canvas-scrollbar"
      onPointerDown={onPointerDown}
    >
      <div
        className="terminal-canvas-scrollbar__thumb"
        style={{
          height: `${thumbHeightPct}%`,
          top: `${thumbTopPct}%`,
        }}
      />
    </div>
  );
};
