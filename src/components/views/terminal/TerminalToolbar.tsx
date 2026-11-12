import React from 'react';
import { type TerminalAppearancePrefs } from '../../../lib/terminalAppearancePrefs';
import {
  CloseIcon,
  FolderIcon,
  PlayIcon,
  RotateCwIcon,
  SpinnerIcon,
  SquareIcon,
  TerminalIcon,
  TrashIcon,
} from './terminalIcons';

export interface TerminalToolbarProps {
  customTitle?: string;
  oscTitle?: string;
  sessionId?: string;
  appearance?: TerminalAppearancePrefs;
  status: 'idle' | 'connecting' | 'running' | 'exited' | 'terminated';
  exitCode: number | null;
  workspaceId?: string | null;
  engine: string;
  setEngine: (engine: string) => void;
  onClear: () => void;
  onRestart: () => void;
  onTerminate: () => void;
  onLaunch: () => void;
  onClose?: () => void;
}

export const TerminalToolbar: React.FC<TerminalToolbarProps> = ({
  customTitle,
  oscTitle,
  sessionId,
  status,
  exitCode,
  workspaceId,
  engine,
  setEngine,
  onClear,
  onRestart,
  onTerminate,
  onLaunch,
  onClose,
}) => {
  return (
    <header className="terminal-toolbar">
      <div className="terminal-toolbar__left">
        <div className="terminal-toolbar__icon">
          <TerminalIcon size={14} />
        </div>
        <span className="terminal-toolbar__title">{customTitle || oscTitle || 'ConPTY Terminal'}</span>
        <span className="terminal-session-badge" title={sessionId || 'Idle session'}>
          {sessionId ? `[${sessionId}]` : '[Idle]'}
        </span>
        <span className={`terminal-status-pill terminal-status-pill--${status}`}>
          <span className="terminal-status-dot" />
          <span>
            {status === 'running'
              ? 'Active'
              : status === 'connecting'
              ? 'Connecting'
              : status === 'exited'
              ? `Exited (${exitCode ?? 0})`
              : status === 'terminated'
              ? 'Terminated'
              : 'Idle'}
          </span>
        </span>
        {workspaceId && (
          <span className="terminal-workspace-tag" title={`Workspace: ${workspaceId}`}>
            <FolderIcon size={11} />
            <span>{workspaceId}</span>
          </span>
        )}
      </div>

      <div className="terminal-toolbar__right">
        <select
          value={engine}
          onChange={(e) => setEngine(e.target.value)}
          disabled={status === 'running' || status === 'connecting'}
          className="terminal-engine-select"
          title="Select Terminal Shell Engine"
        >
          <option value="powershell">PowerShell</option>
          <option value="gentle-shell">Gentle Shell</option>
          <option value="antigravity">Antigravity (agy)</option>
          <option value="claude-code">Claude Code</option>
          <option value="codex">Codex</option>
          <option value="gemini">Gemini CLI</option>
        </select>

        <button
          onClick={onClear}
          className="terminal-btn terminal-btn--ghost"
          title="Clear Terminal Output"
          type="button"
        >
          <TrashIcon size={13} />
          <span>Clear</span>
        </button>

        {status === 'running' ? (
          <>
            <button
              onClick={onRestart}
              className="terminal-btn terminal-btn--secondary"
              title="Restart Terminal Session"
              type="button"
            >
              <RotateCwIcon size={13} />
              <span>Restart</span>
            </button>
            <button
              onClick={onTerminate}
              className="terminal-btn terminal-btn--danger"
              title="Terminate Terminal Session"
              type="button"
            >
              <SquareIcon size={13} />
              <span>Terminate</span>
            </button>
          </>
        ) : (
          <button
            onClick={onLaunch}
            disabled={status === 'connecting'}
            className="terminal-btn terminal-btn--primary"
            title="Launch Terminal Session"
            type="button"
          >
            {status === 'connecting' ? (
              <>
                <SpinnerIcon size={13} />
                <span>Starting...</span>
              </>
            ) : (
              <>
                <PlayIcon size={13} />
                <span>Launch</span>
              </>
            )}
          </button>
        )}

        {onClose && (
          <button
            onClick={onClose}
            className="terminal-btn terminal-btn--ghost terminal-btn--icon-only"
            title="Close Terminal Pane"
            type="button"
          >
            <CloseIcon size={11} />
          </button>
        )}
      </div>
    </header>
  );
};
