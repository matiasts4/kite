import React, { useState, useEffect, useRef, useCallback } from 'react';
import { invokeCommand } from '../../lib/ipc';
import {
  waitForTerminalReady,
  markTerminalPromptInjected,
  markTerminalExited,
} from '../../lib/terminalRegistry';
import {
  getTerminalAppearancePrefs,
  setTerminalAppearancePrefs,
  TERMINAL_APPEARANCE_CHANGED_EVENT,
  type TerminalAppearancePrefs,
} from '../../lib/terminalAppearancePrefs';
import { TerminalCanvasSurface } from './TerminalCanvasSurface';
import { XtermDomSurface, type XtermDomSurfaceHandle } from './terminal/XtermDomSurface';
import { TerminalToolbar } from './terminal/TerminalToolbar';
import { RotateCwIcon, SpinnerIcon } from './terminal/terminalIcons';
import { clipboardImageFormat, extractClipboardImage } from '../../lib/clipboardImage';
import {
  restartedSessions,
  releaseTerminal,
  terminalOwner,
} from './terminal/terminalSessionRegistry';
import { useTerminalSession } from './terminal/useTerminalSession';
import './terminal.css';

/** Arrival wave length when a thrown prompt lands in this terminal. */
const TERMINAL_IMPACT_PULSE_MS = 460;

export { releaseTerminal, clipboardImageFormat, extractClipboardImage };

export interface TerminalViewProps {
  workspaceId?: string | null;
  paneId?: string;
  agentId?: string;
  sessionId?: string;
  initialEngine?: string;
  compact?: boolean;
  /** `pane` hides the debug toolbar. Clear, restart, and interrupt come from the Code pane menu. */
  chrome?: 'toolbar' | 'pane';
  title?: string;
  isFocused?: boolean;
  onClose?: () => void;
  onStatusChange?: (status: 'idle' | 'connecting' | 'running' | 'exited' | 'terminated') => void;
}

export const TerminalView: React.FC<TerminalViewProps> = ({
  workspaceId = null,
  paneId: propPaneId,
  agentId,
  sessionId: propSessionId,
  initialEngine = 'powershell',
  compact = false,
  chrome = 'toolbar',
  title: customTitle,
  isFocused,
  onClose,
  onStatusChange,
}) => {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const xtermHandleRef = useRef<XtermDomSurfaceHandle>(null);
  const impactTimerRef = useRef<number | null>(null);

  const [isReceivingPrompt, setIsReceivingPrompt] = useState(false);
  const [isImpactPulse, setIsImpactPulse] = useState(false);
  const [appearance, setAppearance] = useState<TerminalAppearancePrefs>(() => getTerminalAppearancePrefs());

  const {
    sessionId,
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
  } = useTerminalSession({
    propSessionId,
    paneId: propPaneId,
    agentId,
    workspaceId,
    initialEngine,
    surfaceRef,
    onStatusChange,
  });

  const agentIdRef = useRef<string>(agentId || globalThis.crypto.randomUUID());
  if (agentId && agentIdRef.current !== agentId) agentIdRef.current = agentId;

  const triggerImpactPulse = useCallback(() => {
    setIsImpactPulse(true);
    if (impactTimerRef.current !== null) {
      window.clearTimeout(impactTimerRef.current);
    }
    impactTimerRef.current = window.setTimeout(() => {
      impactTimerRef.current = null;
      setIsImpactPulse(false);
    }, TERMINAL_IMPACT_PULSE_MS);
  }, []);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (impactTimerRef.current !== null) {
        window.clearTimeout(impactTimerRef.current);
        impactTimerRef.current = null;
      }
    };
  }, []);

  // Launch initial session
  useEffect(() => {
    void startSession();
  }, [startSession]);

  // Stage clipboard image
  const stageClipboardBlob = useCallback(
    (blob: Blob, mimeType: string, fileName?: string) => {
      const session = sessionIdRef.current;
      if (!session) return false;
      const format = clipboardImageFormat(mimeType, fileName);
      if (!format) return false;
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        const bytesBase64 = result.includes(',') ? result.slice(result.indexOf(',') + 1) : result;
        if (!bytesBase64) return;
        void invokeCommand('stage_terminal_clipboard_image', {
          sessionId: sessionIdRef.current || session,
          owner: terminalOwner(workspaceId, paneIdRef.current, agentIdRef.current),
          format,
          bytesBase64,
        }).catch(() => {});
      };
      reader.readAsDataURL(blob);
      return true;
    },
    [workspaceId]
  );
  const stageClipboardBlobRef = useRef(stageClipboardBlob);
  stageClipboardBlobRef.current = stageClipboardBlob;

  // Drag and drop from operating system via Tauri
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import('@tauri-apps/api/webview')
      .then(async ({ getCurrentWebview }) => {
        const stop = await getCurrentWebview().onDragDropEvent((event) => {
          if (cancelled || event.payload.type !== 'drop') return;
          const surface = surfaceRef.current;
          const session = sessionIdRef.current;
          if (!surface || !session || event.payload.paths.length === 0) return;
          const rect = surface.getBoundingClientRect();
          const scale = window.devicePixelRatio || 1;
          const { x, y } = event.payload.position;
          const inside =
            x >= rect.left * scale &&
            x <= rect.right * scale &&
            y >= rect.top * scale &&
            y <= rect.bottom * scale;
          if (!inside) return;
          void invokeCommand('insert_terminal_drop_paths', {
            sessionId: session,
            owner: terminalOwner(workspaceId, paneIdRef.current, agentIdRef.current),
            paths: event.payload.paths.slice(0, 20),
          }).catch(() => {});
        });
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [workspaceId]);

  // Terminal actions bus (clear, restart, interrupt, font adjustments)
  useEffect(() => {
    if (chrome !== 'pane') return;
    const onCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; command?: string }>).detail;
      if (!detail) return;
      const addressed = detail.sessionId ? (restartedSessions.get(detail.sessionId) ?? detail.sessionId) : null;
      const isTargeted =
        detail.sessionId &&
        (detail.sessionId === sessionIdRef.current ||
          addressed === sessionIdRef.current ||
          detail.sessionId === propSessionId);
      const isGlobalAgentRefresh =
        !detail.sessionId && (detail.command === 'restart-agent' || detail.command === 'refresh-all');

      if (!isTargeted && !isGlobalAgentRefresh) return;

      if (detail.command === 'restart-agent') {
        const currentId = sessionIdRef.current;
        if (currentId) {
          setStatus('connecting');
          setExitCode(null);
          const owner = terminalOwner(workspaceId, paneIdRef.current, agentIdRef.current);
          void invokeCommand<{ attachedToExisting?: boolean; scrollbackBase64?: string }>('attach_terminal', {
            sessionId: currentId,
            owner,
            engine,
            workspaceId,
            paneId: paneIdRef.current,
            columns: 80,
            rows: 24,
          })
            .then(() => {
              setStatus('running');
            })
            .catch(() => {
              void startSession(engine);
            });
        }
        return;
      }
      if (detail.command === 'clear') {
        handleClear();
        xtermHandleRef.current?.clear();
      }
      if (detail.command === 'refresh' || detail.command === 'redraw') {
        xtermHandleRef.current?.fit();
        return;
      }
      if (detail.command === 'restart') {
        void startSession(engine, { restart: true });
      }
      if (detail.command === 'interrupt') {
        interruptSession();
      }
      if (detail.command === 'terminate') {
        void terminateSession();
      }
      if (detail.command === 'font-larger' || detail.command === 'font-smaller') {
        const currentSize = appearance.fontSize;
        const next = Math.min(22, Math.max(10, currentSize + (detail.command === 'font-larger' ? 1 : -1)));
        setTerminalAppearancePrefs({ fontSize: next });
      }
    };

    window.addEventListener('kite:terminal-command', onCommand);
    return () => window.removeEventListener('kite:terminal-command', onCommand);
  }, [appearance.fontSize, chrome, engine, handleClear, interruptSession, propSessionId, sessionIdRef, setExitCode, setStatus, startSession, terminateSession, workspaceId]);

  // Appearance change broadcasts
  useEffect(() => {
    const onAppearanceChanged = (e: Event) => {
      const prefs = (e as CustomEvent<TerminalAppearancePrefs>).detail ?? getTerminalAppearancePrefs();
      setAppearance(prefs);
    };

    window.addEventListener(TERMINAL_APPEARANCE_CHANGED_EVENT, onAppearanceChanged);
    return () => window.removeEventListener(TERMINAL_APPEARANCE_CHANGED_EVENT, onAppearanceChanged);
  }, []);

  // In-terminal prompt delivery (thrown prompts)
  useEffect(() => {
    let cancelled = false;

    const handleStagedPrompt = async (e: Event) => {
      const detail = (
        e as CustomEvent<{
          sessionId?: string;
          paneId?: string;
          prompt: string;
        }>
      ).detail;
      if (!detail?.prompt) return;

      const currentSid = sessionIdRef.current || propSessionId;
      const currentPid = paneIdRef.current;
      const matchesSession =
        detail.sessionId &&
        (detail.sessionId === currentSid ||
          detail.sessionId === propSessionId ||
          restartedSessions.get(detail.sessionId) === currentSid);
      const matchesPane = detail.paneId && detail.paneId === currentPid;

      if (!matchesSession && !matchesPane) return;

      triggerImpactPulse();
      setIsReceivingPrompt(true);

      const sid = sessionIdRef.current || propSessionId;
      if (!sid) {
        setIsReceivingPrompt(false);
        return;
      }

      await waitForTerminalReady(sid, { timeoutMs: 12000 });
      if (cancelled) return;

      const text = detail.prompt;
      const chunkSize = Math.max(3, Math.ceil(text.length / 24));
      for (let i = 0; i < text.length; i += chunkSize) {
        if (cancelled) return;
        const chunk = text.slice(i, i + chunkSize);
        await invokeCommand('write_terminal', {
          sessionId: sid,
          input: chunk,
          owner: 'user',
        }).catch(() => {});
        await new Promise((r) => setTimeout(r, 20));
      }

      if (cancelled) return;

      await new Promise((r) => setTimeout(r, 120));
      await invokeCommand('write_terminal', {
        sessionId: sid,
        input: '\r\n',
        owner: 'user',
      }).catch(() => {});

      markTerminalPromptInjected(sid);

      setTimeout(() => {
        if (!cancelled) {
          setIsReceivingPrompt(false);
          xtermHandleRef.current?.focus();
        }
      }, 500);
    };

    window.addEventListener('kite:terminal-staged-prompt', handleStagedPrompt);
    return () => {
      cancelled = true;
      window.removeEventListener('kite:terminal-staged-prompt', handleStagedPrompt);
    };
  }, [paneIdRef, propSessionId, sessionIdRef, triggerImpactPulse]);

  // Prompt landed wave
  useEffect(() => {
    const handlePromptLanded = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string; targetPaneId?: string }>).detail;
      if (!detail) return;

      const currentSid = sessionIdRef.current || propSessionId;
      const currentPid = paneIdRef.current;
      const matchesSession =
        detail.sessionId &&
        (detail.sessionId === currentSid ||
          detail.sessionId === propSessionId ||
          restartedSessions.get(detail.sessionId) === currentSid);
      const matchesPane = detail.targetPaneId && detail.targetPaneId === currentPid;

      if (!matchesSession && !matchesPane) return;
      triggerImpactPulse();
    };

    window.addEventListener('kite:prompt-landed', handlePromptLanded);
    return () => window.removeEventListener('kite:prompt-landed', handlePromptLanded);
  }, [paneIdRef, propSessionId, sessionIdRef, triggerImpactPulse]);

  const handleTitleChange = useCallback(
    (nextTitle: string) => {
      if (nextTitle) setOscTitle(nextTitle);
    },
    [setOscTitle]
  );

  const handleProcessExit = useCallback(
    (code: number | null) => {
      const sid = sessionIdRef.current || propSessionId;
      if (sid) markTerminalExited(sid);
      setExitCode(code ?? 0);
      setStatus('exited');
    },
    [propSessionId, sessionIdRef, setExitCode, setStatus]
  );

  return (
    <div
      ref={surfaceRef}
      className={`terminal-view-container${compact ? ' terminal-view-container--compact' : ''}${
        chrome === 'pane' ? ' terminal-view-container--pane' : ''
      }`}
      data-session-id={sessionId || propSessionId || undefined}
      data-pane-id={paneIdRef.current}
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        backgroundColor: '#0a0a0a',
        position: 'relative',
        overflow: 'hidden',
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('application/x-kite-files-entry')) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(event) => {
        const raw = event.dataTransfer.getData('application/x-kite-files-entry');
        const session = sessionIdRef.current;
        if (!raw || !session) return;
        event.preventDefault();
        try {
          const entry = JSON.parse(raw) as { workspaceId?: string; resourceId?: string; entryId?: string };
          if (!entry.workspaceId || !entry.resourceId || !entry.entryId) return;
          void invokeCommand('insert_terminal_files_entry', {
            sessionId: session,
            owner: terminalOwner(workspaceId, paneIdRef.current, agentIdRef.current),
            workspaceId: entry.workspaceId,
            resourceId: entry.resourceId,
            entryId: entry.entryId,
          }).catch(() => {});
        } catch {
          // The drop payload was not a files entry.
        }
      }}
      onPasteCapture={(event) => {
        const session = sessionIdRef.current;
        if (!session) return;
        const img = extractClipboardImage(event.clipboardData);
        if (!img) return;
        event.preventDefault();
        event.stopPropagation();
        stageClipboardBlobRef.current(img.file, img.file.type, img.file.name);
      }}
    >
      {chrome === 'pane' ? null : (
        <TerminalToolbar
          customTitle={customTitle}
          oscTitle={oscTitle}
          sessionId={sessionId}
          appearance={appearance}
          status={status}
          exitCode={exitCode}
          workspaceId={workspaceId}
          engine={engine}
          setEngine={setEngine}
          onClear={() => {
            handleClear();
            xtermHandleRef.current?.clear();
          }}
          onRestart={() => startSession(engine, { restart: true })}
          onTerminate={terminateSession}
          onLaunch={() => startSession(engine, { restart: true })}
          onClose={onClose}
        />
      )}

      {/* Terminal Host Surface */}
      <div
        className={[
          'terminal-canvas-area',
          isReceivingPrompt ? 'terminal-canvas-area--receiving' : '',
          isImpactPulse ? 'terminal-canvas-area--impact' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {appearance.renderer === 'canvas' ? (
          (sessionId || propSessionId) ? (
            <TerminalCanvasSurface
              sessionId={sessionId || propSessionId!}
              workspaceId={workspaceId}
              isFocused={isFocused}
              className="terminal-surface-host"
              onTitleChange={handleTitleChange}
              onProcessExit={handleProcessExit}
            />
          ) : null
        ) : (
          (sessionId || propSessionId) ? (
            <XtermDomSurface
              ref={xtermHandleRef}
              sessionId={sessionId || propSessionId!}
              workspaceId={workspaceId}
              engine={engine}
              className="terminal-surface-host"
              onProcessExit={handleProcessExit}
              onStageClipboardBlob={stageClipboardBlob}
            />
          ) : null
        )}

        {status === 'connecting' && (
          <div className="terminal-loading-overlay">
            <SpinnerIcon size={14} className="terminal-loading-spinner" />
            <span>Starting ConPTY session...</span>
          </div>
        )}

        {status === 'exited' && (
          <div className="terminal-exit-bar">
            <div className="terminal-exit-bar__info">
              <span
                className={`terminal-exit-bar__dot ${
                  exitCode === 0 ? 'terminal-exit-bar__dot--success' : 'terminal-exit-bar__dot--failed'
                }`}
              />
              <span>Process exited with code {exitCode ?? 0}</span>
            </div>
            <button
              onClick={() => startSession(engine, { restart: true })}
              className="terminal-btn terminal-btn--primary terminal-btn--sm"
              type="button"
            >
              <RotateCwIcon size={12} />
              <span>Restart</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
