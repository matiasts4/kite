import React from 'react';
import type { Workspace } from '../../types';
import type { AgentEngineDescriptor } from './types';
import { BrandLogo } from '../views/agents/engineMetadata';
import { SquareTerminalIcon } from './codeIcons';

export interface WorkspaceEmptyLauncherProps {
  workspace: Workspace;
  availableEngines: AgentEngineDescriptor[];
  onLaunchAgent: (engineId: string, engineName: string) => void;
  onLaunchTerminal: () => void;
  onLaunchMore: () => void;
  readOnly?: boolean;
}

const SparklesIcon = () => (
  <svg
    aria-hidden="true"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
    <path d="M20 3v4" />
    <path d="M22 5h-4" />
    <path d="M4 17v2" />
    <path d="M5 18H3" />
  </svg>
);

export const WorkspaceEmptyLauncher: React.FC<WorkspaceEmptyLauncherProps> = ({
  workspace,
  availableEngines,
  onLaunchAgent,
  onLaunchTerminal,
  onLaunchMore,
  readOnly = false,
}) => {
  return (
    <section className="empty-surface empty-surface--embedded workspace-empty">
      <span aria-hidden="true" className="empty-surface__icon">
        <SparklesIcon />
      </span>
      <div className="empty-surface__copy">
        <h1>Start vibe coding in {workspace.displayName}</h1>
        <p>Launch a coding agent — it runs in a real terminal inside this pane.</p>
      </div>
      <div className="workspace-empty__launcher">
        <div className="workspace-empty__agents" data-probed="true">
          {availableEngines.map((agent) => (
            <button
              key={agent.wireId}
              className="workspace-empty__agent"
              disabled={readOnly || agent.installed === false}
              onClick={() => onLaunchAgent(agent.wireId, agent.displayName)}
              title={`Launch ${agent.displayName} in ${workspace.displayName}`}
              type="button"
            >
              <BrandLogo engine={agent.wireId} size={15} />
              <span>{agent.displayName}</span>
            </button>
          ))}
          <button
            className="workspace-empty__agent"
            disabled={readOnly}
            onClick={onLaunchTerminal}
            title="A plain shell in this folder"
            type="button"
          >
            <span aria-hidden="true" className="workspace-empty__agent-mark">
              <SquareTerminalIcon size={15} strokeWidth={1.75} />
            </span>
            <span>Terminal</span>
          </button>
        </div>

        <button
          className="workspace-empty__launch-more"
          disabled={readOnly}
          onClick={onLaunchMore}
          title="Open the launch wizard"
          type="button"
        >
          Launch more than one…
        </button>
      </div>
    </section>
  );
};
