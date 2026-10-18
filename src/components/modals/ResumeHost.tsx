import React, { useState, useEffect, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import { invokeCommand } from '../../lib/ipc';
import { BrandLogo } from '../ui/BrandLogo';

export interface AgentResumeEntry {
  paneId: string;
  engine: string;
  title?: string;
  workspaceName: string;
}

export interface ResumePromptResponse {
  schemaVersion: number;
  status: 'pending' | 'quiet';
  reason: 'update' | 'restart' | 'quit' | 'endedSessions';
  agents: AgentResumeEntry[];
  total: number;
}

const REASON_COPY: Record<
  ResumePromptResponse['reason'],
  { title: string; body: string }
> = {
  update: {
    title: 'Resume agents after the update?',
    body: 'The update stopped these agents. Each one can reopen its last conversation in the folder it ran in.',
  },
  restart: {
    title: 'Resume agents after the restart?',
    body: 'Kite or your computer restarted, and these agents stopped. Each one can reopen its last conversation in the folder it ran in.',
  },
  quit: {
    title: 'Resume agents?',
    body: 'These agents stopped when you quit. Each one can reopen its last conversation in the folder it ran in.',
  },
  endedSessions: {
    title: 'Resume agents?',
    body: 'You ended these agents when you quit. Each one can reopen its last conversation in the folder it ran in.',
  },
};

export const ResumeHost: React.FC = () => {
  const [prompt, setPrompt] = useState<ResumePromptResponse | null>(null);
  const [alwaysResume, setAlwaysResume] = useState(false);
  const [submitting, setSubmitting] = useState<'resumeAll' | 'startFresh' | null>(null);
  const [error, setError] = useState(false);
  const checkboxId = useId();

  useEffect(() => {
    let mounted = true;
    void invokeCommand<ResumePromptResponse>('resume_prompt_get')
      .then((res) => {
        if (mounted && res && res.status === 'pending') {
          setPrompt(res);
        }
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  const handleAnswer = useCallback(
    async (choice: 'resumeAll' | 'startFresh') => {
      if (submitting) return;
      setSubmitting(choice);
      setError(false);
      try {
        await invokeCommand('resume_prompt_answer', {
          choice,
          alwaysResume,
        });
        setPrompt(null);
      } catch (err) {
        console.error('Failed to answer agent resume prompt:', err);
        setError(true);
        setSubmitting(null);
      }
    },
    [submitting, alwaysResume]
  );

  if (!prompt || prompt.status !== 'pending' || prompt.agents.length === 0) {
    return null;
  }

  const { title, body } = REASON_COPY[prompt.reason] || REASON_COPY.quit;
  const overflow = Math.max(0, prompt.total - prompt.agents.length);

  const modal = (
    <div
      className="modal-backdrop"
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.65)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        className="modal agent-resume-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          width: '520px',
          maxWidth: '92vw',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: 'var(--surface-primary, #1e1e1e)',
          color: 'var(--text-primary, #fff)',
          borderRadius: '12px',
          border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.12))',
          boxShadow: '0 20px 48px rgba(0, 0, 0, 0.5)',
          padding: '24px',
          overflowY: 'auto',
        }}
      >
        <div style={{ marginBottom: '16px' }}>
          <h2
            style={{
              fontSize: '18px',
              fontWeight: 600,
              margin: '0 0 8px 0',
              lineHeight: 1.3,
            }}
          >
            {title}
          </h2>
          <p
            style={{
              fontSize: '13px',
              color: 'var(--text-secondary, #aaa)',
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            {body}
          </p>
        </div>

        <ul
          className="agent-resume-list"
          aria-label="Agents to resume"
          style={{
            listStyle: 'none',
            margin: '0 0 16px 0',
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            maxHeight: '260px',
            overflowY: 'auto',
          }}
        >
          {prompt.agents.map((agent) => (
            <li
              key={agent.paneId}
              className="agent-resume-list__row"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '10px 12px',
                borderRadius: '8px',
                backgroundColor: 'var(--surface-secondary, rgba(255, 255, 255, 0.05))',
                border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
              }}
            >
              <BrandLogo engine={agent.engine} size={18} />
              <div
                className="agent-resume-list__text"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '2px',
                  minWidth: 0,
                  flex: 1,
                }}
              >
                <span
                  className="agent-resume-list__title"
                  style={{
                    fontSize: '13px',
                    fontWeight: 500,
                    color: 'var(--text-primary, #fff)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {agent.title || agent.engine}
                </span>
                <span
                  className="agent-resume-list__meta"
                  style={{
                    fontSize: '11.5px',
                    color: 'var(--text-secondary, #888)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {agent.title
                    ? `${agent.engine} · ${agent.workspaceName}`
                    : agent.workspaceName}
                </span>
              </div>
            </li>
          ))}
          {overflow > 0 && (
            <li
              className="agent-resume-list__row agent-resume-list__meta"
              style={{
                fontSize: '12px',
                color: 'var(--text-secondary, #888)',
                padding: '6px 12px',
              }}
            >
              {overflow === 1 ? 'and 1 more agent' : `and ${overflow} more agents`}
            </li>
          )}
        </ul>

        <p
          className="agent-resume-sheet__note"
          style={{
            fontSize: '12px',
            color: 'var(--text-tertiary, #777)',
            margin: '0 0 16px 0',
            lineHeight: 1.4,
          }}
        >
          Start fresh opens new conversations and keeps these under Resume
          Previous Conversation in each pane's menu.
        </p>

        <div
          className="agent-resume-sheet__always"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 0',
            borderTop: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
            marginBottom: '20px',
          }}
        >
          <label
            htmlFor={checkboxId}
            style={{
              fontSize: '13px',
              color: 'var(--text-primary, #ddd)',
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            Always resume automatically
          </label>
          <input
            id={checkboxId}
            type="checkbox"
            checked={alwaysResume}
            disabled={submitting !== null}
            onChange={(e) => setAlwaysResume(e.target.checked)}
            style={{
              width: '16px',
              height: '16px',
              cursor: 'pointer',
              accentColor: 'var(--accent, #3b82f6)',
            }}
          />
        </div>

        {error && (
          <p
            className="agent-resume-sheet__error"
            role="alert"
            style={{
              fontSize: '12px',
              color: 'var(--error, #f87171)',
              margin: '0 0 12px 0',
            }}
          >
            Couldn't save your answer. Try again.
          </p>
        )}

        <div
          className="agent-resume-sheet__actions"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: '10px',
          }}
        >
          <button
            type="button"
            className="secondary-button"
            disabled={submitting !== null}
            onClick={() => handleAnswer('startFresh')}
            style={{
              padding: '8px 16px',
              fontSize: '13px',
              borderRadius: '6px',
              cursor: submitting !== null ? 'not-allowed' : 'pointer',
            }}
          >
            Start fresh
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={submitting === 'startFresh'}
            onClick={() => handleAnswer('resumeAll')}
            style={{
              padding: '8px 16px',
              fontSize: '13px',
              fontWeight: 500,
              borderRadius: '6px',
              cursor: submitting === 'startFresh' ? 'not-allowed' : 'pointer',
            }}
          >
            {submitting === 'resumeAll' ? 'Resuming…' : 'Resume all'}
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined'
    ? createPortal(modal, document.body)
    : null;
};
