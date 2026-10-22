import type { AgentEngineDescriptor } from './types';

/** Launch grid order for the Code empty state. */
export const CODE_LAUNCH_ENGINES: AgentEngineDescriptor[] = [
  { wireId: 'claude-code', displayName: 'Claude Code', shortDisplayName: 'Claude', vendor: 'Anthropic', installed: true },
  { wireId: 'codex', displayName: 'Codex', shortDisplayName: 'Codex', vendor: 'OpenAI', installed: true },
  { wireId: 'cursor', displayName: 'Cursor Agent', shortDisplayName: 'Cursor', vendor: 'Cursor', installed: true },
  { wireId: 'gemini', displayName: 'Gemini CLI', shortDisplayName: 'Gemini', vendor: 'Google', installed: true },
  { wireId: 'github-copilot', displayName: 'GitHub Copilot', shortDisplayName: 'Copilot', vendor: 'GitHub', installed: true },
  { wireId: 'droid', displayName: 'Droid', shortDisplayName: 'Droid', vendor: 'Factory', installed: true },
  { wireId: 'open-code', displayName: 'OpenCode', shortDisplayName: 'OpenCode', vendor: 'OpenCode', installed: true },
  { wireId: 'deep-seek', displayName: 'DeepSeek Harness', shortDisplayName: 'DeepSeek', vendor: 'DeepSeek', installed: true },
  { wireId: 'grok', displayName: 'Grok Build', shortDisplayName: 'Grok', vendor: 'xAI', installed: true },
  { wireId: 'kimi', displayName: 'Kimi Code', shortDisplayName: 'Kimi', vendor: 'Moonshot', installed: true },
  { wireId: 'amp', displayName: 'Amp', shortDisplayName: 'Amp', vendor: 'Sourcegraph', installed: true },
  { wireId: 'antigravity', displayName: 'Antigravity', shortDisplayName: 'Antigravity', vendor: 'Antigravity', installed: true },
  { wireId: 'gentle-shell', displayName: 'Gentle Shell', shortDisplayName: 'Gentle', vendor: 'Gentle AI', installed: true },
  { wireId: 'aider', displayName: 'Aider', shortDisplayName: 'Aider', vendor: 'Aider', installed: true },
  { wireId: 'muse', displayName: 'Muse Code', shortDisplayName: 'Muse', vendor: 'Muse', installed: true },
];

const LOGO_BY_ENGINE: Record<string, string> = {
  'claude-code': '/assets/logos/agent-claude.png',
  codex: '/assets/logos/agent-codex-onDark.png',
  cursor: '/assets/logos/agent-cursor-onDark.png',
  gemini: '/assets/logos/agent-gemini-onDark.png',
  'github-copilot': '/assets/logos/agent-copilot-onDark.png',
  droid: '/assets/logos/agent-droid-onDark.png',
  'open-code': '/assets/logos/agent-opencode-onDark.png',
  'deep-seek': '/assets/logos/agent-deepseek.png',
  grok: '/assets/logos/agent-grok-onDark.png',
  kimi: '/assets/logos/agent-kimi-onDark.png',
  amp: '/assets/logos/agent-amp.png',
  antigravity: '/assets/logos/agent-antigravity.png',
  'gentle-shell': '/assets/logos/agent-gentle-shell.png',
  aider: '/assets/logos/agent-aider-onDark.png',
};

export function engineLogo(wireId: string): string | null {
  return LOGO_BY_ENGINE[wireId] ?? null;
}
