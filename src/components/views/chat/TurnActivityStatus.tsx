import { useEffect, useState } from 'react';
import { ActivityGlyph } from './activityGlyph';
import {
  approvalWaitLabel,
  interruptedTurnLine,
  showThinkingPlaceholder,
  turnStartUnixMs,
  workingLine,
  type ActivityItem,
} from './activityPresentation';

export interface TurnApproval {
  title?: string | null;
  toolName?: string | null;
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

  const showBrain = showThinkingPlaceholder(items, false);
  return (
    <div className="chat-turn-activity" role="status">
      <p className="chat-turn-activity__working">{workingLine(turnStartUnixMs(items), now)}</p>
      {showBrain ? (
        <div className="chat-turn-activity__thinking">
          <span aria-hidden="true" className="chat-work-entry__glyph">
            <ActivityGlyph item={{ kind: 'reasoning' }} size={16} />
          </span>
          <span className="chat-activity-shine">Thinking</span>
        </div>
      ) : null}
    </div>
  );
}
