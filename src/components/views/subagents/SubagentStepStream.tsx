import React from 'react';
import { motion } from 'motion/react';
import { tweens } from '../../../motion/standard/tokens';
import type { ChatItem, SubagentRun } from '../../../types';
import { ActivityGlyph } from '../chat/activityGlyph';
import { ChatApprovalCard } from '../chat/ChatApprovalCard';
import { ChatWorkEntry, ChatWorkGroup, type TranscriptRow } from '../chat/ChatItemRow';
import { MarkdownMessage } from '../chat/MarkdownMessage';
import { SubagentGroupRow } from '../chat/SubagentActivityCard';
import type { ApprovalRequest } from '../chat/types';
import { isRunActive } from './subagentInspectorHelpers';

interface SubagentStepStreamProps {
  workspaceId: string | null;
  threadId?: string | null;
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
  steeringText: string;
  sendingSteering: boolean;
  onSteeringTextChange: (value: string) => void;
  onSendSteering: (e: React.FormEvent) => void;
}

export const SubagentStepStream: React.FC<SubagentStepStreamProps> = ({
  workspaceId,
  threadId,
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
  steeringText,
  sendingSteering,
  onSteeringTextChange,
  onSendSteering,
}) => (
  <>
    {activeRun.status?.toLowerCase() === 'failed' && (
      <div
        className="subagent-inspector__failure-card"
        data-testid="subagent-failure-card"
        role="status"
      >
        <strong>Subagent execution failed</strong>
        <span>
          {activeRun.latestActivity ||
            'The subagent exited with an error. Check provider credentials, model availability, or CLI arguments.'}
        </span>
      </div>
    )}

    {activeRun.prompt && (
      <div className="subagent-brief-card">
        <button
          type="button"
          className="subagent-brief-card__toggle"
          aria-expanded={briefExpanded}
          onClick={onToggleBrief}
        >
          <span>Task Brief</span>
          <span>{briefExpanded ? 'Collapse' : 'Expand'}</span>
        </button>
        <div
          className={`subagent-brief-card__body${!briefExpanded ? ' subagent-brief-card__body--clamped' : ''}`}
        >
          {activeRun.prompt}
        </div>
      </div>
    )}

    <div className="subagent-inspector__stream-wrap">
      <div
        ref={streamRef}
        className="subagent-inspector__stream"
        onScroll={(e) => {
          const el = e.currentTarget;
          const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
          atBottomRef.current = nearBottom;
          onSetAutoScrollPaused(!nearBottom);
        }}
      >
        {visibleSteps.length === 0 ? (
          <div className="subagent-inspector__empty">
            {activeRun.status?.toLowerCase() === 'failed' ? (
              <>
                <strong>No steps captured before failure</strong>
                <span>
                  {activeRun.latestActivity || 'The subagent failed before producing transcript items.'}
                </span>
              </>
            ) : !isRunActive(activeRun.status) ? (
              <>
                <strong>
                  {activeRun.status?.toLowerCase() === 'killed' ? 'Subagent stopped' : 'Subagent settled'}
                </strong>
                <span>
                  {activeRun.latestActivity || 'No individual step items were recorded for this run.'}
                </span>
              </>
            ) : (
              <>
                <strong>Waiting for subagent steps…</strong>
                <span>{activeRun.latestActivity || 'Starting subagent execution.'}</span>
              </>
            )}
          </div>
        ) : (
          groupedRows.map((row) => {
            if (row.kind === 'work') {
              const isNewGroup = row.items.some((it) => !seenStepIdsRef.current.has(it.id));
              return (
                <motion.div
                  key={row.id}
                  className="subagent-inspector__step subagent-inspector__step--work"
                  initial={isNewGroup && !reduceMotion ? { opacity: 0, y: 4 } : false}
                  animate={{ opacity: 1, y: 0 }}
                  transition={reduceMotion ? tweens.instant : tweens.reveal}
                >
                  <ChatWorkGroup
                    items={row.items}
                    running={activeRunRunning}
                    enterFor={(id) => !seenStepIdsRef.current.has(id)}
                  />
                </motion.div>
              );
            }
            if (row.kind === 'subagentGroup') {
              return (
                <SubagentGroupRow
                  key={row.id}
                  items={row.items}
                  threadId={activeRun.childThreadId ?? threadId ?? undefined}
                  workspaceId={workspaceId}
                  enterFor={(id) => !seenStepIdsRef.current.has(id)}
                />
              );
            }
            const step = row.item;
            const isNew = !seenStepIdsRef.current.has(step.id);
            return (
              <motion.div
                key={step.id}
                className={`subagent-inspector__step subagent-inspector__step--${step.kind}`}
                initial={isNew && !reduceMotion ? { opacity: 0, y: 4 } : false}
                animate={{ opacity: 1, y: 0 }}
                transition={reduceMotion ? tweens.instant : tweens.reveal}
              >
                {step.kind === 'assistant' ? (
                  <div className="subagent-inspector__response">
                    <MarkdownMessage text={step.text} workspaceId={workspaceId} />
                  </div>
                ) : step.kind === 'user' ? (
                  <div className="subagent-inspector__user-msg">
                    <MarkdownMessage text={step.text} workspaceId={workspaceId} />
                  </div>
                ) : step.kind === 'reasoning' ? (
                  <div className="subagent-inspector__thought">
                    <span className="subagent-inspector__thought-head">
                      <ActivityGlyph item={step} size={14} />
                      <span>Thought</span>
                    </span>
                    <p className="subagent-inspector__thought-body">{step.text}</p>
                  </div>
                ) : (
                  <ChatWorkEntry
                    item={step}
                    running={isRunActive(step.status) || Boolean(step.streaming)}
                    enter={isNew}
                  />
                )}
              </motion.div>
            );
          })
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

    <form
      className="subagent-inspector__composer"
      data-testid="subagent-steering-form"
      onSubmit={onSendSteering}
    >
      <input
        type="text"
        className="subagent-inspector__composer-input"
        value={steeringText}
        placeholder={
          activeRun.childThreadId
            ? `Message ${activeRun.role || 'subagent'}…`
            : 'Follow-up steering requires a child thread subagent'
        }
        disabled={!activeRun.childThreadId || sendingSteering}
        onChange={(e) => onSteeringTextChange(e.target.value)}
      />
      <button
        type="submit"
        className="subagent-inspector__composer-submit"
        disabled={!activeRun.childThreadId || sendingSteering || !steeringText.trim()}
      >
        Send
      </button>
    </form>
  </>
);
