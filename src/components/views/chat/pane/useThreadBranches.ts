import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { RefObject } from 'react';
import {
  invokeCommand,
  listWorkspaceBranches,
  switchWorkspaceBranch,
  createWorkspaceBranch,
} from '../../../../lib/ipc';

export interface UseThreadBranchesOptions {
  workspaceId: string | null | undefined;
}

export interface UseThreadBranchesResult {
  isRepo: boolean;
  gitBranch: string | null;
  branches: string[];
  branchesLoading: boolean;
  branchSearch: string;
  setBranchSearch: React.Dispatch<React.SetStateAction<string>>;
  branchDropdownOpen: boolean;
  setBranchDropdownOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isCreatingBranch: boolean;
  setIsCreatingBranch: React.Dispatch<React.SetStateAction<boolean>>;
  newBranchInput: string;
  setNewBranchInput: React.Dispatch<React.SetStateAction<string>>;
  branchError: string | null;
  setBranchError: React.Dispatch<React.SetStateAction<string | null>>;
  branchDropdownRef: RefObject<HTMLDivElement>;
  filteredBranches: string[];
  loadBranches: () => Promise<void>;
  handleSwitchBranch: (b: string) => Promise<void>;
  handleCreateBranch: (branchName?: string) => Promise<void>;
}

export function useThreadBranches({ workspaceId }: UseThreadBranchesOptions): UseThreadBranchesResult {
  const [isRepo, setIsRepo] = useState(false);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchSearch, setBranchSearch] = useState('');
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [newBranchInput, setNewBranchInput] = useState('');
  const [branchError, setBranchError] = useState<string | null>(null);
  const branchDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!workspaceId) {
      setIsRepo(false);
      setGitBranch(null);
      setBranches([]);
      return;
    }
    let active = true;
    void invokeCommand<{ isRepo: boolean; branch?: string }>(
      'read_workspace_changes',
      { workspaceId }
    )
      .then((res) => {
        if (!active || !res) return;
        setIsRepo(Boolean(res.isRepo));
        if (res.branch) setGitBranch(res.branch);
      })
      .catch(() => {});

    void listWorkspaceBranches(workspaceId)
      .then((res) => {
        if (!active || !res) return;
        if (res.branches) setBranches(res.branches);
        if (res.current) setGitBranch(res.current);
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [workspaceId]);

  const loadBranches = useCallback(async () => {
    if (!workspaceId) return;
    setBranchesLoading(true);
    setBranchError(null);
    try {
      const res = await listWorkspaceBranches(workspaceId);
      if (res) {
        setBranches(res.branches || []);
        if (res.current) setGitBranch(res.current);
      }
    } catch (err: any) {
      setBranchError(err?.message || 'Failed to list branches');
    } finally {
      setBranchesLoading(false);
    }
  }, [workspaceId]);

  const handleSwitchBranch = useCallback(async (b: string) => {
    if (!workspaceId) return;
    setBranchError(null);
    try {
      const res = await switchWorkspaceBranch(workspaceId, b);
      if (res?.current) setGitBranch(res.current);
      if (res?.branches) setBranches(res.branches);
      setBranchDropdownOpen(false);
    } catch (err: any) {
      setBranchError(err?.message || `Failed to switch to ${b}`);
    }
  }, [workspaceId]);

  const handleCreateBranch = useCallback(async (branchName?: string) => {
    const name = (typeof branchName === 'string' && branchName.trim()) ? branchName.trim() : newBranchInput.trim();
    if (!workspaceId || !name) return;
    setBranchError(null);
    try {
      const res = await createWorkspaceBranch(workspaceId, name);
      if (res?.current) setGitBranch(res.current);
      if (res?.branches) setBranches(res.branches);
      setNewBranchInput('');
      setIsCreatingBranch(false);
      setBranchDropdownOpen(false);
    } catch (err: any) {
      setBranchError(err?.message || `Failed to create ${name}`);
    }
  }, [workspaceId, newBranchInput]);

  const filteredBranches = useMemo(() => {
    const q = branchSearch.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((b) => b.toLowerCase().includes(q));
  }, [branches, branchSearch]);

  useEffect(() => {
    if (!branchDropdownOpen) return;
    const handleGlobalClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(target)) {
        setBranchDropdownOpen(false);
      }
    };
    window.addEventListener('mousedown', handleGlobalClick);
    return () => window.removeEventListener('mousedown', handleGlobalClick);
  }, [branchDropdownOpen]);

  return {
    isRepo,
    gitBranch,
    branches,
    branchesLoading,
    branchSearch,
    setBranchSearch,
    branchDropdownOpen,
    setBranchDropdownOpen,
    isCreatingBranch,
    setIsCreatingBranch,
    newBranchInput,
    setNewBranchInput,
    branchError,
    setBranchError,
    branchDropdownRef,
    filteredBranches,
    loadBranches,
    handleSwitchBranch,
    handleCreateBranch,
  };
}
