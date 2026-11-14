import type {
  SubagentRun,
  SwarmBoardPost,
  SwarmChannel,
  SwarmMember,
} from '../../../types';
import { formatShortModelLabel } from '../../../lib/subagentNav';
import type { SelectMenuRow } from '../../ui/SelectMenu';

export type SwarmTab = 'feed' | 'roster' | 'graph';

export interface ParsedMentionEdge {
  seq: number;
  from: string;
  to: string;
  channel: string;
  isStall: boolean;
}

export interface SwarmGraphData {
  postCountByAuthor: Map<string, number>;
  edges: ParsedMentionEdge[];
  stallPosts: SwarmBoardPost[];
  batonHolder: string | null;
}

export const TOKEN_SPLIT_RE = /(@#?[A-Za-z0-9_.-]+|#\d+\b)/g;

export const KEEP_PROVIDER_VALUE = '__keep__';

export const SWARM_PROVIDER_OPTIONS: SelectMenuRow[] = [
  { id: KEEP_PROVIDER_VALUE, title: 'keep provider' },
  { id: 'antigravity', title: 'antigravity' },
  { id: 'claude', title: 'claude' },
  { id: 'codex', title: 'codex' },
  { id: 'cursor', title: 'cursor' },
  { id: 'gemini', title: 'gemini' },
  { id: 'grok', title: 'grok' },
  { id: 'opencode', title: 'opencode' },
];

export function formatInspectorModelName(
  model?: string | null,
  provider?: string | null,
): string {
  const m = (model ?? '').trim();
  const lower = m.toLowerCase();
  const claudeMatch = lower.match(/claude-(opus|sonnet|haiku)-(\d+)[-.](\d+)/);
  if (claudeMatch) {
    const family = claudeMatch[1].charAt(0).toUpperCase() + claudeMatch[1].slice(1);
    return `${family} ${claudeMatch[2]}.${claudeMatch[3]}`;
  }
  const geminiMatch = lower.match(/^gemini-(\d+(?:\.\d+)?)-([a-z-]+)$/);
  if (geminiMatch) {
    const tier = geminiMatch[2]
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
    return `Gemini ${geminiMatch[1]} ${tier}`;
  }
  return formatShortModelLabel(model, provider) || provider || 'Default';
}

export function formatPostTime(unixMs?: number | null): string {
  if (!unixMs || !Number.isFinite(unixMs)) return '';
  try {
    return new Date(unixMs).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

export function memberStateDescription(
  member: SwarmMember,
  matchedRun?: SubagentRun,
): { dotClass: string; label: string } {
  const state = (member.state ?? 'waiting').toLowerCase();
  if (state === 'working') {
    const activity =
      member.currentActivity?.trim() ||
      matchedRun?.latestActivity?.trim() ||
      'Working';
    return { dotClass: 'swarm-state-dot--working', label: activity };
  }
  if (state === 'stopped') {
    return {
      dotClass: 'swarm-state-dot--stopped',
      label: 'Stopped (wakes on @mention)',
    };
  }
  if (state === 'killed') {
    return { dotClass: 'swarm-state-dot--killed', label: 'Killed' };
  }
  return {
    dotClass: 'swarm-state-dot--waiting',
    label: 'Sleeping on board (0 tokens)',
  };
}

export function buildSwarmChannels(
  swarmChannels: SwarmChannel[] | undefined,
  posts: SwarmBoardPost[],
): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const ch of swarmChannels ?? []) {
    const name = ch.name.replace(/^#/, '');
    if (name && !seen.has(name)) {
      seen.add(name);
      list.push(name);
    }
  }
  for (const post of posts) {
    const name = (post.channel ?? '').replace(/^#/, '');
    if (name && !seen.has(name)) {
      seen.add(name);
      list.push(name);
    }
  }
  if (!seen.has('main')) list.unshift('main');
  return list;
}

export function buildSwarmGraphData(
  posts: SwarmBoardPost[],
  members: SwarmMember[],
): SwarmGraphData {
  const postCountByAuthor = new Map<string, number>();
  const edges: ParsedMentionEdge[] = [];
  const stallPosts: SwarmBoardPost[] = [];
  let batonHolder: string | null = null;

  for (const post of posts) {
    const author = post.author || 'coordinator';
    postCountByAuthor.set(author, (postCountByAuthor.get(author) ?? 0) + 1);
    const isStall = /\[stall\]/i.test(post.text);
    if (isStall) stallPosts.push(post);

    const matches = post.text.match(/@#?[A-Za-z0-9_.-]+/g) ?? [];
    for (const rawTarget of matches) {
      const cleanTarget = rawTarget.replace(/^@#?/, '');
      if (cleanTarget.toLowerCase() === 'all') continue;
      edges.push({
        seq: post.seq,
        from: `@${author}`,
        to: `@${cleanTarget}`,
        channel: (post.channel ?? 'main').replace(/^#/, ''),
        isStall,
      });
      batonHolder = `@${cleanTarget}`;
    }
  }

  const activeWorker = members.find((m) => (m.state ?? '').toLowerCase() === 'working');
  if (activeWorker) {
    batonHolder = `@${activeWorker.name}`;
  }

  return { postCountByAuthor, edges, stallPosts, batonHolder };
}
