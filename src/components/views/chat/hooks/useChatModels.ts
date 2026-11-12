import { useState, useCallback, useEffect, useRef } from 'react';
import { invokeCommand } from '../../../../lib/ipc';
import { ChatProvider, ModelOption, PROVIDER_CATALOG } from '../types';
import type { CatalogEmptyKind } from '../catalogEmptyState';

export type CatalogAvailability = CatalogEmptyKind | 'ready';

type ProviderModelsResponse = {
  models: ModelOption[];
  cached?: boolean;
  catalogState?: 'missing-binary' | 'signed-out' | 'ready';
};

function dynamicProviders(): ChatProvider[] {
  return (Object.keys(PROVIDER_CATALOG) as ChatProvider[]).filter(
    (provider) => PROVIDER_CATALOG[provider].isDynamic
  );
}

export function useChatModels() {
  const [dynamicModelsMap, setDynamicModelsMap] = useState<Record<string, ModelOption[]>>({});
  const [catalogStateMap, setCatalogStateMap] = useState<Record<string, CatalogAvailability>>({});
  const [isRefreshingModels, setIsRefreshingModels] = useState<boolean>(false);
  // A successful list is requested at most once per mounted session unless a
  // caller forces a refresh. An empty or failed fetch stays retryable so
  // selecting that provider later can pick up a catalog that was not ready
  // at mount (Grok's CLI list is often empty until the account cache is read).
  const requestedProvidersRef = useRef<Set<string>>(new Set());
  const inFlightProvidersRef = useRef<Set<string>>(new Set());

  const fetchDynamicModels = useCallback(async (provider: ChatProvider, forceRefresh = false) => {
    if (!forceRefresh) {
      if (requestedProvidersRef.current.has(provider)) return;
      if (inFlightProvidersRef.current.has(provider)) return;
    }
    inFlightProvidersRef.current.add(provider);
    setCatalogStateMap((prev) => ({ ...prev, [provider]: 'loading' }));
    try {
      const res = await invokeCommand<ProviderModelsResponse>('list_chat_provider_models', {
        provider,
        forceRefresh,
      });
      const models = res && Array.isArray(res.models) ? res.models : [];
      const remote = res?.catalogState;
      const nextState: CatalogAvailability =
        models.length > 0
          ? 'ready'
          : remote === 'missing-binary' || remote === 'signed-out'
            ? remote
            : 'empty';
      setCatalogStateMap((prev) => ({ ...prev, [provider]: nextState }));
      // An empty response keeps the static catalog and any previously fetched list usable.
      if (models.length > 0) {
        requestedProvidersRef.current.add(provider);
        setDynamicModelsMap((prev) => ({ ...prev, [provider]: models }));
      }
    } catch {
      setCatalogStateMap((prev) => ({
        ...prev,
        [provider]: prev[provider] === 'loading' ? 'empty' : prev[provider],
      }));
    } finally {
      inFlightProvidersRef.current.delete(provider);
    }
  }, []);

  // Prefetch every dynamic provider in the background so the model menu is ready
  // before the user opens it. The dedupe guard keeps repeat calls cheap.
  useEffect(() => {
    for (const provider of dynamicProviders()) {
      void fetchDynamicModels(provider);
    }
  }, [fetchDynamicModels]);

  const ensureDynamicModels = useCallback(
    (provider: ChatProvider) => {
      void fetchDynamicModels(provider);
    },
    [fetchDynamicModels]
  );

  const refreshModels = useCallback(async (provider: ChatProvider) => {
    setIsRefreshingModels(true);
    try {
      await fetchDynamicModels(provider, true);
    } finally {
      setIsRefreshingModels(false);
    }
  }, [fetchDynamicModels]);

  return {
    dynamicModelsMap,
    catalogStateMap,
    isRefreshingModels,
    fetchDynamicModels,
    ensureDynamicModels,
    refreshModels,
  };
}
