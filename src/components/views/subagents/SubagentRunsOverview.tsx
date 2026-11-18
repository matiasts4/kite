import React, { useMemo, useState } from 'react';
import type { SubagentRun } from '../../../types';
import { SubagentRunCard } from './SubagentRunCard';
import {
  isRunActive,
  isRunBlocked,
  sortRunsForOverview,
} from './subagentInspectorHelpers';

export interface SubagentRunsOverviewProps {
  runs: SubagentRun[];
  stoppingRunId?: string | null;
  onInspectRun: (subagentId: string) => void;
  onStopRun: (subagentId: string) => void;
}

/** Vertical multi-subagent overview listing all runs on the currently inspected thread. */
export const SubagentRunsOverview: React.FC<SubagentRunsOverviewProps> = ({
  runs,
  stoppingRunId = null,
  onInspectRun,
  onStopRun,
}) => {
  const [filter, setFilter] = useState<'all' | 'live'>('all');

  const { sorted, activeCount, waitingCount } = useMemo(() => {
    const ordered = sortRunsForOverview(runs);
    let active = 0;
    let waiting = 0;
    for (const run of ordered) {
      if (isRunBlocked(run.status)) {
        waiting += 1;
        active += 1;
      } else if (isRunActive(run.status)) {
        active += 1;
      }
    }
    return { sorted: ordered, activeCount: active, waitingCount: waiting };
  }, [runs]);

  const effectiveFilter = activeCount > 0 && activeCount < runs.length ? filter : 'all';
  const displayedRuns = useMemo(
    () =>
      effectiveFilter === 'live'
        ? sorted.filter((run) => isRunActive(run.status))
        : sorted,
    [effectiveFilter, sorted],
  );

  return (
    <div className="subagent-overview" data-testid="subagent-runs-overview">
      <div className="subagent-overview__toolbar">
        <div className="subagent-overview__summary">
          <strong>{runs.length} subagents</strong>
          {waitingCount > 0 && (
            <span className="subagent-badge subagent-badge--waiting">
              {waitingCount} waiting
            </span>
          )}
          {activeCount - waitingCount > 0 && (
            <span className="subagent-badge">{activeCount - waitingCount} running</span>
          )}
        </div>

        {activeCount > 0 && activeCount < runs.length && (
          <div
            className="subagent-inspector__segmented"
            role="tablist"
            aria-label="Filter thread subagents"
          >
            <button
              type="button"
              role="tab"
              aria-selected={effectiveFilter === 'all'}
              className={`subagent-inspector__segment-btn${effectiveFilter === 'all' ? ' subagent-inspector__segment-btn--active' : ''}`}
              onClick={() => setFilter('all')}
            >
              All ({runs.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={effectiveFilter === 'live'}
              className={`subagent-inspector__segment-btn${effectiveFilter === 'live' ? ' subagent-inspector__segment-btn--active' : ''}`}
              onClick={() => setFilter('live')}
            >
              Live ({activeCount})
            </button>
          </div>
        )}
      </div>

      <div className="subagent-overview__list">
        {displayedRuns.map((run) => (
          <SubagentRunCard
            key={run.subagentId}
            run={run}
            stopping={stoppingRunId === run.subagentId}
            onInspect={() => onInspectRun(run.subagentId)}
            onStop={() => onStopRun(run.subagentId)}
          />
        ))}
      </div>
    </div>
  );
};
