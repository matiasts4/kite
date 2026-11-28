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
  enabled?: boolean;
  manualOnly?: boolean;
  contextMode?: 'inline' | 'fork' | string;
  requiresBins?: string[];
  requiresEnv?: string[];
  eligible?: boolean;
  missingRequirements?: string[];
}

export interface DiscoverableSkill {
  id: string;
  refKey: string;
  name: string;
  description: string;
  scope: 'workspace' | 'global' | string;
  path: string;
  manualOnly: boolean;
  contextMode: 'inline' | 'fork' | string;
  requiresBins: string[];
  requiresEnv: string[];
  eligible: boolean;
  missingRequirements: string[];
}

export interface ReadinessPillar {
  id: string;
  label: string;
  score: number;
  maxScore: number;
  passed: boolean;
  hint: string;
}

export interface LearnedSkillDocument extends LearnedSkillSummary {
  schemaVersion: number;
  source: string;
}

export interface MemoryEntryMeta {
  pinned: boolean;
  archived: boolean;
  lastVerifiedAtUnixMs: number;
}

export interface KnowledgePackDef {
  id: string;
  name: string;
  root: string;
  globs: string[];
  enabled: boolean;
  createdAtUnixMs: number;
}

export interface KnowledgePackIndexEntry {
  packId: string;
  name: string;
  root: string;
  globs: string[];
  indexedAtUnixMs: number;
  fileCount: number;
  chunkCount: number;
}

export interface KnowledgePackSearchMatch {
  packId: string;
  packName: string;
  path: string;
  heading: string;
  lineStart: number;
  lineEnd: number;
  preview: string;
  score: number;
}

export interface KnowledgePackSnapshot {
  agentId: string;
  packs: KnowledgePackDef[];
  entries: KnowledgePackIndexEntry[];
  totalChunks: number;
  manifestPreview: string;
}

export interface AgentMindSnapshot {
  schemaVersion: number;
  agentId: string;
  memory: string;
  user: string;
  skills: LearnedSkillSummary[];
  linkedSkillRefs?: string[];
  memoryUpdatedAtUnixMs: number | null;
  userUpdatedAtUnixMs: number | null;
  memoryRevision: string | null;
  userRevision: string | null;
  memoryMeta?: Record<string, MemoryEntryMeta>;
  readIssues: Array<{ code: string; skillId: string | null; rawRevision: string | null }>;
}

export interface StarterSummary {
  id: string;
  title: string;
  summary: string;
}

export interface KnowledgePackConfig {
  id: string;
  name: string;
  rootPath: string;
  globs: string[];
  enabled: boolean;
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
  toolPolicies?: Record<string, 'allow' | 'ask' | 'deny'>;
  maxTurnsPerRun?: number | null;
  maxDurationSecs?: number | null;
  failoverEngines?: string[];
  knowledgePacks?: KnowledgePackConfig[];
  linkedSkillRefs?: string[];
}

export interface PlaybookStage {
  stageId: string;
  title: string;
  agentProfileId: string;
  promptTemplate: string;
  dependsOn: string[];
  workspaceMode: 'inherit' | 'share' | 'branch';
  handoffKeys: string[];
}

export interface PlaybookDefinition {
  id: string;
  name: string;
  description: string;
  stages: PlaybookStage[];
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
}

export interface PlaybookStageRun {
  stageId: string;
  title: string;
  agentProfileId: string;
  provider: string;
  model: string | null;
  status: string;
  threadId: string | null;
  startedAtUnixMs: number | null;
  finishedAtUnixMs: number | null;
  handoffKeys: string[];
  summary: string | null;
  error: string | null;
}

export interface PlaybookRunRecord {
  runId: string;
  playbookId: string;
  playbookName: string;
  status: string;
  startedAtUnixMs: number;
  finishedAtUnixMs: number | null;
  workspaceId: string | null;
  stages: PlaybookStageRun[];
}

export interface AgentAuditLogEntry {
  id: string;
  agentId: string;
  threadId: string | null;
  toolName: string;
  toolFamily: string;
  verdict: 'allowed' | 'asked' | 'denied' | string;
  reason: string | null;
  durationMs: number;
  skillEvent: string | null;
  createdAtUnixMs: number;
}

export interface DryRunPredictedTool {
  tool: string;
  family: string;
  policy: string;
  mutating: boolean;
  blockedInDryRun: boolean;
}

export interface DryRunCaseResult {
  prompt: string;
  predictedTools: DryRunPredictedTool[];
  policyViolations: string[];
  matchedSkills: string[];
  passed: boolean;
}

export interface DryRunEvalReport {
  agentId: string;
  compiledPromptChars: number;
  estimatedPromptTokens: number;
  totalCases: number;
  passedCases: number;
  blockedMutations: number;
  readinessScore?: number;
  readinessPillars?: ReadinessPillar[];
  results: DryRunCaseResult[];
}

export interface CuratedAgentTemplate {
  id: string;
  name: string;
  engine: string;
  roleBadge: string;
  summary: string;
  brief: string;
  toolPolicies: Record<string, 'allow' | 'ask' | 'deny'>;
  knowledgePackGlobs: string[];
  defaultMode?: string;
  memoryBudget?: number;
  reflectionMode?: string;
  maxTurnsPerRun?: number;
  maxDurationSecs?: number;
  linkedSkillRefs?: string[];
}

export type TabType = 'memory' | 'skills' | 'starters' | 'playbooks' | 'audit' | 'settings';
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
