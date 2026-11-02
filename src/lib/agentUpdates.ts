import { useState, useEffect, useCallback, useRef } from 'react';
import { invokeCommand, isTauriEnvironment } from './ipc';
import type {
  AgentUpdatesSummary,
  AgentUpdateAdvisory,
  ToolJobProgress,
} from '../types/agentUpdates';

export type { AgentUpdatesSummary, AgentUpdateAdvisory, ToolJobProgress };

export const AGENT_UPDATES_CHANGED_EVENT = 'kite:agent-updates-changed';
export const AGENT_TOOL_JOB_EVENT = 'kite:agent-tool-job-changed';

let cachedSummary: AgentUpdatesSummary | null = null;
const listeners = new Set<(summary: AgentUpdatesSummary) => void>();
const jobListeners = new Set<(job: ToolJobProgress) => void>();

export async function fetchAgentUpdatesSummary(forceRefresh = false): Promise<AgentUpdatesSummary> {
  if (!isTauriEnvironment()) {
    // Mock summary in web browser mode for testing & preview
    const mock: AgentUpdatesSummary = {
      totalSupported: 8,
      installedCount: 4,
      outdatedCount: 2,
      advisories: {
        antigravity: {
          engine: 'antigravity',
          displayName: 'Antigravity',
          state: 'outdated',
          currentVersion: '1.4.5',
          latestVersion: '1.4.12',
          updateCommand: 'agy update',
          installCommand: 'irm https://antigravity.google/cli/install.ps1 | iex',
          binaryPath: 'C:\\Users\\User\\AppData\\Local\\agy\\bin\\agy.exe',
          checkedAtUnixMs: Date.now(),
        },
        codex: {
          engine: 'codex',
          displayName: 'Codex',
          state: 'outdated',
          currentVersion: '0.164.0',
          latestVersion: '0.166.0',
          updateCommand: 'codex update',
          installCommand: 'irm https://chatgpt.com/codex/install.ps1 | iex',
          binaryPath: 'C:\\Users\\User\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe',
          checkedAtUnixMs: Date.now(),
        },
        grok: {
          engine: 'grok',
          displayName: 'Grok Build',
          state: 'up_to_date',
          currentVersion: '1.0.70',
          latestVersion: '1.0.70',
          updateCommand: 'grok update',
          installCommand: 'irm https://x.ai/cli/install.ps1 | iex',
          binaryPath: 'C:\\Users\\User\\.grok\\bin\\grok.exe',
          checkedAtUnixMs: Date.now(),
        },
        claude: {
          engine: 'claude',
          displayName: 'Claude Code',
          state: 'not_installed',
          currentVersion: null,
          latestVersion: '2.1.316',
          updateCommand: 'claude update',
          installCommand: 'irm https://claude.ai/install.ps1 | iex',
          binaryPath: null,
          checkedAtUnixMs: Date.now(),
        },
      },
      lastCheckedUnixMs: Date.now(),
    };
    cachedSummary = mock;
    notifySummary(mock);
    return mock;
  }

  try {
    const summary = await invokeCommand<AgentUpdatesSummary>('get_agent_updates_summary', {
      forceRefresh,
    });
    cachedSummary = summary;
    notifySummary(summary);
    return summary;
  } catch (err) {
    console.warn('[agentUpdates] Failed to fetch agent updates summary:', err);
    if (cachedSummary) return cachedSummary;
    throw err;
  }
}

export async function triggerAgentToolJob(
  engine: string,
  action: 'update' | 'install' = 'update'
): Promise<ToolJobProgress> {
  if (!isTauriEnvironment()) {
    const mockJob: ToolJobProgress = {
      jobId: 'mock-job-' + Date.now(),
      engine,
      action,
      status: 'succeeded',
      percent: 100,
      lastLine: `Completado exitosamente ${action}`,
      startedAtUnixMs: Date.now(),
      finishedAtUnixMs: Date.now() + 500,
    };
    notifyJob(mockJob);
    return mockJob;
  }

  return await invokeCommand<ToolJobProgress>('start_agent_tool_job', { engine, action });
}

function notifySummary(summary: AgentUpdatesSummary) {
  for (const fn of listeners) {
    try {
      fn(summary);
    } catch {
      /* ignore */
    }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<AgentUpdatesSummary>(AGENT_UPDATES_CHANGED_EVENT, { detail: summary })
    );
  }
}

function notifyJob(job: ToolJobProgress) {
  for (const fn of jobListeners) {
    try {
      fn(job);
    } catch {
      /* ignore */
    }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<ToolJobProgress>(AGENT_TOOL_JOB_EVENT, { detail: job })
    );
  }
}

// Global Tauri IPC event listener setup (runs once)
let tauriEventsRegistered = false;
async function ensureTauriEventListeners() {
  if (tauriEventsRegistered || !isTauriEnvironment()) return;
  tauriEventsRegistered = true;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen<ToolJobProgress>('agent:tool-job-changed', (event) => {
      if (event.payload) {
        notifyJob(event.payload);
      }
    });
    await listen<AgentUpdatesSummary>('agent:updates-summary-changed', (event) => {
      if (event.payload) {
        cachedSummary = event.payload;
        notifySummary(event.payload);
      }
    });
  } catch {
    /* ignore */
  }
}

/**
 * Hook to consume live agent update advisories and summary.
 */
export function useAgentUpdates() {
  const [summary, setSummary] = useState<AgentUpdatesSummary | null>(cachedSummary);
  const [activeJobs, setActiveJobs] = useState<Record<string, ToolJobProgress>>({});
  const [isChecking, setIsChecking] = useState(false);
  const mountedRef = useRef(true);

  const refresh = useCallback(async (force = false) => {
    if (mountedRef.current) setIsChecking(true);
    try {
      const data = await fetchAgentUpdatesSummary(force);
      if (mountedRef.current) setSummary(data);
    } finally {
      if (mountedRef.current) setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void ensureTauriEventListeners();

    const unsubSummary = (data: AgentUpdatesSummary) => {
      if (mountedRef.current) setSummary(data);
    };
    listeners.add(unsubSummary);

    const unsubJob = (job: ToolJobProgress) => {
      if (mountedRef.current) {
        setActiveJobs((prev) => ({ ...prev, [job.engine]: job }));
        if (job.status === 'succeeded') {
          // Re-fetch updates summary when job succeeds
          void refresh(true);
        }
      }
    };
    jobListeners.add(unsubJob);

    // Initial query with slight delay to not stall initial paint
    const t = window.setTimeout(() => {
      void refresh(false);
    }, 1500);

    return () => {
      mountedRef.current = false;
      window.clearTimeout(t);
      listeners.delete(unsubSummary);
      jobListeners.delete(unsubJob);
    };
  }, [refresh]);

  return {
    summary,
    activeJobs,
    isChecking,
    refresh,
    triggerJob: triggerAgentToolJob,
  };
}
