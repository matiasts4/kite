import React, { useState, useRef, useEffect } from 'react';
import {
  FolderIcon,
  GitBranchIcon,
  ChevronDownIcon,
  SearchIcon,
  CheckIcon,
} from '../ChatIcons';
import { ComposerSurface } from './ComposerSurface';

export interface ComposerContextStripProps {
  currentBranch?: string | null;
  currentWorkspace?: string | null;
  envMode?: 'local' | 'worktree';
  onSelectBranch?: (branch: string) => void;
  onSelectEnvMode?: (mode: 'local' | 'worktree') => void;
  className?: string;
}

const FolderGit2Svg: React.FC<{ size?: number; className?: string }> = ({ size = 14, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    <circle cx="12" cy="13" r="2" />
    <path d="M12 15v3" />
  </svg>
);

export const ComposerContextStrip: React.FC<ComposerContextStripProps> = ({
  currentBranch = 'main',
  currentWorkspace = 'Local',
  envMode = 'local',
  onSelectBranch,
  onSelectEnvMode,
  className = '',
}) => {
  const [isEnvOpen, setIsEnvOpen] = useState(false);
  const [isBranchOpen, setIsBranchOpen] = useState(false);
  const [branchSearch, setBranchSearch] = useState('');

  const envRef = useRef<HTMLDivElement | null>(null);
  const branchRef = useRef<HTMLDivElement | null>(null);

  // Close menus on outside click
  useEffect(() => {
    if (!isEnvOpen && !isBranchOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (envRef.current && !envRef.current.contains(e.target as Node)) {
        setIsEnvOpen(false);
      }
      if (branchRef.current && !branchRef.current.contains(e.target as Node)) {
        setIsBranchOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isEnvOpen, isBranchOpen]);

  // Demo branches for searchable selector
  const availableBranches = ['main', 'master', 'feat/warm-provider-sessions', 'feat/ui-composer', 'develop'];
  const filteredBranches = availableBranches.filter((b) =>
    b.toLowerCase().includes(branchSearch.toLowerCase().trim())
  );

  return (
    <ComposerSurface.ContextStrip className={className}>
      {/* Left: Environment Mode Selector */}
      <div ref={envRef} className="relative inline-flex items-center">
        <button
          type="button"
          onClick={() => setIsEnvOpen((prev) => !prev)}
          className="h-6 px-2 gap-1.5 rounded-sm inline-flex items-center text-2xs font-medium text-secondary-label hover:text-foreground hover:bg-hover-row border-0 bg-transparent cursor-pointer transition-colors"
        >
          {envMode === 'worktree' ? (
            <FolderGit2Svg size={13} className="text-info shrink-0" />
          ) : (
            <FolderIcon size={13} className="text-icon-muted shrink-0" />
          )}
          <span className="truncate max-w-[120px]">
            {envMode === 'worktree' ? 'Worktree' : currentWorkspace || 'Local'}
          </span>
          <ChevronDownIcon size={10} className="opacity-60 shrink-0" />
        </button>

        {isEnvOpen && (
          <div className="absolute bottom-[calc(100%+6px)] left-0 w-44 rounded-card border border-border bg-surface-elevated/95 backdrop-blur-md shadow-xl p-1 z-50 flex flex-col gap-0.5">
            <button
              type="button"
              onClick={() => {
                onSelectEnvMode?.('local');
                setIsEnvOpen(false);
              }}
              className={`h-7 px-2 rounded-sm flex items-center justify-between text-xs text-left cursor-pointer border-0 transition-colors ${
                envMode === 'local'
                  ? 'bg-selected-row text-foreground font-medium'
                  : 'bg-transparent text-secondary-label hover:text-foreground hover:bg-hover-row'
              }`}
            >
              <span className="flex items-center gap-1.5">
                <FolderIcon size={13} className="text-icon-muted" />
                <span>Local Workspace</span>
              </span>
              {envMode === 'local' && <CheckIcon size={12} className="text-primary" />}
            </button>

            <button
              type="button"
              onClick={() => {
                onSelectEnvMode?.('worktree');
                setIsEnvOpen(false);
              }}
              className={`h-7 px-2 rounded-sm flex items-center justify-between text-xs text-left cursor-pointer border-0 transition-colors ${
                envMode === 'worktree'
                  ? 'bg-selected-row text-foreground font-medium'
                  : 'bg-transparent text-secondary-label hover:text-foreground hover:bg-hover-row'
              }`}
            >
              <span className="flex items-center gap-1.5">
                <FolderGit2Svg size={13} className="text-info" />
                <span>Isolated Worktree</span>
              </span>
              {envMode === 'worktree' && <CheckIcon size={12} className="text-primary" />}
            </button>
          </div>
        )}
      </div>

      {/* Right: Searchable Git Branch Selector */}
      <div ref={branchRef} className="ml-auto relative inline-flex items-center">
        <button
          type="button"
          onClick={() => {
            setIsBranchOpen((prev) => !prev);
            setBranchSearch('');
          }}
          className="h-6 px-2 gap-1.5 rounded-sm inline-flex items-center text-2xs font-mono text-secondary-label hover:text-foreground hover:bg-hover-row border-0 bg-transparent cursor-pointer transition-colors"
        >
          <GitBranchIcon size={12} className="text-icon-muted shrink-0" />
          <span className="truncate max-w-[130px]">{currentBranch || 'main'}</span>
          <ChevronDownIcon size={10} className="opacity-60 shrink-0" />
        </button>

        {isBranchOpen && (
          <div className="absolute bottom-[calc(100%+6px)] right-0 w-56 rounded-card border border-border bg-surface-elevated/95 backdrop-blur-md shadow-xl flex flex-col overflow-hidden z-50">
            <div className="h-8 px-2 border-b border-border flex items-center gap-1.5">
              <SearchIcon size={12} className="text-muted-foreground shrink-0" />
              <input
                type="text"
                value={branchSearch}
                onChange={(e) => setBranchSearch(e.target.value)}
                placeholder="Search branches..."
                className="w-full bg-transparent border-0 text-2xs text-foreground placeholder:text-muted-foreground outline-none"
                autoFocus
              />
            </div>
            <div className="p-1 max-h-40 overflow-y-auto flex flex-col gap-0.5">
              {filteredBranches.map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => {
                    onSelectBranch?.(b);
                    setIsBranchOpen(false);
                  }}
                  className={`h-6 px-2 rounded-sm flex items-center justify-between text-2xs font-mono text-left cursor-pointer border-0 transition-colors ${
                    b === currentBranch
                      ? 'bg-selected-row text-foreground font-semibold'
                      : 'bg-transparent text-secondary-label hover:text-foreground hover:bg-hover-row'
                  }`}
                >
                  <span className="truncate">{b}</span>
                  {b === currentBranch && <CheckIcon size={11} className="text-primary" />}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </ComposerSurface.ContextStrip>
  );
};
