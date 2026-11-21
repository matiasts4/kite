import React from 'react';
import type { SubagentRun } from '../../../types';
import { AgentStatusIndicator } from '../../ui/AgentStatusIndicator';
import { SubagentRoleIcon } from '../../ui/SubagentRoleIcon';
import { LiveElapsedClock } from '../chat/LiveElapsedClock';
import type { ExtendedChatThread } from '../chat/types';
import { formatInspectorModelName } from './swarmBoardHelpers';
import { SubagentRunSwitcher } from './SubagentRunSwitcher';
import {
  formatSubagentDisplayTitle,
  isRunActive,
  isRunBlocked,
  settledPrefixLabel,
  type InspectorMode,
  type InspectorScope,
} from './subagentInspectorHelpers';

interface SubagentInspectorHeaderProps {
  scope: InspectorScope;
  threadRunsCount: number;
  globalTotalCount: number;
  globalActiveCount: number;
  thread: ExtendedChatThread | null;
  mode: InspectorMode;
  hasRuns: boolean;
  hasSwarm: boolean;
  runs: SubagentRun[];
  activeRun: SubagentRun | null;
  showingOverview: boolean;
  fromGlobalView: boolean;
  parentModelLabel: string;
  stoppingRun: boolean;
  fromSwarmRoster: boolean;
  onSelectScope: (scope: InspectorScope) => void;
  onJumpToParent: () => void;
  onPopOutChildThread: () => void;
  onSelectMode: (mode: InspectorMode) => void;
  onSelectRun: (subagentId: string) => void;
  onBackToOverview: () => void;
  onBackToGlobal: () => void;
  onStopActiveRun: () => void;
  onBackToSwarmRoster: () => void;
}

export const SubagentInspectorHeader: React.FC<SubagentInspectorHeaderProps> = ({
  scope,
  threadRunsCount,
  globalTotalCount,
  globalActiveCount,
  thread,
  mode,
  hasRuns,
  hasSwarm,
  runs,
  activeRun,
  showingOverview,
  fromGlobalView,
  parentModelLabel,
  stoppingRun,
  fromSwarmRoster,
  onSelectScope,
  onJumpToParent,
  onPopOutChildThread,
  onSelectMode,
  onSelectRun,
  onBackToOverview,
  onBackToGlobal,
  onStopActiveRun,
  onBackToSwarmRoster,
}) => {
  const showBackToOverview =
    scope === 'thread' &&
    mode === 'subagent' &&
    runs.length > 1 &&
    Boolean(activeRun) &&
    !showingOverview &&
    !fromSwarmRoster;

  const isDrilledIn = fromGlobalView || fromSwarmRoster || showBackToOverview;
  const showOpenThreadBtn = Boolean(mode === 'subagent' && activeRun?.childThreadId && !showingOverview);
  const showSwarmSwitch = scope === 'thread' && hasSwarm;

  const activeTitle = activeRun ? formatSubagentDisplayTitle(activeRun) : 'Subagent';
  const resolvedSubagentModel = activeRun
    ? !activeRun.model || activeRun.model.trim().toLowerCase() === 'inherit'
      ? parentModelLabel
      : formatInspectorModelName(activeRun.model, activeRun.provider)
    : parentModelLabel;

  return (
    <div className="subagent-inspector__header">
      {!isDrilledIn ? (
        <div className="subagent-inspector__scope-row">
          <div
            className="subagent-inspector__segmented"
            role="tablist"
            aria-label="Subagents scope"
          >
            <button
              type="button"
              role="tab"
              aria-selected={scope === 'thread'}
              className={`subagent-inspector__segment-btn${scope === 'thread' ? ' subagent-inspector__segment-btn--active' : ''}`}
              onClick={() => onSelectScope('thread')}
            >
              <span>This Thread</span>
              {threadRunsCount > 0 && (
                <span className="subagent-inspector__scope-count">{threadRunsCount}</span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={scope === 'all'}
              className={`subagent-inspector__segment-btn${scope === 'all' ? ' subagent-inspector__segment-btn--active' : ''}`}
              onClick={() => onSelectScope('all')}
            >
              {globalActiveCount > 0 && (
                <AgentStatusIndicator status="running" size={11} />
              )}
              <span>All Threads</span>
              {globalTotalCount > 0 && (
                <span className="subagent-inspector__scope-count">{globalTotalCount}</span>
              )}
            </button>
          </div>

          <div className="subagent-inspector__top-actions">
            {showSwarmSwitch && (
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
                    Subagents
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
            {showOpenThreadBtn && (
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
          </div>
        </div>
      ) : (
        <div className="subagent-inspector__top-row">
          <div className="subagent-inspector__nav-group">
            {fromGlobalView && (
              <button
                type="button"
                className="subagent-inspector__back-btn"
                onClick={onBackToGlobal}
              >
                ← All Subagents
              </button>
            )}
            {fromSwarmRoster && hasSwarm && (
              <button
                type="button"
                className="subagent-inspector__back-btn"
                onClick={onBackToSwarmRoster}
              >
                ← Back to Swarm Roster
              </button>
            )}
            {showBackToOverview && (
              <button
                type="button"
                className="subagent-inspector__back-btn"
                onClick={onBackToOverview}
              >
                ← Subagents ({runs.length})
              </button>
            )}
            {thread && (
              <button
                type="button"
                className="subagent-inspector__parent-link"
                onClick={onJumpToParent}
                aria-label={`Main Thread: ${thread.title || 'Untitled Thread'}`}
                title={`Focus main thread: ${thread.title || thread.id}`}
              >
                <span className="subagent-inspector__parent-link-text">
                  {thread.title || 'Untitled Thread'}
                </span>
              </button>
            )}
          </div>

          <div className="subagent-inspector__top-actions">
            {showSwarmSwitch && mode === 'subagent' && (
              <button
                type="button"
                className="subagent-inspector__popout-btn"
                onClick={() => onSelectMode('swarm')}
                title="Switch to Swarm Board"
              >
                Swarm
              </button>
            )}
            {showOpenThreadBtn && (
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
          </div>
        </div>
      )}

      {mode === 'subagent' && activeRun && !showingOverview && (
        <div className="subagent-inspector__identity-row">
          <div className="subagent-inspector__meta-title-row">
            <div className="subagent-inspector__identity-main">
              {runs.length > 1 ? (
                <SubagentRunSwitcher
                  key={thread?.id ?? activeRun.parentThreadId}
                  runs={runs}
                  activeRun={activeRun}
                  onSelectRun={onSelectRun}
                />
              ) : (
                <div className="subagent-inspector__role">
                  <SubagentRoleIcon
                    typeName={activeRun.typeName}
                    role={activeRun.role}
                    status={activeRun.status}
                    size={15}
                  />
                  <span className="subagent-inspector__role-title">{activeTitle}</span>
                  {activeRun.typeName &&
                    activeRun.typeName.toLowerCase() !== (activeRun.provider ?? '').toLowerCase() &&
                    activeRun.typeName.toLowerCase() !== activeTitle.toLowerCase() && (
                      <span className="subagent-inspector__type-label">{activeRun.typeName}</span>
                    )}
                </div>
              )}
            </div>

            <div className="subagent-inspector__status-actions">
              {isRunBlocked(activeRun.status) ? (
                <span className="subagent-run-card__live">
                  <AgentStatusIndicator status="waiting" size={13} />
                  <span className="subagent-inspector__status-text subagent-inspector__status-text--waiting">
                    Waiting for approval
                  </span>
                </span>
              ) : isRunActive(activeRun.status) ? (
                <span className="subagent-run-card__live" aria-label="Working">
                  <AgentStatusIndicator status="running" size={13} />
                  <LiveElapsedClock
                    className="subagent-inspector__status-text"
                    running={true}
                    startedAtUnixMs={activeRun.startedAtUnixMs}
                    prefix=""
                    format="clock"
                    idleLabel=""
                  />
                </span>
              ) : (
                <span className="subagent-run-card__settled">
                  <AgentStatusIndicator status={activeRun.status} size={12} />
                  <LiveElapsedClock
                    className="subagent-inspector__status-text"
                    running={false}
                    startedAtUnixMs={activeRun.startedAtUnixMs}
                    completedAtUnixMs={activeRun.completedAtUnixMs ?? activeRun.updatedAtUnixMs ?? null}
                    prefix={`${settledPrefixLabel(activeRun.status)} · `}
                    format="duration"
                    idleLabel={settledPrefixLabel(activeRun.status)}
                  />
                </span>
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

          <div
            className="subagent-inspector__meta-subtitle"
            title={`Main: ${parentModelLabel} ➔ Subagent: ${resolvedSubagentModel}${activeRun.workspaceMode ? ` · ${activeRun.workspaceMode}` : ''}`}
          >
            <span
              data-testid="subagent-model-hierarchy"
              aria-label="Main to Subagent model hierarchy"
              className="subagent-inspector__hierarchy-text"
            >
              Main: {parentModelLabel} ➔ Subagent: {resolvedSubagentModel}
            </span>
            {activeRun.workspaceMode && (
              <>
                <span aria-hidden="true">·</span>
                <span className="subagent-inspector__workspace-text">{activeRun.workspaceMode}</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
