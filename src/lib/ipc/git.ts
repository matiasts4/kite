import { invokeCommand } from './core';

export type WorkspaceFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted';

export interface WorkspaceFileChange {
  path: string;
  status: WorkspaceFileStatus;
  oldPath: string | null;
  staged: boolean;
  unstaged: boolean;
}

export interface WorkspaceChanges {
  isRepo: boolean;
  branch: string | null;
  files: WorkspaceFileChange[];
  workspacePrefix: string;
  upstream: { ahead: number; behind: number } | null;
}

export type DiffLineKind = 'context' | 'added' | 'removed' | 'hunk' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  oldNumber: number | null;
  newNumber: number | null;
  text: string;
}

export interface WorkspaceFileDiff {
  lines: DiffLine[];
  truncated: boolean;
}

export async function readWorkspaceChanges(workspaceId: string): Promise<WorkspaceChanges> {
  return invokeCommand<WorkspaceChanges>('read_workspace_changes', { workspaceId });
}

export interface WorkspaceBranches {
  current: string | null;
  branches: string[];
}

export async function listWorkspaceBranches(workspaceId: string): Promise<WorkspaceBranches> {
  return invokeCommand<WorkspaceBranches>('list_workspace_branches', { workspaceId });
}

export async function switchWorkspaceBranch(workspaceId: string, branch: string): Promise<WorkspaceBranches> {
  return invokeCommand<WorkspaceBranches>('switch_workspace_branch', { workspaceId, branch });
}

export async function createWorkspaceBranch(workspaceId: string, branch: string): Promise<WorkspaceBranches> {
  return invokeCommand<WorkspaceBranches>('create_workspace_branch', { workspaceId, branch });
}

export async function readWorkspaceFileDiff(
  workspaceId: string,
  path: string,
  untracked = false
): Promise<WorkspaceFileDiff> {
  return invokeCommand<WorkspaceFileDiff>('read_workspace_file_diff', { workspaceId, path, untracked });
}

export async function stageWorkspaceChanges(
  workspaceId: string,
  paths: string[]
): Promise<WorkspaceChanges> {
  return invokeCommand<WorkspaceChanges>('stage_workspace_changes', { workspaceId, paths });
}

export async function stageAllWorkspaceChanges(workspaceId: string): Promise<WorkspaceChanges> {
  return invokeCommand<WorkspaceChanges>('stage_all_workspace_changes', { workspaceId });
}

export async function unstageWorkspaceChanges(
  workspaceId: string,
  paths: string[]
): Promise<WorkspaceChanges> {
  return invokeCommand<WorkspaceChanges>('unstage_workspace_changes', { workspaceId, paths });
}

export async function discardWorkspaceChanges(
  workspaceId: string,
  paths: string[]
): Promise<WorkspaceChanges> {
  return invokeCommand<WorkspaceChanges>('discard_workspace_changes', { workspaceId, paths });
}

export async function commitWorkspaceChanges(
  workspaceId: string,
  message: string,
  stageAll = false
): Promise<WorkspaceChanges> {
  return invokeCommand<WorkspaceChanges>('commit_workspace_changes', { workspaceId, message, stageAll });
}

export async function pullWorkspaceChanges(workspaceId: string): Promise<WorkspaceChanges> {
  return invokeCommand<WorkspaceChanges>('pull_workspace_changes', { workspaceId });
}

export async function pushWorkspaceChanges(workspaceId: string): Promise<WorkspaceChanges> {
  return invokeCommand<WorkspaceChanges>('push_workspace_changes', { workspaceId });
}
