import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { AgentProfile } from '../../types';
import type {
  RoutineItem,
  RoutineCollection,
  RoutineCadence,
  RoutineTriggerType,
  RoutinePermissionMode,
  RoutineOutputAction,
  RoutineRunRecord,
} from './routines/types';
import { RoutineRunHistoryDrawer } from './routines/RoutineRunHistoryDrawer';
import {
  Clock,
  CheckCircle,
  Plus,
  RefreshCw,
  AlertCircle,
  Loader2,
  Trash2,
  X,
  Search,
  ArrowLeft,
} from './routines/routineIcons';
import { RoutineEditorDrawer } from './routines/RoutineEditorDrawer';
import { RoutineCard } from './routines/RoutineCard';
import { invokeCommand } from '../../lib/ipc';
import './notifications.css';

export interface RoutinesViewProps {
  workspaceId?: string | null;
  onBack?: () => void;
  onOpenThread?: (agentId: string, threadId: string) => void;
  onOpenLastRun?: (agentId: string, threadId: string) => void;
  readOnly?: boolean;
  embedded?: boolean;
}

export function formatRoutineError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  if (typeof err === 'object' && err !== null) {
    const rec = err as { message?: unknown; error?: unknown; code?: unknown };
    if (typeof rec.message === 'string' && rec.message.trim()) return rec.message;
    if (typeof rec.error === 'string' && rec.error.trim()) return rec.error;
    if (typeof rec.code === 'string' && rec.code.trim()) return rec.code;
  }
  return 'Unexpected routine error';
}

function getErrorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

const WEEKDAY_NAMES: Record<number, string> = {
  2: 'Mon',
  3: 'Tue',
  4: 'Wed',
  5: 'Thu',
  6: 'Fri',
  7: 'Sat',
  1: 'Sun',
};

function formatCadenceInterval(seconds: number): string {
  const s = Math.round(seconds);
  if (s % 86400 === 0) {
    const days = s / 86400;
    return days === 1 ? 'every day' : `every ${days} days`;
  }
  if (s % 3600 === 0) {
    const hours = s / 3600;
    return hours === 1 ? 'every hour' : `every ${hours} hours`;
  }
  const mins = Math.max(1, Math.floor(s / 60));
  return mins === 1 ? 'every minute' : `every ${mins} minutes`;
}

export function formatCadence(routine: RoutineItem): string {
  const cadence = routine.cadence;
  if (!cadence?.kind) return 'Manual';

  if (cadence.kind === 'interval') {
    return formatCadenceInterval(cadence.seconds || 3600);
  }

  if (cadence.kind === 'cron') {
    return `cron: ${cadence.expr}`;
  }

  if (cadence.kind === 'event') {
    return cadence.eventKind;
  }

  if (cadence.kind === 'clock') {
    const hour = String(cadence.hour ?? 0);
    const minute = String(cadence.minute ?? 0).padStart(2, '0');
    const time = `${hour}:${minute}`;
    const weekdays = cadence.weekdays;

    if (!weekdays || weekdays.length === 0 || weekdays.length === 7) {
      return `every day at ${time}`;
    }

    const isWeekdays =
      weekdays.length === 5 && [2, 3, 4, 5, 6].every((d) => weekdays.includes(d));
    if (isWeekdays) return `weekdays at ${time}`;

    const isWeekends =
      weekdays.length === 2 && [1, 7].every((d) => weekdays.includes(d));
    if (isWeekends) return `weekends at ${time}`;

    const daysList = [2, 3, 4, 5, 6, 7, 1]
      .filter((d) => weekdays.includes(d))
      .map((d) => WEEKDAY_NAMES[d] || String(d));
    return `${daysList.join(', ')} at ${time}`;
  }

  return 'Scheduled';
}

export function formatCompactFutureTime(timestampMs?: number | null): string {
  if (!timestampMs) return 'Not scheduled';
  const diffSec = Math.floor((timestampMs - Date.now()) / 1000);
  if (diffSec <= 0) return 'due now';
  const diffMin = Math.max(1, Math.round(diffSec / 60));
  if (diffMin < 60) return `in ${diffMin}m`;
  const diffHr = Math.round(diffSec / 3600);
  if (diffHr < 48) return `in ${diffHr}h`;
  const diffDays = Math.round(diffSec / 86400);
  if (diffDays < 14) return `in ${diffDays}d`;
  const diffWeeks = Math.max(2, Math.round(diffDays / 7));
  if (diffWeeks < 8) return `in ${diffWeeks}w`;
  const diffMonths = Math.max(2, Math.round(diffDays / 30.4375));
  return `in ${diffMonths}mo`;
}

function getAgentRevision(collection: RoutineCollection | null, agentId: string): string | null {
  if (!collection?.agentRevisions) return null;
  return collection.agentRevisions.find((r) => r.agentId === agentId)?.revision ?? null;
}

export const RoutinesView: React.FC<RoutinesViewProps> = ({
  workspaceId = null,
  onBack,
  onOpenThread,
  onOpenLastRun,
  readOnly = false,
  embedded = false,
}) => {
  const [collection, setCollection] = useState<RoutineCollection | null>(null);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);
  const [runningRoutineId, setRunningRoutineId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<{
    type: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);

  // Filters & Search
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [triggerFilter, setTriggerFilter] = useState<'all' | RoutineTriggerType>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'paused'>('all');
  const [actionableOnly, setActionableOnly] = useState<boolean>(false);
  const [recentRuns, setRecentRuns] = useState<RoutineRunRecord[]>([]);

  // Drawer / Modal states
  const [isEditorOpen, setIsEditorOpen] = useState<boolean>(false);
  const [editingRoutine, setEditingRoutine] = useState<RoutineItem | null>(null);
  const [deleteConfirmRoutine, setDeleteConfirmRoutine] = useState<RoutineItem | null>(null);
  const [historyRoutine, setHistoryRoutine] = useState<RoutineItem | null>(null);

  const requestVersionRef = useRef<number>(0);

  // Load routine collection and agents
  const loadData = useCallback(async () => {
    const version = ++requestVersionRef.current;
    try {
      setLoading(true);
      const [routinesRes, agentsRes, runsRes] = await Promise.all([
        invokeCommand<RoutineCollection>('list_routines').catch((err) => {
          console.warn('[RoutinesView] list_routines fallback:', err);
          return null;
        }),
        invokeCommand<AgentProfile[]>('list_agent_profiles').catch((err) => {
          console.warn('[RoutinesView] list_agent_profiles fallback:', err);
          return [];
        }),
        invokeCommand<{ runs?: RoutineRunRecord[] }>('list_routine_runs', { limit: 100 }).catch((err) => {
          console.warn('[RoutinesView] list_routine_runs fallback:', err);
          return null;
        }),
      ]);

      if (version === requestVersionRef.current) {
        if (routinesRes) {
          setCollection(routinesRes);
        }
        if (agentsRes && agentsRes.length > 0) {
          setAgents(agentsRes);
        }
        if (runsRes && Array.isArray(runsRes.runs)) {
          setRecentRuns(runsRes.runs);
        }
      }
    } catch (err: unknown) {
      console.error('[RoutinesView] Failed to load routines:', err);
      if (version === requestVersionRef.current) {
        setStatusMessage({ type: 'error', text: `Failed to load routines: ${formatRoutineError(err)}` });
      }
    } finally {
      if (version === requestVersionRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (embedded) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (isEditorOpen || historyRoutine) return;
      if (deleteConfirmRoutine) {
        e.preventDefault();
        e.stopPropagation();
        if (!busy) setDeleteConfirmRoutine(null);
        return;
      }
      if (onBack) {
        e.preventDefault();
        e.stopPropagation();
        onBack();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [embedded, onBack, isEditorOpen, historyRoutine, deleteConfirmRoutine, busy]);

  const invokeRoutineWithConflictRetry = async <T,>(
    agentId: string,
    call: (revision: string) => Promise<T>
  ): Promise<T> => {
    let currentColl = collection;
    if (!currentColl) {
      currentColl = await invokeCommand<RoutineCollection>('list_routines');
      setCollection(currentColl);
    }
    let revision = getAgentRevision(currentColl, agentId);
    if (!revision && currentColl?.agentRevisions && currentColl.agentRevisions.length > 0) {
      revision = currentColl.agentRevisions[0].revision;
    }
    if (!revision) {
      revision = '0000000000000000000000000000000000000000000000000000000000000000';
    }

    try {
      return await call(revision);
    } catch (err: unknown) {
      if (getErrorCode(err) !== 'routine_conflict') {
        throw err;
      }
      const freshColl = await invokeCommand<RoutineCollection>('list_routines');
      setCollection(freshColl);
      const freshRev = getAgentRevision(freshColl, agentId) || revision;
      return await call(freshRev);
    }
  };

  // Execute Routine Now with optimistic lock & conflict retry
  const handleRunNow = async (routine: RoutineItem) => {
    if (busy || readOnly) return;
    setRunningRoutineId(routine.id);
    setBusy(true);

    try {
      const requestId = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `req-${Date.now()}`;

      const runResult = await invokeRoutineWithConflictRetry<{
        started: boolean;
        replayed: boolean;
        threadId: string | null;
        runId: string | null;
        snapshot: RoutineCollection;
      }>(routine.agentId, (rev) =>
        invokeCommand('run_routine_now', {
          agentId: routine.agentId,
          routineId: routine.id,
          expectedRevision: rev,
          requestId,
        })
      );

      if (runResult?.snapshot) {
        setCollection(runResult.snapshot);
      }

      setStatusMessage({
        type: 'success',
        text: runResult.replayed
          ? `Routine request replayed. Thread: ${runResult.threadId || 'active'}`
          : `Routine "${routine.name}" started successfully.`,
      });
      setTimeout(() => setStatusMessage(null), 5000);
    } catch (err: unknown) {
      console.error('[RoutinesView] Run routine error:', err);
      setStatusMessage({ type: 'error', text: `Could not start routine: ${formatRoutineError(err)}` });
      setTimeout(() => setStatusMessage(null), 6000);
    } finally {
      setRunningRoutineId(null);
      setBusy(false);
    }
  };

  // Toggle Routine Enabled State
  const handleToggle = async (routine: RoutineItem, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (busy || readOnly) return;

    try {
      setBusy(true);
      const updated = await invokeRoutineWithConflictRetry<RoutineCollection>(routine.agentId, (rev) =>
        invokeCommand<RoutineCollection>('set_routine_enabled', {
          agentId: routine.agentId,
          routineId: routine.id,
          expectedRevision: rev,
          enabled: !routine.enabled,
        })
      );

      setCollection(updated);
      setStatusMessage({
        type: 'success',
        text: routine.enabled ? `Routine "${routine.name}" paused.` : `Routine "${routine.name}" resumed.`,
      });
      setTimeout(() => setStatusMessage(null), 3000);
    } catch (err: unknown) {
      console.error('[RoutinesView] Toggle error:', err);
      setStatusMessage({ type: 'error', text: `Failed to toggle routine: ${formatRoutineError(err)}` });
    } finally {
      setBusy(false);
    }
  };

  // Save / Update routine handler
  const handleSaveRoutineDraft = async (draft: {
    name: string;
    prompt: string;
    agentId: string;
    cadence: RoutineCadence;
    triggerType: RoutineTriggerType;
    permissionMode?: RoutinePermissionMode;
    maxRetries?: number;
    outputActions?: RoutineOutputAction[];
    notifyTeammateId?: string | null;
  }): Promise<boolean> => {
    if (readOnly) return false;
    setBusy(true);

    try {
      const agentId = draft.agentId || agents[0]?.id || 'c3333333-3333-4333-8333-333333333333';

      if (editingRoutine) {
        const updatedSnapshot = await invokeRoutineWithConflictRetry<RoutineCollection>(agentId, (rev) =>
          invokeCommand<RoutineCollection>('update_routine', {
            agentId,
            routineId: editingRoutine.id,
            expectedRevision: rev,
            update: {
              name: draft.name,
              prompt: draft.prompt,
              cadence: draft.cadence,
              triggerType: draft.triggerType,
              workspaceId: editingRoutine.workspaceId ?? workspaceId ?? null,
              permissionMode: draft.permissionMode ?? editingRoutine.permissionMode ?? 'readOnly',
              maxRetries: draft.maxRetries ?? 0,
              outputActions: draft.outputActions ?? [],
              notifyTeammateId: draft.notifyTeammateId ?? null,
            },
          })
        );
        setCollection(updatedSnapshot);
        setStatusMessage({
          type: 'success',
          text: `Routine "${draft.name}" updated successfully.`,
        });
      } else {
        const updatedSnapshot = await invokeRoutineWithConflictRetry<RoutineCollection>(agentId, (rev) =>
          invokeCommand<RoutineCollection>('create_routine', {
            agentId,
            expectedRevision: rev,
            draft: {
              name: draft.name,
              prompt: draft.prompt,
              cadence: draft.cadence,
              triggerType: draft.triggerType,
              workspaceId: workspaceId ?? null,
              permissionMode: draft.permissionMode ?? 'readOnly',
              maxRetries: draft.maxRetries ?? 0,
              outputActions: draft.outputActions ?? [],
              notifyTeammateId: draft.notifyTeammateId ?? null,
            },
          })
        );
        setCollection(updatedSnapshot);
        setStatusMessage({
          type: 'success',
          text: `Routine "${draft.name}" created successfully.`,
        });
      }

      setTimeout(() => setStatusMessage(null), 4000);
      return true;
    } catch (err: unknown) {
      console.error('[RoutinesView] Save error:', err);
      setStatusMessage({ type: 'error', text: `Failed to save routine: ${formatRoutineError(err)}` });
      throw err;
    } finally {
      setBusy(false);
    }
  };

  // Delete Routine
  const handleDeleteRoutine = async (routine: RoutineItem) => {
    if (readOnly) return;
    setBusy(true);

    try {
      const res = await invokeRoutineWithConflictRetry<{ deleted: boolean; snapshot: RoutineCollection }>(
        routine.agentId,
        (rev) =>
          invokeCommand<{ deleted: boolean; snapshot: RoutineCollection }>('delete_routine', {
            agentId: routine.agentId,
            routineId: routine.id,
            expectedRevision: rev,
          })
      );

      if (res?.snapshot) {
        setCollection(res.snapshot);
      } else {
        const fresh = await invokeCommand<RoutineCollection>('list_routines');
        setCollection(fresh);
      }

      setDeleteConfirmRoutine(null);
      setStatusMessage({ type: 'info', text: `Routine "${routine.name}" deleted.` });
      setTimeout(() => setStatusMessage(null), 3000);
    } catch (err: unknown) {
      console.error('[RoutinesView] Delete error:', err);
      setStatusMessage({ type: 'error', text: `Failed to delete routine: ${formatRoutineError(err)}` });
    } finally {
      setBusy(false);
    }
  };

  // Sort and filter routines
  const rawRoutines = useMemo(() => collection?.routines || [], [collection?.routines]);

  const quietTicksCount = useMemo(
    () => recentRuns.filter((run) => run.status === 'quiet').length,
    [recentRuns]
  );

  const latestRunStatusByRoutine = useMemo(() => {
    const map = new Map<string, RoutineRunRecord>();
    for (const run of recentRuns) {
      if (!map.has(run.routineId)) {
        map.set(run.routineId, run);
      }
    }
    return map;
  }, [recentRuns]);

  const filteredRoutines = useMemo(() => {
    const sorted = [...rawRoutines].sort((a, b) => {
      if (a.enabled !== b.enabled) {
        return a.enabled ? -1 : 1;
      }
      const aNext = a.nextRunAtUnixMs ?? 0;
      const bNext = b.nextRunAtUnixMs ?? 0;
      if (aNext !== bNext) return aNext - bNext;
      return (a.createdAtUnixMs ?? 0) - (b.createdAtUnixMs ?? 0);
    });

    return sorted.filter((r) => {
      if (statusFilter === 'active' && !r.enabled) return false;
      if (statusFilter === 'paused' && r.enabled) return false;

      if (actionableOnly && !r.lastError) {
        const latest = latestRunStatusByRoutine.get(r.id);
        if (latest && latest.status === 'quiet') {
          return false;
        }
      }

      const rTrigger = r.triggerType || 'schedule';
      if (triggerFilter !== 'all' && rTrigger !== triggerFilter) return false;

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesName = r.name.toLowerCase().includes(q);
        const matchesPrompt = (r.prompt || '').toLowerCase().includes(q);
        const agentName = agents.find((a) => a.id === r.agentId)?.name?.toLowerCase() || '';
        const matchesAgent = agentName.includes(q);
        if (!matchesName && !matchesPrompt && !matchesAgent) return false;
      }

      return true;
    });
  }, [rawRoutines, statusFilter, actionableOnly, latestRunStatusByRoutine, triggerFilter, searchQuery, agents]);

  const activeCount = useMemo(() => rawRoutines.filter((r) => r.enabled).length, [rawRoutines]);
  const isRunNowAvailable = collection?.runNowAvailability?.available !== false;
  const runNowUnavailableReason = collection?.runNowAvailability?.reason || '';

  const handleOpenThreadAction = (routine: RoutineItem, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!routine.lastRunThreadId) return;
    if (onOpenThread && routine.agentId) {
      onOpenThread(routine.agentId, routine.lastRunThreadId);
    } else if (onOpenLastRun && routine.agentId) {
      onOpenLastRun(routine.agentId, routine.lastRunThreadId);
    }
  };

  const toolbarButtons = (
    <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
      <button
        type="button"
        onClick={loadData}
        disabled={loading || busy}
        className="secondary-button"
        style={{
          padding: '0 12px',
          height: 'var(--vl-control-md, 32px)',
          borderRadius: 'var(--control-radius, 8px)',
          fontSize: '12px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '5px',
          cursor: 'pointer',
        }}
        title="Refresh routines collection"
      >
        <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        <span>Refresh</span>
      </button>

      <button
        type="button"
        onClick={() => {
          setEditingRoutine(null);
          setIsEditorOpen(true);
        }}
        disabled={busy || readOnly}
        className="primary-button"
        style={{
          padding: '0 14px',
          height: 'var(--vl-control-md, 32px)',
          borderRadius: 'var(--control-radius, 8px)',
          fontSize: '12px',
          fontWeight: 600,
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          cursor: 'pointer',
        }}
      >
        <Plus size={13} />
        <span>New routine</span>
      </button>
    </div>
  );

  return (
    <section
      className={
        embedded
          ? 'routine-pane routine-pane--embedded select-none'
          : 'pane destination-pane routine-pane select-none'
      }
      aria-label={embedded ? 'Automated Routines' : undefined}
    >
      {!embedded && (
        <header className="pane-titlebar pane-titlebar--large">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="secondary-button routine-titlebar__back"
              aria-label="Back to Agents"
              title="Back to Agents"
            >
              <ArrowLeft size={13} />
              <span>Back</span>
            </button>
          )}
          <span aria-hidden="true" className="pane-titlebar__icon">
            <Clock size={16} />
          </span>
          <span className="pane-titlebar__copy">
            <strong>Automated Routines</strong>
            <small>Work your agents pick up on their own.</small>
          </span>

          {/* Global Toolbar actions */}
          {toolbarButtons}
        </header>
      )}

      {/* Routine Pane Body */}
      <div className={embedded ? 'routine-list-embedded' : 'routine-list-scroll'}>
        <div className={embedded ? undefined : 'routine-list-shell'}>
          {embedded && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: '12px' }}>
              {toolbarButtons}
            </div>
          )}
          {/* Status Message Banner */}
          {statusMessage && (
            <div
              className={`routine-feedback ${
                statusMessage.type === 'error' ? 'routine-feedback--error' : ''
              }`}
              role="alert"
              style={{
                borderRadius: 'var(--control-radius, 8px)',
                padding: '8px 12px',
                marginBottom: '14px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '12px',
                backgroundColor:
                  statusMessage.type === 'error'
                    ? 'color-mix(in srgb, var(--status-failed, #ff6568) 12%, transparent)'
                    : 'var(--accent-tint, color-mix(in srgb, var(--accent, #5c8fff) 12%, transparent))',
                border:
                  statusMessage.type === 'error'
                    ? '1px solid color-mix(in srgb, var(--status-failed, #ff6568) 28%, transparent)'
                    : '1px solid var(--accent-tint-strong, color-mix(in srgb, var(--accent, #5c8fff) 28%, transparent))',
                color:
                  statusMessage.type === 'error'
                    ? 'var(--danger-ink, var(--status-failed, #ff6568))'
                    : 'var(--accent, #5c8fff)',
              }}
            >
              {statusMessage.type === 'error' ? (
                <AlertCircle size={15} />
              ) : (
                <CheckCircle size={15} />
              )}
              <span style={{ flex: 1 }}>{statusMessage.text}</span>
              <button
                type="button"
                onClick={() => setStatusMessage(null)}
                style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer' }}
                aria-label="Close message"
              >
                <X size={12} />
              </button>
            </div>
          )}

          {/* Search & Filter Toolbar */}
          <div className="routine-toolbar">
            <div className="routine-toolbar__row">
              {/* Search Input */}
              <div className="routine-toolbar__search">
                <Search size={13} style={{ color: 'var(--text-secondary, #9da2b4)', flexShrink: 0 }} />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search routines by name, prompt or agent..."
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    style={{ background: 'none', border: 0, color: 'var(--text-secondary)', cursor: 'pointer' }}
                    aria-label="Clear search"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>

              {/* Trigger Filter Buttons */}
              <div className="routine-toolbar__group">
                {(
                  [
                    { id: 'all', label: 'All Triggers' },
                    { id: 'schedule', label: 'Schedule' },
                    { id: 'webhook', label: 'Webhook' },
                    { id: 'event', label: 'Event' },
                    { id: 'manual', label: 'Manual' },
                  ] as const
                ).map((f) => {
                  const active = triggerFilter === f.id;
                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setTriggerFilter(f.id)}
                      className={`routine-toolbar__chip${active ? ' routine-toolbar__chip--active' : ''}`}
                    >
                      {f.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="routine-toolbar__row">
              {/* Status Filter */}
              <div className="routine-toolbar__group">
                {(
                  [
                    { id: 'all', label: `All (${rawRoutines.length})` },
                    { id: 'active', label: `Active (${activeCount})` },
                    { id: 'paused', label: 'Paused' },
                  ] as const
                ).map((s) => {
                  const active = statusFilter === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setStatusFilter(s.id)}
                      className={`routine-toolbar__chip${active ? ' routine-toolbar__chip--active' : ''}`}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>

              {/* Quiet Ticks Triage */}
              <div className="routine-triage-bar">
                <button
                  type="button"
                  className="routine-triage-btn"
                  aria-pressed={actionableOnly}
                  onClick={() => setActionableOnly((prev) => !prev)}
                  title="Filter out routines whose latest tick ended cleanly with HEARTBEAT_OK"
                >
                  Actionable only
                </button>
                <span className="routine-quiet-summary">
                  {quietTicksCount} quiet ticks auto-archived
                </span>
              </div>
            </div>
          </div>

          {/* Loading state */}
          {loading && rawRoutines.length === 0 ? (
            <div className="routine-loading" style={{ padding: '60px 0', textAlign: 'center' }}>
              <Loader2 size={24} className="animate-spin" style={{ color: 'var(--accent, #5c8fff)' }} />
              <span className="sr-only">Opening routines…</span>
            </div>
          ) : rawRoutines.length === 0 ? (
            /* Empty state */
            <div className="empty-surface empty-surface--embedded routine-empty" style={{ padding: '48px 24px', textAlign: 'center' }}>
              <div aria-hidden="true" className="routine-empty__icon" style={{ marginBottom: '16px' }}>
                <Clock size={32} strokeWidth={1.5} />
              </div>
              <h1 style={{ fontSize: '18px', fontWeight: 600, color: 'var(--text-primary, #fafafa)', marginBottom: '8px' }}>
                No routines yet
              </h1>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary, #a1a1a1)', maxWidth: '480px', margin: '0 auto 20px', lineHeight: 1.5 }}>
                {agents.length === 0
                  ? 'Create an agent first, then add a job here — or let the agent schedule one itself while you work.'
                  : 'A routine is a job an agent picks up on a clock or trigger: morning triage, an hourly sweep, or repository checks. You can add one, or an agent can create one with the schedule tool.'}
              </p>
              {agents.length > 0 && (
                <button
                  type="button"
                  disabled={readOnly || busy}
                  onClick={() => {
                    setEditingRoutine(null);
                    setIsEditorOpen(true);
                  }}
                  className="primary-button routine-empty__button"
                  style={{
                    height: 'var(--vl-control-md, 32px)',
                    padding: '0 20px',
                    borderRadius: 'var(--control-radius, 8px)',
                    fontWeight: 600,
                    fontSize: '13px',
                    cursor: 'pointer',
                  }}
                >
                  New routine
                </button>
              )}
            </div>
          ) : filteredRoutines.length === 0 ? (
            <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-secondary, #9da2b4)', fontSize: '13px' }}>
              No routines matched the selected filter or search query.
            </div>
          ) : (
            /* Routine list */
            <ul aria-label="Scheduled routines" className="ui-card routine-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {filteredRoutines.map((routine) => {
                const isRunning = runningRoutineId === routine.id;
                const agent = agents.find((a) => a.id === routine.agentId);

                return (
                  <RoutineCard
                    key={routine.id}
                    routine={routine}
                    agent={agent}
                    busy={busy}
                    readOnly={readOnly}
                    isRunning={isRunning}
                    isRunNowAvailable={isRunNowAvailable}
                    runNowUnavailableReason={runNowUnavailableReason}
                    onRunNow={handleRunNow}
                    onToggle={handleToggle}
                    onEdit={(r) => {
                      setEditingRoutine(r);
                      setIsEditorOpen(true);
                    }}
                    onDelete={(r) => setDeleteConfirmRoutine(r)}
                    onViewHistory={(r) => setHistoryRoutine(r)}
                    onOpenThread={handleOpenThreadAction}
                  />
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <RoutineRunHistoryDrawer
        routine={historyRoutine}
        onClose={() => setHistoryRoutine(null)}
        onOpenThread={onOpenThread || onOpenLastRun}
      />

      {/* Routine Editor Drawer/Modal */}
      <RoutineEditorDrawer
        isOpen={isEditorOpen}
        onClose={() => {
          setIsEditorOpen(false);
          setEditingRoutine(null);
        }}
        onSave={handleSaveRoutineDraft}
        editingRoutine={editingRoutine}
        agents={agents}
        busy={busy}
      />

      {/* Delete Confirmation Modal */}
      {deleteConfirmRoutine && (
        <div
          className="notif-modal-backdrop"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 99999,
            backgroundColor: 'var(--glass-modal-scrim, var(--glass-backdrop-scrim, rgba(0, 0, 0, 0.72)))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
          }}
          onClick={() => !busy && setDeleteConfirmRoutine(null)}
        >
          <div
            className="notif-modal-dialog"
            style={{
              width: '440px',
              maxWidth: '100%',
              background: 'var(--glass-modal-bg, var(--glass-overlay-bg, var(--menu-plate, #16171d)))',
              WebkitBackdropFilter: 'var(--glass-overlay-blur)',
              backdropFilter: 'var(--glass-overlay-blur)',
              borderRadius: 'var(--dialog-radius, 14px)',
              border: '1px solid var(--glass-border, var(--block-stroke, rgba(255, 255, 255, 0.12)))',
              boxShadow: 'var(--glass-shadow, 0 20px 45px rgba(0, 0, 0, 0.55))',
              padding: '20px',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--status-failed, #ff6568)', marginBottom: '12px' }}>
              <Trash2 size={18} />
              <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: 'var(--text-primary, #fafafa)' }}>
                Delete Routine
              </h3>
            </div>
            <p style={{ fontSize: '13px', color: 'var(--text-primary, #fafafa)', lineHeight: 1.4, margin: '0 0 8px' }}>
              Are you sure you want to delete routine <strong>&quot;{deleteConfirmRoutine.name}&quot;</strong>?
            </p>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary, #9da2b4)', lineHeight: 1.4, margin: '0 0 20px' }}>
              This will cancel future background schedules. Existing threads or previous notifications remain preserved.
            </p>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                type="button"
                disabled={busy}
                onClick={() => setDeleteConfirmRoutine(null)}
                className="secondary-button"
                style={{
                  height: 'var(--vl-control-md, 32px)',
                  padding: '0 14px',
                  borderRadius: 'var(--control-radius, 8px)',
                  fontSize: '12px',
                  border: '1px solid var(--glass-inner-border, var(--block-stroke))',
                  backgroundColor: 'transparent',
                  color: 'var(--text-primary, #fafafa)',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => handleDeleteRoutine(deleteConfirmRoutine)}
                style={{
                  height: 'var(--vl-control-md, 32px)',
                  padding: '0 16px',
                  borderRadius: 'var(--control-radius, 8px)',
                  fontSize: '12px',
                  fontWeight: 600,
                  backgroundColor: 'var(--status-failed, #ff6568)',
                  color: 'var(--accent-on-fill, #fff)',
                  border: 0,
                  cursor: 'pointer',
                }}
              >
                {busy ? 'Deleting...' : 'Delete Routine'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

export default RoutinesView;
