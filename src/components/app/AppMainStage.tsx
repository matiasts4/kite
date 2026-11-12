import React from 'react';
import { AgentsView } from '../views/AgentsView';
import { CodeWorkspace } from '../code/CodeWorkspace';
import { ChatView } from '../views/ChatView';
import { RoutinesView } from '../views/RoutinesView';
import { isTauriEnvironment } from '../../lib/ipc';
import type { WorkMode } from '../Sidebar';
import type { Workspace, AgentProfile } from '../../types';
import type { WorkspaceSessionTab } from '../sidebar/types';

export interface AppMainStageProps {
  workMode: WorkMode;
  setWorkMode: (mode: WorkMode) => void;
  loading: boolean;
  error: string | null;
  workspaces: Workspace[];
  agents: AgentProfile[];
  setAgents: React.Dispatch<React.SetStateAction<AgentProfile[]>>;
  selectedWorkspaceId: string | null;
  setSelectedWorkspaceId: (id: string | null) => void;
  selectedAgentId: string | null;
  setSelectedAgentId: (id: string | null) => void;
  selectedThreadId: string | null;
  agentEditorOpen: boolean;
  setAgentEditorOpen: (open: boolean) => void;
  agentViewMode: 'chats' | 'settings' | 'memory' | 'skills' | 'starters';
  setAgentViewMode: (mode: 'chats' | 'settings' | 'memory' | 'skills' | 'starters') => void;
  routinesOpen: boolean;
  setRoutinesOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  hasOpenedChat: boolean;
  loadBootstrap: () => Promise<void>;
  loadThreads: () => Promise<void>;
  handleAddWorkspace: () => Promise<void>;
  handleCodeSessions: (workspaceId: string, sessions: WorkspaceSessionTab[]) => void;
  requestedCodeTabId: string | null;
  setRequestedCodeTabId: (id: string | null) => void;
  newSessionRequest: number;
}

export const AppMainStage: React.FC<AppMainStageProps> = ({
  workMode,
  setWorkMode,
  loading,
  error,
  workspaces,
  agents,
  setAgents,
  selectedWorkspaceId,
  setSelectedWorkspaceId,
  selectedAgentId,
  setSelectedAgentId,
  selectedThreadId,
  agentEditorOpen,
  setAgentEditorOpen,
  agentViewMode,
  setAgentViewMode,
  routinesOpen,
  setRoutinesOpen,
  setSettingsOpen,
  hasOpenedChat,
  loadBootstrap,
  loadThreads,
  handleAddWorkspace,
  handleCodeSessions,
  requestedCodeTabId,
  setRequestedCodeTabId,
  newSessionRequest,
}) => {
  const renderFallbackView = () => {
    if (!isTauriEnvironment()) {
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--pane)', padding: '32px', height: '100%' }}>
          <div style={{ maxWidth: '440px', width: '100%', background: 'var(--block-fill)', border: '1px solid var(--block-stroke)', borderRadius: 'var(--radius-card)', padding: '24px', boxShadow: 'var(--shadow-sheet)', textAlign: 'center' }}>
            <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'var(--accent-tint)', border: '1px solid var(--accent-tint-strong)', color: 'var(--accent)', margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect width="20" height="14" x="2" y="3" rx="2" />
                <line x1="8" x2="16" y1="21" y2="21" />
                <line x1="12" x2="12" y1="17" y2="21" />
              </svg>
            </div>
            <h3 style={{ fontSize: 'var(--text-body)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)', marginBottom: '8px' }}>
              Kite Code Runs in Tauri Window
            </h3>
            <p style={{ fontSize: 'var(--text-caption)', color: 'var(--text-secondary)', lineHeight: 'var(--leading-body)', marginBottom: '16px' }}>
              This page is running in a standard web browser at http://localhost:1420. Native desktop capabilities (frameless window cromo, child WebView2, ConPTY terminal, and local SQLite IPC) require launching the desktop application.
            </p>
            <div style={{ background: 'var(--terminal-canvas, #0d1117)', border: '1px solid var(--separator)', borderRadius: 'var(--radius-chip)', padding: '12px', fontSize: 'var(--text-mono)', fontFamily: 'var(--font-mono)', color: 'var(--accent)', userSelect: 'all', marginBottom: '16px', textAlign: 'left' }}>
              npm run tauri dev
            </div>
            <p style={{ fontSize: 'var(--text-meta)', color: 'var(--text-faint)', margin: 0 }}>
              Studio runs in the frameless desktop window. Close any lingering background instances first.
            </p>
          </div>
        </div>
      );
    }

    if (loading && workspaces.length === 0 && agents.length === 0) {
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--pane)', height: '100%' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
            <div className="loading-spinner" style={{ width: '24px', height: '24px', borderWidth: '2px' }} />
            <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-secondary)' }}>Connecting to Kite Code...</span>
          </div>
        </div>
      );
    }

    if (error && workspaces.length === 0 && agents.length === 0) {
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--pane)', padding: '24px', height: '100%' }}>
          <div className="ui-status-notice ui-status-notice--warning">
            <h3 className="ui-status-notice__title">Backend Connection Issue</h3>
            <p className="ui-status-notice__message">{error}</p>
            <button onClick={loadBootstrap} className="primary-button" style={{ marginTop: '16px' }}>
              Retry Connection
            </button>
          </div>
        </div>
      );
    }

    switch (workMode) {
      case 'agent':
        return (
          <AgentsView
            agents={agents}
            workspaceId={selectedWorkspaceId}
            selectedAgentId={selectedAgentId}
            onSelectAgent={(id) => {
              setSelectedAgentId(id);
              setAgentEditorOpen(false);
            }}
            agentEditorOpen={agentEditorOpen}
            onCloseAgentEditor={() => setAgentEditorOpen(false)}
            onAgentCreated={(agent) => {
              setAgents((prev) => (prev.some((a) => a.id === agent.id) ? prev : [...prev, agent]));
              setSelectedAgentId(agent.id);
              setAgentEditorOpen(false);
            }}
            onAgentUpdated={(updated) => {
              setAgents((prev) => prev.map((a) => (a.id === updated.id ? { ...a, ...updated } : a)));
            }}
            onAgentDeleted={(agentId) => {
              setAgents((prev) => {
                const remaining = prev.filter((a) => a.id !== agentId);
                if (selectedAgentId === agentId) {
                  setSelectedAgentId(remaining[0]?.id ?? null);
                }
                return remaining;
              });
            }}
            viewMode={agentViewMode}
            onViewModeChange={setAgentViewMode}
            onOpenRoutines={() => {
              setWorkMode('agent');
              setAgentViewMode('settings');
            }}
          />
        );
      case 'code':
        return (
          <CodeWorkspace
            workspaces={workspaces}
            selectedWorkspaceId={selectedWorkspaceId}
            onSelectWorkspace={setSelectedWorkspaceId}
            onRefresh={loadBootstrap}
            onAddWorkspace={handleAddWorkspace}
            agents={agents}
            selectedAgentId={selectedAgentId}
            onSessionsChange={handleCodeSessions}
            requestedTabId={requestedCodeTabId}
            onTabRequestedHandled={() => setRequestedCodeTabId(null)}
          />
        );
      case 'chat':
        return (
          <ChatView
            ownsNewThreadRequests
            workspaceId={selectedWorkspaceId}
            threadId={selectedThreadId}
            agents={agents}
          />
        );
      default:
        return (
          <AgentsView
            agents={agents}
            workspaceId={selectedWorkspaceId}
            selectedAgentId={selectedAgentId}
            onSelectAgent={(id) => {
              setSelectedAgentId(id);
              setAgentEditorOpen(false);
            }}
            agentEditorOpen={agentEditorOpen}
            onCloseAgentEditor={() => setAgentEditorOpen(false)}
            onAgentCreated={(agent) => {
              setAgents((prev) => (prev.some((a) => a.id === agent.id) ? prev : [...prev, agent]));
              setSelectedAgentId(agent.id);
              setAgentEditorOpen(false);
            }}
            onAgentUpdated={(updated) => {
              setAgents((prev) => prev.map((a) => (a.id === updated.id ? { ...a, ...updated } : a)));
            }}
            onAgentDeleted={(agentId) => {
              setAgents((prev) => {
                const remaining = prev.filter((a) => a.id !== agentId);
                if (selectedAgentId === agentId) {
                  setSelectedAgentId(remaining[0]?.id ?? null);
                }
                return remaining;
              });
            }}
            viewMode={agentViewMode}
            onViewModeChange={setAgentViewMode}
            onOpenRoutines={() => {
              setWorkMode('agent');
              setAgentViewMode('settings');
            }}
          />
        );
    }
  };

  return (
    <main className="main-pane main-pane--stacked">
      {isTauriEnvironment() &&
      !(loading && workspaces.length === 0 && agents.length === 0) &&
      !(error && workspaces.length === 0 && agents.length === 0) ? (
        <>
          <div className={`mode-layer${workMode === 'agent' && !routinesOpen ? ' mode-layer--visible' : ''}`}>
            <AgentsView
              agents={agents}
              workspaceId={selectedWorkspaceId}
              selectedAgentId={selectedAgentId}
              onSelectAgent={(id) => {
                setSelectedAgentId(id);
                setAgentEditorOpen(false);
              }}
              agentEditorOpen={agentEditorOpen}
              onCloseAgentEditor={() => setAgentEditorOpen(false)}
              onAgentCreated={(agent) => {
                setAgents((prev) => (prev.some((a) => a.id === agent.id) ? prev : [...prev, agent]));
                setSelectedAgentId(agent.id);
                setAgentEditorOpen(false);
              }}
              onAgentUpdated={(updated) => {
                setAgents((prev) => prev.map((a) => (a.id === updated.id ? { ...a, ...updated } : a)));
              }}
              onAgentDeleted={(agentId) => {
                setAgents((prev) => {
                  const remaining = prev.filter((a) => a.id !== agentId);
                  if (selectedAgentId === agentId) {
                    setSelectedAgentId(remaining[0]?.id ?? null);
                  }
                  return remaining;
                });
              }}
              viewMode={agentViewMode}
              onViewModeChange={setAgentViewMode}
              onOpenRoutines={() => {
                setRoutinesOpen(true);
                setSettingsOpen(false);
              }}
            />
          </div>
          <div className={`mode-layer${workMode === 'code' && !routinesOpen ? ' mode-layer--visible' : ''}`}>
            <CodeWorkspace
              workspaces={workspaces}
              selectedWorkspaceId={selectedWorkspaceId}
              onSelectWorkspace={setSelectedWorkspaceId}
              onRefresh={loadBootstrap}
              onAddWorkspace={handleAddWorkspace}
              agents={agents}
              selectedAgentId={selectedAgentId}
              onSessionsChange={handleCodeSessions}
              requestedTabId={requestedCodeTabId}
              onTabRequestedHandled={() => setRequestedCodeTabId(null)}
              newSessionRequest={newSessionRequest}
            />
          </div>
          <div className={`mode-layer${workMode === 'chat' && !routinesOpen ? ' mode-layer--visible' : ''}`}>
            {hasOpenedChat && (
              <ChatView
                ownsNewThreadRequests
                workspaceId={selectedWorkspaceId}
                threadId={selectedThreadId}
                agents={agents}
                workspaces={workspaces}
                onThreadsChanged={loadThreads}
              />
            )}
          </div>
          {routinesOpen && (
            <div className="mode-layer mode-layer--visible">
              <div className="main-pane__surface">
                <RoutinesView
                  workspaceId={selectedWorkspaceId}
                  onOpenThread={(agentId, _threadId) => {
                    setRoutinesOpen(false);
                    setSelectedAgentId(agentId);
                    setWorkMode('agent');
                    setAgentViewMode('chats');
                  }}
                />
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="mode-layer mode-layer--visible">
          <div className="main-pane__surface">{renderFallbackView()}</div>
        </div>
      )}
    </main>
  );
};
