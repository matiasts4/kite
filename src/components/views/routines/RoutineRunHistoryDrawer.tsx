import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { RoutineItem, RoutineRunRecord } from './types';
import { Clock, ExternalLink, Loader2, RefreshCw, X } from './routineIcons';

export interface RoutineRunHistoryDrawerProps {
  routine: RoutineItem | null;
  onClose: () => void;
  onOpenThread?: (agentId: string, threadId: string) => void;
}

function formatTimestamp(ms?: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

function formatDuration(startMs: number, endMs?: number | null): string {
  if (!endMs || endMs < startMs) return '—';
  const sec = Math.round((endMs - startMs) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}

export const RoutineRunHistoryDrawer: React.FC<RoutineRunHistoryDrawerProps> = ({
  routine,
  onClose,
  onOpenThread,
}) => {
  const [runs, setRuns] = useState<RoutineRunRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = async () => {
    if (!routine) return;
    setLoading(true);
    setError(null);
    try {
      const res = await invoke<{ runs?: RoutineRunRecord[] }>('list_routine_runs', {
        request: { routineId: routine.id, limit: 30 },
      });
      setRuns(res?.runs ?? []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load routine runs');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (routine) {
      void loadRuns();
    } else {
      setRuns([]);
      setError(null);
    }
  }, [routine?.id]);

  if (!routine) return null;

  return (
    <div
      className="notif-modal-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        backgroundColor: 'var(--glass-modal-scrim, rgba(0, 0, 0, 0.72))',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="notif-modal-dialog"
        role="dialog"
        aria-label={`Run history for ${routine.name}`}
        style={{
          width: '680px',
          maxWidth: '100%',
          maxHeight: '85vh',
          background: 'var(--glass-modal-bg, var(--menu-plate, #16171d))',
          borderRadius: 'var(--dialog-radius, 14px)',
          border: '1px solid var(--glass-border, var(--block-stroke, rgba(255, 255, 255, 0.12)))',
          boxShadow: 'var(--glass-shadow, 0 20px 45px rgba(0, 0, 0, 0.55))',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--separator, rgba(255, 255, 255, 0.08))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Clock size={16} />
            <div>
              <h2 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: 'var(--text-primary, #fff)' }}>
                Run History — {routine.name}
              </h2>
              <p style={{ margin: '2px 0 0', fontSize: '12px', color: 'var(--text-secondary, #9da2b4)' }}>
                SQLite audit ledger (`routine_runs`) for recent scheduled and event executions.
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <button
              type="button"
              className="chrome-button"
              onClick={() => void loadRuns()}
              disabled={loading}
              aria-label="Refresh run history"
              style={{
                height: 'var(--vl-control-sm, 28px)',
                padding: '0 8px',
                borderRadius: 'var(--control-radius, 8px)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close run history"
              style={{
                background: 'none',
                border: 0,
                padding: '6px',
                color: 'var(--text-secondary, #9da2b4)',
                cursor: 'pointer',
                borderRadius: 'var(--control-radius, 8px)',
                display: 'inline-flex',
              }}
            >
              <X size={15} />
            </button>
          </div>
        </div>

        <div style={{ padding: '16px 20px', overflowY: 'auto', flex: 1 }}>
          {error ? (
            <p className="routine-feedback routine-feedback--error" role="alert">
              {error}
            </p>
          ) : loading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)' }}>
              <Loader2 size={14} className="animate-spin" />
              <span>Loading execution history...</span>
            </div>
          ) : runs.length === 0 ? (
            <p style={{ color: 'var(--text-secondary, #9da2b4)', fontSize: '13px', margin: 0 }}>
              No recorded runs yet for this routine.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {runs.map((run) => (
                <li
                  key={run.runId}
                  className="ui-card"
                  style={{
                    padding: '12px',
                    borderRadius: 'var(--card-radius, 12px)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <strong style={{ fontSize: '12px', textTransform: 'uppercase' }}>{run.status}</strong>
                      <span style={{ fontSize: '11px', color: 'var(--text-secondary, #9da2b4)' }}>
                        Trigger: {run.triggerKind}
                      </span>
                      {run.retryAttempt > 0 ? (
                        <span style={{ fontSize: '11px', color: 'var(--warning-color, #e3b341)' }}>
                          Retry #{run.retryAttempt}
                        </span>
                      ) : null}
                    </div>
                    <span style={{ fontSize: '11px', color: 'var(--text-secondary, #9da2b4)' }}>
                      {formatTimestamp(run.startedAtUnixMs)} ({formatDuration(run.startedAtUnixMs, run.finishedAtUnixMs)})
                    </span>
                  </div>
                  {run.summary ? (
                    <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-primary, #fff)' }}>
                      {run.summary}
                    </p>
                  ) : null}
                  {run.error ? (
                    <p style={{ margin: 0, fontSize: '12px', color: 'var(--status-failed, #ff6568)' }}>
                      {run.error}
                    </p>
                  ) : null}
                  {run.threadId && onOpenThread ? (
                    <div>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => onOpenThread(run.agentId, run.threadId!)}
                        style={{
                          height: 'var(--vl-control-sm, 26px)',
                          padding: '0 8px',
                          borderRadius: 'var(--control-radius, 8px)',
                          fontSize: '11px',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                        }}
                      >
                        <ExternalLink size={11} />
                        <span>Open thread</span>
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};
