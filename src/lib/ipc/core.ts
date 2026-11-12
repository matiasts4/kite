import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { BootstrapResponse, Workspace } from '../../types';

export function isTauriEnvironment(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)
  );
}

export async function invokeCommand<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isTauriEnvironment()) {
    throw new Error(
      `[IPC] Command '${cmd}' failed: Kite Code is running in a web browser. Launch Studio inside the native Tauri window via 'npm run tauri dev'.`
    );
  }
  // Only wrap non-empty arguments into `{ request: args }` per specification.
  // Zero-argument commands (like bootstrap and window controls) expect an empty payload.
  const hasArgs = args && Object.keys(args).length > 0;
  const payload = hasArgs ? { request: args } : {};
  try {
    return await tauriInvoke<T>(cmd, payload);
  } catch (err) {
    console.warn(`[IPC] Failed to invoke command ${cmd}:`, err);
    throw err;
  }
}

// Window controls
export const windowControls = {
  minimize: () => invokeCommand<void>('app_window_minimize'),
  toggleMaximize: () => invokeCommand<void>('app_window_toggle_maximize'),
  close: () => invokeCommand<void>('app_window_close'),
  startDragging: () => invokeCommand<void>('app_window_start_dragging'),
  isMaximized: () => invokeCommand<boolean>('app_window_is_maximized'),
};

// Bootstrap
export async function getBootstrap(): Promise<BootstrapResponse> {
  return invokeCommand<BootstrapResponse>('bootstrap');
}

export interface AuthBootstrapResponse {
  schemaVersion: number;
  revision: number;
  phase: { kind: string };
  access: { kind: string };
  user?: { name: string; email: string };
  subscriptionTier?: string;
  features?: Record<string, boolean>;
  includedCredits?: number;
}

export async function getCreditsBalance(): Promise<{ balance: number; cycleBalance: number } | null> {
  try {
    return await invokeCommand<{ balance: number; cycleBalance: number }>('credits_balance');
  } catch {
    return null;
  }
}

export async function getAuthBootstrap(): Promise<AuthBootstrapResponse | null> {
  try {
    return await invokeCommand<AuthBootstrapResponse>('auth_bootstrap');
  } catch {
    return null;
  }
}

export async function getSubscriptionQuotas(
  force: boolean = false,
  providers?: string[]
): Promise<Record<string, any>> {
  if (!isTauriEnvironment()) {
    try {
      const res = await fetch(`/api/quota${force ? '?force=1' : ''}`);
      if (res.ok) return await res.json();
    } catch (_) {}
    return {};
  }
  try {
    return await invokeCommand<Record<string, any>>('get_subscription_quotas', { force, providers });
  } catch (err) {
    console.warn('[IPC] Failed to fetch subscription quotas:', err);
    return {};
  }
}

export async function saveOpenCodeApiKey(apiKey: string): Promise<boolean> {
  if (!isTauriEnvironment()) {
    try {
      localStorage.setItem('opencode_go_api_key', apiKey);
      return true;
    } catch {
      return false;
    }
  }
  try {
    return await invokeCommand<boolean>('save_opencode_api_key', { apiKey });
  } catch (err) {
    console.warn('[IPC] Failed to save OpenCode API key:', err);
    return false;
  }
}

export async function clearOpenCodeApiKey(): Promise<boolean> {
  if (!isTauriEnvironment()) {
    try {
      localStorage.removeItem('opencode_go_api_key');
      localStorage.removeItem('opencode_go_auth_cookie');
      localStorage.removeItem('opencode_go_workspace_id');
      return true;
    } catch {
      return false;
    }
  }
  try {
    return await invokeCommand<boolean>('clear_opencode_api_key', {});
  } catch (err) {
    console.warn('[IPC] Failed to clear OpenCode API key:', err);
    return false;
  }
}

export interface ConnectionEndpointView {
  endpointId: string;
  ok: boolean;
}

export interface ConnectionSummary {
  connectionId: string;
  driverKind: string;
  displayName: string;
  authMethod: string;
  accountIdentity: {
    email?: string | null;
    orgId?: string | null;
    accountId?: string | null;
  };
  credentialRef: string;
  billingMode?: string | null;
  endpoints: ConnectionEndpointView[];
  status: string;
  lastCheckedMs?: number | null;
  expiresMs?: number | null;
  lastHttpStatus?: number | null;
}

export async function listConnections(): Promise<ConnectionSummary[]> {
  if (!isTauriEnvironment()) return [];
  try {
    return await invokeCommand<ConnectionSummary[]>('list_connections');
  } catch (err) {
    console.warn('[IPC] Failed to list connections:', err);
    return [];
  }
}

// Workspaces
export async function addWorkspace(): Promise<Workspace | null> {
  return invokeCommand<Workspace | null>('add_workspace', { supportedSchemaVersion: 1 });
}

export async function copyWorkspacePath(workspaceId: string): Promise<string> {
  return invokeCommand<string>('copy_workspace_path', { supportedSchemaVersion: 1, workspaceId });
}

export async function renameWorkspace(workspaceId: string, name: string): Promise<Workspace[]> {
  return invokeCommand<Workspace[]>('rename_workspace', { supportedSchemaVersion: 1, workspaceId, name });
}

export async function setWorkspacePinned(workspaceId: string, pinned: boolean): Promise<Workspace[]> {
  return invokeCommand<Workspace[]>('set_workspace_pinned', { supportedSchemaVersion: 1, workspaceId, pinned });
}

export async function removeWorkspace(workspaceId: string): Promise<Workspace[]> {
  return invokeCommand<Workspace[]>('remove_workspace_from_list', { supportedSchemaVersion: 1, workspaceId });
}

export async function moveWorkspace(workspaceId: string, toIndex: number): Promise<Workspace[]> {
  return invokeCommand<Workspace[]>('move_workspace', { supportedSchemaVersion: 1, workspaceId, toIndex });
}

export function randomUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export async function getSystemMetrics(): Promise<Record<string, any> | null> {
  if (!isTauriEnvironment()) {
    try {
      const res = await fetch('/api/tauri/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'get_system_metrics', args: {} }),
      });
      if (res.ok) return await res.json();
    } catch (_) {}
    return null;
  }
  try {
    return await invokeCommand<Record<string, any>>('get_system_metrics');
  } catch (err) {
    console.warn('[IPC] getSystemMetrics failed:', err);
    return null;
  }
}
