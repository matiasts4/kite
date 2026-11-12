import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import type { ChatItem, SubagentRun } from '../../../types';
import { BotIcon, CheckIcon, ChevronRightIcon, CloseIcon } from './ChatIcons';
import { formatDurationLabel, formatWorkingClock } from './activityPresentation';
import { prefersReducedMotion } from '../../../motion/contract';
import { tweens } from '../../../motion/standard/tokens';
import { formatShortModelLabel, openSubagentInRightDock } from '../../../lib/subagentNav';

export interface SubagentActivityCardProps {
  item: ChatItem;
  threadId?: string;
  workspaceId?: string | null;
  run?: SubagentRun | null;
  enter?: boolean;
}

export const SubagentActivityCard: React.FC<SubagentActivityCardProps> = ({
  item,
  threadId,
  workspaceId = null,
  run = null,
  enter = false,
}) => {
  const meta = item.subagentMeta;
  const subagentId = run?.subagentId || meta?.subagentId || item.id;
  const childThreadId = run?.childThreadId ?? meta?.childThreadId ?? null;
  const role = run?.role || meta?.role || item.title || 'Subagent';
  const modelLabel = formatShortModelLabel(run?.model ?? meta?.model, run?.provider ?? meta?.provider);
  const workspaceMode = run?.workspaceMode ?? meta?.workspaceMode ?? null;
  const rawStatus = run?.status || meta?.status || item.status || 'running';
  const isRunning =
    Boolean(item.streaming) ||
    rawStatus === 'running' ||
    rawStatus === 'inProgress' ||
    rawStatus === 'pending';
  const isFailed = rawStatus === 'failed' || rawStatus === 'cancelled';
  const startedAt = run?.startedAtUnixMs || item.createdAtUnixMs || 0;
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!isRunning) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isRunning]);

  const elapsedSeconds =
    !isRunning && typeof item.durationSeconds === 'number' && item.durationSeconds > 0
      ? item.durationSeconds
      : !isRunning && run?.completedAtUnixMs && startedAt > 0
        ? Math.max(0, (run.completedAtUnixMs - startedAt) / 1000)
        : startedAt > 0
          ? Math.max(0, (nowMs - startedAt) / 1000)
          : 0;

  const stepCount = Math.max(run?.stepCount ?? 0, meta?.stepCount ?? 0, run?.items?.length ?? 0);
  const liveLine =
    (run?.latestActivity || meta?.latestActivity || item.detail || meta?.prompt || item.text || '').trim();
  const promptExcerpt = (run?.prompt || meta?.prompt || '').trim();

  const statusClass = isRunning
    ? 'chat-subagent-card--running'
    : isFailed
      ? 'chat-subagent-card--failed'
      : 'chat-subagent-card--completed';

  const handleOpen = () => {
    if (!threadId) return;
    openSubagentInRightDock({
      threadId,
      subagentId,
      childThreadId,
      mode: 'subagent',
      workspaceId,
    });
  };

  return (
    <motion.div
      className="chat-subagent-card-wrap"
      initial={enter && !prefersReducedMotion() ? { opacity: 0, y: 4 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={tweens.reveal}
    >
      <button
        type="button"
        className={`chat-subagent-card ${statusClass}`}
        data-subagent-id={subagentId}
        onClick={handleOpen}
        aria-label={`Inspect subagent ${role}`}
      >
        <div className="chat-subagent-card__header">
          <span aria-hidden="true" className="chat-subagent-card__icon">
            <BotIcon size={15} />
          </span>
          <span className="chat-subagent-card__title">{role}</span>
          {modelLabel ? (
            <span className="chat-subagent-card__pill chat-subagent-card__pill--model">
              {modelLabel}
            </span>
          ) : null}
          {workspaceMode ? (
            <span className={`chat-subagent-card__pill chat-subagent-card__pill--ws-${workspaceMode}`}>
              {workspaceMode}
            </span>
          ) : null}
          <span className="chat-subagent-card__spacer" />
          <span className="chat-subagent-card__telemetry">
            {isRunning ? (
              <>
                <span aria-hidden="true" className="chat-working-pulse" />
                <span className="chat-subagent-card__clock">
                  {startedAt > 0 ? formatWorkingClock(elapsedSeconds) : 'Live'}
                </span>
              </>
            ) : isFailed ? (
              <span className="chat-subagent-card__state chat-subagent-card__state--failed">
                <CloseIcon size={11} />
                <span>{rawStatus === 'cancelled' ? 'Stopped' : 'Failed'}</span>
              </span>
            ) : (
              <span className="chat-subagent-card__state chat-subagent-card__state--done">
                <CheckIcon size={11} />
                <span>
                  {elapsedSeconds > 0 ? formatDurationLabel(elapsedSeconds) : 'Done'}
                </span>
              </span>
            )}
            {stepCount > 0 ? (
              <span className="chat-subagent-card__steps">{stepCount} {stepCount === 1 ? 'step' : 'steps'}</span>
            ) : null}
            <span className="chat-subagent-card__chevron" aria-hidden="true">
              <ChevronRightIcon size={13} />
            </span>
          </span>
        </div>

        {(liveLine || (promptExcerpt && promptExcerpt !== liveLine)) && (
          <div className="chat-subagent-card__body">
            {liveLine ? (
              <p className={`chat-subagent-card__preview ${isRunning ? 'live-tool-shine' : ''}`}>
                {liveLine}
              </p>
            ) : null}
            {promptExcerpt && promptExcerpt !== liveLine ? (
              <p className="chat-subagent-card__prompt">{promptExcerpt}</p>
            ) : null}
          </div>
        )}
      </button>
    </motion.div>
  );
};
