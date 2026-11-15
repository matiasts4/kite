import { listen } from '@tauri-apps/api/event';
import type { AntigravityAuthTelemetry, SavedAccountProfile } from '../../types';
import * as ipc from '../ipc';
import type {
  ListSavedAccountsResult,
  ProviderSessionSummary,
  SwitchAccountProfileResult,
  UnregisteredLiveSession,
} from '../ipc';
import { subscriptionQuotaManager } from '../quota/quotaManager';
import { guidedLoginCoordinator } from './guidedLoginCoordinator';

function safeIpcFn<K extends keyof typeof ipc>(name: K): (typeof ipc)[K] | null {
  try {
    const candidate = (ipc as Record<string, unknown>)[name as string];
    return typeof candidate === 'function' ? (candidate as (typeof ipc)[K]) : null;
  } catch {
    return null;
  }
}

function safeIsTauriEnvironment(): boolean {
  const fn = safeIpcFn('isTauriEnvironment');
  if (fn) {
    return Boolean(fn());
  }
  return (
    typeof window !== 'undefined' &&
    Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)
  );
}

export interface BusyTerminalConfirmState {
  accountId: string;
  label: string;
  busySessions: ProviderSessionSummary[];
  managedIdleCount: number;
  unaffectedTerminalsCount: number;
}

export interface OverwritePromptState {
  existingProfile: SavedAccountProfile;
  pendingLabel: string;
  source: 'manual' | 'unregistered' | 'popover';
}

export interface FailedSwitchState {
  accountId: string;
  code?: string;
  providerBusyKind?: string;
  canCloseProcesses?: boolean;
  residualProcessCount?: number;
}

export interface ProviderVaultState {
  provider: string;
  profiles: SavedAccountProfile[];
  unregisteredLiveSession: UnregisteredLiveSession | null;
  authTelemetry: AntigravityAuthTelemetry | null;
  loading: boolean;
  hasLoadedOnce: boolean;
  switchingId: string | null;
  closingProcesses: boolean;
  saving: boolean;
  renamingId: string | null;
  deletingId: string | null;
  busyConfirm: BusyTerminalConfirmState | null;
  overwritePrompt: OverwritePromptState | null;
  deleteConfirmProfile: SavedAccountProfile | null;
  lastFailedSwitch: FailedSwitchState | null;
  error: string | null;
  notice: string | null;
}

export function canonicalVaultProvider(provider?: string | null): string {
  const lower = (provider || 'antigravity').trim().toLowerCase();
  return lower === 'agy' || lower === 'antigravity' ? 'antigravity' : lower;
}

export function quotaKeyForProvider(provider?: string | null): string {
  return canonicalVaultProvider(provider);
}

export function resolveLiveAccountEmail(state: Pick<
  ProviderVaultState,
  'profiles' | 'unregisteredLiveSession' | 'authTelemetry'
>): string | null {
  const activeProfile = state.profiles.find((p) => p.isActive);
  return (
    activeProfile?.email ||
    state.unregisteredLiveSession?.email ||
    state.authTelemetry?.cliEmail ||
    state.authTelemetry?.credEmail ||
    null
  );
}

export function isSplitBrainActive(telemetry?: AntigravityAuthTelemetry | null): boolean {
  if (!telemetry) return false;
  if (typeof telemetry.splitBrainWarning === 'boolean') {
    return telemetry.splitBrainWarning;
  }
  return Boolean(telemetry.splitBrainWarning);
}

export function formatSplitBrainDetail(telemetry?: AntigravityAuthTelemetry | null): string | null {
  if (!isSplitBrainActive(telemetry)) return null;
  if (telemetry?.splitBrainMessage) return telemetry.splitBrainMessage;
  if (typeof telemetry?.splitBrainWarning === 'string' && telemetry.splitBrainWarning.trim()) {
    return telemetry.splitBrainWarning;
  }
  const cli = telemetry?.cliEmail || telemetry?.credEmail;
  const ide = telemetry?.ideEmail;
  if (cli && ide) {
    return `La sesión del CLI (${cli}) no coincide con la del IDE (${ide}).`;
  }
  if (ide) {
    return `Estado residual en el IDE (${ide}) sin sesión OAuth activa.`;
  }
  return 'La sesión del CLI y la del IDE están desincronizadas.';
}

function createInitialProviderState(provider: string): ProviderVaultState {
  return {
    provider,
    profiles: [],
    unregisteredLiveSession: null,
    authTelemetry: null,
    loading: false,
    hasLoadedOnce: false,
    switchingId: null,
    closingProcesses: false,
    saving: false,
    renamingId: null,
    deletingId: null,
    busyConfirm: null,
    overwritePrompt: null,
    deleteConfirmProfile: null,
    lastFailedSwitch: null,
    error: null,
    notice: null,
  };
}

class AccountVaultStore {
  private states = new Map<string, ProviderVaultState>();
  private listeners = new Map<string, Set<() => void>>();
  private inFlightLoads = new Map<string, Promise<ListSavedAccountsResult | void>>();
  private loadEpochs = new Map<string, number>();
  private globalBound = false;
  private windowAccountsListener: ((e: Event) => void) | null = null;
  private tauriUnlisten: (() => void) | null = null;
  private tauriListenInit = false;
  private pendingAccountReloads = new Set<string>();
  private reloadScheduled = false;
  private reloadGeneration = 0;

  getSnapshot(rawProvider: string): ProviderVaultState {
    const canon = canonicalVaultProvider(rawProvider);
    let current = this.states.get(canon);
    if (!current) {
      current = createInitialProviderState(canon);
      this.states.set(canon, current);
    }
    return current;
  }

  subscribe(rawProvider: string, listener: () => void): () => void {
    const canon = canonicalVaultProvider(rawProvider);
    let set = this.listeners.get(canon);
    if (!set) {
      set = new Set();
      this.listeners.set(canon, set);
    }
    set.add(listener);
    this.ensureGlobalListeners();

    return () => {
      const currentSet = this.listeners.get(canon);
      currentSet?.delete(listener);
      if (currentSet && currentSet.size === 0) {
        this.listeners.delete(canon);
      }
      if (this.totalSubscribers() === 0) {
        this.teardownGlobalListeners();
      }
    };
  }

  private totalSubscribers(): number {
    let count = 0;
    for (const set of this.listeners.values()) {
      count += set.size;
    }
    return count;
  }

  private emit(canon: string): void {
    const set = this.listeners.get(canon);
    if (!set) return;
    for (const listener of Array.from(set)) {
      listener();
    }
  }

  private patchState(
    rawProvider: string,
    patch:
      | Partial<ProviderVaultState>
      | ((prev: ProviderVaultState) => Partial<ProviderVaultState>)
  ): ProviderVaultState {
    const canon = canonicalVaultProvider(rawProvider);
    const prev = this.getSnapshot(canon);
    const resolved = typeof patch === 'function' ? patch(prev) : patch;
    const next: ProviderVaultState = { ...prev, ...resolved };
    this.states.set(canon, next);
    this.emit(canon);
    return next;
  }

  private scheduleAccountReload(providers: Iterable<string>): void {
    for (const prov of providers) {
      if (this.listeners.has(prov) || this.states.get(prov)?.hasLoadedOnce) {
        this.pendingAccountReloads.add(prov);
      }
    }
    if (this.reloadScheduled || this.pendingAccountReloads.size === 0) {
      return;
    }
    this.reloadScheduled = true;
    const generation = this.reloadGeneration;
    queueMicrotask(() => {
      if (generation !== this.reloadGeneration) return;
      this.reloadScheduled = false;
      const batch = Array.from(this.pendingAccountReloads);
      this.pendingAccountReloads.clear();
      for (const prov of batch) {
        if (this.listeners.has(prov) || this.states.get(prov)?.hasLoadedOnce) {
          void this.loadAccounts(prov, { force: true });
        }
      }
    });
  }

  private ensureGlobalListeners(): void {
    if (typeof window !== 'undefined' && !this.globalBound) {
      this.globalBound = true;
      this.windowAccountsListener = (event: Event) => {
        const detail = (event as CustomEvent<{ provider?: string; _fromVaultStore?: boolean }>)?.detail;
        if (detail?._fromVaultStore) {
          return;
        }
        const targetProviders = detail?.provider
          ? [canonicalVaultProvider(detail.provider)]
          : Array.from(new Set([...this.listeners.keys(), ...this.states.keys()]));
        this.scheduleAccountReload(targetProviders);
      };
      window.addEventListener('kite:accounts-changed', this.windowAccountsListener);
    }

    const inTauri = safeIsTauriEnvironment();
    if (inTauri && !this.tauriListenInit && typeof listen === 'function') {
      this.tauriListenInit = true;
      void Promise.resolve(
        listen<{ sessionId?: string; provider?: string; accountLabel?: string; email?: string }>(
          'terminal://account-rotated',
          (event) => {
            const prov = canonicalVaultProvider(event?.payload?.provider || 'antigravity');
            this.scheduleAccountReload([prov]);
          }
        )
      )
        .then((unlisten) => {
          if (typeof unlisten === 'function') {
            if (!this.globalBound && this.totalSubscribers() === 0) {
              unlisten();
            } else {
              this.tauriUnlisten = unlisten;
            }
          }
        })
        .catch(() => {
          this.tauriListenInit = false;
        });
    }
  }

  private teardownGlobalListeners(): void {
    if (typeof window !== 'undefined' && this.windowAccountsListener) {
      window.removeEventListener('kite:accounts-changed', this.windowAccountsListener);
      this.windowAccountsListener = null;
    }
    this.globalBound = false;
    if (this.tauriUnlisten) {
      try {
        this.tauriUnlisten();
      } catch {
        // Ignore unlisten cleanup errors during teardown
      }
      this.tauriUnlisten = null;
    }
    this.tauriListenInit = false;
  }

  private dispatchAccountsChanged(canon: string, action: string, accountId?: string): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(
      new CustomEvent('kite:accounts-changed', {
        detail: { provider: canon, action, accountId, _fromVaultStore: true },
      })
    );
  }

  private triggerQuotaRefresh(canon: string, markRefreshing: boolean): void {
    const quotaKey = quotaKeyForProvider(canon);
    if (markRefreshing && typeof subscriptionQuotaManager?.invalidateAndMarkRefreshing === 'function') {
      subscriptionQuotaManager.invalidateAndMarkRefreshing(quotaKey);
    }
    if (typeof subscriptionQuotaManager?.fetchAll === 'function') {
      void Promise.resolve(subscriptionQuotaManager.fetchAll(true, [quotaKey])).catch(() => undefined);
    }
  }

  clearFeedback(rawProvider: string): void {
    this.patchState(rawProvider, {
      error: null,
      notice: null,
      lastFailedSwitch: null,
    });
  }

  async loadAccounts(
    rawProvider: string,
    opts?: { force?: boolean }
  ): Promise<ListSavedAccountsResult | void> {
    const canon = canonicalVaultProvider(rawProvider);
    const listFn = safeIpcFn('listSavedAccountsFull');
    if (!listFn) {
      this.patchState(canon, { loading: false, hasLoadedOnce: true });
      return;
    }

    const existing = this.inFlightLoads.get(canon);
    if (existing && !opts?.force) {
      return existing;
    }

    const nextEpoch = (this.loadEpochs.get(canon) ?? 0) + 1;
    this.loadEpochs.set(canon, nextEpoch);

    const prev = this.getSnapshot(canon);
    if (!prev.hasLoadedOnce && prev.profiles.length === 0) {
      this.patchState(canon, { loading: true });
    }

    let task!: Promise<ListSavedAccountsResult | void>;
    task = (async () => {
      try {
        const res = await listFn(canon);
        if (this.loadEpochs.get(canon) !== nextEpoch) {
          return res;
        }
        this.patchState(canon, {
          profiles: res?.profiles || [],
          unregisteredLiveSession: res?.unregisteredLiveSession ?? null,
          authTelemetry: res?.authTelemetry ?? null,
          loading: false,
          hasLoadedOnce: true,
        });
        return res;
      } catch {
        if (this.loadEpochs.get(canon) === nextEpoch) {
          this.patchState(canon, {
            loading: false,
            hasLoadedOnce: true,
            error: 'No se pudieron cargar las cuentas guardadas.',
          });
        }
      } finally {
        if (this.inFlightLoads.get(canon) === task) {
          this.inFlightLoads.delete(canon);
        }
      }
    })();

    this.inFlightLoads.set(canon, task);
    return task;
  }

  async switchAccount(
    rawProvider: string,
    accountId: string,
    opts?: { force?: boolean }
  ): Promise<SwitchAccountProfileResult> {
    const canon = canonicalVaultProvider(rawProvider);
    const current = this.getSnapshot(canon);
    if (current.switchingId) {
      return { success: false, error: 'Ya hay un cambio de cuenta en curso.' };
    }
    const switchFn = safeIpcFn('switchAccountProfile');
    if (!switchFn) {
      return { success: false, error: 'IPC de cambio de cuenta no disponible.' };
    }

    this.patchState(canon, {
      switchingId: accountId,
      error: null,
      notice: null,
      busyConfirm: null,
      lastFailedSwitch: null,
    });

    try {
      const res =
        opts?.force === true
          ? await switchFn(canon, accountId, { force: true })
          : await switchFn(canon, accountId);

      if (res?.code === 'CONFIRM_BUSY_TERMINALS') {
        const targetLabel =
          this.getSnapshot(canon).profiles.find((p) => p.id === accountId)?.label || accountId;
        this.patchState(canon, {
          switchingId: null,
          busyConfirm: {
            accountId,
            label: targetLabel,
            busySessions: res.busySessions ?? [],
            managedIdleCount: res.managedIdleCount ?? 0,
            unaffectedTerminalsCount: res.unaffectedTerminalsCount ?? 0,
          },
        });
        return res;
      }

      if (res?.success) {
        const restarted = res.terminalsRestarted ?? 0;
        const termSuffix =
          restarted > 0
            ? ` (${restarted} terminal${restarted > 1 ? 'es' : ''} actualizada${restarted > 1 ? 's' : ''})`
            : '';
        const targetLabel =
          res.profile?.label ||
          this.getSnapshot(canon).profiles.find((p) => p.id === accountId)?.label ||
          'la cuenta seleccionada';

        this.patchState(canon, (prev) => ({
          switchingId: null,
          busyConfirm: null,
          error: null,
          lastFailedSwitch: null,
          authTelemetry: res.authTelemetry !== undefined ? res.authTelemetry : prev.authTelemetry,
          notice: `Sesión cambiada y verificada en «${targetLabel}»${termSuffix}.`,
        }));

        await this.loadAccounts(canon, { force: true });
        this.triggerQuotaRefresh(canon, true);
        this.dispatchAccountsChanged(canon, 'switch', accountId);
        return res;
      }

      const errorText = formatSwitchError(res);
      this.patchState(canon, {
        switchingId: null,
        error: errorText,
        lastFailedSwitch: {
          accountId,
          code: res?.code,
          providerBusyKind: res?.providerBusyKind,
          canCloseProcesses: res?.canCloseProcesses,
          residualProcessCount: res?.residualProcessCount,
        },
      });
      await this.loadAccounts(canon, { force: true });
      return res || { success: false, error: errorText };
    } catch (err: any) {
      const errorText = err?.message || 'Error al cambiar cuenta.';
      this.patchState(canon, {
        switchingId: null,
        error: errorText,
        lastFailedSwitch: { accountId },
      });
      await this.loadAccounts(canon, { force: true });
      return { success: false, error: errorText };
    }
  }

  async confirmBusySwitch(rawProvider: string): Promise<SwitchAccountProfileResult | null> {
    const canon = canonicalVaultProvider(rawProvider);
    const pending = this.getSnapshot(canon).busyConfirm;
    if (!pending) return null;
    return this.switchAccount(canon, pending.accountId, { force: true });
  }

  cancelBusySwitch(rawProvider: string): void {
    this.patchState(rawProvider, { busyConfirm: null });
  }

  async saveCurrentAccount(
    rawProvider: string,
    typedLabel?: string,
    opts?: { source?: 'manual' | 'unregistered' | 'popover'; bypassOverwriteGuard?: boolean }
  ): Promise<{ success: boolean; prompted?: boolean; profile?: SavedAccountProfile; error?: string }> {
    const canon = canonicalVaultProvider(rawProvider);
    const state = this.getSnapshot(canon);
    if (state.saving) {
      return { success: false, error: 'Guardado en progreso.' };
    }
    const saveFn = safeIpcFn('saveCurrentAccountProfile');
    if (!saveFn) {
      return { success: false, error: 'IPC de guardado no disponible.' };
    }

    const trimmed = (typedLabel ?? '').trim();
    const liveEmail = resolveLiveAccountEmail(state);

    if (!opts?.bypassOverwriteGuard && liveEmail && trimmed) {
      const existing = state.profiles.find(
        (p) => p.email && p.email.trim().toLowerCase() === liveEmail.trim().toLowerCase()
      );
      if (existing && existing.label.trim().toLowerCase() !== trimmed.toLowerCase()) {
        this.patchState(canon, {
          overwritePrompt: {
            existingProfile: existing,
            pendingLabel: trimmed,
            source: opts?.source || 'manual',
          },
          error: null,
          notice: null,
        });
        return { success: false, prompted: true };
      }
    }

    const activeProfile = state.profiles.find((p) => p.isActive);
    const labelToSave =
      trimmed ||
      activeProfile?.label ||
      state.unregisteredLiveSession?.email ||
      `Cuenta ${state.profiles.length + 1}`;

    this.patchState(canon, {
      saving: true,
      error: null,
      notice: null,
      overwritePrompt: null,
    });

    try {
      const res = await saveFn(canon, labelToSave);
      if (res?.success) {
        await this.loadAccounts(canon, { force: true });
        this.triggerQuotaRefresh(canon, false);
        this.dispatchAccountsChanged(canon, 'save', res.profile?.id);
        this.patchState(canon, {
          saving: false,
          notice: `Sesión actual guardada como «${res.profile?.label || labelToSave}».`,
        });
        return { success: true, profile: res.profile };
      }
      const errMsg = res?.error || 'No se pudo guardar la sesión actual.';
      this.patchState(canon, { saving: false, error: errMsg });
      return { success: false, error: errMsg };
    } catch (err: any) {
      const errMsg = err?.message || 'No se pudo guardar la sesión actual.';
      this.patchState(canon, { saving: false, error: errMsg });
      return { success: false, error: errMsg };
    }
  }

  async confirmOverwriteUpdate(rawProvider: string): Promise<{ success: boolean; error?: string }> {
    const canon = canonicalVaultProvider(rawProvider);
    const prompt = this.getSnapshot(canon).overwritePrompt;
    if (!prompt) return { success: false };

    const res = await this.saveCurrentAccount(canon, prompt.existingProfile.label, {
      source: prompt.source,
      bypassOverwriteGuard: true,
    });
    if (res.success) {
      this.patchState(canon, {
        notice: `Credenciales actualizadas en «${prompt.existingProfile.label}».`,
      });
    }
    return res;
  }

  async confirmOverwriteRename(rawProvider: string): Promise<{ success: boolean; error?: string }> {
    const canon = canonicalVaultProvider(rawProvider);
    const prompt = this.getSnapshot(canon).overwritePrompt;
    if (!prompt) return { success: false };

    this.patchState(canon, { saving: true, error: null, notice: null, overwritePrompt: null });
    try {
      const renameFn = safeIpcFn('renameAccountProfile');
      if (renameFn) {
        const renameRes = await renameFn(
          canon,
          prompt.existingProfile.id,
          prompt.pendingLabel
        );
        if (!renameRes?.success) {
          const errMsg = renameRes?.error || 'No se pudo renombrar el perfil.';
          this.patchState(canon, { saving: false, error: errMsg });
          return { success: false, error: errMsg };
        }
      }

      const saveFn = safeIpcFn('saveCurrentAccountProfile');
      if (saveFn) {
        const saveRes = await saveFn(canon, prompt.pendingLabel);
        if (!saveRes?.success) {
          const errMsg = saveRes?.error || 'No se pudo actualizar las credenciales.';
          this.patchState(canon, { saving: false, error: errMsg });
          await this.loadAccounts(canon, { force: true });
          return { success: false, error: errMsg };
        }
      }

      await this.loadAccounts(canon, { force: true });
      this.triggerQuotaRefresh(canon, false);
      this.dispatchAccountsChanged(canon, 'rename', prompt.existingProfile.id);
      this.patchState(canon, {
        saving: false,
        notice: `Perfil renombrado a «${prompt.pendingLabel}» y credenciales actualizadas.`,
      });
      return { success: true };
    } catch (err: any) {
      const errMsg = err?.message || 'Error al renombrar y guardar el perfil.';
      this.patchState(canon, { saving: false, error: errMsg });
      return { success: false, error: errMsg };
    }
  }

  cancelOverwritePrompt(rawProvider: string): void {
    this.patchState(rawProvider, { overwritePrompt: null });
  }

  async renameProfile(
    rawProvider: string,
    accountId: string,
    nextLabel: string
  ): Promise<{ success: boolean; profile?: SavedAccountProfile; error?: string }> {
    const canon = canonicalVaultProvider(rawProvider);
    const trimmed = nextLabel.trim();
    if (!trimmed) {
      const errMsg = 'El nombre del perfil no puede estar vacío.';
      this.patchState(canon, { error: errMsg });
      return { success: false, error: errMsg };
    }
    const renameFn = safeIpcFn('renameAccountProfile');
    if (!renameFn) {
      return { success: false, error: 'IPC de renombrado no disponible.' };
    }

    this.patchState(canon, { renamingId: accountId, error: null, notice: null });
    try {
      const res = await renameFn(canon, accountId, trimmed);
      if (res?.success) {
        await this.loadAccounts(canon, { force: true });
        this.dispatchAccountsChanged(canon, 'rename', accountId);
        this.patchState(canon, {
          renamingId: null,
          notice: `Perfil renombrado a «${res.profile?.label || trimmed}».`,
        });
        return res;
      }
      const errMsg = res?.error || 'No se pudo renombrar el perfil.';
      this.patchState(canon, { renamingId: null, error: errMsg });
      return { success: false, error: errMsg };
    } catch (err: any) {
      const errMsg = err?.message || 'No se pudo renombrar el perfil.';
      this.patchState(canon, { renamingId: null, error: errMsg });
      return { success: false, error: errMsg };
    }
  }

  requestDeleteProfile(rawProvider: string, profile: SavedAccountProfile): void {
    this.patchState(rawProvider, { deleteConfirmProfile: profile, error: null });
  }

  cancelDeleteProfile(rawProvider: string): void {
    this.patchState(rawProvider, { deleteConfirmProfile: null });
  }

  async confirmDeleteProfile(rawProvider: string): Promise<{ success: boolean; error?: string }> {
    const canon = canonicalVaultProvider(rawProvider);
    const profile = this.getSnapshot(canon).deleteConfirmProfile;
    if (!profile) return { success: false };
    const deleteFn = safeIpcFn('deleteAccountProfile');
    if (!deleteFn) {
      this.patchState(canon, { deleteConfirmProfile: null });
      return { success: false, error: 'IPC de eliminación no disponible.' };
    }

    this.patchState(canon, {
      deletingId: profile.id,
      error: null,
      notice: null,
    });
    try {
      const res = await deleteFn(canon, profile.id);
      if (res?.success !== false) {
        this.patchState(canon, {
          deleteConfirmProfile: null,
          deletingId: null,
          notice: `Perfil «${profile.label}» eliminado de la bóveda.`,
        });
        await this.loadAccounts(canon, { force: true });
        this.dispatchAccountsChanged(canon, 'delete', profile.id);
        return { success: true };
      }
      const errMsg = res?.error || 'No se pudo eliminar el perfil.';
      this.patchState(canon, { deleteConfirmProfile: null, deletingId: null, error: errMsg });
      return { success: false, error: errMsg };
    } catch (err: any) {
      const errMsg = err?.message || 'Error al eliminar el perfil.';
      this.patchState(canon, { deleteConfirmProfile: null, deletingId: null, error: errMsg });
      return { success: false, error: errMsg };
    }
  }

  async refreshQuota(rawProvider: string): Promise<void> {
    const canon = canonicalVaultProvider(rawProvider);
    const quotaKey = quotaKeyForProvider(canon);
    if (typeof subscriptionQuotaManager?.invalidateAndMarkRefreshing === 'function') {
      subscriptionQuotaManager.invalidateAndMarkRefreshing(quotaKey);
    }
    if (typeof subscriptionQuotaManager?.fetchAll === 'function') {
      await Promise.resolve(subscriptionQuotaManager.fetchAll(true, [quotaKey])).catch(() => undefined);
    }
    await this.loadAccounts(canon, { force: true });
  }

  async closeResidualProcesses(rawProvider: string): Promise<{
    success: boolean;
    error?: string;
    profile?: SavedAccountProfile;
  }> {
    const canon = canonicalVaultProvider(rawProvider);
    const snapshot = this.getSnapshot(canon);
    if (snapshot.closingProcesses) {
      return { success: false, error: 'Cierre de procesos en curso.' };
    }
    const closeFn = safeIpcFn('closeResidualProviderProcesses');
    if (!closeFn) {
      return { success: false, error: 'IPC de limpieza de procesos no disponible.' };
    }

    const retryAccountId = snapshot.lastFailedSwitch?.accountId ?? null;
    this.patchState(canon, { closingProcesses: true });

    try {
      const res = await closeFn(canon);
      this.patchState(canon, { closingProcesses: false });
      if (res?.success) {
        if (retryAccountId) {
          const switchRes = await this.switchAccount(canon, retryAccountId);
          return {
            success: Boolean(switchRes?.success),
            error: switchRes?.error,
            profile: switchRes?.profile,
          };
        }
        this.patchState(canon, {
          error: null,
          lastFailedSwitch: null,
          notice: 'Procesos residuales de Antigravity cerrados.',
        });
        return { success: true };
      }

      const errMsg =
        res?.error || 'No se pudieron cerrar los procesos residuales de Antigravity.';
      this.patchState(canon, (prev) => ({
        error: errMsg,
        lastFailedSwitch: prev.lastFailedSwitch
          ? {
              ...prev.lastFailedSwitch,
              code: res?.code || prev.lastFailedSwitch.code,
              providerBusyKind: res?.providerBusyKind ?? prev.lastFailedSwitch.providerBusyKind,
              canCloseProcesses: Boolean(res?.canCloseProcesses),
              residualProcessCount:
                res?.residualProcessCount ?? prev.lastFailedSwitch.residualProcessCount,
            }
          : null,
      }));
      return { success: false, error: errMsg };
    } catch (err: any) {
      const errMsg =
        err?.message || 'Error al cerrar los procesos residuales de Antigravity.';
      this.patchState(canon, { closingProcesses: false, error: errMsg });
      return { success: false, error: errMsg };
    }
  }

  async alignIde(rawProvider: string): Promise<void> {
    const canon = canonicalVaultProvider(rawProvider);
    const state = this.getSnapshot(canon);
    const activeProfile = state.profiles.find((p) => p.isActive);
    const hasBrokenTokens =
      activeProfile?.credentialStatus &&
      activeProfile.credentialStatus !== 'valid';

    if (activeProfile && !hasBrokenTokens) {
      await this.switchAccount(canon, activeProfile.id);
      return;
    }

    if (typeof guidedLoginCoordinator?.start === 'function') {
      await guidedLoginCoordinator.start(canon);
    }
  }

  resetForTest(): void {
    this.reloadGeneration += 1;
    this.reloadScheduled = false;
    this.pendingAccountReloads.clear();
    this.teardownGlobalListeners();
    this.states.clear();
    this.listeners.clear();
    this.inFlightLoads.clear();
    this.loadEpochs.clear();
  }
}

function formatSwitchError(res?: SwitchAccountProfileResult | null): string {
  if (!res) return 'No se pudo cambiar la sesión.';
  if (res.code === 'PROVIDER_BUSY') {
    return (
      res.error ||
      'Cierra el IDE o proceso externo de este proveedor para liberar los archivos de sesión e inténtalo de nuevo.'
    );
  }
  if (res.code === 'INVALID_TARGET_PROFILE') {
    return (
      res.error ||
      'El perfil seleccionado no tiene tokens OAuth válidos. Reautentica la cuenta para volver a guardarla.'
    );
  }
  return res.error || 'No se pudo cambiar la sesión.';
}

export const accountVaultStore = new AccountVaultStore();

export function resetAccountVaultStoreForTest(): void {
  accountVaultStore.resetForTest();
}
