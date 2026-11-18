import React from 'react';
import { openDiffsInRightDock } from '../../../lib/diffPreviewNav';
import type { ChatItem, SubagentRun } from '../../../types';
import { ChangedFilesCard } from '../chat/ChangedFilesCard';
import { ChatApprovalCard } from '../chat/ChatApprovalCard';
import {
  ChatItemRow,
  ChatWorkGroup,
  liveActivityRowIndex,
  type TranscriptRow,
} from '../chat/ChatItemRow';
import { changedFilesForTurn } from '../chat/pane/threadTurnHelpers';
import { SubagentGroupRow } from '../chat/SubagentActivityCard';
import { humanizeActivityText } from '../chat/subagentRunHelpers';
import { TurnActivityStatus } from '../chat/TurnActivityStatus';
import type { ApprovalRequest } from '../chat/types';
import { isRunActive } from './subagentInspectorHelpers';

interface SubagentStepStreamProps {
  workspaceId: string | null;
  parentThreadId: string;
  activeRun: SubagentRun;
  activeRunRunning: boolean;
  visibleSteps: ChatItem[];
  groupedRows: TranscriptRow[];
  briefExpanded: boolean;
  onToggleBrief: () => void;
  reduceMotion: boolean | null;
  streamRef: React.RefObject<HTMLDivElement>;
  atBottomRef: React.MutableRefObject<boolean>;
  seenStepIdsRef: React.MutableRefObject<Set<string>>;
  autoScrollPaused: boolean;
  onSetAutoScrollPaused: (paused: boolean) => void;
  childApproval: ApprovalRequest | null;
  resolvingApproval: boolean;
  onChildApprovalDecision: (
    decision: 'allowOnce' | 'allowForSession' | 'deny' | 'denyAndStop',
    requestId: string,
  ) => void;
  actionError: string | null;
  onJumpToParent?: () => void;
}

export const SubagentStepStream: React.FC<SubagentStepStreamProps> = ({
  workspaceId,
  parentThreadId,
  activeRun,
  activeRunRunning,
  visibleSteps,
  groupedRows,
  briefExpanded,
  onToggleBrief,
  reduceMotion,
  streamRef,
  atBottomRef,
  seenStepIdsRef,
  autoScrollPaused,
  onSetAutoScrollPaused,
  childApproval,
  resolvingApproval,
  onChildApprovalDecision,
  actionError,
  onJumpToParent,
}) => {
  const normalizedStatus = (activeRun.status ?? '').toLowerCase();
  const isInterrupted =
    normalizedStatus === 'interrupted' ||
    normalizedStatus === 'killed' ||
    normalizedStatus === 'cancelled' ||
    normalizedStatus === 'stopped';
  const finishedAt = activeRun.completedAtUnixMs ?? activeRun.updatedAtUnixMs;
  const durationSeconds =
    finishedAt && activeRun.startedAtUnixMs && finishedAt >= activeRun.startedAtUnixMs
      ? Math.max(0, Math.round((finishedAt - activeRun.startedAtUnixMs) / 1000))
      : null;
  const liveWorkIdx = activeRunRunning ? liveActivityRowIndex(groupedRows) : -1;
  const enterFor = (id: string) => !reduceMotion && !seenStepIdsRef.current.has(id);
  const changedFiles = React.useMemo(() => changedFilesForTurn(visibleSteps), [visibleSteps]);
  const activityItems = React.useMemo<ChatItem[]>(() => {
    if (visibleSteps.some((item) => item.kind === 'user')) {
      return visibleSteps;
    }
    return [
      {
        id: `__subagent-start-${activeRun.subagentId}`,
        kind: 'user',
        text: activeRun.prompt ?? '',
        title: null,
        detail: null,
        status: null,
        streaming: false,
        exitCode: null,
        createdAtUnixMs: activeRun.startedAtUnixMs,
        attachments: [],
      },
      ...visibleSteps,
    ];
  }, [visibleSteps, activeRun.subagentId, activeRun.prompt, activeRun.startedAtUnixMs]);

  return (
    <>
      {normalizedStatus === 'failed' && (
        <div
          className="subagent-inspector__failure-card"
          data-testid="subagent-failure-card"
          role="status"
        >
          <strong>Subagent execution failed</strong>
          <span>
            {humanizeActivityText(activeRun.latestActivity) ||
              'The subagent exited with an error. Check provider credentials, model availability, or CLI arguments.'}
          </span>
        </div>
      )}

      <div className="subagent-inspector__stream-wrap">
        <div
          ref={streamRef}
          className="chat-transcript subagent-inspector__stream"
          onScroll={(e) => {
            const el = e.currentTarget;
            const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
            atBottomRef.current = nearBottom;
            onSetAutoScrollPaused(!nearBottom);
          }}
        >
          <div
            className="chat-transcript__column subagent-inspector__transcript-column"
            data-testid="subagent-transcript-column"
          >
            {activeRun.prompt ? (
              <article
                className="chat-turn chat-turn--user chat-user-row chat-user-row--bubble subagent-brief-card"
                data-testid="subagent-prompt-turn"
              >
                <button
                  type="button"
                  className="subagent-brief-card__toggle"
                  aria-expanded={briefExpanded}
                  onClick={onToggleBrief}
                >
                  <span className="subagent-brief-card__label">Task Brief</span>
                  <span className="subagent-brief-card__chevron">
                    {briefExpanded ? 'Collapse' : 'Expand'}
                  </span>
                </button>
                <p
                  className={`subagent-brief-card__body${
                    briefExpanded ? ' is-expanded' : ' subagent-brief-card__body--clamped'
                  }`}
                >
                  {activeRun.prompt}
                </p>
              </article>
            ) : null}

            {visibleSteps.length === 0 ? (
              <div className="subagent-inspector__empty">
                {normalizedStatus === 'failed' ? (
                  <>
                    <strong>No steps captured before failure</strong>
                    <span>
                      {humanizeActivityText(activeRun.latestActivity) || 'The subagent failed before producing transcript items.'}
                    </span>
                  </>
                ) : !isRunActive(activeRun.status) ? (
                  <>
                    <strong>
                      {normalizedStatus === 'killed' ? 'Subagent stopped' : 'Subagent settled'}
                    </strong>
                    <span>
                      {humanizeActivityText(activeRun.latestActivity) || 'No individual step items were recorded for this run.'}
                    </span>
                  </>
                ) : (
                  <>
                    <strong>Waiting for subagent steps…</strong>
                    <span>{humanizeActivityText(activeRun.latestActivity) || 'Starting subagent execution.'}</span>
                  </>
                )}
              </div>
            ) : (
              groupedRows.map((row, rowIdx) => {
                const targetThreadId = activeRun.childThreadId ?? parentThreadId;
                if (row.kind === 'work') {
                  return (
                    <ChatWorkGroup
                      key={row.id}
                      items={row.items}
                      running={activeRunRunning && rowIdx === liveWorkIdx}
                      enterFor={enterFor}
                      interrupted={isInterrupted && rowIdx === groupedRows.length - 1}
                    />
                  );
                }
                if (row.kind === 'subagentGroup') {
                  return (
                    <SubagentGroupRow
                      key={row.id}
                      items={row.items}
                      threadId={targetThreadId}
                      workspaceId={workspaceId}
                      enterFor={enterFor}
                    />
                  );
                }
                return (
                  <ChatItemRow
                    key={row.item.id}
                    item={row.item}
                    threadId={targetThreadId}
                    workspaceId={workspaceId}
                    subagentRuns={null}
                    swarmState={null}
                    enter={enterFor(row.item.id)}
                  />
                );
              })
            )}

            {(visibleSteps.length > 0 || (isInterrupted && !activeRunRunning)) && (
              <TurnActivityStatus
                running={activeRunRunning}
                pendingApproval={childApproval}
                items={activityItems}
                swarmState={null}
                interrupted={isInterrupted && !activeRunRunning}
                durationSeconds={durationSeconds}
              />
            )}

            {changedFiles.length > 0 && (
              <ChangedFilesCard
                files={changedFiles}
                onOpenTurnDiff={() =>
                  openDiffsInRightDock({
                    workspaceId: workspaceId ?? null,
                    focusPaths: changedFiles.map((file) => file.path),
                  })
                }
                onOpenFile={(path) =>
                  openDiffsInRightDock({
                    workspaceId: workspaceId ?? null,
                    focusPaths: [path],
                    selectedPath: path,
                  })
                }
              />
            )}

            {childApproval && (
              <div className="subagent-inspector__approval-wrap" data-testid="subagent-child-approval">
                <ChatApprovalCard
                  approval={childApproval}
                  busy={resolvingApproval}
                  onDecision={onChildApprovalDecision}
                />
              </div>
            )}
          </div>
        </div>

        {autoScrollPaused && (
          <button
            type="button"
            className="subagent-inspector__jump-latest"
            onClick={() => {
              atBottomRef.current = true;
              onSetAutoScrollPaused(false);
              if (streamRef.current) {
                streamRef.current.scrollTop = streamRef.current.scrollHeight;
              }
            }}
          >
            Jump to latest
          </button>
        )}
      </div>

      {actionError && (
        <div className="subagent-inspector__error" role="alert">
          {actionError}
        </div>
      )}

      <div
        className="subagent-inspector__readonly-footer"
        data-testid="subagent-readonly-footer"
        role="status"
      >
        <span className="subagent-inspector__readonly-label">
          Read-only subagent thread · Managed by the orchestrator
        </span>
        {onJumpToParent && (
          <button
            type="button"
            className="subagent-inspector__readonly-action"
            onClick={onJumpToParent}
          >
            Focus main thread
          </button>
        )}
      </div>
    </>
  );
};
