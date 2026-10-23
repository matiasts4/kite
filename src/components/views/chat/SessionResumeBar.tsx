import React from 'react';
import {
  NEW_SESSION_MESSAGE,
  RESUME_ACTION_LABEL,
} from '../../../lib/session/recovery';

export interface SessionResumeBarProps {
  /** True only when a provider-issued handle exists. */
  available: boolean;
  onResume?: () => void;
  label?: string;
  newSessionMessage?: string;
}

/**
 * The truthful resume affordance of a recovered thread. Without a provider
 * handle it offers no action and says that the next turn starts a new session.
 */
export const SessionResumeBar: React.FC<SessionResumeBarProps> = ({
  available,
  onResume,
  label = RESUME_ACTION_LABEL,
  newSessionMessage = NEW_SESSION_MESSAGE,
}) => {
  return (
    <div
      className="chat-session-resume"
      data-resume-available={available ? 'true' : 'false'}
    >
      {available ? (
        <button
          type="button"
          className="chat-session-resume__action"
          onClick={onResume}
        >
          {label}
        </button>
      ) : (
        <span className="chat-session-resume__notice">{newSessionMessage}</span>
      )}
    </div>
  );
};
