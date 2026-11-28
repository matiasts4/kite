import React, { useMemo, useState } from 'react';
import type { SubagentRun } from '../../../types';
import { isSuppressedNoiseRun } from '../chat/subagentRunHelpers';
import { SubagentRunCard } from './SubagentRunCard';
import {
  isRunActive,
  isRunBlocked,
  isZeroStepFailedRun,
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
  const [showFailedGroup, setShowFailedGroup] = useState(false);

  const visibleRuns = useMemo(
    () => runs.filter((run) => !isSuppressedNoiseRun(run, runs)),
    [runs],
  );

  const { sorted, activeCount, waitingCount } = useMemo(() => {
    const ordered = sortRunsForOverview(visibleRuns);
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
  }, [visibleRuns]);

  const effectiveFilter = activeCount > 0 && activeCount < visibleRuns.length ? filter : 'all';
  const displayedRuns = useMemo(
    () =>
      effectiveFilter === 'live'
        ? sorted.filter((run) => isRunActive(run.status))
        : sorted,
    [effectiveFilter, sorted],
  );

  const { primaryRuns, foldedFailedRuns } = useMemo(() => {
    if (effectiveFilter === 'live') {
      return { primaryRuns: displayedRuns, foldedFailedRuns: [] as SubagentRun[] };
    }
    const emptyFailures = displayedRuns.filter((run) => isZeroStepFailedRun(run));
    const hasPrimary = displayedRuns.length > emptyFailures.length;
    if (emptyFailures.length === 0 || (emptyFailures.length < 3 && !hasPrimary)) {
      return { primaryRuns: displayedRuns, foldedFailedRuns: [] as SubagentRun[] };
    }
    const emptySet = new Set(emptyFailures.map((run) => run.subagentId));
    return {
      primaryRuns: displayedRuns.filter((run) => !emptySet.has(run.subagentId)),
      foldedFailedRuns: emptyFailures,
    };
  }, [displayedRuns, effectiveFilter]);

  return (
    <div className="subagent-overview" data-testid="subagent-runs-overview">
      <div className="subagent-overview__toolbar">
        <div className="subagent-overview__summary">
          <strong>{visibleRuns.length} subagents</strong>
          {waitingCount > 0 && (
            <span className="subagent-badge subagent-badge--waiting">
              {waitingCount} waiting
            </span>
          )}
          {activeCount - waitingCount > 0 && (
            <span className="subagent-badge">{activeCount - waitingCount} running</span>
          )}
        </div>

        {activeCount > 0 && activeCount < visibleRuns.length && (
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
              All ({visibleRuns.length})
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
        {primaryRuns.map((run) => (
          <SubagentRunCard
            key={run.subagentId}
            run={run}
            stopping={stoppingRunId === run.subagentId}
            onInspect={() => onInspectRun(run.subagentId)}
            onStop={() => onStopRun(run.subagentId)}
          />
        ))}

        {foldedFailedRuns.length > 0 && (
          <div className="subagent-overview__failed-group">
            <button
              type="button"
              className="subagent-overview__failed-toggle"
              data-testid="subagent-failed-group-toggle"
              aria-expanded={showFailedGroup}
              onClick={() => setShowFailedGroup((v) => !v)}
            >
              <span className="subagent-dot subagent-dot--failed" aria-hidden="true" />
              <span>
                {foldedFailedRuns.length} empty failed {foldedFailedRuns.length === 1 ? 'attempt' : 'attempts'}
              </span>
              <span className="subagent-overview__failed-hint">
                {showFailedGroup ? 'Hide' : 'Show'}
              </span>
            </button>
            {showFailedGroup && (
              <div className="subagent-overview__list">
                {foldedFailedRuns.map((run) => (
                  <SubagentRunCard
                    key={run.subagentId}
                    run={run}
                    stopping={stoppingRunId === run.subagentId}
                    onInspect={() => onInspectRun(run.subagentId)}
                    onStop={() => onStopRun(run.subagentId)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
