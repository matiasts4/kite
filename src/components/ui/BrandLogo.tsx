import React from 'react';
import { TerminalIcon } from '../views/chat/ChatIcons';

const LOGO_BASE = '/assets/logos';

function logoUrl(file: string) {
  return `${LOGO_BASE}/${file}.png`;
}

export type BrandEngine =
  | 'claude-code'
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'gemini'
  | 'github-copilot'
  | 'copilot'
  | 'droid'
  | 'open-code'
  | 'opencode'
  | 'deep-seek'
  | 'deepseek'
  | 'grok'
  | 'kimi'
  | 'amp'
  | 'antigravity'
  | 'aider'
  | 'muse'
  | 'terminal';

interface BrandVariant {
  file?: string;
  onDark?: string;
  onLight?: string;
}

const BRAND_VARIANTS: Record<string, BrandVariant | null> = {
  'claude-code': { file: 'agent-claude' },
  claude: { file: 'agent-claude' },
  codex: { onDark: 'agent-codex-onDark', onLight: 'agent-codex-onLight' },
  cursor: { onDark: 'agent-cursor-onDark', onLight: 'agent-cursor-onLight' },
  gemini: { onDark: 'agent-gemini-onDark', onLight: 'agent-gemini-onLight' },
  'github-copilot': { onDark: 'agent-copilot-onDark', onLight: 'agent-copilot-onLight' },
  copilot: { onDark: 'agent-copilot-onDark', onLight: 'agent-copilot-onLight' },
  droid: { onDark: 'agent-droid-onDark', onLight: 'agent-droid-onLight' },
  'open-code': { onDark: 'agent-opencode-onDark', onLight: 'agent-opencode-onLight' },
  opencode: { onDark: 'agent-opencode-onDark', onLight: 'agent-opencode-onLight' },
  'deep-seek': { file: 'agent-deepseek' },
  deepseek: { file: 'agent-deepseek' },
  grok: { onDark: 'agent-grok-onDark', onLight: 'agent-grok-onLight' },
  kimi: { onDark: 'agent-kimi-onDark', onLight: 'agent-kimi-onLight' },
  amp: { file: 'agent-amp' },
  antigravity: { file: 'agent-antigravity' },
  aider: { onDark: 'agent-aider-onDark', onLight: 'agent-aider-onLight' },
  muse: null,
  terminal: null,
};

export interface BrandLogoProps {
  engine?: string;
  alt?: string;
  label?: string;
  size?: number;
}

export const BrandLogo: React.FC<BrandLogoProps> = ({
  engine = 'antigravity',
  alt = '',
  label = '',
  size = 13,
}) => {
  const effectiveAlt = label || alt;
  const style = { '--brand-logo-size': `${size}px` } as React.CSSProperties;
  const normalizedEngine = (engine || 'antigravity').toLowerCase();
  const variant = BRAND_VARIANTS[normalizedEngine] ?? null;

  if (variant === null) {
    return (
      <span aria-hidden="true" className="brand-logo brand-logo--fallback" style={style}>
        <TerminalIcon aria-hidden="true" size={Math.round(size * 0.92)} strokeWidth={1.6} />
      </span>
    );
  }

  if (variant.file) {
    return (
      <img
        alt={effectiveAlt}
        className="brand-logo"
        height={size}
        width={size}
        src={logoUrl(variant.file)}
        style={style}
      />
    );
  }

  if (variant.onDark && variant.onLight) {
    return (
      <span aria-hidden="true" className="brand-logo-pair" style={style}>
        <img
          alt=""
          className="brand-logo brand-logo--dark"
          height={size}
          width={size}
          src={logoUrl(variant.onDark)}
        />
        <img
          alt={effectiveAlt}
          className="brand-logo brand-logo--light"
          height={size}
          width={size}
          src={logoUrl(variant.onLight)}
        />
      </span>
    );
  }

  return (
    <span aria-hidden="true" className="brand-logo brand-logo--fallback" style={style}>
      <TerminalIcon aria-hidden="true" size={Math.round(size * 0.92)} strokeWidth={1.6} />
    </span>
  );
};
