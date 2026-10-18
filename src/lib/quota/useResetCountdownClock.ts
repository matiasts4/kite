import { useState, useEffect } from 'react';

/**
 * Hook to keep countdown timers refreshed without wasteful re-renders.
 * Updates every second when a reset is within 10 minutes, or every 30 seconds otherwise.
 */
export function useResetCountdownClock(targetMs: number | null | undefined): string | null {
  const [formatted, setFormatted] = useState<string | null>(() => formatTimeUntil(targetMs));

  useEffect(() => {
    setFormatted(formatTimeUntil(targetMs));
    if (!targetMs || targetMs <= 0) return;

    const interval = targetMs < 10 * 60 * 1000 ? 1000 : 30000;
    const timer = setInterval(() => {
      setFormatted(formatTimeUntil(targetMs));
    }, interval);

    return () => clearInterval(timer);
  }, [targetMs]);

  return formatted;
}

export function formatTimeUntil(ms: number | null | undefined): string | null {
  if (ms == null || ms <= 0) return null;
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}

export function formatDetailedReset(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return 'Cuota disponible / Sin límite activo';
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);

  if (days > 0) {
    return `Resetea en ${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `Resetea en ${hours}h ${mins}m`;
  }
  return `Resetea en ${mins}m`;
}
