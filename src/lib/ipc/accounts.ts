import type { SavedAccountProfile } from '../../types';
import { invokeCommand, isTauriEnvironment } from './core';

export interface ListSavedAccountsResult {
  profiles: SavedAccountProfile[];
  unregisteredLiveSession?: {
    provider: string;
    email: string;
    name?: string | null;
    source?: string | null;
    planName?: string | null;
    primaryRemainingPercent?: number | null;
    primaryResetAt?: string | null;
    timeUntilResetMs?: number | null;
  } | null;
}

export async function listSavedAccounts(provider?: string): Promise<SavedAccountProfile[]> {
  try {
    const res = await invokeCommand<{ schemaVersion: number; profiles: SavedAccountProfile[]; unregisteredLiveSession?: any }>('list_saved_accounts', { provider });
    return res?.profiles || [];
  } catch (err) {
    console.warn('[IPC] listSavedAccounts failed:', err);
    return [];
  }
}

export async function listSavedAccountsFull(provider?: string): Promise<ListSavedAccountsResult> {
  try {
    const res = await invokeCommand<{ schemaVersion: number; profiles: SavedAccountProfile[]; unregisteredLiveSession?: any }>('list_saved_accounts', { provider });
    return {
      profiles: res?.profiles || [],
      unregisteredLiveSession: res?.unregisteredLiveSession || null,
    };
  } catch (err) {
    console.warn('[IPC] listSavedAccountsFull failed:', err);
    return { profiles: [] };
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

export interface SwitchAccountProfileResult {
  success: boolean;
  profile?: SavedAccountProfile;
  code?: string;
  error?: string;
  terminalsRestarted?: number;
  targetedSessionIds?: string[];
  skippedUnaffectedCount?: number;
}

export async function switchAccountProfile(
  provider: string,
  accountId: string
): Promise<SwitchAccountProfileResult> {
  try {
    return await invokeCommand('switch_account_profile', { provider, accountId });
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

export async function prepareNewAccountLogin(
  provider: string
): Promise<{ success: boolean; previousEmailSaved?: string; loginCommand?: string; keyringDeleted?: boolean; error?: string }> {
  try {
    return await invokeCommand('prepare_new_account_login', { provider });
  } catch (err: any) {
    console.error('[IPC] prepareNewAccountLogin failed:', err);
    return { success: false, error: err?.message || String(err) };
  }
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
