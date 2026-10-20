import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sendUiRequest,
  sendUiAck,
  waitForCodeWorkspaceReady,
  type UiBusRequestPayload,
} from './ui-bus';

vi.mock('../trace/trace', () => ({
  emitTrace: vi.fn(),
}));

describe('UI Bus — Request / ACK System', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as any).__kiteCodeWorkspaceMounted;
  });

  it('resolves with success ACK when receptor responds immediately', async () => {
    const handleRequest = (e: Event) => {
      const custom = e as CustomEvent<UiBusRequestPayload>;
      if (custom.detail.kind === 'navigate') {
        sendUiAck({
          reqId: custom.detail.reqId,
          ok: true,
          data: { mode: 'code' },
        });
      }
    };

    window.addEventListener('kite:op-request', handleRequest);

    const res = await sendUiRequest('navigate', { mode: 'code' });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ mode: 'code' });

    window.removeEventListener('kite:op-request', handleRequest);
  });

  it('resolves with failure ACK when receptor is missing (timeout)', async () => {
    const res = await sendUiRequest(
      'spawn-terminal',
      { engine: 'grok' },
      { timeoutMs: 50 }
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('sin-receptor');
  });

  it('waitForCodeWorkspaceReady resolves true when signal is received', async () => {
    const waitPromise = waitForCodeWorkspaceReady(500);

    // Simulate CodeWorkspace mount
    setTimeout(() => {
      (window as any).__kiteCodeWorkspaceMounted = true;
      window.dispatchEvent(new CustomEvent('kite:code-workspace-ready'));
    }, 20);

    const ready = await waitPromise;
    expect(ready).toBe(true);
  });

  it('waitForCodeWorkspaceReady resolves false when timeout fires', async () => {
    const ready = await waitForCodeWorkspaceReady(30);
    expect(ready).toBe(false);
  });
});
