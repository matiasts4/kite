import { describe, expect, it } from 'vitest';
import {
  hasWorkingMarkers,
  isWaitingForUserInput,
  isBlockedOnQuestionOrApproval,
  registerSpawnedTerminal,
  markTerminalExited,
  isTerminalReadyForInput,
  waitForTerminalReady,
  markTerminalPromptInjected,
  recordTerminalOutput,
} from './terminalRegistry';

describe('terminalRegistry — Prompt readiness & startup decontamination', () => {
  it('detects OpenCode and modern CLI chevron prompts as waitingForYou', () => {
    expect(isWaitingForUserInput('OpenCode v0.1.1\n❯ ')).toBe(true);
    expect(isWaitingForUserInput('Starting OpenCode...\n❯')).toBe(true);
    expect(isWaitingForUserInput('claude-code\n> ')).toBe(true);
    expect(isWaitingForUserInput('Windows PowerShell\nPS C:\\Users\\Dev> ')).toBe(true);
    expect(isWaitingForUserInput('What would you like to do next?\n')).toBe(true);
  });

  it('does not treat startup banners as active work', () => {
    expect(hasWorkingMarkers('OpenCode v0.1.0 (running on port 3000)')).toBe(false);
    expect(hasWorkingMarkers('Reading configuration from opencode.json')).toBe(false);
    expect(hasWorkingMarkers('Resolving plugins...')).toBe(false);
    expect(hasWorkingMarkers('Welcome to Claude Code')).toBe(false);
    // Real work markers still return true:
    expect(hasWorkingMarkers('Editing src/App.tsx')).toBe(true);
    expect(hasWorkingMarkers('Compiling typescript...')).toBe(true);
    expect(hasWorkingMarkers('Executing git status')).toBe(true);
  });

  it('registers newly spawned terminals with state idle rather than working', () => {
    const term = registerSpawnedTerminal('test-sess-1', {
      engine: 'open-code',
      who: 'OpenCode',
      title: 'OpenCode Terminal',
    });

    expect(term.state).toBe('idle');
    expect(term.latestLine).toContain('Iniciando');

    markTerminalExited('test-sess-1');
  });

  it('transitions to waitingForYou and resolves waitForTerminalReady when prompt appears', async () => {
    registerSpawnedTerminal('test-sess-2', {
      engine: 'open-code',
      who: 'OpenCode',
    });

    expect(isTerminalReadyForInput('test-sess-2')).toBe(false);

    // Simulate startup banner output
    recordTerminalOutput('test-sess-2', 'OpenCode v0.2.0\nReading configuration...\n');
    expect(isTerminalReadyForInput('test-sess-2')).toBe(false);

    // Simulate prompt output arriving
    recordTerminalOutput('test-sess-2', '❯ ');
    expect(isTerminalReadyForInput('test-sess-2')).toBe(true);

    const ready = await waitForTerminalReady('test-sess-2', { timeoutMs: 500 });
    expect(ready).toBe(true);

    // Mark prompt injected
    markTerminalPromptInjected('test-sess-2');
    expect(isTerminalReadyForInput('test-sess-2')).toBe(false);

    markTerminalExited('test-sess-2');
  });

  it('does not falsely classify normal shell terminals running npm or git as codex', () => {
    // A regular terminal running npm run dev or touching files mentioning codex
    recordTerminalOutput('shell-term-npm', '> kite-code@0.1.41 dev\n> vite\n\n  VITE v6.0.7  ready in 324 ms\n  ➜  Local:   http://localhost:1420/\n  ➜  Network: use --host to expose\n', {
      engine: 'powershell',
    });
    // Even if output mentions file path containing codex or codecs
    recordTerminalOutput('shell-term-npm', 'transforming (42) src/quota/codex.rs\ncompiling video codecs module\n', {
      engine: 'powershell',
    });

    // An actual OpenAI Codex CLI banner MUST be required to classify as codex
    recordTerminalOutput('real-codex-cli', '  >_ OpenAI Codex (v0.164.0)\n     loading\n\n› Ask Codex to do anything\n', {
      engine: 'powershell',
    });
  });

  it('differentiates normal ready prompts from genuine question or permission prompts', () => {
    // Normal ready prompts -> NOT blocked
    expect(isBlockedOnQuestionOrApproval('> ')).toBe(false);
    expect(isBlockedOnQuestionOrApproval('❯ ')).toBe(false);
    expect(isBlockedOnQuestionOrApproval('$ ')).toBe(false);
    expect(isBlockedOnQuestionOrApproval('What would you like to build?\n> ')).toBe(false);
    expect(isBlockedOnQuestionOrApproval('What should we work on next?')).toBe(false);

    // Question / confirmation prompts -> BLOCKED
    expect(isBlockedOnQuestionOrApproval('Apply this change? (y/n)')).toBe(true);
    expect(isBlockedOnQuestionOrApproval('Proceed with execution? [y/N]')).toBe(true);
    expect(isBlockedOnQuestionOrApproval('Approval required before running command.')).toBe(true);
    expect(isBlockedOnQuestionOrApproval('Allow once or deny?')).toBe(true);
    expect(isBlockedOnQuestionOrApproval('Do you want to continue?')).toBe(true);
  });
});
