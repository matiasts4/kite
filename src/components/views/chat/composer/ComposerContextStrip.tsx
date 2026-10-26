import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  FolderIcon,
  GitBranchIcon,
  ChevronDownIcon,
  SearchIcon,
  CheckIcon,
  PlusIcon,
} from '../ChatIcons';
import { ComposerSurface } from './ComposerSurface';
import { getAnchoredPopoverCoords, PopoverCoords } from './anchoredPosition';

export interface ComposerContextStripProps {
  currentBranch?: string | null;
  branches?: string[];
  currentWorkspace?: string | null;
  workspaces?: Array<{ id: string; name: string }>;
  envMode?: 'local' | 'worktree';
  onSelectBranch?: (branch: string) => void;
  onCreateBranch?: (branch: string) => void;
  onSelectWorkspace?: (wsId: string) => void;
  onSelectEnvMode?: (mode: 'local' | 'worktree') => void;
  className?: string;
}

const FolderGitSvg: React.FC<{ size?: number; className?: string }> = ({ size = 13, className = '' }) => (
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

const MENU_WIDTH = 256;
const MENU_HEIGHT = 260;

export const ComposerContextStrip: React.FC<ComposerContextStripProps> = ({
  currentBranch = 'main',
  branches = [],
  currentWorkspace = 'Local',
  workspaces = [],
  envMode = 'local',
  onSelectBranch,
  onCreateBranch,
  onSelectWorkspace,
  onSelectEnvMode,
  className = '',
}) => {
  const [isEnvOpen, setIsEnvOpen] = useState(false);
  const [isBranchOpen, setIsBranchOpen] = useState(false);
  const [branchSearch, setBranchSearch] = useState('');

  const [envCoords, setEnvCoords] = useState<PopoverCoords | null>(null);
  const [branchCoords, setBranchCoords] = useState<PopoverCoords | null>(null);

  const envBtnRef = useRef<HTMLButtonElement | null>(null);
  const branchBtnRef = useRef<HTMLButtonElement | null>(null);
  const envMenuRef = useRef<HTMLDivElement | null>(null);
  const branchMenuRef = useRef<HTMLDivElement | null>(null);
  const branchSearchInputRef = useRef<HTMLInputElement | null>(null);

  const updatePositions = useCallback(() => {
    if (envBtnRef.current) {
      setEnvCoords(getAnchoredPopoverCoords(envBtnRef.current, MENU_WIDTH, 140, 8, 'top'));
    }
    if (branchBtnRef.current) {
      setBranchCoords(getAnchoredPopoverCoords(branchBtnRef.current, MENU_WIDTH, MENU_HEIGHT, 8, 'top'));
    }
  }, []);

  useLayoutEffect(() => {
    if (isEnvOpen || isBranchOpen) {
      updatePositions();
    }
  }, [isEnvOpen, isBranchOpen, updatePositions]);

  useEffect(() => {
    if (isBranchOpen) {
      setBranchSearch('');
      requestAnimationFrame(() => branchSearchInputRef.current?.focus());
    }
  }, [isBranchOpen]);

  // Close menus on outside click or escape
  useEffect(() => {
    if (!isEnvOpen && !isBranchOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        isEnvOpen &&
        envBtnRef.current &&
        !envBtnRef.current.contains(target) &&
        envMenuRef.current &&
        !envMenuRef.current.contains(target)
      ) {
        setIsEnvOpen(false);
      }
      if (
        isBranchOpen &&
        branchBtnRef.current &&
        !branchBtnRef.current.contains(target) &&
        branchMenuRef.current &&
        !branchMenuRef.current.contains(target)
      ) {
        setIsBranchOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsEnvOpen(false);
        setIsBranchOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updatePositions);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updatePositions);
    };
  }, [isEnvOpen, isBranchOpen, updatePositions]);

  const effectiveBranches =
    branches.length > 0
      ? branches
      : ['main', 'master', 'develop', currentBranch || 'main'];
  const uniqueBranches = Array.from(new Set(effectiveBranches));

  const filteredBranches = uniqueBranches.filter((b) =>
    b.toLowerCase().includes(branchSearch.toLowerCase().trim())
  );

  return (
    <ComposerSurface.ContextStrip className={className}>
      {/* Left: Environment / Workspace Mode Selector */}
      <div>
        <button
          ref={envBtnRef}
          type="button"
          onClick={() => setIsEnvOpen((prev) => !prev)}
          className="kite-context-strip-btn"
          title="Select workspace environment"
          aria-expanded={isEnvOpen}
        >
          {envMode === 'worktree' ? (
            <FolderGitSvg size={13} className="text-info shrink-0" />
          ) : (
            <FolderIcon size={13} className="text-icon-muted shrink-0" />
          )}
          <span style={{ maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {envMode === 'worktree' ? 'Worktree' : currentWorkspace || 'Local'}
          </span>
          <ChevronDownIcon size={10} className="opacity-60 shrink-0" />
        </button>

        {isEnvOpen &&
          envCoords &&
          createPortal(
            <div
              ref={envMenuRef}
              role="dialog"
              aria-label="Workspace Environment"
              className="kite-floating-card kite-context-menu"
              style={{
                left: `${envCoords.left}px`,
                top: `${envCoords.top}px`,
                width: '180px',
              }}
            >
              <button
                type="button"
                className={`kite-context-menu-item ${
                  envMode === 'local' ? 'kite-context-menu-item--selected' : ''
                }`}
                onClick={() => {
                  onSelectEnvMode?.('local');
                  setIsEnvOpen(false);
                }}
              >
                <FolderIcon size={13} className="text-icon-muted shrink-0" />
                <span className="kite-context-menu-item-text">Local Workspace</span>
                {envMode === 'local' && (
                  <CheckIcon size={13} className="shrink-0 text-primary" />
                )}
              </button>

              <button
                type="button"
                className={`kite-context-menu-item ${
                  envMode === 'worktree' ? 'kite-context-menu-item--selected' : ''
                }`}
                onClick={() => {
                  onSelectEnvMode?.('worktree');
                  setIsEnvOpen(false);
                }}
              >
                <FolderGitSvg size={13} className="text-info shrink-0" />
                <span className="kite-context-menu-item-text">Git Worktree</span>
                {envMode === 'worktree' && (
                  <CheckIcon size={13} className="shrink-0 text-primary" />
                )}
              </button>

              {workspaces.length > 0 && (
                <>
                  <div
                    style={{
                      height: '1px',
                      background: 'var(--border, rgba(255,255,255,0.08))',
                      margin: '0.25rem 0',
                    }}
                  />
                  <div
                    style={{
                      padding: '0.25rem 0.5rem',
                      fontSize: '0.625rem',
                      fontWeight: 600,
                      color: 'var(--muted-foreground)',
                      textTransform: 'uppercase',
                    }}
                  >
                    Workspaces
                  </div>
                  {workspaces.map((ws) => (
                    <button
                      key={ws.id}
                      type="button"
                      className="kite-context-menu-item"
                      onClick={() => {
                        onSelectWorkspace?.(ws.id);
                        setIsEnvOpen(false);
                      }}
                    >
                      <FolderIcon size={12} className="shrink-0 text-icon-muted" />
                      <span className="kite-context-menu-item-text">{ws.name}</span>
                    </button>
                  ))}
                </>
              )}
            </div>,
            document.body
          )}
      </div>

      {/* Right: Git Branch Selector */}
      <div>
        <button
          ref={branchBtnRef}
          type="button"
          onClick={() => setIsBranchOpen((prev) => !prev)}
          className="kite-context-strip-btn"
          title={`Git branch: ${currentBranch || 'main'}`}
          aria-expanded={isBranchOpen}
        >
          <GitBranchIcon size={13} className="text-icon-muted shrink-0" />
          <span style={{ maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {currentBranch || 'main'}
          </span>
          <ChevronDownIcon size={10} className="opacity-60 shrink-0" />
        </button>

        {isBranchOpen &&
          branchCoords &&
          createPortal(
            <div
              ref={branchMenuRef}
              role="dialog"
              aria-label="Select Git Branch"
              className="kite-floating-card kite-context-menu"
              style={{
                left: `${branchCoords.left}px`,
                top: `${branchCoords.top}px`,
              }}
            >
              {/* Branch Search Input */}
              <div className="kite-context-menu-search">
                <SearchIcon size={13} className="text-muted-foreground shrink-0" />
                <input
                  ref={branchSearchInputRef}
                  type="text"
                  placeholder="Filter branches..."
                  value={branchSearch}
                  onChange={(e) => setBranchSearch(e.target.value)}
                />
              </div>

              {/* Branch Items List */}
              <div className="kite-context-menu-list">
                {filteredBranches.map((b) => {
                  const isCurrent = b === currentBranch;
                  return (
                    <button
                      key={b}
                      type="button"
                      onClick={() => {
                        onSelectBranch?.(b);
                        setIsBranchOpen(false);
                      }}
                      className={`kite-context-menu-item ${
                        isCurrent ? 'kite-context-menu-item--selected' : ''
                      }`}
                    >
                      <GitBranchIcon size={12} className="shrink-0 text-icon-muted" />
                      <span className="kite-context-menu-item-text">{b}</span>
                      {isCurrent && (
                        <CheckIcon size={13} className="shrink-0 text-primary" />
                      )}
                    </button>
                  );
                })}

                {/* Option to create new branch if search does not match */}
                {branchSearch.trim() &&
                  !uniqueBranches.some(
                    (b) => b.toLowerCase() === branchSearch.trim().toLowerCase()
                  ) && (
                    <button
                      type="button"
                      onClick={() => {
                        onCreateBranch?.(branchSearch.trim());
                        setIsBranchOpen(false);
                      }}
                      className="kite-context-menu-item"
                      style={{ color: 'var(--primary, #3b82f6)' }}
                    >
                      <PlusIcon size={13} className="shrink-0" />
                      <span className="kite-context-menu-item-text">
                        Create branch "{branchSearch.trim()}"
                      </span>
                    </button>
                  )}
              </div>
            </div>,
            document.body
          )}
      </div>
    </ComposerSurface.ContextStrip>
  );
};
