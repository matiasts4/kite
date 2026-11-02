import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { LayoutGridGlyph, FolderGlyph, CloseGlyph, SearchGlyph } from '../../dockIcons';
import { AgentAvatar, AvatarChoice } from '../../AgentAvatar';
import { listLiveChatRuns, listAgents, listAgentProfiles, invokeCommand } from '../../../lib/ipc';
import { getActiveAgentTerminals, markTerminalExited } from '../../../lib/terminalRegistry';
import { BrandLogo } from '../agents/engineMetadata';
import type { LiveChatRun } from '../chat/types';
import type { AgentProfile } from '../../../types';

export type AgentState = 'waitingForYou' | 'working' | 'done' | 'idle' | 'exited';
export type DashboardGrouping = 'status' | 'project';
export type DashboardFilter = 'waitingForYou' | 'working' | 'done' | 'idle' | null;

export interface AgentMark {
  kind: 'engine' | 'teammate';
  engine?: string;
  agentId?: string;
  name?: string;
  avatar?: AvatarChoice | null;
}

export interface AgentTarget {
  kind: 'pane' | 'chat' | 'agentThread' | 'agent';
  workspaceId?: string;
  tabId?: string;
  leafId?: string;
  threadId?: string;
  agentId?: string;
}

export interface AgentRow {
  id: string;
  target: AgentTarget;
  mark: AgentMark;
  title: string;
  who: string | null;
  place: string;
  latest: string | null;
  branch?: string | null;
  state: AgentState;
  sinceUnixMs: number | null;
}

export interface AgentDigest {
  rows: AgentRow[];
  placeOrder: string[];
}

export interface AgentDashboardViewProps {
  digest?: AgentDigest;
  grouping?: DashboardGrouping;
  onGroupingChange?: (g: DashboardGrouping) => void;
  onOpen?: (row: AgentRow) => void;
  closeWorkspaceId?: string | null;
  onCloseIdle?: (targets: AgentTarget[]) => void;
  onStartAgent?: () => void;
}

const STORAGE_GROUPING_KEY = 'kite-code.dashboard-grouping.v1';
const FILTER_KEYS: Array<'waitingForYou' | 'working' | 'done' | 'idle'> = [
  'waitingForYou',
  'working',
  'done',
  'idle',
];

// Clean GitBranch icon
const GitBranchGlyph: React.FC<{ size?: number; className?: string }> = ({ size = 11, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
    style={{ flexShrink: 0 }}
  >
    <line x1="6" x2="6" y1="3" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </svg>
);

// Engine Brand Marks rendered with official high-resolution assets matching CodePaneHeader
const EngineBrandIcon: React.FC<{ engine: string; size?: number }> = ({ engine, size = 18 }) => {
  return <BrandLogo engine={engine || 'antigravity'} size={size} />;
};

function readStoredGrouping(): DashboardGrouping {
  try {
    const val = localStorage.getItem(STORAGE_GROUPING_KEY);
    if (!val) return 'status';
    const parsed = JSON.parse(val);
    return parsed === 'project' ? 'project' : 'status';
  } catch {
    return 'status';
  }
}

function writeStoredGrouping(grouping: DashboardGrouping) {
  try {
    localStorage.setItem(STORAGE_GROUPING_KEY, JSON.stringify(grouping));
  } catch {}
}

function matchFilter(filter: DashboardFilter, state: AgentState): boolean {
  if (filter === null) return true;
  switch (filter) {
    case 'waitingForYou':
      return state === 'waitingForYou';
    case 'working':
      return state === 'working';
    case 'done':
      return state === 'done';
    case 'idle':
      return state === 'idle' || state === 'exited';
  }
}

function getStateDisplay(state: AgentState): string {
  switch (state) {
    case 'waitingForYou':
      return 'Waiting for you';
    case 'working':
      return 'Working';
    case 'done':
      return 'Done';
    case 'idle':
      return 'Idle';
    case 'exited':
      return 'Exited';
  }
}

function getFilterChipTitle(filter: DashboardFilter): string {
  switch (filter) {
    case 'waitingForYou':
      return 'Waiting on you';
    case 'working':
      return 'Working';
    case 'done':
      return 'Done';
    case 'idle':
      return 'Idle';
    default:
      return 'All';
  }
}

function formatElapsed(fromMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function getPillLabel(row: AgentRow, nowMs: number): string {
  const base = getStateDisplay(row.state);
  const timed = row.state === 'waitingForYou' || row.state === 'working' || row.state === 'done';
  if (row.sinceUnixMs === null || !timed) return base;
  const elapsed = formatElapsed(row.sinceUnixMs, nowMs);
  return elapsed === 'now' ? base : `${base} ${elapsed}`;
}

const STATE_SORT_PRIORITY: Record<AgentState, number> = {
  waitingForYou: 0,
  working: 1,
  done: 2,
  idle: 3,
  exited: 4,
};

function sortAgentRows(rows: AgentRow[]): AgentRow[] {
  return rows
    .map((row, idx) => ({ row, idx }))
    .sort((a, b) => {
      const sA = a.row.state;
      const sB = b.row.state;
      if (sA !== sB) {
        return STATE_SORT_PRIORITY[sA] - STATE_SORT_PRIORITY[sB];
      }
      if (sA === 'waitingForYou' || sA === 'done') {
        const isDone = sA === 'done';
        const tA = a.row.sinceUnixMs;
        const tB = b.row.sinceUnixMs;
        if (tA !== null && tB !== null && tA !== tB) {
          return isDone ? tB - tA : tA - tB;
        }
        if (tA === null !== (tB === null)) {
          return tA === null ? 1 : -1;
        }
      }
      return a.idx - b.idx;
    })
    .map((item) => item.row);
}

function normalizeSearch(str: string): string {
  return str.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function matchesSearch(row: AgentRow, queryTokens: string[]): boolean {
  if (queryTokens.length === 0) return true;
  const corpus = normalizeSearch(
    [row.title, row.who, row.place, row.branch, row.latest].filter(Boolean).join('\n')
  );
  return queryTokens.every((token) => corpus.includes(token));
}

function getActivityHeadline(digest: AgentDigest): string {
  const parts = FILTER_KEYS.map((k) => ({
    filter: k,
    count: digest.rows.filter((r) => matchFilter(k, r.state)).length,
  }))
    .filter((x) => x.count > 0)
    .map((x) => `${x.count} ${getStateDisplay(x.filter).toLowerCase()}`);

  return parts.length === 0 ? 'Nothing running' : parts.join(' · ');
}

function getFilterEmptyMessage(filter: DashboardFilter): string {
  switch (filter) {
    case 'waitingForYou':
      return 'Nothing is waiting for you.';
    case 'working':
      return 'No agent is working right now.';
    case 'done':
      return 'No agent has finished yet.';
    case 'idle':
      return 'No idle agents.';
    default:
      return 'No agents.';
  }
}

function getCloseIdleTooltip(
  count: number,
  otherCount: number,
  place: string | null,
  searching: boolean
): string {
  const countStr = count === 1 ? '' : `${count} `;
  const noun = count === 1 ? 'idle agent' : 'idle agents';
  if (otherCount > 0 && place !== null) {
    return `Close the ${countStr}${searching ? 'matching ' : ''}${noun} in ${place}. Idle agents in other workspaces stay open.`;
  }
  if (searching) {
    return `Close the ${countStr}${noun} that ${count === 1 ? 'matches' : 'match'} your search.`;
  }
  return 'Close every idle agent. Agents that are working or waiting stay open.';
}

interface AgentSectionData {
  id: string;
  kind: 'status' | 'project';
  filter: DashboardFilter;
  title: string;
  rows: AgentRow[];
}

export const AgentDashboardView: React.FC<AgentDashboardViewProps> = ({
  digest: externalDigest,
  grouping: externalGrouping,
  onGroupingChange: externalOnGroupingChange,
  onOpen: externalOnOpen,
  closeWorkspaceId = null,
  onCloseIdle: externalOnCloseIdle,
  onStartAgent: externalOnStartAgent,
}) => {
  const [internalGrouping, setInternalGrouping] = useState<DashboardGrouping>(readStoredGrouping);
  const [filter, setFilter] = useState<DashboardFilter>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [internalDigest, setInternalDigest] = useState<AgentDigest>({ rows: [], placeOrder: [] });
  const [closedIdleIds, setClosedIdleIds] = useState<Set<string>>(new Set());

  const searchInputRef = useRef<HTMLInputElement>(null);

  const grouping = externalGrouping ?? internalGrouping;
  const handleGroupingChange = useCallback(
    (next: DashboardGrouping) => {
      setInternalGrouping(next);
      writeStoredGrouping(next);
      externalOnGroupingChange?.(next);
    },
    [externalOnGroupingChange]
  );

  // Time ticker for elapsed pill labels
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, []);

  // Internal data loading when externalDigest is not supplied
  const refreshInternalData = useCallback(async () => {
    if (externalDigest) return;
    try {
      const [liveRuns, roster] = await Promise.all([
        listLiveChatRuns().catch(() => [] as LiveChatRun[]),
        listAgents().catch(() => listAgentProfiles().catch(() => [] as AgentProfile[])),
      ]);

      const agentMap = new Map<string, AgentProfile>();
      for (const a of roster) {
        agentMap.set(a.id, a);
      }

      const rows: AgentRow[] = [];
      const placeSet = new Set<string>();

      // 1. Process LiveChatRuns
      for (const run of liveRuns) {
        const state: AgentState = run.needsYou ? 'waitingForYou' : 'working';
        const agentProf = run.profileId ? agentMap.get(run.profileId) : null;
        const place = run.workspaceId ? `Workspace` : agentProf ? 'Agents' : 'Threads';
        placeSet.add(place);

        rows.push({
          id: `run:${run.threadId}`,
          target: {
            kind: agentProf ? 'agentThread' : 'chat',
            threadId: run.threadId,
            agentId: run.profileId ?? undefined,
            workspaceId: run.workspaceId ?? undefined,
          },
          mark: agentProf
            ? {
                kind: 'teammate',
                agentId: agentProf.id,
                name: agentProf.name,
                avatar: (agentProf.avatar as any) ?? null,
              }
            : {
                kind: 'engine',
                engine: run.provider || 'antigravity',
              },
          title: run.title || (agentProf ? agentProf.name : 'Active Agent'),
          who: agentProf ? agentProf.name : run.provider || 'Antigravity',
          place,
          latest: run.line ?? null,
          state,
          sinceUnixMs: run.startedAtUnixMs || Date.now(),
        });
      }

      // 2. Process active terminal agent sessions (Antigravity CLI, Claude Code, Codex, etc.)
      const activeTerminals = getActiveAgentTerminals();
      for (const term of activeTerminals) {
        const place = term.workspaceName || 'Workspace';
        placeSet.add(place);
        rows.push({
          id: `term:${term.sessionId}`,
          target: {
            kind: 'pane',
            workspaceId: term.workspaceId ?? undefined,
            leafId: term.sessionId,
          },
          mark: {
            kind: 'engine',
            engine: term.engine || 'antigravity',
          },
          title: term.title || 'Antigravity CLI',
          who: term.who || 'Google Antigravity',
          place,
          latest: term.latestLine || (term.state === 'working' ? 'Thinking…' : term.state === 'waitingForYou' ? 'Waiting for your input' : null),
          branch: term.branch || null,
          state: term.state,
          sinceUnixMs: term.updatedAt,
        });
      }

      // 3. Read recent workspace agents / local sessions from localStorage
      try {
        const localKey = 'kite_dashboard_agents';
        const saved = localStorage.getItem(localKey);
        if (saved) {
          const parsed: AgentRow[] = JSON.parse(saved);
          for (const item of parsed) {
            if (!rows.some((r) => r.id === item.id)) {
              rows.push(item);
              if (item.place) placeSet.add(item.place);
            }
          }
        }
      } catch (_) {}

      setInternalDigest({
        rows: sortAgentRows(rows),
        placeOrder: Array.from(placeSet),
      });
    } catch (err) {
      console.warn('[AgentDashboardView] Error refreshing agents:', err);
    }
  }, [externalDigest]);

  useEffect(() => {
    if (!externalDigest) {
      void refreshInternalData();
      const interval = window.setInterval(refreshInternalData, 2000);
      const onTermUpdate = () => {
        void refreshInternalData();
      };
      window.addEventListener('kite:terminal-agent-update', onTermUpdate);
      return () => {
        window.clearInterval(interval);
        window.removeEventListener('kite:terminal-agent-update', onTermUpdate);
      };
    }
  }, [externalDigest, refreshInternalData]);

  // Active digest
  const baseDigest = externalDigest ?? internalDigest;

  // Filter out any locally closed idle ids
  const activeDigest = useMemo(() => {
    if (closedIdleIds.size === 0) return baseDigest;
    return {
      ...baseDigest,
      rows: baseDigest.rows.filter((r) => !closedIdleIds.has(r.id)),
    };
  }, [baseDigest, closedIdleIds]);

  // Search filtering
  const searchTokens = useMemo(() => {
    return normalizeSearch(searchQuery).split(/\s+/u).filter((t) => t.length > 0);
  }, [searchQuery]);

  const searchedDigest = useMemo(() => {
    if (searchTokens.length === 0) return activeDigest;
    return {
      ...activeDigest,
      rows: activeDigest.rows.filter((row) => matchesSearch(row, searchTokens)),
    };
  }, [activeDigest, searchTokens]);

  // Grouped sections
  const sections = useMemo((): AgentSectionData[] => {
    const matchingRows = searchedDigest.rows.filter((r) => matchFilter(filter, r.state));

    if (grouping === 'status') {
      return FILTER_KEYS.map((k) => ({
        id: `status-${k}`,
        kind: 'status' as const,
        filter: k,
        title: getStateDisplay(k),
        rows: matchingRows.filter((r) => matchFilter(k, r.state)),
      })).filter((s) => s.rows.length > 0);
    }

    // Grouping by Project / Place
    const places = activeDigest.placeOrder.length > 0
      ? activeDigest.placeOrder
      : Array.from(new Set(matchingRows.map((r) => r.place)));

    return places
      .map((place) => ({
        id: `project-${place}`,
        kind: 'project' as const,
        filter: null,
        title: place,
        rows: matchingRows.filter((r) => r.place === place),
      }))
      .filter((s) => s.rows.length > 0);
  }, [searchedDigest.rows, filter, grouping, activeDigest.placeOrder]);

  // Idle targets for Close Idle button
  const idleTargets = useMemo(() => {
    return searchedDigest.rows
      .filter((r) => matchFilter('idle', r.state))
      .filter((r) => closeWorkspaceId === null || r.target.workspaceId === closeWorkspaceId)
      .map((r) => r.target);
  }, [searchedDigest.rows, closeWorkspaceId]);

  const idleCountInDigest = useMemo(() => {
    return activeDigest.rows.filter((r) => matchFilter('idle', r.state)).length;
  }, [activeDigest.rows]);

  const handleCardClick = (row: AgentRow) => {
    if (externalOnOpen) {
      externalOnOpen(row);
      return;
    }

    // Default intelligent navigation
    if (row.target.kind === 'pane' || row.id.startsWith('term:')) {
      const sId = row.id.startsWith('term:') ? row.id.replace('term:', '') : (row.target.leafId || '');
      window.dispatchEvent(new CustomEvent('kite:navigate-mode', { detail: 'code' }));
      if (row.target.workspaceId) {
        window.dispatchEvent(new CustomEvent('kite:select-workspace', { detail: row.target.workspaceId }));
      }
      window.dispatchEvent(
        new CustomEvent('kite:spotlight-pane', {
          detail: {
            leafId: row.target.leafId,
            sessionId: sId,
            workspaceId: row.target.workspaceId,
          },
        })
      );
    } else if (row.target.kind === 'agent' || row.target.agentId) {
      window.dispatchEvent(new CustomEvent('kite:navigate-mode', { detail: 'agent' }));
      if (row.target.agentId) {
        window.dispatchEvent(new CustomEvent('kite:select-agent', { detail: row.target.agentId }));
      }
    } else if (row.target.kind === 'chat' || row.target.threadId) {
      window.dispatchEvent(new CustomEvent('kite:navigate-mode', { detail: 'chat' }));
      if (row.target.threadId) {
        window.dispatchEvent(new CustomEvent('kite:select-thread', { detail: row.target.threadId }));
      }
    }
  };

  const handleCloseIdle = () => {
    if (idleTargets.length === 0) return;
    if (externalOnCloseIdle) {
      externalOnCloseIdle(idleTargets);
    }
    const newlyClosed = new Set(closedIdleIds);
    for (const r of searchedDigest.rows) {
      if (matchFilter('idle', r.state)) {
        newlyClosed.add(r.id);
        if (r.id.startsWith('term:')) {
          const sId = r.id.replace('term:', '');
          void invokeCommand('terminate_terminal', { sessionId: sId, owner: 'user' }).catch(() => {});
          markTerminalExited(sId);
          window.dispatchEvent(new CustomEvent('kite:terminate-agent', { detail: { sessionId: sId, leafId: r.target.leafId, tabId: r.target.tabId } }));
        }
      }
    }
    setClosedIdleIds(newlyClosed);
    window.dispatchEvent(new CustomEvent('kite:close-idle-agents', { detail: idleTargets }));
  };

  const handleDismissCard = (row: AgentRow) => {
    setClosedIdleIds((prev) => new Set([...prev, row.id]));
    if (row.id.startsWith('term:') || row.target.kind === 'pane') {
      const sId = row.id.startsWith('term:') ? row.id.replace('term:', '') : (row.target.leafId || '');
      if (sId) {
        void invokeCommand('terminate_terminal', { sessionId: sId, owner: 'user' }).catch(() => {});
        markTerminalExited(sId);
      }
      window.dispatchEvent(new CustomEvent('kite:terminate-agent', { detail: { sessionId: sId, leafId: row.target.leafId, tabId: row.target.tabId } }));
    } else if (row.id.startsWith('run:')) {
      const runId = row.id.replace('run:', '');
      window.dispatchEvent(new CustomEvent('kite:stop-chat-run', { detail: { runId } }));
    }
    try {
      const localKey = 'kite_dashboard_agents';
      const saved = localStorage.getItem(localKey);
      if (saved) {
        const parsed: AgentRow[] = JSON.parse(saved);
        const filtered = parsed.filter((r) => r.id !== row.id);
        localStorage.setItem(localKey, JSON.stringify(filtered));
      }
    } catch (_) {}
    setInternalDigest((prev) => ({
      ...prev,
      rows: prev.rows.filter((r) => r.id !== row.id),
    }));
    window.dispatchEvent(new CustomEvent('kite:terminal-agent-update'));
  };

  const handleStartAgent = () => {
    if (externalOnStartAgent) {
      externalOnStartAgent();
    } else {
      window.dispatchEvent(new CustomEvent('kite:navigate-mode', { detail: 'agent' }));
      window.dispatchEvent(new CustomEvent('studio-new-agent'));
    }
  };

  // Activity Bar proportional segment counts
  const barSegments = useMemo(() => {
    return FILTER_KEYS.map((k) => ({
      filter: k,
      count: activeDigest.rows.filter((r) => matchFilter(k, r.state)).length,
    })).filter((x) => x.count > 0);
  }, [activeDigest.rows]);

  const isSearching = searchQuery.trim().length > 0;
  const totalAgents = activeDigest.rows.length;

  return (
    <section aria-label="Agent dashboard" className="agent-dashboard">
      <header className="agent-dashboard__summary">
        {/* Headline with total count, status text & grouping switcher */}
        <div className="agent-dashboard__headline">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0 }}>
            <span className="agent-dashboard__total">{totalAgents}</span>
            <span className="agent-dashboard__headline-text">
              <strong>{totalAgents === 1 ? 'agent' : 'agents'}</strong>
              <span>{getActivityHeadline(activeDigest)}</span>
            </span>
          </div>

          <fieldset className="agent-dashboard__grouping">
            <legend className="sr-only">Group agents by</legend>
            <button
              type="button"
              className="agent-dashboard__grouping-option"
              aria-pressed={grouping === 'status'}
              onClick={() => handleGroupingChange('status')}
            >
              Status
            </button>
            <button
              type="button"
              className="agent-dashboard__grouping-option"
              aria-pressed={grouping === 'project'}
              onClick={() => handleGroupingChange('project')}
            >
              Project
            </button>
          </fieldset>
        </div>

        {/* Proportional Segmented Activity Bar */}
        <div
          aria-label={`Agent activity: ${getActivityHeadline(activeDigest)}`}
          className="agent-dashboard__bar"
          role="img"
        >
          {barSegments.length === 0 ? (
            <span className="agent-dashboard__bar-segment" />
          ) : (
            barSegments.map(({ filter: key, count }) => (
              <span
                key={key}
                className="agent-dashboard__bar-segment"
                data-state={key}
                style={{ flexGrow: count }}
              />
            ))
          )}
        </div>

        {/* Filter Chips */}
        <div aria-label="Filter agents" className="agent-dashboard__chips" role="toolbar">
          <button
            type="button"
            className="agent-dashboard__chip"
            aria-pressed={filter === null}
            data-empty={totalAgents === 0 || undefined}
            onClick={() => setFilter(null)}
            title={filter === null ? 'Showing all agents' : 'Show every agent'}
          >
            <span>All</span>
            <span className="agent-dashboard__chip-count">{totalAgents}</span>
          </button>

          {FILTER_KEYS.map((key) => {
            const count = activeDigest.rows.filter((r) => matchFilter(key, r.state)).length;
            const isPressed = filter === key;
            return (
              <button
                key={key}
                type="button"
                className="agent-dashboard__chip"
                aria-pressed={isPressed}
                data-empty={count === 0 || undefined}
                onClick={() => setFilter(isPressed ? null : key)}
                title={isPressed ? 'Show every agent' : `Show ${getFilterChipTitle(key).toLowerCase()}`}
              >
                <span aria-hidden="true" className="agent-dashboard__dot" data-state={key} />
                <span>{getFilterChipTitle(key)}</span>
                <span className="agent-dashboard__chip-count">{count}</span>
              </button>
            );
          })}
        </div>

        {/* Tools Bar: Search Input & Close Idle Button */}
        {totalAgents > 0 && (
          <div className="agent-dashboard__tools">
            <span className="agent-dashboard__search">
              <SearchGlyph className="agent-dashboard__search-glyph" size={13} />
              <input
                ref={searchInputRef}
                aria-label="Search agents"
                className="agent-dashboard__search-field ui-field"
                type="search"
                placeholder="Search agents"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && searchQuery !== '') {
                    e.preventDefault();
                    e.stopPropagation();
                    setSearchQuery('');
                  }
                }}
              />
              {searchQuery !== '' && (
                <button
                  type="button"
                  className="agent-dashboard__search-clear"
                  onClick={() => {
                    setSearchQuery('');
                    searchInputRef.current?.focus();
                  }}
                  aria-label="Clear search"
                  title="Clear search"
                >
                  <CloseGlyph size={12} />
                </button>
              )}
            </span>

            {idleTargets.length > 0 && (
              <button
                type="button"
                aria-label={`Close idle (${idleTargets.length} ${idleTargets.length === 1 ? 'agent' : 'agents'})`}
                className="agent-dashboard__close-idle"
                onClick={handleCloseIdle}
                title={getCloseIdleTooltip(
                  idleTargets.length,
                  idleCountInDigest - idleTargets.length,
                  null,
                  isSearching
                )}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '0 12px',
                  height: '32px',
                  fontSize: '12px',
                  fontWeight: 500,
                  borderRadius: 'var(--control-radius, 8px)',
                  color: 'var(--text-secondary)',
                  background: 'var(--chip-fill, rgba(255,255,255,0.06))',
                  border: '1px solid var(--block-stroke, rgba(255,255,255,0.08))',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                <CloseGlyph size={12} />
                <span>Close idle ({idleTargets.length})</span>
              </button>
            )}
          </div>
        )}
      </header>

      {/* Body Wall & Empty States */}
      {totalAgents === 0 ? (
        <div className="agent-dashboard__empty">
          <span aria-hidden="true" className="agent-dashboard__empty-mark">
            <LayoutGridGlyph size={28} />
          </span>
          <h3 className="agent-dashboard__empty-title">No agents running</h3>
          <p>Agents you start in Code, Agent or Thread show up here with what they’re working on.</p>
          <button type="button" className="primary-button" onClick={handleStartAgent}>
            <span>Start an agent</span>
          </button>
        </div>
      ) : searchedDigest.rows.length === 0 ? (
        <div className="agent-dashboard__empty">
          <p>No agents match &ldquo;{searchQuery.trim()}&rdquo;.</p>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setSearchQuery('');
              searchInputRef.current?.focus();
            }}
          >
            Clear search
          </button>
        </div>
      ) : sections.length === 0 ? (
        <div className="agent-dashboard__empty">
          <p>{getFilterEmptyMessage(filter)}</p>
          <button type="button" className="secondary-button" onClick={() => setFilter(null)}>
            Show every agent
          </button>
        </div>
      ) : (
        <div className="agent-dashboard__wall">
          {sections.map((section) => {
            const waitingCount = section.rows.filter((r) => r.state === 'waitingForYou').length;
            const workingCount = section.rows.filter((r) => r.state === 'working').length;
            const doneCount = section.rows.filter((r) => r.state === 'done').length;

            return (
              <section key={section.id} aria-label={section.title} className="agent-dashboard__section">
                <h3 className="agent-dashboard__section-title">
                  {section.filter !== null ? (
                    <span aria-hidden="true" className="agent-dashboard__dot" data-state={section.filter} />
                  ) : (
                    <FolderGlyph size={14} />
                  )}
                  <span>{section.title}</span>
                  <span className="agent-dashboard__section-count">{section.rows.length}</span>

                  {section.kind === 'project' && (
                    <span className="agent-dashboard__section-tallies">
                      {waitingCount > 0 && (
                        <span data-state="waitingForYou">{waitingCount} waiting for you</span>
                      )}
                      {workingCount > 0 && (
                        <span data-state="working">{workingCount} working</span>
                      )}
                      {doneCount > 0 && (
                        <span data-state="done">{doneCount} done</span>
                      )}
                    </span>
                  )}
                </h3>

                <div className="agent-dashboard__grid">
                  {section.rows.map((row) => {
                    const detail = [row.who, row.place].filter(Boolean).join(' · ');
                    return (
                      <div
                        key={row.id}
                        role="button"
                        tabIndex={0}
                        aria-label={`${row.title}, ${detail}, ${getStateDisplay(row.state)}`}
                        className="agent-dashboard__card"
                        data-state={row.state}
                        onClick={() => handleCardClick(row)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handleCardClick(row);
                          }
                        }}
                        title={`Go to ${row.title}`}
                      >
                        <span className="agent-dashboard__card-top">
                          <span className="agent-dashboard__mark">
                            {row.mark.kind === 'engine' ? (
                              <>
                                <span className="agent-dashboard__logo">
                                  <EngineBrandIcon engine={row.mark.engine || 'antigravity'} size={17} />
                                </span>
                                {(row.state === 'waitingForYou' ||
                                  row.state === 'working' ||
                                  row.state === 'done') && (
                                  <span
                                    aria-hidden="true"
                                    className="agent-dashboard__pip"
                                    data-state={row.state}
                                  />
                                )}
                              </>
                            ) : (
                              <AgentAvatar
                                choice={row.mark.avatar ?? null}
                                id={row.mark.agentId || row.id}
                                size={32}
                                state={
                                  row.state === 'waitingForYou'
                                    ? 'needsYou'
                                    : row.state === 'working'
                                    ? 'running'
                                    : 'idle'
                                }
                              />
                            )}
                          </span>

                          <span className="agent-dashboard__card-text">
                            <span className="agent-dashboard__card-title">{row.title}</span>
                            <span className="agent-dashboard__card-where">
                              <span className="agent-dashboard__card-detail">{detail}</span>
                              {row.branch && (
                                <span className="agent-dashboard__branch" title={`Branch ${row.branch}`}>
                                  <GitBranchGlyph size={10} />
                                  <span>{row.branch}</span>
                                </span>
                              )}
                            </span>
                          </span>

                          <span className="agent-dashboard__pill" data-state={row.state}>
                            <span
                              aria-hidden="true"
                              className="agent-dashboard__dot"
                              data-state={row.state}
                            />
                            <span>{getPillLabel(row, now)}</span>
                          </span>

                          <button
                            type="button"
                            aria-label={`Close ${row.title}`}
                            title={`Close ${row.title}`}
                            className="agent-dashboard__card-close"
                            style={{
                              border: 0,
                              background: 'transparent',
                              color: 'var(--text-secondary, #9da2b4)',
                              cursor: 'pointer',
                              width: '22px',
                              height: '22px',
                              padding: 0,
                              borderRadius: '4px',
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              marginLeft: '6px',
                              opacity: 0.75,
                              transition: 'opacity 0.15s ease, background-color 0.15s ease, color 0.15s ease',
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.opacity = '1';
                              e.currentTarget.style.background = 'var(--hover-fill, rgba(255,255,255,0.08))';
                              e.currentTarget.style.color = 'var(--text-primary, #ffffff)';
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.opacity = '0.75';
                              e.currentTarget.style.background = 'transparent';
                              e.currentTarget.style.color = 'var(--text-secondary, #9da2b4)';
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDismissCard(row);
                            }}
                          >
                            <CloseGlyph size={12} />
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
};
