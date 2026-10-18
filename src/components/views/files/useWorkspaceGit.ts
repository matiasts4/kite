import { useState, useEffect, useCallback, useMemo } from 'react';
import type {
  GitFileChange,
  WorkspaceChanges,
} from './gitTypes';
import { createWorkspaceGitService } from './gitTypes';
import type { DiffData } from '../chat/types';

export function useWorkspaceGit(currentWsId: string | null) {
  const gitService = useMemo(() => createWorkspaceGitService(), []);

  const [gitChanges, setGitChanges] = useState<WorkspaceChanges | null>(null);
  const [gitLoading, setGitLoading] = useState<boolean>(false);
  const [gitError, setGitError] = useState<string | null>(null);

  const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);
  const [diffData, setDiffData] = useState<DiffData | null>(null);
  const [diffLoading, setDiffLoading] = useState<boolean>(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const [gitBusy, setGitBusy] = useState<string | null>(null);
  const [gitWriteError, setGitWriteError] = useState<string | null>(null);
  const [commitDraft, setCommitDraft] = useState<string>('');

  const refreshGit = useCallback(
    async (wsId: string) => {
      gitService.clearCache?.();
      setGitLoading(true);
      setGitError(null);
      try {
        const changes = await gitService.readWorkspaceChanges(wsId);
        setGitChanges(changes);
        setSelectedDiffPath((prev) => {
          if (prev && !changes.files.some((f) => f.path === prev)) {
            setDiffData(null);
            return null;
          }
          return prev;
        });
      } catch (err: unknown) {
        const msg = String((err as { message?: string })?.message || err || '');
        if (
          msg.includes('not_a_repository') ||
          msg.includes('not a git repository') ||
          msg.includes('Command') ||
          msg.includes('not found') ||
          msg.includes('running in a web browser')
        ) {
          setGitChanges({
            isRepo: false,
            branch: null,
            files: [],
            workspacePrefix: '',
            upstream: null,
          });
        } else {
          setGitError(msg || 'Changes could not be read for this folder.');
        }
      } finally {
        setGitLoading(false);
      }
    },
    [gitService]
  );

  useEffect(() => {
    if (currentWsId) {
      void refreshGit(currentWsId);
    } else {
      setGitChanges(null);
      setSelectedDiffPath(null);
      setDiffData(null);
      setGitError(null);
    }
  }, [currentWsId, refreshGit]);

  useEffect(() => {
    if (!currentWsId || !selectedDiffPath || !gitChanges?.isRepo) {
      setDiffData(null);
      setDiffError(null);
      return;
    }
    const file = gitChanges.files.find((f) => f.path === selectedDiffPath);
    if (!file) return;

    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);

    gitService
      .readWorkspaceFileDiff(currentWsId, file.path, file.status === 'untracked')
      .then((data) => {
        if (!cancelled) setDiffData(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg = String((err as { message?: string })?.message || err || '');
          setDiffError(msg || "This file's diff could not be read.");
        }
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [currentWsId, selectedDiffPath, gitChanges, gitService]);

  const handleStageFile = useCallback(
    async (file: GitFileChange) => {
      if (!currentWsId) return;
      setGitBusy('Staging…');
      setGitWriteError(null);
      try {
        const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
        const updated = await gitService.stageWorkspaceChanges(currentWsId, paths);
        setGitChanges(updated);
      } catch (err: unknown) {
        setGitWriteError(String((err as { message?: string })?.message || err || 'Staging failed.'));
      } finally {
        setGitBusy(null);
      }
    },
    [currentWsId, gitService]
  );

  const handleUnstageFile = useCallback(
    async (file: GitFileChange) => {
      if (!currentWsId) return;
      setGitBusy('Unstaging…');
      setGitWriteError(null);
      try {
        const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
        const updated = await gitService.unstageWorkspaceChanges(currentWsId, paths);
        setGitChanges(updated);
      } catch (err: unknown) {
        setGitWriteError(String((err as { message?: string })?.message || err || 'Unstaging failed.'));
      } finally {
        setGitBusy(null);
      }
    },
    [currentWsId, gitService]
  );

  const handleToggleStage = useCallback(
    (file: GitFileChange, isStaged: boolean) => {
      if (isStaged) {
        void handleUnstageFile(file);
      } else {
        void handleStageFile(file);
      }
    },
    [handleStageFile, handleUnstageFile]
  );

  const handleStageAll = useCallback(async () => {
    if (!currentWsId) return;
    setGitBusy('Staging all…');
    setGitWriteError(null);
    try {
      const updated = await gitService.stageAllWorkspaceChanges(currentWsId);
      setGitChanges(updated);
    } catch (err: unknown) {
      setGitWriteError(String((err as { message?: string })?.message || err || 'Stage all failed.'));
    } finally {
      setGitBusy(null);
    }
  }, [currentWsId, gitService]);

  const handleUnstageAll = useCallback(async () => {
    if (!currentWsId || !gitChanges) return;
    const stagedPaths = gitChanges.files.filter((f) => f.staged).map((f) => f.path);
    if (stagedPaths.length === 0) return;
    setGitBusy('Unstaging all…');
    setGitWriteError(null);
    try {
      const updated = await gitService.unstageWorkspaceChanges(currentWsId, stagedPaths);
      setGitChanges(updated);
    } catch (err: unknown) {
      setGitWriteError(String((err as { message?: string })?.message || err || 'Unstage all failed.'));
    } finally {
      setGitBusy(null);
    }
  }, [currentWsId, gitChanges, gitService]);

  const handleDiscardChanges = useCallback(
    async (file: GitFileChange) => {
      if (!currentWsId) return;
      setGitBusy('Discarding…');
      setGitWriteError(null);
      try {
        const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
        const updated = await gitService.discardWorkspaceChanges(currentWsId, paths);
        setGitChanges(updated);
        if (selectedDiffPath === file.path) {
          setSelectedDiffPath(null);
          setDiffData(null);
        }
      } catch (err: unknown) {
        setGitWriteError(String((err as { message?: string })?.message || err || 'Discarding failed.'));
      } finally {
        setGitBusy(null);
      }
    },
    [currentWsId, selectedDiffPath, gitService]
  );

  const handleCommit = useCallback(
    async (message: string, stageAll: boolean) => {
      if (!currentWsId) return;
      setGitBusy(stageAll ? 'Committing all…' : 'Committing…');
      setGitWriteError(null);
      try {
        const updated = await gitService.commitWorkspaceChanges(currentWsId, message, stageAll);
        setGitChanges(updated);
        setCommitDraft('');
      } catch (err: unknown) {
        setGitWriteError(String((err as { message?: string })?.message || err || 'Commit failed.'));
      } finally {
        setGitBusy(null);
      }
    },
    [currentWsId, gitService]
  );

  const handlePull = useCallback(async () => {
    if (!currentWsId) return;
    setGitBusy('Pulling…');
    setGitWriteError(null);
    try {
      const updated = await gitService.pullWorkspaceChanges(currentWsId);
      setGitChanges(updated);
    } catch (err: unknown) {
      setGitWriteError(String((err as { message?: string })?.message || err || 'Pull failed.'));
    } finally {
      setGitBusy(null);
    }
  }, [currentWsId, gitService]);

  const handlePush = useCallback(async () => {
    if (!currentWsId) return;
    setGitBusy('Pushing…');
    setGitWriteError(null);
    try {
      const updated = await gitService.pushWorkspaceChanges(currentWsId);
      setGitChanges(updated);
    } catch (err: unknown) {
      setGitWriteError(String((err as { message?: string })?.message || err || 'Push failed.'));
    } finally {
      setGitBusy(null);
    }
  }, [currentWsId, gitService]);

  return {
    gitChanges,
    gitLoading,
    gitError,
    selectedDiffPath,
    diffData,
    diffLoading,
    diffError,
    gitBusy,
    gitWriteError,
    commitDraft,
    setCommitDraft,
    setSelectedDiffPath,
    setGitWriteError,
    refreshGit,
    handleStageFile,
    handleUnstageFile,
    handleToggleStage,
    handleStageAll,
    handleUnstageAll,
    handleDiscardChanges,
    handleCommit,
    handlePull,
    handlePush,
  };
}
