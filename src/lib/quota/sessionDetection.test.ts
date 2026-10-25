import { describe, it, expect } from 'vitest';
import {
  matchEngineToProvider,
  resolveProviderDetectedSession,
  detectAllProviderSessions,
  getAutoEnableSuggestedProviders,
} from './sessionDetection';
import type { DetectedCliAccount } from '../ipc';
import type { ActiveAgentTerminal } from '../terminalRegistry';

describe('sessionDetection', () => {
  it('correctly matches engine names to provider ids', () => {
    expect(matchEngineToProvider('antigravity', 'antigravity')).toBe(true);
    expect(matchEngineToProvider('agy', 'antigravity')).toBe(true);
    expect(matchEngineToProvider('gemini', 'antigravity')).toBe(true);
    expect(matchEngineToProvider('claude-code', 'claude')).toBe(true);
    expect(matchEngineToProvider('open-code', 'opencode')).toBe(true);
    expect(matchEngineToProvider('cursor-agent', 'cursor')).toBe(true);
    expect(matchEngineToProvider('codex', 'codex')).toBe(true);
    expect(matchEngineToProvider('powershell', 'codex')).toBe(false);
  });

  it('detects active terminal agent with top priority', () => {
    const terminals: ActiveAgentTerminal[] = [
      {
        sessionId: 'term-1',
        engine: 'claude-code',
        title: 'Claude Code Agent',
        who: 'Anthropic Claude',
        state: 'working',
        latestLine: 'Processing request...',
        updatedAt: Date.now(),
      },
    ];

    const session = resolveProviderDetectedSession('claude', [], terminals, undefined);
    expect(session.hasSession).toBe(true);
    expect(session.sessionType).toBe('terminal_agent');
    expect(session.statusLabel).toBe('● Agente en terminal');
    expect(session.statusTone).toBe('ok');
    expect(session.terminalTitle).toBe('Anthropic Claude');
  });

  it('detects local CLI account when authenticated', () => {
    const cliAccounts: DetectedCliAccount[] = [
      {
        provider: 'codex',
        displayName: 'Codex',
        authState: 'authenticated',
        email: 'developer@example.com',
        planName: 'ChatGPT Plus',
        details: 'Tokens detectados en ~/.codex/auth.json',
      },
    ];

    const session = resolveProviderDetectedSession('codex', cliAccounts, [], undefined);
    expect(session.hasSession).toBe(true);
    expect(session.sessionType).toBe('cli_authenticated');
    expect(session.statusLabel).toBe('● Sesión CLI detectada');
    expect(session.statusTone).toBe('ok');
    expect(session.email).toBe('developer@example.com');
    expect(session.planName).toBe('ChatGPT Plus');
  });

  it('detects unauthenticated CLI as installed', () => {
    const cliAccounts: DetectedCliAccount[] = [
      {
        provider: 'grok',
        displayName: 'Grok',
        authState: 'unauthenticated',
        binaryPath: '/usr/local/bin/grok',
      },
    ];

    const session = resolveProviderDetectedSession('grok', cliAccounts, [], undefined);
    expect(session.hasSession).toBe(false);
    expect(session.sessionType).toBe('cli_installed');
    expect(session.statusLabel).toBe('○ CLI instalada');
    expect(session.statusTone).toBe('warn');
  });

  it('detects session from live quota auth when CLI is absent', () => {
    const quota: any = {
      providerId: 'opencode',
      isAuth: true,
      metadata: { email: 'user@opencode.ai' },
    };

    const session = resolveProviderDetectedSession('opencode', [], [], quota);
    expect(session.hasSession).toBe(true);
    expect(session.sessionType).toBe('quota_active');
    expect(session.email).toBe('user@opencode.ai');
  });

  it('detects session from vault API key when CLI is absent', () => {
    const credentials: any[] = [
      {
        provider: 'deepseek',
        isConfigured: true,
        source: 'vault',
        preview: 'sk-deep...99a1',
      },
    ];

    const session = resolveProviderDetectedSession('deepseek', [], [], undefined, credentials);
    expect(session.hasSession).toBe(true);
    expect(session.sessionType).toBe('api_key_vault');
    expect(session.statusLabel).toBe('● Clave en bóveda');
    expect(session.statusTone).toBe('ok');
    expect(session.email).toContain('sk-deep...99a1');
  });

  it('detects session from environment variable', () => {
    const credentials: any[] = [
      {
        provider: 'claude',
        isConfigured: true,
        source: 'env',
        preview: 'sk-ant...88b2',
      },
    ];

    const session = resolveProviderDetectedSession('claude', [], [], undefined, credentials);
    expect(session.hasSession).toBe(true);
    expect(session.sessionType).toBe('api_key_env');
    expect(session.statusLabel).toBe('● Clave en entorno');
    expect(session.statusTone).toBe('ok');
  });

  it('returns none when not installed and no session exists', () => {
    const session = resolveProviderDetectedSession('deepseek', [], [], undefined);
    expect(session.hasSession).toBe(false);
    expect(session.sessionType).toBe('none');
    expect(session.statusLabel).toBe('No instalado');
    expect(session.statusTone).toBe('idle');
  });

  it('detectAllProviderSessions and getAutoEnableSuggestedProviders return active sessions', () => {
    const cliAccounts: DetectedCliAccount[] = [
      {
        provider: 'antigravity',
        displayName: 'Antigravity',
        authState: 'authenticated',
        email: 'dev@gmail.com',
      },
      {
        provider: 'cursor',
        displayName: 'Cursor',
        authState: 'authenticated',
      },
    ];

    const detected = detectAllProviderSessions(cliAccounts, [], {});
    expect(detected.antigravity.hasSession).toBe(true);
    expect(detected.cursor.hasSession).toBe(true);
    expect(detected.kimi.hasSession).toBe(false);

    const suggested = getAutoEnableSuggestedProviders(detected);
    expect(suggested).toContain('antigravity');
    expect(suggested).toContain('cursor');
    expect(suggested).not.toContain('kimi');
  });
});
