import React from 'react';
import { ArrowUpIcon, StopIcon } from '../ChatIcons';
import {
  resolvePrimaryAction,
  useDefaultFollowUp,
} from '../composerPrimaryAction';
import { composerGoalStop } from '../threadInteraction';
import type { ChatProvider } from '../types';

export interface ComposerPrimaryActionButtonProps {
  running: boolean;
  prompt: string;
  attachmentsCount: number;
  paused: boolean;
  threadProvider: ChatProvider;
  followUpFlip: boolean;
  canSend: boolean;
  agentName?: string;
  goal?: string | null;
  onGoalStop?: (result: { goal: string | null; paused: boolean; turnEnded: boolean }) => void;
  onStop: () => void;
  onSend: () => void;
  deliverDraft: (mode: 'send' | 'queue' | 'steer') => void;
  hasQueueHandler: boolean;
  hasSteerHandler?: boolean;
  editingQueued?: boolean;
}

export const ComposerPrimaryActionButton: React.FC<ComposerPrimaryActionButtonProps> = ({
  running,
  prompt,
  attachmentsCount,
  paused,
  threadProvider,
  followUpFlip,
  canSend,
  agentName,
  goal,
  onGoalStop,
  onStop,
  onSend,
  deliverDraft,
  hasQueueHandler,
  hasSteerHandler = false,
  editingQueued = false,
}) => {
  const defaultFollowUp = useDefaultFollowUp();

  if (editingQueued && hasQueueHandler) {
    return (
      <button
        type="button"
        aria-label="Save"
        title="Save queued message (Enter) · Cancel (Escape)"
        disabled={!canSend}
        onClick={() => {
          if (canSend) deliverDraft('queue');
        }}
        className="kite-composer-action-btn kite-composer-action-btn--send"
      >
        <ArrowUpIcon size={16} />
      </button>
    );
  }
  const action = resolvePrimaryAction({
    running,
    draftEmpty: prompt.trim().length === 0 && attachmentsCount === 0,
    paused,
    steerSupported: hasSteerHandler,
    defaultFollowUp,
    flip: followUpFlip,
  });

  if (action === 'interrupt') {
    return (
      <button
        type="button"
        aria-label="Interrupt"
        title="Interrupt"
        onClick={() => {
          const stopped = composerGoalStop(threadProvider, goal ?? null);
          onGoalStop?.(stopped);
          onStop();
        }}
        className="kite-composer-action-btn kite-composer-action-btn--stop"
      >
        <StopIcon size={11} className="fill-current" />
      </button>
    );
  }

  const label =
    action === 'queue'
      ? 'Queue'
      : action === 'steer'
      ? 'Steer'
      : action === 'resume'
      ? 'Resume'
      : 'Send message';

  return (
    <button
      type="button"
      aria-label={label}
      title="Send prompt (Enter) · New line (Shift+Enter) · Earlier prompts (↑)"
      disabled={(action === 'send' || action === 'queue' || action === 'steer') && !canSend}
      data-testid={agentName ? 'agent-chat-send' : undefined}
      onClick={() => {
        if (action === 'resume') {
          onSend();
          return;
        }
        if (!canSend) return;
        if (action === 'steer' && (hasSteerHandler || hasQueueHandler)) {
          deliverDraft('steer');
          return;
        }
        if (action === 'queue' && hasQueueHandler) {
          deliverDraft('queue');
          return;
        }
        deliverDraft('send');
      }}
      className="kite-composer-action-btn kite-composer-action-btn--send"
    >
      <ArrowUpIcon size={16} />
    </button>
  );
};
