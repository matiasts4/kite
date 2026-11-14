import type { ChatItem } from '../../../types';

export type InspectorMode = 'subagent' | 'swarm';

export function isRunBlocked(status?: string | null): boolean {
  const s = (status ?? '').toLowerCase();
  return s === 'waiting' || s === 'needsinput' || s === 'blocked';
}

export function isRunActive(status?: string | null): boolean {
  const s = (status ?? '').toLowerCase();
  return s === 'running' || s === 'queued' || s === 'pending' || isRunBlocked(s);
}

export function runStatusDotClass(status?: string | null): string {
  const s = (status ?? '').toLowerCase();
  if (isRunBlocked(s)) return 'subagent-dot--waiting';
  if (isRunActive(s)) return 'subagent-dot--running';
  if (s === 'completed' || s === 'done' || s === 'ok') return 'subagent-dot--completed';
  if (s === 'failed' || s === 'error' || s === 'killed') return 'subagent-dot--failed';
  return '';
}

export function settledPrefixLabel(status?: string | null): string {
  const s = (status ?? 'completed').toLowerCase();
  if (s === 'failed' || s === 'error') return 'Failed';
  if (s === 'killed' || s === 'cancelled') return 'Killed';
  if (s === 'completed' || s === 'done' || s === 'ok') return 'Completed';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function filterInspectorSteps(
  items?: ChatItem[] | null,
  initialPrompt?: string | null,
): ChatItem[] {
  if (!items || items.length === 0) return [];
  const promptTrim = (initialPrompt ?? '').trim();
  return items.filter((item, idx) => {
    const rawKind = String(item.kind ?? '');
    if (rawKind === 'notice' || rawKind === 'note') return false;
    if (item.kind === 'user') {
      const text = (item.text ?? '').trim();
      if (
        idx === 0 ||
        text.startsWith('[Subagent Role:') ||
        (promptTrim.length > 0 && text === promptTrim)
      ) {
        return false;
      }
    }
    if (item.kind === 'reasoning' && !(item.text ?? '').trim()) return false;
    return true;
  });
}
