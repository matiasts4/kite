import React from 'react';
import type { SubagentRun } from '../../../types';
import { AgentStatusIndicator } from '../../ui/AgentStatusIndicator';
import { SubagentRoleIcon } from '../../ui/SubagentRoleIcon';
import { ChevronRightIcon } from '../chat/ChatIcons';
import { LiveElapsedClock } from '../chat/LiveElapsedClock';
import { formatInspectorModelName } from './swarmBoardHelpers';
import {
  cleanRunPreviewText,
  isRunActive,
  isRunBlocked,
  settledPrefixLabel,
} from './subagentInspectorHelpers';

export interface SubagentRunCardProps {
  run: SubagentRun;
  hasPendingApproval?: boolean;
  stopping?: boolean;
  onInspect: () => void;
  onStop?: () => void;
}

/** Compact interactive card summarizing a single subagent execution inside RightDock overviews. */
export const SubagentRunCard: React.FC<SubagentRunCardProps> = ({
  run,
  hasPendingApproval = false,
  stopping = false,
  onInspect,
  onStop,
}) => {
  const blocked = hasPendingApproval || isRunBlocked(run.status);
  const running = !blocked && isRunActive(run.status);
  const active = blocked || running;
  const visualStatus = blocked ? 'waiting' : run.status;
  const modelLabel = formatInspectorModelName(run.model, run.provider);
  const preview = cleanRunPreviewText(run);
  const roleLabel = run.role || run.typeName || run.subagentId || 'Subagent';
  const showWorkspacePill = Boolean(run.workspaceMode && run.workspaceMode !== 'inherit');
  const stepCount = run.stepCount ?? run.items?.length ?? 0;

  return (
    <div
      className={`subagent-run-card${active ? ' subagent-run-card--active' : ''}${blocked ? ' subagent-run-card--waiting' : ''}`}
      data-testid="subagent-run-card"
      data-subagent-id={run.subagentId}
    >
      <div className="subagent-run-card__row">
        <button
          type="button"
          className="subagent-run-card__trigger"
          onClick={onInspect}
          aria-label={`Inspect ${roleLabel}`}
        >
          <div className="subagent-run-card__top">
            <div className="subagent-run-card__identity">
              <SubagentRoleIcon
                typeName={run.typeName}
                role={roleLabel}
                status={visualStatus}
                size={14}
              />
              <span className="subagent-run-card__role">{roleLabel}</span>
              {run.typeName &&
                run.typeName.toLowerCase() !== (run.provider ?? '').toLowerCase() &&
                run.typeName.toLowerCase() !== roleLabel.toLowerCase() && (
                  <span className="subagent-inspector__type-label">{run.typeName}</span>
                )}
              <span className="subagent-badge">{modelLabel}</span>
              {showWorkspacePill && run.workspaceMode && (
                <span className="subagent-badge">{run.workspaceMode}</span>
              )}
              {blocked && (
                <span className="subagent-badge subagent-badge--waiting">Needs approval</span>
              )}
            </div>

            <div className="subagent-run-card__telemetry">
              {blocked ? (
                <span className="subagent-run-card__live">
                  <AgentStatusIndicator status="waiting" size={12} />
                  <span className="subagent-inspector__status-text subagent-inspector__status-text--waiting">
                    Waiting
                  </span>
                </span>
              ) : running ? (
                <span className="subagent-run-card__live" aria-label="Working">
                  <AgentStatusIndicator status="running" size={13} />
                  <LiveElapsedClock
                    className="subagent-inspector__status-text"
                    running={true}
                    startedAtUnixMs={run.startedAtUnixMs}
                    prefix=""
                    format="clock"
                    idleLabel=""
                  />
                </span>
              ) : (
                <span className="subagent-run-card__settled">
                  <AgentStatusIndicator status={run.status} size={12} />
                  <LiveElapsedClock
                    className="subagent-inspector__status-text"
                    running={false}
                    startedAtUnixMs={run.startedAtUnixMs}
                    completedAtUnixMs={run.completedAtUnixMs ?? run.updatedAtUnixMs ?? null}
                    prefix={`${settledPrefixLabel(run.status)} · `}
                    format="duration"
                    idleLabel={settledPrefixLabel(run.status)}
                  />
                </span>
              )}
              {stepCount > 0 && (
                <span className="subagent-run-card__steps">
                  {stepCount} {stepCount === 1 ? 'step' : 'steps'}
                </span>
              )}
              <span className="subagent-run-card__chevron" aria-hidden="true">
                <ChevronRightIcon size={12} />
              </span>
            </div>
          </div>

          {preview && preview.toLowerCase() !== roleLabel.toLowerCase() && (
            <p className="subagent-run-card__preview">{preview}</p>
          )}
        </button>

        {active && onStop && (
          <div className="subagent-run-card__actions">
            <button
              type="button"
              className="subagent-stop-btn"
              aria-label={`Stop ${roleLabel}`}
              disabled={stopping}
              onClick={onStop}
            >
              Stop
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
