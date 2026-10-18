import React, { useState, useEffect, useRef, useMemo } from 'react';
import { invokeCommand } from '../../../lib/ipc';
import {
  AgentMindSnapshot,
  LearnedSkillDocument,
  StarterSummary,
  formatRelativeAge,
} from './types';

// Clean inline SVG icons matching bundle geometry
const FileTextSvg: React.FC<{ size?: number; className?: string }> = ({ size = 14, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
    <polyline points="10 9 9 9 8 9" />
  </svg>
);

const WandSparklesSvg: React.FC<{ size?: number; className?: string }> = ({ size = 24, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.21 1.21 0 0 0 1.72 0L21.64 5.36a1.21 1.21 0 0 0 0-1.72Z" />
    <path d="m14 7 3 3" />
    <path d="M5 6v4" />
    <path d="M19 14v4" />
    <path d="M10 2v2" />
    <path d="M7 8H3" />
    <path d="M21 16h-4" />
    <path d="M11 3H9" />
  </svg>
);

const Trash2Svg: React.FC<{ size?: number; className?: string }> = ({ size = 13, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </svg>
);

const ChevronLeftSvg: React.FC<{ size?: number; className?: string }> = ({ size = 11, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

const ChevronDownSvg: React.FC<{ size?: number; className?: string }> = ({ size = 10, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

const PlusSvg: React.FC<{ size?: number; className?: string }> = ({ size = 12, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const CircleAlertSvg: React.FC<{ size?: number; className?: string }> = ({ size = 16, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
);

const SpinnerSvg: React.FC<{ size?: number; className?: string }> = ({ size = 16, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

// Strips YAML frontmatter (---\n...\n---) for reader presentation
function stripFrontmatter(source: string): string {
  const lines = source.split('\n');
  if (lines[0]?.trim() !== '---') return source;
  const endIdx = lines.findIndex((line, idx) => idx > 0 && line.trim() === '---');
  return endIdx < 0
    ? source
    : lines.slice(endIdx + 1).join('\n').replace(/^[\n\r]+|[\n\r]+$/gu, '');
}

// Formats timestamp for display
function formatTimestamp(timestampMs: number): string {
  if (timestampMs <= 0) return 'Just updated';
  const date = new Date(timestampMs);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date)
    : 'Updated recently';
}

// Checks if a skill or the skills folder has safety or read issues
function hasSkillReadIssue(mind: AgentMindSnapshot | null, skillId: string): boolean {
  if (!mind?.readIssues) return false;
  return mind.readIssues.some(
    (issue) =>
      issue.code === 'skillsUnreadable' ||
      (issue.skillId === skillId &&
        ['skillUnreadable', 'skillInvalid', 'skillPathRejected', 'skillCaseNonCanonical'].includes(issue.code))
  );
}

// Render formatted markdown safely without external HTML injections using authentic chat-markdown styles
function renderProcedureMarkdown(source: string): React.ReactNode {
  if (!source || source.trim().length === 0) {
    return <p className="chat-markdown__plain">No procedure body defined.</p>;
  }

  const sections = source.split(/\n\n+/);
  return (
    <div className="chat-markdown">
      {sections.map((section, sIdx) => {
        const trimmed = section.trim();
        if (!trimmed) return null;

        // Code block
        if (trimmed.startsWith('```') && trimmed.endsWith('```')) {
          const lines = trimmed.slice(3, -3).trim().split('\n');
          const lang = lines[0].trim().match(/^[a-z0-9_-]+/i) ? lines[0].trim() : '';
          const code = (lang ? lines.slice(1) : lines).join('\n');
          return (
            <div key={sIdx} className="chat-code-block">
              {lang && (
                <div className="chat-code-block__bar">
                  <span className="chat-code-block__lang">{lang}</span>
                </div>
              )}
              <pre data-language={lang || undefined}>
                <code>{code}</code>
              </pre>
            </div>
          );
        }

        // Headings (in chat-markdown h2 is title, h3 is heading, h4 is body)
        if (trimmed.startsWith('### ')) {
          return <h4 key={sIdx}>{trimmed.slice(4)}</h4>;
        }
        if (trimmed.startsWith('## ')) {
          return <h3 key={sIdx}>{trimmed.slice(3)}</h3>;
        }
        if (trimmed.startsWith('# ')) {
          return <h2 key={sIdx}>{trimmed.slice(2)}</h2>;
        }

        // Bullet lists
        const lines = trimmed.split('\n');
        if (lines.every((line) => line.trim().startsWith('- ') || line.trim().startsWith('* '))) {
          return (
            <ul key={sIdx} role="list">
              {lines.map((line, lIdx) => (
                <li key={lIdx} className="chat-markdown__list-item">
                  <span className="chat-markdown__item-text">{line.trim().replace(/^[-*]\s+/, '')}</span>
                </li>
              ))}
            </ul>
          );
        }

        // Standard paragraph
        return <p key={sIdx}>{trimmed}</p>;
      })}
    </div>
  );
}

export interface AgentSkillsTabProps {
  agentName: string;
  mind: AgentMindSnapshot | null;
  selectedSkillId: string | null;
  skillDocument: LearnedSkillDocument | null;
  skillLoading: boolean;
  skillSaving: boolean;
  onSelectSkill: (skillId: string) => Promise<void>;
  onSaveSkill: (source: string) => Promise<void>;
  onDeleteSkill: () => Promise<void>;
  onClearSelectedSkill: () => void;
  onNavigateToStarters?: () => void;
  starters?: StarterSummary[];
  onInstallStarter?: (starterId: string) => Promise<void>;
  readOnly?: boolean;
}

export const AgentSkillsTab: React.FC<AgentSkillsTabProps> = ({
  agentName,
  mind,
  selectedSkillId,
  skillDocument,
  skillLoading,
  skillSaving,
  onSelectSkill,
  onSaveSkill,
  onDeleteSkill,
  onClearSelectedSkill,
  starters: startersProp,
  onInstallStarter: onInstallStarterProp,
  readOnly = false,
}) => {
  const [isEditingSkill, setIsEditingSkill] = useState<boolean>(false);
  const [skillSourceDraft, setSkillSourceDraft] = useState<string>('');
  const [isConfirmingDeleteSkill, setIsConfirmingDeleteSkill] = useState<boolean>(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // Starters state
  const [startersList, setStartersList] = useState<StarterSummary[]>(startersProp || []);
  const [startersLoading, setStartersLoading] = useState<boolean>(false);
  const [isStarterMenuOpen, setIsStarterMenuOpen] = useState<boolean>(false);
  const [installingStarterId, setInstallingStarterId] = useState<string | null>(null);

  const starterMenuRef = useRef<HTMLDivElement>(null);
  const starterButtonRef = useRef<HTMLButtonElement>(null);

  // Load starter skills if not passed via props
  useEffect(() => {
    if (startersProp && startersProp.length > 0) {
      setStartersList(startersProp);
      return;
    }

    let isMounted = true;
    setStartersLoading(true);
    invokeCommand<StarterSummary[]>('list_agent_starters', { supportedCatalogVersion: 1 })
      .then((items) => {
        if (isMounted && Array.isArray(items)) {
          setStartersList(items);
        }
      })
      .catch((err) => {
        console.warn('[AgentSkillsTab] Could not load starters catalog:', err);
      })
      .finally(() => {
        if (isMounted) {
          setStartersLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [startersProp]);

  // Close starter dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        starterMenuRef.current &&
        !starterMenuRef.current.contains(event.target as Node) &&
        starterButtonRef.current &&
        !starterButtonRef.current.contains(event.target as Node)
      ) {
        setIsStarterMenuOpen(false);
      }
    }

    if (isStarterMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isStarterMenuOpen]);

  // Reset local state when selected skill or agent changes
  useEffect(() => {
    setIsEditingSkill(false);
    setIsConfirmingDeleteSkill(false);
    setLocalError(null);
  }, [selectedSkillId, mind?.agentId]);

  // Filter starters that are not already installed
  const availableStarters = useMemo(() => {
    const installedIds = new Set(mind?.skills?.map((s) => s.id) || []);
    return startersList.filter((s) => !installedIds.has(s.id));
  }, [mind?.skills, startersList]);

  // Read issue flags
  const hasSkillsFolderIssue = mind?.readIssues?.some((issue) => issue.code === 'skillsUnreadable') ?? false;
  const isSkillsTruncated = mind?.readIssues?.some((issue) => issue.code === 'skillsTruncated') ?? false;
  const selectedSkillHasIssue = selectedSkillId ? hasSkillReadIssue(mind, selectedSkillId) : false;
  const isOperationLocked = readOnly || hasSkillsFolderIssue || selectedSkillHasIssue;

  // Selected skill reference
  const activeSkillSummary = mind?.skills?.find((s) => s.id === selectedSkillId) ?? null;

  const handleEditClick = () => {
    if (skillDocument && !isOperationLocked) {
      setSkillSourceDraft(skillDocument.source);
      setIsEditingSkill(true);
      setLocalError(null);
    }
  };

  const handleSave = async () => {
    if (isOperationLocked || !skillDocument) return;

    if (skillDocument.source.length > 0 && skillSourceDraft.trim().length === 0) {
      setLocalError('An empty draft cannot replace a non-empty skill. Re-open it before saving.');
      return;
    }

    const byteLength = new TextEncoder().encode(skillSourceDraft).length;
    if (byteLength > 1048576) {
      setLocalError('This skill is too large for the bounded agent-data file.');
      return;
    }

    setLocalError(null);
    try {
      await onSaveSkill(skillSourceDraft);
      setIsEditingSkill(false);
    } catch (err: unknown) {
      console.error('[AgentSkillsTab] Failed to save skill:', err);
      setLocalError(err instanceof Error ? err.message : 'Failed to save skill');
    }
  };

  const handleDelete = async () => {
    if (isOperationLocked || !skillDocument) return;

    setLocalError(null);
    try {
      await onDeleteSkill();
      setIsConfirmingDeleteSkill(false);
      setIsEditingSkill(false);
      onClearSelectedSkill();
    } catch (err: unknown) {
      console.error('[AgentSkillsTab] Failed to delete skill:', err);
      setLocalError(err instanceof Error ? err.message : 'Failed to delete skill');
    }
  };

  const handleInstallStarter = async (starterId: string) => {
    setInstallingStarterId(starterId);
    setLocalError(null);
    try {
      if (onInstallStarterProp) {
        await onInstallStarterProp(starterId);
      } else if (mind?.agentId) {
        await invokeCommand<{ installed: boolean; mind: AgentMindSnapshot }>('install_agent_starter', {
          agentId: mind.agentId,
          starterId,
          confirmedByBuilder: true,
        });
      }
      setIsStarterMenuOpen(false);
    } catch (err: unknown) {
      console.error('[AgentSkillsTab] Failed to install starter:', err);
      setLocalError(err instanceof Error ? err.message : 'Failed to install starter skill');
    } finally {
      setInstallingStarterId(null);
    }
  };

  // Starter menu and button component
  const hasAvailableStarters = availableStarters.length > 0 || startersLoading;

  const renderStarterControl = (ariaLabel?: string) => (
    <div className="agent-skills__starter-control">
      <button
        ref={starterButtonRef}
        type="button"
        aria-expanded={isStarterMenuOpen}
        aria-haspopup="menu"
        aria-label={ariaLabel}
        className="secondary-button action-button--row agent-skills__starter-trigger"
        disabled={readOnly || startersLoading || installingStarterId !== null || hasSkillsFolderIssue}
        onClick={() => setIsStarterMenuOpen((prev) => !prev)}
        title={`Give ${agentName} its own copy of a starter skill`}
      >
        <span aria-hidden="true" className="action-button__icon">
          {installingStarterId !== null ? <SpinnerSvg size={12} /> : <PlusSvg size={11} />}
        </span>
        {startersLoading ? 'Loading starters…' : 'Add starter'}
        <ChevronDownSvg size={10} />
      </button>

      {isStarterMenuOpen && (
        <div
          ref={starterMenuRef}
          className="ui-menu ui-menu--plain agent-skills__starter-menu"
          role="menu"
          aria-label="Starter skills"
        >
          {availableStarters.map((starter) => (
            <button
              key={starter.id}
              type="button"
              role="menuitem"
              className="ui-menu__row"
              disabled={installingStarterId === starter.id}
              onClick={() => void handleInstallStarter(starter.id)}
            >
              <span className="ui-menu__row-title">{starter.title || (starter as any).name}</span>
              <span className="ui-menu__row-detail">{starter.summary || (starter as any).description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  if (selectedSkillId && activeSkillSummary) {
    return (
      <div className="agent-face agent-skills agent-skills--detail">
        <header className="agent-skills__toolbar">
          <button
            type="button"
            className="agent-skills__back"
            onClick={() => {
              setIsEditingSkill(false);
              setIsConfirmingDeleteSkill(false);
              setLocalError(null);
              onClearSelectedSkill();
            }}
          >
            <ChevronLeftSvg size={11} />
            Skills
          </button>

          <span className="agent-skills__toolbar-spacer" />

          {isEditingSkill ? (
            <>
              <button
                type="button"
                className="secondary-button action-button--row"
                onClick={() => {
                  setIsEditingSkill(false);
                  setLocalError(null);
                }}
                disabled={skillSaving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary-button action-button--row"
                onClick={() => void handleSave()}
                disabled={
                  skillSaving ||
                  isOperationLocked ||
                  (skillDocument !== null && skillSourceDraft === skillDocument.source)
                }
              >
                {skillSaving ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : isConfirmingDeleteSkill ? (
            <>
              <span className="agent-skills__delete-copy">
                Delete &ldquo;{skillDocument?.name || activeSkillSummary.name}&rdquo;?
              </span>
              <button
                type="button"
                className="secondary-button action-button--row"
                onClick={() => setIsConfirmingDeleteSkill(false)}
                disabled={skillSaving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="secondary-button action-button--row agent-skills__delete"
                onClick={() => void handleDelete()}
                disabled={skillSaving || isOperationLocked}
              >
                {skillSaving ? 'Deleting…' : 'Delete'}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                aria-label="Delete this skill"
                className="chrome-button"
                disabled={isOperationLocked || skillLoading || !skillDocument}
                onClick={() => setIsConfirmingDeleteSkill(true)}
              >
                <Trash2Svg size={13} />
              </button>
              <button
                type="button"
                className="secondary-button action-button--row"
                disabled={isOperationLocked || skillLoading || !skillDocument}
                onClick={handleEditClick}
              >
                Edit
              </button>
            </>
          )}
        </header>

        {localError && (
          <p className="agent-feedback agent-feedback--error agent-skills__feedback" role="alert">
            {localError}
          </p>
        )}

        {selectedSkillHasIssue && (
          <div className="agent-skills__read-issue" role="alert">
            This skill could not be read safely. Editing and deletion stay locked; no recovery write is exposed to the renderer.
          </div>
        )}

        {skillLoading ? (
          <div className="agent-detail-state">
            <div className="ui-status-notice" data-tone="loading" role="status">
              <div className="ui-status-notice__copy">
                <strong>Opening skill…</strong>
                <p>Source loads only for the skill you chose.</p>
              </div>
            </div>
          </div>
        ) : !skillDocument ? (
          <div className="agent-detail-state">
            <div className="ui-status-notice" data-tone="warning" role="alert">
              <span aria-hidden="true" className="ui-status-notice__glyph">
                <CircleAlertSvg size={16} />
              </span>
              <div className="ui-status-notice__copy">
                <strong>Skill couldn’t be opened</strong>
                <p>The source response was incomplete.</p>
              </div>
              <div className="ui-status-notice__action">
                <button
                  type="button"
                  className="primary-button action-button--row"
                  onClick={() => void onSelectSkill(selectedSkillId)}
                >
                  Try again
                </button>
              </div>
            </div>
          </div>
        ) : isEditingSkill ? (
          <div className="agent-skills__editor">
            <label className="sr-only" htmlFor="agent-skill-source">
              Skill source
            </label>
            <textarea
              id="agent-skill-source"
              value={skillSourceDraft}
              onChange={(e) => setSkillSourceDraft(e.currentTarget.value)}
              spellCheck={false}
            />
          </div>
        ) : (
          <div className="agent-skills__detail-scroll">
            <article className="agent-skills__document">
              <header>
                <div>
                  <h1>{skillDocument.name}</h1>
                  <time>{formatTimestamp(skillDocument.updatedAtUnixMs)}</time>
                </div>
                <p>
                  <strong>Fires when</strong>
                  <span>
                    {skillDocument.description || 'No description — the agent should add one; retrieval keys on it.'}
                  </span>
                </p>
              </header>
              <div className="agent-skills__document-body">
                {renderProcedureMarkdown(stripFrontmatter(skillDocument.source))}
              </div>
            </article>
          </div>
        )}
      </div>
    );
  }

  const skillsCount = mind?.skills?.length ?? 0;

  return (
    <div className="agent-face agent-skills">
      <div className="agent-mind-bar">
        <div className="ui-tabs">
          <div aria-label="Skills" className="ui-tabs__list" role="tablist">
            <button
              className="ui-tab ui-tab--selected"
              role="tab"
              type="button"
              tabIndex={0}
              aria-selected="true"
            >
              <span className="ui-tab__label" data-label="Skills">
                Skills
              </span>
              {skillsCount > 0 ? (
                <span className="ui-tab__count" data-count="">
                  {skillsCount}
                </span>
              ) : null}
            </button>
          </div>
          {hasAvailableStarters && skillsCount > 0 ? (
            <div className="ui-tabs__trailing">{renderStarterControl()}</div>
          ) : null}
        </div>
      </div>

      {localError && (
        <p className="agent-feedback agent-feedback--error agent-skills__feedback" role="alert">
          {localError}
        </p>
      )}

      {hasSkillsFolderIssue && (
        <div className="agent-skills__read-issue" role="alert">
          The skills folder could not be read safely. Existing data was left unchanged and writes stay disabled.
        </div>
      )}

      {isSkillsTruncated && (
        <div className="agent-skills__read-issue" role="status">
          The bounded list is incomplete. No hidden skill was removed or overwritten.
        </div>
      )}

      <div className="agent-skills__list-scroll">
        {mind && mind.skills && mind.skills.length > 0 ? (
          <div className="agent-mind-column">
            <p className="agent-mind-lede">
              Procedures {agentName} wrote for itself, and reads back when the work matches.
            </p>

            <div className="ui-card agent-skills__rows">
              {mind.skills.map((skill) => {
                const hasIssue = hasSkillReadIssue(mind, skill.id);
                return (
                  <button
                    key={skill.id}
                    type="button"
                    className={
                      hasIssue ? 'ui-card__row agent-skills__row--read-issue' : 'ui-card__row'
                    }
                    aria-label={`${skill.name}. ${skill.description}`}
                    title={
                      hasIssue
                        ? 'This skill opened read-only because its source could not be verified'
                        : `Updated ${formatTimestamp(skill.updatedAtUnixMs)}`
                    }
                    onClick={() => void onSelectSkill(skill.id)}
                  >
                    <span aria-hidden="true" className="agent-skills__row-icon">
                      <FileTextSvg size={14} />
                    </span>

                    <span className="agent-skills__row-copy">
                      <strong>{skill.name}</strong>
                      <span>{skill.description || 'No description — the agent should add one.'}</span>
                      {skill.uses > 0 ? (
                        <small>{skill.uses === 1 ? 'Fired once' : `Fired ${skill.uses}×`}</small>
                      ) : null}
                    </span>

                    <span aria-hidden="true" className="agent-skills__stamp">
                      <span className="agent-skills__stamp-age">
                        {formatRelativeAge(skill.updatedAtUnixMs)}
                      </span>
                      <span className="agent-skills__stamp-open">Open</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <section className="empty-surface empty-surface--embedded agent-skills__empty">
            <span aria-hidden="true" className="empty-surface__icon">
              <WandSparklesSvg size={24} />
            </span>
            <div className="empty-surface__copy">
              <h1>{agentName} hasn’t written a skill yet</h1>
              <p>
                When it works out how to do something you’ll ask for again, it writes the procedure here and reads it back when the work matches. Add a starter to give it something to pattern-match against.
              </p>
            </div>
            {hasAvailableStarters ? renderStarterControl('Add starter skill') : null}
          </section>
        )}
      </div>
    </div>
  );
};
