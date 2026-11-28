import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { invokeCommand, isTauriEnvironment } from './ipc';
import type {
  AgentUpdatesSummary,
  AgentUpdateAdvisory,
  ToolJobProgress,
} from '../types/agentUpdates';

export type { AgentUpdatesSummary, AgentUpdateAdvisory, ToolJobProgress };

export const AGENT_UPDATES_CHANGED_EVENT = 'kite:agent-updates-changed';
export const AGENT_TOOL_JOB_EVENT = 'kite:agent-tool-job-changed';
export const AGENT_UPDATES_AUTO_CHECK_COOLDOWN_MS = 60_000;
export const AGENT_UPDATES_INITIAL_DELAY_MS = 1500;

interface AgentUpdatesSnapshot {
  summary: AgentUpdatesSummary | null;
  activeJobs: Record<string, ToolJobProgress>;
  isChecking: boolean;
}

let cachedSummary: AgentUpdatesSummary | null = null;
let cachedActiveJobs: Record<string, ToolJobProgress> = {};
let cachedIsChecking = false;
let lastFetchedAtMs = 0;
let inFlightFetch: Promise<AgentUpdatesSummary> | null = null;
let queuedForcedFetch: Promise<AgentUpdatesSummary> | null = null;
let subscriberCount = 0;
let autoCheckTimer: number | null = null;

let snapshot: AgentUpdatesSnapshot = {
  summary: cachedSummary,
  activeJobs: cachedActiveJobs,
  isChecking: cachedIsChecking,
};

const listeners = new Set<(summary: AgentUpdatesSummary) => void>();
const jobListeners = new Set<(job: ToolJobProgress) => void>();
const storeListeners = new Set<() => void>();

function emitSnapshot() {
  snapshot = {
    summary: cachedSummary,
    activeJobs: cachedActiveJobs,
    isChecking: cachedIsChecking,
  };
  for (const fn of storeListeners) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

function subscribeStore(listener: () => void): () => void {
  storeListeners.add(listener);
  return () => {
    storeListeners.delete(listener);
  };
}

function getStoreSnapshot(): AgentUpdatesSnapshot {
  return snapshot;
}

async function runFetchSummary(forceRefresh: boolean): Promise<AgentUpdatesSummary> {
  cachedIsChecking = true;
  emitSnapshot();

  try {
    if (!isTauriEnvironment()) {
      // Mock summary in web browser mode for testing & preview
      const now = Date.now();
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
            checkedAtUnixMs: now,
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
            checkedAtUnixMs: now,
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
            checkedAtUnixMs: now,
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
            checkedAtUnixMs: now,
          },
        },
        lastCheckedUnixMs: now,
      };
      cachedSummary = mock;
      lastFetchedAtMs = now;
      notifySummary(mock);
      return mock;
    }

    const summary = await invokeCommand<AgentUpdatesSummary>('get_agent_updates_summary', {
      forceRefresh,
    });
    if (summary && typeof summary === 'object') {
      cachedSummary = summary;
      lastFetchedAtMs = Date.now();
      notifySummary(summary);
      return summary;
    }
    if (cachedSummary) {
      return cachedSummary;
    }
    return summary;
  } catch (err) {
    console.warn('[agentUpdates] Failed to fetch agent updates summary:', err);
    if (cachedSummary) return cachedSummary;
    throw err;
  } finally {
    cachedIsChecking = false;
    emitSnapshot();
  }
}

export function fetchAgentUpdatesSummary(forceRefresh = false): Promise<AgentUpdatesSummary> {
  if (inFlightFetch) {
    if (!forceRefresh) {
      return inFlightFetch;
    }
    if (!queuedForcedFetch) {
      const runQueued = () => {
        queuedForcedFetch = null;
        return fetchAgentUpdatesSummary(true);
      };
      queuedForcedFetch = inFlightFetch.then(runQueued, runQueued);
    }
    return queuedForcedFetch;
  }

  let current!: Promise<AgentUpdatesSummary>;
  current = runFetchSummary(forceRefresh).then(
    (res) => {
      if (inFlightFetch === current) {
        inFlightFetch = null;
      }
      return res;
    },
    (err) => {
      if (inFlightFetch === current) {
        inFlightFetch = null;
      }
      throw err;
    }
  );
  inFlightFetch = current;
  return current;
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

  const job = await invokeCommand<ToolJobProgress>('start_agent_tool_job', { engine, action });
  if (job && typeof job === 'object' && job.engine) {
    const existing = cachedActiveJobs[job.engine];
    const existingIsTerminalForSameJob =
      existing?.jobId === job.jobId &&
      (existing.status === 'succeeded' ||
        existing.status === 'failed' ||
        existing.status === 'cancelled');
    if (!existingIsTerminalForSameJob) {
      notifyJob(job);
    }
  }
  return job;
}

function notifySummary(summary: AgentUpdatesSummary) {
  emitSnapshot();
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
  cachedActiveJobs = { ...cachedActiveJobs, [job.engine]: job };
  emitSnapshot();
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
  if (job.status === 'succeeded') {
    // Coalesced singleton refresh when any tool job completes.
    void fetchAgentUpdatesSummary(true).catch(() => undefined);
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
        lastFetchedAtMs = Date.now();
        notifySummary(event.payload);
      }
    });
  } catch {
    /* ignore */
  }
}

function shouldSkipAutoCheck(): boolean {
  return (
    cachedSummary !== null &&
    lastFetchedAtMs > 0 &&
    Date.now() - lastFetchedAtMs < AGENT_UPDATES_AUTO_CHECK_COOLDOWN_MS
  );
}

function scheduleSharedAutoCheck() {
  if (typeof window === 'undefined' || autoCheckTimer !== null || shouldSkipAutoCheck()) {
    return;
  }
  autoCheckTimer = window.setTimeout(() => {
    autoCheckTimer = null;
    if (subscriberCount === 0 || shouldSkipAutoCheck()) return;
    void fetchAgentUpdatesSummary(false).catch(() => undefined);
  }, AGENT_UPDATES_INITIAL_DELAY_MS);
}

export function resetAgentUpdatesForTest() {
  if (typeof window !== 'undefined' && autoCheckTimer !== null) {
    window.clearTimeout(autoCheckTimer);
  }
  autoCheckTimer = null;
  subscriberCount = 0;
  cachedSummary = null;
  cachedActiveJobs = {};
  cachedIsChecking = false;
  lastFetchedAtMs = 0;
  inFlightFetch = null;
  queuedForcedFetch = null;
  tauriEventsRegistered = false;
  emitSnapshot();
}

/**
 * Hook to consume live agent update advisories and summary via shared singleton store.
 */
export function useAgentUpdates() {
  const state = useSyncExternalStore(subscribeStore, getStoreSnapshot, getStoreSnapshot);

  const refresh = useCallback(async (force = false) => {
    try {
      await fetchAgentUpdatesSummary(force);
    } catch {
      /* errors logged in fetchAgentUpdatesSummary */
    }
  }, []);

  useEffect(() => {
    subscriberCount += 1;
    void ensureTauriEventListeners();
    scheduleSharedAutoCheck();

    return () => {
      subscriberCount = Math.max(0, subscriberCount - 1);
      if (subscriberCount === 0 && typeof window !== 'undefined' && autoCheckTimer !== null) {
        window.clearTimeout(autoCheckTimer);
        autoCheckTimer = null;
      }
    };
  }, []);

  return {
    summary: state.summary,
    activeJobs: state.activeJobs,
    isChecking: state.isChecking,
    refresh,
    triggerJob: triggerAgentToolJob,
  };
}
