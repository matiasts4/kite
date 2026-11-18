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

const ALL_PROVIDERS: ChatProvider[] = [
  'antigravity',
  'claude',
  'codex',
  'grok',
  'opencode',
  'cursor',
  'gemini',
];

export function useChatAgents(activeProvider?: ChatProvider) {
  const [dynamicAgentsMap, setDynamicAgentsMap] = useState<Record<string, WorkModeOption[]>>({});
  const requestedAgentsRef = useRef<Set<string>>(new Set());

  const fetchDynamicAgents = useCallback(async (provider: ChatProvider, force = false) => {
    if (!force && requestedAgentsRef.current.has(provider)) return;
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

  // Preload agents across all known providers on mount so switching is instant
  // Fetch the active provider immediately and stage non-active providers asynchronously
  // so opening Thread does not blast all 7 provider queries before first paint.
  useEffect(() => {
    if (activeProvider) {
      void fetchDynamicAgents(activeProvider);
    }
    const timer = window.setTimeout(() => {
      ALL_PROVIDERS.forEach((p) => {
        if (p !== activeProvider) {
          void fetchDynamicAgents(p);
        }
      });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [activeProvider, fetchDynamicAgents]);

  const ensureDynamicAgents = useCallback(
    (provider: ChatProvider) => {
      void fetchDynamicAgents(provider);
    },
    [fetchDynamicAgents]
  );

  const refreshAgents = useCallback(
    async (provider?: ChatProvider) => {
      if (provider) {
        requestedAgentsRef.current.delete(provider);
        await fetchDynamicAgents(provider, true);
      } else {
        requestedAgentsRef.current.clear();
        await Promise.all(ALL_PROVIDERS.map((p) => fetchDynamicAgents(p, true)));
      }
    },
    [fetchDynamicAgents]
  );

  return {
    dynamicAgentsMap,
    fetchDynamicAgents,
    ensureDynamicAgents,
    refreshAgents,
  };
}
