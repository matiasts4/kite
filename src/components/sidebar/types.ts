import React from 'react';
import type { Workspace, AgentProfile } from '../../types';

export type WorkMode = 'agent' | 'code' | 'chat';

export interface ChatThreadSummary {
  id: string;
  title: string;
  workspaceId?: string | null;
  updatedAtUnixMs?: number;
  isPinned?: boolean;
  pinned?: boolean;
  status?: 'idle' | 'running' | 'waiting' | 'error';
  unread?: boolean;
  hasContent?: boolean;
  provider?: 'claude' | 'codex' | 'cursor' | 'grok' | 'opencode';
}

export interface WorkspaceSessionTab {
  id: string;
  title: string;
  paneCount?: number;
  status?: 'idle' | 'running' | 'waiting' | 'error';
  isActive?: boolean;
}

export interface SidebarProps {
  hidden?: boolean;
  /** Fired when the rail finishes mount/unmount (includes exit animation). */
  onRailPresenceChange?: (mounted: boolean) => void;
  mode: WorkMode;
  workspaces: Workspace[];
  agents: AgentProfile[];
  threads?: ChatThreadSummary[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
  selectedThreadId?: string | null;
  onSelectThread?: (id: string) => void;
  onNewAgent: () => void;
  onAddWorkspace: () => void;
  onNewChat: () => void;
  onNewChatInWorkspace?: (workspaceId: string) => void;
  onNewAgentChat?: (agentId: string) => void;
  onCopyWorkspacePath?: (id: string) => void;
  onTogglePinWorkspace?: (id: string, pinned: boolean) => void;
  onTogglePinAgent?: (id: string, pinned: boolean) => void;
  onTogglePinThread?: (id: string, pinned: boolean) => void;
  onOpenSettings: () => void;
  appearance: 'dark' | 'light';
  onToggleAppearance: () => void;
  accountName?: string;
  accountTier?: string;
  accountTierPaid?: boolean;
  creditsLabel?: string;
  onShowModeHome?: () => void;
  onConnectSsh?: () => void;
  onRenameWorkspace?: (id: string, newName: string) => void;
  onRemoveWorkspaceFromList?: (id: string) => void;
  onNewWorkspaceSession?: (workspaceId: string) => void;
  onSelectWorkspaceTab?: (workspaceId: string, tabId: string) => void;
  onCloseWorkspaceTab?: (workspaceId: string, tabId: string) => void;
  onRenameWorkspaceTab?: (workspaceId: string, tabId: string, newTitle: string) => void;
  workspaceSessions?: Record<string, WorkspaceSessionTab[]>;
  onDeleteAgent?: (agentId: string) => void;
  onOpenAgentSettings?: (agentId: string) => void;
  onInstallAgent?: (engine: string) => void;
  agentActivity?: Record<string, { runningCount?: number; needsYou?: boolean; atUnixMs?: number; line?: string }>;
  availability?: { hasProbed?: boolean } & Record<string, boolean>;
  onOpenArchivedChats?: () => void;
  onRenameThread?: (id: string, newTitle: string) => void;
  onDeleteThread?: (id: string) => void;
  onMoveWorkspace?: (workspaceId: string, toIndex: number) => void;
  onMoveAgent?: (agentId: string, toIndex: number) => void;
}

export interface MenuItem {
  id: string;
  title: string;
  detail?: string;
  icon?: React.ReactNode;
  shortcut?: string;
  role?: 'destructive' | 'default';
  disabled?: boolean;
  action: () => void;
}

export interface MenuHeader {
  title: string;
  subtitle?: string;
}

export interface ContextMenuState {
  x: number;
  y: number;
  header?: MenuHeader;
  sections: MenuItem[][];
  targetId?: string;
}

export const engineDisplayNames: Record<string, string> = {
  claude: 'Claude Code',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  agy: 'Antigravity',
  grok: 'Grok Build',
  opencode: 'OpenCode',
  'open-code': 'OpenCode',
  cursor: 'Cursor Agent',
  gemini: 'Gemini CLI',
  copilot: 'GitHub Copilot',
  'github-copilot': 'GitHub Copilot',
  droid: 'Droid',
  'deep-seek': 'DeepSeek',
  deepseek: 'DeepSeek',
  kimi: 'Kimi Code',
  amp: 'Amp',
  aider: 'Aider',
  muse: 'Muse Code',
  qoder: 'Qoder',
  codestory: 'CodeStory',
  goose: 'Goose',
  pi: 'Pi',
  terminal: 'Terminal',
  kodu: 'Kodu',
};

function isNoisyActivityLine(line: string): boolean {
  const lower = line.toLowerCase().trim();
  if (
    lower.startsWith('reading') ||
    lower.startsWith('read ') ||
    lower.startsWith('view_file') ||
    lower.startsWith('inspecting') ||
    lower.startsWith('fetching') ||
    lower.startsWith('cat ') ||
    lower.startsWith('head ') ||
    lower.startsWith('tail ')
  ) {
    return true;
  }
  if (/[a-zA-Z]:[\\/]|^\.{1,2}[\\/]|^src[\\/]/.test(lower) && /\.(?:ts|tsx|js|jsx|json|rs|py|md|html|css|toml)\b/i.test(lower)) {
    return true;
  }
  return false;
}

export function formatAgentPurpose(
  agent: AgentProfile,
  activity?: { line?: string },
  isInstalled: boolean = true
): string {
  const engineName = engineDisplayNames[agent.engine] || agent.engine;
  if (!isInstalled) return `${engineName} not installed`;
  const line = activity?.line?.trim() ?? '';
  if (line.length > 0 && !isNoisyActivityLine(line)) return line;
  const cleaned = (agent.purpose || '')
    .replace(/^#+\s*(?:Role\s*&\s*Charter|Role|Execution\s*Standards|Standards|Context|Propósito|Rol|Misión)\s*$/gim, '')
    .replace(/^\s*[#>*-]+\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return `Powered by ${engineName}`;
  return cleaned.length > 120 ? `${cleaned.slice(0, 120)}…` : cleaned;
}

export function formatRelativeTime(atUnixMs: number, now: number = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((now - atUnixMs) / 1000));
  if (diffSec < 60) return 'now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
}

export function formatThreadTrailing(thread: ChatThreadSummary, now: number = Date.now()): string {
  if (thread.status === 'running') return 'Working';
  if (thread.status === 'waiting') return 'Needs you';
  if (thread.status === 'error') return 'Failed';
  if (thread.hasContent === false) return 'Draft';
  if (!thread.updatedAtUnixMs) return '';
  return formatRelativeTime(thread.updatedAtUnixMs, now);
}
