import { memo, useEffect, useMemo, useState } from 'react';
import { AgentStatusIndicator } from '../../ui/AgentStatusIndicator';
import {
  approvalWaitLabel,
  interruptedTurnLine,
  liveStageLabel,
  turnStartUnixMs,
  workingLine,
  type ActivityItem,
} from './activityPresentation';

export interface TurnApproval {
  title?: string | null;
  toolName?: string | null;
}

export function WorkingStatus({ line, stage = null }: { line: string; stage?: string | null }) {
  const splitAt = line.indexOf(' · ');
  const word = splitAt === -1 ? line : line.slice(0, splitAt);
  const clock = splitAt === -1 ? null : line.slice(splitAt + 3);
  return (
    <span className="chat-working-caption">
      <AgentStatusIndicator status="running" size={13} className="chat-working-indicator" />
      <span className="chat-working-live">{word}</span>
      {clock ? <span className="chat-working-caption__clock"> · {clock}</span> : null}
      {stage ? (
        <span key={stage} className="chat-working-caption__stage" title={stage}>
          {stage}
        </span>
      ) : null}
    </span>
  );
}

export const TURN_ACTIVITY_CLOCK_INTERVAL_MS = 1000;

export const TurnActivityStatus = memo(function TurnActivityStatus({
  running,
  pendingApproval,
  items,
  swarmState = null,
  interrupted = false,
  durationSeconds = null,
}: {
  running: boolean;
  pendingApproval?: TurnApproval | null;
  items: ActivityItem[];
  swarmState?: import('./activityPresentation').ActivitySwarmSummary | null;
  interrupted?: boolean;
  durationSeconds?: number | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || pendingApproval) return;
    const timer = window.setInterval(() => setNow(Date.now()), TURN_ACTIVITY_CLOCK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [running, pendingApproval]);

  const startUnixMs = useMemo(() => turnStartUnixMs(items), [items]);
  const stage = useMemo(() => liveStageLabel(items, swarmState), [items, swarmState]);

  if (pendingApproval) {
    return (
      <div className="chat-working-row chat-working-row--waiting" role="status">
        <span className="chat-working-row__stage">
          {approvalWaitLabel(pendingApproval.title, pendingApproval.toolName)}
        </span>
      </div>
    );
  }

  if (interrupted && !running) {
    return (
      <div className="chat-working-row" role="status">
        <span className="chat-working-row__stage">{interruptedTurnLine(durationSeconds)}</span>
      </div>
    );
  }

  if (!running) return null;

  return (
    <div className="chat-turn-activity" role="status">
      <p className="chat-turn-activity__working">
        <WorkingStatus
          line={workingLine(startUnixMs, now)}
          stage={stage}
        />
      </p>
    </div>
  );
});
