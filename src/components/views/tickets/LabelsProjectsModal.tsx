import React, { useState } from 'react';
import { Sheet } from '../../ui/Sheet';
import { TicketLabel, TicketProject, getLabelColor } from './types';

export interface LabelsProjectsModalProps {
  labels: TicketLabel[];
  projects: TicketProject[];
  busy?: boolean;
  onAddLabel: (name: string) => Promise<boolean>;
  onAddProject: (name: string) => Promise<boolean>;
  onClose: () => void;
}

interface MetadataColumnProps {
  title: string;
  kind: 'label' | 'project';
  items: Array<{ id: string; name: string; color?: string }>;
  busy: boolean;
  onAdd: (name: string) => Promise<boolean>;
}

const MetadataColumn: React.FC<MetadataColumnProps> = ({
  title,
  kind,
  items,
  busy,
  onAdd,
}) => {
  const [text, setText] = useState('');

  const handleSubmit = async () => {
    if (busy || !text.trim()) return;
    const ok = await onAdd(text.trim());
    if (ok) {
      setText('');
    }
  };

  return (
    <section aria-label={title} className="ticket-metadata__column">
      <h2>{title}</h2>
      <ul className="ticket-metadata__list">
        {items.length === 0 ? (
          <li className="ticket-metadata__empty">None yet.</li>
        ) : null}
        {items.map((item) => (
          <li key={item.id}>
            {item.color ? (
              <span
                aria-hidden="true"
                className="ticket-pill__dot"
                style={{ background: item.color }}
              />
            ) : null}
            {item.name}
          </li>
        ))}
      </ul>
      <div className="ticket-metadata__add">
        <input
          aria-label={`New ${kind}`}
          className="ui-field"
          maxLength={160}
          placeholder={`New ${kind}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
        />
        <button
          type="button"
          className="secondary-button action-button--row"
          disabled={busy || !text.trim()}
          onClick={() => void handleSubmit()}
        >
          Add
        </button>
      </div>
    </section>
  );
};

export const LabelsProjectsModal: React.FC<LabelsProjectsModalProps> = ({
  labels,
  projects,
  busy = false,
  onAddLabel,
  onAddProject,
  onClose,
}) => {
  return (
    <Sheet
      open={true}
      onCancel={onClose}
      title="Labels & projects"
      width={560}
      className="ticket-sheet ticket-metadata"
    >
      <div
        className="ticket-sheet__content"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.defaultPrevented) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <button
          type="button"
          className="secondary-button action-button--row ticket-sheet__done"
          onClick={onClose}
        >
          Done
        </button>
        <div className="ticket-metadata__columns">
          <MetadataColumn
            title="Labels"
            kind="label"
            busy={busy}
            items={labels.map((l) => ({
              id: l.id,
              name: l.name,
              color: getLabelColor(l.name),
            }))}
            onAdd={onAddLabel}
          />
          <MetadataColumn
            title="Projects"
            kind="project"
            busy={busy}
            items={projects.map((p) => ({
              id: p.id,
              name: p.name,
            }))}
            onAdd={onAddProject}
          />
        </div>
      </div>
    </Sheet>
  );
};
