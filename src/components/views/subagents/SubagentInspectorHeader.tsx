import React from 'react';
import type { SubagentRun } from '../../../types';
import { LiveElapsedClock } from '../chat/LiveElapsedClock';
import type { ExtendedChatThread } from '../chat/types';
import { formatInspectorModelName } from './SwarmBoardInspector';
import {
  isRunActive,
  isRunBlocked,
  runStatusDotClass,
  settledPrefixLabel,
  type InspectorMode,
} from './subagentInspectorHelpers';

interface SubagentInspectorHeaderProps {
  thread: ExtendedChatThread | null;
  mode: InspectorMode;
  hasRuns: boolean;
  hasSwarm: boolean;
  runs: SubagentRun[];
  activeRun: SubagentRun | null;
  parentModelLabel: string;
  stoppingRun: boolean;
  fromSwarmRoster: boolean;
  onJumpToParent: () => void;
  onPopOutChildThread: () => void;
  onSelectMode: (mode: InspectorMode) => void;
  onSelectRun: (subagentId: string) => void;
  onStopActiveRun: () => void;
  onBackToSwarmRoster: () => void;
}

export const SubagentInspectorHeader: React.FC<SubagentInspectorHeaderProps> = ({
  thread,
  mode,
  hasRuns,
  hasSwarm,
  runs,
  activeRun,
  parentModelLabel,
  stoppingRun,
  fromSwarmRoster,
  onJumpToParent,
  onPopOutChildThread,
  onSelectMode,
  onSelectRun,
  onStopActiveRun,
  onBackToSwarmRoster,
}) => (
  <div className="subagent-inspector__header">
    <div className="subagent-inspector__top-row">
      {thread && (
        <button
          type="button"
          className="subagent-inspector__parent-link"
          onClick={onJumpToParent}
          title={`Focus main thread: ${thread.title || thread.id}`}
        >
          <span>← Main Thread: {thread.title || 'Untitled Thread'}</span>
        </button>
      )}

      <div className="subagent-inspector__top-actions">
        {mode === 'subagent' && activeRun?.childThreadId && (
          <button
            type="button"
            className="subagent-inspector__popout-btn"
            onClick={onPopOutChildThread}
            aria-label="Open subagent thread in main pane"
            title="Open subagent conversation in main pane"
          >
            Open thread
          </button>
        )}

        {hasSwarm && (
          <div
            className="subagent-inspector__segmented"
            role="tablist"
            aria-label="Inspector mode"
          >
            {hasRuns && (
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'subagent'}
                className={`subagent-inspector__segment-btn${mode === 'subagent' ? ' subagent-inspector__segment-btn--active' : ''}`}
                onClick={() => onSelectMode('subagent')}
              >
                Subagent
              </button>
            )}
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'swarm'}
              className={`subagent-inspector__segment-btn${mode === 'swarm' ? ' subagent-inspector__segment-btn--active' : ''}`}
              onClick={() => onSelectMode('swarm')}
            >
              Swarm Board
            </button>
          </div>
        )}
      </div>
    </div>

    {mode === 'subagent' && activeRun && (
      <div className="subagent-inspector__identity-row">
        <div className="subagent-inspector__meta-title-row">
          <div className="subagent-inspector__role">
            <span className={`subagent-dot ${runStatusDotClass(activeRun.status)}`} />
            <span>{activeRun.role || 'Subagent'}</span>
            {activeRun.typeName &&
              activeRun.typeName.toLowerCase() !== (activeRun.provider ?? '').toLowerCase() && (
                <span className="subagent-inspector__type-label">{activeRun.typeName}</span>
              )}
          </div>
          <div className="subagent-inspector__status-actions">
            {isRunBlocked(activeRun.status) ? (
              <span className="subagent-inspector__status-text subagent-inspector__status-text--waiting">
                Waiting for approval
              </span>
            ) : isRunActive(activeRun.status) ? (
              <LiveElapsedClock
                className="subagent-inspector__status-text"
                running={true}
                startedAtUnixMs={activeRun.startedAtUnixMs}
                prefix="Working · "
                format="clock"
                idleLabel="Working…"
              />
            ) : (
              <LiveElapsedClock
                className="subagent-inspector__status-text"
                running={false}
                startedAtUnixMs={activeRun.startedAtUnixMs}
                completedAtUnixMs={activeRun.updatedAtUnixMs ?? null}
                prefix={`${settledPrefixLabel(activeRun.status)} · `}
                format="duration"
                idleLabel={settledPrefixLabel(activeRun.status)}
              />
            )}
            {isRunActive(activeRun.status) && (
              <button
                type="button"
                className="subagent-stop-btn"
                aria-label="Stop subagent"
                disabled={stoppingRun}
                onClick={onStopActiveRun}
              >
                Stop
              </button>
            )}
          </div>
        </div>

        <div className="subagent-inspector__meta-subtitle">
          <span
            data-testid="subagent-model-hierarchy"
            aria-label="Main to Subagent model hierarchy"
          >
            Main: {parentModelLabel} ➔ Subagent:{' '}
            {formatInspectorModelName(activeRun.model, activeRun.provider)}
          </span>
          {activeRun.workspaceMode && (
            <>
              <span aria-hidden="true">·</span>
              <span>{activeRun.workspaceMode}</span>
            </>
          )}
        </div>
      </div>
    )}

    {mode === 'subagent' && hasRuns && (runs.length > 1 || (fromSwarmRoster && hasSwarm)) && (
      <div className="subagent-inspector__selector-strip" role="navigation" aria-label="Subagent selector">
        {fromSwarmRoster && hasSwarm && (
          <button
            type="button"
            className="subagent-inspector__back-btn"
            onClick={onBackToSwarmRoster}
          >
            ← Back to Swarm Roster
          </button>
        )}
        {runs.length > 1 &&
          runs.map((run) => {
            const selected = activeRun?.subagentId === run.subagentId;
            const shortModel = formatInspectorModelName(run.model, run.provider);
            return (
              <button
                key={run.subagentId}
                type="button"
                className={`subagent-inspector__selector-pill${selected ? ' subagent-inspector__selector-pill--active' : ''}`}
                onClick={() => onSelectRun(run.subagentId)}
              >
                <span className={`subagent-dot ${runStatusDotClass(run.status)}`} />
                <span>{run.role || run.typeName || run.subagentId}</span>
                <span className="subagent-badge">{shortModel}</span>
              </button>
            );
          })}
      </div>
    )}
  </div>
);
