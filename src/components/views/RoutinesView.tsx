import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { AgentProfile } from '../../types';
import type {
  RoutineItem,
  RoutineCollection,
  RoutineCadence,
  RoutineTriggerType,
} from './routines/types';
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
} from './routines/routineIcons';
import { RoutineEditorDrawer } from './routines/RoutineEditorDrawer';
import { RoutineCard } from './routines/RoutineCard';
import { invokeCommand } from '../../lib/ipc';
import './notifications.css';

export interface RoutinesViewProps {
  workspaceId?: string | null;
  onOpenThread?: (agentId: string, threadId: string) => void;
  onOpenLastRun?: (agentId: string, threadId: string) => void;
  readOnly?: boolean;
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
  onOpenThread,
  onOpenLastRun,
  readOnly = false,
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

  // Drawer / Modal states
  const [isEditorOpen, setIsEditorOpen] = useState<boolean>(false);
  const [editingRoutine, setEditingRoutine] = useState<RoutineItem | null>(null);
  const [deleteConfirmRoutine, setDeleteConfirmRoutine] = useState<RoutineItem | null>(null);

  const requestVersionRef = useRef<number>(0);

  // Load routine collection and agents
  const loadData = useCallback(async () => {
    const version = ++requestVersionRef.current;
    try {
      setLoading(true);
      const [routinesRes, agentsRes] = await Promise.all([
        invokeCommand<RoutineCollection>('list_routines').catch((err) => {
          console.warn('[RoutinesView] list_routines fallback:', err);
          return null;
        }),
        invokeCommand<AgentProfile[]>('list_agent_profiles').catch(() => []),
      ]);

      if (version === requestVersionRef.current) {
        if (routinesRes) {
          setCollection(routinesRes);
        }
        if (agentsRes && agentsRes.length > 0) {
          setAgents(agentsRes);
        }
      }
    } catch (err: unknown) {
      console.error('[RoutinesView] Failed to load routines:', err);
      if (version === requestVersionRef.current) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatusMessage({ type: 'error', text: `Failed to load routines: ${msg}` });
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

  // Execute Routine Now with optimistic lock & conflict retry
  const handleRunNow = async (routine: RoutineItem) => {
    if (busy || readOnly) return;
    setRunningRoutineId(routine.id);
    setBusy(true);

    try {
      let currentColl = collection;
      if (!currentColl) {
        currentColl = await invokeCommand<RoutineCollection>('list_routines');
        setCollection(currentColl);
      }

      let revision = getAgentRevision(currentColl, routine.agentId);
      if (!revision && currentColl?.agentRevisions && currentColl.agentRevisions.length > 0) {
        revision = currentColl.agentRevisions[0].revision;
      }
      if (!revision) {
        revision = '0000000000000000000000000000000000000000000000000000000000000000';
      }

      const requestId = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `req-${Date.now()}`;

      let runResult: {
        started: boolean;
        replayed: boolean;
        threadId: string | null;
        runId: string | null;
        snapshot: RoutineCollection;
      };

      try {
        runResult = await invokeCommand('run_routine_now', {
          agentId: routine.agentId,
          routineId: routine.id,
          expectedRevision: revision,
          requestId,
        });
      } catch (runErr: any) {
        // Handle revision conflict
        if (runErr?.code === 'routine_conflict') {
          const freshColl = await invokeCommand<RoutineCollection>('list_routines');
          setCollection(freshColl);
          const freshRev = getAgentRevision(freshColl, routine.agentId) || revision;
          runResult = await invokeCommand('run_routine_now', {
            agentId: routine.agentId,
            routineId: routine.id,
            expectedRevision: freshRev,
            requestId,
          });
        } else {
          throw runErr;
        }
      }

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
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage({ type: 'error', text: `Could not start routine: ${msg}` });
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
      let revision = getAgentRevision(collection, routine.agentId);
      if (!revision) {
        const fresh = await invokeCommand<RoutineCollection>('list_routines');
        setCollection(fresh);
        revision = getAgentRevision(fresh, routine.agentId) || '0000000000000000000000000000000000000000000000000000000000000000';
      }

      const updated = await invokeCommand<RoutineCollection>('set_routine_enabled', {
        agentId: routine.agentId,
        routineId: routine.id,
        expectedRevision: revision,
        enabled: !routine.enabled,
      });

      setCollection(updated);
      setStatusMessage({
        type: 'success',
        text: routine.enabled ? `Routine "${routine.name}" paused.` : `Routine "${routine.name}" resumed.`,
      });
      setTimeout(() => setStatusMessage(null), 3000);
    } catch (err: unknown) {
      console.error('[RoutinesView] Toggle error:', err);
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage({ type: 'error', text: `Failed to toggle routine: ${msg}` });
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
  }): Promise<boolean> => {
    if (readOnly) return false;
    setBusy(true);

    try {
      let currentColl = collection;
      if (!currentColl) {
        currentColl = await invokeCommand<RoutineCollection>('list_routines');
        setCollection(currentColl);
      }

      const agentId = draft.agentId || agents[0]?.id || 'c3333333-3333-4333-8333-333333333333';
      let revision = getAgentRevision(currentColl, agentId);

      if (!revision) {
        const fresh = await invokeCommand<RoutineCollection>('list_routines');
        setCollection(fresh);
        revision = getAgentRevision(fresh, agentId) || '0000000000000000000000000000000000000000000000000000000000000000';
      }

      if (editingRoutine) {
        const updatedSnapshot = await invokeCommand<RoutineCollection>('update_routine', {
          agentId,
          routineId: editingRoutine.id,
          expectedRevision: revision,
          update: {
            name: draft.name,
            prompt: draft.prompt,
            cadence: draft.cadence,
            workspaceId: editingRoutine.workspaceId ?? workspaceId ?? null,
          },
        });
        setCollection(updatedSnapshot);
        setStatusMessage({
          type: 'success',
          text: `Routine "${draft.name}" updated successfully.`,
        });
      } else {
        const updatedSnapshot = await invokeCommand<RoutineCollection>('create_routine', {
          agentId,
          expectedRevision: revision,
          draft: {
            name: draft.name,
            prompt: draft.prompt,
            cadence: draft.cadence,
            workspaceId: workspaceId ?? null,
          },
        });
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
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage({ type: 'error', text: `Failed to save routine: ${msg}` });
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
      let revision = getAgentRevision(collection, routine.agentId);
      if (!revision) {
        const fresh = await invokeCommand<RoutineCollection>('list_routines');
        setCollection(fresh);
        revision = getAgentRevision(fresh, routine.agentId) || '0000000000000000000000000000000000000000000000000000000000000000';
      }

      const res = await invokeCommand<{ deleted: boolean; snapshot: RoutineCollection }>(
        'delete_routine',
        {
          agentId: routine.agentId,
          routineId: routine.id,
          expectedRevision: revision,
        }
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
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage({ type: 'error', text: `Failed to delete routine: ${msg}` });
    } finally {
      setBusy(false);
    }
  };

  // Sort and filter routines
  const rawRoutines = useMemo(() => collection?.routines || [], [collection?.routines]);

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
  }, [rawRoutines, statusFilter, triggerFilter, searchQuery, agents]);

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

  return (
    <section className="pane destination-pane routine-pane select-none">
      {/* Titlebar Header */}
      <header className="pane-titlebar pane-titlebar--large">
        <span aria-hidden="true" className="pane-titlebar__icon">
          <Clock size={16} />
        </span>
        <span className="pane-titlebar__copy">
          <strong>Automated Routines</strong>
          <small>Work your agents pick up on their own.</small>
        </span>

        {/* Global Toolbar actions */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            type="button"
            onClick={loadData}
            disabled={loading || busy}
            className="secondary-button"
            style={{
              padding: '0 10px',
              height: '28px',
              borderRadius: '6px',
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
              padding: '0 12px',
              height: '28px',
              borderRadius: '6px',
              fontSize: '12px',
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              cursor: 'pointer',
              backgroundColor: 'var(--accent, #5c8fff)',
              color: '#fff',
            }}
          >
            <Plus size={13} />
            <span>+ New routine</span>
          </button>
        </div>
      </header>

      <div className="agent-pane__rule" />

      {/* Routine Pane Body */}
      <div className="routine-list-scroll">
        <div className="routine-list-shell">
          {/* Status Message Banner */}
          {statusMessage && (
            <div
              className={`routine-feedback ${
                statusMessage.type === 'error' ? 'routine-feedback--error' : ''
              }`}
              role="alert"
              style={{
                borderRadius: '8px',
                padding: '8px 12px',
                marginBottom: '14px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '12px',
                backgroundColor:
                  statusMessage.type === 'error'
                    ? 'rgba(255, 101, 104, 0.12)'
                    : 'rgba(92, 143, 255, 0.12)',
                border:
                  statusMessage.type === 'error'
                    ? '1px solid rgba(255, 101, 104, 0.3)'
                    : '1px solid rgba(92, 143, 255, 0.3)',
                color: statusMessage.type === 'error' ? '#ff8a8c' : '#a0c0ff',
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
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              marginBottom: '14px',
              flexWrap: 'wrap',
            }}
          >
            {/* Search Input */}
            <div
              className="plugin-search"
              style={{
                flex: 1,
                minWidth: '220px',
                height: '32px',
                borderRadius: '6px',
                padding: '0 10px',
                backgroundColor: 'var(--block-fill, rgba(255, 255, 255, 0.04))',
                border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.1))',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <Search size={13} style={{ color: 'var(--text-secondary, #9da2b4)', flexShrink: 0 }} />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search routines by name, prompt or agent..."
                style={{
                  background: 'none',
                  border: 0,
                  outline: 'none',
                  color: 'var(--text-primary, #fff)',
                  fontSize: '12px',
                  width: '100%',
                }}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  style={{ background: 'none', border: 0, color: 'var(--text-secondary)', cursor: 'pointer' }}
                >
                  <X size={12} />
                </button>
              )}
            </div>

            {/* Trigger Filter Buttons */}
            <div
              style={{
                display: 'flex',
                gap: '4px',
                backgroundColor: 'rgba(255, 255, 255, 0.03)',
                padding: '2px',
                borderRadius: '6px',
                border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.08))',
              }}
            >
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
                    style={{
                      padding: '4px 8px',
                      borderRadius: '4px',
                      border: 0,
                      backgroundColor: active ? 'rgba(92, 143, 255, 0.2)' : 'transparent',
                      color: active ? 'var(--text-primary, #fff)' : 'var(--text-secondary, #9da2b4)',
                      fontSize: '11px',
                      fontWeight: active ? 600 : 400,
                      cursor: 'pointer',
                    }}
                  >
                    {f.label}
                  </button>
                );
              })}
            </div>

            {/* Status Filter */}
            <div
              style={{
                display: 'flex',
                gap: '4px',
                backgroundColor: 'rgba(255, 255, 255, 0.03)',
                padding: '2px',
                borderRadius: '6px',
                border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.08))',
              }}
            >
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
                    style={{
                      padding: '4px 8px',
                      borderRadius: '4px',
                      border: 0,
                      backgroundColor: active ? 'rgba(92, 143, 255, 0.2)' : 'transparent',
                      color: active ? 'var(--text-primary, #fff)' : 'var(--text-secondary, #9da2b4)',
                      fontSize: '11px',
                      fontWeight: active ? 600 : 400,
                      cursor: 'pointer',
                    }}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Loading state */}
          {loading && rawRoutines.length === 0 ? (
            <div className="routine-loading" style={{ padding: '60px 0', textAlign: 'center' }}>
              <Loader2 size={24} className="animate-spin text-[#5c8fff]" />
              <span className="sr-only">Opening routines…</span>
            </div>
          ) : rawRoutines.length === 0 ? (
            /* Empty state */
            <div className="empty-surface empty-surface--embedded routine-empty" style={{ padding: '48px 24px', textAlign: 'center' }}>
              <div aria-hidden="true" className="routine-empty__icon" style={{ marginBottom: '16px' }}>
                <Clock size={32} strokeWidth={1.5} />
              </div>
              <h1 style={{ fontSize: '18px', fontWeight: 600, color: 'var(--text-primary, #fff)', marginBottom: '8px' }}>
                No routines yet
              </h1>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary, #9da2b4)', maxWidth: '480px', margin: '0 auto 20px', lineHeight: 1.5 }}>
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
                    padding: '8px 20px',
                    borderRadius: '6px',
                    backgroundColor: 'var(--accent, #5c8fff)',
                    color: '#fff',
                    fontWeight: 600,
                    fontSize: '13px',
                    border: 0,
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
                    onOpenThread={handleOpenThreadAction}
                  />
                );
              })}
            </ul>
          )}
        </div>
      </div>

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
            backgroundColor: 'rgba(0, 0, 0, 0.72)',
            backdropFilter: 'blur(3px)',
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
              backgroundColor: 'var(--dialog, #16171d)',
              borderRadius: '10px',
              border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.12))',
              boxShadow: '0 20px 45px rgba(0, 0, 0, 0.55)',
              padding: '20px',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--status-failed, #ff6568)', marginBottom: '12px' }}>
              <Trash2 size={18} />
              <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: 'var(--text-primary, #fff)' }}>
                Delete Routine
              </h3>
            </div>
            <p style={{ fontSize: '13px', color: 'var(--text-primary, #eee)', lineHeight: 1.4, margin: '0 0 8px' }}>
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
                style={{
                  padding: '6px 14px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.12))',
                  backgroundColor: 'transparent',
                  color: 'var(--text-primary, #fff)',
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
                  padding: '6px 16px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  fontWeight: 600,
                  backgroundColor: 'var(--status-failed, #ff6568)',
                  color: '#fff',
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
