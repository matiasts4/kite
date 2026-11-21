import type { ChatItem, SubagentRun } from '../../../types';
import type { OpenRightDockSubagentDetail } from '../../../lib/subagentNav';
import { isInternalDispatchItem } from '../chat/chatItemHelpers';
import {
  humanizeActivityText,
  isRawDispatchCommand,
  plainPreviewLine,
  structuredReportToMarkdown,
} from '../chat/subagentRunHelpers';

export type InspectorMode = 'subagent' | 'swarm';
export type InspectorScope = 'thread' | 'all';

export function isRunBlocked(status?: string | null): boolean {
  const s = (status ?? '').toLowerCase();
  return s === 'waiting' || s === 'needsinput' || s === 'pendingapproval' || s === 'blocked';
}

export function isRunActive(status?: string | null): boolean {
  const s = (status ?? '').toLowerCase();
  return s === 'running' || s === 'queued' || s === 'pending' || s === 'inprogress' || s === 'in_progress' || isRunBlocked(s);
}

export function runStatusPriority(status?: string | null, hasPendingApproval?: boolean): number {
  if (hasPendingApproval || isRunBlocked(status)) return 0;
  if (isRunActive(status)) return 1;
  return 2;
}

export function sortRunsForOverview(runs: SubagentRun[]): SubagentRun[] {
  return [...runs].sort((a, b) => {
    const pDiff = runStatusPriority(a.status) - runStatusPriority(b.status);
    if (pDiff !== 0) return pDiff;
    const aTime = a.updatedAtUnixMs || a.startedAtUnixMs || 0;
    const bTime = b.updatedAtUnixMs || b.startedAtUnixMs || 0;
    return bTime - aTime;
  });
}

export function resolveRequestedRunId(
  target?: OpenRightDockSubagentDetail | null,
): string | null {
  if (!target) return null;
  if (target.subagentId && target.subagentId.trim()) return target.subagentId;
  if (target.childThreadId && target.childThreadId.trim()) return target.childThreadId;
  return null;
}

export function cleanRunPreviewText(run: SubagentRun): string {
  const rawActivity = isRawDispatchCommand(run.latestActivity)
    ? ''
    : humanizeActivityText(run.latestActivity);
  const rawPrompt = isRawDispatchCommand(run.prompt) ? '' : run.prompt || '';
  return plainPreviewLine(rawActivity || rawPrompt);
}

/**
 * Produces a distinguishable display title for a subagent run so generic
 * `"Subagent"` fallbacks include a concise task/error excerpt when available.
 */
export function formatSubagentDisplayTitle(run: SubagentRun): string {
  const rawRole = (run.role ?? '').trim();
  if (rawRole && rawRole.toLowerCase() !== 'subagent') {
    return rawRole;
  }
  const swarmMember = (run.swarmMemberName ?? '').trim();
  if (swarmMember) {
    return `@${swarmMember}`;
  }
  const typeName = (run.typeName ?? '').trim();
  if (typeName && typeName.toLowerCase() !== (run.provider ?? '').trim().toLowerCase() && typeName.toLowerCase() !== 'subagent') {
    return typeName.charAt(0).toUpperCase() + typeName.slice(1);
  }
  const rawPrompt = isRawDispatchCommand(run.prompt) ? '' : plainPreviewLine(run.prompt);
  const excerptSource = rawPrompt || cleanRunPreviewText(run);
  if (excerptSource) {
    const clipped = excerptSource.length > 36 ? `${excerptSource.slice(0, 35).trimEnd()}…` : excerptSource;
    return clipped;
  }
  return 'Subagent';
}

/** True when a failed run has no recorded steps or backing transcript/thread. */
export function isZeroStepFailedRun(run: SubagentRun): boolean {
  const s = (run.status ?? '').toLowerCase();
  if (s !== 'failed' && s !== 'error') return false;
  const steps = run.stepCount ?? run.items?.length ?? 0;
  return steps === 0 && !run.childThreadId && !run.transcriptUri;
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
    if (isInternalDispatchItem(item)) return false;
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
  }).map(readableAssistantItem);
}

/** A reply that is only a JSON payload (e.g. a verifier report) renders as formatted text. */
function readableAssistantItem(item: ChatItem): ChatItem {
  if (item.kind !== 'assistant') return item;
  const markdown = structuredReportToMarkdown(item.text);
  return markdown ? { ...item, text: markdown } : item;
}
