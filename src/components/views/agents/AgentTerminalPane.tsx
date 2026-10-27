import React, { useEffect, useState } from 'react';
import { TerminalView } from '../TerminalView';
import { SquareTerminalIcon } from '../../code/codeIcons';
import { invokeCommand } from '../../../lib/ipc';
import { markTerminalExited } from '../../../lib/terminalRegistry';
import { suppressProactiveAnnouncement } from '../../../lib/operator/proactiveWatcher';
import {
  BrandLogo,
  getEngineDisplayName,
  getEngineInstallHint,
} from './engineMetadata';
import { AgentAutoPilot } from './AgentAutoPilot';
import { AgentPaneResumeModal } from '../../modals/AgentPaneResumeModal';

export {
  type EngineMeta,
  ENGINE_METADATA,
  BrandLogo,
  getEngineDisplayName,
  getEngineVendor,
  getEngineInstallHint,
  supportsAgentChat,
  isTerminalEngine,
} from './engineMetadata';

export interface AgentTerminalPaneProps {
  agentId?: string;
  agentName: string;
  engine: string;
  readOnly?: boolean;
  workspaceId?: string | null;
}

type Phase = 'suspended' | 'loading' | 'running' | 'exited' | 'error';

const sessions = new Map<string, string>();

const PlayIcon = () => (
  <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
    <polygon points="6 4 20 12 6 20" />
  </svg>
);

const StopIcon = () => (
  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
    <rect x="5" y="5" width="14" height="14" rx="1.5" />
  </svg>
);

const AlertIcon = () => (
  <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v5" />
    <path d="M12 16h.01" />
  </svg>
);

export const AgentTerminalPane: React.FC<AgentTerminalPaneProps> = ({
  agentId,
  agentName,
  engine,
  readOnly = false,
  workspaceId,
}) => {
  const key = agentId || agentName;
  const [sessionId, setSessionId] = useState<string | null>(() => sessions.get(key) ?? null);
  const [phase, setPhase] = useState<Phase>(sessionId ? 'loading' : 'suspended');
  const [stopping, setStopping] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<boolean>(true);
  const [resumeOpen, setResumeOpen] = useState(false);
  const engineName = getEngineDisplayName(engine);

  useEffect(() => {
    const remembered = sessions.get(key) ?? null;
    setSessionId(remembered);
    setPhase(remembered ? 'loading' : 'suspended');
    setInlineError(null);
    setStopping(false);
  }, [key]);

  useEffect(() => {
    let cancelled = false;
    invokeCommand<{ teammates?: Array<{ engine?: string; installed?: boolean }> }>('get_agent_availability', {
      supportedSchemaVersion: 1,
    })
      .then((res) => {
        if (cancelled) return;
        const row = res.teammates?.find((item) => item.engine === engine);
        setInstalled(row ? row.installed !== false : true);
      })
      .catch(() => {
        if (!cancelled) setInstalled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [engine]);

  const launch = () => {
    if (readOnly || !installed) return;
    const next = globalThis.crypto.randomUUID();
    sessions.set(key, next);
    setInlineError(null);
    setPhase('loading');
    setSessionId(next);
  };

  const stop = async () => {
    if (!sessionId || stopping) return;
    setStopping(true);
    setInlineError(null);
    // A deliberate stop is not an agent finishing: never announce it (S6).
    suppressProactiveAnnouncement(sessionId);
    try {
      await invokeCommand('terminate_terminal', { sessionId, owner: 'user' });
      // S4: keep the registry synchronized only after the IPC confirms the exit.
      markTerminalExited(sessionId);
      if (sessions.get(key) === sessionId) sessions.delete(key);
      setSessionId(null);
      setPhase('suspended');
    } catch {
      setInlineError('The terminal could not be stopped safely. Try again.');
    } finally {
      setStopping(false);
    }
  };

  const startNewSession = async () => {
    if (readOnly || !sessionId) return;
    try {
      await invokeCommand('terminate_terminal', { sessionId, owner: 'user' });
    } catch {
      setInlineError('The exited session could not be retired safely. Try Stop again.');
      return;
    }
    if (sessions.get(key) === sessionId) sessions.delete(key);
    launch();
  };

  const notice = (
    <div className="agent-terminal__notice">
      <SquareTerminalIcon size={14} />
      <p>
        {engineName} runs here in a native terminal from {agentName}’s protected home. Only the Agent brief is sent at startup; memory and skills stay out of this session.
      </p>
    </div>
  );

  if (!installed) {
    return (
      <div className="agent-terminal" data-state="idle">
        {notice}
        <div className="agent-terminal__state agent-terminal__state--error" role="alert">
          <AlertIcon />
          <strong>{engineName} isn’t available on this system</strong>
          <span>{getEngineInstallHint(engine)}</span>
          <button
            type="button"
            className="install-agent-button"
            onClick={() => {
              void invokeCommand('start_agent_install', { engine, supportedSchemaVersion: 1 }).catch(() => {});
            }}
          >
            Install
          </button>
        </div>
      </div>
    );
  }

  if (sessionId === null) {
    return (
      <div className="agent-terminal" data-state="idle">
        {notice}
        <div className="agent-terminal__state" role="status">
          <span aria-hidden="true" className="agent-terminal__logo">
            <BrandLogo engine={engine} size={28} />
          </span>
          <strong>{agentName} isn’t running</strong>
          <span>Launch it and it runs here, from its own home — no folder to pick.</span>
          <button
            type="button"
            className="primary-button"
            disabled={readOnly}
            title={`Launch ${engineName} in ${agentName}’s home`}
            onClick={launch}
          >
            Launch
          </button>
          {readOnly ? <small role="note">Terminal launch is unavailable while app data is read-only.</small> : null}
        </div>
      </div>
    );
  }

  const statusLabel =
    phase === 'loading'
      ? 'Starting terminal…'
      : phase === 'exited'
        ? 'Terminal exited'
        : phase === 'error'
          ? 'Terminal needs attention'
          : 'Terminal running';

  return (
    <div className="agent-terminal" data-state={phase} data-session-id={sessionId || undefined}>
      {notice}
      <div className="agent-terminal__live">
        <div className="agent-terminal__toolbar">
          <span aria-live="polite">{statusLabel}</span>
          {agentId && sessionId ? (
            <AgentAutoPilot
              profile={{ id: agentId, name: agentName, engine }}
              paneId={`pane-${key}`}
              sessionId={sessionId}
              phase={phase}
              readOnly={readOnly}
              onSessionRestart={startNewSession}
            />
          ) : null}
          {phase === 'exited' ? (
            <button type="button" disabled={readOnly} onClick={() => void startNewSession()}>
              <PlayIcon />
              Start new session
            </button>
          ) : null}
          <button
            type="button"
            disabled={readOnly}
            onClick={() => setResumeOpen(true)}
            title="Resume previous conversation"
          >
            Resume…
          </button>
          <button type="button" disabled={stopping} onClick={() => void stop()}>
            <StopIcon />
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        </div>
        {readOnly ? (
          <div className="agent-terminal__readonly" role="note">
            App data is read-only. Terminal input is disabled, but you can still stop the process.
          </div>
        ) : null}
        {inlineError ? (
          <div className="agent-terminal__inline-error" role="alert">
            {inlineError}
          </div>
        ) : null}
        <TerminalView
          chrome="pane"
          compact
          workspaceId={workspaceId}
          sessionId={sessionId}
          agentId={agentId}
          initialEngine={engine}
          title={agentName}
          onStatusChange={(status) => {
            if (status === 'connecting' || status === 'idle') setPhase('loading');
            else if (status === 'running') setPhase('running');
            else if (status === 'exited' || status === 'terminated') setPhase('exited');
          }}
        />
        {resumeOpen && (
          <AgentPaneResumeModal
            isOpen={true}
            workspaceId={agentId || 'global-agents'}
            paneId={`pane-${key}`}
            engine={engine}
            title={agentName}
            onClose={() => setResumeOpen(false)}
            onResumeSelected={(resumedKey) => {
              sessions.set(key, resumedKey);
              setSessionId(resumedKey);
              setPhase('loading');
              setResumeOpen(false);
            }}
            onStartFresh={() => {
              void startNewSession();
              setResumeOpen(false);
            }}
          />
        )}
      </div>
    </div>
  );
};

export const AgentTerminalSurface = AgentTerminalPane;
export default AgentTerminalPane;
