import React from 'react';
import './agent-indicators.css';

export type AgentActivityVisualState =
  | 'running'
  | 'backgroundWorking'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'idle';

export type AttentionToolKind =
  | 'terminal'
  | 'file'
  | 'search'
  | 'web'
  | 'help'
  | 'shield';

const ACTIVE_STATUSES = new Set([
  'running',
  'queued',
  'pending',
  'inprogress',
  'in_progress',
  'started',
]);

const WAITING_STATUSES = new Set([
  'waiting',
  'approval',
  'input',
  'blocked',
  'needsapproval',
  'needs_approval',
  'needsinput',
  'needs_input',
  'pendingapproval',
  'pending_approval',
  'needsyou',
  'needs_you',
]);

const COMPLETED_STATUSES = new Set(['completed', 'done', 'ok', 'settled']);
const FAILED_STATUSES = new Set(['failed', 'error', 'errored']);
const KILLED_STATUSES = new Set(['killed', 'cancelled', 'canceled', 'stopped']);

const TOOL_CATEGORY_MATCHERS: Array<{ kind: AttentionToolKind; keywords: string[] }> = [
  {
    kind: 'terminal',
    keywords: ['command', 'terminal', 'shell', 'bash', 'exec', 'run_'],
  },
  {
    kind: 'file',
    keywords: ['file', 'write', 'edit', 'replace', 'patch', 'read_', 'view_'],
  },
  {
    kind: 'search',
    keywords: ['search', 'grep', 'find', 'glob', 'list_dir'],
  },
  {
    kind: 'web',
    keywords: ['web', 'browser', 'url', 'fetch', 'http'],
  },
  {
    kind: 'help',
    keywords: ['ask_question', 'user_input', 'question', 'clarify'],
  },
];

/** Normalizes heterogeneous thread, run, and child status values into a visual state. */
export function resolveActivityVisualState(status?: string | null): AgentActivityVisualState {
  const s = (status ?? '').trim().toLowerCase();
  if (!s || s === 'idle' || s === 'warm') return 'idle';
  if (s === 'backgroundworking' || s === 'background_working') return 'backgroundWorking';
  if (WAITING_STATUSES.has(s)) return 'waiting';
  if (ACTIVE_STATUSES.has(s)) return 'running';
  if (COMPLETED_STATUSES.has(s)) return 'completed';
  if (FAILED_STATUSES.has(s)) return 'failed';
  if (KILLED_STATUSES.has(s)) return 'killed';
  return 'idle';
}

/** Maps a pending approval tool name into its contextual attention glyph category. */
export function classifyAttentionTool(toolName?: string | null): AttentionToolKind {
  const clean = (toolName ?? '').trim().toLowerCase();
  if (!clean) return 'shield';
  for (const entry of TOOL_CATEGORY_MATCHERS) {
    if (entry.keywords.some((kw) => clean.includes(kw))) {
      return entry.kind;
    }
  }
  return 'shield';
}

export interface OrbitDotsSpinnerProps {
  size?: number;
  className?: string;
}

/** Four circular dots arranged around a ring that orbit smoothly during active execution. */
export const OrbitDotsSpinner: React.FC<OrbitDotsSpinnerProps> = ({
  size = 14,
  className = '',
}) => (
  <svg
    aria-hidden="true"
    focusable="false"
    data-testid="agent-orbit-spinner"
    className={`agent-orbit-spinner${className ? ` ${className}` : ''}`}
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="currentColor"
  >
    <circle className="agent-orbit-spinner__dot agent-orbit-spinner__dot--1" cx="8" cy="3" r="1.75" />
    <circle className="agent-orbit-spinner__dot agent-orbit-spinner__dot--2" cx="13" cy="8" r="1.55" />
    <circle className="agent-orbit-spinner__dot agent-orbit-spinner__dot--3" cx="8" cy="13" r="1.35" />
    <circle className="agent-orbit-spinner__dot agent-orbit-spinner__dot--4" cx="3" cy="8" r="1.15" />
  </svg>
);

const AttentionGlyph: React.FC<{ kind: AttentionToolKind; size: number }> = ({ kind, size }) => {
  const glyphSize = Math.max(10, Math.round(size * 0.92));
  const common = {
    'aria-hidden': true as const,
    focusable: false as const,
    className: 'agent-status-attention__icon',
    width: glyphSize,
    height: glyphSize,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  switch (kind) {
    case 'terminal':
      return (
        <svg {...common}>
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" x2="20" y1="19" y2="19" />
        </svg>
      );
    case 'file':
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      );
    case 'search':
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="7" />
          <line x1="21" x2="16.65" y1="21" y2="16.65" />
        </svg>
      );
    case 'web':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3a13.5 13.5 0 0 0 0 18 13.5 13.5 0 0 0 0-18" />
          <line x1="3" x2="21" y1="12" y2="12" />
        </svg>
      );
    case 'help':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" x2="12.01" y1="17" y2="17" />
        </svg>
      );
    case 'shield':
    default:
      return (
        <svg {...common}>
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      );
  }
};

export interface AgentStatusIndicatorProps {
  status?: string | null;
  toolName?: string | null;
  size?: number;
  idleFallback?: React.ReactNode;
  className?: string;
  showPing?: boolean;
}

/** Reactive agent/thread/subagent state indicator shared across sidebars and subagent cards. */
export const AgentStatusIndicator: React.FC<AgentStatusIndicatorProps> = ({
  status,
  toolName,
  size = 14,
  idleFallback = null,
  className = '',
  showPing = true,
}) => {
  const visualState = resolveActivityVisualState(status);
  const attentionKind = visualState === 'waiting' ? classifyAttentionTool(toolName) : undefined;
  const classes = [
    'agent-status-indicator',
    `agent-status-indicator--${visualState}`,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  if (visualState === 'running') {
    return (
      <span
        aria-hidden="true"
        data-testid="agent-status-indicator"
        data-status="running"
        className={classes}
      >
        <OrbitDotsSpinner size={size} />
      </span>
    );
  }

  if (visualState === 'backgroundWorking') {
    return (
      <span
        aria-hidden="true"
        data-testid="agent-status-indicator"
        data-status="backgroundWorking"
        className={`${classes} agent-dot-bounce`}
      >
        <span className="agent-dot-bounce__dot agent-dot-bounce__dot--1" />
        <span className="agent-dot-bounce__dot agent-dot-bounce__dot--2" />
        <span className="agent-dot-bounce__dot agent-dot-bounce__dot--3" />
      </span>
    );
  }

  if (visualState === 'waiting' && attentionKind) {
    return (
      <span
        aria-hidden="true"
        data-testid="agent-status-indicator"
        data-status="waiting"
        data-attention-kind={attentionKind}
        className={`${classes} agent-status-attention`}
        style={{ width: size, height: size }}
      >
        <AttentionGlyph kind={attentionKind} size={size} />
        {showPing && <span className="agent-status-attention__ping" />}
        <span className="agent-status-attention__dot" />
      </span>
    );
  }

  if (visualState === 'completed') {
    if (idleFallback !== null) {
      return <>{idleFallback}</>;
    }
    return (
      <span
        aria-hidden="true"
        data-testid="agent-status-indicator"
        data-status="completed"
        className={classes}
      >
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      </span>
    );
  }

  if (visualState === 'failed') {
    return (
      <span
        aria-hidden="true"
        data-testid="agent-status-indicator"
        data-status="failed"
        className={classes}
      >
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <line x1="15" x2="9" y1="9" y2="15" />
          <line x1="9" x2="15" y1="9" y2="15" />
        </svg>
      </span>
    );
  }

  if (visualState === 'killed') {
    return (
      <span
        aria-hidden="true"
        data-testid="agent-status-indicator"
        data-status="killed"
        className={classes}
      >
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <line x1="6.3" x2="17.7" y1="6.3" y2="17.7" />
        </svg>
      </span>
    );
  }

  return idleFallback ? <>{idleFallback}</> : null;
};
