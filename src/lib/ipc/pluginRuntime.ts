import { invokeCommand, isTauriEnvironment } from './core';

export type PluginSourceKind = 'workspace' | 'globalKite' | 'sharedSystem';
export type PluginManifestFormat =
  | 'native'
  | 'claude'
  | 'cursor'
  | 'geminiExtension'
  | 'legacyManifest';
export type SidecarStateKind =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'unhealthy'
  | 'crashed'
  | 'stopping';

export interface SidecarUiView {
  title: string;
  path: string;
  entrypoint: string;
}

export interface SidecarStatusSnapshot {
  namespacedId: string;
  sidecarId: string;
  pluginId: string;
  pluginName: string;
  displayName: string;
  description: string;
  hasWebUi: boolean;
  views: SidecarUiView[];
  state: SidecarStateKind;
  pid?: number | null;
  upstreamPort?: number | null;
  proxyPort?: number | null;
  proxyUrl?: string | null;
  entryUrl?: string | null;
  logPath: string;
  restartCount: number;
  lastError?: string | null;
  startedAtMs?: number | null;
  builtin?: string | null;
}

export interface PluginSkillSummaryDto {
  id: string;
  name: string;
  description: string;
}

export interface PluginMcpSummaryDto {
  id: string;
  serverName: string;
  transport: string;
}

export interface PluginRecordDto {
  dirId: string;
  name: string;
  displayName: string;
  description: string;
  version?: string | null;
  author?: string | null;
  homepage?: string | null;
  repository?: string | null;
  license?: string | null;
  keywords: string[];
  suggestedPrompts: string[];
  logoDataUri?: string | null;
  source: PluginSourceKind;
  format: PluginManifestFormat;
  rootPath: string;
  enabled: boolean;
  canUninstall: boolean;
  hasHooks: boolean;
  skills: PluginSkillSummaryDto[];
  ruleNames: string[];
  agentSlugs: string[];
  mcpServers: PluginMcpSummaryDto[];
  sidecars: SidecarStatusSnapshot[];
}

export interface PluginRuntimeSettings {
  enableSharedSystemRoots: boolean;
  extraPluginDirs: string[];
  autoStartUiSidecars: boolean;
}

export const DEFAULT_PLUGIN_RUNTIME_SETTINGS: PluginRuntimeSettings = {
  enableSharedSystemRoots: true,
  extraPluginDirs: [],
  autoStartUiSidecars: false,
};

export async function listInstalledPlugins(
  opts?: { workspaceId?: string | null; workspacePath?: string | null; refresh?: boolean },
): Promise<PluginRecordDto[]> {
  if (!isTauriEnvironment()) return [];
  const res = await invokeCommand<PluginRecordDto[]>('plugin_runtime_list', opts ?? {});
  return Array.isArray(res) ? res : [];
}

export async function refreshInstalledPlugins(
  opts?: { workspaceId?: string | null; workspacePath?: string | null },
): Promise<PluginRecordDto[]> {
  if (!isTauriEnvironment()) return [];
  const res = await invokeCommand<PluginRecordDto[]>('plugin_runtime_refresh', opts ?? {});
  return Array.isArray(res) ? res : [];
}

export async function getPluginRuntimeSettings(): Promise<PluginRuntimeSettings> {
  if (!isTauriEnvironment()) return DEFAULT_PLUGIN_RUNTIME_SETTINGS;
  return invokeCommand<PluginRuntimeSettings>('plugin_runtime_get_settings');
}

export async function savePluginRuntimeSettings(
  settings: PluginRuntimeSettings,
  workspaceId?: string | null,
): Promise<PluginRuntimeSettings> {
  return invokeCommand<PluginRuntimeSettings>('plugin_runtime_save_settings', {
    settings,
    workspaceId: workspaceId ?? undefined,
  });
}

export async function setInstalledPluginEnabled(
  dirId: string,
  enabled: boolean,
  workspaceId?: string | null,
): Promise<PluginRecordDto[]> {
  const res = await invokeCommand<PluginRecordDto[]>('plugin_runtime_set_enabled', {
    dirId,
    enabled,
    workspaceId: workspaceId ?? undefined,
  });
  return Array.isArray(res) ? res : [];
}

export async function installPluginFromFolder(
  path: string,
  workspaceId?: string | null,
): Promise<PluginRecordDto> {
  return invokeCommand<PluginRecordDto>('plugin_runtime_install_folder', {
    path,
    workspaceId: workspaceId ?? undefined,
  });
}

export async function installPluginFromGit(
  repoUrl: string,
  opts?: { gitRef?: string; subdir?: string; workspaceId?: string | null },
): Promise<PluginRecordDto> {
  return invokeCommand<PluginRecordDto>('plugin_runtime_install_git', {
    repoUrl,
    gitRef: opts?.gitRef,
    subdir: opts?.subdir,
    workspaceId: opts?.workspaceId ?? undefined,
  });
}

export async function installPluginFromArchive(
  path: string,
  workspaceId?: string | null,
): Promise<PluginRecordDto> {
  return invokeCommand<PluginRecordDto>('plugin_runtime_install_archive', {
    path,
    workspaceId: workspaceId ?? undefined,
  });
}

export async function uninstallInstalledPlugin(
  dirId: string,
  workspaceId?: string | null,
): Promise<void> {
  await invokeCommand<void>('plugin_runtime_uninstall', {
    dirId,
    workspaceId: workspaceId ?? undefined,
  });
}

export async function pickPluginInstallPath(
  mode: 'folder' | 'archive' = 'folder',
): Promise<string | null> {
  if (!isTauriEnvironment()) return null;
  return invokeCommand<string | null>('plugin_runtime_pick_folder', { mode });
}

export async function runSidecarAction(
  namespacedId: string,
  action: 'start' | 'stop' | 'restart' | 'open',
  opts?: { viewPath?: string; workspaceId?: string | null },
): Promise<SidecarStatusSnapshot> {
  return invokeCommand<SidecarStatusSnapshot>('plugin_runtime_sidecar_action', {
    namespacedId,
    action,
    viewPath: opts?.viewPath,
    workspaceId: opts?.workspaceId ?? undefined,
  });
}

export async function fetchSidecarLogs(
  namespacedId: string,
  tailLines = 200,
): Promise<string[]> {
  if (!isTauriEnvironment()) return [];
  const res = await invokeCommand<string[]>('plugin_runtime_sidecar_logs', {
    namespacedId,
    tailLines,
  });
  return Array.isArray(res) ? res : [];
}

export async function listUiSidecars(
  workspaceId?: string | null,
): Promise<SidecarStatusSnapshot[]> {
  if (!isTauriEnvironment()) return [];
  const res = await invokeCommand<SidecarStatusSnapshot[]>(
    'plugin_runtime_list_sidecars',
    workspaceId ? { workspaceId } : {},
  );
  return Array.isArray(res) ? res : [];
}

export type McpAppSurfaceKind = 'aux_pane' | 'global' | 'title' | 'inline';

export interface McpAppEntrypointDto {
  id: string;
  pluginId: string;
  pluginName: string;
  serverName: string;
  toolName: string;
  title: string;
  description?: string | null;
  resourceUri: string;
  surface: McpAppSurfaceKind;
}

export interface McpAppCspDto {
  connectDomains: string[];
  resourceDomains: string[];
  frameDomains: string[];
  baseUriDomains: string[];
}

export interface McpAppResourcePayload {
  uri: string;
  mimeType: string;
  html: string;
  csp: McpAppCspDto;
  prefersBorder?: boolean;
  serverName: string;
}

export interface PluginCatalogSource {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

export interface PluginCatalogEntry {
  id: string;
  sourceId: string;
  sourceName: string;
  name: string;
  displayName: string;
  description: string;
  version?: string | null;
  author?: string | null;
  homepage?: string | null;
  repository?: string | null;
  keywords: string[];
  installKind: 'git' | 'archive' | 'folder';
  installLocation: string;
  gitRef?: string | null;
  subdir?: string | null;
  installed: boolean;
  installedVersion?: string | null;
  updateAvailable: boolean;
}

export interface PluginCatalogFetchError {
  sourceId: string;
  sourceName: string;
  message: string;
}

export interface PluginCatalogFetchResult {
  sources: PluginCatalogSource[];
  entries: PluginCatalogEntry[];
  errors: PluginCatalogFetchError[];
}

export interface ScheduledSidecarStatus {
  namespacedId: string;
  pluginId: string;
  pluginName: string;
  sidecarId: string;
  displayName: string;
  cronExpr: string;
  enabled: boolean;
  lastRunAtMs?: number | null;
  nextRunAtMs?: number | null;
  lastExitCode?: number | null;
  lastError?: string | null;
  runCount: number;
  logPath: string;
}

export async function pluginMcpAppListEntrypoints(
  workspaceId?: string | null,
): Promise<McpAppEntrypointDto[]> {
  if (!isTauriEnvironment()) return [];
  const res = await invokeCommand<McpAppEntrypointDto[]>(
    'plugin_mcp_app_list_entrypoints',
    workspaceId ? { workspaceId } : {},
  );
  return Array.isArray(res) ? res : [];
}

export async function pluginMcpAppReadResource(params: {
  serverName: string;
  uri: string;
  workspaceId?: string | null;
}): Promise<McpAppResourcePayload> {
  return invokeCommand<McpAppResourcePayload>('plugin_mcp_app_read_resource', {
    serverName: params.serverName,
    uri: params.uri,
    workspaceId: params.workspaceId ?? undefined,
  });
}

export async function pluginMcpAppCallTool(params: {
  instanceId: string;
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  workspaceId?: string | null;
}): Promise<Record<string, unknown>> {
  return invokeCommand<Record<string, unknown>>('plugin_mcp_app_call_tool', {
    instanceId: params.instanceId,
    serverName: params.serverName,
    toolName: params.toolName,
    arguments: params.arguments ?? {},
    workspaceId: params.workspaceId ?? undefined,
  });
}

export async function pluginCatalogListSources(): Promise<PluginCatalogSource[]> {
  if (!isTauriEnvironment()) return [];
  const res = await invokeCommand<PluginCatalogSource[]>('plugin_catalog_list_sources');
  return Array.isArray(res) ? res : [];
}

export async function pluginCatalogSaveSources(
  sources: PluginCatalogSource[],
): Promise<PluginCatalogSource[]> {
  const res = await invokeCommand<PluginCatalogSource[]>('plugin_catalog_save_sources', {
    sources,
  });
  return Array.isArray(res) ? res : [];
}

export async function pluginCatalogFetch(
  workspaceId?: string | null,
): Promise<PluginCatalogFetchResult> {
  if (!isTauriEnvironment()) return { sources: [], entries: [], errors: [] };
  return invokeCommand<PluginCatalogFetchResult>(
    'plugin_catalog_fetch',
    workspaceId ? { workspaceId } : {},
  );
}

export async function pluginCatalogInstall(params: {
  sourceId: string;
  entryId: string;
  workspaceId?: string | null;
}): Promise<PluginRecordDto> {
  return invokeCommand<PluginRecordDto>('plugin_catalog_install', {
    sourceId: params.sourceId,
    entryId: params.entryId,
    workspaceId: params.workspaceId ?? undefined,
  });
}

export async function pluginScheduledSidecarsStatus(
  workspaceId?: string | null,
): Promise<ScheduledSidecarStatus[]> {
  if (!isTauriEnvironment()) return [];
  const res = await invokeCommand<ScheduledSidecarStatus[]>(
    'plugin_scheduled_sidecars_status',
    workspaceId ? { workspaceId } : {},
  );
  return Array.isArray(res) ? res : [];
}
