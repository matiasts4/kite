import type { AgentProfile } from '../../../types';

export interface LearnedSkillSummary {
  id: string;
  name: string;
  description: string;
  updatedAtUnixMs: number;
  revision: string;
  uses: number;
  lastUsed: string | null;
  lastOutcome: string | null;
}

export interface LearnedSkillDocument extends LearnedSkillSummary {
  schemaVersion: number;
  source: string;
}

export interface AgentMindSnapshot {
  schemaVersion: number;
  agentId: string;
  memory: string;
  user: string;
  skills: LearnedSkillSummary[];
  memoryUpdatedAtUnixMs: number | null;
  userUpdatedAtUnixMs: number | null;
  memoryRevision: string | null;
  userRevision: string | null;
  readIssues: Array<{ code: string; skillId: string | null; rawRevision: string | null }>;
}

export interface StarterSummary {
  id: string;
  title: string;
  summary: string;
}

export interface FullAgentProfile extends AgentProfile {
  brief?: string;
  defaultMode?: string | null;
  defaultPlan?: boolean;
  defaultModel?: string | null;
  memoryBudget?: number | null;
  reflectionMode?: string;
  allowAgentScheduling?: boolean;
  allowAgentMessaging?: boolean;
  placeDisplayNames?: string[];
}

export type TabType = 'memory' | 'skills' | 'starters' | 'settings';
export type MemoryTarget = 'memory' | 'user';

export const MEMORY_DELIMITER = '\n§\n';

export function parseMemoryEntries(text: string): string[] {
  if (!text || text.trim().length === 0) return [];
  if (text.includes(MEMORY_DELIMITER)) {
    return text
      .split(MEMORY_DELIMITER)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*+]\s+/, ''))
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export function parseHeadingAndBody(entry: string): { heading: string | null; body: string } {
  for (const sep of [' — ', ' – ', ' - ']) {
    const idx = entry.indexOf(sep);
    if (idx > 0) {
      const heading = entry.slice(0, idx).trim();
      const body = entry.slice(idx + sep.length).trim();
      if (heading.length > 0 && heading.length <= 24 && heading.split(/\s+/).length <= 4 && body.length > 0) {
        return { heading, body };
      }
    }
  }
  return { heading: null, body: entry };
}

export interface ClusteredEntry {
  index: number;
  text: string;
  heading: string | null;
  body: string;
}

export interface EntryCluster {
  heading: string | null;
  entries: ClusteredEntry[];
}

export function clusterMemory(entries: string[]): EntryCluster[] {
  const clusters: EntryCluster[] = [];
  for (let i = 0; i < entries.length; i++) {
    const text = entries[i];
    const { heading, body } = parseHeadingAndBody(text);
    const clusteredEntry: ClusteredEntry = { index: i, text, heading, body };

    const lastCluster = clusters[clusters.length - 1];
    if (lastCluster && lastCluster.heading === heading) {
      lastCluster.entries.push(clusteredEntry);
    } else {
      clusters.push({ heading, entries: [clusteredEntry] });
    }
  }
  return clusters;
}

export function formatRelativeAge(timestampMs: number): string {
  if (!timestampMs || timestampMs <= 0) return 'recently';
  const diffSec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDays = Math.floor(diffHour / 24);
  return `${diffDays}d ago`;
}

export const SUPPORTED_ENGINES = [
  { id: 'antigravity', name: 'Antigravity', provider: 'Google DeepMind' },
  { id: 'claude-code', name: 'Claude Code', provider: 'Anthropic' },
  { id: 'codex', name: 'Codex CLI', provider: 'OpenAI' },
  { id: 'cursor', name: 'Cursor', provider: 'Anysphere' },
  { id: 'grok', name: 'Grok CLI', provider: 'xAI' },
  { id: 'open-code', name: 'OpenCode', provider: 'Community' },
  { id: 'gemini', name: 'Gemini', provider: 'Google' },
];
