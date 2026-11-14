import React from 'react';
import type { SubagentRun, SwarmMember } from '../../../types';
import { SelectMenu } from '../../ui/SelectMenu';
import {
  formatInspectorModelName,
  KEEP_PROVIDER_VALUE,
  memberStateDescription,
  SWARM_PROVIDER_OPTIONS,
} from './swarmBoardHelpers';

interface SwarmRosterTabProps {
  members: SwarmMember[];
  subagentRuns?: SubagentRun[] | null;
  editingWorker: string | null;
  switchProvider: string;
  switchModel: string;
  switchingWorker: boolean;
  killingWorker: string | null;
  onToggleEditWorker: (member: SwarmMember) => void;
  onChangeSwitchProvider: (provider: string) => void;
  onChangeSwitchModel: (model: string) => void;
  onApplySwitch: (member: SwarmMember) => void;
  onKillWorker: (member: SwarmMember) => void;
  onInspectWorker: (member: SwarmMember) => void;
}

export const SwarmRosterTab: React.FC<SwarmRosterTabProps> = ({
  members,
  subagentRuns = null,
  editingWorker,
  switchProvider,
  switchModel,
  switchingWorker,
  killingWorker,
  onToggleEditWorker,
  onChangeSwitchProvider,
  onChangeSwitchModel,
  onApplySwitch,
  onKillWorker,
  onInspectWorker,
}) => (
  <div className="swarm-board__scroll">
    {members.map((member) => {
      const matchedRun = (subagentRuns ?? []).find(
        (r) =>
          r.subagentId === member.subagentId ||
          r.swarmMemberName?.toLowerCase() === member.name.toLowerCase(),
      );
      const stateInfo = memberStateDescription(member, matchedRun);
      const modelLabel = formatInspectorModelName(member.model, member.provider);
      return (
        <div key={member.name} className="swarm-roster-card">
          <div className="swarm-roster-card__top">
            <div className="swarm-post-card__author-group">
              <span className="swarm-post-card__author">@{member.name}</span>
              {member.state !== 'killed' ? (
                <button
                  type="button"
                  className="subagent-badge subagent-badge--interactive"
                  aria-label={`Switch model for @${member.name}`}
                  disabled={member.state === 'working'}
                  title={
                    member.state === 'working'
                      ? 'Wait until worker is sleeping or stopped to switch model'
                      : 'Click to hot-swap worker provider or model'
                  }
                  onClick={() => onToggleEditWorker(member)}
                >
                  {modelLabel} ▾
                </button>
              ) : (
                <span className="subagent-badge">{modelLabel}</span>
              )}
              {member.workspaceMode && (
                <span className="subagent-badge">{member.workspaceMode}</span>
              )}
            </div>
            <span className="swarm-state-badge">
              <span className={`swarm-state-dot ${stateInfo.dotClass}`} />
              <span>{stateInfo.label}</span>
            </span>
          </div>
          {(member.role || member.brief) && (
            <div className="swarm-post-card__body">
              {member.role || member.brief}
            </div>
          )}
          {editingWorker === member.name && (
            <div className="swarm-roster-card__switch-panel">
              <SelectMenu
                label={`Target provider for @${member.name}`}
                variant="field"
                className="swarm-roster-card__select"
                value={switchProvider || KEEP_PROVIDER_VALUE}
                triggerLabel={switchProvider || 'keep provider'}
                rows={SWARM_PROVIDER_OPTIONS}
                onSelect={(id) =>
                  onChangeSwitchProvider(id === KEEP_PROVIDER_VALUE ? '' : id)
                }
              />
              <input
                type="text"
                aria-label={`Target model for @${member.name}`}
                className="swarm-roster-card__input"
                value={switchModel}
                placeholder="Model id…"
                onChange={(e) => onChangeSwitchModel(e.target.value)}
              />
              <button
                type="button"
                className="swarm-roster-card__inspect-btn"
                aria-label={`Apply switch for @${member.name}`}
                disabled={!switchModel.trim() || switchingWorker}
                onClick={() => onApplySwitch(member)}
              >
                Apply
              </button>
            </div>
          )}
          <div className="swarm-roster-card__actions">
            <span className="swarm-post-card__time">
              Channels: {(member.channels ?? ['main']).map((c) => `#${c}`).join(', ')}
            </span>
            <div className="swarm-roster-card__btn-group">
              {member.state !== 'killed' && (
                <button
                  type="button"
                  className="swarm-roster-card__kill-btn"
                  aria-label={`Kill @${member.name}`}
                  disabled={killingWorker === member.name}
                  onClick={() => onKillWorker(member)}
                >
                  Kill
                </button>
              )}
              <button
                type="button"
                className="swarm-roster-card__inspect-btn"
                onClick={() => onInspectWorker(member)}
              >
                Inspect @{member.name}
              </button>
            </div>
          </div>
        </div>
      );
    })}
  </div>
);
