import { useState, useCallback, useEffect, useRef } from 'react';
import { invokeCommand } from '../../../../lib/ipc';
import { ChatProvider, ModelOption, PROVIDER_CATALOG } from '../types';

type ProviderModelsResponse = { models: ModelOption[]; cached?: boolean };

function dynamicProviders(): ChatProvider[] {
  return (Object.keys(PROVIDER_CATALOG) as ChatProvider[]).filter(
    (provider) => PROVIDER_CATALOG[provider].isDynamic
  );
}

export function useChatModels() {
  const [dynamicModelsMap, setDynamicModelsMap] = useState<Record<string, ModelOption[]>>({});
  const [isRefreshingModels, setIsRefreshingModels] = useState<boolean>(false);
  // A provider is requested at most once per mounted session unless a caller forces a refresh.
  const requestedProvidersRef = useRef<Set<string>>(new Set());

  const fetchDynamicModels = useCallback(async (provider: ChatProvider, forceRefresh = false) => {
    if (!forceRefresh) {
      if (requestedProvidersRef.current.has(provider)) return;
      requestedProvidersRef.current.add(provider);
    }
    try {
      const res = await invokeCommand<ProviderModelsResponse>('list_chat_provider_models', {
        provider,
        forceRefresh,
      });
      // An empty response keeps the static catalog and any previously fetched list usable.
      if (res && Array.isArray(res.models) && res.models.length > 0) {
        setDynamicModelsMap((prev) => ({ ...prev, [provider]: res.models }));
      }
    } catch {
      // Ignore background fetch failure, default catalog will be used
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
    isRefreshingModels,
    fetchDynamicModels,
    ensureDynamicModels,
    refreshModels,
  };
}
