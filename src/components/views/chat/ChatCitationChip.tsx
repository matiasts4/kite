import { useState } from 'react';
import { PencilIcon } from './ChatIcons';
import {
  citationChipLabel,
  locateCitationSource,
  readableQuoteWithoutSource,
  revealCitationSource,
  writeCitationClipboard,
  type CitationPayload,
} from './citationChip';

export function AssistantCitationChip({
  citation,
  token,
  onEditComment,
  onRemove,
}: {
  citation: CitationPayload;
  token: string;
  onEditComment?: (comment: string) => void;
  onRemove?: () => void;
}) {
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftComment, setDraftComment] = useState(citation.comment);
  const label = citationChipLabel(citation);

  const activate = () => {
    const sourcePresent = Boolean(citation.messageId) && locateCitationSource(citation.messageId) !== null;
    if (sourcePresent && revealCitationSource(citation.messageId)) {
      setQuoteOpen(false);
      return;
    }
    setQuoteOpen(true);
  };

  return (
    <span
      className="citation-chip rounded-sm"
      contentEditable={false}
      data-citation-token={token}
      onCopy={(event) => {
        event.preventDefault();
        event.stopPropagation();
        writeCitationClipboard(event.clipboardData, token);
      }}
      onKeyDown={(event) => {
        if ((event.key === 'Backspace' || event.key === 'Delete') && onRemove) {
          event.preventDefault();
          onRemove();
        }
      }}
    >
      <button
        type="button"
        className="citation-chip__jump"
        onMouseDown={(event) => event.preventDefault()}
        onClick={activate}
      >
        {label}
      </button>
      {onEditComment ? (
        <button
          type="button"
          className="citation-chip__edit"
          aria-label="Edit comment"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setDraftComment(citation.comment);
            setEditing((open) => !open);
          }}
        >
          <PencilIcon size={11} />
        </button>
      ) : null}
      {quoteOpen ? (
        <span className="citation-chip__quote" role="dialog" aria-label="Saved quote">
          {readableQuoteWithoutSource(citation)}
        </span>
      ) : null}
      {editing && onEditComment ? (
        <span className="citation-chip__note" role="dialog" aria-label="Edit comment">
          <input
            aria-label="Comment"
            value={draftComment}
            onChange={(event) => setDraftComment(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key !== 'Enter') return;
              event.preventDefault();
              onEditComment(draftComment);
              setEditing(false);
            }}
          />
          <button
            type="button"
            onClick={() => {
              onEditComment(draftComment);
              setEditing(false);
            }}
          >
            Save
          </button>
        </span>
      ) : null}
    </span>
  );
}
