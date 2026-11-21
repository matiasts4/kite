import React, { useEffect, useState } from 'react';
import { invokeCommand, isTauriEnvironment } from '../../../lib/ipc';
import type { ChatAttachment } from './types';

export const MAX_ATTACHMENT_PREVIEW_CACHE = 32;

const previewCache = new Map<string, string>();
const inflightRequests = new Map<string, Promise<string | null>>();

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;

export function isImageAttachment(
  att: Pick<ChatAttachment, 'mimeType' | 'displayName' | 'isDirectory'>
): boolean {
  if (att.isDirectory) return false;
  if (att.mimeType?.toLowerCase().startsWith('image/')) return true;
  if (att.displayName && IMAGE_EXT_RE.test(att.displayName)) return true;
  return false;
}

function revokeIfBlobUrl(url: string | undefined): void {
  if (url && url.startsWith('blob:') && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    try {
      URL.revokeObjectURL(url);
    } catch {}
  }
}

export function seedAttachmentPreview(resourceId: string, url: string): void {
  if (!resourceId || !url) return;
  const existing = previewCache.get(resourceId);
  if (existing && existing !== url) {
    revokeIfBlobUrl(existing);
  }
  previewCache.delete(resourceId);
  previewCache.set(resourceId, url);
  while (previewCache.size > MAX_ATTACHMENT_PREVIEW_CACHE) {
    const oldestKey = previewCache.keys().next().value;
    if (oldestKey === undefined) break;
    const evicted = previewCache.get(oldestKey);
    previewCache.delete(oldestKey);
    revokeIfBlobUrl(evicted);
  }
}

export function getCachedAttachmentPreview(resourceId: string): string | null {
  const existing = previewCache.get(resourceId);
  if (!existing) return null;
  previewCache.delete(resourceId);
  previewCache.set(resourceId, existing);
  return existing;
}

export function releaseAttachmentPreview(resourceId: string): void {
  const existing = previewCache.get(resourceId);
  if (existing) {
    previewCache.delete(resourceId);
    revokeIfBlobUrl(existing);
  }
  inflightRequests.delete(resourceId);
}

export function clearAttachmentPreviewCache(): void {
  for (const url of previewCache.values()) {
    revokeIfBlobUrl(url);
  }
  previewCache.clear();
  inflightRequests.clear();
}

export function useAttachmentPreview(
  att: Partial<ChatAttachment> & { resourceId?: string; displayName?: string; path?: string | null },
  threadId?: string | null
): string | null {
  const inlinePreview = att.previewDataUrl || null;
  const resourceId = att.resourceId || '';
  const shouldFetch = !inlinePreview && Boolean(resourceId) && isImageAttachment({
    mimeType: att.mimeType,
    displayName: att.displayName || '',
    isDirectory: Boolean(att.isDirectory),
  });

  const [resolved, setResolved] = useState<string | null>(() => {
    if (inlinePreview) return inlinePreview;
    if (resourceId) return getCachedAttachmentPreview(resourceId);
    return null;
  });

  useEffect(() => {
    if (inlinePreview) {
      setResolved(inlinePreview);
      return;
    }
    if (!shouldFetch || !resourceId) {
      setResolved(null);
      return;
    }
    const cached = getCachedAttachmentPreview(resourceId);
    if (cached) {
      setResolved(cached);
      return;
    }
    if (!isTauriEnvironment()) return;

    let cancelled = false;
    let req = inflightRequests.get(resourceId);
    if (!req) {
      req = invokeCommand<string | null>('read_chat_attachment_preview', {
        threadId: threadId || undefined,
        resourceId,
        path: att.path || undefined,
      })
        .then((url) => {
          inflightRequests.delete(resourceId);
          if (typeof url === 'string' && url.length > 0) {
            seedAttachmentPreview(resourceId, url);
            return url;
          }
          return null;
        })
        .catch(() => {
          inflightRequests.delete(resourceId);
          return null;
        });
      inflightRequests.set(resourceId, req);
    }

    void req.then((url) => {
      if (!cancelled && url) {
        setResolved(url);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [inlinePreview, shouldFetch, resourceId, threadId, att.path]);

  return inlinePreview ?? resolved;
}

export interface AttachmentPreviewThumbProps {
  attachment: Partial<ChatAttachment> & { resourceId?: string; displayName?: string; path?: string | null };
  threadId?: string | null;
  alt: string;
  className: string;
  fallback: React.ReactNode;
}

export const AttachmentPreviewThumb: React.FC<AttachmentPreviewThumbProps> = ({
  attachment,
  threadId,
  alt,
  className,
  fallback,
}) => {
  const src = useAttachmentPreview(attachment, threadId);
  if (!src) return <>{fallback}</>;
  return <img src={src} alt={alt} className={className} />;
};
