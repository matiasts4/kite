import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { invokeCommand } from '../../lib/ipc';
import {
  recordTerminalOutput,
  markTerminalExited,
  waitForTerminalReady,
  markTerminalPromptInjected,
} from '../../lib/terminalRegistry';
import {
  hostBoxIsUsable,
  waitForStableHost,
} from '../../lib/terminalHostSize';
import {
  activateTerminalUnicodeProvider,
  attachDomBlockFillCleanup,
  buildWindowsConptyOptions,
  DEFAULT_WINDOWS_CONPTY_BUILD_NUMBER,
  reconcilePtySizeAfterSpawn,
  repairWebglCanvasForDevicePixelRatio,
  safeFitTerminal,
  terminalGridDriftedFromFit,
} from '../../lib/terminalViewport';
import {
  classifyForegroundOutputRefresh,
  createSyncOutputHold,
  disposeTerminalRefreshTracking,
  splitAlternateScreenEnterChunk,
  stripTransientCursorShows,
  SYNC_OUTPUT_MAX_HOLD_MS,
  writeTerminalOutputWithRefresh,
} from '../../lib/terminalSyncOutput';
import { openFileInRightDock } from '../../lib/filePreviewNav';
import {
  extractTerminalLinks,
  getTerminalWebLinksTarget,
  openTerminalWebLink,
} from '../../lib/terminalLinkNav';
import './terminal.css';

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
  onClose?: () => void;
  onStatusChange?: (status: 'idle' | 'connecting' | 'running' | 'exited' | 'terminated') => void;
}

// Inline SVG Icons (Cero Lucide, Cero Emojis)
const TerminalIcon = ({ className = '', size = 14 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);

const FolderIcon = ({ className = '', size = 11 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
);

const TrashIcon = ({ className = '', size = 13 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M3 6h18" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

const PlayIcon = ({ className = '', size = 13 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    stroke="currentColor"
    strokeWidth="1"
    className={className}
    aria-hidden="true"
  >
    <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />
  </svg>
);

const SquareIcon = ({ className = '', size = 13 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    stroke="currentColor"
    strokeWidth="1"
    className={className}
    aria-hidden="true"
  >
    <rect width="16" height="16" x="4" y="4" rx="2" />
  </svg>
);

const RotateCwIcon = ({ className = '', size = 13 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
  </svg>
);

const SpinnerIcon = ({ className = '', size = 13 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`terminal-spinner ${className}`}
    aria-hidden="true"
  >
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

const CloseIcon = ({ className = '', size = 12 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 10 10"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M1 1L9 9M9 1L1 9" />
  </svg>
);

// Helper function to decode base64 ANSI byte stream into Uint8Array
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

type BitmapRenderer = { kind: 'webgl'; dispose: () => void };
type LiveTerminal = {
  term: Terminal;
  fit: FitAddon;
  renderer: BitmapRenderer | null;
  cleanupDomBlockFill?: () => void;
};
const liveTerms = new Map<string, LiveTerminal>();
const restartedSessions = new Map<string, string>();

// Temporary capture experiment: keep this enabled for one controlled sample to
// suppress only the foreground grid-drift auto-refit. Initial fits and explicit
// resize paths remain unchanged. Revert this diagnostic hunk after the sample.
const SUPPRESS_FOREGROUND_GRID_DRIFT_REFIT_DIAGNOSTIC = true;

/** Arrival wave length when a thrown prompt lands in this terminal. */
const TERMINAL_IMPACT_PULSE_MS = 460;

function isAgentEngine(engine: string): boolean {
  return engine !== '' && engine !== 'powershell' && engine !== 'terminal';
}

function terminalOwner(workspaceId: string | null | undefined, paneId: string, agentId: string) {
  if (workspaceId) {
    return { kind: 'workspace' as const, workspaceId, profile: { kind: 'default' as const } };
  }
  return { kind: 'agent' as const, agentId, paneId };
}

export function clipboardImageFormat(mime: string, fileName?: string): 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | null {
  const cleanMime = (mime || '').toLowerCase().split(';')[0].trim();
  if (cleanMime === 'image/png') return 'png';
  if (cleanMime === 'image/jpeg' || cleanMime === 'image/jpg') return 'jpeg';
  if (cleanMime === 'image/gif') return 'gif';
  if (cleanMime === 'image/webp') return 'webp';
  if (cleanMime === 'image/bmp') return 'bmp';
  if (fileName) {
    const ext = fileName.toLowerCase().split('.').pop();
    if (ext === 'png') return 'png';
    if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
    if (ext === 'gif') return 'gif';
    if (ext === 'webp') return 'webp';
    if (ext === 'bmp') return 'bmp';
  }
  return null;
}

export function extractClipboardImage(clipboardData: DataTransfer | null): { file: File; format: 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' } | null {
  if (!clipboardData) return null;
  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item.kind === 'file' || item.type.toLowerCase().startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        const format = clipboardImageFormat(file.type || item.type, file.name);
        if (format) return { file, format };
      }
    }
  }
  for (const file of Array.from(clipboardData.files ?? [])) {
    const format = clipboardImageFormat(file.type, file.name);
    if (format) return { file, format };
  }
  return null;
}

function terminalParking(): HTMLElement {
  let node = document.getElementById('terminal-parking');
  if (!node) {
    node = document.createElement('div');
    node.id = 'terminal-parking';
    node.setAttribute('hidden', '');
    document.body.appendChild(node);
  }
  return node;
}

function isLiveTerminalVisible(live: LiveTerminal): boolean {
  const el = live.term.element;
  if (!el || !el.isConnected) return false;
  return !el.closest('#terminal-parking');
}

function releaseBitmapRenderer(live: LiveTerminal) {
  const previous = live.renderer;
  live.renderer = null;
  try {
    previous?.dispose();
  } catch {
    // The addon can already be disposed after a context loss.
  }
}

function attachBitmapRenderer(live: LiveTerminal) {
  if (live.renderer?.kind === 'webgl') {
    repairWebglCanvasForDevicePixelRatio(live.term);
    return;
  }
  releaseBitmapRenderer(live);
  try {
    const addon = new WebglAddon();
    const loss = addon.onContextLoss(() => {
      loss.dispose();
      releaseBitmapRenderer(live);
      try {
        if (live.term.rows > 0) {
          live.term.refresh(0, live.term.rows - 1);
        }
      } catch {}
    });
    live.term.loadAddon(addon);
    live.renderer = {
      kind: 'webgl',
      dispose: () => {
        loss.dispose();
        addon.dispose();
      },
    };
  } catch (err) {
    console.warn('[terminal] WebGL renderer unavailable', err);
  }
  if (!isLiveTerminalVisible(live)) return;
  try {
    safeFitTerminal(live.term, live.fit);
  } catch {
    // The host can be mid-layout. The settled fit still runs after open.
  }
}

function syncVisibleBitmapRenderers() {
  for (const live of liveTerms.values()) {
    if (!isLiveTerminalVisible(live)) {
      releaseBitmapRenderer(live);
      continue;
    }
    attachBitmapRenderer(live);
  }
}

/** Kill the PTY and drop the screen. Only an explicit close or Restart should call this. */
export function releaseTerminal(sessionId: string) {
  markTerminalExited(sessionId);
  const ids = new Set([sessionId, restartedSessions.get(sessionId) ?? sessionId]);
  for (const id of ids) {
    markTerminalExited(id);
    const live = liveTerms.get(id);
    if (live) {
      disposeTerminalRefreshTracking(live.term);
      live.cleanupDomBlockFill?.();
      releaseBitmapRenderer(live);
      live.term.dispose();
      liveTerms.delete(id);
    }
    if (!id) continue;
    void invokeCommand('terminate_terminal', {
      sessionId: id,
      owner: 'user',
    }).catch(() => {});
  }
  restartedSessions.delete(sessionId);
  syncVisibleBitmapRenderers();
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
  onClose,
  onStatusChange,
}) => {
  const [sessionId, setSessionId] = useState<string>(propSessionId || '');
  const [engine, setEngine] = useState<string>(initialEngine);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'running' | 'exited' | 'terminated'>('idle');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [isReceivingPrompt, setIsReceivingPrompt] = useState(false);
  const [isImpactPulse, setIsImpactPulse] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const pollingRef = useRef<number | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const cancelSpawnReconcileRef = useRef<(() => void) | null>(null);
  const driftCheckFrameRef = useRef<number | null>(null);
  const lastDriftCheckAtRef = useRef<number>(0);
  const altScreenSplitTailRef = useRef<string>('');
  const writeDecoderRef = useRef<TextDecoder>(new TextDecoder('utf-8', { fatal: false }));
  const lastColsRef = useRef<number | null>(null);
  const lastRowsRef = useRef<number | null>(null);
  const ptyOpenRef = useRef(false);
  const startGenRef = useRef(0);
  /** Polled chunks still inside xterm.write. A fit waits until this is 0. */
  const writeActiveRef = useRef(0);
  const fitDeferredRef = useRef(false);
  const fitNowRef = useRef<() => void>(() => {});
  const fitWatchRef = useRef(0);
  const scheduleStableFitRef = useRef<() => void>(() => {});
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  /** Joins a synchronized frame so a poll slice is not painted on its own. */
  const syncHoldRef = useRef(createSyncOutputHold());
  const syncHoldTimerRef = useRef<number | null>(null);
  const utf8DecoderRef = useRef<TextDecoder>(new TextDecoder('utf-8', { fatal: false }));
  const onDataDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const sessionIdRef = useRef<string>(propSessionId || '');
  const isMountedRef = useRef<boolean>(true);
  const engineRef = useRef<string>(engine);
  const liveSessionRef = useRef<string>(propSessionId || '');
  const paneIdRef = useRef<string>(propPaneId || globalThis.crypto.randomUUID());
  const agentIdRef = useRef<string>(agentId || globalThis.crypto.randomUUID());
  const generationRef = useRef(1);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const workspaceIdRef = useRef<string | null>(workspaceId);
  workspaceIdRef.current = workspaceId;
  const isAtBottomRef = useRef<boolean>(true);
  const linesFromBottomRef = useRef<number>(0);
  const isResizingRef = useRef<boolean>(false);
  const impactTimerRef = useRef<number | null>(null);

  if (propPaneId && paneIdRef.current !== propPaneId) {
    paneIdRef.current = propPaneId;
  }
  if (agentId && agentIdRef.current !== agentId) {
    agentIdRef.current = agentId;
  }

  engineRef.current = engine;
  sessionIdRef.current = liveSessionRef.current || sessionId;

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

  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);

  const stopPolling = useCallback(() => {
    if (pollingRef.current !== null) {
      clearTimeout(pollingRef.current);
      pollingRef.current = null;
    }
    if (resizeTimerRef.current !== null) {
      clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = null;
    }
  }, []);

  const stageClipboardBlob = useCallback((blob: Blob, mimeType: string, fileName?: string) => {
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
        owner: terminalOwner(workspaceIdRef.current, paneIdRef.current, agentIdRef.current),
        format,
        bytesBase64,
      }).catch(() => {});
    };
    reader.readAsDataURL(blob);
    return true;
  }, []);
  const stageClipboardBlobRef = useRef(stageClipboardBlob);
  stageClipboardBlobRef.current = stageClipboardBlob;

  const lastUserInputTimeRef = useRef<number>(0);
  const isWindowFocusedRef = useRef<boolean>(true);
  const triggerImmediatePollRef = useRef<() => void>(() => {});

  const scheduleForegroundGridDriftCheck = useCallback(() => {
    if (SUPPRESS_FOREGROUND_GRID_DRIFT_REFIT_DIAGNOSTIC) return;
    if (driftCheckFrameRef.current !== null) return;
    const now = performance.now();
    if (now - lastDriftCheckAtRef.current < 250) return;
    driftCheckFrameRef.current = window.requestAnimationFrame(() => {
      driftCheckFrameRef.current = null;
      lastDriftCheckAtRef.current = performance.now();
      const term = termRef.current;
      const fit = fitAddonRef.current;
      const host = containerRef.current;
      if (!term || !fit || !host || !ptyOpenRef.current) return;
      if (terminalGridDriftedFromFit(term, fit, host)) {
        fitNowRef.current();
      }
    });
  }, []);

  const writeRaw = useCallback((data: Uint8Array | string, onFlushed?: () => void) => {
    scheduleForegroundGridDriftCheck();
    writeActiveRef.current += 1;
    const releaseWrite = () => {
      writeActiveRef.current = Math.max(0, writeActiveRef.current - 1);
      if (writeActiveRef.current === 0 && fitDeferredRef.current) {
        fitDeferredRef.current = false;
        queueMicrotask(() => fitNowRef.current());
      }
    };
    const next = writeQueueRef.current.then(
      () =>
        new Promise<void>((resolve) => {
          const term = termRef.current;
          if (!term) {
            onFlushed?.();
            releaseWrite();
            resolve();
            return;
          }
          let finished = false;
          const done = () => {
            if (!finished) {
              finished = true;
              onFlushed?.();
              releaseWrite();
              resolve();
            }
          };
          // Hard safety timeout: never allow an unrendered, hidden, or resizing xterm
          // to block the write queue or deadlock the polling tick.
          const timer = setTimeout(done, 100);

          const text =
            typeof data === 'string'
              ? data
              : writeDecoderRef.current.decode(data, { stream: true });
          const live = sessionIdRef.current ? liveTerms.get(sessionIdRef.current) : undefined;
          const hasWebglRenderer = Boolean(live?.renderer);

          const deliverText = (chunkText: string, cb: () => void) => {
            if (!chunkText) {
              cb();
              return;
            }
            const refreshPlan = classifyForegroundOutputRefresh(chunkText);
            const payload = refreshPlan.stripTransientCursorShows
              ? stripTransientCursorShows(chunkText)
              : chunkText;
            writeTerminalOutputWithRefresh(term, payload, {
              forceViewportRefresh: refreshPlan.forceViewportRefresh,
              followupViewportRefresh: refreshPlan.followupViewportRefresh,
              shouldRefreshViewportSynchronously: () => !hasWebglRenderer,
              onParsed: cb,
            });
          };

          try {
            const hasPendingResize =
              fitDeferredRef.current ||
              Boolean(
                fitAddonRef.current &&
                  containerRef.current &&
                  terminalGridDriftedFromFit(term, fitAddonRef.current, containerRef.current),
              );
            const split = splitAlternateScreenEnterChunk(
              text,
              altScreenSplitTailRef.current,
              hasPendingResize,
            );
            altScreenSplitTailRef.current = split.nextTail;

            if (split.splitBeforeChunkOffset !== null) {
              const before = text.slice(0, split.splitBeforeChunkOffset);
              const after = text.slice(split.splitBeforeChunkOffset);
              deliverText(before, () => {
                fitDeferredRef.current = false;
                fitNowRef.current();
                deliverText(after, () => {
                  clearTimeout(timer);
                  done();
                });
              });
            } else {
              deliverText(text, () => {
                clearTimeout(timer);
                done();
              });
            }
          } catch {
            clearTimeout(timer);
            done();
          }
        })
    );
    writeQueueRef.current = next.catch(() => {
      releaseWrite();
    });
    return writeQueueRef.current;
  }, [scheduleForegroundGridDriftCheck]);

  const enqueueWrite = useCallback((data: Uint8Array | string, onFlushed?: () => void) => {
    const ready = syncHoldRef.current.push(data);
    if (syncHoldRef.current.pending) {
      if (syncHoldTimerRef.current === null) {
        syncHoldTimerRef.current = window.setTimeout(() => {
          syncHoldTimerRef.current = null;
          const pending = syncHoldRef.current.flush();
          if (pending && pending.length > 0) {
            void writeRaw(pending);
          }
        }, SYNC_OUTPUT_MAX_HOLD_MS);
      }
    } else if (syncHoldTimerRef.current !== null) {
      window.clearTimeout(syncHoldTimerRef.current);
      syncHoldTimerRef.current = null;
    }
    if (ready.length === 0) {
      onFlushed?.();
      return Promise.resolve();
    }
    for (let i = 0; i < ready.length; i += 1) {
      writeRaw(ready[i], i === ready.length - 1 ? onFlushed : undefined);
    }
    return writeQueueRef.current;
  }, [writeRaw]);

  const fitTerminal = useCallback(() => {
    const host = containerRef.current;
    if (!host || !fitAddonRef.current || !termRef.current || !ptyOpenRef.current) return;
    if (!hostBoxIsUsable(host.clientWidth, host.clientHeight)) return;
    // A polled chunk or an open synchronized frame owns the screen.
    // Fitting now would SIGWINCH in the middle of it.
    if (writeActiveRef.current > 0 || syncHoldRef.current.holding) {
      fitDeferredRef.current = true;
      return;
    }
    try {
      const term = termRef.current;
      const wasAtBottom = isAtBottomRef.current || linesFromBottomRef.current <= 3;
      const savedLinesFromBottom = linesFromBottomRef.current;

      isResizingRef.current = true;
      let grid: { cols: number; rows: number } | null = null;
      try {
        grid = safeFitTerminal(term, fitAddonRef.current, host);
      } finally {
        requestAnimationFrame(() => {
          isResizingRef.current = false;
        });
      }

      const restoreScroll = () => {
        if (!termRef.current) return;
        if (termRef.current.buffer.active.type === 'alternate') return;
        if (wasAtBottom) {
          termRef.current.scrollToBottom();
        } else {
          const target = Math.max(0, termRef.current.buffer.active.baseY - savedLinesFromBottom);
          termRef.current.scrollToLine(target);
        }
      };

      restoreScroll();
      requestAnimationFrame(restoreScroll);

      const cols = grid?.cols ?? term.cols;
      const rows = grid?.rows ?? term.rows;
      if (cols <= 0 || rows <= 0 || !sessionIdRef.current) return;
      if (cols === lastColsRef.current && rows === lastRowsRef.current) return;

      if (resizeTimerRef.current !== null) {
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      lastColsRef.current = cols;
      lastRowsRef.current = rows;
      const sessionId = sessionIdRef.current;
      invokeCommand('resize_terminal', {
        sessionId,
        columns: cols,
        rows: rows,
      })
        .then(() => {
          if (sessionIdRef.current !== sessionId) return;
          if (termRef.current?.buffer.active.type !== 'alternate') {
            restoreScroll();
          }
        })
        .catch(() => {});
    } catch {}
  }, []);
  fitNowRef.current = fitTerminal;

  const scheduleStableFit = useCallback(() => {
    const host = containerRef.current;
    if (!host || !ptyOpenRef.current) return;
    const watch = ++fitWatchRef.current;
    void waitForStableHost(
      host,
      () => fitWatchRef.current !== watch || !isMountedRef.current,
    ).then((box) => {
      if (!box || fitWatchRef.current !== watch || !ptyOpenRef.current) return;
      fitTerminal();
    });
  }, [fitTerminal]);
  scheduleStableFitRef.current = scheduleStableFit;

  const initTerminal = useCallback((sessionKey?: string) => {
    if (!containerRef.current) return null;
    const key = sessionKey || propSessionId || sessionIdRef.current;
    const existing = key ? liveTerms.get(key) : undefined;
    if (existing?.term.element) {
      containerRef.current.replaceChildren(existing.term.element);
      termRef.current = existing.term;
      fitAddonRef.current = existing.fit;
      syncVisibleBitmapRenderers();
      requestAnimationFrame(() => {
        if (!termRef.current) return;
        if (isAtBottomRef.current || linesFromBottomRef.current <= 3) {
          termRef.current.scrollToBottom();
        } else {
          const target = Math.max(0, termRef.current.buffer.active.baseY - linesFromBottomRef.current);
          termRef.current.scrollToLine(target);
        }
      });
      return existing.term;
    }

    containerRef.current.innerHTML = '';

    const term = new Terminal({
      theme: {
        background: '#0a0a0a',
        foreground: '#fafafa',
        cursor: '#5c8fff',
        cursorAccent: '#0a0a0a',
        selectionBackground: 'rgba(92, 143, 255, 0.30)',
        selectionForeground: '#fafafa',
        black: '#171717',
        red: '#e06c75',
        green: '#7fd99a',
        yellow: '#e8c87a',
        blue: '#5c8fff',
        magenta: '#d4a08c',
        cyan: '#5ec8c5',
        white: '#d4d4d4',
        brightBlack: '#525252',
        brightRed: '#ff8a8a',
        brightGreen: '#a8f0b8',
        brightYellow: '#ffe08a',
        brightBlue: '#8ab0ff',
        brightMagenta: '#e8c4b0',
        brightCyan: '#8ae8e4',
        brightWhite: '#fafafa',
      },
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      fontWeight: '400',
      fontWeightBold: '600',
      drawBoldTextInBrightColors: true,
      letterSpacing: 0,
      lineHeight: 1,
      minimumContrastRatio: 4.5,
      customGlyphs: true,
      rescaleOverlappingGlyphs: false,
      cursorBlink: false,
      cursorStyle: 'bar',
      convertEol: false,
      scrollback: 5000,
      allowProposedApi: true,
      windowsPty: buildWindowsConptyOptions(DEFAULT_WINDOWS_CONPTY_BUILD_NUMBER),
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    activateTerminalUnicodeProvider(term);
    term.open(containerRef.current);
    const cleanupDomBlockFill = attachDomBlockFillCleanup(term);

    term.onScroll(() => {
      if (isResizingRef.current) return;
      const buffer = term.buffer.active;
      const dist = Math.max(0, buffer.baseY - buffer.viewportY);
      linesFromBottomRef.current = dist;
      isAtBottomRef.current = dist <= 3;
    });

    try {
      safeFitTerminal(term, fitAddon, containerRef.current);
    } catch {}

    // Register link provider for Ctrl + Left Click file preview and web URL navigation
    term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const buffer = term.buffer.active;
        const lineIdx = bufferLineNumber - 1;
        const currentLine = buffer.getLine(lineIdx);
        if (!currentLine) {
          callback(undefined);
          return;
        }

        // Trace backward to find the beginning of this wrapped logical line
        let startLineIdx = lineIdx;
        while (startLineIdx > 0 && buffer.getLine(startLineIdx)?.isWrapped) {
          startLineIdx--;
        }

        // Trace forward to find the end of this wrapped logical line
        let endLineIdx = lineIdx;
        while (endLineIdx + 1 < buffer.length && buffer.getLine(endLineIdx + 1)?.isWrapped) {
          endLineIdx++;
        }

        // Reconstruct the full text across all wrapped physical lines
        let fullText = '';
        const lineOffsets: number[] = [];

        for (let y = startLineIdx; y <= endLineIdx; y++) {
          lineOffsets.push(fullText.length);
          const l = buffer.getLine(y);
          if (!l) continue;
          // Intermediate wrapped lines do not trim whitespace; final line trims right
          const isLast = y === endLineIdx;
          fullText += l.translateToString(isLast);
        }

        if (!fullText.trim()) {
          callback(undefined);
          return;
        }

        const rawLinks = extractTerminalLinks(fullText);
        if (rawLinks.length === 0) {
          callback(undefined);
          return;
        }

        const links: any[] = [];

        for (const item of rawLinks) {
          let startY = startLineIdx;
          let startX = 1;
          let endY = endLineIdx;
          let endX = 1;

          for (let i = 0; i < lineOffsets.length; i++) {
            const y = startLineIdx + i;
            const lineStart = lineOffsets[i];
            const lineEnd = i + 1 < lineOffsets.length ? lineOffsets[i + 1] : fullText.length;

            if (item.start >= lineStart && item.start < lineEnd) {
              startY = y;
              startX = item.start - lineStart + 1;
            }
            if (item.end > lineStart && item.end <= lineEnd) {
              endY = y;
              endX = item.end - lineStart + 1;
            }
          }

          // Only report links that touch the requested buffer line
          if (lineIdx >= startY && lineIdx <= endY) {
            const isWeb = item.kind === 'web';
            links.push({
              range: {
                start: { x: startX, y: startY + 1 },
                end: { x: endX, y: endY + 1 },
              },
              text: item.text,
              decorations: {
                pointerCursor: true,
                underline: true,
              },
              hover() {
                if (term.element) {
                  if (isWeb) {
                    const target = getTerminalWebLinksTarget();
                    term.element.title =
                      target === 'external'
                        ? 'Ctrl + Click para abrir en el navegador externo'
                        : 'Ctrl + Click para abrir en el navegador integrado';
                  } else {
                    term.element.title = 'Ctrl + Click para previsualizar archivo';
                  }
                }
              },
              leave() {
                if (term.element) {
                  term.element.title = '';
                }
              },
              activate(event: MouseEvent, clickedText: string) {
                // Unified behavior: Ctrl + Click izquierdo opens web link or file preview
                if ((event.ctrlKey || event.metaKey) && event.button === 0) {
                  event.preventDefault();
                  const candidate = (clickedText || item.text).trim().replace(/^['"`(<\[]+|['"`)>\].,;:]+$/g, '');
                  if (isWeb) {
                    openTerminalWebLink(candidate, workspaceIdRef.current);
                  } else {
                    openFileInRightDock({
                      candidate,
                      workspaceId: workspaceIdRef.current,
                      collapseTree: true,
                    });
                  }
                }
              },
            });
          }
        }

        callback(links.length > 0 ? links : undefined);
      },
    });

    termRef.current = term;
    fitAddonRef.current = fitAddon;
    if (key) liveTerms.set(key, { term, fit: fitAddon, renderer: null, cleanupDomBlockFill });
    syncVisibleBitmapRenderers();

    return term;
  }, [propSessionId]);

  const startPolling = useCallback((id: string) => {
    stopPolling();

    const tick = async () => {
      if (!isMountedRef.current || sessionIdRef.current !== id) {
        stopPolling();
        return;
      }

      let nextDelay = 40;
      try {
        const res: any = await invokeCommand('read_terminal_output', {
          sessionId: id,
          owner: 'user',
        });

        if (!isMountedRef.current || sessionIdRef.current !== id) {
          return;
        }

        const now = Date.now();
        const hasRecentUserInput = now - lastUserInputTimeRef.current < 4000;
        const isDocHidden =
          typeof document !== 'undefined' &&
          document.visibilityState === 'hidden' &&
          !isWindowFocusedRef.current;
        if (res?.kind === 'output' && res.bytesBase64) {
          nextDelay = 35;
          const bytes = base64ToUint8Array(res.bytesBase64);
          await enqueueWrite(bytes);
          try {
            const text = utf8DecoderRef.current.decode(bytes, { stream: true });
            if (text) {
              recordTerminalOutput(id, text, {
                workspaceId,
                engine: engineRef.current || initialEngine,
                title: customTitle,
              });
            }
          } catch {}
        } else if (res?.kind === 'exited') {
          stopPolling();
          setStatus('exited');
          markTerminalExited(id);
          const code = res.status?.code ?? 0;
          setExitCode(code);
          await enqueueWrite(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`);
          return;
        } else {
          // Idle state (no new output):
          if (isDocHidden) {
            nextDelay = 800;
          } else if (hasRecentUserInput) {
            nextDelay = 40;
          } else {
            nextDelay = 220;
          }
        }
      } catch {
        nextDelay = 300;
      }

      if (isMountedRef.current && sessionIdRef.current === id) {
        pollingRef.current = window.setTimeout(tick, nextDelay);
      }
    };

    triggerImmediatePollRef.current = () => {
      if (!isMountedRef.current || sessionIdRef.current !== id) return;
      if (pollingRef.current !== null) {
        clearTimeout(pollingRef.current);
        pollingRef.current = null;
      }
      pollingRef.current = window.setTimeout(tick, 5);
    };

    pollingRef.current = window.setTimeout(tick, 40);
  }, [stopPolling, enqueueWrite, workspaceId, initialEngine, customTitle]);

  const startSession = useCallback(async (selectedEngine?: string, opts?: { restart?: boolean }) => {
    const gen = ++startGenRef.current;
    fitWatchRef.current += 1;
    ptyOpenRef.current = false;
    cancelSpawnReconcileRef.current?.();
    cancelSpawnReconcileRef.current = null;
    const stillCurrent = () => isMountedRef.current && startGenRef.current === gen;

    stopPolling();

    const currentEngine = selectedEngine ?? engineRef.current;
    const previousSessionId = propSessionId || sessionIdRef.current || `term-${Date.now()}`;
    let newSessionId = previousSessionId;
    let pendingAgentRestart: { previousSessionId: string; nextSessionId: string } | null = null;

    if (opts?.restart && isAgentEngine(currentEngine)) {
      const nextSessionId = globalThis.crypto.randomUUID();
      const live = liveTerms.get(previousSessionId);
      if (live) {
        try {
          live.renderer?.dispose();
        } catch {}
        disposeTerminalRefreshTracking(live.term);
        live.cleanupDomBlockFill?.();
        live.term.dispose();
        liveTerms.delete(previousSessionId);
      }
      if (termRef.current === live?.term) {
        termRef.current = null;
        fitAddonRef.current = null;
      }
      pendingAgentRestart = { previousSessionId, nextSessionId };
      newSessionId = nextSessionId;
    }

    if (opts?.restart && !pendingAgentRestart) {
      const live = liveTerms.get(previousSessionId);
      if (live) {
        try {
          live.renderer?.dispose();
        } catch {}
        disposeTerminalRefreshTracking(live.term);
        live.cleanupDomBlockFill?.();
        live.term.dispose();
        liveTerms.delete(previousSessionId);
      }
      if (termRef.current === live?.term) {
        termRef.current = null;
        fitAddonRef.current = null;
      }
      try {
        await invokeCommand('terminate_terminal', {
          sessionId: previousSessionId,
          owner: 'user',
        });
      } catch {}
    }

    liveSessionRef.current = newSessionId;
    setSessionId(newSessionId);
    sessionIdRef.current = newSessionId;
    setStatus('connecting');
    setExitCode(null);

    const hadLiveElement = Boolean(liveTerms.get(newSessionId)?.term.element);
    let term = termRef.current;
    if (!term || opts?.restart) {
      term = initTerminal(newSessionId);
    }

    if (term) {
      onDataDisposableRef.current?.dispose();
      onDataDisposableRef.current = term.onData((data: string) => {
        lastUserInputTimeRef.current = Date.now();
        const activeId = sessionIdRef.current || newSessionId;
        if (!activeId) return;
        invokeCommand('write_terminal', {
          sessionId: activeId,
          owner: 'user',
          input: data,
        })
          .then(() => {
            // Wake up poller immediately to fetch echoed keystrokes with 0ms perceived lag
            triggerImmediatePollRef.current();
          })
          .catch((err) => {
            console.error('Failed to write to terminal:', err);
          });
      });

      term.attachCustomKeyEventHandler((event) => {
        if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && !event.altKey) {
          if (event.key.toLowerCase() === 'c') {
            const selection = term?.getSelection();
            if (selection && selection.length > 0) {
              navigator.clipboard.writeText(selection).catch(() => {});
              return false;
            }
          }
          if (event.key.toLowerCase() === 'v') {
            event.preventDefault();
            const session = sessionIdRef.current;
            if (!session) return false;

            const pasteTextFallback = () => {
              navigator.clipboard?.readText?.().then((text) => {
                if (text && sessionIdRef.current) {
                  term?.paste(text);
                }
              }).catch(() => {});
            };

            if (navigator.clipboard && typeof navigator.clipboard.read === 'function') {
              navigator.clipboard.read().then(async (items) => {
                for (const item of items) {
                  const imageType = item.types.find((t) => t.toLowerCase().startsWith('image/'));
                  if (imageType) {
                    try {
                      const blob = await item.getType(imageType);
                      if (blob && stageClipboardBlobRef.current(blob, imageType)) {
                        return;
                      }
                    } catch {}
                  }
                }
                pasteTextFallback();
              }).catch(() => {
                pasteTextFallback();
              });
            } else {
              pasteTextFallback();
            }
            return false;
          }
        }
        return true;
      });

      term.focus();
    }

    if (!stillCurrent()) return;

    const host = containerRef.current;
    if (!host || !term || !fitAddonRef.current) {
      if (stillCurrent()) setStatus('idle');
      return;
    }

    try {
      const fontsReady = document.fonts?.ready;
      if (fontsReady) {
        await Promise.race([
          fontsReady.then(() => undefined).catch(() => undefined),
          new Promise<void>((resolve) => {
            window.setTimeout(resolve, 400);
          }),
        ]);
      }
      if (!stillCurrent()) return;

      const readGrid = () => {
        if (!fitAddonRef.current || !termRef.current) return null;
        return safeFitTerminal(termRef.current, fitAddonRef.current, host);
      };

      let grid: { cols: number; rows: number } | null = null;
      while (stillCurrent() && !grid) {
        const stable = await waitForStableHost(host, () => !stillCurrent());
        if (!stillCurrent()) return;
        if (!stable) continue;
        grid = readGrid();
      }
      if (!grid || !stillCurrent()) return;

      lastColsRef.current = grid.cols;
      lastRowsRef.current = grid.rows;

      const owner = terminalOwner(workspaceId, paneIdRef.current, agentIdRef.current);
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
            columns: grid.cols,
            rows: grid.rows,
          });
          generationRef.current += 1;
          restartedSessions.set(pendingAgentRestart.previousSessionId, pendingAgentRestart.nextSessionId);
          if (propSessionId) {
            restartedSessions.set(propSessionId, pendingAgentRestart.nextSessionId);
          }
          restartedAgent = true;
        } catch (err) {
          console.error('Failed to restart agent terminal:', err);
        }
      }
      const started = restartedAgent
        ? { attachedToExisting: false, scrollbackBase64: undefined as string | undefined }
        : await invokeCommand<{ attachedToExisting?: boolean; scrollbackBase64?: string }>(
            propSessionId && !opts?.restart ? 'attach_terminal' : 'start_terminal',
            propSessionId && !opts?.restart
              ? {
                  sessionId: newSessionId,
                  owner,
                  engine: currentEngine,
                  workspaceId,
                  paneId: paneIdRef.current,
                  columns: grid.cols,
                  rows: grid.rows,
                }
              : {
                  sessionId: newSessionId,
                  engine: currentEngine,
                  owner,
                  workspaceId,
                  paneId: paneIdRef.current,
                  confirmedByBuilder: true,
                  columns: grid.cols,
                  rows: grid.rows,
                },
          );
      if (!stillCurrent()) return;

      ptyOpenRef.current = true;

      if (term && !started?.attachedToExisting && (hadLiveElement || opts?.restart)) {
        term.reset();
      }
      if (started?.attachedToExisting) {
        void invokeCommand('resize_terminal', {
          sessionId: newSessionId,
          columns: grid.cols,
          rows: grid.rows,
        }).catch(() => {});
      } else if (!hadLiveElement && started?.scrollbackBase64 && term) {
        const historyBytes = base64ToUint8Array(started.scrollbackBase64);
        if (historyBytes.length > 0) {
          await enqueueWrite(historyBytes);
          if (!stillCurrent()) return;
        }
      }

      if (fitAddonRef.current) {
        cancelSpawnReconcileRef.current = reconcilePtySizeAfterSpawn({
          isCancelled: () => !stillCurrent() || sessionIdRef.current !== newSessionId,
          fitAndMeasure: () => {
            if (!termRef.current || !fitAddonRef.current || !containerRef.current) return null;
            return safeFitTerminal(termRef.current, fitAddonRef.current, containerRef.current);
          },
          getAppliedSize: () => ({
            cols: lastColsRef.current,
            rows: lastRowsRef.current,
          }),
          applySize: (dims) => {
            lastColsRef.current = dims.cols;
            lastRowsRef.current = dims.rows;
            void invokeCommand('resize_terminal', {
              sessionId: newSessionId,
              columns: dims.cols,
              rows: dims.rows,
            }).catch(() => {});
          },
        });
      }

      scheduleStableFitRef.current();

      if (!stillCurrent()) {
        return;
      }

      setStatus('running');
      recordTerminalOutput(newSessionId, `> ${currentEngine || 'Antigravity'} active`, {
        workspaceId,
        engine: currentEngine || initialEngine,
        title: customTitle,
      });

      startPolling(newSessionId);
    } catch (err: any) {
      console.error('Failed to start ConPTY session:', err);
      if (isMountedRef.current && sessionIdRef.current === newSessionId) {
        setStatus('idle');
        term?.write(`\r\n\x1b[31m[Failed to start ConPTY terminal: ${err?.message || err}]\x1b[0m\r\n`);
      }
    }
  }, [workspaceId, propSessionId, initTerminal, startPolling, stopPolling]);

  const terminateSession = useCallback(async () => {
    stopPolling();
    const idToTerminate = sessionIdRef.current;
    if (idToTerminate) {
      try {
        await invokeCommand('terminate_terminal', {
          sessionId: idToTerminate,
          owner: 'user',
        });
      } catch (e) {
        console.error('Failed to terminate session:', e);
      }
    }
    sessionIdRef.current = '';
    setSessionId('');
    setStatus('terminated');
    termRef.current?.write('\r\n\x1b[90m[Session Terminated by User]\x1b[0m\r\n');
  }, [stopPolling]);

  const handleClear = useCallback(() => {
    termRef.current?.clear();
    termRef.current?.focus();
  }, []);

  useEffect(() => {
    if (chrome !== 'pane') return;
    const onCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; command?: string }>).detail;
      if (!detail) return;
      const addressed = detail.sessionId ? (restartedSessions.get(detail.sessionId) ?? detail.sessionId) : null;
      const isTargeted = detail.sessionId && (
        detail.sessionId === sessionIdRef.current ||
        addressed === sessionIdRef.current ||
        detail.sessionId === propSessionId
      );
      const isGlobalAgentRefresh = !detail.sessionId && (
        detail.command === 'restart-agent' || detail.command === 'refresh-all'
      );

      if (!isTargeted && !isGlobalAgentRefresh) return;

      if (detail.command === 'restart-agent') {
        const term = termRef.current;
        if (term) {
          term.reset();
        }
        lastColsRef.current = null;
        lastRowsRef.current = null;
        const currentId = sessionIdRef.current;
        if (currentId) {
          stopPolling();
          setStatus('connecting');
          setExitCode(null);
          const cols = term?.cols || 80;
          const rows = term?.rows || 24;
          const owner = terminalOwner(workspaceId, paneIdRef.current, agentIdRef.current);
          invokeCommand<{ attachedToExisting?: boolean; scrollbackBase64?: string }>('attach_terminal', {
            sessionId: currentId,
            owner,
            engine: engineRef.current,
            workspaceId,
            paneId: paneIdRef.current,
            columns: cols,
            rows: rows,
          })
            .then((started) => {
              if (term && started?.attachedToExisting) {
                term.reset();
              }
              setStatus('running');
              ptyOpenRef.current = true;
              startPolling(currentId);
              scheduleStableFitRef.current();
            })
            .catch(() => {
              void startSession(engineRef.current);
            });
        }
        return;
      }
      if (detail.command === 'clear') handleClear();
      if (detail.command === 'refresh' || detail.command === 'redraw') {
        const term = termRef.current;
        const sessionId = sessionIdRef.current;
        if (term && sessionId && term.cols > 1 && term.rows > 1) {
          fitTerminal();
          try {
            term.refresh(0, Math.max(0, term.rows - 1));
          } catch {}
        }
        return;
      }
      if (detail.command === 'restart') void startSession(engineRef.current, { restart: true });
      if (detail.command === 'interrupt') {
        void invokeCommand('write_terminal', {
          sessionId: sessionIdRef.current,
          owner: 'user',
          input: '\x03',
        }).catch(() => {});
      }
      if (detail.command === 'font-larger' || detail.command === 'font-smaller') {
        const term = termRef.current;
        if (!term) return;
        const next = Math.min(22, Math.max(10, (term.options.fontSize ?? 13) + (detail.command === 'font-larger' ? 1 : -1)));
        term.options.fontSize = next;
        fitTerminal();
      }
    };
    window.addEventListener('kite:terminal-command', onCommand);
    return () => window.removeEventListener('kite:terminal-command', onCommand);
  }, [chrome, handleClear, propSessionId, startSession]);

  useEffect(() => {
    if (initialEngine && initialEngine !== engineRef.current) {
      engineRef.current = initialEngine;
      setEngine(initialEngine);
    }
  }, [initialEngine]);

  // ── Direct In-Terminal Prompt Delivery (No intermediate popup window) ──
  useEffect(() => {
    let cancelled = false;

    const handleStagedPrompt = async (e: Event) => {
      const detail = (e as CustomEvent<{
        sessionId?: string;
        paneId?: string;
        prompt: string;
        agentName?: string;
        engine?: string;
      }>).detail;
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

      // Reactive gate: wait until the terminal/agent is genuinely ready to receive input
      await waitForTerminalReady(sid, { timeoutMs: 12000 });
      if (cancelled) return;

      // Stream text directly into PTY stdin in fast natural chunks so it appears typed at the CLI prompt
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

      // Send Enter key to submit instruction
      await new Promise((r) => setTimeout(r, 120));
      await invokeCommand('write_terminal', {
        sessionId: sid,
        input: '\r\n',
        owner: 'user',
      }).catch(() => {});

      // Mark the prompt as injected so subsequent activity is tracked as real work
      markTerminalPromptInjected(sid);

      setTimeout(() => {
        if (!cancelled) {
          setIsReceivingPrompt(false);
          termRef.current?.focus();
        }
      }, 500);
    };

    window.addEventListener('kite:terminal-staged-prompt', handleStagedPrompt);
    return () => {
      cancelled = true;
      window.removeEventListener('kite:terminal-staged-prompt', handleStagedPrompt);
    };
  }, [propSessionId, status, triggerImpactPulse]);

  // ── Arrival wave: the thrown prompt landed in this terminal ──
  useEffect(() => {
    const handlePromptLanded = (e: Event) => {
      const detail = (e as CustomEvent<{
        sessionId?: string;
        targetPaneId?: string;
      }>).detail;
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
    return () => {
      window.removeEventListener('kite:prompt-landed', handlePromptLanded);
      if (impactTimerRef.current !== null) {
        window.clearTimeout(impactTimerRef.current);
        impactTimerRef.current = null;
      }
    };
  }, [propSessionId, triggerImpactPulse]);

  useEffect(() => {
    isMountedRef.current = true;
    liveSessionRef.current = propSessionId || liveSessionRef.current;
    void startSession();

    const ro = new ResizeObserver(() => {
      scheduleStableFitRef.current();
    });

    if (containerRef.current) {
      ro.observe(containerRef.current);
    }

    const handleWindowResize = () => {
      scheduleStableFitRef.current();
    };
    window.addEventListener('resize', handleWindowResize);

    return () => {
      cancelSpawnReconcileRef.current?.();
      cancelSpawnReconcileRef.current = null;
      if (driftCheckFrameRef.current !== null) {
        window.cancelAnimationFrame(driftCheckFrameRef.current);
        driftCheckFrameRef.current = null;
      }
      if (syncHoldTimerRef.current !== null) {
        window.clearTimeout(syncHoldTimerRef.current);
        syncHoldTimerRef.current = null;
      }
      const pendingFrame = syncHoldRef.current.flush();
      if (pendingFrame && pendingFrame.length > 0 && termRef.current) {
        try {
          termRef.current.write(pendingFrame);
        } catch {
          /* The pane is going away. Drop the frame rather than throw. */
        }
      }
      startGenRef.current += 1;
      fitWatchRef.current += 1;
      ptyOpenRef.current = false;
      isMountedRef.current = false;
      window.removeEventListener('resize', handleWindowResize);
      ro.disconnect();
      stopPolling();
      onDataDisposableRef.current?.dispose();
      onDataDisposableRef.current = null;
      const id = sessionIdRef.current;
      const live = id ? liveTerms.get(id) : undefined;
      const el = termRef.current?.element;
      if (live && el && termRef.current === live.term) {
        terminalParking().appendChild(el);
      }
      termRef.current = null;
      fitAddonRef.current = null;
      syncVisibleBitmapRenderers();
    };
    // The session stays alive across splits and mode switches. This effect
    // rebinds the existing screen; it must not follow callback identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propSessionId]);

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

  // Instant wake-up when app is foregrounded or focused again
  useEffect(() => {
    const handleFocus = () => {
      isWindowFocusedRef.current = true;
      if (sessionIdRef.current) {
        triggerImmediatePollRef.current();
      }
    };
    const handleBlur = () => {
      isWindowFocusedRef.current = false;
    };
    const handleVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        isWindowFocusedRef.current = true;
        if (sessionIdRef.current) {
          triggerImmediatePollRef.current();
        }
      }
    };

    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  return (
    <div
      ref={surfaceRef}
      className={`terminal-view-container${compact ? ' terminal-view-container--compact' : ''}${
        chrome === 'pane' ? ' terminal-view-container--pane' : ''
      }`}
      data-session-id={sessionId || propSessionId || undefined}
      data-pane-id={paneIdRef.current}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types).includes('application/x-kite-files-entry')) {
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
      <header className="terminal-toolbar">
        <div className="terminal-toolbar__left">
          <div className="terminal-toolbar__icon">
            <TerminalIcon size={14} />
          </div>
          <span className="terminal-toolbar__title">{customTitle || 'ConPTY Terminal'}</span>
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
            onClick={handleClear}
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
                onClick={() => startSession(engine, { restart: true })}
                className="terminal-btn terminal-btn--secondary"
                title="Restart Terminal Session"
                type="button"
              >
                <RotateCwIcon size={13} />
                <span>Restart</span>
              </button>
              <button
                onClick={terminateSession}
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
              onClick={() => startSession(engine, { restart: true })}
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
      )}

      {/* Terminal Canvas Host */}
      <div
        className={[
          'terminal-canvas-area',
          isReceivingPrompt ? 'terminal-canvas-area--receiving' : '',
          isImpactPulse ? 'terminal-canvas-area--impact' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={() => {
          termRef.current?.focus();
        }}
      >
        <div ref={containerRef} className="terminal-surface-host" />

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
