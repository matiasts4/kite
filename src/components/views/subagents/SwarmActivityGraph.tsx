import React from 'react';
import type { SwarmMember } from '../../../types';
import { memberStateDescription, type SwarmGraphData } from './swarmBoardHelpers';

interface SwarmActivityGraphProps {
  members: SwarmMember[];
  parentModelLabel: string;
  graphData: SwarmGraphData;
}

export const SwarmActivityGraph: React.FC<SwarmActivityGraphProps> = ({
  members,
  parentModelLabel,
  graphData,
}) => (
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
);
