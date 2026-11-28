import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchSidecarLogs,
  listUiSidecars,
  runSidecarAction,
  type SidecarStateKind,
  type SidecarStatusSnapshot,
} from '../../lib/ipc/pluginRuntime';
import { RotateCcwIcon, RotateCwIcon, TriangleAlertIcon } from './browser/browserIcons';
import { PuzzleIcon, XIcon } from './plugins/pluginIcons';
import './sidecar-panel.css';

const STARTING_POLL_MS = 1500;
const RUNNING_POLL_MS = 5000;

export interface SidecarPanelViewProps {
  sidecarId: string;
  viewPath?: string;
  title?: string;
  workspaceId?: string | null;
  isResizing?: boolean;
}

type NormalizedDotState = 'running' | 'starting' | 'stopped' | 'crashed';

function normalizeDotState(state: SidecarStateKind | null | undefined, hasError: boolean): NormalizedDotState {
  if (state === 'running') return 'running';
  if (state === 'starting') return 'starting';
  if (state === 'crashed' || state === 'unhealthy' || (hasError && !state)) return 'crashed';
  return 'stopped';
}

function matchesSidecarSnapshot(snap: SidecarStatusSnapshot, targetId: string): boolean {
  const lower = targetId.trim().toLowerCase();
  return (
    snap.namespacedId.toLowerCase() === lower ||
    snap.sidecarId.toLowerCase() === lower
  );
}

const PlayGlyph: React.FC = () => (
  <svg width={12} height={12} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <polygon points="6 4 20 12 6 20 6 4" />
  </svg>
);

const StopGlyph: React.FC = () => (
  <svg width={12} height={12} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </svg>
);

const LogsGlyph: React.FC = () => (
  <svg
    width={12}
    height={12}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);

export const SidecarPanelView: React.FC<SidecarPanelViewProps> = ({
  sidecarId,
  viewPath,
  title,
  workspaceId = null,
  isResizing = false,
}) => {
  const [snapshot, setSnapshot] = useState<SidecarStatusSnapshot | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'open' | 'start' | 'stop' | 'restart' | null>('open');
  const [reloadNonce, setReloadNonce] = useState(0);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const snapshotRef = useRef<SidecarStatusSnapshot | null>(null);
  snapshotRef.current = snapshot;

  const loadLogs = useCallback(
    async (targetId: string) => {
      setLogsLoading(true);
      setLogsError(null);
      try {
        const lines = await fetchSidecarLogs(targetId, 200);
        setLogs(lines);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[SidecarPanelView] Failed to fetch sidecar logs:', err);
        setLogsError(message);
      } finally {
        setLogsLoading(false);
      }
    },
    [],
  );

  const executeAction = useCallback(
    async (action: 'open' | 'start' | 'stop' | 'restart') => {
      setBusyAction(action);
      setActionError(null);
      try {
        const next = await runSidecarAction(
          sidecarId,
          action,
          action === 'stop'
            ? { workspaceId }
            : { viewPath, workspaceId },
        );
        setSnapshot(next);
        if (action === 'restart') {
          setReloadNonce((n) => n + 1);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[SidecarPanelView] Action '${action}' failed for ${sidecarId}:`, err);
        setActionError(message);
      } finally {
        setBusyAction(null);
      }
    },
    [sidecarId, viewPath, workspaceId],
  );

  // Open sidecar on mount or target change
  useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    setActionError(null);
    setLogs([]);
    setLogsError(null);
    setBusyAction('open');

    void runSidecarAction(sidecarId, 'open', { viewPath, workspaceId })
      .then((next) => {
        if (cancelled) return;
        setSnapshot(next);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[SidecarPanelView] Failed to open sidecar ${sidecarId}:`, err);
        setActionError(message);
      })
      .finally(() => {
        if (!cancelled) setBusyAction(null);
      });

    return () => {
      cancelled = true;
    };
  }, [sidecarId, viewPath, workspaceId]);

  const currentState = snapshot?.state ?? null;

  // Poll status cleanly every 1500ms while starting, or 5000ms refresh while running
  useEffect(() => {
    if (currentState !== 'starting' && currentState !== 'running') {
      return;
    }

    let cancelled = false;
    let timerId: number | null = null;
    const delayMs = currentState === 'starting' ? STARTING_POLL_MS : RUNNING_POLL_MS;

    const scheduleNext = () => {
      if (cancelled) return;
      timerId = window.setTimeout(() => {
        void pollOnce();
      }, delayMs);
    };

    const pollOnce = async () => {
      if (cancelled) return;
      try {
        const items = await listUiSidecars(workspaceId);
        if (cancelled) return;
        const match = items.find((item) => matchesSidecarSnapshot(item, sidecarId));

        if (match) {
          const prev = snapshotRef.current;
          if (
            currentState === 'starting' &&
            match.state === 'running' &&
            viewPath &&
            viewPath !== '/'
          ) {
            const opened = await runSidecarAction(sidecarId, 'open', { viewPath, workspaceId });
            if (!cancelled) setSnapshot(opened);
          } else {
            setSnapshot((prevSnap) => {
              if (
                prevSnap &&
                prevSnap.entryUrl &&
                match.state === 'running' &&
                prevSnap.proxyUrl &&
                match.proxyUrl === prevSnap.proxyUrl &&
                viewPath &&
                viewPath !== '/'
              ) {
                return { ...match, entryUrl: prevSnap.entryUrl };
              }
              return match;
            });
          }

          if (!cancelled && (match.state === 'starting' || match.state === 'running')) {
            if (logsOpen) {
              void loadLogs(sidecarId);
            }
            if (match.state === currentState) {
              scheduleNext();
            }
          }
          void prev;
          return;
        }

        // Fallback when listUiSidecars has no match during startup (e.g. initial registration race)
        if (currentState === 'starting') {
          const refreshed = await runSidecarAction(sidecarId, 'open', { viewPath, workspaceId });
          if (cancelled) return;
          setSnapshot(refreshed);
          if (refreshed.state === 'starting') {
            scheduleNext();
          }
          return;
        }
      } catch (err) {
        if (!cancelled) {
          console.warn(`[SidecarPanelView] Status poll failed for ${sidecarId}:`, err);
        }
      }
      scheduleNext();
    };

    scheduleNext();

    return () => {
      cancelled = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [currentState, sidecarId, viewPath, workspaceId, logsOpen, loadLogs]);

  const handleToggleLogs = useCallback(() => {
    setLogsOpen((prev) => {
      const next = !prev;
      if (next) {
        void loadLogs(sidecarId);
      }
      return next;
    });
  }, [loadLogs, sidecarId]);

  const handleReloadIframe = useCallback(() => {
    setReloadNonce((n) => n + 1);
    if (iframeRef.current && snapshot?.entryUrl) {
      try {
        iframeRef.current.src = snapshot.entryUrl;
      } catch (err) {
        console.warn('[SidecarPanelView] Failed to reload iframe src:', err);
      }
    }
  }, [snapshot?.entryUrl]);

  const effectiveError = actionError || snapshot?.lastError || null;
  const dotState = normalizeDotState(snapshot?.state, Boolean(actionError));
  const resolvedTitle =
    title?.trim() ||
    snapshot?.views[0]?.title?.trim() ||
    snapshot?.displayName?.trim() ||
    sidecarId;
  const isActive =
    snapshot?.state === 'running' ||
    snapshot?.state === 'starting' ||
    snapshot?.state === 'unhealthy';
  const isReadyFrame = snapshot?.state === 'running' && Boolean(snapshot.entryUrl);

  return (
    <section
      className="sidecar-panel"
      aria-label={resolvedTitle}
      data-testid="sidecar-panel-view"
      data-sidecar-id={sidecarId}
    >
      <header className="sidecar-panel__toolbar" role="toolbar" aria-label="Extension panel controls">
        <span
          className={`sidecar-status-dot sidecar-status-dot--${dotState}`}
          data-testid="sidecar-status-dot"
          data-state={dotState}
          title={`Status: ${dotState}`}
        />
        <span className="sidecar-panel__title" title={`${resolvedTitle} (${sidecarId})`}>
          {resolvedTitle}
        </span>
        <span className="sidecar-panel__state-label" data-testid="sidecar-state-label">
          {dotState}
        </span>

        <div className="sidecar-panel__actions">
          <button
            type="button"
            className="sidecar-panel__icon-btn"
            aria-label="Reload panel"
            title="Reload panel"
            disabled={!isReadyFrame || busyAction !== null}
            onClick={handleReloadIframe}
          >
            <RotateCcwIcon size={12} />
          </button>

          <button
            type="button"
            className="sidecar-panel__icon-btn"
            aria-label="Restart sidecar"
            title="Restart sidecar"
            disabled={busyAction !== null}
            onClick={() => void executeAction('restart')}
          >
            <RotateCwIcon size={12} />
          </button>

          <button
            type="button"
            className="sidecar-panel__icon-btn"
            aria-label={isActive ? 'Stop sidecar' : 'Start sidecar'}
            title={isActive ? 'Stop sidecar' : 'Start sidecar'}
            disabled={busyAction !== null}
            onClick={() => void executeAction(isActive ? 'stop' : 'start')}
          >
            {isActive ? <StopGlyph /> : <PlayGlyph />}
            <span>{isActive ? 'Stop' : 'Start'}</span>
          </button>

          <button
            type="button"
            className="sidecar-panel__icon-btn"
            aria-label="Toggle logs"
            aria-pressed={logsOpen}
            aria-expanded={logsOpen}
            title="Toggle sidecar logs"
            onClick={handleToggleLogs}
          >
            <LogsGlyph />
            <span>Logs</span>
          </button>
        </div>
      </header>

      <div className="sidecar-panel__body">
        {isReadyFrame && snapshot?.entryUrl ? (
          <div className="sidecar-panel__frame-wrap">
            <iframe
              ref={iframeRef}
              key={`${sidecarId}:${reloadNonce}`}
              src={snapshot.entryUrl}
              title={resolvedTitle}
              className="sidecar-panel__frame"
            />
            {isResizing && (
              <div
                className="sidecar-panel__resize-shield"
                data-testid="sidecar-resize-shield"
                aria-hidden="true"
              />
            )}
          </div>
        ) : dotState === 'starting' || (busyAction === 'open' && !effectiveError) ? (
          <div className="sidecar-panel__state sidecar-panel__state--starting" role="status">
            <span className="loading-spinner" aria-hidden="true" />
            <p className="sidecar-panel__state-title">Starting {resolvedTitle}...</p>
            <p className="sidecar-panel__state-message">
              Waiting for the extension service to bind and respond on loopback.
            </p>
            <div className="sidecar-panel__state-actions">
              <button
                type="button"
                className="secondary-button sidecar-panel__state-btn"
                onClick={() => {
                  setLogsOpen(true);
                  void loadLogs(sidecarId);
                }}
              >
                View Logs
              </button>
            </div>
          </div>
        ) : dotState === 'crashed' ? (
          <div className="sidecar-panel__state sidecar-panel__state--crashed" role="alert">
            <span className="sidecar-panel__state-glyph" aria-hidden="true">
              <TriangleAlertIcon size={24} />
            </span>
            <p className="sidecar-panel__state-title">{resolvedTitle} failed to run</p>
            <p className="sidecar-panel__state-error">
              {effectiveError || 'The extension sidecar process exited unexpectedly.'}
            </p>
            <div className="sidecar-panel__state-actions">
              <button
                type="button"
                className="primary-button sidecar-panel__state-btn"
                disabled={busyAction !== null}
                onClick={() => void executeAction(snapshot ? 'restart' : 'open')}
              >
                Retry
              </button>
              <button
                type="button"
                className="secondary-button sidecar-panel__state-btn"
                onClick={() => {
                  setLogsOpen(true);
                  void loadLogs(sidecarId);
                }}
              >
                View Logs
              </button>
            </div>
          </div>
        ) : (
          <div className="sidecar-panel__state sidecar-panel__state--stopped">
            <span className="sidecar-panel__state-glyph" aria-hidden="true">
              <PuzzleIcon size={24} strokeWidth={1.5} />
            </span>
            <p className="sidecar-panel__state-title">{resolvedTitle} is stopped</p>
            <p className="sidecar-panel__state-message">
              {effectiveError || 'Start this extension sidecar to render its interface.'}
            </p>
            <div className="sidecar-panel__state-actions">
              <button
                type="button"
                className="primary-button sidecar-panel__state-btn"
                disabled={busyAction !== null}
                onClick={() => void executeAction('start')}
              >
                Start
              </button>
              <button
                type="button"
                className="secondary-button sidecar-panel__state-btn"
                onClick={() => {
                  setLogsOpen(true);
                  void loadLogs(sidecarId);
                }}
              >
                View Logs
              </button>
            </div>
          </div>
        )}

        {logsOpen && (
          <aside className="sidecar-panel__logs" aria-label="Sidecar logs" data-testid="sidecar-logs-drawer">
            <div className="sidecar-panel__logs-header">
              <span>Logs</span>
              {snapshot?.logPath && (
                <span className="sidecar-panel__logs-path" title={snapshot.logPath}>
                  {snapshot.logPath}
                </span>
              )}
              <button
                type="button"
                className="sidecar-panel__icon-btn"
                aria-label="Refresh logs"
                disabled={logsLoading}
                onClick={() => void loadLogs(sidecarId)}
              >
                <RotateCwIcon size={11} />
              </button>
              <button
                type="button"
                className="sidecar-panel__icon-btn"
                aria-label="Close logs"
                onClick={() => setLogsOpen(false)}
              >
                <XIcon size={12} />
              </button>
            </div>
            <pre className="sidecar-panel__logs-body">
              {logsLoading && logs.length === 0 ? (
                <span className="sidecar-panel__logs-empty">Loading logs...</span>
              ) : logsError ? (
                <span className="sidecar-panel__logs-empty">Failed to load logs: {logsError}</span>
              ) : logs.length > 0 ? (
                logs.join('\n')
              ) : (
                <span className="sidecar-panel__logs-empty">No log output yet.</span>
              )}
            </pre>
          </aside>
        )}
      </div>
    </section>
  );
};
