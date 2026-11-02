import { useState, useCallback, useEffect, useRef } from 'react';
import { invokeCommand } from '../../../../lib/ipc';
import { ChatProvider } from '../types';

export interface WorkModeOption {
  id: string;
  label: string;
  detail?: string;
  plan?: boolean;
  mode?: string;
}

type ProviderAgentsResponse = { provider: string; agents: WorkModeOption[] };

export function useChatAgents(activeProvider?: ChatProvider) {
  const [dynamicAgentsMap, setDynamicAgentsMap] = useState<Record<string, WorkModeOption[]>>({});
  const requestedAgentsRef = useRef<Set<string>>(new Set());

  const fetchDynamicAgents = useCallback(async (provider: ChatProvider) => {
    if (requestedAgentsRef.current.has(provider)) return;
    requestedAgentsRef.current.add(provider);
    try {
      const res = await invokeCommand<ProviderAgentsResponse>('list_provider_agents', {
        provider,
      });
      if (res && Array.isArray(res.agents) && res.agents.length > 0) {
        setDynamicAgentsMap((prev) => ({ ...prev, [provider]: res.agents }));
      }
    } catch {
      requestedAgentsRef.current.delete(provider);
    }
  }, []);

  // Fetch agents for the active provider on mount and when provider changes
  useEffect(() => {
    if (activeProvider) {
      void fetchDynamicAgents(activeProvider);
    }
    // Also preload OpenCode agents if not yet fetched since OpenCode has custom agents
    void fetchDynamicAgents('opencode');
  }, [activeProvider, fetchDynamicAgents]);

  const ensureDynamicAgents = useCallback(
    (provider: ChatProvider) => {
      void fetchDynamicAgents(provider);
    },
    [fetchDynamicAgents]
  );

  return {
    dynamicAgentsMap,
    fetchDynamicAgents,
    ensureDynamicAgents,
  };
}
