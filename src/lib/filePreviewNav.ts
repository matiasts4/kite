export interface FilePreviewRequest {
  candidate: string;
  workspaceId?: string | null;
  line?: number | null;
  column?: number | null;
  preferRendered?: boolean;
  collapseTree?: boolean;
}

export const OPEN_RIGHT_DOCK_FILE_EVENT = 'kite:open-right-dock-file';

let pendingPreviewRequest: FilePreviewRequest | null = null;

export function openFileInRightDock(req: FilePreviewRequest) {
  // Save pending request in case RightDock or FilesView is not yet mounted
  pendingPreviewRequest = {
    collapseTree: true,
    preferRendered: true,
    ...req,
  };

  window.dispatchEvent(
    new CustomEvent<FilePreviewRequest>(OPEN_RIGHT_DOCK_FILE_EVENT, {
      detail: pendingPreviewRequest,
    })
  );
}

export function consumePendingFilePreview(): FilePreviewRequest | null {
  const req = pendingPreviewRequest;
  pendingPreviewRequest = null;
  return req;
}

export function peekPendingFilePreview(): FilePreviewRequest | null {
  return pendingPreviewRequest;
}
