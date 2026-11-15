import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { SavedAccountProfile } from '../../types';
import {
  accountVaultStore,
  canonicalVaultProvider,
  type ProviderVaultState,
} from './accountVaultStore';

export interface UseAccountVaultOptions {
  autoLoad?: boolean;
}

export interface UseAccountVaultResult extends ProviderVaultState {
  canonicalProvider: string;
  refresh: (force?: boolean) => Promise<void>;
  switchAccount: (accountId: string, opts?: { force?: boolean }) => ReturnType<typeof accountVaultStore.switchAccount>;
  confirmBusySwitch: () => ReturnType<typeof accountVaultStore.confirmBusySwitch>;
  cancelBusySwitch: () => void;
  saveCurrentAccount: (
    typedLabel?: string,
    opts?: { source?: 'manual' | 'unregistered' | 'popover'; bypassOverwriteGuard?: boolean }
  ) => ReturnType<typeof accountVaultStore.saveCurrentAccount>;
  confirmOverwriteUpdate: () => ReturnType<typeof accountVaultStore.confirmOverwriteUpdate>;
  confirmOverwriteRename: () => ReturnType<typeof accountVaultStore.confirmOverwriteRename>;
  cancelOverwritePrompt: () => void;
  renameProfile: (accountId: string, label: string) => ReturnType<typeof accountVaultStore.renameProfile>;
  requestDeleteProfile: (profile: SavedAccountProfile) => void;
  cancelDeleteProfile: () => void;
  confirmDeleteProfile: () => ReturnType<typeof accountVaultStore.confirmDeleteProfile>;
  refreshQuota: () => Promise<void>;
  closeResidualProcesses: () => ReturnType<typeof accountVaultStore.closeResidualProcesses>;
  alignIde: () => Promise<void>;
  clearFeedback: () => void;
}

export function useAccountVault(
  provider: string,
  options: UseAccountVaultOptions = {}
): UseAccountVaultResult {
  const { autoLoad = true } = options;
  const canon = canonicalVaultProvider(provider);

  const subscribe = useCallback(
    (onStoreChange: () => void) => accountVaultStore.subscribe(canon, onStoreChange),
    [canon]
  );

  const getSnapshot = useCallback(
    () => accountVaultStore.getSnapshot(canon),
    [canon]
  );

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (autoLoad) {
      void accountVaultStore.loadAccounts(canon);
    }
  }, [autoLoad, canon]);

  return useMemo(
    () => ({
      ...state,
      canonicalProvider: canon,
      refresh: async (force = true) => {
        await accountVaultStore.loadAccounts(canon, { force });
      },
      switchAccount: (accountId, opts) =>
        accountVaultStore.switchAccount(canon, accountId, opts),
      confirmBusySwitch: () => accountVaultStore.confirmBusySwitch(canon),
      cancelBusySwitch: () => accountVaultStore.cancelBusySwitch(canon),
      saveCurrentAccount: (typedLabel, opts) =>
        accountVaultStore.saveCurrentAccount(canon, typedLabel, opts),
      confirmOverwriteUpdate: () => accountVaultStore.confirmOverwriteUpdate(canon),
      confirmOverwriteRename: () => accountVaultStore.confirmOverwriteRename(canon),
      cancelOverwritePrompt: () => accountVaultStore.cancelOverwritePrompt(canon),
      renameProfile: (accountId, label) =>
        accountVaultStore.renameProfile(canon, accountId, label),
      requestDeleteProfile: (profile) =>
        accountVaultStore.requestDeleteProfile(canon, profile),
      cancelDeleteProfile: () => accountVaultStore.cancelDeleteProfile(canon),
      confirmDeleteProfile: () => accountVaultStore.confirmDeleteProfile(canon),
      refreshQuota: () => accountVaultStore.refreshQuota(canon),
      closeResidualProcesses: () => accountVaultStore.closeResidualProcesses(canon),
      alignIde: () => accountVaultStore.alignIde(canon),
      clearFeedback: () => accountVaultStore.clearFeedback(canon),
    }),
    [state, canon]
  );
}
