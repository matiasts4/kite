import { useEffect, useState } from 'react';
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
      <i className="chat-working-pulse" aria-hidden="true" />
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

export function TurnActivityStatus({
  running,
  pendingApproval,
  items,
  interrupted = false,
  durationSeconds = null,
}: {
  running: boolean;
  pendingApproval?: TurnApproval | null;
  items: ActivityItem[];
  interrupted?: boolean;
  durationSeconds?: number | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || pendingApproval) return;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [running, pendingApproval]);

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
        <WorkingStatus line={workingLine(turnStartUnixMs(items), now)} stage={liveStageLabel(items)} />
      </p>
    </div>
  );
}
