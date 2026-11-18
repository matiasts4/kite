import React from 'react';
import './agent-indicators.css';

export type AgentRoleKind =
  | 'browser'
  | 'explore'
  | 'review'
  | 'architect'
  | 'debug'
  | 'code'
  | 'orchestrator'
  | 'bot';

const ROLE_MATCHERS: Array<{ kind: AgentRoleKind; keywords: string[] }> = [
  {
    kind: 'browser',
    keywords: ['browser', 'web', 'playwright', 'cdp', 'chrome', 'dom'],
  },
  {
    kind: 'explore',
    keywords: ['explore', 'research', 'scout', 'search', 'finder', 'lookup', 'discover'],
  },
  {
    kind: 'review',
    keywords: ['review', 'audit', 'verify', 'verifier', 'judge', 'security', 'qa', 'guard', 'aegis'],
  },
  {
    kind: 'architect',
    keywords: ['architect', 'plan', 'planner', 'design', 'spec', 'schema', 'orion'],
  },
  {
    kind: 'debug',
    keywords: ['debug', 'debugger', 'trace', 'fix', 'root-cause', 'sherlock', 'diagnos'],
  },
  {
    kind: 'code',
    keywords: ['code', 'coder', 'implement', 'backend', 'frontend', 'systems', 'build', 'nova', 'atlas'],
  },
  {
    kind: 'orchestrator',
    keywords: ['swarm', 'coordinator', 'orchestrat', 'lead', 'release', 'hermes', 'dispatch'],
  },
];

/** Classifies an agent or subagent into a semantic role icon category using role, typeName, id, or name. */
export function resolveAgentRoleKind(input: {
  typeName?: string | null;
  role?: string | null;
  id?: string | null;
  name?: string | null;
}): AgentRoleKind {
  const haystack = [input.typeName, input.role, input.id, input.name]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .join(' ')
    .toLowerCase();

  if (!haystack) return 'bot';
  for (const matcher of ROLE_MATCHERS) {
    if (matcher.keywords.some((kw) => haystack.includes(kw))) {
      return matcher.kind;
    }
  }
  return 'bot';
}

function renderRolePaths(kind: AgentRoleKind): React.ReactNode {
  switch (kind) {
    case 'browser':
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3a13.5 13.5 0 0 0 0 18 13.5 13.5 0 0 0 0-18" />
          <line x1="3" x2="21" y1="12" y2="12" />
        </>
      );
    case 'explore':
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <polygon points="15.8 8.2 14 14 8.2 15.8 10 10 15.8 8.2" />
        </>
      );
    case 'review':
      return (
        <>
          <path d="M12 22s7.5-3.8 7.5-9.5V5.5L12 2.5 4.5 5.5v7C4.5 18.2 12 22 12 22z" />
          <path d="m9.2 12 2 2 3.8-3.8" />
        </>
      );
    case 'architect':
      return (
        <>
          <rect x="3" y="3" width="6" height="6" rx="1.5" />
          <rect x="15" y="3" width="6" height="6" rx="1.5" />
          <rect x="9" y="15" width="6" height="6" rx="1.5" />
          <path d="M6 9v2a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9" />
          <line x1="12" x2="12" y1="13" y2="15" />
        </>
      );
    case 'debug':
      return (
        <>
          <rect x="7" y="7" width="10" height="12" rx="5" />
          <path d="M9 7V5a3 3 0 0 1 6 0v2" />
          <path d="M4 11h3M17 11h3M3.5 15h3.5M17 15h3.5M6 19l2-1.5M18 19l-2-1.5" />
        </>
      );
    case 'code':
      return (
        <>
          <polyline points="8 7 3 12 8 17" />
          <polyline points="16 7 21 12 16 17" />
          <line x1="13.5" x2="10.5" y1="5" y2="19" />
        </>
      );
    case 'orchestrator':
      return (
        <>
          <circle cx="12" cy="5.5" r="2.5" />
          <circle cx="5.5" cy="17.5" r="2.5" />
          <circle cx="18.5" cy="17.5" r="2.5" />
          <line x1="10.6" x2="6.9" y1="7.7" y2="15.3" />
          <line x1="13.4" x2="17.1" y1="7.7" y2="15.3" />
          <line x1="8" x2="16" y1="17.5" y2="17.5" />
        </>
      );
    case 'bot':
    default:
      return (
        <>
          <path d="M7.5 13h9a4.5 4.5 0 0 0 0-9h-9a4.5 4.5 0 0 0 0 9z" />
          <rect x="4" y="16" width="16" height="4.5" rx="1.5" />
          <circle cx="9.2" cy="8.5" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="14.8" cy="8.5" r="0.9" fill="currentColor" stroke="none" />
        </>
      );
  }
}

export interface SubagentRoleIconProps {
  typeName?: string | null;
  role?: string | null;
  id?: string | null;
  name?: string | null;
  status?: string | null;
  size?: number;
  className?: string;
}

/** Crisp role-semantic SVG icon used for specialist agents and subagents across sidebars and cards. */
export const SubagentRoleIcon: React.FC<SubagentRoleIconProps> = ({
  typeName,
  role,
  id,
  name,
  status,
  size = 14,
  className = '',
}) => {
  const kind = resolveAgentRoleKind({ typeName, role, id, name });
  const normalizedStatus = (status ?? '').trim().toLowerCase();
  const statusClass =
    normalizedStatus === 'running' ||
    normalizedStatus === 'queued' ||
    normalizedStatus === 'pending' ||
    normalizedStatus === 'inprogress'
      ? 'subagent-role-icon--running'
      : normalizedStatus === 'waiting' ||
          normalizedStatus === 'blocked' ||
          normalizedStatus === 'needsinput' ||
          normalizedStatus === 'pendingapproval'
        ? 'subagent-role-icon--waiting'
        : normalizedStatus === 'completed' || normalizedStatus === 'done'
          ? 'subagent-role-icon--completed'
          : normalizedStatus === 'failed' || normalizedStatus === 'error'
            ? 'subagent-role-icon--failed'
            : normalizedStatus === 'killed' || normalizedStatus === 'cancelled'
              ? 'subagent-role-icon--killed'
              : '';

  return (
    <span
      aria-hidden="true"
      data-testid="subagent-role-icon"
      data-role-kind={kind}
      className={`subagent-role-icon${statusClass ? ` ${statusClass}` : ''}${className ? ` ${className}` : ''}`}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.85}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {renderRolePaths(kind)}
      </svg>
    </span>
  );
};
