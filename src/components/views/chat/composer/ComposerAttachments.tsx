import React from 'react';
import { CloseIcon, FileCodeIcon } from '../ChatIcons';
import { formatBytes, type ChatAttachment } from '../types';

export interface ComposerAttachmentsProps {
  attachments: ChatAttachment[];
  onRemoveAttachment: (resourceId: string) => void;
}

export const ComposerAttachments: React.FC<ComposerAttachmentsProps> = ({
  attachments,
  onRemoveAttachment,
}) => {
  if (attachments.length === 0) return null;

  return (
    <div className="kite-composer-attachments">
      {attachments.map((att) => (
        <div key={att.resourceId} className="kite-composer-attachment-chip">
          <FileCodeIcon size={13} className="text-muted-foreground shrink-0" />
          <span title={att.displayName}>{att.displayName}</span>
          {att.byteSize && (
            <span className="text-2xs opacity-60 shrink-0">
              {formatBytes(att.byteSize)}
            </span>
          )}
          <button
            type="button"
            onClick={() => onRemoveAttachment(att.resourceId)}
            title="Remove attachment"
            className="size-4 rounded-xs inline-flex items-center justify-center text-muted-foreground hover:text-foreground border-0 bg-transparent cursor-pointer ml-0.5"
          >
            <CloseIcon size={11} />
          </button>
        </div>
      ))}
    </div>
  );
};
