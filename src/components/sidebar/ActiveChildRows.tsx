import React, { useEffect, useState } from 'react';
import { BrandLogo } from '../ui/BrandLogo';
import { AgentStatusIndicator } from '../ui/AgentStatusIndicator';
import {
  getActiveSubagentInspection,
  openSubagentInRightDock,
  SUBAGENT_INSPECTION_CHANGE_EVENT,
  type OpenRightDockSubagentDetail,
} from '../../lib/subagentNav';
import {
  childAttentionLabel,
  childDisplayLabel,
  classifyChildAttention,
  type RosterChildCandidate,
} from '../views/chat/threadInteraction';

export const DEFAULT_VISIBLE_CHILD_ROWS = 3;

export interface ActiveChildRowsProps {
  parentId: string;
  parentTitle: string;
  workspaceId?: string | null;
  childrenList: RosterChildCandidate[];
  selectedThreadId?: string | null;
  onSelectParent?: (parentId: string) => void;
}

function useActiveInspection(): OpenRightDockSubagentDetail | null {
  const [active, setActive] = useState<OpenRightDockSubagentDetail | null>(() =>
    getActiveSubagentInspection(),
  );
  useEffect(() => {
    const handler = (ev: Event) => {
      setActive((ev as CustomEvent<OpenRightDockSubagentDetail | null>).detail ?? null);
    };
    window.addEventListener(SUBAGENT_INSPECTION_CHANGE_EVENT, handler);
    return () => window.removeEventListener(SUBAGENT_INSPECTION_CHANGE_EVENT, handler);
  }, []);
  return active;
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
  const [showAll, setShowAll] = useState(false);
  const activeInspection = useActiveInspection();

  useEffect(() => {
    if (childrenList.length <= DEFAULT_VISIBLE_CHILD_ROWS && showAll) {
      setShowAll(false);
    }
  }, [childrenList.length, showAll]);

  if (childrenList.length === 0) return null;

  const hasOverflow = childrenList.length > DEFAULT_VISIBLE_CHILD_ROWS;
  const visibleChildren =
    hasOverflow && !showAll ? childrenList.slice(0, DEFAULT_VISIBLE_CHILD_ROWS) : childrenList;
  const hiddenCount = childrenList.length - visibleChildren.length;

  return (
    <div
      className="chat-thread-children"
      role="group"
      aria-label={`Active subagents for ${parentTitle}`}
    >
      {visibleChildren.map((child) => {
        const attention = classifyChildAttention(child);
        const statusLabel = childAttentionLabel(attention);
        const label = childDisplayLabel(child);
        const childThreadId =
          child.childThreadId ?? (child.subagentId ? undefined : child.id);
        const isInspected = Boolean(
          activeInspection &&
            activeInspection.threadId === parentId &&
            ((child.subagentId && activeInspection.subagentId === child.subagentId) ||
              (childThreadId && activeInspection.childThreadId === childThreadId)),
        );
        const dotMod =
          attention === 'approval' || attention === 'input' || attention === 'blocked'
            ? 'waiting'
            : 'settled';

        return (
          <button
            key={child.subagentId || child.id}
            type="button"
            className={`chat-thread-child-row chat-thread-child-row--${attention}${
              isInspected ? ' chat-thread-child-row--inspected' : ''
            }`}
            aria-label={`${label}, ${statusLabel}`}
            title={`Inspect ${label} (${child.provider || 'antigravity'}) in Subagents dock`}
            onClick={() => {
              if (selectedThreadId !== parentId) {
                onSelectParent?.(parentId);
              }
              openSubagentInRightDock({
                threadId: parentId,
                subagentId: child.subagentId ?? undefined,
                childThreadId,
                mode:
                  child.swarmId && !child.subagentId && !childThreadId
                    ? 'swarm'
                    : 'subagent',
                swarmId: child.swarmId ?? undefined,
                workspaceId: workspaceId ?? undefined,
              });
            }}
          >
            <BrandLogo
              engine={child.provider || 'antigravity'}
              size={12}
              className="chat-thread-row__logo"
            />
            <span className="chat-thread-child-row__title">{label}</span>
            {attention === 'running' ? (
              <AgentStatusIndicator status="running" size={11} />
            ) : (
              <span className="chat-thread-child-row__attention">
                <i aria-hidden="true" className={`chat-thread-row__dot chat-thread-row__dot--${dotMod}`} />
                <span className={`chat-thread-child-row__status chat-thread-child-row__status--${attention}`}>
                  {statusLabel}
                </span>
              </span>
            )}
          </button>
        );
      })}

      {hasOverflow && (
        <button
          type="button"
          className="chat-thread-children__more"
          aria-expanded={showAll}
          onClick={() => setShowAll((prev) => !prev)}
        >
          {showAll ? 'Show less' : `+${hiddenCount} more`}
        </button>
      )}
    </div>
  );
};
