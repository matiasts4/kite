import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  guidedLoginCoordinator,
  GUIDED_LOGIN_POLL_MS,
  GUIDED_LOGIN_TIMEOUT_MS,
} from './guidedLoginCoordinator';

const ipcMocks = vi.hoisted(() => ({
  startAccountLoginFlow: vi.fn(),
  cancelAccountLoginFlow: vi.fn(),
  probeLiveAccountLoginStatus: vi.fn(),
  saveCurrentAccountProfile: vi.fn(),
}));

const quotaMocks = vi.hoisted(() => ({
  fetchAll: vi.fn().mockResolvedValue({}),
}));

vi.mock('../ipc', () => ipcMocks);
vi.mock('../quota/quotaManager', () => ({
  subscriptionQuotaManager: quotaMocks,
}));

describe('guidedLoginCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    delete (window as unknown as { __kiteCodeWorkspaceMounted?: boolean }).__kiteCodeWorkspaceMounted;
    delete (window as unknown as { __kiteHasActiveWorkspace?: boolean }).__kiteHasActiveWorkspace;
    guidedLoginCoordinator.reset();

    ipcMocks.startAccountLoginFlow.mockResolvedValue({
      success: true,
      flowId: 'flow-1',
      previousEmail: 'prev@example.com',
      previousEmailSaved: 'prev@example.com',
      engine: 'agy',
      loginArgv: ['C:\\Tools\\agy.exe', 'acp', '--login'],
      loginCommand: 'agy acp --login',
      keyringDeleted: true,
      ideCleared: true,
    });
    ipcMocks.cancelAccountLoginFlow.mockResolvedValue({
      success: true,
      restored: true,
      restoredEmail: 'prev@example.com',
    });
    ipcMocks.probeLiveAccountLoginStatus.mockResolvedValue({
      provider: 'agy',
      authenticated: false,
      credentialStatus: 'missing_file',
      email: null,
      hasRefreshToken: false,
      sameAsPrevious: false,
    });
    ipcMocks.saveCurrentAccountProfile.mockResolvedValue({
      success: true,
      profile: {
        id: 'prof-new',
        provider: 'agy',
        label: 'new@example.com',
        email: 'new@example.com',
        isActive: true,
      },
    });
  });

  afterEach(() => {
    guidedLoginCoordinator.reset();
    vi.useRealTimers();
  });

  it('stops polling and aborts when subscriber count drops to zero', async () => {
    const unsubscribe = guidedLoginCoordinator.subscribe(() => {});
    const spawns: Array<Record<string, unknown>> = [];
    const legacyCmds: unknown[] = [];

    const onSpawn = (e: Event) => spawns.push((e as CustomEvent).detail);
    const onLegacy = (e: Event) => legacyCmds.push((e as CustomEvent).detail);
    window.addEventListener('kite:spawn-agent-terminal', onSpawn);
    window.addEventListener('kite:terminal-command', onLegacy);

    (window as unknown as { __kiteCodeWorkspaceMounted?: boolean }).__kiteCodeWorkspaceMounted = true;

    await guidedLoginCoordinator.start('antigravity');

    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      engine: 'agy',
      argv: ['C:\\Tools\\agy.exe', 'acp', '--login'],
    });
    expect(legacyCmds).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(GUIDED_LOGIN_POLL_MS);
    expect(ipcMocks.probeLiveAccountLoginStatus).toHaveBeenCalledTimes(1);

    // Dropping the last subscriber must immediately clear the polling timer.
    unsubscribe();
    await vi.advanceTimersByTimeAsync(GUIDED_LOGIN_POLL_MS * 5);
    expect(ipcMocks.probeLiveAccountLoginStatus).toHaveBeenCalledTimes(1);

    window.removeEventListener('kite:spawn-agent-terminal', onSpawn);
    window.removeEventListener('kite:terminal-command', onLegacy);
  });

  it('auto-saves valid new account, refreshes vault & quotas once, and differentiates re-auth vs new account', async () => {
    const unsubscribe = guidedLoginCoordinator.subscribe(() => {});
    const accountChangedEvents: unknown[] = [];
    const onAccountsChanged = (e: Event) => accountChangedEvents.push((e as CustomEvent).detail);
    window.addEventListener('kite:accounts-changed', onAccountsChanged);

    (window as unknown as { __kiteCodeWorkspaceMounted?: boolean }).__kiteCodeWorkspaceMounted = true;
    await guidedLoginCoordinator.start('antigravity');

    // First poll: still missing
    await vi.advanceTimersByTimeAsync(GUIDED_LOGIN_POLL_MS);
    expect(guidedLoginCoordinator.getSnapshot().phase).toBe('waiting');

    // Second poll: valid new account authenticated
    ipcMocks.probeLiveAccountLoginStatus.mockResolvedValueOnce({
      provider: 'agy',
      authenticated: true,
      credentialStatus: 'valid',
      email: 'new@example.com',
      hasRefreshToken: true,
      sameAsPrevious: false,
    });
    await vi.advanceTimersByTimeAsync(GUIDED_LOGIN_POLL_MS);

    expect(ipcMocks.saveCurrentAccountProfile).toHaveBeenCalledWith('antigravity', 'new@example.com');
    expect(accountChangedEvents).toHaveLength(1);
    expect(quotaMocks.fetchAll).toHaveBeenCalledTimes(1);
    expect(quotaMocks.fetchAll).toHaveBeenCalledWith(true);
    expect(guidedLoginCoordinator.getSnapshot().phase).toBe('done');
    expect(guidedLoginCoordinator.getSnapshot().notice).toContain('¡Nueva cuenta (new@example.com) autenticada');

    // Re-authenticating same account shows distinct copy
    vi.clearAllMocks();
    ipcMocks.startAccountLoginFlow.mockResolvedValueOnce({
      success: true,
      flowId: 'flow-2',
      previousEmail: 'prev@example.com',
      previousEmailSaved: 'prev@example.com',
      engine: 'agy',
      loginArgv: ['C:\\Tools\\agy.exe', 'acp', '--login'],
      loginCommand: 'agy acp --login',
    });
    ipcMocks.probeLiveAccountLoginStatus.mockResolvedValueOnce({
      provider: 'agy',
      authenticated: true,
      credentialStatus: 'valid',
      email: 'prev@example.com',
      hasRefreshToken: true,
      sameAsPrevious: true,
    });
    ipcMocks.saveCurrentAccountProfile.mockResolvedValueOnce({
      success: true,
      profile: { id: 'prof-1', provider: 'agy', label: 'Personal Pro', email: 'prev@example.com', isActive: true },
    });

    await guidedLoginCoordinator.start('antigravity');
    await vi.advanceTimersByTimeAsync(GUIDED_LOGIN_POLL_MS);
    expect(guidedLoginCoordinator.getSnapshot().notice).toContain('Sesión reautenticada (prev@example.com)');

    unsubscribe();
    window.removeEventListener('kite:accounts-changed', onAccountsChanged);
  });

  it('stops polling truthfully after 120s timeout and keeps cancel-and-restore working', async () => {
    const unsubscribe = guidedLoginCoordinator.subscribe(() => {});
    const terminated: unknown[] = [];
    const onTerminate = (e: Event) => terminated.push((e as CustomEvent).detail);
    window.addEventListener('kite:terminate-agent', onTerminate);
    (window as unknown as { __kiteCodeWorkspaceMounted?: boolean }).__kiteCodeWorkspaceMounted = true;

    await guidedLoginCoordinator.start('antigravity');
    await vi.advanceTimersByTimeAsync(GUIDED_LOGIN_TIMEOUT_MS);

    const probesAtTimeout = ipcMocks.probeLiveAccountLoginStatus.mock.calls.length;
    expect(probesAtTimeout).toBeGreaterThanOrEqual(59);
    expect(guidedLoginCoordinator.getSnapshot().timedOut).toBe(true);
    expect(guidedLoginCoordinator.getSnapshot().notice).toContain('No se completó el inicio de sesión en 120s');

    // No further polling after timeout
    await vi.advanceTimersByTimeAsync(GUIDED_LOGIN_POLL_MS * 5);
    expect(ipcMocks.probeLiveAccountLoginStatus).toHaveBeenCalledTimes(probesAtTimeout);

    await guidedLoginCoordinator.cancelAndRestore();
    expect(terminated).toHaveLength(1);
    expect(ipcMocks.cancelAccountLoginFlow).toHaveBeenCalledWith('antigravity', 'flow-1');
    expect(quotaMocks.fetchAll).toHaveBeenCalledWith(true);
    expect(guidedLoginCoordinator.getSnapshot().phase).toBe('cancelled');
    expect(guidedLoginCoordinator.getSnapshot().notice).toContain('prev@example.com');

    unsubscribe();
    window.removeEventListener('kite:terminate-agent', onTerminate);
  });

  it('waits for CodeWorkspace mount when started outside Code mode and handles busy terminal force', async () => {
    const unsubscribe = guidedLoginCoordinator.subscribe(() => {});
    const spawns: unknown[] = [];
    const onSpawn = (e: Event) => spawns.push((e as CustomEvent).detail);
    window.addEventListener('kite:spawn-agent-terminal', onSpawn);

    ipcMocks.startAccountLoginFlow.mockResolvedValueOnce({
      success: false,
      code: 'CONFIRM_BUSY_TERMINALS',
      error: 'Hay terminales activas.',
      busySessions: [{ sessionId: 's1', engine: 'agy', cwd: '.', reasons: ['recent_output'] }],
    });

    const firstTry = await guidedLoginCoordinator.start('antigravity');
    expect(firstTry).toBe(false);
    expect(guidedLoginCoordinator.getSnapshot().canForceStart).toBe(true);

    // Force retry succeeds and waits for CodeWorkspace readiness when unmounted
    await guidedLoginCoordinator.start('antigravity', { force: true });
    expect(spawns).toHaveLength(1);

    (window as unknown as { __kiteCodeWorkspaceMounted?: boolean }).__kiteCodeWorkspaceMounted = true;
    window.dispatchEvent(new CustomEvent('kite:code-workspace-ready'));
    await vi.advanceTimersByTimeAsync(0);

    expect(spawns).toHaveLength(2);

    unsubscribe();
    window.removeEventListener('kite:spawn-agent-terminal', onSpawn);
  });

  it('retryWaiting after 120s timeout terminates old loginSessionId, preserves original flowId/previousEmail, and supports rollback', async () => {
    const unsubscribe = guidedLoginCoordinator.subscribe(() => {});
    const spawns: Array<Record<string, unknown>> = [];
    const terminated: Array<Record<string, unknown>> = [];
    const onSpawn = (e: Event) => spawns.push((e as CustomEvent).detail);
    const onTerminate = (e: Event) => terminated.push((e as CustomEvent).detail);
    window.addEventListener('kite:spawn-agent-terminal', onSpawn);
    window.addEventListener('kite:terminate-agent', onTerminate);
    (window as unknown as { __kiteCodeWorkspaceMounted?: boolean }).__kiteCodeWorkspaceMounted = true;

    await guidedLoginCoordinator.start('antigravity');
    const firstSessionId = guidedLoginCoordinator.getSnapshot().loginSessionId;
    expect(ipcMocks.startAccountLoginFlow).toHaveBeenCalledTimes(1);
    expect(spawns).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(GUIDED_LOGIN_TIMEOUT_MS);
    expect(guidedLoginCoordinator.getSnapshot().timedOut).toBe(true);

    const retried = await guidedLoginCoordinator.retryWaiting();
    expect(retried).toBe(true);
    // Must reuse original flowId/rollback instead of overwriting with an empty rollback bundle
    expect(ipcMocks.startAccountLoginFlow).toHaveBeenCalledTimes(1);
    expect(terminated).toEqual([{ sessionId: firstSessionId }]);
    expect(spawns).toHaveLength(2);
    expect(guidedLoginCoordinator.getSnapshot().flowId).toBe('flow-1');
    expect(guidedLoginCoordinator.getSnapshot().previousEmail).toBe('prev@example.com');
    expect(guidedLoginCoordinator.getSnapshot().timedOut).toBe(false);

    // Cancel after retry still passes original flowId and terminates only the replacement loginSessionId
    const secondSessionId = guidedLoginCoordinator.getSnapshot().loginSessionId;
    expect(secondSessionId).not.toBe(firstSessionId);
    await guidedLoginCoordinator.cancelAndRestore();
    expect(terminated).toHaveLength(2);
    expect(terminated[1]).toEqual({ sessionId: secondSessionId });
    expect(ipcMocks.cancelAccountLoginFlow).toHaveBeenCalledWith('antigravity', 'flow-1');

    unsubscribe();
    window.removeEventListener('kite:spawn-agent-terminal', onSpawn);
    window.removeEventListener('kite:terminate-agent', onTerminate);
  });

  it('refuses cleanly or rolls back immediately when no enrolled workspace is active', async () => {
    const unsubscribe = guidedLoginCoordinator.subscribe(() => {});
    (window as unknown as { __kiteHasActiveWorkspace?: boolean }).__kiteHasActiveWorkspace = false;

    const okPre = await guidedLoginCoordinator.start('antigravity');
    expect(okPre).toBe(false);
    expect(ipcMocks.startAccountLoginFlow).not.toHaveBeenCalled();
    expect(guidedLoginCoordinator.getSnapshot().phase).toBe('error');
    expect(guidedLoginCoordinator.getSnapshot().error).toContain('Agrega o selecciona un workspace');

    // Also handle dynamic discovery when CodeWorkspace mounts CodeHome with 0 workspaces
    guidedLoginCoordinator.reset();
    delete (window as unknown as { __kiteHasActiveWorkspace?: boolean }).__kiteHasActiveWorkspace;
    await guidedLoginCoordinator.start('antigravity');
    expect(ipcMocks.startAccountLoginFlow).toHaveBeenCalledTimes(1);

    (window as unknown as { __kiteHasActiveWorkspace?: boolean }).__kiteHasActiveWorkspace = false;
    window.dispatchEvent(new CustomEvent('kite:code-workspace-no-workspace'));
    await vi.advanceTimersByTimeAsync(0);

    expect(ipcMocks.cancelAccountLoginFlow).toHaveBeenCalledWith('antigravity', 'flow-1');
    expect(guidedLoginCoordinator.getSnapshot().phase).toBe('error');
    expect(guidedLoginCoordinator.getSnapshot().error).toContain('Agrega o selecciona un workspace');

    unsubscribe();
  });
});
