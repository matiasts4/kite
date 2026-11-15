import type {
  AntigravityAuthTelemetry,
  AutoSwitchBusySessionSummary,
  AutoSwitchExecutedEvent,
  AutoSwitchPolicy,
  AutoSwitchRuntimeStatus,
  AutoSwitchStatusEvent,
  CachedQuotaWindow,
  PendingAutoSwitchConfirmation,
  SavedAccountProfile,
} from '../../types';
import { invokeCommand, isTauriEnvironment } from './core';

export type {
  AntigravityAuthTelemetry,
  AutoSwitchBusySessionSummary,
  AutoSwitchExecutedEvent,
  AutoSwitchPolicy,
  AutoSwitchRuntimeStatus,
  AutoSwitchStatusEvent,
  CachedQuotaWindow,
  PendingAutoSwitchConfirmation,
};

export interface UnregisteredLiveSession {
  provider: string;
  email: string;
  name?: string | null;
  source?: string | null;
  planName?: string | null;
  primaryRemainingPercent?: number | null;
  primaryResetAt?: string | null;
  timeUntilResetMs?: number | null;
}

export interface ListSavedAccountsResult {
  profiles: SavedAccountProfile[];
  unregisteredLiveSession?: UnregisteredLiveSession | null;
  authTelemetry?: AntigravityAuthTelemetry | null;
}

export async function listSavedAccounts(provider?: string): Promise<SavedAccountProfile[]> {
  try {
    const res = await invokeCommand<{
      schemaVersion: number;
      profiles: SavedAccountProfile[];
      unregisteredLiveSession?: UnregisteredLiveSession | null;
      authTelemetry?: AntigravityAuthTelemetry | null;
    }>('list_saved_accounts', { provider });
    return res?.profiles || [];
  } catch (err) {
    console.warn('[IPC] listSavedAccounts failed:', err);
    return [];
  }
}

export async function listSavedAccountsFull(provider?: string): Promise<ListSavedAccountsResult> {
  try {
    const res = await invokeCommand<{
      schemaVersion: number;
      profiles: SavedAccountProfile[];
      unregisteredLiveSession?: UnregisteredLiveSession | null;
      authTelemetry?: AntigravityAuthTelemetry | null;
    }>('list_saved_accounts', { provider });
    return {
      profiles: res?.profiles || [],
      unregisteredLiveSession: res?.unregisteredLiveSession || null,
      authTelemetry: res?.authTelemetry ?? null,
    };
  } catch (err) {
    console.warn('[IPC] listSavedAccountsFull failed:', err);
    return { profiles: [], unregisteredLiveSession: null, authTelemetry: null };
  }
}

export interface DetectedCliAccount {
  provider: string;
  displayName: string;
  authState: 'authenticated' | 'unauthenticated' | 'not_installed';
  accountLabel?: string;
  email?: string;
  planName?: string;
  binaryPath?: string;
  configPath?: string;
  details?: string;
}

export async function listDetectedCliAccounts(): Promise<DetectedCliAccount[]> {
  try {
    const res = await invokeCommand<{ schemaVersion: number; accounts: DetectedCliAccount[] }>('list_detected_cli_accounts');
    return res?.accounts || [];
  } catch (err) {
    console.warn('[IPC] listDetectedCliAccounts failed:', err);
    return [];
  }
}

export async function saveCurrentAccountProfile(
  provider: string,
  label: string
): Promise<{ success: boolean; profile?: SavedAccountProfile; error?: string }> {
  try {
    return await invokeCommand('save_current_account_profile', { provider, label });
  } catch (err: any) {
    console.error('[IPC] saveCurrentAccountProfile failed:', err);
    return { success: false, error: err?.message || String(err) };
  }
}

export interface ProviderSessionSummary {
  sessionId: string;
  engine: string;
  workspaceId?: string | null;
  paneId?: string | null;
  cwd: string;
  busy: boolean;
  reasons: string[];
  lastOutputAgeMs?: number | null;
  presentationLive: boolean;
}

export interface ProviderSessionsInspection {
  managedIdle: ProviderSessionSummary[];
  managedBusy: ProviderSessionSummary[];
  externalBlocking: string[];
  unaffectedTerminalsCount: number;
}

export interface ResidualProcessSummary {
  pid: number;
  name: string;
  kind: string;
}

export type ProviderBusyKind = 'idle' | 'residual_only' | 'base_app_open' | 'unknown';

export interface SwitchAccountProfileResult {
  success: boolean;
  profile?: SavedAccountProfile;
  code?: string;
  error?: string;
  providerBusyKind?: ProviderBusyKind;
  canCloseProcesses?: boolean;
  residualProcessCount?: number;
  residualProcesses?: ResidualProcessSummary[];
  baseAppTitles?: string[];
  terminalsRestarted?: number;
  targetedSessionIds?: string[];
  skippedUnaffectedCount?: number;
  busySessions?: ProviderSessionSummary[];
  managedIdleCount?: number;
  unaffectedTerminalsCount?: number;
  authTelemetry?: AntigravityAuthTelemetry | null;
}

export interface CloseResidualProviderProcessesResult {
  success: boolean;
  alreadyIdle?: boolean;
  closedCount?: number;
  closedPids?: number[];
  code?: string;
  providerBusyKind?: ProviderBusyKind;
  canCloseProcesses?: boolean;
  residualProcessCount?: number;
  residualProcesses?: ResidualProcessSummary[];
  baseAppTitles?: string[];
  error?: string;
}

export async function closeResidualProviderProcesses(
  provider: string
): Promise<CloseResidualProviderProcessesResult> {
  try {
    return await invokeCommand('close_residual_provider_processes', { provider });
  } catch (err: any) {
    console.error('[IPC] closeResidualProviderProcesses failed:', err);
    return { success: false, error: err?.message || String(err) };
  }
}

export async function inspectProviderSessions(
  provider: string
): Promise<ProviderSessionsInspection> {
  try {
    return await invokeCommand<ProviderSessionsInspection>('inspect_provider_sessions', { provider });
  } catch (err) {
    console.warn('[IPC] inspectProviderSessions failed:', err);
    return {
      managedIdle: [],
      managedBusy: [],
      externalBlocking: [],
      unaffectedTerminalsCount: 0,
    };
  }
}

export async function switchAccountProfile(
  provider: string,
  accountId: string,
  opts?: { force?: boolean }
): Promise<SwitchAccountProfileResult> {
  try {
    const payload =
      opts?.force !== undefined
        ? { provider, accountId, force: opts.force }
        : { provider, accountId };
    return await invokeCommand('switch_account_profile', payload);
  } catch (err) {
    console.error('[IPC] switchAccountProfile failed:', err);
    return { success: false, error: String(err) };
  }
}

export async function deleteAccountProfile(
  provider: string,
  accountId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    return await invokeCommand('delete_account_profile', { provider, accountId });
  } catch (err) {
    console.error('[IPC] deleteAccountProfile failed:', err);
    return { success: false, error: String(err) };
  }
}

export async function renameAccountProfile(
  provider: string,
  accountId: string,
  label: string
): Promise<{ success: boolean; profile?: SavedAccountProfile; error?: string }> {
  try {
    return await invokeCommand('rename_account_profile', { provider, accountId, label });
  } catch (err: any) {
    console.error('[IPC] renameAccountProfile failed:', err);
    return { success: false, error: err?.message || String(err) };
  }
}

export async function getActiveAccountProfile(
  provider: string
): Promise<{ found: boolean; profile?: SavedAccountProfile }> {
  try {
    return await invokeCommand('get_active_account_profile', { provider });
  } catch (err) {
    console.warn('[IPC] getActiveAccountProfile failed:', err);
    return { found: false };
  }
}

export interface StartAccountLoginFlowResult {
  success: boolean;
  code?: string;
  error?: string;
  providerBusyKind?: ProviderBusyKind;
  canCloseProcesses?: boolean;
  residualProcessCount?: number;
  residualProcesses?: ResidualProcessSummary[];
  baseAppTitles?: string[];
  flowId?: string;
  previousEmail?: string | null;
  previousEmailSaved?: string | null;
  previousSaveWarning?: string | null;
  engine?: string;
  loginArgv?: string[];
  loginCommand?: string;
  keyringDeleted?: boolean;
  ideCleared?: boolean;
  quiescedTerminalsCount?: number;
  unaffectedTerminalsCount?: number;
  busySessions?: Array<{
    sessionId: string;
    engine: string;
    workspaceId?: string;
    paneId?: string;
    cwd: string;
    reasons: string[];
  }>;
  managedIdleCount?: number;
}

export interface CancelAccountLoginFlowResult {
  success: boolean;
  restored?: boolean;
  restoredEmail?: string | null;
  terminalsRestarted?: number;
  error?: string;
}

export interface LiveAccountLoginProbe {
  provider: string;
  authenticated: boolean;
  credentialStatus: string;
  email?: string | null;
  hasRefreshToken: boolean;
  sameAsPrevious: boolean;
  error?: string;
}

export async function startAccountLoginFlow(
  provider: string,
  options?: { force?: boolean }
): Promise<StartAccountLoginFlowResult> {
  try {
    return await invokeCommand('start_account_login_flow', {
      provider,
      force: options?.force ?? false,
    });
  } catch (err: any) {
    console.error('[IPC] startAccountLoginFlow failed:', err);
    return { success: false, error: err?.message || String(err) };
  }
}

export async function cancelAccountLoginFlow(
  provider: string,
  flowId?: string | null
): Promise<CancelAccountLoginFlowResult> {
  try {
    return await invokeCommand('cancel_account_login_flow', {
      provider,
      ...(flowId ? { flowId } : {}),
    });
  } catch (err: any) {
    console.error('[IPC] cancelAccountLoginFlow failed:', err);
    return { success: false, restored: false, error: err?.message || String(err) };
  }
}

export async function probeLiveAccountLoginStatus(
  provider: string,
  previousEmail?: string | null
): Promise<LiveAccountLoginProbe> {
  try {
    return await invokeCommand('probe_live_account_login_status', {
      provider,
      ...(previousEmail ? { previousEmail } : {}),
    });
  } catch (err: any) {
    console.warn('[IPC] probeLiveAccountLoginStatus failed:', err);
    return {
      provider,
      authenticated: false,
      credentialStatus: 'error',
      email: null,
      hasRefreshToken: false,
      sameAsPrevious: false,
      error: err?.message || String(err),
    };
  }
}

export async function prepareNewAccountLogin(
  provider: string
): Promise<{ success: boolean; previousEmailSaved?: string | null; loginCommand?: string; keyringDeleted?: boolean; error?: string }> {
  return startAccountLoginFlow(provider);
}

export interface CredentialStatusItem {
  provider: string;
  isConfigured: boolean;
  source: 'vault' | 'env' | 'cli' | 'none';
  preview?: string;
}

export async function getProviderCredentials(): Promise<{ success: boolean; credentials: CredentialStatusItem[] }> {
  if (!isTauriEnvironment()) return { success: true, credentials: [] };
  try {
    return await invokeCommand<{ success: boolean; credentials: CredentialStatusItem[] }>('get_provider_credentials', {});
  } catch {
    return { success: false, credentials: [] };
  }
}

export async function getActiveProviderKey(provider: string): Promise<{ success: boolean; key: string | null; source: string }> {
  if (!isTauriEnvironment()) return { success: false, key: null, source: 'none' };
  try {
    return await invokeCommand<{ success: boolean; key: string | null; source: string }>('get_active_provider_key', { provider });
  } catch {
    return { success: false, key: null, source: 'none' };
  }
}

export async function saveProviderCredential(provider: string, key: string): Promise<{ success: boolean; preview?: string }> {
  if (!isTauriEnvironment()) return { success: false };
  try {
    return await invokeCommand<{ success: boolean; preview?: string }>('save_provider_credential', { provider, key });
  } catch {
    return { success: false };
  }
}

export async function deleteProviderCredential(provider: string): Promise<{ success: boolean }> {
  if (!isTauriEnvironment()) return { success: false };
  try {
    return await invokeCommand<{ success: boolean }>('delete_provider_credential', { provider });
  } catch {
    return { success: false };
  }
}

export async function migrateLocalStorageCredentials(records: Record<string, string>): Promise<{ success: boolean; migrated: number }> {
  if (!isTauriEnvironment()) return { success: false, migrated: 0 };
  try {
    return await invokeCommand<{ success: boolean; migrated: number }>('migrate_localstorage_credentials', { records });
  } catch {
    return { success: false, migrated: 0 };
  }
}

export const DEFAULT_AUTO_SWITCH_POLICY: AutoSwitchPolicy = {
  enabled: false,
  triggerThresholdPercent: 0,
  selectionStrategy: 'highest_quota',
  priorityOrder: [],
  excludedAccountIds: [],
  modelMismatchPolicy: 'confirm_notification',
  busyTerminalsPolicy: 'wait_idle',
  autoContinueChatTurn: true,
  cooldownSeconds: 120,
  maxConsecutiveSwitches: 3,
};

export const DEFAULT_AUTO_SWITCH_STATUS: AutoSwitchRuntimeStatus = {
  paused: false,
  pauseReason: null,
  cooldownUntilMs: null,
  recentSwitchCount: 0,
  nextResetAt: null,
  nextResetMs: null,
  lastErrorCode: null,
};

export interface GetAutoSwitchPolicyResult {
  provider: string;
  policy: AutoSwitchPolicy;
  status: AutoSwitchRuntimeStatus;
}

export interface SaveAutoSwitchPolicyResult {
  success: boolean;
  provider?: string;
  policy?: AutoSwitchPolicy;
  status?: AutoSwitchRuntimeStatus;
  error?: string;
}

export interface ResumeAutoSwitchResult {
  success: boolean;
  provider?: string;
  status?: AutoSwitchRuntimeStatus;
  error?: string;
}

export async function getAutoSwitchPolicy(provider: string): Promise<GetAutoSwitchPolicyResult> {
  try {
    return await invokeCommand<GetAutoSwitchPolicyResult>('get_auto_switch_policy', { provider });
  } catch (err: any) {
    console.warn('[IPC] getAutoSwitchPolicy failed:', err);
    return {
      provider: provider === 'antigravity' ? 'agy' : provider,
      policy: { ...DEFAULT_AUTO_SWITCH_POLICY },
      status: { ...DEFAULT_AUTO_SWITCH_STATUS },
    };
  }
}

export async function saveAutoSwitchPolicy(
  provider: string,
  policy: AutoSwitchPolicy
): Promise<SaveAutoSwitchPolicyResult> {
  try {
    return await invokeCommand<SaveAutoSwitchPolicyResult>('save_auto_switch_policy', {
      provider,
      policy,
    });
  } catch (err: any) {
    console.error('[IPC] saveAutoSwitchPolicy failed:', err);
    return {
      success: false,
      error: err?.message || String(err),
    };
  }
}

export async function resumeAutoSwitch(provider: string): Promise<ResumeAutoSwitchResult> {
  try {
    return await invokeCommand<ResumeAutoSwitchResult>('resume_auto_switch', { provider });
  } catch (err: any) {
    console.error('[IPC] resumeAutoSwitch failed:', err);
    return {
      success: false,
      error: err?.message || String(err),
    };
  }
}

export interface ListPendingAutoSwitchesResult {
  success: boolean;
  confirmations: PendingAutoSwitchConfirmation[];
}

export interface ConfirmPendingAutoSwitchOptions {
  confirmationId: string;
  selectedModelId?: string;
  forceBusy?: boolean;
  autoResumeTurn?: boolean;
}

export interface ConfirmPendingAutoSwitchResult {
  success: boolean;
  confirmationId: string;
  provider?: string;
  toAccountId?: string;
  toAccountLabel?: string;
  appliedModel?: string | null;
  modelAdjusted?: boolean;
  freshCatalogModels?: string[];
  resumedThreadId?: string | null;
  status?: AutoSwitchRuntimeStatus;
  error?: string;
  code?: string;
  expired?: boolean;
  providerBusyKind?: ProviderBusyKind | null;
  canCloseProcesses?: boolean | null;
  residualProcesses?: ResidualProcessSummary[];
  residualProcessCount?: number | null;
  baseAppTitles?: string[];
}

export interface DismissPendingAutoSwitchResult {
  success: boolean;
  dismissed: boolean;
  confirmationId: string;
  error?: string;
}

export async function listPendingAutoSwitches(
  provider?: string
): Promise<ListPendingAutoSwitchesResult> {
  try {
    const payload = provider ? { provider } : {};
    const res = await invokeCommand<ListPendingAutoSwitchesResult>(
      'list_pending_auto_switches',
      payload
    );
    return {
      success: Boolean(res?.success),
      confirmations: Array.isArray(res?.confirmations) ? res.confirmations : [],
    };
  } catch (err) {
    console.warn('[IPC] listPendingAutoSwitches failed:', err);
    return { success: false, confirmations: [] };
  }
}

export async function confirmPendingAutoSwitch(
  options: ConfirmPendingAutoSwitchOptions
): Promise<ConfirmPendingAutoSwitchResult> {
  try {
    const payload: Record<string, unknown> = {
      confirmationId: options.confirmationId,
    };
    if (options.selectedModelId !== undefined) {
      payload.selectedModelId = options.selectedModelId;
    }
    if (options.forceBusy !== undefined) {
      payload.forceBusy = options.forceBusy;
    }
    if (options.autoResumeTurn !== undefined) {
      payload.autoResumeTurn = options.autoResumeTurn;
    }
    return await invokeCommand<ConfirmPendingAutoSwitchResult>(
      'confirm_pending_auto_switch',
      payload
    );
  } catch (err: any) {
    console.error('[IPC] confirmPendingAutoSwitch failed:', err);
    return {
      success: false,
      confirmationId: options.confirmationId,
      error: err?.message || String(err),
    };
  }
}

export async function dismissPendingAutoSwitch(
  confirmationId: string
): Promise<DismissPendingAutoSwitchResult> {
  try {
    return await invokeCommand<DismissPendingAutoSwitchResult>(
      'dismiss_pending_auto_switch',
      { confirmationId }
    );
  } catch (err: any) {
    console.error('[IPC] dismissPendingAutoSwitch failed:', err);
    return {
      success: false,
      dismissed: false,
      confirmationId,
      error: err?.message || String(err),
    };
  }
}
