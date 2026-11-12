import type { KeyboardEvent } from 'react';
import type { ChatItem } from '../../../../types';

export function extractUserPromptHistory(items: ChatItem[] = []): string[] {
  const result: string[] = [];
  for (const item of items) {
    if (item.kind !== 'user') continue;
    const text = item.text?.trim() ?? '';
    if (text.length !== 0 && result[result.length - 1] !== text) {
      result.push(text);
    }
  }
  return result;
}

export function getNextHistoryIndex(
  length: number,
  currentIndex: number | null,
  direction: 'older' | 'newer'
): number | null | undefined {
  if (length === 0) return undefined;
  if (direction === 'older') {
    return currentIndex === null ? length - 1 : currentIndex > 0 ? currentIndex - 1 : undefined;
  }
  if (currentIndex !== null) {
    return currentIndex + 1 < length ? currentIndex + 1 : null;
  }
  return undefined;
}

export function isNoNewlineBefore(text: string, pos: number): boolean {
  return !text.slice(0, pos).includes('\n');
}

export function isNoNewlineAfter(text: string, pos: number): boolean {
  return !text.slice(pos).includes('\n');
}

export function isPlainKey(e: KeyboardEvent): boolean {
  return !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey;
}
