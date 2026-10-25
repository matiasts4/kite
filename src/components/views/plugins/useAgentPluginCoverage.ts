import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentProfile } from '../../../types';
import { invokeCommand, listAgentProfiles } from '../../../lib/ipc';

export interface AgentPluginCoverage {
  agents: AgentProfile[];
  loading: boolean;
  error: string | null;
  isPluginEnabledForAgent: (agentId: string, pluginId: string) => boolean;
  activeAgentsForPlugin: (pluginId: string) => AgentProfile[];
  togglePluginForAgent: (agentId: string, pluginId: string, enable: boolean) => Promise<void>;
  refresh: () => Promise<void>;
}

const CACHED_AGENTS_KEY = 'bmone.cached_agents';

export function getFallbackAgents(): AgentProfile[] {
  if (typeof window !== 'undefined') {
    try {
      const cached = localStorage.getItem(CACHED_AGENTS_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch {
      // ignore
    }
  }

  return [
    {
      id: 'default-agent',
      name: 'Orion',
      engine: 'antigravity',
      purpose: 'Autonomous software engineering assistant',
      avatar: null,
      createdAtUnixMs: 1791770226543,
      pinned: true,
      order: 0,
      disabledPluginIds: [],
    },
  ];
}

export function useAgentPluginCoverage(): AgentPluginCoverage {
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [disabledMap, setDisabledMap] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const disabledMapRef = useRef<Record<string, string[]>>(disabledMap);
  disabledMapRef.current = disabledMap;
  const agentsRef = useRef<AgentProfile[]>(agents);
  agentsRef.current = agents;

  const fetchCoverage = useCallback(async () => {
    setLoading(true);
    let loadedAgents: AgentProfile[] = [];

    try {
      const result = await listAgentProfiles();
      if (Array.isArray(result) && result.length > 0) {
        loadedAgents = result;
      } else {
        loadedAgents = getFallbackAgents();
      }
    } catch {
      loadedAgents = getFallbackAgents();
    }

    const nextDisabledMap: Record<string, string[]> = {};

    await Promise.allSettled(
      loadedAgents.map(async (agent) => {
        try {
          const detail = await invokeCommand<any>('load_agent_profile', { agentId: agent.id });
          const disabled = Array.isArray(detail?.disabledPluginIds)
            ? detail.disabledPluginIds
            : Array.isArray(detail?.disabledPluginIDs)
              ? detail.disabledPluginIDs
              : Array.isArray(agent.disabledPluginIds)
                ? agent.disabledPluginIds
                : [];
          nextDisabledMap[agent.id] = disabled;
        } catch {
          nextDisabledMap[agent.id] = Array.isArray(agent.disabledPluginIds)
            ? agent.disabledPluginIds
            : [];
        }
      })
    );

    const updatedAgents = loadedAgents.map((agent) => ({
      ...agent,
      disabledPluginIds: nextDisabledMap[agent.id] ?? [],
    }));

    setAgents(updatedAgents);
    setDisabledMap(nextDisabledMap);
    setLoading(false);
    setError(null);
  }, []);

  useEffect(() => {
    fetchCoverage();
  }, [fetchCoverage]);

  const isPluginEnabledForAgent = useCallback(
    (agentId: string, pluginId: string): boolean => {
      const disabled = disabledMap[agentId] ?? [];
      return !disabled.includes(pluginId);
    },
    [disabledMap]
  );

  const activeAgentsForPlugin = useCallback(
    (pluginId: string): AgentProfile[] => {
      return agents.filter((agent) => isPluginEnabledForAgent(agent.id, pluginId));
    },
    [agents, isPluginEnabledForAgent]
  );

  const togglePluginForAgent = useCallback(
    async (agentId: string, pluginId: string, enable: boolean): Promise<void> => {
      const prevDisabledMap = { ...disabledMapRef.current };
      const prevAgents = [...agentsRef.current];

      const currentDisabled = prevDisabledMap[agentId] ? [...prevDisabledMap[agentId]] : [];
      const nextDisabled = enable
        ? currentDisabled.filter((id) => id !== pluginId)
        : currentDisabled.includes(pluginId)
          ? currentDisabled
          : [...currentDisabled, pluginId];

      const nextMap = { ...prevDisabledMap, [agentId]: nextDisabled };
      const nextAgents = prevAgents.map((a) =>
        a.id === agentId ? { ...a, disabledPluginIds: nextDisabled } : a
      );

      // Optimistic update
      setDisabledMap(nextMap);
      setAgents(nextAgents);
      setError(null);

      try {
        await invokeCommand('update_agent_profile', {
          agentId,
          disabledPluginIds: nextDisabled,
        });

        if (typeof window !== 'undefined') {
          try {
            localStorage.setItem(CACHED_AGENTS_KEY, JSON.stringify(nextAgents));
          } catch {
            // ignore
          }
        }
      } catch (err: any) {
        // Rollback on failure
        setDisabledMap(prevDisabledMap);
        setAgents(prevAgents);
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        throw err;
      }
    },
    []
  );

  return {
    agents,
    loading,
    error,
    isPluginEnabledForAgent,
    activeAgentsForPlugin,
    togglePluginForAgent,
    refresh: fetchCoverage,
  };
}
