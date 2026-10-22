import React from 'react';
import { SquareTerminalIcon } from '../../code/codeIcons';

export interface EngineMeta {
  displayName: string;
  vendor: string | null;
  installHint?: string;
  logoVariant:
    | { file: string }
    | { onDark: string; onLight: string }
    | null;
  supportsChat: boolean;
}

export const ENGINE_METADATA: Record<string, EngineMeta> = {
  'claude-code': {
    displayName: 'Claude Code',
    vendor: 'Anthropic',
    installHint: 'irm https://claude.ai/install.ps1 | iex',
    logoVariant: { file: 'agent-claude' },
    supportsChat: true,
  },
  codex: {
    displayName: 'Codex',
    vendor: 'OpenAI',
    installHint: 'irm https://chatgpt.com/codex/install.ps1 | iex',
    logoVariant: { onDark: 'agent-codex-onDark', onLight: 'agent-codex-onLight' },
    supportsChat: true,
  },
  cursor: {
    displayName: 'Cursor Agent',
    vendor: 'Cursor',
    installHint: 'irm https://cursor.com/install?win32=true | iex',
    logoVariant: { onDark: 'agent-cursor-onDark', onLight: 'agent-cursor-onLight' },
    supportsChat: true,
  },
  gemini: {
    displayName: 'Gemini CLI',
    vendor: 'Google',
    installHint: 'npm install -g @google/gemini-cli',
    logoVariant: { onDark: 'agent-gemini-onDark', onLight: 'agent-gemini-onLight' },
    supportsChat: true,
  },
  'github-copilot': {
    displayName: 'GitHub Copilot',
    vendor: 'GitHub',
    installHint: 'winget install --id GitHub.Copilot --exact',
    logoVariant: { onDark: 'agent-copilot-onDark', onLight: 'agent-copilot-onLight' },
    supportsChat: false,
  },
  droid: {
    displayName: 'Droid',
    vendor: 'Factory',
    installHint: 'irm https://app.factory.ai/cli/windows | iex',
    logoVariant: { onDark: 'agent-droid-onDark', onLight: 'agent-droid-onLight' },
    supportsChat: false,
  },
  'open-code': {
    displayName: 'OpenCode',
    vendor: 'OpenCode',
    installHint: 'npm install -g opencode-ai',
    logoVariant: { onDark: 'agent-opencode-onDark', onLight: 'agent-opencode-onLight' },
    supportsChat: true,
  },
  'deep-seek': {
    displayName: 'DeepSeek Harness',
    vendor: 'DeepSeek',
    installHint: 'DeepSeek has not shipped an official CLI yet.',
    logoVariant: { file: 'agent-deepseek' },
    supportsChat: false,
  },
  grok: {
    displayName: 'Grok Build',
    vendor: 'xAI',
    installHint: 'irm https://x.ai/cli/install.ps1 | iex',
    logoVariant: { onDark: 'agent-grok-onDark', onLight: 'agent-grok-onLight' },
    supportsChat: true,
  },
  kimi: {
    displayName: 'Kimi Code',
    vendor: 'Moonshot AI',
    installHint: 'irm https://code.kimi.com/kimi-code/install.ps1 | iex',
    logoVariant: { onDark: 'agent-kimi-onDark', onLight: 'agent-kimi-onLight' },
    supportsChat: false,
  },
  amp: {
    displayName: 'Amp',
    vendor: 'Sourcegraph',
    installHint: 'irm https://ampcode.com/install.ps1 | iex',
    logoVariant: { file: 'agent-amp' },
    supportsChat: false,
  },
  antigravity: {
    displayName: 'Antigravity',
    vendor: 'Google',
    installHint: 'irm https://antigravity.google/cli/install.ps1 | iex',
    logoVariant: { file: 'agent-antigravity' },
    supportsChat: true,
  },
  'gentle-shell': {
    displayName: 'Gentle Shell',
    vendor: 'Gentle AI',
    installHint: 'npm install -g gentle-pi',
    logoVariant: { file: 'agent-gentle-shell' },
    supportsChat: false,
  },
  gentle: {
    displayName: 'Gentle Shell',
    vendor: 'Gentle AI',
    installHint: 'npm install -g gentle-pi',
    logoVariant: { file: 'agent-gentle-shell' },
    supportsChat: false,
  },
  gentleshell: {
    displayName: 'Gentle Shell',
    vendor: 'Gentle AI',
    installHint: 'npm install -g gentle-pi',
    logoVariant: { file: 'agent-gentle-shell' },
    supportsChat: false,
  },
  aider: {
    displayName: 'Aider',
    vendor: 'Aider',
    installHint: 'irm https://aider.chat/install.ps1 | iex',
    logoVariant: { onDark: 'agent-aider-onDark', onLight: 'agent-aider-onLight' },
    supportsChat: false,
  },
  muse: {
    displayName: 'Muse Code',
    vendor: 'Meta',
    installHint: 'No native Windows installer',
    logoVariant: null,
    supportsChat: false,
  },
  terminal: {
    displayName: 'Terminal',
    vendor: null,
    installHint: undefined,
    logoVariant: null,
    supportsChat: false,
  },
  qoder: {
    displayName: 'Qoder',
    vendor: 'Qoder',
    installHint: 'irm https://qoder.sh/install.ps1 | iex',
    logoVariant: null,
    supportsChat: false,
  },
  qodercli: {
    displayName: 'Qoder CLI',
    vendor: 'Qoder',
    installHint: 'irm https://qoder.sh/install.ps1 | iex',
    logoVariant: null,
    supportsChat: false,
  },
  claude: {
    displayName: 'Claude Code',
    vendor: 'Anthropic',
    installHint: 'irm https://claude.ai/install.ps1 | iex',
    logoVariant: { file: 'agent-claude' },
    supportsChat: true,
  },
  copilot: {
    displayName: 'GitHub Copilot',
    vendor: 'GitHub',
    installHint: 'winget install --id GitHub.Copilot --exact',
    logoVariant: { onDark: 'agent-copilot-onDark', onLight: 'agent-copilot-onLight' },
    supportsChat: false,
  },
  opencode: {
    displayName: 'OpenCode',
    vendor: 'OpenCode',
    installHint: 'npm install -g opencode-ai',
    logoVariant: { onDark: 'agent-opencode-onDark', onLight: 'agent-opencode-onLight' },
    supportsChat: true,
  },
  deepseek: {
    displayName: 'DeepSeek Harness',
    vendor: 'DeepSeek',
    installHint: 'DeepSeek has not shipped an official CLI yet.',
    logoVariant: { file: 'agent-deepseek' },
    supportsChat: false,
  },
};

export const TEAMMATE_ENGINE_IDS = [
  'claude-code',
  'codex',
  'cursor',
  'gemini',
  'github-copilot',
  'droid',
  'open-code',
  'deep-seek',
  'grok',
  'kimi',
  'amp',
  'antigravity',
  'gentle-shell',
  'qoder',
  'aider',
  'muse',
] as const;

export function normalizeEngineKey(engine?: string | null): string {
  if (!engine) return '';
  const raw = engine.toLowerCase().trim();
  const aliasMap: Record<string, string> = {
    claude: 'claude-code',
    copilot: 'github-copilot',
    opencode: 'open-code',
    deepseek: 'deep-seek',
    gentle: 'gentle-shell',
    gentleshell: 'gentle-shell',
    'gentle-pi': 'gentle-shell',
  };
  return aliasMap[raw] || raw;
}

export function getEngineDisplayName(engine?: string | null): string {
  if (!engine) return 'This engine';
  const raw = engine.toLowerCase().trim();
  const meta = ENGINE_METADATA[raw] || ENGINE_METADATA[normalizeEngineKey(raw)];
  return meta?.displayName || engine;
}

export function getEngineVendor(engine?: string | null): string | null {
  if (!engine) return null;
  const raw = engine.toLowerCase().trim();
  const meta = ENGINE_METADATA[raw] || ENGINE_METADATA[normalizeEngineKey(raw)];
  return meta?.vendor ?? null;
}

export function getEngineInstallHint(engine?: string | null): string {
  if (!engine) {
    return 'Install the engine or choose another engine in Settings. Kite re-checks as soon as an installer finishes.';
  }
  const raw = engine.toLowerCase().trim();
  const meta = ENGINE_METADATA[raw] || ENGINE_METADATA[normalizeEngineKey(raw)];
  return (
    meta?.installHint ||
    'Install the engine or choose another engine in Settings. Kite re-checks as soon as an installer finishes.'
  );
}

export function supportsAgentChat(engine?: string | null): boolean {
  if (!engine) return false;
  const raw = engine.toLowerCase().trim();
  const meta = ENGINE_METADATA[raw] || ENGINE_METADATA[normalizeEngineKey(raw)];
  return Boolean(meta?.supportsChat);
}

export function isTerminalEngine(engine?: string | null): boolean {
  return !supportsAgentChat(engine);
}

export const BrandLogo: React.FC<{
  engine: string;
  size: number;
  label?: string;
}> = ({ engine, size, label = '' }) => {
  const raw = (engine || '').toLowerCase().trim();
  const meta = ENGINE_METADATA[raw] || ENGINE_METADATA[normalizeEngineKey(raw)];
  const variant = meta?.logoVariant ?? null;
  const style = { '--brand-logo-size': `${size}px` } as React.CSSProperties;

  if (variant === null) {
    return React.createElement(
      'span',
      { 'aria-hidden': 'true', className: 'brand-logo brand-logo--fallback', style },
      React.createElement(SquareTerminalIcon, { size: Math.round(size * 0.92) })
    );
  }

  if ('file' in variant) {
    return React.createElement('img', {
      alt: label,
      className: 'brand-logo',
      height: size,
      src: `/assets/logos/${variant.file}.png`,
      style,
      width: size,
    });
  }

  return React.createElement(
    'span',
    { 'aria-hidden': 'true', className: 'brand-logo-pair', style },
    React.createElement('img', {
      alt: '',
      className: 'brand-logo brand-logo--dark',
      height: size,
      src: `/assets/logos/${variant.onDark}.png`,
      width: size,
    }),
    React.createElement('img', {
      alt: label,
      className: 'brand-logo brand-logo--light',
      height: size,
      src: `/assets/logos/${variant.onLight}.png`,
      width: size,
    })
  );
};
