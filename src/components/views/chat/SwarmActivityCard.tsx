import React from 'react';
import { motion } from 'motion/react';
import type { ChatItem, SwarmState } from '../../../types';
import { BotIcon, ChevronRightIcon } from './ChatIcons';
import { prefersReducedMotion } from '../../../motion/contract';
import { tweens } from '../../../motion/standard/tokens';
import { openSubagentInRightDock } from '../../../lib/subagentNav';

export interface SwarmActivityCardProps {
  item: ChatItem;
  threadId?: string;
  workspaceId?: string | null;
  swarmState?: SwarmState | null;
  enter?: boolean;
}

export const SwarmActivityCard: React.FC<SwarmActivityCardProps> = ({
  item,
  threadId,
  workspaceId = null,
  swarmState = null,
  enter = false,
}) => {
  const meta = item.swarmMeta;
  const swarmId = swarmState?.swarmId || meta?.swarmId || item.id;
  const title = swarmState?.title || meta?.swarmTitle || item.title || 'Swarm';
  const members = swarmState?.members ?? [];
  const latestPost = swarmState?.posts?.[swarmState.posts.length - 1] ?? null;
  const workingCount = members.filter((m) => m.state === 'working').length;
  const isRunning =
    workingCount > 0 ||
    Boolean(item.streaming) ||
    item.status === 'running' ||
    item.status === 'inProgress';

  const postSeq = latestPost?.seq ?? meta?.seq ?? null;
  const postAuthor = latestPost?.author || meta?.memberName || null;
  const postChannel = latestPost?.channel || meta?.channel || 'main';
  const postBody = (latestPost?.text || meta?.postText || meta?.brief || item.detail || item.text || '').trim();
  const shownMembers = members.slice(0, 4);
  const extraMembers = Math.max(0, members.length - shownMembers.length);

  const handleOpen = () => {
    if (!threadId) return;
    openSubagentInRightDock({
      threadId,
      swarmId,
      mode: 'swarm',
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
        className={`chat-subagent-card chat-swarm-card ${isRunning ? 'chat-subagent-card--running' : ''}`}
        data-swarm-id={swarmId}
        onClick={handleOpen}
        aria-label={`Inspect swarm ${title}`}
      >
        <div className="chat-subagent-card__header">
          <span aria-hidden="true" className="chat-subagent-card__icon">
            <BotIcon size={15} />
          </span>
          <span className="chat-subagent-card__title">{title}</span>
          {members.length > 0 ? (
            <span className="chat-subagent-card__pill">
              {workingCount > 0 ? `${workingCount}/${members.length} working` : `${members.length} workers`}
            </span>
          ) : null}
          {postSeq ? (
            <span className="chat-subagent-card__pill chat-subagent-card__pill--seq">#{postSeq}</span>
          ) : null}
          <span className="chat-subagent-card__spacer" />
          <span className="chat-subagent-card__telemetry">
            {isRunning ? <span aria-hidden="true" className="chat-working-pulse" /> : null}
            <span className="chat-subagent-card__inspect-label">Inspect Board</span>
            <span className="chat-subagent-card__chevron" aria-hidden="true">
              <ChevronRightIcon size={13} />
            </span>
          </span>
        </div>

        {(shownMembers.length > 0 || postBody) && (
          <div className="chat-subagent-card__body">
            {shownMembers.length > 0 ? (
              <div className="chat-swarm-card__roster">
                {shownMembers.map((member) => (
                  <span key={member.name} className="chat-swarm-member-chip">
                    <span className={`chat-swarm-dot chat-swarm-dot--${member.state || 'waiting'}`} aria-hidden="true" />
                    <span>@{member.name}</span>
                  </span>
                ))}
                {extraMembers > 0 ? (
                  <span className="chat-subagent-card__steps">+{extraMembers}</span>
                ) : null}
              </div>
            ) : null}
            {postBody ? (
              <p className={`chat-subagent-card__preview ${isRunning ? 'live-tool-shine' : ''}`}>
                {postAuthor ? `@${postAuthor} · #${postChannel}: ` : ''}
                {postBody}
              </p>
            ) : null}
          </div>
        )}
      </button>
    </motion.div>
  );
};
