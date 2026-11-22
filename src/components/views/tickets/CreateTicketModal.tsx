import React, { useState, useRef, useEffect, useMemo } from 'react';
import { TicketState, TicketPriority, TicketSnapshot, COLUMNS } from './types';
import { PriorityGlyph, StateGlyph } from './TicketCard';
import { readStoredLabels, readStoredProjects } from './ticketStorage';
import { TagGlyph } from './ticketIcons';
import { FolderGlyph } from '../../dockIcons';
import { Sheet } from '../../ui/Sheet';
import { SelectMenu } from '../../ui/SelectMenu';

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
    oddPath?: string;
  }) => void | Promise<void>;
  snapshot?: TicketSnapshot | null;
  busy?: boolean;
  error?: string | null;
}

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
  const [oddPath, setOddPath] = useState('');
  const [assignee, setAssignee] = useState('');
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('');
  const [dueDate, setDueDate] = useState('');

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const raf = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(raf);
  }, []);

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

  const availableLabels = useMemo((): Array<{ id: string; name: string }> => {
    const source =
      snapshot?.labels && Array.isArray(snapshot.labels) && snapshot.labels.length > 0
        ? snapshot.labels
        : readStoredLabels();
    return source.map((l) =>
      typeof l === 'string' ? { id: l, name: l } : { id: l.id, name: l.name }
    );
  }, [snapshot]);

  const availableProjects = useMemo((): Array<{ id: string; name: string }> => {
    const base = [{ id: '', name: 'No project' }];
    const source =
      snapshot?.projects && Array.isArray(snapshot.projects) && snapshot.projects.length > 0
        ? snapshot.projects
        : readStoredProjects();
    return [...base, ...source.map((p) => ({ id: p.id, name: p.name }))];
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

  const handleSubmit = () => {
    if (!title.trim() || busy) return;
    const trimmedOddPath = oddPath.trim();

    onCreate({
      title: title.trim(),
      description,
      priority,
      state: column,
      assignee: assignee.trim() || null,
      labels: selectedLabels,
      dueDate: dueDate.trim() || null,
      project: selectedProject || undefined,
      ...(trimmedOddPath ? { oddPath: trimmedOddPath } : {}),
    });
  };

  return (
    <Sheet
      open={true}
      title="New task"
      width={560}
      className="ticket-sheet ticket-new"
      onCancel={() => {
        if (!busy) onClose();
      }}
      primary={{
        label: 'Create task',
        onClick: handleSubmit,
        disabled: busy || !title.trim(),
        loading: busy,
      }}
      secondary={{
        label: 'Cancel',
        onClick: onClose,
        disabled: busy,
      }}
    >
      <div
        className="ticket-new__canvas"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.defaultPrevented && !busy) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        {error && (
          <p role="alert" className="ticket-notice ticket-notice--error ticket-new__notice--error">
            {error}
          </p>
        )}

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

        <div className="ticket-new__odd-row">
          <input
            type="text"
            aria-label="ODD link"
            className="ui-field ticket-new__odd-input"
            placeholder="ODD path (e.g. odd/tasks/my-feature.md)"
            maxLength={260}
            value={oddPath}
            onChange={(e) => setOddPath(e.target.value)}
          />
        </div>

        <div className="ticket-new__chips">
          <SelectMenu
            disabled={busy}
            label="Status"
            variant="field"
            minWidth={180}
            value={column}
            triggerIcon={<StateGlyph state={column} size={13} />}
            triggerLabel={column}
            rows={COLUMNS.map((col) => ({
              id: col,
              title: col,
              icon: <StateGlyph state={col} size={14} />,
            }))}
            onSelect={(id) => setColumn(id as TicketState)}
          />

          <SelectMenu
            disabled={busy}
            label="Priority"
            variant="field"
            minWidth={180}
            value={priorityLabel}
            triggerIcon={<PriorityGlyph priority={priority} size={13} />}
            triggerLabel={priorityLabel}
            rows={PRIORITY_OPTIONS.map((opt) => ({
              id: opt.id,
              title: opt.title,
              icon: <PriorityGlyph priority={opt.priority} size={14} />,
            }))}
            onSelect={(id) => {
              const match = PRIORITY_OPTIONS.find((opt) => opt.id === id);
              if (match) setPriority(match.priority);
            }}
          />

          <input
            type="text"
            aria-label="Assignee"
            className="ticket-new__chip-input"
            placeholder="Assignee"
            maxLength={160}
            disabled={busy}
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          />

          <SelectMenu
            disabled={busy}
            label="Labels"
            variant="field"
            minWidth={200}
            closeOnSelect={false}
            value=""
            triggerIcon={<TagGlyph size={11} />}
            triggerLabel={labelsLabel}
            rows={availableLabels.map((lbl) => ({
              id: lbl.name,
              title: lbl.name,
              icon: <TagGlyph size={12} />,
              selected: selectedLabels.includes(lbl.name),
            }))}
            onSelect={(name) => {
              setSelectedLabels((prev) =>
                prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]
              );
            }}
          />

          <SelectMenu
            disabled={busy}
            label="Project"
            variant="field"
            minWidth={200}
            value={selectedProject}
            triggerIcon={<FolderGlyph size={11} />}
            triggerLabel={projectLabel}
            rows={availableProjects.map((proj) => ({
              id: proj.id,
              title: proj.name,
              icon: <FolderGlyph size={12} />,
            }))}
            onSelect={setSelectedProject}
          />

          <input
            type="text"
            aria-label="Due date"
            className="ticket-new__chip-input"
            placeholder="Due YYYY-MM-DD"
            maxLength={10}
            disabled={busy}
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </div>
      </div>
    </Sheet>
  );
};
