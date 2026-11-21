import React, { useSyncExternalStore } from 'react';
import {
  AGENT_ACTIVITY_INDICATOR_COLOR_EVENT,
  AGENT_ACTIVITY_INDICATOR_EVENT,
  DEFAULT_AGENT_ACTIVITY_INDICATOR_COLOR,
  DEFAULT_AGENT_ACTIVITY_INDICATOR_STYLE,
  kitePrefKey,
  readAgentActivityIndicatorColor,
  readAgentActivityIndicatorStyle,
  resolveAgentActivityIndicatorColorValue,
  type AgentActivityIndicatorColor,
  type AgentActivityIndicatorColorPreset,
  type AgentActivityIndicatorStyle,
} from '../../lib/kitePrefs';
import './agent-indicators.css';

export interface AgentActivityIndicatorOption {
  id: AgentActivityIndicatorStyle;
  label: string;
  blurb: string;
}

export const AGENT_ACTIVITY_INDICATOR_OPTIONS: readonly AgentActivityIndicatorOption[] = [
  {
    id: 'matrix-grid',
    label: 'Matriz neural',
    blurb: 'Grilla 2×2 que late en secuencia diagonal.',
  },
  {
    id: 'signal-bars',
    label: 'Barras activas',
    blurb: 'Tres barras verticales en fase orgánica.',
  },
  {
    id: 'pulse-aura',
    label: 'Pulso sereno',
    blurb: 'Núcleo limpio con halo suave que respira.',
  },
  {
    id: 'kite-diamond',
    label: 'Cometa Kite',
    blurb: 'Rombo geométrico con núcleo vivo.',
  },
  {
    id: 'matrix-3x3',
    label: 'Grilla 3×3',
    blurb: 'Matriz de nueve píxeles con onda diagonal.',
  },
  {
    id: 'wave-dots',
    label: 'Pulso en línea',
    blurb: 'Tres nodos horizontales con cadencia luminosa.',
  },
  {
    id: 'radar-sweep',
    label: 'Anillo fluido',
    blurb: 'Arco fino de precisión sobre pista circular.',
  },
  {
    id: 'chevron-flow',
    label: 'Flujo activo',
    blurb: 'Doble chevrón direccional en avance rítmico.',
  },
];

export interface AgentActivityColorPresetOption {
  id: AgentActivityIndicatorColorPreset;
  label: string;
  swatch: string;
}

export const AGENT_ACTIVITY_INDICATOR_COLOR_OPTIONS: readonly AgentActivityColorPresetOption[] = [
  { id: 'status', label: 'Estado', swatch: 'var(--status-running, #4ade80)' },
  { id: 'accent', label: 'Acento del tema', swatch: 'var(--accent, #5c8fff)' },
  { id: 'cyan', label: 'Cian', swatch: '#38bdf8' },
  { id: 'violet', label: 'Violeta', swatch: '#a78bfa' },
  { id: 'amber', label: 'Ámbar', swatch: '#fbbf24' },
  { id: 'rose', label: 'Rosa', swatch: '#fb7185' },
  { id: 'neutral', label: 'Neutro', swatch: 'var(--text-secondary, #a3a3a3)' },
];

function subscribeAgentActivityIndicator(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const prefKey = kitePrefKey('agentActivityIndicator');
  const handleCustom = () => onStoreChange();
  const handleStorage = (e: StorageEvent) => {
    if (!e.key || e.key === prefKey) onStoreChange();
  };
  window.addEventListener(AGENT_ACTIVITY_INDICATOR_EVENT, handleCustom);
  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener(AGENT_ACTIVITY_INDICATOR_EVENT, handleCustom);
    window.removeEventListener('storage', handleStorage);
  };
}

export function useAgentActivityIndicatorStyle(): AgentActivityIndicatorStyle {
  return useSyncExternalStore(
    subscribeAgentActivityIndicator,
    readAgentActivityIndicatorStyle,
    () => DEFAULT_AGENT_ACTIVITY_INDICATOR_STYLE
  );
}

function subscribeAgentActivityIndicatorColor(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const prefKey = kitePrefKey('agentActivityIndicatorColor');
  const handleCustom = () => onStoreChange();
  const handleStorage = (e: StorageEvent) => {
    if (!e.key || e.key === prefKey) onStoreChange();
  };
  window.addEventListener(AGENT_ACTIVITY_INDICATOR_COLOR_EVENT, handleCustom);
  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener(AGENT_ACTIVITY_INDICATOR_COLOR_EVENT, handleCustom);
    window.removeEventListener('storage', handleStorage);
  };
}

export function useAgentActivityIndicatorColor(): AgentActivityIndicatorColor {
  return useSyncExternalStore(
    subscribeAgentActivityIndicatorColor,
    readAgentActivityIndicatorColor,
    () => DEFAULT_AGENT_ACTIVITY_INDICATOR_COLOR
  );
}

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

const MATRIX_3X3_CELLS: ReadonlyArray<{ x: number; y: number; wave: number }> = [
  { x: 2.2, y: 2.2, wave: 1 },
  { x: 6.8, y: 2.2, wave: 2 },
  { x: 11.4, y: 2.2, wave: 3 },
  { x: 2.2, y: 6.8, wave: 2 },
  { x: 6.8, y: 6.8, wave: 3 },
  { x: 11.4, y: 6.8, wave: 4 },
  { x: 2.2, y: 11.4, wave: 3 },
  { x: 6.8, y: 11.4, wave: 4 },
  { x: 11.4, y: 11.4, wave: 5 },
];

const RunningActivityGlyph: React.FC<{ variant: AgentActivityIndicatorStyle; size: number }> = ({
  variant,
  size,
}) => {
  switch (variant) {
    case 'pulse-aura':
      return (
        <svg
          aria-hidden="true"
          focusable="false"
          data-testid="agent-activity-pulse-aura"
          className="agent-activity-glyph agent-activity-pulse-aura"
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="none"
        >
          <circle
            className="agent-activity-pulse-aura__ring"
            cx="8"
            cy="8"
            r="5.25"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <circle
            className="agent-activity-pulse-aura__core"
            cx="8"
            cy="8"
            r="2.65"
            fill="currentColor"
          />
        </svg>
      );
    case 'signal-bars':
      return (
        <svg
          aria-hidden="true"
          focusable="false"
          data-testid="agent-activity-signal-bars"
          className="agent-activity-glyph agent-activity-signal-bars"
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <rect
            className="agent-activity-signal-bars__bar agent-activity-signal-bars__bar--1"
            x="2.2"
            y="3"
            width="2.4"
            height="10"
            rx="1.2"
          />
          <rect
            className="agent-activity-signal-bars__bar agent-activity-signal-bars__bar--2"
            x="6.8"
            y="3"
            width="2.4"
            height="10"
            rx="1.2"
          />
          <rect
            className="agent-activity-signal-bars__bar agent-activity-signal-bars__bar--3"
            x="11.4"
            y="3"
            width="2.4"
            height="10"
            rx="1.2"
          />
        </svg>
      );
    case 'kite-diamond':
      return (
        <svg
          aria-hidden="true"
          focusable="false"
          data-testid="agent-activity-kite-diamond"
          className="agent-activity-glyph agent-activity-kite-diamond"
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="none"
        >
          <path
            className="agent-activity-kite-diamond__frame"
            d="M8 1.75L14.25 8L8 14.25L1.75 8Z"
            stroke="currentColor"
            strokeWidth="1.45"
            strokeLinejoin="round"
          />
          <path
            className="agent-activity-kite-diamond__core"
            d="M8 5.2L10.8 8L8 10.8L5.2 8Z"
            fill="currentColor"
          />
        </svg>
      );
    case 'matrix-3x3':
      return (
        <svg
          aria-hidden="true"
          focusable="false"
          data-testid="agent-activity-matrix-3x3"
          className="agent-activity-glyph agent-activity-matrix-3x3"
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          {MATRIX_3X3_CELLS.map((cell, index) => (
            <rect
              key={index}
              className={`agent-activity-matrix-3x3__cell agent-activity-matrix-3x3__cell--w${cell.wave}`}
              x={cell.x}
              y={cell.y}
              width="2.4"
              height="2.4"
              rx="0.65"
            />
          ))}
        </svg>
      );
    case 'wave-dots':
      return (
        <svg
          aria-hidden="true"
          focusable="false"
          data-testid="agent-activity-wave-dots"
          className="agent-activity-glyph agent-activity-wave-dots"
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <circle
            className="agent-activity-wave-dots__dot agent-activity-wave-dots__dot--1"
            cx="3.2"
            cy="8"
            r="1.7"
          />
          <circle
            className="agent-activity-wave-dots__dot agent-activity-wave-dots__dot--2"
            cx="8"
            cy="8"
            r="1.7"
          />
          <circle
            className="agent-activity-wave-dots__dot agent-activity-wave-dots__dot--3"
            cx="12.8"
            cy="8"
            r="1.7"
          />
        </svg>
      );
    case 'radar-sweep':
      return (
        <svg
          aria-hidden="true"
          focusable="false"
          data-testid="agent-activity-radar-sweep"
          className="agent-activity-glyph agent-activity-radar-sweep"
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="none"
        >
          <circle
            className="agent-activity-radar-sweep__track"
            cx="8"
            cy="8"
            r="5.5"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <circle
            className="agent-activity-radar-sweep__arc"
            cx="8"
            cy="8"
            r="5.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeDasharray="11 24"
          />
        </svg>
      );
    case 'chevron-flow':
      return (
        <svg
          aria-hidden="true"
          focusable="false"
          data-testid="agent-activity-chevron-flow"
          className="agent-activity-glyph agent-activity-chevron-flow"
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="none"
        >
          <path
            className="agent-activity-chevron-flow__arm agent-activity-chevron-flow__arm--1"
            d="M3.5 4.25L7.25 8L3.5 11.75"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            className="agent-activity-chevron-flow__arm agent-activity-chevron-flow__arm--2"
            d="M8.75 4.25L12.5 8L8.75 11.75"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'matrix-grid':
    default:
      return (
        <svg
          aria-hidden="true"
          focusable="false"
          data-testid="agent-activity-matrix-grid"
          className="agent-activity-glyph agent-activity-matrix-grid"
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <rect
            className="agent-activity-matrix-grid__cell agent-activity-matrix-grid__cell--1"
            x="2.5"
            y="2.5"
            width="4.5"
            height="4.5"
            rx="1.2"
          />
          <rect
            className="agent-activity-matrix-grid__cell agent-activity-matrix-grid__cell--2"
            x="9"
            y="2.5"
            width="4.5"
            height="4.5"
            rx="1.2"
          />
          <rect
            className="agent-activity-matrix-grid__cell agent-activity-matrix-grid__cell--3"
            x="9"
            y="9"
            width="4.5"
            height="4.5"
            rx="1.2"
          />
          <rect
            className="agent-activity-matrix-grid__cell agent-activity-matrix-grid__cell--4"
            x="2.5"
            y="9"
            width="4.5"
            height="4.5"
            rx="1.2"
          />
        </svg>
      );
  }
};

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
  variant?: AgentActivityIndicatorStyle;
  color?: AgentActivityIndicatorColor;
}

/** Reactive agent/thread/subagent state indicator shared across sidebars and subagent cards. */
export const AgentStatusIndicator: React.FC<AgentStatusIndicatorProps> = ({
  status,
  toolName,
  size = 14,
  idleFallback = null,
  className = '',
  showPing = true,
  variant,
  color,
}) => {
  const preferredVariant = useAgentActivityIndicatorStyle();
  const preferredColor = useAgentActivityIndicatorColor();
  const activeVariant = variant ?? preferredVariant;
  const activeColor = color ?? preferredColor;
  const resolvedRunningColor = resolveAgentActivityIndicatorColorValue(activeColor);
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
        data-variant={activeVariant}
        data-color-mode={activeColor}
        className={classes}
        style={resolvedRunningColor ? { color: resolvedRunningColor } : undefined}
      >
        <RunningActivityGlyph variant={activeVariant} size={size} />
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
