import { useEffect, useRef } from 'react';
import type { OpenFileTab } from './CodeEditorPane';
import type { FilePreviewRequest } from '../../../lib/filePreviewNav';

export interface UseFilesTabsPersistenceOptions {
  currentWsId: string | null;
  resourceId: string | null;
  openFiles: OpenFileTab[];
  activeFileId: string | null;
  isEditMode: boolean;
  setIsEditMode: (mode: boolean) => void;
  setOpenFiles: React.Dispatch<React.SetStateAction<OpenFileTab[]>>;
  setActiveFileId: (id: string | null) => void;
  openCandidate: (req: FilePreviewRequest) => Promise<void>;
}

export function useFilesTabsPersistence({
  currentWsId,
  resourceId,
  openFiles,
  activeFileId,
  isEditMode,
  setIsEditMode,
  setOpenFiles,
  setActiveFileId,
  openCandidate,
}: UseFilesTabsPersistenceOptions) {
  const isRestoringTabsRef = useRef(false);
  const restoredWorkspaceRef = useRef<string | null>(null);

  // 1. Restore tabs when workspace resource is ready
  useEffect(() => {
    if (!currentWsId || !resourceId || restoredWorkspaceRef.current === currentWsId) return;
    restoredWorkspaceRef.current = currentWsId;

    try {
      const raw = localStorage.getItem(`kite.files.viewState.${currentWsId}`);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.openRelativePaths) || parsed.openRelativePaths.length === 0) return;

      if (parsed.isEditMode !== undefined) {
        setIsEditMode(parsed.isEditMode);
      }

      isRestoringTabsRef.current = true;
      void (async () => {
        try {
          for (const candidate of parsed.openRelativePaths) {
            await openCandidate({
              candidate,
              workspaceId: currentWsId,
              collapseTree: false,
            });
          }
          if (parsed.activeRelativePath) {
            setOpenFiles((currentTabs) => {
              const match = currentTabs.find((t) => t.relativePath === parsed.activeRelativePath);
              if (match) {
                setActiveFileId(match.entryId);
              }
              return currentTabs;
            });
          }
        } finally {
          isRestoringTabsRef.current = false;
        }
      })();
    } catch {}
  }, [currentWsId, resourceId, openCandidate, setIsEditMode, setOpenFiles, setActiveFileId]);

  // 2. Persist tabs & active file whenever they change
  useEffect(() => {
    if (!currentWsId || isRestoringTabsRef.current) return;
    try {
      const active = openFiles.find((f) => f.entryId === activeFileId);
      const stateToStore = {
        activeRelativePath: active?.relativePath || null,
        openRelativePaths: openFiles.map((f) => f.relativePath),
        isEditMode,
      };
      localStorage.setItem(`kite.files.viewState.${currentWsId}`, JSON.stringify(stateToStore));
    } catch {}
  }, [currentWsId, openFiles, activeFileId, isEditMode]);
}
