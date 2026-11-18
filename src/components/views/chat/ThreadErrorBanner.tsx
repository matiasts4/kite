import { useEffect, useRef, useState } from 'react';
import { openSettingsTab } from '../../../lib/settingsNav';
import { toast } from '../../../lib/toast';

export interface TurnFailureView {
  kind: 'usageLimit' | 'authRequired' | 'cliUsageError' | 'processError';
  message: string;
  resetAtUnixMs?: number | null;
  provider?: string;
}

/**
 * Failures that block the thread until the user acts (quota exhausted, sign-in
 * needed) stay docked above the composer. Every other failure is transient
 * and is surfaced as a toast instead.
 */
export function isDockedFailure(failure: TurnFailureView): boolean {
  return failure.kind === 'usageLimit' || failure.kind === 'authRequired';
}

const toastedTransientFailures = new Set<string>();
const MAX_TOASTED_TRANSIENT_FAILURES = 200;

export function clearToastedTransientFailuresForTest(): void {
  toastedTransientFailures.clear();
}

/**
 * Surfaces non-blocking (`processError` / `cliUsageError`) failures as a one-time
 * toast per failure occurrence so switching threads never replays stale alerts.
 */
export function useTransientFailureToast(
  thread:
    | {
        id: string;
        updatedAtUnixMs?: number;
        turnFailure?: TurnFailureView | null;
      }
    | null
    | undefined,
  suppressed = false
): void {
  const threadId = thread?.id;
  const updatedAtUnixMs = thread?.updatedAtUnixMs;
  const failure = thread?.turnFailure;
  const failureKind = failure?.kind;
  const failureMessage = failure?.message;

  useEffect(() => {
    if (!threadId || !failure || !failureKind || !failureMessage || suppressed || isDockedFailure(failure)) {
      return;
    }
    const signature = `${threadId}|${updatedAtUnixMs ?? 0}|${failureKind}|${failureMessage}`;
    if (toastedTransientFailures.has(signature)) return;
    if (toastedTransientFailures.size >= MAX_TOASTED_TRANSIENT_FAILURES) {
      const oldest = toastedTransientFailures.values().next().value;
      if (oldest !== undefined) toastedTransientFailures.delete(oldest);
    }
    toastedTransientFailures.add(signature);
    const detail =
      failureMessage.length > 280
        ? `${failureMessage.slice(0, 280).trimEnd()}…`
        : failureMessage;
    toast.error('Thread error', detail);
  }, [threadId, updatedAtUnixMs, failure, failureKind, failureMessage, suppressed]);
}

/**
 * Shared thread-failure UI controller across Thread and Agent Chat surfaces:
 * resets dismissal across thread/failure transitions, shows one-time toasts for
 * transient failures, and returns a docked `ThreadErrorBanner` for `usageLimit`
 * and `authRequired`.
 */
export function useThreadFailureBanner(
  thread:
    | {
        id: string;
        provider?: string;
        updatedAtUnixMs?: number;
        turnFailure?: TurnFailureView | null;
      }
    | null
    | undefined,
  onResume: () => void
) {
  const [failureDismissed, setFailureDismissed] = useState(false);
  const threadId = thread?.id;
  const failure = thread?.turnFailure;
  const failureKind = failure?.kind;
  const failureMessage = failure?.message;

  useEffect(() => {
    setFailureDismissed(false);
  }, [threadId, failureKind, failureMessage]);

  useTransientFailureToast(thread, failureDismissed);

  const failureBanner =
    thread && failure && !failureDismissed && isDockedFailure(failure) ? (
      <ThreadErrorBanner
        failure={failure}
        onDismiss={() => setFailureDismissed(true)}
        onResume={onResume}
        onResumeAtReset={(resetAtUnixMs) => {
          const delay = Math.max(0, resetAtUnixMs - Date.now());
          window.setTimeout(() => onResume(), delay);
        }}
        onSignIn={() => {
          openSettingsTab('quotas', thread.provider);
        }}
      />
    ) : null;

  return { failureDismissed, setFailureDismissed, failureBanner };
}

export function formatResetTime(resetAtUnixMs: number | null | undefined): string | null {
  if (!resetAtUnixMs) return null;
  const date = new Date(resetAtUnixMs);
  return `Resets ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function failureTitle(kind: TurnFailureView['kind']): string {
  if (kind === 'usageLimit') return 'Usage limit reached';
  if (kind === 'authRequired') return 'Sign-in required';
  return 'Thread error';
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
  const lastDispatchedRef = useRef<string | null>(null);
  const reset = formatResetTime(failure.resetAtUnixMs);

  useEffect(() => {
    if (failure.kind !== 'usageLimit') return;
    const signature = `${failure.provider ?? ''}|${failure.message}|${failure.resetAtUnixMs ?? ''}`;
    if (lastDispatchedRef.current === signature) return;
    lastDispatchedRef.current = signature;
    window.dispatchEvent(
      new CustomEvent('kite:usage-limit-detected', {
        detail: {
          provider: failure.provider ?? null,
          message: failure.message,
          resetAtUnixMs: failure.resetAtUnixMs ?? null,
        },
      })
    );
  }, [failure.kind, failure.provider, failure.message, failure.resetAtUnixMs]);
  return (
    <section
      className={`thread-error-banner thread-error-banner--${failure.kind} rounded-card`}
      role="alert"
    >
      <div className="thread-error-banner__body">
        <strong className="thread-error-banner__title">{failureTitle(failure.kind)}</strong>
        <p className="thread-error-banner__message">
          {open ? failure.message : failure.message.slice(0, 140)}
        </p>
        {reset ? <span className="thread-error-banner__reset">{reset}</span> : null}
      </div>
      <div className="thread-error-banner__actions">
        {failure.message.length > 140 ? (
          <button type="button" onClick={() => setOpen((value) => !value)}>
            {open ? 'Show less' : 'Show more'}
          </button>
        ) : null}
        {failure.kind === 'usageLimit' ? (
          <>
            <button type="button" onClick={onResume}>Resume now</button>
            {failure.resetAtUnixMs ? (
              <button type="button" onClick={() => onResumeAtReset?.(failure.resetAtUnixMs!)}>
                Resume at reset
              </button>
            ) : null}
          </>
        ) : null}
        {failure.kind === 'authRequired' ? (
          <button type="button" onClick={onSignIn}>Sign in</button>
        ) : null}
        <button
          type="button"
          className="thread-error-banner__dismiss"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          ×
        </button>
      </div>
    </section>
  );
}
