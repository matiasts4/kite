import { queueVisibleRows } from './composerPrimaryAction';
import { CloseIcon, PencilIcon } from './ChatIcons';

export interface QueuedRunRow {
  id: string;
  text: string;
}

export function QueuedRunsControl({
  rows,
  expanded,
  editingId,
  onToggle,
  onSendNow,
  onEdit,
  onRemove,
}: {
  rows: QueuedRunRow[];
  expanded: boolean;
  editingId?: string | null;
  onToggle: () => void;
  onSendNow: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  if (rows.length === 0) return null;
  const { visible, hidden } = queueVisibleRows(rows, expanded);
  return (
    <section className="queued-runs" aria-label="Queued messages">
      {visible.map((row) => (
        <article
          key={row.id}
          className={`queued-runs__card${editingId === row.id ? ' queued-runs__card--editing' : ''}`}
        >
          <p>{row.text}</p>
          <div className="queued-runs__actions">
            <button type="button" onClick={() => onSendNow(row.id)}>
              Send now
            </button>
            <button type="button" aria-label="Edit" onClick={() => onEdit(row.id)}>
              <PencilIcon size={12} />
            </button>
            <button type="button" aria-label="Remove" onClick={() => onRemove(row.id)}>
              <CloseIcon size={12} />
            </button>
          </div>
        </article>
      ))}
      {hidden > 0 ? (
        <button type="button" onClick={onToggle}>
          Show {hidden} more
        </button>
      ) : null}
    </section>
  );
}
