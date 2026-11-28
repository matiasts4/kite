import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  clearConnectionsCache,
  invokeCommand,
  invokeFlatCommand,
  listConnections,
} from './core';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('IPC core command helpers (invokeCommand vs invokeFlatCommand)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  });

  it('invokeCommand wraps non-empty args into { request: args }', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ ok: true });
    await invokeCommand('load_agent_mind', { agentId: 'a1' });
    expect(invoke).toHaveBeenCalledWith('load_agent_mind', { request: { agentId: 'a1' } });
  });

  it('invokeFlatCommand passes flat top-level args without wrapping into { request }', async () => {
    vi.mocked(invoke).mockResolvedValueOnce('saved');
    await invokeFlatCommand('voice_call_receipt_save', { receipt: { callId: 'c1' } });
    expect(invoke).toHaveBeenCalledWith('voice_call_receipt_save', { receipt: { callId: 'c1' } });
  });

  it('listConnections deduplicates concurrent calls and caches within TTL until cleared', async () => {
    clearConnectionsCache();
    vi.mocked(invoke).mockResolvedValueOnce([{ id: 'c1', provider: 'codex', status: 'verified' }]);
    const [a, b] = await Promise.all([listConnections(), listConnections()]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(1);

    const c = await listConnections();
    expect(c).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(1);

    clearConnectionsCache();
    vi.mocked(invoke).mockResolvedValueOnce([]);
    const d = await listConnections();
    expect(d).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
