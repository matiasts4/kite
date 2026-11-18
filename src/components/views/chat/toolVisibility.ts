import type { ChatItem } from '../../../types';
import { isInternalDispatchItem, visibleAssistantText } from './chatItemHelpers';

export type ToolVisibilityMode = 'show-all' | 'hide-successful' | 'hide-all' | 'zen';

export const TOOL_VISIBILITY_KEY = 'kite_tool_visibility';
export const TOOL_VISIBILITY_EVENT = 'kite:tool-visibility';

const MODES: ToolVisibilityMode[] = ['show-all', 'hide-successful', 'hide-all', 'zen'];

export function isToolVisibilityMode(value: string | null | undefined): value is ToolVisibilityMode {
  return MODES.includes(value as ToolVisibilityMode);
}

export function readToolVisibility(): ToolVisibilityMode {
  try {
    const raw = localStorage.getItem(TOOL_VISIBILITY_KEY);
    return isToolVisibilityMode(raw) ? raw : 'show-all';
  } catch {
    return 'show-all';
  }
}

export function writeToolVisibility(mode: ToolVisibilityMode): void {
  try {
    localStorage.setItem(TOOL_VISIBILITY_KEY, mode);
  } catch {
    // The in-memory listener still applies the choice for this session.
  }
  window.dispatchEvent(new CustomEvent(TOOL_VISIBILITY_EVENT, { detail: mode }));
}

function alwaysVisible(item: ChatItem): boolean {
  if (item.kind === 'error' || item.kind === 'user' || item.kind === 'note' || item.kind === 'quotaHandoff') {
    return true;
  }
  return item.status === 'pending' || item.status === 'failed';
}

function successfulTool(item: ChatItem): boolean {
  if (item.kind !== 'tool' && item.kind !== 'command') return false;
  if (item.streaming || item.status === 'running' || item.status === 'inProgress' || item.status === 'pending') {
    return false;
  }
  if (item.status === 'failed') return false;
  if (item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0) return false;
  return true;
}

/** Applies Settings → Chat visibility. Approvals, questions, and errors stay. */
export function filterTranscriptForVisibility(items: ChatItem[], mode: ToolVisibilityMode): ChatItem[] {
  const visibleItems = items.filter((item) => !isInternalDispatchItem(item));
  if (mode === 'show-all') return visibleItems;
  if (mode === 'hide-successful') {
    return visibleItems.filter((item) => alwaysVisible(item) || !successfulTool(item));
  }
  if (mode === 'hide-all') {
    return visibleItems.filter((item) => {
      if (alwaysVisible(item)) return true;
      return item.kind !== 'tool' && item.kind !== 'command' && item.kind !== 'reasoning';
    });
  }
  const lastAssistant = [...visibleItems]
    .reverse()
    .find((item) => item.kind === 'assistant' && visibleAssistantText(item.text).trim().length > 0);
  return visibleItems.filter((item) => {
    if (item.kind !== 'assistant') return true;
    return item.id === lastAssistant?.id;
  });
}
