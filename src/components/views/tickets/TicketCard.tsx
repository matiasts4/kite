import React from 'react';
import { TicketIssue, TaskExecutionRun, getLabelColor } from './types';


// Clean SVG Priority Glyph matching bundle
export const PriorityGlyph: React.FC<{ priority: number | string; size?: number }> = ({
  priority,
  size = 14,
}) => {
  let num = 0;
  if (typeof priority === 'number') {
    num = priority;
  } else {
    switch (priority) {
      case 'Urgent': num = 1; break;
      case 'High': num = 2; break;
      case 'Medium':
      case 'Normal': num = 3; break;
      case 'Low': num = 4; break;
      default: num = 0; break;
    }
  }

  const renderBar = (x: number, h: number, active: boolean) => (
    <rect
      key={x}
      fill={active ? 'var(--text-secondary, #8b949e)' : 'var(--block-stroke, #30363d)'}
      height={h}
      rx="0.8"
      width="2.4"
      x={x}
      y={12 - h}
    />
  );

  let children = null;
  switch (num) {
    case 1:
      children = (
        <>
          <rect fill="var(--warning, #d29922)" height="12" rx="2.5" width="12" x="1" y="1" />
          <path d="M7 3.6v4.2" stroke="var(--accent-ink, #0d1117)" strokeLinecap="round" strokeWidth="1.7" />
          <circle cx="7" cy="10.3" fill="var(--accent-ink, #0d1117)" r="0.95" />
        </>
      );
      break;
    case 2:
      children = (
        <>
          {renderBar(2.2, 4, true)}
          {renderBar(5.8, 7, true)}
          {renderBar(9.4, 10, true)}
        </>
      );
      break;
    case 3:
      children = (
        <>
          {renderBar(2.2, 4, true)}
          {renderBar(5.8, 7, true)}
          {renderBar(9.4, 10, false)}
        </>
      );
      break;
    case 4:
      children = (
        <>
          {renderBar(2.2, 4, true)}
          {renderBar(5.8, 7, false)}
          {renderBar(9.4, 10, false)}
        </>
      );
      break;
    default:
      children = (
        <>
          <rect fill="var(--text-faint, #484f58)" height="1.6" rx="0.8" width="2.2" x="1.8" y="6.2" />
          <rect fill="var(--text-faint, #484f58)" height="1.6" rx="0.8" width="2.2" x="5.9" y="6.2" />
          <rect fill="var(--text-faint, #484f58)" height="1.6" rx="0.8" width="2.2" x="10" y="6.2" />
        </>
      );
      break;
  }

  return (
    <svg
      aria-hidden="true"
      className="ticket-priority-glyph"
      data-priority={num}
      focusable="false"
      height={size}
      viewBox="0 0 14 14"
      width={size}
    >
      {children}
    </svg>
  );
};

// Clean SVG State Glyph matching bundle
export const StateGlyph: React.FC<{ state: string; size?: number }> = ({ state, size = 14 }) => {
  let normalized = 'todo';
  switch (state) {
    case 'To Do':
    case 'Todo':
    case 'Backlog':
      normalized = 'todo';
      break;
    case 'In Progress':
      normalized = 'inProgress';
      break;
    case 'Review':
    case 'In Review':
      normalized = 'review';
      break;
    case 'Done':
      normalized = 'done';
      break;
    case 'Closed':
    case 'Canceled':
    case 'Duplicate':
      normalized = 'closed';
      break;
    default:
      normalized = 'todo';
      break;
  }

  let color = 'var(--text-secondary, #8b949e)';
  if (normalized === 'inProgress') color = 'var(--warning, #d29922)';
  else if (normalized === 'review') color = 'var(--accent, #58a6ff)';
  else if (normalized === 'done') color = 'var(--success, #3fb950)';
  else if (normalized === 'closed') color = 'var(--text-secondary, #8b949e)';

  const baseCircle = (
    <circle cx="7" cy="7" fill="none" r="5.5" stroke={color} strokeWidth="1.5" />
  );

  let children = null;
  switch (normalized) {
    case 'todo':
      children = baseCircle;
      break;
    case 'inProgress':
      children = (
        <>
          {baseCircle}
          <path d="M7 3.2 A3.8 3.8 0 0 1 7 10.8 Z" fill={color} />
        </>
      );
      break;
    case 'review':
      children = (
        <>
          {baseCircle}
          <circle cx="7" cy="7" fill={color} r="2.4" />
        </>
      );
      break;
    case 'done':
      children = (
        <>
          <circle cx="7" cy="7" fill={color} r="6.25" />
          <path
            d="M4.4 7.2 6.3 9.1 9.8 5.4"
            fill="none"
            stroke="var(--accent-ink, #0d1117)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
        </>
      );
      break;
    case 'closed':
      children = (
        <>
          {baseCircle}
          <path
            d="M4.9 4.9 9.1 9.1 M9.1 4.9 4.9 9.1"
            fill="none"
            stroke={color}
            strokeLinecap="round"
            strokeWidth="1.5"
          />
        </>
      );
      break;
  }

  return (
    <svg
      aria-hidden="true"
      className="ticket-state-glyph"
      data-state={normalized}
      focusable="false"
      height={size}
      viewBox="0 0 14 14"
      width={size}
    >
      {children}
    </svg>
  );
};

// Clean SVG Branch Icon
export const BranchIcon: React.FC<{ size?: number; className?: string }> = ({
  size = 12,
  className = '',
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <line x1="6" y1="3" x2="6" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </svg>
);

// Clean Delegate / User Avatar (no emojis)
export const TicketAvatar: React.FC<{
  name: string | null;
  kind?: string;
  size?: number;
}> = ({ name, kind = 'Assignee', size = 18 }) => {
  const style: React.CSSProperties = {
    width: size,
    height: size,
    fontSize: Math.round(size * 0.42),
    minWidth: size,
  };
  const trimmed = name?.trim();
  const initial = trimmed ? trimmed.charAt(0).toUpperCase() : '?';

  if (!trimmed) {
    return (
      <span
        aria-label={`${kind}: nobody`}
        className="ticket-avatar ticket-avatar--empty"
        role="img"
        style={style}
        title={`${kind}: nobody`}
      />
    );
  }

  return (
    <span
      aria-label={`${kind}: ${trimmed}`}
      className="ticket-avatar"
      role="img"
      style={style}
      title={`${kind}: ${trimmed}`}
    >
      {initial}
    </span>
  );
};

export interface TicketCardProps {
  issue: TicketIssue;
  run?: TaskExecutionRun | null;
  onSelect: (issue: TicketIssue) => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onDragStart?: (e: React.DragEvent) => void;
  carried?: boolean;
  moving?: boolean;
  tabStop?: boolean;
}

export const TicketCard: React.FC<TicketCardProps> = ({
  issue,
  run,
  onSelect,
  onPointerDown,
  onContextMenu,
  onDragStart,
  carried,
  moving,
  tabStop = false,
}) => {
  const isDone = issue.state === 'Done';

  return (
    <button
      type="button"
      className="ticket-card"
      data-issue-id={issue.id}
      data-carried={carried ? true : undefined}
      data-moving={moving ? true : undefined}
      data-closed={isDone || issue.archivedAt ? true : undefined}
      tabIndex={tabStop ? 0 : -1}
      onClick={() => onSelect(issue)}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      draggable={true}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', issue.id);
        onDragStart?.(e);
      }}
      aria-label={`${issue.id} ${issue.title}`}
    >
      <span className="ticket-card__top">
        <PriorityGlyph priority={issue.priority} />
        <span className="ticket-card__id">{issue.id}</span>
        {isDone ? <StateGlyph state={issue.state} /> : null}
        {run && (
          <span
            aria-hidden="true"
            className="ticket-card__run"
            data-waiting={run.state === 'waitingForInput' ? true : undefined}
            title={`Run: ${run.state}`}
          />
        )}
        <span className="ticket-card__spacer" />
        <button
          type="button"
          className="ticket-card__run-btn"
          aria-label="Run with Agent"
          title="Run with Agent in Chat"
          onClick={(e) => {
            e.stopPropagation();
            window.dispatchEvent(new CustomEvent('kite:navigate-mode', { detail: 'chat' }));
            window.dispatchEvent(
              new CustomEvent('kite:open-task-in-chat', {
                detail: {
                  taskId: issue.id,
                  title: issue.title,
                  description: issue.description || '',
                },
              })
            );
          }}
          style={{
            background: 'transparent',
            border: 0,
            cursor: 'pointer',
            padding: '2px',
            borderRadius: '4px',
            color: 'var(--text-muted, #6e7681)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: 0.6,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.opacity = '1';
            (e.currentTarget as HTMLElement).style.color = 'var(--accent, #58a6ff)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.opacity = '0.6';
            (e.currentTarget as HTMLElement).style.color = 'var(--text-muted, #6e7681)';
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="6 4 20 12 6 20" />
          </svg>
        </button>
        {issue.delegate && (
          <TicketAvatar name={issue.delegate} kind="Delegate" size={18} />
        )}
      </span>

      <span className="ticket-card__title">
        {issue.title || 'Untitled task'}
      </span>

      {(issue.branch || issue.dueDate || (issue.labels && issue.labels.length > 0)) && (
        <span className="ticket-card__meta">
          {issue.branch && (
            <span className="ticket-card__parent" title={`Branch: ${issue.branch}`}>
              <BranchIcon size={11} />
              <span>{issue.branch}</span>
            </span>
          )}
          {issue.dueDate && (
            <span className="ticket-card__due">
              Due {issue.dueDate}
            </span>
          )}
          {issue.labels && issue.labels.length > 0 && (
            <span className="ticket-card__labels">
              {issue.labels.slice(0, 2).map((lbl) => (
                <span key={lbl} className="ticket-pill" title={lbl}>
                  <span
                    aria-hidden="true"
                    className="ticket-pill__dot"
                    style={{ background: getLabelColor(lbl) }}
                  />
                  <span className="ticket-pill__name">{lbl}</span>
                </span>
              ))}
              {issue.labels.length > 2 && (
                <span className="ticket-pill ticket-pill--more">
                  +{issue.labels.length - 2}
                </span>
              )}
            </span>
          )}
        </span>
      )}
    </button>
  );
};

