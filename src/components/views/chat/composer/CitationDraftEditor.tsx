import React, { useRef, useLayoutEffect } from 'react';
import { AssistantCitationChip } from '../ChatItemRow';
import {
  composerPartOffset,
  deleteComposerChipKey,
  removeComposerPart,
  replaceComposerCitationComment,
  replaceComposerTextPart,
  splitComposerDraft,
} from '../mentionChip';
import { MentionDraftChip } from './MentionDraftChip';
import { isPlainKey } from './composerTextHelpers';

export interface CitationDraftEditorProps {
  prompt: string;
  onChange: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onCopy: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  pendingCaret: number | null;
  onPendingCaretApplied: () => void;
  onCaret: (caret: number) => void;
  onDraftCaret: (caret: number) => void;
  caretRef: React.MutableRefObject<{ start: number; end: number }>;
  testId?: string;
}

export function CitationDraftEditor({
  prompt,
  onChange,
  onKeyDown,
  onPaste,
  onCopy,
  pendingCaret,
  onPendingCaretApplied,
  onCaret,
  onDraftCaret,
  caretRef,
  testId,
}: CitationDraftEditorProps) {
  const parts = splitComposerDraft(prompt);
  const fields = useRef<Array<HTMLTextAreaElement | null>>([]);

  useLayoutEffect(() => {
    if (pendingCaret === null) return;
    let cursor = 0;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const size = part.kind === 'text' ? part.text.length : part.token.length;
      if (part.kind === 'text' && pendingCaret <= cursor + size) {
        const field = fields.current[index];
        const local = Math.max(0, pendingCaret - cursor);
        field?.focus();
        field?.setSelectionRange(local, local);
        caretRef.current = { start: cursor + local, end: cursor + local };
        break;
      }
      cursor += size;
    }
    onPendingCaretApplied();
  }, [caretRef, onPendingCaretApplied, parts, pendingCaret]);

  return (
    <div className="kite-composer-draft">
      {parts.map((part, index) => {
        if (part.kind === 'citation') {
          return (
            <AssistantCitationChip
              key={`cite-${index}-${part.citation.comment}`}
              citation={part.citation}
              token={part.token}
              onEditComment={(comment) => onChange(replaceComposerCitationComment(prompt, index, comment))}
              onRemove={() => {
                const caret = composerPartOffset(parts, index);
                caretRef.current = { start: caret, end: caret };
                onCaret(caret);
                onDraftCaret(caret);
                onChange(removeComposerPart(prompt, index));
              }}
            />
          );
        }
        if (part.kind === 'mention') {
          return (
            <MentionDraftChip
              key={`mention-${index}-${part.mention.kind}-${part.mention.id}`}
              mention={part.mention}
              token={part.token}
              onRemove={() => {
                const caret = composerPartOffset(parts, index);
                caretRef.current = { start: caret, end: caret };
                onCaret(caret);
                onDraftCaret(caret);
                onChange(removeComposerPart(prompt, index));
              }}
            />
          );
        }
        const offset = composerPartOffset(parts, index);
        return (
          <textarea
            key={`text-${index}`}
            ref={(node) => {
              fields.current[index] = node;
            }}
            data-testid={index === 0 ? testId : undefined}
            className="kite-composer-textarea kite-composer-draft__text"
            value={part.text}
            rows={1}
            onSelect={(event) => {
              const start = offset + (event.currentTarget.selectionStart ?? 0);
              const end = offset + (event.currentTarget.selectionEnd ?? start);
              caretRef.current = { start, end };
              onDraftCaret(start);
            }}
            onChange={(event) => {
              const local = event.target.selectionStart ?? event.target.value.length;
              const nextCaret = offset + local;
              caretRef.current = { start: nextCaret, end: nextCaret };
              onDraftCaret(nextCaret);
              onChange(replaceComposerTextPart(prompt, index, event.target.value));
            }}
            onKeyDown={(event) => {
              const localStart = event.currentTarget.selectionStart ?? 0;
              const localEnd = event.currentTarget.selectionEnd ?? localStart;
              const draftStart = offset + localStart;
              const draftEnd = offset + localEnd;
              caretRef.current = { start: draftStart, end: draftEnd };
              onDraftCaret(draftStart);
              if ((event.key === 'Backspace' || event.key === 'Delete') && isPlainKey(event)) {
                const deleted = deleteComposerChipKey(prompt, draftStart, draftEnd, event.key);
                if (deleted) {
                  event.preventDefault();
                  caretRef.current = { start: deleted.caret, end: deleted.caret };
                  onCaret(deleted.caret);
                  onDraftCaret(deleted.caret);
                  onChange(deleted.text);
                  return;
                }
              }
              onKeyDown(event);
            }}
            onPaste={onPaste}
            onCopy={onCopy}
          />
        );
      })}
    </div>
  );
}
