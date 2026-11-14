import React from 'react';
import { BrandLogo } from '../ui/BrandLogo';
import { openSubagentInRightDock } from '../../lib/subagentNav';
import {
  childAttentionLabel,
  classifyChildAttention,
  type RosterChildCandidate,
} from '../views/chat/threadInteraction';

export interface ActiveChildRowsProps {
  parentId: string;
  parentTitle: string;
  workspaceId?: string | null;
  childrenList: RosterChildCandidate[];
  selectedThreadId?: string | null;
  onSelectParent?: (parentId: string) => void;
}

/** Nested active or attention-needing child subagent rows rendered under a parent thread. */
export const ActiveChildRows: React.FC<ActiveChildRowsProps> = ({
  parentId,
  parentTitle,
  workspaceId,
  childrenList,
  selectedThreadId,
  onSelectParent,
}) => {
  if (childrenList.length === 0) return null;

  return (
    <div
      className="chat-thread-children"
      role="group"
      aria-label={`Active subagents for ${parentTitle}`}
    >
      {childrenList.map((child) => {
        const attention = classifyChildAttention(child);
        const statusLabel = childAttentionLabel(attention);
        const label =
          child.subagentRole ||
          child.swarmMemberName ||
          child.title ||
          'Subagent';
        const dotMod =
          attention === 'running'
            ? 'running'
            : attention === 'approval' || attention === 'input' || attention === 'blocked'
              ? 'waiting'
              : 'settled';
        return (
          <button
            key={child.id}
            type="button"
            className={`chat-thread-child-row chat-thread-child-row--${attention}`}
            aria-label={`${label}, ${statusLabel}`}
            title={`Inspect ${label} (${child.provider || 'antigravity'}) in Subagents dock`}
            onClick={() => {
              if (selectedThreadId !== parentId) {
                onSelectParent?.(parentId);
              }
              openSubagentInRightDock({
                threadId: parentId,
                childThreadId: child.id,
                mode: child.swarmId ? 'swarm' : 'subagent',
                swarmId: child.swarmId ?? undefined,
                workspaceId: workspaceId ?? undefined,
              });
            }}
          >
            <i aria-hidden="true" className={`chat-thread-row__dot chat-thread-row__dot--${dotMod}`} />
            <BrandLogo
              engine={child.provider || 'antigravity'}
              size={12}
              className="chat-thread-row__logo"
            />
            <span className="chat-thread-child-row__title">{label}</span>
            <span className={`chat-thread-child-row__status chat-thread-child-row__status--${attention}`}>
              {statusLabel}
            </span>
          </button>
        );
      })}
    </div>
  );
};
