import { useState, useRef, useEffect, useCallback } from 'react';
import { invokeCommand } from '../../../../lib/ipc';
import { ChatAttachment } from '../types';
import { fileToBase64 } from '../chatSessionUtils';

export function useChatAttachments() {
  const [attachmentsMap, setAttachmentsMap] = useState<Record<string, ChatAttachment[]>>({});
  const attachmentsMapRef = useRef(attachmentsMap);
  attachmentsMapRef.current = attachmentsMap;

  useEffect(() => {
    return () => {
      for (const [threadId, items] of Object.entries(attachmentsMapRef.current)) {
        for (const item of items) {
          void invokeCommand('release_chat_attachment', { threadId, resourceId: item.resourceId });
        }
      }
    };
  }, []);

  const writeAttachments = useCallback((threadId: string, items: ChatAttachment[]) => {
    const next = { ...attachmentsMapRef.current, [threadId]: items };
    attachmentsMapRef.current = next;
    setAttachmentsMap(next);
  }, []);

  const acceptAttachments = useCallback(
    (threadId: string, incoming: ChatAttachment[]) => {
      const valid = incoming.filter((item) => item && item.resourceId);
      if (valid.length === 0) return;
      const current = attachmentsMapRef.current[threadId] || [];
      const room = Math.max(0, 16 - current.length);
      for (const extra of valid.slice(room)) {
        void invokeCommand('release_chat_attachment', { threadId, resourceId: extra.resourceId });
      }
      writeAttachments(threadId, [...current, ...valid.slice(0, room)]);
    },
    [writeAttachments]
  );

  const handlePickAttachments = useCallback(
    async (threadId: string, kind: 'files' | 'folder' = 'files') => {
      try {
        const picked = await invokeCommand<ChatAttachment[]>('pick_chat_attachments', {
          threadId,
          kind,
        });
        if (Array.isArray(picked)) {
          acceptAttachments(threadId, picked);
        }
      } catch (err) {
        console.error('[ChatView] pick_chat_attachments failed:', err);
      }
    },
    [acceptAttachments]
  );

  const handleStageFiles = useCallback(
    async (threadId: string, files: File[]) => {
      const staged: ChatAttachment[] = [];
      for (const file of files.slice(0, 16)) {
        if (file.size > 10 * 1024 * 1024) continue;
        try {
          const dataBase64 = await fileToBase64(file);
          const item = await invokeCommand<ChatAttachment | null>('stage_chat_blob', {
            threadId,
            displayName: file.name || 'attachment',
            mimeType: (file.type || 'application/octet-stream').slice(0, 127),
            dataBase64,
          });
          if (item?.resourceId) staged.push(item);
        } catch (err) {
          console.error('[ChatView] stage_chat_blob failed:', err);
        }
      }
      acceptAttachments(threadId, staged);
    },
    [acceptAttachments]
  );

  const stageDroppedAttachments = useCallback(
    async (threadId: string, paths: string[]) => {
      const usable = paths.filter((path) => path.length > 0 && path.length <= 4096).slice(0, 16);
      if (usable.length === 0) return;
      try {
        const staged = await invokeCommand<ChatAttachment[]>('stage_dropped_chat_attachments', {
          threadId,
          paths: usable,
        });
        if (Array.isArray(staged)) {
          acceptAttachments(threadId, staged);
        }
      } catch (err) {
        console.error('[ChatView] stage_dropped_chat_attachments failed:', err);
      }
    },
    [acceptAttachments]
  );

  const handleRemoveAttachment = useCallback(
    async (threadId: string, resourceId: string) => {
      try {
        await invokeCommand('release_chat_attachment', { threadId, resourceId });
      } catch (err) {
        console.error('[ChatView] release_chat_attachment failed:', err);
        return;
      }
      writeAttachments(
        threadId,
        (attachmentsMapRef.current[threadId] || []).filter(
          (item) => item.resourceId !== resourceId
        )
      );
    },
    [writeAttachments]
  );

  return {
    attachmentsMap,
    setAttachmentsMap,
    attachmentsMapRef,
    writeAttachments,
    acceptAttachments,
    handlePickAttachments,
    handleStageFiles,
    stageDroppedAttachments,
    handleRemoveAttachment,
  };
}
