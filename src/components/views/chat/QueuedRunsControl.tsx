import { queueVisibleRows } from './composerPrimaryAction';
import { CloseIcon, FileCodeIcon, PencilIcon } from './ChatIcons';
import { AttachmentPreviewThumb } from './attachmentPreview';
import { formatBytes, type ChatAttachment } from './types';

export interface QueuedRunRow {
  id: string;
  text: string;
  attachments?: ChatAttachment[];
  createdAtUnixMs?: number;
}

export function QueuedRunsControl({
  rows,
  expanded,
  editingId,
  onToggle,
  onSendNow,
  onEdit,
  onCancelEdit,
  onRemove,
}: {
  rows: QueuedRunRow[];
  expanded: boolean;
  editingId?: string | null;
  onToggle: () => void;
  onSendNow: (id: string) => void;
  onEdit: (id: string) => void;
  onCancelEdit?: () => void;
  onRemove: (id: string) => void;
}) {
  if (rows.length === 0) return null;
  const { visible, hidden } = queueVisibleRows(rows, expanded);
  return (
    <section className="queued-runs" aria-label="Queued messages">
      <div className="queued-runs__header">
        <span className="queued-runs__title">
          Queued ({rows.length})
        </span>
        {(hidden > 0 || (expanded && rows.length > 3)) && (
          <button
            type="button"
            className="queued-runs__toggle"
            onClick={onToggle}
          >
            {hidden > 0 ? `Show ${hidden} more` : 'Show less'}
          </button>
        )}
      </div>
      {visible.map((row, idx) => {
        const isEditing = editingId === row.id;
        const hasAttachments = Boolean(row.attachments && row.attachments.length > 0);
        return (
          <article
            key={row.id}
            className={`queued-runs__card${isEditing ? ' queued-runs__card--editing' : ''}`}
          >
            <div className="queued-runs__main">
              <div className="queued-runs__meta">
                <span className="queued-runs__badge">
                  {isEditing ? 'Editing' : `#${idx + 1}`}
                </span>
                {row.text ? (
                  <p className="queued-runs__text">{row.text}</p>
                ) : hasAttachments ? (
                  <p className="queued-runs__text queued-runs__text--muted">
                    Attached file(s)
                  </p>
                ) : null}
              </div>
              {hasAttachments && (
                <div className="queued-runs__attachments">
                  {row.attachments!.map((att) => {
                    const name = att.displayName || (att as { name?: string }).name || 'Attachment';
                    const size = att.byteSize || (att as { sizeBytes?: number }).sizeBytes || 0;
                    return (
                      <span key={att.resourceId} className="queued-runs__attachment">
                        <AttachmentPreviewThumb
                          attachment={att}
                          alt={name}
                          className="queued-runs__thumb"
                          fallback={<FileCodeIcon size={11} />}
                        />
                        <span className="queued-runs__attachment-name">{name}</span>
                        {size > 0 ? <small>{formatBytes(size)}</small> : null}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="queued-runs__actions">
              <button
                type="button"
                className="queued-runs__btn queued-runs__btn--primary"
                onClick={() => onSendNow(row.id)}
              >
                Send now
              </button>
              {isEditing && onCancelEdit ? (
                <button
                  type="button"
                  className="queued-runs__btn"
                  title="Cancel edit"
                  onClick={onCancelEdit}
                >
                  Cancel
                </button>
              ) : (
                <button
                  type="button"
                  className="queued-runs__btn queued-runs__btn--icon"
                  aria-label="Edit"
                  title="Edit queued message"
                  onClick={() => onEdit(row.id)}
                >
                  <PencilIcon size={12} />
                </button>
              )}
              <button
                type="button"
                className="queued-runs__btn queued-runs__btn--icon queued-runs__btn--danger"
                aria-label="Remove"
                title="Remove queued message"
                onClick={() => onRemove(row.id)}
              >
                <CloseIcon size={12} />
              </button>
            </div>
          </article>
        );
      })}
    </section>
  );
}
