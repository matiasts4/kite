import { useEffect, useState } from 'react';
import {
  cancelAccountLoginFlow,
  probeLiveAccountLoginStatus,
  saveCurrentAccountProfile,
  startAccountLoginFlow,
} from '../ipc';
import { waitForCodeWorkspaceReady } from '../operator/executor/ui-bus';
import { subscriptionQuotaManager } from '../quota/quotaManager';

export const GUIDED_LOGIN_POLL_MS = 2000;
export const GUIDED_LOGIN_TIMEOUT_MS = 120_000;

export type GuidedLoginPhase =
  | 'idle'
  | 'preparing'
  | 'waiting'
  | 'saving'
  | 'done'
  | 'error'
  | 'cancelled';

export interface GuidedLoginState {
  phase: GuidedLoginPhase;
  flowId: string | null;
  provider: string | null;
  previousEmail: string | null;
  previousEmailSaved: string | null;
  previousSaveWarning: string | null;
  loginCommand: string | null;
  loginSessionId: string | null;
  error: string | null;
  notice: string | null;
  timedOut: boolean;
  busySessionsCount: number;
  canForceStart: boolean;
}

const INITIAL_STATE: GuidedLoginState = {
  phase: 'idle',
  flowId: null,
  provider: null,
  previousEmail: null,
  previousEmailSaved: null,
  previousSaveWarning: null,
  loginCommand: null,
  loginSessionId: null,
  error: null,
  notice: null,
  timedOut: false,
  busySessionsCount: 0,
  canForceStart: false,
};

export function isSameAccountProvider(a?: string | null, b?: string | null): boolean {
  const norm = (value?: string | null) => (value === 'antigravity' ? 'agy' : value || '');
  const na = norm(a);
  const nb = norm(b);
  return Boolean(na && nb && na === nb);
}

class GuidedLoginCoordinator {
  private state: GuidedLoginState = { ...INITIAL_STATE };
  private subscribers = new Set<() => void>();
  private pollTimerId: number | null = null;
  private abortController: AbortController | null = null;
  private isProbeInFlight = false;
  private currentRunToken = 0;
  private waitingStartedAt = 0;
  private activeLoginTarget: {
    engine: string;
    argv: string[];
    loginCommand: string;
  } | null = null;

  getSnapshot(): GuidedLoginState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    if (
      this.state.phase === 'waiting' &&
      !this.state.timedOut &&
      this.pollTimerId === null
    ) {
      this.startPollingLoop(this.currentRunToken);
    }

    return () => {
      this.subscribers.delete(listener);
      if (this.subscribers.size === 0) {
        // Stop background polling immediately when no UI consumer stays mounted.
        this.stopPollingResources();
      }
    };
  }

  private emit(): void {
    for (const listener of this.subscribers) {
      try {
        listener();
      } catch (err) {
        console.error('[GuidedLoginCoordinator] subscriber error:', err);
      }
    }
  }

  private setState(next: Partial<GuidedLoginState>): void {
    this.state = { ...this.state, ...next };
    this.emit();
  }

  private stopPollingResources(): void {
    if (this.pollTimerId !== null && typeof window !== 'undefined') {
      window.clearInterval(this.pollTimerId);
      this.pollTimerId = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.isProbeInFlight = false;
  }

  reset(): void {
    this.currentRunToken += 1;
    this.stopPollingResources();
    this.waitingStartedAt = 0;
    this.activeLoginTarget = null;
    this.state = { ...INITIAL_STATE };
    this.emit();
  }

  dismiss(): void {
    if (this.state.phase === 'waiting' || this.state.phase === 'preparing' || this.state.phase === 'saving') {
      return;
    }
    this.reset();
  }

  async start(provider: string, options?: { force?: boolean }): Promise<boolean> {
    if (this.state.phase === 'preparing' || this.state.phase === 'saving') {
      return false;
    }

    if (
      this.state.phase === 'waiting' &&
      this.state.flowId &&
      this.activeLoginTarget &&
      isSameAccountProvider(this.state.provider, provider)
    ) {
      return this.retryWaiting();
    }

    if (
      typeof window !== 'undefined' &&
      (window as unknown as { __kiteHasActiveWorkspace?: boolean }).__kiteHasActiveWorkspace === false
    ) {
      this.activeLoginTarget = null;
      this.setState({
        ...INITIAL_STATE,
        phase: 'error',
        provider,
        error: 'Agrega o selecciona un workspace en Código para abrir la terminal de inicio de sesión.',
      });
      return false;
    }

    const runToken = ++this.currentRunToken;
    this.stopPollingResources();
    this.activeLoginTarget = null;

    this.setState({
      ...INITIAL_STATE,
      phase: 'preparing',
      provider,
    });

    try {
      const res = await startAccountLoginFlow(provider, { force: options?.force });
      if (runToken !== this.currentRunToken) {
        return false;
      }

      if (!res.success) {
        if (res.code === 'CONFIRM_BUSY_TERMINALS') {
          this.setState({
            phase: 'error',
            provider,
            busySessionsCount: res.busySessions?.length ?? 1,
            canForceStart: true,
            error: res.error || 'Hay terminales activas ejecutando una respuesta.',
          });
          return false;
        }

        this.setState({
          phase: 'error',
          provider,
          canForceStart: false,
          busySessionsCount: 0,
          error: res.error || 'No se pudo preparar la conexión de una nueva cuenta.',
        });
        return false;
      }

      const flowId = res.flowId ?? null;
      const previousEmail = res.previousEmail ?? null;
      const previousEmailSaved = res.previousEmailSaved ?? null;
      const previousSaveWarning = res.previousSaveWarning ?? null;
      const engine = res.engine || 'agy';
      const loginCommand = res.loginCommand || 'agy acp --login';
      const loginArgv =
        res.loginArgv && res.loginArgv.length > 0 ? res.loginArgv : [engine];
      const loginSessionId =
        typeof globalThis.crypto?.randomUUID === 'function'
          ? globalThis.crypto.randomUUID()
          : `login-${Date.now()}`;

      let notice: string | null = null;
      if (previousSaveWarning) {
        notice = `Advertencia al respaldar la sesión anterior: ${previousSaveWarning}`;
      } else if (previousEmailSaved) {
        notice = `Sesión anterior (${previousEmailSaved}) guardada en la bóveda. Completa el inicio de sesión en la terminal.`;
      }

      this.activeLoginTarget = { engine, argv: loginArgv, loginCommand };
      this.waitingStartedAt = Date.now();
      this.setState({
        phase: 'waiting',
        flowId,
        provider,
        previousEmail,
        previousEmailSaved,
        previousSaveWarning,
        loginCommand,
        loginSessionId,
        error: null,
        notice,
        timedOut: false,
        busySessionsCount: 0,
        canForceStart: false,
      });

      this.dispatchWorkspaceLoginSpawn(runToken, {
        flowId,
        provider,
        sessionId: loginSessionId,
        engine,
        argv: loginArgv,
        loginCommand,
      });

      if (this.subscribers.size > 0) {
        this.startPollingLoop(runToken);
      }

      return true;
    } catch (err: any) {
      if (runToken !== this.currentRunToken) {
        return false;
      }
      this.activeLoginTarget = null;
      this.setState({
        phase: 'error',
        provider,
        canForceStart: false,
        error: err?.message || 'Error al iniciar el flujo de autenticación.',
      });
      return false;
    }
  }

  async retryWaiting(): Promise<boolean> {
    if (
      this.state.phase !== 'waiting' ||
      !this.state.flowId ||
      !this.state.provider ||
      !this.activeLoginTarget
    ) {
      return this.start(this.state.provider || 'antigravity', { force: true });
    }

    if (
      typeof window !== 'undefined' &&
      (window as unknown as { __kiteHasActiveWorkspace?: boolean }).__kiteHasActiveWorkspace === false
    ) {
      return this.rollbackUnavailableWorkspace(
        this.state.provider,
        this.state.flowId,
        this.state.loginSessionId
      );
    }

    const oldSessionId = this.state.loginSessionId;
    if (oldSessionId && typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('kite:terminate-agent', {
          detail: { sessionId: oldSessionId },
        })
      );
    }

    const runToken = ++this.currentRunToken;
    this.stopPollingResources();

    const newSessionId =
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `login-${Date.now()}`;
    const target = this.activeLoginTarget;
    let notice: string | null = null;
    if (this.state.previousSaveWarning) {
      notice = `Advertencia al respaldar la sesión anterior: ${this.state.previousSaveWarning}`;
    } else if (this.state.previousEmailSaved) {
      notice = `Sesión anterior (${this.state.previousEmailSaved}) guardada en la bóveda. Completa el inicio de sesión en la terminal.`;
    }

    this.waitingStartedAt = Date.now();
    this.setState({
      phase: 'waiting',
      loginSessionId: newSessionId,
      timedOut: false,
      error: null,
      notice,
    });

    this.dispatchWorkspaceLoginSpawn(runToken, {
      flowId: this.state.flowId,
      provider: this.state.provider,
      sessionId: newSessionId,
      engine: target.engine,
      argv: target.argv,
      loginCommand: target.loginCommand,
    });

    if (this.subscribers.size > 0) {
      this.startPollingLoop(runToken);
    }

    return true;
  }

  private async rollbackUnavailableWorkspace(
    provider: string,
    flowId: string | null,
    loginSessionId: string | null
  ): Promise<boolean> {
    this.currentRunToken += 1;
    this.stopPollingResources();
    this.activeLoginTarget = null;
    if (loginSessionId && typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('kite:terminate-agent', {
          detail: { sessionId: loginSessionId },
        })
      );
    }
    try {
      await cancelAccountLoginFlow(provider, flowId);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('kite:accounts-changed', {
            detail: { provider },
          })
        );
      }
      await subscriptionQuotaManager.fetchAll(true);
    } catch (err) {
      console.warn('[GuidedLoginCoordinator] rollback after workspace unavailable failed:', err);
    }
    this.setState({
      phase: 'error',
      flowId: null,
      loginSessionId: null,
      timedOut: false,
      canForceStart: false,
      error: 'Agrega o selecciona un workspace en Código para abrir la terminal de inicio de sesión.',
    });
    return false;
  }

  private dispatchWorkspaceLoginSpawn(
    runToken: number,
    opts: {
      flowId: string | null;
      provider: string;
      sessionId: string;
      engine: string;
      argv: string[];
      loginCommand: string;
    }
  ): void {
    if (typeof window === 'undefined') return;

    const spawnDetail = {
      sessionId: opts.sessionId,
      engine: opts.engine,
      argv: opts.argv,
      title: `Login (${opts.loginCommand})`,
      agentName: `Login ${opts.engine}`,
      autoApprove: false,
    };

    const wasWorkspaceMounted = Boolean(
      (window as unknown as { __kiteCodeWorkspaceMounted?: boolean }).__kiteCodeWorkspaceMounted
    );

    // Always notify App global listener so Settings closes and Code mode activates.
    window.dispatchEvent(
      new CustomEvent('kite:spawn-agent-terminal', {
        detail: spawnDetail,
      })
    );

    // If CodeWorkspace wasn't mounted yet (launched from Agent/Chat mode), wait until
    // CodeWorkspace mounts its event listener and re-dispatch the spawn once ready.
    if (!wasWorkspaceMounted) {
      void waitForCodeWorkspaceReady(3500).then((ready) => {
        if (
          runToken !== this.currentRunToken ||
          this.state.phase !== 'waiting' ||
          this.abortController?.signal.aborted
        ) {
          return;
        }
        if (ready) {
          window.dispatchEvent(
            new CustomEvent('kite:spawn-agent-terminal', {
              detail: spawnDetail,
            })
          );
        } else {
          void this.rollbackUnavailableWorkspace(opts.provider, opts.flowId, opts.sessionId);
        }
      });
    }
  }

  private startPollingLoop(runToken: number): void {
    this.stopPollingResources();
    if (this.subscribers.size === 0 || typeof window === 'undefined') {
      return;
    }

    const controller = new AbortController();
    this.abortController = controller;
    if (this.waitingStartedAt <= 0) {
      this.waitingStartedAt = Date.now();
    }

    this.pollTimerId = window.setInterval(() => {
      void this.pollOnce(runToken, controller);
    }, GUIDED_LOGIN_POLL_MS);
  }

  private async pollOnce(runToken: number, controller: AbortController): Promise<void> {
    if (
      controller.signal.aborted ||
      runToken !== this.currentRunToken ||
      this.state.phase !== 'waiting' ||
      this.isProbeInFlight
    ) {
      return;
    }

    const provider = this.state.provider || 'antigravity';
    const previousEmail = this.state.previousEmail;
    this.isProbeInFlight = true;

    try {
      const probe = await probeLiveAccountLoginStatus(provider, previousEmail);
      if (
        controller.signal.aborted ||
        runToken !== this.currentRunToken ||
        this.state.phase !== 'waiting'
      ) {
        return;
      }

      if (probe.authenticated && probe.credentialStatus === 'valid') {
        this.stopPollingResources();
        this.setState({ phase: 'saving', error: null });

        const saved = await saveCurrentAccountProfile(provider, probe.email || '');
        if (runToken !== this.currentRunToken) {
          return;
        }

        if (!saved.success) {
          this.activeLoginTarget = null;
          this.setState({
            phase: 'error',
            error: saved.error || 'Cuenta autenticada, pero no se pudo guardar en la bóveda.',
          });
          return;
        }

        const email = probe.email || saved.profile?.email || 'cuenta activa';
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('kite:accounts-changed', {
              detail: { provider, email },
            })
          );
        }

        try {
          await subscriptionQuotaManager.fetchAll(true);
        } catch (err) {
          console.warn('[GuidedLoginCoordinator] quota refresh failed:', err);
        }

        if (runToken !== this.currentRunToken) {
          return;
        }

        this.activeLoginTarget = null;
        this.setState({
          phase: 'done',
          timedOut: false,
          error: null,
          notice: probe.sameAsPrevious
            ? `Sesión reautenticada (${email}) y credenciales actualizadas en la bóveda.`
            : `¡Nueva cuenta (${email}) autenticada y guardada en la bóveda!`,
        });
        return;
      }

      if (Date.now() - this.waitingStartedAt >= GUIDED_LOGIN_TIMEOUT_MS) {
        this.stopPollingResources();
        this.setState({
          timedOut: true,
          notice:
            'No se completó el inicio de sesión en 120s. Puedes reintentar o cancelar y restaurar tu sesión anterior.',
        });
      }
    } catch (err) {
      console.warn('[GuidedLoginCoordinator] poll failed:', err);
    } finally {
      this.isProbeInFlight = false;
    }
  }

  async cancelAndRestore(): Promise<boolean> {
    const provider = this.state.provider || 'antigravity';
    const flowId = this.state.flowId;
    const loginSessionId = this.state.loginSessionId;

    this.currentRunToken += 1;
    this.stopPollingResources();
    this.activeLoginTarget = null;

    if (loginSessionId && typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('kite:terminate-agent', {
          detail: { sessionId: loginSessionId },
        })
      );
    }

    try {
      const res = await cancelAccountLoginFlow(provider, flowId);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('kite:accounts-changed', {
            detail: { provider },
          })
        );
      }

      try {
        await subscriptionQuotaManager.fetchAll(true);
      } catch (err) {
        console.warn('[GuidedLoginCoordinator] quota refresh on cancel failed:', err);
      }

      if (res.success) {
        this.setState({
          phase: 'cancelled',
          flowId: null,
          loginSessionId: null,
          timedOut: false,
          error: null,
          canForceStart: false,
          notice: res.restoredEmail
            ? `Inicio de sesión cancelado. Se restauró tu sesión anterior (${res.restoredEmail}).`
            : 'Inicio de sesión cancelado y estado temporal limpiado.',
        });
        return true;
      }

      this.setState({
        phase: 'error',
        error: res.error || 'No se pudo restaurar la sesión anterior.',
      });
      return false;
    } catch (err: any) {
      this.setState({
        phase: 'error',
        error: err?.message || 'No se pudo cancelar y restaurar la sesión.',
      });
      return false;
    }
  }
}

export const guidedLoginCoordinator = new GuidedLoginCoordinator();

export function useGuidedLoginState(active = true): GuidedLoginState {
  const [snapshot, setSnapshot] = useState<GuidedLoginState>(() =>
    guidedLoginCoordinator.getSnapshot()
  );

  useEffect(() => {
    if (!active) return;
    setSnapshot(guidedLoginCoordinator.getSnapshot());
    return guidedLoginCoordinator.subscribe(() => {
      setSnapshot(guidedLoginCoordinator.getSnapshot());
    });
  }, [active]);

  return snapshot;
}
