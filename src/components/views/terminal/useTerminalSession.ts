import { useState, useRef, useCallback, useEffect } from 'react';
import { invokeCommand } from '../../../lib/ipc';
import { markTerminalExited } from '../../../lib/terminalRegistry';
import { getTerminalAppearancePrefs } from '../../../lib/terminalAppearancePrefs';
import { waitForStableHost } from '../../../lib/terminalHostSize';
import { measureTerminalCanvasGrid } from '../TerminalCanvasSurface';
import {
  isAgentEngine,
  terminalOwner,
  restartedSessions,
  stopParkedPolling,
  activeMountedSessions,
  syncParkedPollers,
  liveTerms,
} from './terminalSessionRegistry';

export interface UseTerminalSessionOptions {
  propSessionId?: string;
  paneId?: string;
  agentId?: string;
  workspaceId?: string | null;
  initialEngine?: string;
  surfaceRef: React.RefObject<HTMLDivElement | null>;
  onStatusChange?: (status: 'idle' | 'connecting' | 'running' | 'exited' | 'terminated') => void;
}

export function useTerminalSession(options: UseTerminalSessionOptions) {
  const {
    propSessionId,
    paneId: propPaneId,
    agentId: propAgentId,
    workspaceId = null,
    initialEngine = 'powershell',
    surfaceRef,
    onStatusChange,
  } = options;

  const [sessionId, setSessionId] = useState<string>(propSessionId || '');
  const [engine, setEngine] = useState<string>(initialEngine);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'running' | 'exited' | 'terminated'>('idle');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [oscTitle, setOscTitle] = useState<string>('');

  const paneIdRef = useRef<string>(propPaneId || globalThis.crypto.randomUUID());
  const agentIdRef = useRef<string>(propAgentId || globalThis.crypto.randomUUID());
  const engineRef = useRef<string>(engine);
  const sessionIdRef = useRef<string>(sessionId);
  const generationRef = useRef<number>(1);
  const startGenRef = useRef<number>(0);
  const isMountedRef = useRef<boolean>(true);

  if (propPaneId && paneIdRef.current !== propPaneId) paneIdRef.current = propPaneId;
  if (propAgentId && agentIdRef.current !== propAgentId) agentIdRef.current = propAgentId;
  engineRef.current = engine;
  sessionIdRef.current = sessionId;

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (sessionIdRef.current) {
        activeMountedSessions.delete(sessionIdRef.current);
      }
    };
  }, []);

  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);

  useEffect(() => {
    if (initialEngine && initialEngine !== engineRef.current) {
      engineRef.current = initialEngine;
      setEngine(initialEngine);
    }
  }, [initialEngine]);

  const startSession = useCallback(async (selectedEngine?: string, opts?: { restart?: boolean }) => {
    const gen = ++startGenRef.current;
    const currentEngine = selectedEngine ?? engineRef.current;
    const previousSessionId = propSessionId || sessionIdRef.current || `term-${Date.now()}`;
    let newSessionId = previousSessionId;
    let pendingAgentRestart: { previousSessionId: string; nextSessionId: string } | null = null;

    if (opts?.restart && isAgentEngine(currentEngine)) {
      const nextSessionId = globalThis.crypto.randomUUID();
      stopParkedPolling(previousSessionId);
      activeMountedSessions.delete(previousSessionId);
      const live = liveTerms.get(previousSessionId);
      if (live) {
        live.cleanupDomBlockFill?.();
        live.term.dispose();
        liveTerms.delete(previousSessionId);
      }
      pendingAgentRestart = { previousSessionId, nextSessionId };
      newSessionId = nextSessionId;
    } else if (opts?.restart) {
      stopParkedPolling(previousSessionId);
      activeMountedSessions.delete(previousSessionId);
      const live = liveTerms.get(previousSessionId);
      if (live) {
        live.cleanupDomBlockFill?.();
        live.term.dispose();
        liveTerms.delete(previousSessionId);
      }
      try {
        await invokeCommand('terminate_terminal', {
          sessionId: previousSessionId,
          owner: 'user',
        });
      } catch {}
    }

    setSessionId(newSessionId);
    sessionIdRef.current = newSessionId;
    activeMountedSessions.add(newSessionId);
    stopParkedPolling(newSessionId);
    setStatus('connecting');
    setExitCode(null);

    const activePrefs = getTerminalAppearancePrefs();
    syncParkedPollers();

    const attachExisting = Boolean(propSessionId) && !opts?.restart;
    const host = surfaceRef.current;
    if (attachExisting && host) {
      await waitForStableHost(host, () => !isMountedRef.current || startGenRef.current !== gen);
      if (!isMountedRef.current || startGenRef.current !== gen) return;
    }

    const measured = surfaceRef.current
      ? measureTerminalCanvasGrid(surfaceRef.current, activePrefs)
      : { cols: 80, rows: 24 };

    const owner = terminalOwner(workspaceId, paneIdRef.current, agentIdRef.current);

    try {
      let restartedAgent = false;
      if (pendingAgentRestart) {
        try {
          await invokeCommand('restart_agent_terminal_for_autopilot', {
            oldSessionId: pendingAgentRestart.previousSessionId,
            newSessionId: pendingAgentRestart.nextSessionId,
            agentId: agentIdRef.current,
            paneId: paneIdRef.current,
            runId: globalThis.crypto.randomUUID(),
            generation: generationRef.current,
            prompt: `Continue with ${currentEngine}`.slice(0, 2000),
            columns: measured.cols,
            rows: measured.rows,
          });
          generationRef.current += 1;
          restartedSessions.set(pendingAgentRestart.previousSessionId, pendingAgentRestart.nextSessionId);
          if (propSessionId) {
            restartedSessions.set(propSessionId, pendingAgentRestart.nextSessionId);
          }
          restartedAgent = true;
        } catch {
          restartedAgent = false;
        }
      }

      if (!restartedAgent) {
        const autoApprove = isAgentEngine(currentEngine);
        await invokeCommand(attachExisting ? 'attach_terminal' : 'start_terminal', {
          sessionId: newSessionId,
          engine: currentEngine,
          owner,
          workspaceId,
          paneId: paneIdRef.current,
          confirmedByBuilder: true,
          columns: measured.cols,
          rows: measured.rows,
          autoApprove,
          // Ask the daemon for the packed grid stream so the canvas paints
          // `SNAPSHOT_BIN` frames and replenishes channel credit.
          mode: 'snapshot_bin',
          live: true,
        });
      }

      if (isMountedRef.current && startGenRef.current === gen) {
        setStatus('running');
      }
    } catch (err) {
      console.warn('Terminal session start error:', err);
      if (isMountedRef.current && startGenRef.current === gen) {
        setStatus('idle');
      }
    }
  }, [propSessionId, surfaceRef, workspaceId]);

  const terminateSession = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    setStatus('terminated');
    markTerminalExited(id);
    stopParkedPolling(id);
    try {
      await invokeCommand('terminate_terminal', {
        sessionId: id,
        owner: 'user',
      });
    } catch {}
  }, []);

  const handleClear = useCallback(() => {
    const id = sessionIdRef.current || propSessionId;
    if (id) {
      void invokeCommand('clear_terminal_vt', { sessionId: id }).catch(() => {});
    }
  }, [propSessionId]);

  const interruptSession = useCallback(() => {
    const id = sessionIdRef.current;
    if (id) {
      void invokeCommand('write_terminal', {
        sessionId: id,
        owner: 'user',
        input: '\x03',
      }).catch(() => {});
    }
  }, []);

  return {
    sessionId,
    setSessionId,
    engine,
    setEngine,
    status,
    setStatus,
    exitCode,
    setExitCode,
    oscTitle,
    setOscTitle,
    startSession,
    terminateSession,
    handleClear,
    interruptSession,
    sessionIdRef,
    paneIdRef,
    agentIdRef,
    engineRef,
  };
}
