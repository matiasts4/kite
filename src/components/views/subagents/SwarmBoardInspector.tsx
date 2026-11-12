import React, { useMemo, useRef, useState } from 'react';
import type {
  SubagentRun,
  SwarmBoardPost,
  SwarmMember,
  SwarmState,
} from '../../../types';
import { formatShortModelLabel } from '../../../lib/subagentNav';

type SwarmTab = 'feed' | 'roster' | 'graph';

export interface SwarmBoardInspectorProps {
  swarmState: SwarmState;
  parentModelLabel: string;
  subagentRuns?: SubagentRun[] | null;
  onInspectWorker: (member: SwarmMember) => void;
}

export function formatInspectorModelName(
  model?: string | null,
  provider?: string | null,
): string {
  const m = (model ?? '').trim();
  const lower = m.toLowerCase();
  if (lower.includes('opus-4-6')) return 'Opus 4.6';
  if (lower.includes('sonnet-4-6')) return 'Sonnet 4.6';
  if (lower.includes('haiku-3-5') || lower.includes('3-5-haiku')) return 'Haiku 3.5';
  if (lower.includes('gemini-2.5-flash')) return 'Gemini Flash';
  if (lower.includes('gemini-2.5-pro')) return 'Gemini Pro';
  return formatShortModelLabel(model, provider) || provider || 'Default';
}

function formatPostTime(unixMs?: number | null): string {
  if (!unixMs || !Number.isFinite(unixMs)) return '';
  try {
    return new Date(unixMs).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

function memberStateDescription(
  member: SwarmMember,
  matchedRun?: SubagentRun,
): { dotClass: string; label: string } {
  const state = (member.state ?? 'waiting').toLowerCase();
  if (state === 'working') {
    const activity =
      member.currentActivity?.trim() ||
      matchedRun?.latestActivity?.trim() ||
      'Working';
    return { dotClass: 'swarm-state-dot--working', label: activity };
  }
  if (state === 'stopped') {
    return {
      dotClass: 'swarm-state-dot--stopped',
      label: 'Stopped (wakes on @mention)',
    };
  }
  if (state === 'killed') {
    return { dotClass: 'swarm-state-dot--killed', label: 'Killed' };
  }
  return {
    dotClass: 'swarm-state-dot--waiting',
    label: 'Sleeping on board (0 tokens)',
  };
}

interface ParsedMentionEdge {
  seq: number;
  from: string;
  to: string;
  channel: string;
  isStall: boolean;
}

const TOKEN_SPLIT_RE = /(@#?[A-Za-z0-9_.-]+|#\d+\b)/g;

export const SwarmBoardInspector: React.FC<SwarmBoardInspectorProps> = ({
  swarmState,
  parentModelLabel,
  subagentRuns = null,
  onInspectWorker,
}) => {
  const [activeTab, setActiveTab] = useState<SwarmTab>('feed');
  const [selectedChannel, setSelectedChannel] = useState<string>('all');
  const [highlightedSeq, setHighlightedSeq] = useState<number | null>(null);
  const postRefs = useRef<Map<number, HTMLElement>>(new Map());

  const members = swarmState.members ?? [];
  const posts = swarmState.posts ?? [];

  const channels = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const ch of swarmState.channels ?? []) {
      const name = ch.name.replace(/^#/, '');
      if (name && !seen.has(name)) {
        seen.add(name);
        list.push(name);
      }
    }
    for (const post of posts) {
      const name = (post.channel ?? '').replace(/^#/, '');
      if (name && !seen.has(name)) {
        seen.add(name);
        list.push(name);
      }
    }
    if (!seen.has('main')) list.unshift('main');
    return list;
  }, [swarmState.channels, posts]);

  const filteredPosts = useMemo(() => {
    if (selectedChannel === 'all') return posts;
    return posts.filter(
      (p) => (p.channel ?? 'main').replace(/^#/, '') === selectedChannel,
    );
  }, [posts, selectedChannel]);

  const memberByName = useMemo(() => {
    const map = new Map<string, SwarmMember>();
    for (const member of members) {
      map.set(member.name.toLowerCase(), member);
    }
    return map;
  }, [members]);

  const scrollToPost = (seq: number) => {
    setSelectedChannel('all');
    setHighlightedSeq(seq);
    const existing = postRefs.current.get(seq);
    if (existing && typeof existing.scrollIntoView === 'function') {
      existing.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    requestAnimationFrame(() => {
      const el = postRefs.current.get(seq);
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  };

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
            onClick={() => scrollToPost(seqNum)}
          >
            {part}
          </button>
        );
      }
      return <React.Fragment key={`${post.seq}-t-${idx}`}>{part}</React.Fragment>;
    });
  };

  const graphData = useMemo(() => {
    const postCountByAuthor = new Map<string, number>();
    const edges: ParsedMentionEdge[] = [];
    const stallPosts: SwarmBoardPost[] = [];
    let batonHolder: string | null = null;

    for (const post of posts) {
      const author = post.author || 'coordinator';
      postCountByAuthor.set(author, (postCountByAuthor.get(author) ?? 0) + 1);
      const isStall = /\[stall\]/i.test(post.text);
      if (isStall) stallPosts.push(post);

      const matches = post.text.match(/@#?[A-Za-z0-9_.-]+/g) ?? [];
      for (const rawTarget of matches) {
        const cleanTarget = rawTarget.replace(/^@#?/, '');
        if (cleanTarget.toLowerCase() === 'all') continue;
        edges.push({
          seq: post.seq,
          from: `@${author}`,
          to: `@${cleanTarget}`,
          channel: (post.channel ?? 'main').replace(/^#/, ''),
          isStall,
        });
        batonHolder = `@${cleanTarget}`;
      }
    }

    const activeWorker = members.find((m) => (m.state ?? '').toLowerCase() === 'working');
    if (activeWorker) {
      batonHolder = `@${activeWorker.name}`;
    }

    return { postCountByAuthor, edges, stallPosts, batonHolder };
  }, [posts, members]);

  return (
    <div className="swarm-board" data-testid="swarm-board-inspector">
      <div className="swarm-board__overview">
        <div className="swarm-board__title-row">
          <span className="swarm-board__title">{swarmState.title || 'Swarm Board'}</span>
          <span className="subagent-badge">
            {members.length} {members.length === 1 ? 'worker' : 'workers'}
          </span>
        </div>
        <div className="swarm-board__models-row">
          <span className="subagent-badge subagent-badge--hierarchy">
            Coordinator: {parentModelLabel}
          </span>
          {members.slice(0, 4).map((member) => (
            <span key={member.name} className="subagent-badge">
              @{member.name}: {formatInspectorModelName(member.model, member.provider)}
            </span>
          ))}
        </div>
      </div>

      <div className="swarm-board__subtabs" role="tablist" aria-label="Swarm views">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'feed'}
          className={`subagent-inspector__segment-btn${activeTab === 'feed' ? ' subagent-inspector__segment-btn--active' : ''}`}
          onClick={() => setActiveTab('feed')}
        >
          Board Feed
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'roster'}
          className={`subagent-inspector__segment-btn${activeTab === 'roster' ? ' subagent-inspector__segment-btn--active' : ''}`}
          onClick={() => setActiveTab('roster')}
        >
          Roster ({members.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'graph'}
          className={`subagent-inspector__segment-btn${activeTab === 'graph' ? ' subagent-inspector__segment-btn--active' : ''}`}
          onClick={() => setActiveTab('graph')}
        >
          Activity Graph
        </button>
      </div>

      {activeTab === 'feed' && (
        <>
          <div className="swarm-board__channels" aria-label="Swarm channels">
            <button
              type="button"
              className={`swarm-channel-pill${selectedChannel === 'all' ? ' swarm-channel-pill--active' : ''}`}
              onClick={() => setSelectedChannel('all')}
            >
              All
            </button>
            {channels.map((ch) => (
              <button
                key={ch}
                type="button"
                className={`swarm-channel-pill${selectedChannel === ch ? ' swarm-channel-pill--active' : ''}`}
                onClick={() => setSelectedChannel(ch)}
              >
                #{ch}
              </button>
            ))}
          </div>

          <div className="swarm-board__scroll">
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
      )}

      {activeTab === 'roster' && (
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
                    <span className="subagent-badge">{modelLabel}</span>
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
                <div className="swarm-roster-card__actions">
                  <span className="swarm-post-card__time">
                    {(member.channels ?? []).map((c) => `#${c.replace(/^#/, '')}`).join(' ')}
                  </span>
                  <button
                    type="button"
                    className="swarm-roster-card__inspect-btn"
                    onClick={() => onInspectWorker(member)}
                  >
                    Inspect @{member.name}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {activeTab === 'graph' && (
        <div className="swarm-board__scroll" data-testid="swarm-activity-graph">
          {graphData.stallPosts.length > 0 && (
            <div className="swarm-graph__stall">
              [stall] flagged on post #{graphData.stallPosts[graphData.stallPosts.length - 1].seq}
            </div>
          )}
          <div className="swarm-graph-card">
            <div className="swarm-post-card__meta">
              <span className="swarm-post-card__author">Orchestration Nodes</span>
              {graphData.batonHolder && (
                <span className="subagent-badge subagent-badge--hierarchy">
                  Baton: {graphData.batonHolder}
                </span>
              )}
            </div>
            <div className="swarm-graph__nodes">
              <div className="swarm-graph__node">
                <span className="swarm-state-dot swarm-state-dot--waiting" />
                <span>Coordinator ({parentModelLabel})</span>
                <span className="subagent-badge">
                  {graphData.postCountByAuthor.get('coordinator') ?? 0} posts
                </span>
              </div>
              {members.map((member) => {
                const stateInfo = memberStateDescription(member);
                return (
                  <div key={member.name} className="swarm-graph__node">
                    <span className={`swarm-state-dot ${stateInfo.dotClass}`} />
                    <span>@{member.name}</span>
                    <span className="subagent-badge">
                      {graphData.postCountByAuthor.get(member.name) ?? 0} posts
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="swarm-graph-card">
            <span className="swarm-post-card__author">Handoffs & @mentions</span>
            <div className="swarm-graph__edges">
              {graphData.edges.length === 0 ? (
                <span className="swarm-post-card__time">
                  No @mention edges recorded yet.
                </span>
              ) : (
                graphData.edges.map((edge, idx) => (
                  <div key={`${edge.seq}-${idx}`} className="swarm-graph__edge">
                    <span>
                      {edge.from} ➔ {edge.to}
                    </span>
                    <span className="subagent-badge">
                      #{edge.channel} · #{edge.seq}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
