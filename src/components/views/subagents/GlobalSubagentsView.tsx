import React, { useMemo, useState } from 'react';
import type { GlobalSubagentEntry } from '../../../lib/ipc/chat';
import { formatInspectorModelName } from './swarmBoardHelpers';
import { SubagentRunCard } from './SubagentRunCard';
import { isRunActive, isRunBlocked } from './subagentInspectorHelpers';

export interface GlobalSubagentsViewProps {
  workspaceId: string | null;
  selectedThreadId?: string | null;
  entries: GlobalSubagentEntry[];
  totalCount: number;
  activeCount: number;
  loading: boolean;
  stoppingRunKey?: string | null;
  onInspectEntry: (entry: GlobalSubagentEntry) => void;
  onStopEntry: (entry: GlobalSubagentEntry) => void;
  onFocusThread: (threadId: string) => void;
}

interface ThreadSubagentGroup {
  threadId: string;
  threadTitle: string;
  workspaceId: string | null;
  parentModelLabel: string | null;
  activeCount: number;
  entries: GlobalSubagentEntry[];
}

/** Unified cross-thread overview grouping subagents under their parent orchestrator threads. */
export const GlobalSubagentsView: React.FC<GlobalSubagentsViewProps> = ({
  workspaceId,
  selectedThreadId = null,
  entries,
  totalCount,
  activeCount,
  loading,
  stoppingRunKey = null,
  onInspectEntry,
  onStopEntry,
  onFocusThread,
}) => {
  const [statusFilter, setStatusFilter] = useState<'all' | 'live'>('all');
  const [workspaceFilter, setWorkspaceFilter] = useState<'all' | 'current'>('all');

  const hasCurrentWorkspaceRuns = useMemo(
    () => Boolean(workspaceId && entries.some((e) => e.workspaceId === workspaceId)),
    [entries, workspaceId],
  );
  const hasOtherWorkspaceRuns = useMemo(
    () => Boolean(workspaceId && entries.some((e) => e.workspaceId && e.workspaceId !== workspaceId)),
    [entries, workspaceId],
  );
  const showWorkspaceToggle = Boolean(workspaceId && hasCurrentWorkspaceRuns && hasOtherWorkspaceRuns);

  const workspaceScopedEntries = useMemo(() => {
    if (showWorkspaceToggle && workspaceFilter === 'current') {
      return entries.filter((entry) => entry.workspaceId === workspaceId);
    }
    return entries;
  }, [entries, showWorkspaceToggle, workspaceFilter, workspaceId]);

  const scopedAllCount =
    showWorkspaceToggle && workspaceFilter === 'current'
      ? workspaceScopedEntries.length
      : totalCount || workspaceScopedEntries.length;

  const scopedLiveCount = useMemo(
    () =>
      showWorkspaceToggle && workspaceFilter === 'current'
        ? workspaceScopedEntries.filter(
            (entry) =>
              entry.hasPendingApproval ||
              isRunBlocked(entry.run.status) ||
              isRunActive(entry.run.status),
          ).length
        : activeCount,
    [activeCount, showWorkspaceToggle, workspaceFilter, workspaceScopedEntries],
  );

  const filteredEntries = useMemo(() => {
    if (statusFilter !== 'live') {
      return workspaceScopedEntries;
    }
    return workspaceScopedEntries.filter(
      (entry) =>
        entry.hasPendingApproval ||
        isRunBlocked(entry.run.status) ||
        isRunActive(entry.run.status),
    );
  }, [workspaceScopedEntries, statusFilter]);

  const groups = useMemo<ThreadSubagentGroup[]>(() => {
    const map = new Map<string, ThreadSubagentGroup>();
    for (const entry of filteredEntries) {
      let group = map.get(entry.threadId);
      if (!group) {
        group = {
          threadId: entry.threadId,
          threadTitle: entry.threadTitle || 'Untitled Thread',
          workspaceId: entry.workspaceId ?? null,
          parentModelLabel:
            entry.parentModel || entry.parentProvider
              ? formatInspectorModelName(entry.parentModel, entry.parentProvider)
              : null,
          activeCount: 0,
          entries: [],
        };
        map.set(entry.threadId, group);
      }
      if (entry.hasPendingApproval || isRunBlocked(entry.run.status) || isRunActive(entry.run.status)) {
        group.activeCount += 1;
      }
      group.entries.push(entry);
    }
    return Array.from(map.values());
  }, [filteredEntries]);

  return (
    <div className="subagent-global" data-testid="global-subagents-view">
      <div className="subagent-global__toolbar">
        <div
          className="subagent-inspector__segmented"
          role="tablist"
          aria-label="Filter global subagents"
        >
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === 'all'}
            className={`subagent-inspector__segment-btn${statusFilter === 'all' ? ' subagent-inspector__segment-btn--active' : ''}`}
            onClick={() => setStatusFilter('all')}
          >
            All ({scopedAllCount})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === 'live'}
            className={`subagent-inspector__segment-btn${statusFilter === 'live' ? ' subagent-inspector__segment-btn--active' : ''}`}
            onClick={() => setStatusFilter('live')}
          >
            Live ({scopedLiveCount})
          </button>
        </div>

        {showWorkspaceToggle && (
          <div
            className="subagent-inspector__segmented"
            role="tablist"
            aria-label="Workspace filter"
          >
            <button
              type="button"
              role="tab"
              aria-selected={workspaceFilter === 'all'}
              className={`subagent-inspector__segment-btn${workspaceFilter === 'all' ? ' subagent-inspector__segment-btn--active' : ''}`}
              onClick={() => setWorkspaceFilter('all')}
            >
              All projects
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={workspaceFilter === 'current'}
              className={`subagent-inspector__segment-btn${workspaceFilter === 'current' ? ' subagent-inspector__segment-btn--active' : ''}`}
              onClick={() => setWorkspaceFilter('current')}
            >
              This project
            </button>
          </div>
        )}
      </div>

      {!loading && groups.length === 0 ? (
        <div className="subagent-inspector__empty" data-testid="global-subagents-empty">
          <strong>
            {statusFilter === 'live'
              ? 'No active subagents running'
              : 'No subagents across threads yet'}
          </strong>
          <span>
            {statusFilter === 'live'
              ? 'All recorded subagents across your threads have settled.'
              : 'Subagents launched in any thread will appear together here.'}
          </span>
          {statusFilter === 'live' && workspaceScopedEntries.length > 0 && (
            <button
              type="button"
              className="subagent-inspector__empty-cta"
              onClick={() => setStatusFilter('all')}
            >
              Show all ({workspaceScopedEntries.length})
            </button>
          )}
        </div>
      ) : (
        <div className="subagent-global__groups">
          {groups.map((group) => {
            const isCurrentThread = selectedThreadId === group.threadId;
            return (
              <section
                key={group.threadId}
                className={`subagent-global__group${isCurrentThread ? ' subagent-global__group--current' : ''}`}
                data-testid="global-subagent-thread-group"
                data-thread-id={group.threadId}
              >
                <div className="subagent-global__group-header">
                  <button
                    type="button"
                    className="subagent-global__thread-btn"
                    onClick={() => onFocusThread(group.threadId)}
                    title={`Focus thread: ${group.threadTitle}`}
                  >
                    <span className="subagent-global__thread-title">{group.threadTitle}</span>
                  </button>
                  <div className="subagent-global__group-meta">
                    {isCurrentThread && (
                      <span className="subagent-badge subagent-badge--hierarchy">Current</span>
                    )}
                    {group.parentModelLabel && (
                      <span className="subagent-badge">{group.parentModelLabel}</span>
                    )}
                    <span className="subagent-global__group-count">
                      {group.activeCount > 0
                        ? `${group.activeCount} live · ${group.entries.length}`
                        : `${group.entries.length} ${group.entries.length === 1 ? 'run' : 'runs'}`}
                    </span>
                  </div>
                </div>

                <div className="subagent-global__group-cards">
                  {group.entries.map((entry) => {
                    const key = `${entry.threadId}:${entry.run.subagentId}`;
                    return (
                      <SubagentRunCard
                        key={key}
                        run={entry.run}
                        hasPendingApproval={Boolean(entry.hasPendingApproval)}
                        stopping={stoppingRunKey === key}
                        onInspect={() => onInspectEntry(entry)}
                        onStop={() => onStopEntry(entry)}
                      />
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
};
