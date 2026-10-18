import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { invokeCommand } from '../../lib/ipc';
import { BrandLogo } from '../ui/BrandLogo';

export interface AgentPaneResumeModalProps {
  isOpen: boolean;
  workspaceId: string;
  paneId: string;
  engine: string;
  title?: string;
  onClose: () => void;
  onResumeSelected: (key: string) => void;
  onStartFresh: () => void;
}

interface StoredConversation {
  key: string;
  startedAtUnixMs?: number;
  archivedAtUnixMs: number;
}

function formatDate(ms?: number): string {
  if (!ms) return 'Unknown date';
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const AgentPaneResumeModal: React.FC<AgentPaneResumeModalProps> = ({
  isOpen,
  workspaceId,
  paneId,
  engine,
  title,
  onClose,
  onResumeSelected,
  onStartFresh,
}) => {
  const [conversations, setConversations] = useState<StoredConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    let mounted = true;
    void invokeCommand<{ conversations?: StoredConversation[] }>('agent_pane_history', {
      workspaceId,
      paneId,
      engine,
    })
      .then((res) => {
        if (mounted) {
          setConversations(res?.conversations || []);
          setLoading(false);
        }
      })
      .catch(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [isOpen, workspaceId, paneId, engine]);

  const handleResume = useCallback(
    async (key: string) => {
      setBusyKey(key);
      try {
        await invokeCommand('agent_pane_resume_choice', {
          workspaceId,
          paneId,
          engine,
          choice: { kind: 'previous', key },
        });
        onResumeSelected(key);
        onClose();
      } catch (err) {
        console.error('Failed to resume previous conversation:', err);
      } finally {
        setBusyKey(null);
      }
    },
    [workspaceId, paneId, engine, onResumeSelected, onClose]
  );

  const handleFresh = useCallback(async () => {
    setBusyKey('fresh');
    try {
      await invokeCommand('agent_pane_resume_choice', {
        workspaceId,
        paneId,
        engine,
        choice: { kind: 'fresh' },
      });
      onStartFresh();
      onClose();
    } catch (err) {
      console.error('Failed to start fresh conversation:', err);
    } finally {
      setBusyKey(null);
    }
  }, [workspaceId, paneId, engine, onStartFresh, onClose]);

  if (!isOpen) return null;

  const modal = (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={onClose}
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
        aria-label="Resume previous conversation"
        onClick={(e) => e.stopPropagation()}
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
            Resume previous conversation
          </h2>
          <p
            style={{
              fontSize: '13px',
              color: 'var(--text-secondary, #aaa)',
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            Up to 8 set-aside conversations for this pane are kept so you can jump back in.
          </p>
        </div>

        {loading ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: '#888', fontSize: '13px' }}>
            Loading conversations…
          </div>
        ) : conversations.length === 0 ? (
          <div
            style={{
              padding: '28px 16px',
              textAlign: 'center',
              color: 'var(--text-secondary, #888)',
              fontSize: '13px',
              backgroundColor: 'var(--surface-secondary, rgba(255, 255, 255, 0.03))',
              borderRadius: '8px',
              border: '1px dashed var(--border-subtle, rgba(255, 255, 255, 0.1))',
              marginBottom: '16px',
            }}
          >
            No previous conversations set aside for this pane yet.
          </div>
        ) : (
          <ul
            className="agent-resume-list"
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
            {conversations.map((conv) => (
              <li
                key={conv.key}
                className="agent-resume-list__row"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  backgroundColor: 'var(--surface-secondary, rgba(255, 255, 255, 0.05))',
                  border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                  <BrandLogo engine={engine} size={18} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                    <span
                      style={{
                        fontSize: '13px',
                        fontWeight: 500,
                        color: 'var(--text-primary, #fff)',
                      }}
                    >
                      {title || engine}
                    </span>
                    <span
                      style={{
                        fontSize: '11.5px',
                        color: 'var(--text-secondary, #888)',
                      }}
                    >
                      Started {formatDate(conv.startedAtUnixMs)} · Set aside {formatDate(conv.archivedAtUnixMs)}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busyKey !== null}
                  onClick={() => handleResume(conv.key)}
                  style={{
                    padding: '6px 14px',
                    fontSize: '12px',
                    borderRadius: '6px',
                    cursor: busyKey !== null ? 'not-allowed' : 'pointer',
                  }}
                >
                  {busyKey === conv.key ? 'Resuming…' : 'Resume'}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: '8px',
            borderTop: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
            paddingTop: '16px',
          }}
        >
          <button
            type="button"
            className="secondary-button"
            disabled={busyKey !== null}
            onClick={handleFresh}
            style={{
              padding: '8px 14px',
              fontSize: '13px',
              borderRadius: '6px',
              cursor: busyKey !== null ? 'not-allowed' : 'pointer',
            }}
          >
            Start fresh
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            style={{
              padding: '8px 16px',
              fontSize: '13px',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modal, document.body) : null;
};
