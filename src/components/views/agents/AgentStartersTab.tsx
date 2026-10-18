import React, { useMemo } from 'react';
import { AgentMindSnapshot, StarterSummary } from './types';

export interface OfficialStarterItem extends StarterSummary {
  description: string;
}

// Inline SVG Icons (Zero external icon dependencies, Zero emojis)

// Inline SVG Icons (Zero external icon dependencies, Zero emojis)

const IconBookmark: React.FC = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
  </svg>
);

const IconWand: React.FC = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="m15 4-2 2" />
    <path d="m15 9-2-2" />
    <path d="m4 20 10-10" />
    <path d="m9 5 7 7" />
    <path d="M19 9l2-2" />
    <path d="M21 5l-2 2" />
  </svg>
);

const IconSearch: React.FC = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const IconFileDraft: React.FC = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
  </svg>
);

const IconRootCause: React.FC = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="12" cy="12" r="10" />
    <line x1="22" y1="12" x2="18" y2="12" />
    <line x1="6" y1="12" x2="2" y2="12" />
    <line x1="12" y1="6" x2="12" y2="2" />
    <line x1="12" y1="22" x2="12" y2="18" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const IconSparkles: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" />
  </svg>
);

const IconCheck: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const IconPlus: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const IconSpinner: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    style={{ animation: 'starter-spin 0.85s linear infinite' }}
    aria-hidden="true"
    focusable="false"
  >
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

function getStarterGlyph(id: string): React.ReactNode {
  switch (id) {
    case 'keep-a-memory':
      return <IconBookmark />;
    case 'write-a-skill':
      return <IconWand />;
    case 'research-a-question':
      return <IconSearch />;
    case 'draft-for-a-reader':
      return <IconFileDraft />;
    case 'root-cause':
      return <IconRootCause />;
    default:
      return <IconSparkles size={16} />;
  }
}

interface AgentStartersTabProps {
  agentName: string;
  mind: AgentMindSnapshot | null;
  starters: StarterSummary[];
  installingStarterId: string | null;
  onInstallStarter: (starterId: string) => Promise<void>;
}

export const AgentStartersTab: React.FC<AgentStartersTabProps> = ({
  agentName,
  mind,
  starters,
  installingStarterId,
  onInstallStarter,
}) => {
  // Use starters directly from backend command without synthetic fallback
  const catalog = useMemo<OfficialStarterItem[]>(() => {
    if (!starters || starters.length === 0) {
      return [];
    }
    return starters.map((s) => ({
      id: s.id,
      title: s.title,
      summary: s.summary,
      description: s.summary,
    }));
  }, [starters]);

  const installedCount = useMemo(() => {
    if (!mind?.skills) return 0;
    return catalog.filter((starter) => mind.skills.some((s) => s.id === starter.id)).length;
  }, [catalog, mind?.skills]);

  return (
    <div className="agent-face agent-starters">
      <style>{`
        @keyframes starter-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>

      <div className="agent-mind-column">
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' }}>
          <p className="agent-mind-lede">
            Starter patterns provide reference blueprints for {agentName} to pattern-match against during execution. Installing a starter creates an editable local skill file for this agent.
          </p>
          {catalog.length > 0 && installedCount > 0 && (
            <span
              style={{
                fontSize: 'var(--text-caption, 11px)',
                color: 'var(--text-secondary, #8b949e)',
                whiteSpace: 'nowrap',
                fontWeight: 500,
              }}
            >
              {installedCount} of {catalog.length} installed
            </span>
          )}
        </div>

        {catalog.length === 0 ? (
          <div className="agent-starters__empty" style={{ padding: '48px 24px', textAlign: 'center' }}>
            <h2 style={{ fontSize: 'var(--text-body, 14px)', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
              No starters available
            </h2>
            <p style={{ color: 'var(--text-secondary, #8b949e)', fontSize: '13px', marginTop: '6px' }}>
              Starter templates configured in the workspace will appear here.
            </p>
          </div>
        ) : (
          <div className="agent-starters__grid">
          {catalog.map((starter) => {
            const isInstalled = Boolean(mind?.skills?.some((s) => s.id === starter.id));
            const isInstalling = installingStarterId === starter.id;

            return (
              <div
                key={starter.id}
                className="agent-starter-card"
                data-starter-id={starter.id}
              >
                <div className="agent-starter-card__header">
                  <div
                    className="agent-starter-card__title-row"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      minWidth: 0,
                    }}
                  >
                    <span
                      className="agent-starter-card__icon"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '26px',
                        height: '26px',
                        borderRadius: 'var(--radius-row, 6px)',
                        background: 'var(--chip-fill, rgba(255, 255, 255, 0.05))',
                        color: 'var(--text-secondary, #8b949e)',
                        flexShrink: 0,
                      }}
                      aria-hidden="true"
                    >
                      {getStarterGlyph(starter.id)}
                    </span>
                    <h3 className="agent-starter-card__title">{starter.title}</h3>
                  </div>

                  <span
                    className={`agent-starter-card__badge ${
                      isInstalled
                        ? 'agent-starter-card__badge--installed'
                        : 'agent-starter-card__badge--available'
                    }`}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      flexShrink: 0,
                    }}
                  >
                    {isInstalled ? (
                      <>
                        <IconCheck size={10} />
                        <span>Installed</span>
                      </>
                    ) : (
                      <span>Available</span>
                    )}
                  </span>
                </div>

                <p className="agent-starter-card__summary">{starter.summary}</p>

                {starter.description && (
                  <p
                    className="agent-starter-card__description"
                    style={{
                      margin: '0',
                      fontSize: 'var(--text-caption, 11px)',
                      lineHeight: '1.4',
                      color: 'var(--text-faint, #6e7681)',
                    }}
                  >
                    <strong style={{ fontWeight: 600, color: 'var(--text-secondary, #8b949e)' }}>
                      Fires when:{' '}
                    </strong>
                    {starter.description}
                  </p>
                )}

                <button
                  type="button"
                  className={isInstalled ? 'secondary-button action-button--row' : 'primary-button action-button--row'}
                  disabled={isInstalled || isInstalling}
                  onClick={() => void onInstallStarter(starter.id)}
                  title={
                    isInstalled
                      ? `Skill "${starter.title}" is already installed for ${agentName}`
                      : `Give ${agentName} its own copy of "${starter.title}"`
                  }
                  aria-label={
                    isInstalled
                      ? `${starter.title} is already installed`
                      : `Install ${starter.title} as a skill for ${agentName}`
                  }
                  style={{
                    marginTop: 'auto',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '6px',
                  }}
                >
                  {isInstalling ? (
                    <>
                      <IconSpinner size={12} />
                      <span>Installing skill…</span>
                    </>
                  ) : isInstalled ? (
                    <>
                      <IconCheck size={12} />
                      <span>Installed as skill</span>
                    </>
                  ) : (
                    <>
                      <IconPlus size={12} />
                      <span>Install starter</span>
                    </>
                  )}
                </button>
              </div>
            );
          })}
        </div>
        )}
      </div>
    </div>
  );
};
