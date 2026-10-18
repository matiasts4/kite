import React from 'react';
import type { AgentProfile } from '../../../types';
import type { RoutineItem } from './types';
import {
  Calendar,
  Play,
  Pencil,
  Trash2,
  Bot,
  ExternalLink,
  Loader2,
  Webhook,
  Zap,
} from './routineIcons';
import { formatCadence, formatCompactFutureTime } from '../RoutinesView';

export interface RoutineCardProps {
  routine: RoutineItem;
  agent?: AgentProfile;
  busy: boolean;
  readOnly: boolean;
  isRunning: boolean;
  isRunNowAvailable: boolean;
  runNowUnavailableReason?: string;
  onRunNow: (routine: RoutineItem) => void;
  onToggle: (routine: RoutineItem, e?: React.MouseEvent) => void;
  onEdit: (routine: RoutineItem) => void;
  onDelete: (routine: RoutineItem) => void;
  onOpenThread?: (routine: RoutineItem, e?: React.MouseEvent) => void;
}

function formatRelativeTime(timestampMs?: number | null): string {
  if (!timestampMs) return 'Never';
  const diffSec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (diffSec < 10) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(timestampMs).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const RoutineCard: React.FC<RoutineCardProps> = ({
  routine,
  agent,
  busy,
  readOnly,
  isRunning,
  isRunNowAvailable,
  runNowUnavailableReason,
  onRunNow,
  onToggle,
  onEdit,
  onDelete,
  onOpenThread,
}) => {
  const agentName = agent?.name || 'Antigravity Agent';
  const isAgentAuthor =
    routine.author === 'agent' ||
    (typeof routine.author === 'object' && routine.author?.kind === 'agent');
  const triggerKind = routine.triggerType || 'schedule';

  const runDisabled = busy || readOnly || isRunning || !isRunNowAvailable;
  const runTitle = isRunning
    ? 'Running routine...'
    : !isRunNowAvailable
    ? runNowUnavailableReason || 'Run now unavailable'
    : 'Run routine now (runs in readOnly thread and notifies on completion)';

  const statusLabel = routine.lastError
    ? routine.lastError
    : routine.enabled
    ? `Next ${formatCompactFutureTime(routine.nextRunAtUnixMs)}`
    : 'Paused';

  return (
    <li
      className="ui-card__row routine-row"
      style={{
        borderBottom: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.08))',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}
    >
      {/* Heading row */}
      <div className="routine-row__heading" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <strong
          title={routine.name}
          style={{
            fontSize: '14px',
            fontWeight: 600,
            color: 'var(--text-primary, #fff)',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {routine.name}
        </strong>

        {/* Trigger badge */}
        <span
          className="routine-row__badge"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '2px 8px',
            borderRadius: '12px',
            fontSize: '11px',
            backgroundColor: 'var(--block-fill, rgba(255, 255, 255, 0.06))',
            color: 'var(--text-secondary, #9da2b4)',
          }}
        >
          {triggerKind === 'webhook' ? (
            <>
              <Webhook size={11} />
              <span>Webhook</span>
            </>
          ) : triggerKind === 'event' ? (
            <>
              <Zap size={11} />
              <span>Event</span>
            </>
          ) : triggerKind === 'manual' ? (
            <>
              <Play size={11} />
              <span>Manual</span>
            </>
          ) : (
            <>
              <Calendar size={11} />
              <span>{formatCadence(routine)}</span>
            </>
          )}
        </span>

        {/* Agent Author badge */}
        {isAgentAuthor && (
          <span
            className="routine-row__badge"
            title="An agent scheduled this with the schedule tool."
            style={{
              padding: '2px 8px',
              borderRadius: '12px',
              fontSize: '11px',
              backgroundColor: 'rgba(92, 143, 255, 0.15)',
              color: 'var(--accent, #5c8fff)',
            }}
          >
            Agent-created
          </span>
        )}

        {/* Enabled Toggle Switch */}
        <button
          type="button"
          role="switch"
          aria-label={routine.enabled ? `Pause ${routine.name}` : `Resume ${routine.name}`}
          aria-checked={routine.enabled}
          disabled={busy || readOnly}
          onClick={(e) => onToggle(routine, e)}
          className="ui-switch"
          title={routine.enabled ? 'Pause routine' : 'Resume routine'}
        >
          <span className="ui-switch__knob" />
        </button>
      </div>

      {/* Detail row */}
      <div
        className="routine-row__detail"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          fontSize: '12px',
          color: 'var(--text-secondary, #9da2b4)',
        }}
      >
        <Bot size={13} />
        <strong style={{ color: 'var(--text-primary, #ddd)', fontWeight: 500 }}>
          {agentName}
        </strong>
        {agent?.engine && (
          <span style={{ opacity: 0.7, fontSize: '11px' }}>({agent.engine})</span>
        )}
        <span>·</span>
        <span>{formatCadence(routine)}</span>
        {routine.workspaceId && (
          <>
            <span>·</span>
            <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '11px' }}>
              Workspace bound
            </span>
          </>
        )}
      </div>

      {/* Prompt Preview */}
      {routine.prompt && (
        <div
          style={{
            fontSize: '12px',
            lineHeight: '1.4',
            color: 'var(--text-secondary, #a8adbf)',
            backgroundColor: 'rgba(0, 0, 0, 0.18)',
            padding: '6px 10px',
            borderRadius: '6px',
            borderLeft: '2px solid var(--block-stroke, rgba(255, 255, 255, 0.15))',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {routine.prompt}
        </div>
      )}

      {/* Footer Row */}
      <div
        className="routine-row__footer"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: '2px',
          fontSize: '11px',
          color: 'var(--text-secondary, #9da2b4)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span
            className={routine.lastError ? 'routine-row__status--error' : undefined}
            style={{
              color: routine.lastError ? 'var(--status-failed, #ff6568)' : 'inherit',
            }}
          >
            {statusLabel}
          </span>

          <span>Last run: {formatRelativeTime(routine.lastRunAtUnixMs)}</span>
        </div>

        {/* Action buttons */}
        <div className="routine-row__actions" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {routine.lastRunThreadId && onOpenThread && (
            <button
              type="button"
              onClick={(e) => onOpenThread(routine, e)}
              className="secondary-button"
              style={{
                padding: '2px 8px',
                height: '24px',
                borderRadius: '4px',
                fontSize: '11px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                cursor: 'pointer',
              }}
              title={`Open last execution thread: ${routine.lastRunThreadId}`}
            >
              <ExternalLink size={11} />
              <span>Open last run</span>
            </button>
          )}

          {/* Run Now Button */}
          <button
            type="button"
            disabled={runDisabled}
            onClick={() => onRunNow(routine)}
            className="chrome-button"
            style={{
              width: '26px',
              height: '26px',
              borderRadius: '4px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: runDisabled ? 'default' : 'pointer',
              color: isRunning ? 'var(--accent, #5c8fff)' : 'var(--text-secondary, #9da2b4)',
            }}
            title={runTitle}
            aria-label={isRunning ? `Running ${routine.name}` : `Run ${routine.name} now`}
          >
            {isRunning ? (
              <Loader2 size={13} className="routine-row__spinner animate-spin" />
            ) : (
              <Play size={13} />
            )}
          </button>

          {/* Edit Button */}
          <button
            type="button"
            disabled={busy || readOnly}
            onClick={() => onEdit(routine)}
            className="chrome-button"
            style={{
              width: '26px',
              height: '26px',
              borderRadius: '4px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: 'var(--text-secondary, #9da2b4)',
            }}
            title="Edit routine"
            aria-label={`Edit ${routine.name}`}
          >
            <Pencil size={13} />
          </button>

          {/* Delete Button */}
          <button
            type="button"
            disabled={busy || readOnly}
            onClick={() => onDelete(routine)}
            className="chrome-button routine-row__delete"
            style={{
              width: '26px',
              height: '26px',
              borderRadius: '4px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: 'var(--text-secondary, #9da2b4)',
            }}
            title="Delete routine"
            aria-label={`Delete ${routine.name}`}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </li>
  );
};
