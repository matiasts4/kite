import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  TicketIssue,
  TicketState,
  TicketPriority,
  TaskExecutionRun,
  TicketSnapshot,
  COLUMNS,
} from './types';
import { PriorityGlyph, StateGlyph, TicketAvatar } from './TicketCard';
import { readStoredLabels, readStoredProjects } from './ticketStorage';
import { TagGlyph } from './ticketIcons';
import { openFileInRightDock } from '../../../lib/filePreviewNav';
import { SelectMenu } from '../../ui/SelectMenu';
import { ChevronLeftGlyph, ChevronRightGlyph, MoreHorizontalGlyph } from '../../dockIcons';

const ODD_PATH_SPLIT_RE = /((?:odd|\.kite)\/tasks\/[a-z0-9._-]+\.md)/g;

function renderDescriptionWithOddLinks(text: string): React.ReactNode {
  const parts = text.split(ODD_PATH_SPLIT_RE);
  if (parts.length === 1) return text;
  return parts.map((part, idx) =>
    idx % 2 === 1 ? (
      <button
        key={`${idx}-${part}`}
        type="button"
        className="ticket-odd-link"
        onClick={() => openFileInRightDock({ candidate: part })}
      >
        {part}
      </button>
    ) : (
      <React.Fragment key={idx}>{part}</React.Fragment>
    )
  );
}

const KITE_THREAD_ID_RE =
  /^(?:thr[-_][a-z0-9-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function parseSourceThread(raw?: string | null): {
  raw: string;
  isKiteThread: boolean;
  threadId: string;
} | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('thread:')) {
    const stripped = trimmed.slice('thread:'.length).trim();
    return {
      raw: trimmed,
      isKiteThread: Boolean(stripped),
      threadId: stripped,
    };
  }
  return {
    raw: trimmed,
    isKiteThread: KITE_THREAD_ID_RE.test(trimmed),
    threadId: trimmed,
  };
}

export interface TicketDetailViewProps {
  issue: TicketIssue;
  snapshot?: TicketSnapshot | null;
  run?: TaskExecutionRun | null;
  busy?: boolean;
  onBack: () => void;
  onSave: (tool: string, args: any) => Promise<boolean | void>;
  onArchive: (issue: TicketIssue) => void;
  onRestore?: (issue: TicketIssue) => void;
  onDispatch?: (issue: TicketIssue) => void;
}

const PRIORITY_ROWS = [
  { id: '0', title: 'No priority', priority: 0 },
  { id: '1', title: 'Urgent', priority: 1 },
  { id: '2', title: 'High', priority: 2 },
  { id: '3', title: 'Normal', priority: 3 },
  { id: '4', title: 'Low', priority: 4 },
];

function getPriorityId(priority: TicketPriority): string {
  if (typeof priority === 'number') return String(priority);
  switch (priority) {
    case 'Urgent':
      return '1';
    case 'High':
      return '2';
    case 'Medium':
    case 'Normal':
      return '3';
    case 'Low':
      return '4';
    default:
      return '0';
  }
}

function getPriorityTitle(priority: TicketPriority): string {
  const id = getPriorityId(priority);
  return PRIORITY_ROWS.find((r) => r.id === id)?.title ?? 'No priority';
}

function getExecutionStateLabel(state: string): string {
  switch (state) {
    case 'preparing':
      return 'Preparing workspace and assignments';
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Implementation in progress';
    case 'validating':
      return 'Independent review in progress';
    case 'waitingForInput':
      return 'Waiting for your input — open the agent session';
    case 'cancelRequested':
      return 'Stopping — waiting for the agent';
    case 'succeeded':
    case 'done':
      return 'Completed with reported verification';
    case 'needsReview':
      return 'Needs review — acceptance evidence is incomplete';
    case 'failed':
      return 'Failed — workspace retained';
    case 'cancelled':
      return 'Stopped — workspace retained';
    case 'interrupted':
      return 'Interrupted when the app closed — resume when ready';
    default:
      return state;
  }
}

const BotGlyph: React.FC<{ size?: number }> = ({ size = 13 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 8V4H8" />
    <rect width="16" height="12" x="4" y="8" rx="2" />
    <path d="M2 14h2" />
    <path d="M20 14h2" />
    <path d="M15 13v2" />
    <path d="M9 13v2" />
  </svg>
);

const ArchiveGlyph: React.FC<{ size?: number }> = ({ size = 13 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect width="20" height="5" x="2" y="3" rx="1" />
    <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
    <path d="M10 12h4" />
  </svg>
);

const ArchiveRestoreGlyph: React.FC<{ size?: number }> = ({ size = 13 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect width="20" height="5" x="2" y="3" rx="1" />
    <path d="M4 8v11a2 2 0 0 0 2 2h2" />
    <path d="M20 8v11a2 2 0 0 1-2 2h-2" />
    <path d="m9 15 3-3 3 3" />
    <path d="M12 12v9" />
  </svg>
);

export const TicketDetailView: React.FC<TicketDetailViewProps> = ({
  issue,
  snapshot,
  run,
  busy = false,
  onBack,
  onSave,
  onArchive,
  onRestore,
  onDispatch,
}) => {
  const [title, setTitle] = useState(issue.title);
  const [description, setDescription] = useState(issue.description || '');
  const [isEditingDescription, setIsEditingDescription] = useState(false);
  const [state, setState] = useState<TicketState>(issue.state);
  const [priority, setPriority] = useState<TicketPriority>(issue.priority);
  const [assignee, setAssignee] = useState(issue.assignee || '');
  const [delegate, setDelegate] = useState(issue.delegate || '');
  const [dueDate, setDueDate] = useState(issue.dueDate || '');
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [copiedThread, setCopiedThread] = useState(false);
  const actionsBtnRef = useRef<HTMLButtonElement>(null);

  const [comments, setComments] = useState<
    Array<{ id: string; author: string; text: string; time: string }>
  >([
    {
      id: 'c1',
      author: 'Kite',
      text: `created this task · status ${issue.state}`,
      time: new Date(issue.createdAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
    },
  ]);
  const [commentText, setCommentText] = useState('');

  useEffect(() => {
    setTitle(issue.title);
    setDescription(issue.description || '');
    setState(issue.state);
    setPriority(issue.priority);
    setAssignee(issue.assignee || '');
    setDelegate(issue.delegate || '');
    setDueDate(issue.dueDate || '');
    setCopiedThread(false);
  }, [issue]);

  const handleTitleBlur = () => {
    if (!title.trim()) {
      setTitle(issue.title);
      return;
    }
    if (title.trim() !== issue.title) {
      void onSave('save_issue', { id: issue.id, title: title.trim() });
    }
  };

  const handleSaveDescription = async () => {
    await onSave('save_issue', { id: issue.id, description });
    setIsEditingDescription(false);
  };

  const handleStateChange = (newStateId: string) => {
    const next = newStateId as TicketState;
    setState(next);
    void onSave('save_issue', { id: issue.id, state: next });
  };

  const handlePriorityChange = (newPrioId: string) => {
    const row = PRIORITY_ROWS.find((r) => r.id === newPrioId);
    const next = row ? row.title : 'Normal';
    setPriority(next as TicketPriority);
    void onSave('save_issue', { id: issue.id, priority: next });
  };

  const handleAssigneeBlur = () => {
    void onSave('save_issue', { id: issue.id, assignee: assignee.trim() || null });
  };

  const handleDelegateBlur = () => {
    void onSave('save_issue', { id: issue.id, delegate: delegate.trim() || null });
  };

  const handleDueDateBlur = () => {
    void onSave('save_issue', { id: issue.id, dueDate: dueDate.trim() || null });
  };

  const handleToggleLabel = (labelName: string) => {
    const current = issue.labels || [];
    const next = current.includes(labelName)
      ? current.filter((l) => l !== labelName)
      : [...current, labelName];
    void onSave('save_issue', { id: issue.id, labels: next });
  };

  const handleAddComment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!commentText.trim() || busy) return;
    setComments((prev) => [
      ...prev,
      {
        id: `c-${Date.now()}`,
        author: 'You',
        text: commentText.trim(),
        time: 'now',
      },
    ]);
    void onSave('save_comment', { issueId: issue.id, body: commentText.trim() });
    setCommentText('');
  };

  const handleCopySourceThread = async (value: string) => {
    try {
      await navigator.clipboard?.writeText(value);
      setCopiedThread(true);
    } catch {
      // ignore clipboard errors
    }
  };

  const rawLabels =
    snapshot?.labels && snapshot.labels.length > 0 ? snapshot.labels : readStoredLabels();
  const baseLabels = rawLabels.map((l) =>
    typeof l === 'string' ? { id: l, name: l } : { id: l.id, name: l.name }
  );
  const availableLabels = [...baseLabels];
  for (const existing of issue.labels ?? []) {
    if (!availableLabels.some((l) => l.name.toLowerCase() === existing.toLowerCase())) {
      availableLabels.push({ id: existing, name: existing });
    }
  }

  const availableProjects =
    snapshot?.projects && snapshot.projects.length > 0
      ? snapshot.projects
      : readStoredProjects();
  const parsedThread = parseSourceThread(issue.sourceThreadId);
  const otherIssues = (snapshot?.issues ?? []).filter(
    (t) => t.id !== issue.id && !t.archivedAt
  );

  const blockedByIssues = (snapshot?.issues ?? []).filter((t) =>
    (t.blocks ?? []).includes(issue.id)
  );

  const activeProject = availableProjects.find((p) => p.id === issue.projectId);

  return (
    <article aria-label={`${issue.id} ${title}`} className="ticket-detail">
      {/* Main Column */}
      <div className="ticket-detail__main">
        <header className="ticket-detail__bar">
          <button type="button" className="ticket-detail__back" onClick={onBack}>
            <ChevronLeftGlyph size={14} strokeWidth={2} />
            Tasks
          </button>
          <span className="ticket-detail__crumb">
            <ChevronRightGlyph size={11} strokeWidth={2} />
            <span className="ticket-detail__id">{issue.id}</span>
            {issue.archivedAt ? (
              <span className="ticket-detail__archived">Archived</span>
            ) : null}
          </span>
          <span className="ticket-row__spacer" />

          {onDispatch ? (
            <button
              type="button"
              className="secondary-button action-button--row"
              disabled={busy}
              onClick={() => onDispatch(issue)}
              title="Have a saved Agent work on this task in its own branch"
            >
              <span className="action-button__icon">
                <BotGlyph size={12} />
              </span>
              Dispatch
            </button>
          ) : null}

          <button
            ref={actionsBtnRef}
            type="button"
            className={`chrome-button${actionsMenuOpen ? ' chrome-button--selected' : ''}`}
            aria-expanded={actionsMenuOpen}
            aria-haspopup="menu"
            disabled={busy}
            onClick={() => setActionsMenuOpen((v) => !v)}
            title="Task actions"
            aria-label="Task actions"
          >
            <MoreHorizontalGlyph size={14} />
          </button>

          {actionsMenuOpen &&
            typeof document !== 'undefined' &&
            createPortal(
              <>
                <div
                  style={{ position: 'fixed', inset: 0, zIndex: 59 }}
                  onClick={() => setActionsMenuOpen(false)}
                />
                <div
                  role="menu"
                  aria-label="Task actions"
                  className="ui-menu scroll-quiet"
                  style={(() => {
                    const rect = actionsBtnRef.current?.getBoundingClientRect();
                    return {
                      left: rect ? `${Math.max(8, rect.right - 180)}px` : '0px',
                      top: rect ? `${rect.bottom + 4}px` : '0px',
                      '--menu-origin': 'top right',
                    } as React.CSSProperties;
                  })()}
                >
                  {issue.archivedAt ? (
                    <div
                      role="menuitem"
                      tabIndex={-1}
                      className="ui-menu__row"
                      onClick={() => {
                        setActionsMenuOpen(false);
                        onRestore?.(issue);
                      }}
                    >
                      <span aria-hidden="true" className="ui-menu__icon">
                        <ArchiveRestoreGlyph size={13} />
                      </span>
                      <span className="ui-menu__label">
                        <span className="ui-menu__row-title">Restore task</span>
                      </span>
                    </div>
                  ) : (
                    <div
                      role="menuitem"
                      tabIndex={-1}
                      className="ui-menu__row"
                      onClick={() => {
                        setActionsMenuOpen(false);
                        onArchive(issue);
                      }}
                    >
                      <span aria-hidden="true" className="ui-menu__icon">
                        <ArchiveGlyph size={13} />
                      </span>
                      <span className="ui-menu__label">
                        <span className="ui-menu__row-title">Archive task</span>
                      </span>
                    </div>
                  )}
                </div>
              </>,
              document.querySelector('.app-frame--scaled') ?? document.body
            )}
        </header>

        <p className="ticket-detail__state">
          <StateGlyph state={state} size={14} />
          {state}
        </p>

        <input
          aria-label="Title"
          className="ticket-detail__title"
          disabled={busy}
          maxLength={512}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleTitleBlur}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              setTitle(issue.title);
            }
          }}
        />

        {(issue.oddPath || issue.sourceAgent || parsedThread) ? (
          <div aria-label="Traceability" className="ticket-traceability">
            {issue.oddPath ? (
              <span className="ticket-traceability__item">
                <span className="ticket-traceability__label">ODD</span>
                <button
                  type="button"
                  className="ticket-traceability__btn ticket-traceability__btn--path"
                  title={`Open ${issue.oddPath} in RightDock Files`}
                  onClick={() => openFileInRightDock({ candidate: issue.oddPath! })}
                >
                  <span className="ticket-traceability__btn-text">{issue.oddPath}</span>
                </button>
              </span>
            ) : null}

            {issue.sourceAgent ? (
              <span className="ticket-traceability__item">
                <span className="ticket-traceability__label">Agent</span>
                <span className="ticket-traceability__badge">{issue.sourceAgent}</span>
              </span>
            ) : null}

            {parsedThread ? (
              <span className="ticket-traceability__item">
                <span className="ticket-traceability__label">Thread</span>
                {parsedThread.isKiteThread ? (
                  <button
                    type="button"
                    className="ticket-traceability__btn"
                    title={`Open thread ${parsedThread.threadId}`}
                    onClick={() => {
                      window.dispatchEvent(new CustomEvent('kite:navigate-mode', { detail: 'chat' }));
                      window.dispatchEvent(
                        new CustomEvent('kite:select-thread', {
                          detail: { threadId: parsedThread.threadId, mode: 'chat' },
                        })
                      );
                    }}
                  >
                    Open thread
                  </button>
                ) : (
                  <>
                    <code className="ticket-traceability__code" title={parsedThread.raw}>
                      {parsedThread.raw}
                    </code>
                    <button
                      type="button"
                      className="ticket-traceability__btn"
                      onClick={() => void handleCopySourceThread(parsedThread.raw)}
                    >
                      {copiedThread ? 'Copied' : 'Copy'}
                    </button>
                  </>
                )}
              </span>
            ) : null}
          </div>
        ) : null}

        <section aria-label="Description" className="ticket-description">
          {isEditingDescription ? (
            <>
              <textarea
                aria-label="Description"
                disabled={busy}
                maxLength={65536}
                rows={6}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
              <div className="ticket-composer__actions">
                <button
                  type="button"
                  className="secondary-button action-button--row"
                  disabled={busy}
                  onClick={() => {
                    setDescription(issue.description || '');
                    setIsEditingDescription(false);
                  }}
                >
                  Cancel description
                </button>
                <button
                  type="button"
                  className="primary-button action-button--row"
                  disabled={busy || description === (issue.description || '')}
                  onClick={() => void handleSaveDescription()}
                >
                  Save description
                </button>
              </div>
            </>
          ) : (
            <>
              <p
                className={`ticket-detail__body${
                  description ? '' : ' ticket-detail__body--empty'
                }`}
              >
                {description ? renderDescriptionWithOddLinks(description) : 'No description.'}
              </p>
              <button
                type="button"
                className="secondary-button action-button--row"
                disabled={busy}
                onClick={() => setIsEditingDescription(true)}
              >
                Edit description
              </button>
            </>
          )}
        </section>

        {/* Execution Status Block (if a run exists for this task) */}
        {run ? (
          <section
            aria-label={`Execution of ${issue.id}`}
            className="task-execution"
            style={{ marginBottom: 'var(--space-6)' }}
          >
            <p className="task-execution__title">
              Execution · Attempt {run.attempt ?? 1}
            </p>
            <p className="task-execution__state">{getExecutionStateLabel(run.state)}</p>
            {run.branch ? <p className="task-execution__branch">{run.branch}</p> : null}
            {run.summary ? <p className="task-execution__summary">{run.summary}</p> : null}
          </section>
        ) : null}

        {/* Activity & Comments Stream */}
        <section aria-label="Activity" className="ticket-activity">
          <h2>Activity</h2>
          <ol className="ticket-activity__list">
            {comments.map((c) => (
              <li key={c.id} className="ticket-activity__entry">
                <TicketAvatar name={c.author} kind="Assignee" size={20} />
                <div className="ticket-activity__content">
                  <p className="ticket-activity__meta">
                    <strong>{c.author}</strong>
                    <time>{c.time}</time>
                  </p>
                  <p className="ticket-activity__body">{c.text}</p>
                </div>
              </li>
            ))}
          </ol>

          <form className="ticket-composer" onSubmit={handleAddComment}>
            <textarea
              aria-label="Comment"
              maxLength={65536}
              placeholder="Leave a comment…"
              rows={3}
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
            />
            <div className="ticket-composer__actions">
              <button
                type="submit"
                className="primary-button action-button--row"
                disabled={busy || !commentText.trim()}
              >
                Comment
              </button>
            </div>
          </form>
        </section>
      </div>

      {/* Properties Sidebar */}
      <aside aria-label="Properties" className="ticket-properties">
        <h2>Properties</h2>

        <div className="ticket-properties__row">
          <span className="ticket-properties__label">Status</span>
          <span className="ticket-properties__value">
            <SelectMenu
              disabled={busy}
              label="Status"
              variant="field"
              minWidth={220}
              value={state}
              triggerIcon={<StateGlyph state={state} />}
              triggerLabel={state}
              rows={COLUMNS.map((col) => ({
                id: col,
                title: col,
                icon: <StateGlyph state={col} />,
              }))}
              onSelect={handleStateChange}
            />
          </span>
        </div>

        <div className="ticket-properties__row">
          <span className="ticket-properties__label">Priority</span>
          <span className="ticket-properties__value">
            <SelectMenu
              disabled={busy}
              label="Priority"
              variant="field"
              minWidth={220}
              value={getPriorityId(priority)}
              triggerIcon={<PriorityGlyph priority={priority} />}
              triggerLabel={getPriorityTitle(priority)}
              rows={PRIORITY_ROWS.map((r) => ({
                id: r.id,
                title: r.title,
                icon: <PriorityGlyph priority={r.priority} />,
              }))}
              onSelect={handlePriorityChange}
            />
          </span>
        </div>

        <div className="ticket-properties__row">
          <span className="ticket-properties__label">Assignee</span>
          <span className="ticket-properties__value">
            <span className="ticket-inline">
              <TicketAvatar name={assignee || null} kind="Assignee" size={18} />
              <input
                aria-label="Assignee"
                className="ticket-inline__input"
                disabled={busy}
                maxLength={160}
                placeholder="Nobody"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                onBlur={handleAssigneeBlur}
              />
            </span>
          </span>
        </div>

        <div className="ticket-properties__row">
          <span className="ticket-properties__label">Delegate</span>
          <span className="ticket-properties__value">
            <span className="ticket-inline">
              <TicketAvatar name={delegate || null} kind="Delegate" size={18} />
              <input
                aria-label="Delegate"
                className="ticket-inline__input"
                disabled={busy}
                maxLength={160}
                placeholder="No agent"
                value={delegate}
                onChange={(e) => setDelegate(e.target.value)}
                onBlur={handleDelegateBlur}
              />
            </span>
          </span>
        </div>

        <div className="ticket-properties__row">
          <span className="ticket-properties__label">Labels</span>
          <span className="ticket-properties__value">
            <SelectMenu
              disabled={busy}
              label="Labels"
              variant="field"
              minWidth={220}
              closeOnSelect={false}
              value=""
              triggerLabel={
                (issue.labels ?? []).length > 0 ? issue.labels.join(', ') : 'Add label'
              }
              rows={availableLabels.map((lbl) => ({
                id: lbl.name,
                title: lbl.name,
                icon: <TagGlyph size={12} />,
                selected: (issue.labels ?? []).includes(lbl.name),
              }))}
              onSelect={handleToggleLabel}
            />
          </span>
        </div>

        <div className="ticket-properties__row">
          <span className="ticket-properties__label">Project</span>
          <span className="ticket-properties__value">
            <SelectMenu
              disabled={busy}
              label="Project"
              variant="field"
              minWidth={220}
              value={issue.projectId ?? ''}
              triggerLabel={activeProject?.name ?? 'No project'}
              rows={[
                { id: '', title: 'No project' },
                ...availableProjects.map((p) => ({ id: p.id, title: p.name })),
              ]}
              onSelect={(id) =>
                void onSave('save_issue', { id: issue.id, projectId: id || null })
              }
            />
          </span>
        </div>

        <div className="ticket-properties__row">
          <span className="ticket-properties__label">Due date</span>
          <span className="ticket-properties__value">
            <span className="ticket-inline">
              <input
                aria-label="Due date"
                className="ticket-inline__input"
                disabled={busy}
                maxLength={160}
                placeholder="YYYY-MM-DD"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                onBlur={handleDueDateBlur}
              />
            </span>
          </span>
        </div>

        <div aria-hidden="true" className="ticket-properties__rule" />

        <div className="ticket-properties__row">
          <span className="ticket-properties__label">Parent</span>
          <span className="ticket-properties__value">
            <SelectMenu
              disabled={busy || otherIssues.length === 0}
              label="Parent"
              variant="field"
              minWidth={220}
              value={issue.parentId ?? ''}
              triggerLabel={issue.parentId ?? 'No parent'}
              rows={[
                { id: '', title: 'No parent' },
                ...otherIssues.map((t) => ({
                  id: t.id,
                  title: t.id,
                  detail: t.title,
                  icon: <StateGlyph state={t.state} />,
                })),
              ]}
              onSelect={(id) =>
                void onSave('save_issue', { id: issue.id, parentId: id || null })
              }
            />
          </span>
        </div>

        <div className="ticket-properties__row">
          <span className="ticket-properties__label">Blocks</span>
          <span className="ticket-properties__value">
            <SelectMenu
              disabled={busy || otherIssues.length === 0}
              label="Blocks"
              variant="field"
              minWidth={220}
              closeOnSelect={false}
              value=""
              triggerLabel={
                (issue.blocks ?? []).length > 0
                  ? (issue.blocks ?? []).join(', ')
                  : 'Nothing'
              }
              rows={otherIssues.map((t) => ({
                id: t.id,
                title: t.id,
                detail: t.title,
                icon: <StateGlyph state={t.state} />,
                selected: (issue.blocks ?? []).includes(t.id),
              }))}
              onSelect={(id) => {
                const cur = issue.blocks ?? [];
                const next = cur.includes(id)
                  ? cur.filter((x) => x !== id)
                  : [...cur, id];
                void onSave('save_issue', { id: issue.id, blocks: next });
              }}
            />
          </span>
        </div>

        <div className="ticket-properties__row">
          <span className="ticket-properties__label">Blocked by</span>
          <span className="ticket-properties__value">
            <span className="ticket-properties__static">
              {blockedByIssues.length > 0
                ? blockedByIssues.map((t) => t.id).join(', ')
                : 'Nothing'}
            </span>
          </span>
        </div>

        <div className="ticket-properties__row">
          <span className="ticket-properties__label">Related</span>
          <span className="ticket-properties__value">
            <SelectMenu
              disabled={busy || otherIssues.length === 0}
              label="Related"
              variant="field"
              minWidth={220}
              closeOnSelect={false}
              value=""
              triggerLabel={
                (issue.relatedTo ?? []).length > 0
                  ? (issue.relatedTo ?? []).join(', ')
                  : 'Nothing'
              }
              rows={otherIssues.map((t) => ({
                id: t.id,
                title: t.id,
                detail: t.title,
                icon: <StateGlyph state={t.state} />,
                selected: (issue.relatedTo ?? []).includes(t.id),
              }))}
              onSelect={(id) => {
                const cur = issue.relatedTo ?? [];
                const next = cur.includes(id)
                  ? cur.filter((x) => x !== id)
                  : [...cur, id];
                void onSave('save_issue', { id: issue.id, relatedTo: next });
              }}
            />
          </span>
        </div>

        <div className="ticket-properties__row">
          <span className="ticket-properties__label">Duplicate of</span>
          <span className="ticket-properties__value">
            <SelectMenu
              disabled={busy || otherIssues.length === 0}
              label="Duplicate of"
              variant="field"
              minWidth={220}
              value={issue.duplicateOf ?? ''}
              triggerLabel={issue.duplicateOf ?? 'Not a duplicate'}
              rows={[
                { id: '', title: 'Not a duplicate' },
                ...otherIssues.map((t) => ({
                  id: t.id,
                  title: t.id,
                  detail: t.title,
                  icon: <StateGlyph state={t.state} />,
                })),
              ]}
              onSelect={(id) =>
                void onSave('save_issue', { id: issue.id, duplicateOf: id || null })
              }
            />
          </span>
        </div>
      </aside>
    </article>
  );
};
