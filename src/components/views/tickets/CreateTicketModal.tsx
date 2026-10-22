import React, { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { TicketState, TicketPriority, TicketSnapshot, COLUMNS } from './types';
import { PriorityGlyph, StateGlyph } from './TicketCard';
import { FolderGlyph } from '../../dockIcons';

export interface CreateTicketModalProps {
  initialState?: TicketState;
  onClose: () => void;
  onCreate: (ticket: {
    title: string;
    description: string;
    priority: TicketPriority;
    state: TicketState;
    assignee: string | null;
    labels: string[];
    dueDate?: string | null;
    project?: string;
  }) => void | Promise<void>;
  snapshot?: TicketSnapshot | null;
  busy?: boolean;
  error?: string | null;
}

// Tag icon
const TagGlyph: React.FC<{ size?: number; className?: string; strokeWidth?: number }> = ({
  size = 11,
  className,
  strokeWidth = 1.8,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={className}
    style={{ flexShrink: 0 }}
  >
    <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
    <circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />
  </svg>
);

// Authentic Chevron Down Glyph
const ChevronDownGlyph: React.FC<{ size?: number; className?: string }> = ({
  size = 10,
  className,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={className}
    style={{ flexShrink: 0 }}
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
);

// Authentic Check Glyph for selected rows
const CheckGlyph: React.FC<{ size?: number; className?: string }> = ({
  size = 13,
  className,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={className}
    style={{ flexShrink: 0 }}
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const PRIORITY_OPTIONS: Array<{ id: string; title: string; priority: TicketPriority }> = [
  { id: 'Urgent', title: 'Urgent', priority: 'Urgent' },
  { id: 'High', title: 'High', priority: 'High' },
  { id: 'Medium', title: 'Medium', priority: 'Medium' },
  { id: 'Low', title: 'Low', priority: 'Low' },
  { id: 'None', title: 'None', priority: 'No priority' },
];

export const CreateTicketModal: React.FC<CreateTicketModalProps> = ({
  initialState = 'To Do',
  onClose,
  onCreate,
  snapshot,
  busy = false,
  error = null,
}) => {
  const [column, setColumn] = useState<TicketState>(initialState);
  const [priority, setPriority] = useState<TicketPriority>('Medium');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState('');
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('');
  const [dueDate, setDueDate] = useState('');
  const [openMenu, setOpenMenu] = useState<'status' | 'priority' | 'labels' | 'project' | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  // Focus title input on mount with RAF fallback
  useEffect(() => {
    inputRef.current?.focus();
    const raf = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(raf);
  }, []);

  // Close menus on outside click or Escape
  useEffect(() => {
    if (!openMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && !target.closest('.ticket-chip-anchor')) {
        setOpenMenu(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpenMenu(null);
      }
    };
    document.addEventListener('pointerdown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [openMenu]);

  // Priority Label Helper: 'Urgent' | 'High' | 'Medium' | 'Low' | 'None'
  const priorityLabel = useMemo((): string => {
    if (typeof priority === 'number') {
      switch (priority) {
        case 1:
          return 'Urgent';
        case 2:
          return 'High';
        case 3:
          return 'Medium';
        case 4:
          return 'Low';
        default:
          return 'None';
      }
    }
    if (priority === 'Normal') return 'Medium';
    if (priority === 'No priority' || (priority as string) === 'None' || !priority) return 'None';
    return priority;
  }, [priority]);

  // Available Labels
  const availableLabels = useMemo((): Array<{ id: string; name: string }> => {
    if (snapshot?.labels && Array.isArray(snapshot.labels) && snapshot.labels.length > 0) {
      return snapshot.labels.map((l) =>
        typeof l === 'string' ? { id: l, name: l } : { id: l.id, name: l.name }
      );
    }
    return [
      { id: 'Frontend', name: 'Frontend' },
      { id: 'Backend', name: 'Backend' },
      { id: 'Bug', name: 'Bug' },
      { id: 'Feature', name: 'Feature' },
      { id: 'Refactor', name: 'Refactor' },
      { id: 'Design', name: 'Design' },
    ];
  }, [snapshot]);

  // Available Projects
  const availableProjects = useMemo((): Array<{ id: string; name: string }> => {
    const base = [{ id: '', name: 'No project' }];
    if (snapshot?.projects && Array.isArray(snapshot.projects) && snapshot.projects.length > 0) {
      return [...base, ...snapshot.projects.map((p) => ({ id: p.id, name: p.name }))];
    }
    return [
      ...base,
      { id: 'bm-one', name: 'Kite Code' },
      { id: 'core', name: 'Core Engine' },
      { id: 'ui', name: 'UI / UX' },
    ];
  }, [snapshot]);

  const projectLabel = useMemo((): string => {
    if (!selectedProject) return 'Project';
    const match = availableProjects.find((p) => p.id === selectedProject);
    return match?.name || selectedProject || 'Project';
  }, [selectedProject, availableProjects]);

  const labelsLabel = useMemo((): string => {
    if (selectedLabels.length === 0) return 'Labels';
    return selectedLabels.join(', ');
  }, [selectedLabels]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || busy) return;

    onCreate({
      title: title.trim(),
      description,
      priority,
      state: column,
      assignee: assignee.trim() || null,
      labels: selectedLabels,
      dueDate: dueDate.trim() || null,
      project: selectedProject || undefined,
    });
  };

  return createPortal(
    <div
      className="ui-sheet-backdrop"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100vw',
        height: '100vh',
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.65)',
        backdropFilter: 'blur(3px)',
        padding: '24px',
        boxSizing: 'border-box',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="ui-sheet ticket-sheet ticket-new"
        style={{
          width: '560px',
          maxWidth: 'calc(100vw - 32px)',
          borderRadius: '12px',
          backgroundColor: 'var(--dialog, #1a1a1f)',
          border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.08))',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.6)',
          padding: '24px',
          boxSizing: 'border-box',
          position: 'relative',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit} className="ui-sheet__form">
          <header className="ui-sheet__heading">
            <h2 className="ui-sheet__title">New task</h2>
          </header>

          {error && (
            <p
              role="alert"
              className="ticket-notice ticket-notice--error"
              style={{ color: 'var(--danger, #f85149)', margin: 0, fontSize: '13px' }}
            >
              {error}
            </p>
          )}

          {/* Form Canvas */}
          <div
            className="ticket-new__canvas"
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !e.defaultPrevented) {
                e.preventDefault();
                onClose();
              }
            }}
          >
            <input
              ref={inputRef}
              type="text"
              aria-label="Title"
              className="ticket-new__title"
              placeholder="Task title"
              maxLength={512}
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />

            <textarea
              aria-label="Description"
              className="ticket-new__description"
              placeholder="Add a description…"
              rows={6}
              maxLength={65536}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />

            <div className="ticket-new__chips">
              {/* a) Status Picker */}
              <div className="ticket-chip-anchor">
                <button
                  type="button"
                  role="combobox"
                  aria-haspopup="listbox"
                  aria-expanded={openMenu === 'status'}
                  aria-label="Status"
                  className={`select-menu-trigger select-menu-trigger--field${
                    openMenu === 'status' ? ' select-menu-trigger--open' : ''
                  }`}
                  onClick={() => setOpenMenu(openMenu === 'status' ? null : 'status')}
                >
                  <span aria-hidden="true" className="select-menu-trigger__icon">
                    <StateGlyph state={column} size={13} />
                  </span>
                  <span className="select-menu-trigger__label">{column}</span>
                  <ChevronDownGlyph size={10} className="select-menu-trigger__chevron" />
                </button>

                {openMenu === 'status' && (
                  <div
                    role="listbox"
                    aria-label="Status"
                    className="select-menu select-menu--from-top"
                    style={{
                      position: 'absolute',
                      top: 'calc(100% + 4px)',
                      left: 0,
                      zIndex: 80,
                      minWidth: '150px',
                    }}
                  >
                    <div className="select-menu__rows">
                      {COLUMNS.map((col) => {
                        const isSelected = column === col;
                        return (
                          <div
                            key={col}
                            role="option"
                            tabIndex={-1}
                            aria-selected={isSelected}
                            className="select-menu__row select-menu__row--marked"
                            onClick={() => {
                              setColumn(col);
                              setOpenMenu(null);
                            }}
                          >
                            <span aria-hidden="true" className="select-menu__row-mark">
                              <StateGlyph state={col} size={14} />
                            </span>
                            <span className="select-menu__row-text">
                              <span className="select-menu__row-title">{col}</span>
                            </span>
                            <span className="select-menu__row-check">
                              {isSelected && <CheckGlyph size={13} />}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* b) Priority Picker */}
              <div className="ticket-chip-anchor">
                <button
                  type="button"
                  role="combobox"
                  aria-haspopup="listbox"
                  aria-expanded={openMenu === 'priority'}
                  aria-label="Priority"
                  className={`select-menu-trigger select-menu-trigger--field${
                    openMenu === 'priority' ? ' select-menu-trigger--open' : ''
                  }`}
                  onClick={() => setOpenMenu(openMenu === 'priority' ? null : 'priority')}
                >
                  <span aria-hidden="true" className="select-menu-trigger__icon">
                    <PriorityGlyph priority={priority} size={13} />
                  </span>
                  <span className="select-menu-trigger__label">{priorityLabel}</span>
                  <ChevronDownGlyph size={10} className="select-menu-trigger__chevron" />
                </button>

                {openMenu === 'priority' && (
                  <div
                    role="listbox"
                    aria-label="Priority"
                    className="select-menu select-menu--from-top"
                    style={{
                      position: 'absolute',
                      top: 'calc(100% + 4px)',
                      left: 0,
                      zIndex: 80,
                      minWidth: '150px',
                    }}
                  >
                    <div className="select-menu__rows">
                      {PRIORITY_OPTIONS.map((opt) => {
                        const isSelected = priorityLabel === opt.title;
                        return (
                          <div
                            key={opt.id}
                            role="option"
                            tabIndex={-1}
                            aria-selected={isSelected}
                            className="select-menu__row select-menu__row--marked"
                            onClick={() => {
                              setPriority(opt.priority);
                              setOpenMenu(null);
                            }}
                          >
                            <span aria-hidden="true" className="select-menu__row-mark">
                              <PriorityGlyph priority={opt.priority} size={14} />
                            </span>
                            <span className="select-menu__row-text">
                              <span className="select-menu__row-title">{opt.title}</span>
                            </span>
                            <span className="select-menu__row-check">
                              {isSelected && <CheckGlyph size={13} />}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* c) Assignee Input */}
              <input
                type="text"
                aria-label="Assignee"
                className="ticket-new__chip-input"
                placeholder="Assignee"
                maxLength={160}
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
              />

              {/* d) Labels Picker */}
              <div className="ticket-chip-anchor">
                <button
                  type="button"
                  role="combobox"
                  aria-haspopup="listbox"
                  aria-expanded={openMenu === 'labels'}
                  aria-label="Labels"
                  className={`select-menu-trigger select-menu-trigger--field${
                    openMenu === 'labels' ? ' select-menu-trigger--open' : ''
                  }`}
                  onClick={() => setOpenMenu(openMenu === 'labels' ? null : 'labels')}
                >
                  <span aria-hidden="true" className="select-menu-trigger__icon">
                    <TagGlyph size={11} strokeWidth={1.8} />
                  </span>
                  <span className="select-menu-trigger__label">{labelsLabel}</span>
                  <ChevronDownGlyph size={10} className="select-menu-trigger__chevron" />
                </button>

                {openMenu === 'labels' && (
                  <div
                    role="listbox"
                    aria-label="Labels"
                    className="select-menu select-menu--from-top"
                    style={{
                      position: 'absolute',
                      top: 'calc(100% + 4px)',
                      left: 0,
                      zIndex: 80,
                      minWidth: '170px',
                    }}
                  >
                    <div className="select-menu__rows">
                      {availableLabels.map((lbl) => {
                        const isSelected = selectedLabels.includes(lbl.name);
                        return (
                          <div
                            key={lbl.id}
                            role="option"
                            tabIndex={-1}
                            aria-selected={isSelected}
                            className="select-menu__row select-menu__row--marked"
                            onClick={() => {
                              setSelectedLabels((prev) =>
                                prev.includes(lbl.name)
                                  ? prev.filter((x) => x !== lbl.name)
                                  : [...prev, lbl.name]
                              );
                            }}
                          >
                            <span aria-hidden="true" className="select-menu__row-mark">
                              <TagGlyph size={12} strokeWidth={1.8} />
                            </span>
                            <span className="select-menu__row-text">
                              <span className="select-menu__row-title">{lbl.name}</span>
                            </span>
                            <span className="select-menu__row-check">
                              {isSelected && <CheckGlyph size={13} />}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* e) Project Picker */}
              <div className="ticket-chip-anchor">
                <button
                  type="button"
                  role="combobox"
                  aria-haspopup="listbox"
                  aria-expanded={openMenu === 'project'}
                  aria-label="Project"
                  className={`select-menu-trigger select-menu-trigger--field${
                    openMenu === 'project' ? ' select-menu-trigger--open' : ''
                  }`}
                  onClick={() => setOpenMenu(openMenu === 'project' ? null : 'project')}
                >
                  <span aria-hidden="true" className="select-menu-trigger__icon">
                    <FolderGlyph size={11} />
                  </span>
                  <span className="select-menu-trigger__label">{projectLabel}</span>
                  <ChevronDownGlyph size={10} className="select-menu-trigger__chevron" />
                </button>

                {openMenu === 'project' && (
                  <div
                    role="listbox"
                    aria-label="Project"
                    className="select-menu select-menu--from-top"
                    style={{
                      position: 'absolute',
                      top: 'calc(100% + 4px)',
                      left: 0,
                      zIndex: 80,
                      minWidth: '170px',
                    }}
                  >
                    <div className="select-menu__rows">
                      {availableProjects.map((proj) => {
                        const isSelected = selectedProject === proj.id;
                        return (
                          <div
                            key={proj.id || 'none'}
                            role="option"
                            tabIndex={-1}
                            aria-selected={isSelected}
                            className="select-menu__row select-menu__row--marked"
                            onClick={() => {
                              setSelectedProject(proj.id);
                              setOpenMenu(null);
                            }}
                          >
                            <span aria-hidden="true" className="select-menu__row-mark">
                              <FolderGlyph size={12} />
                            </span>
                            <span className="select-menu__row-text">
                              <span className="select-menu__row-title">{proj.name}</span>
                            </span>
                            <span className="select-menu__row-check">
                              {isSelected && <CheckGlyph size={13} />}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* f) Due Date Input */}
              <input
                type="text"
                aria-label="Due date"
                className="ticket-new__chip-input"
                placeholder="Due YYYY-MM-DD"
                maxLength={10}
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>

          <footer
            className="ui-sheet__footer"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: '24px',
            }}
          >
            <button
              type="button"
              className="ui-button ui-button--secondary"
              onClick={onClose}
              style={{
                background: 'transparent',
                border: 0,
                color: 'var(--text-secondary, #a1a1aa)',
                fontSize: '13px',
                padding: '6px 14px',
                borderRadius: 'var(--radius-chip, 6px)',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <span aria-hidden="true" className="ui-sheet__spacer" style={{ flex: 1 }} />
            <button
              type="submit"
              className="ui-button ui-button--primary tickets-new"
              disabled={busy || !title.trim()}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'var(--accent, #3b82f6)',
                border: 0,
                color: '#ffffff',
                fontSize: '13px',
                fontWeight: 600,
                padding: '6px 16px',
                borderRadius: 'var(--radius-chip, 6px)',
                cursor: busy || !title.trim() ? 'not-allowed' : 'pointer',
                opacity: busy || !title.trim() ? 0.5 : 1,
              }}
            >
              Create task
            </button>
          </footer>
        </form>
      </div>
    </div>,
    document.body
  );
};
