import { describe, it, expect } from 'vitest';
import type { ConnectionSummary } from '../../../lib/ipc';
import {
  OPENCODE_GO_CHAT_ENDPOINT,
  bindingForConnection,
  resolveConnectionBinding,
  spawnEndpointForProvider,
  verifiedSpawnConnections,
} from './connectionBinding';

function connection(
  connectionId: string,
  driverKind: string,
  endpoints: Array<{ endpointId: string; ok: boolean }>
): ConnectionSummary {
  return {
    connectionId,
    driverKind,
    displayName: connectionId,
    authMethod: 'cli_session',
    accountIdentity: {},
    credentialRef: 'vault',
    endpoints,
    status: 'connected',
  };
}

describe('spawnEndpointForProvider', () => {
  it('names the local spawn endpoint for each chat provider', () => {
    expect(spawnEndpointForProvider('antigravity')).toBe('agy -p');
    expect(spawnEndpointForProvider('claude')).toBe('claude -p');
    expect(spawnEndpointForProvider('codex')).toBe('codex exec');
    expect(spawnEndpointForProvider('cursor')).toBe('cursor-agent -p');
    expect(spawnEndpointForProvider('grok')).toBe('grok -p');
    expect(spawnEndpointForProvider('opencode')).toBe('opencode run');
    expect(spawnEndpointForProvider('gemini')).toBe('gemini --prompt');
  });

  it('returns null for a provider without a local chat command', () => {
    expect(spawnEndpointForProvider('unknown-driver')).toBeNull();
  });
});

describe('resolveConnectionBinding', () => {
  it('binds the one connection whose spawn endpoint is verified', () => {
    const connections = [
      connection('conn-agy', 'antigravity', [{ endpointId: 'agy -p', ok: true }]),
    ];

    const { candidates, binding } = resolveConnectionBinding('antigravity', connections);

    expect(candidates.map((candidate) => candidate.connectionId)).toEqual(['conn-agy']);
    expect(binding).toEqual({ connectionId: 'conn-agy', supportedEndpoint: 'agy -p' });
  });

  it('does not bind a quota-only endpoint', () => {
    const connections = [
      connection('conn-quota', 'antigravity', [{ endpointId: 'cli:agy:usage', ok: true }]),
    ];

    const { candidates, binding } = resolveConnectionBinding('antigravity', connections);

    expect(candidates).toEqual([]);
    expect(binding).toBeNull();
  });

  it('does not auto-pick when two connections have the spawn endpoint verified', () => {
    const connections = [
      connection('conn-claude-a', 'claude', [{ endpointId: 'claude -p', ok: true }]),
      connection('conn-claude-b', 'claude', [{ endpointId: 'claude -p', ok: true }]),
    ];

    const { candidates, binding } = resolveConnectionBinding('claude', connections);

    expect(candidates.map((candidate) => candidate.connectionId)).toEqual([
      'conn-claude-a',
      'conn-claude-b',
    ]);
    expect(binding).toBeNull();
    expect(bindingForConnection('claude', connections, 'conn-claude-b')).toEqual({
      connectionId: 'conn-claude-b',
      supportedEndpoint: 'claude -p',
    });
  });

  it('leaves both fields unset when no connection has the spawn endpoint verified', () => {
    const connections = [
      connection('conn-codex', 'codex', [{ endpointId: 'codex exec', ok: false }]),
      connection('conn-grok', 'grok', [{ endpointId: 'grok -p', ok: true }]),
    ];

    const { candidates, binding } = resolveConnectionBinding('codex', connections);

    expect(candidates).toEqual([]);
    expect(binding).toBeNull();
  });
});

describe('opencode spawn binding', () => {
  it('names the local spawn command, never the Go chat route', () => {
    const connections = [
      connection('conn-open', 'opencode', [{ endpointId: 'opencode run', ok: true }]),
    ];

    const { binding } = resolveConnectionBinding('opencode', connections);

    expect(binding).not.toBeNull();
    expect(binding?.supportedEndpoint).toBe('opencode run');
    expect(binding?.supportedEndpoint).not.toBe(OPENCODE_GO_CHAT_ENDPOINT);
  });

  it('does not bind a connection whose only verified endpoint is the Go chat route', () => {
    const connections = [
      connection('conn-go', 'opencode', [
        { endpointId: OPENCODE_GO_CHAT_ENDPOINT, ok: true },
      ]),
    ];

    const { candidates, binding } = resolveConnectionBinding('opencode', connections);

    expect(candidates).toEqual([]);
    expect(binding).toBeNull();
    expect(bindingForConnection('opencode', connections, 'conn-go')).toBeNull();
  });
});

describe('candidate integrity', () => {
  it('never returns a connection id without its spawn endpoint id', () => {
    const connections = [
      connection('conn-agy', 'antigravity', [
        { endpointId: 'agy -p', ok: true },
        { endpointId: 'cli:agy:usage', ok: true },
      ]),
      connection('conn-quota-only', 'antigravity', [
        { endpointId: 'cli:agy:usage', ok: true },
      ]),
    ];

    const candidates = verifiedSpawnConnections('antigravity', connections);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].connectionId).toBe('conn-agy');
    expect(candidates[0].supportedEndpoint).toBe('agy -p');
    expect(candidates.every((candidate) => Boolean(candidate.connectionId))).toBe(true);
    expect(candidates.every((candidate) => Boolean(candidate.supportedEndpoint))).toBe(true);
    expect(bindingForConnection('antigravity', connections, 'conn-quota-only')).toBeNull();
    expect(bindingForConnection('antigravity', connections, 'missing')).toBeNull();
  });

  it('does not borrow a verified endpoint from another driver', () => {
    const connections = [
      connection('conn-claude', 'claude', [{ endpointId: 'agy -p', ok: true }]),
    ];

    expect(verifiedSpawnConnections('antigravity', connections)).toEqual([]);
  });

  it('drops a chosen connection that did not verify the current provider', () => {
    const connections = [
      connection('conn-agy', 'antigravity', [{ endpointId: 'agy -p', ok: true }]),
      connection('conn-claude', 'claude', [{ endpointId: 'claude -p', ok: true }]),
    ];

    expect(bindingForConnection('claude', connections, 'conn-agy')).toBeNull();
    expect(bindingForConnection('antigravity', connections, 'conn-claude')).toBeNull();
    expect(bindingForConnection('claude', connections, 'conn-claude')).toEqual({
      connectionId: 'conn-claude',
      supportedEndpoint: 'claude -p',
    });
  });
});
