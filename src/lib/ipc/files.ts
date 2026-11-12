import type {
  FilesResourceResponse,
  FilesDirectoryResponse,
  FilesTextResponse,
  FilesPreviewResponse,
} from '../../types';
import { invokeCommand } from './core';

export async function ensureFilesResource(
  workspaceId: string,
  resourceId?: string | null
): Promise<FilesResourceResponse> {
  return invokeCommand<FilesResourceResponse>('ensure_files_resource', {
    supportedSchemaVersion: 1,
    workspaceId,
    resourceId: resourceId ?? null,
  });
}

export async function listFilesDirectory(
  workspaceId: string,
  resourceId: string,
  parentEntryId: string
): Promise<FilesDirectoryResponse> {
  return invokeCommand<FilesDirectoryResponse>('list_files_directory', {
    supportedSchemaVersion: 1,
    workspaceId,
    resourceId,
    parentEntryId,
  });
}

export async function readFilesText(
  workspaceId: string,
  resourceId: string,
  entryId: string
): Promise<FilesTextResponse> {
  return invokeCommand<FilesTextResponse>('read_files_text', {
    supportedSchemaVersion: 1,
    workspaceId,
    resourceId,
    entryId,
  });
}

export async function saveFilesText(
  workspaceId: string,
  resourceId: string,
  entryId: string,
  revision: string,
  text: string
): Promise<FilesTextResponse> {
  return invokeCommand<FilesTextResponse>('save_files_text', {
    supportedSchemaVersion: 1,
    workspaceId,
    resourceId,
    entryId,
    expectedRevision: revision,
    text,
  });
}

export async function readFilesPreview(
  workspaceId: string,
  resourceId: string,
  entryId: string
): Promise<FilesPreviewResponse> {
  return invokeCommand<FilesPreviewResponse>('read_files_preview', {
    supportedSchemaVersion: 1,
    workspaceId,
    resourceId,
    entryId,
  });
}

export async function closeFilesResource(resourceId: string): Promise<{ closed: boolean }> {
  return invokeCommand<{ closed: boolean }>('close_files_resource', { resourceId });
}

export async function revealFile(params: {
  workspaceId?: string | null;
  relativePath?: string;
  path?: string;
}): Promise<void> {
  return invokeCommand<void>('reveal_file', {
    supportedSchemaVersion: 1,
    ...params,
  });
}

export async function openFileDefault(params: {
  workspaceId?: string | null;
  relativePath?: string;
  path?: string;
}): Promise<void> {
  return invokeCommand<void>('open_file_default', {
    supportedSchemaVersion: 1,
    ...params,
  });
}
