import { useState, useCallback } from 'react';
import { invokeCommand } from '../../../../lib/ipc';
import { ChatProvider, ModelOption } from '../types';

export function useChatModels() {
  const [dynamicModelsMap, setDynamicModelsMap] = useState<Record<string, ModelOption[]>>({});
  const [isRefreshingModels, setIsRefreshingModels] = useState<boolean>(false);

  const fetchDynamicModels = useCallback(async (provider: ChatProvider, forceRefresh = false) => {
    try {
      const res = await invokeCommand<{ models: ModelOption[]; cached?: boolean }>('list_chat_provider_models', {
        provider,
        forceRefresh,
      });
      if (res && Array.isArray(res.models)) {
        setDynamicModelsMap((prev) => ({ ...prev, [provider]: res.models }));
      }
    } catch {
      // Ignore background fetch failure, default catalog will be used
    }
  }, []);

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
    refreshModels,
  };
}
