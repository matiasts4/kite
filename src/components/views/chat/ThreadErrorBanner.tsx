import { useState } from 'react';

export interface TurnFailureView {
  kind: 'usageLimit' | 'authRequired' | 'cliUsageError' | 'processError';
  message: string;
  resetAtUnixMs?: number | null;
  provider?: string;
}

export function formatResetTime(resetAtUnixMs: number | null | undefined): string | null {
  if (!resetAtUnixMs) return null;
  const date = new Date(resetAtUnixMs);
  return `Resets ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export function ThreadErrorBanner({
  failure,
  onDismiss,
  onResume,
  onResumeAtReset,
  onSignIn,
}: {
  failure: TurnFailureView;
  onDismiss: () => void;
  onResume?: () => void;
  onResumeAtReset?: (resetAtUnixMs: number) => void;
  onSignIn?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const reset = formatResetTime(failure.resetAtUnixMs);
  return (
    <section className="thread-error-banner rounded-card" role="alert">
      <strong>{failure.kind === 'usageLimit' ? 'Usage limit' : 'Thread error'}</strong>
      <p>{open ? failure.message : failure.message.slice(0, 140)}</p>
      {failure.message.length > 140 ? (
        <button type="button" onClick={() => setOpen((value) => !value)}>{open ? 'Show less' : 'Show more'}</button>
      ) : null}
      {reset ? <span>{reset}</span> : null}
      {failure.kind === 'usageLimit' ? (
        <>
          <button type="button" onClick={onResume}>Resume now</button>
          {failure.resetAtUnixMs ? (
            <button type="button" onClick={() => onResumeAtReset?.(failure.resetAtUnixMs!)}>Resume at reset</button>
          ) : null}
        </>
      ) : null}
      {failure.kind === 'authRequired' ? (
        <button type="button" onClick={onSignIn}>Sign in</button>
      ) : null}
      <button type="button" aria-label="Dismiss" onClick={onDismiss}>×</button>
    </section>
  );
}
