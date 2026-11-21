import React, { useMemo, useRef } from 'react';
import { useTranscriptLiveEdge } from '../../../motion/useTranscriptMotion';
import type { SwarmBoardPost, SwarmMember } from '../../../types';
import { formatPostTime, TOKEN_SPLIT_RE } from './swarmBoardHelpers';

interface SwarmBoardFeedProps {
  channels: string[];
  selectedChannel: string;
  onSelectChannel: (channel: string) => void;
  filteredPosts: SwarmBoardPost[];
  highlightedSeq: number | null;
  postRefs: React.MutableRefObject<Map<number, HTMLElement>>;
  memberByName: Map<string, SwarmMember>;
  onInspectWorker: (member: SwarmMember) => void;
  onInsertTarget: (rawTarget: string) => void;
  onScrollToPost: (seq: number) => void;
}

export const SwarmBoardFeed: React.FC<SwarmBoardFeedProps> = ({
  channels,
  selectedChannel,
  onSelectChannel,
  filteredPosts,
  highlightedSeq,
  postRefs,
  memberByName,
  onInspectWorker,
  onInsertTarget,
  onScrollToPost,
}) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const feedContentKey = useMemo(() => {
    const last = filteredPosts[filteredPosts.length - 1];
    return `${selectedChannel}:${filteredPosts.length}:${last?.seq ?? 0}:${last?.text.length ?? 0}`;
  }, [selectedChannel, filteredPosts]);
  const { handleScroll } = useTranscriptLiveEdge(scrollRef, selectedChannel, atBottomRef, {
    contentKey: feedContentKey,
    columnSelector: ':self',
    edgeThresholdPx: 28,
  });

  const renderPostBody = (post: SwarmBoardPost) => {
    const parts = post.text.split(TOKEN_SPLIT_RE);
    return parts.map((part, idx) => {
      if (part.startsWith('@')) {
        const cleanName = part.replace(/^@#?/, '').toLowerCase();
        const targetMember = memberByName.get(cleanName);
        return (
          <button
            key={`${post.seq}-m-${idx}`}
            type="button"
            className="swarm-mention-pill"
            onClick={() => {
              if (targetMember) {
                onInspectWorker(targetMember);
              } else if (cleanName === 'coordinator' || cleanName === 'all') {
                onInsertTarget(`@${cleanName}`);
              } else {
                onInsertTarget(part);
              }
            }}
          >
            {part}
          </button>
        );
      }
      if (/^#\d+$/.test(part)) {
        const seqNum = Number(part.slice(1));
        return (
          <button
            key={`${post.seq}-s-${idx}`}
            type="button"
            className="swarm-seq-pill"
            onClick={() => onScrollToPost(seqNum)}
          >
            {part}
          </button>
        );
      }
      return <React.Fragment key={`${post.seq}-t-${idx}`}>{part}</React.Fragment>;
    });
  };

  return (
    <>
      <div className="swarm-board__channels" aria-label="Swarm channels">
        <button
          type="button"
          className={`swarm-channel-pill${selectedChannel === 'all' ? ' swarm-channel-pill--active' : ''}`}
          onClick={() => onSelectChannel('all')}
        >
          All
        </button>
        {channels.map((ch) => (
          <button
            key={ch}
            type="button"
            className={`swarm-channel-pill${selectedChannel === ch ? ' swarm-channel-pill--active' : ''}`}
            onClick={() => onSelectChannel(ch)}
          >
            #{ch}
          </button>
        ))}
      </div>

      <div className="swarm-board__scroll" ref={scrollRef} onScroll={handleScroll}>
        {filteredPosts.length === 0 ? (
          <div className="subagent-inspector__empty">
            <strong>No board posts yet</strong>
            <span>Posts matching this channel will stream here chronologically.</span>
          </div>
        ) : (
          filteredPosts.map((post) => (
            <article
              key={post.seq}
              data-testid={`swarm-post-${post.seq}`}
              data-swarm-seq={post.seq}
              ref={(el) => {
                if (el) postRefs.current.set(post.seq, el);
                else postRefs.current.delete(post.seq);
              }}
              className={`swarm-post-card${highlightedSeq === post.seq ? ' swarm-post-card--highlighted' : ''}`}
            >
              <div className="swarm-post-card__meta">
                <div className="swarm-post-card__author-group">
                  <span className="swarm-post-card__seq">#{post.seq}</span>
                  <span className="swarm-post-card__author">@{post.author}</span>
                  {post.channel && (
                    <span className="subagent-badge">
                      #{post.channel.replace(/^#/, '')}
                    </span>
                  )}
                </div>
                <span className="swarm-post-card__time">
                  {formatPostTime(post.createdAtUnixMs)}
                </span>
              </div>
              <div className="swarm-post-card__body">{renderPostBody(post)}</div>
            </article>
          ))
        )}
      </div>
    </>
  );
};
