import React from 'react';
import type { ChatItem } from '../../../types';
import {
  recoveryProjection,
  resumeAffordance,
  type RecoveredThreadPayload,
} from '../../../lib/session/recovery';
import { SessionLifecycleBar } from './SessionLifecycleBar';
import { SessionResumeBar } from './SessionResumeBar';

export interface RecoveredThreadViewProps {
  recovered: RecoveredThreadPayload;
  onResume?: () => void;
}

function itemText(item: ChatItem): string {
  if (item.kind === 'tool') {
    return item.title ?? item.toolName ?? item.command ?? item.text;
  }
  return item.text;
}

/**
 * A read-only second view of one recovered thread.
 *
 * It renders from the recovered payload alone: the projection is a pure fold,
 * every item is already durable data, and no provider process or clock is
 * consulted. Two views of the same payload therefore produce the same markup.
 */
export const RecoveredThreadView: React.FC<RecoveredThreadViewProps> = ({
  recovered,
  onResume,
}) => {
  const projection = recoveryProjection(recovered);
  const resume = resumeAffordance(recovered);

  return (
    <section
      className="chat-recovered-thread"
      data-thread-id={recovered.thread.id}
      data-recovery-source={recovered.source}
    >
      <header className="chat-recovered-thread__header">
        <h2 className="chat-recovered-thread__title">{recovered.thread.title}</h2>
        {recovered.thread.provider && (
          <span className="chat-recovered-thread__provider">{recovered.thread.provider}</span>
        )}
      </header>
      <SessionLifecycleBar projection={projection} />
      <SessionResumeBar available={resume.available} onResume={onResume} />
      {recovered.diagnostic && (
        <p
          className="chat-recovered-thread__diagnostic"
          data-recovery-diagnostic="true"
          role="note"
        >
          {recovered.diagnostic}
        </p>
      )}
      <ol className="chat-recovered-thread__transcript" data-recovered-transcript="true">
        {projection.items.map((item) => (
          <li
            key={item.id}
            className="chat-recovered-thread__item"
            data-item-id={item.id}
            data-item-kind={item.kind}
          >
            {item.kind === 'tool' && item.title && (
              <span className="chat-recovered-thread__item-title">{item.title}</span>
            )}
            <p className="chat-recovered-thread__item-text">{itemText(item)}</p>
            {item.kind === 'tool' && item.status && (
              <span className="chat-recovered-thread__item-status">{item.status}</span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
};
