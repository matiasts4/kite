import React, { useEffect, useRef } from 'react';
import { formatDurationLabel, formatWorkingClock } from './activityPresentation';

export interface LiveElapsedClockProps {
  running?: boolean;
  startedAtUnixMs?: number | null;
  completedAtUnixMs?: number | null;
  durationSeconds?: number | null;
  format?: 'clock' | 'duration';
  prefix?: string;
  idleLabel?: string;
  className?: string;
}

export function formatLiveElapsedText({
  running = false,
  startedAtUnixMs = null,
  completedAtUnixMs = null,
  durationSeconds = null,
  format = 'clock',
  prefix = '',
  idleLabel = 'Live',
  nowMs = Date.now(),
}: LiveElapsedClockProps & { nowMs?: number }): string {
  const start = typeof startedAtUnixMs === 'number' && startedAtUnixMs > 0 ? startedAtUnixMs : 0;
  if (!running) {
    let settledSec = 0;
    if (typeof durationSeconds === 'number' && durationSeconds > 0) {
      settledSec = durationSeconds;
    } else if (
      typeof completedAtUnixMs === 'number' &&
      start > 0 &&
      completedAtUnixMs >= start
    ) {
      settledSec = Math.max(0, (completedAtUnixMs - start) / 1000);
    }
    if (settledSec > 0) {
      return `${prefix}${formatDurationLabel(settledSec)}`;
    }
    return idleLabel;
  }

  if (start <= 0) {
    return idleLabel;
  }

  const elapsedSec = Math.max(0, (nowMs - start) / 1000);
  const formatted =
    format === 'duration' ? formatDurationLabel(elapsedSec) : formatWorkingClock(elapsedSec);
  return `${prefix}${formatted}`;
}

export const LiveElapsedClock: React.FC<LiveElapsedClockProps> = ({
  running = false,
  startedAtUnixMs = null,
  completedAtUnixMs = null,
  durationSeconds = null,
  format = 'clock',
  prefix = '',
  idleLabel = 'Live',
  className,
}) => {
  const spanRef = useRef<HTMLSpanElement | null>(null);
  const initialText = formatLiveElapsedText({
    running,
    startedAtUnixMs,
    completedAtUnixMs,
    durationSeconds,
    format,
    prefix,
    idleLabel,
  });

  useEffect(() => {
    const start = typeof startedAtUnixMs === 'number' && startedAtUnixMs > 0 ? startedAtUnixMs : 0;
    const syncText = () => {
      if (!spanRef.current) return;
      spanRef.current.textContent = formatLiveElapsedText({
        running,
        startedAtUnixMs,
        completedAtUnixMs,
        durationSeconds,
        format,
        prefix,
        idleLabel,
      });
    };
    syncText();
    if (!running || start <= 0) return;
    const timer = window.setInterval(syncText, 1000);
    return () => window.clearInterval(timer);
  }, [running, startedAtUnixMs, completedAtUnixMs, durationSeconds, format, prefix, idleLabel]);

  return (
    <span ref={spanRef} className={className} style={{ fontVariantNumeric: 'tabular-nums' }}>
      {initialText}
    </span>
  );
};
