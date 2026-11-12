import {
  mentionChipLabel,
  writeMentionClipboard,
  type MentionPayload,
} from '../mentionChip';

export interface MentionDraftChipProps {
  mention: MentionPayload;
  token: string;
  onRemove: () => void;
}

export function MentionDraftChip({
  mention,
  token,
  onRemove,
}: MentionDraftChipProps) {
  return (
    <span
      className="citation-chip rounded-sm"
      contentEditable={false}
      data-mention-token={token}
      data-mention-kind={mention.kind}
      onCopy={(event) => {
        event.preventDefault();
        event.stopPropagation();
        writeMentionClipboard(event.clipboardData, token);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Backspace' || event.key === 'Delete') {
          event.preventDefault();
          onRemove();
        }
      }}
    >
      <span className="citation-chip__jump">{mentionChipLabel(mention)}</span>
    </span>
  );
}
