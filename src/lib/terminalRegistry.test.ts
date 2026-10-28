import { describe, expect, it } from 'vitest';
import {
  hasWorkingMarkers,
  isWaitingForUserInput,
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
});
