import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { invokeCommand } from '../../../lib/ipc';
import {
  recordTerminalOutput,
  markTerminalExited,
} from '../../../lib/terminalRegistry';
import {
  activateTerminalUnicodeProvider,
  attachDomBlockFillCleanup,
  buildWindowsConptyOptions,
  DEFAULT_WINDOWS_CONPTY_BUILD_NUMBER,
  safeFitTerminal,
  StableCellFitAddon,
  TERMINAL_SCROLLBAR_WIDTH_PX,
} from '../../../lib/terminalViewport';
import {
  classifyForegroundOutputRefresh,
  createSyncOutputHold,
  splitAlternateScreenEnterChunk,
  SYNC_OUTPUT_CURSOR_RESTORE_HOLD_MS,
  SYNC_OUTPUT_MAX_HOLD_MS,
  writeTerminalOutputWithRefresh,
  type ForegroundOutputScanState,
} from '../../../lib/terminalSyncOutput';
import { openFileInRightDock } from '../../../lib/filePreviewNav';
import {
  extractTerminalLinks,
  getTerminalWebLinksTarget,
  openTerminalWebLink,
} from '../../../lib/terminalLinkNav';
import {
  getTerminalAppearancePrefs,
  resolveTerminalFontFamily,
  TERMINAL_APPEARANCE_CHANGED_EVENT,
} from '../../../lib/terminalAppearancePrefs';
import {
  base64ToUint8Array,
  isLiveTerminalVisible,
  liveTerms,
  activeMountedSessions,
  terminalParking,
  stopParkedPolling,
  syncParkedPollers,
} from './terminalSessionRegistry';
import '@xterm/xterm/css/xterm.css';

export interface XtermDomSurfaceProps {
  sessionId: string;
  workspaceId?: string | null;
  paneId?: string;
  agentId?: string;
  engine?: string;
  className?: string;
  onProcessExit?: (exitCode: number | null) => void;
  onStageClipboardBlob?: (blob: Blob, mimeType: string, fileName?: string) => boolean;
}

export interface XtermDomSurfaceHandle {
  clear: () => void;
  focus: () => void;
  fit: () => void;
}

export const XtermDomSurface = forwardRef<XtermDomSurfaceHandle, XtermDomSurfaceProps>((props, ref) => {
  const {
    sessionId,
    workspaceId = null,
    engine = 'powershell',
    className = '',
    onProcessExit,
    onStageClipboardBlob,
  } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const pollingRef = useRef<number | null>(null);
  const sessionIdRef = useRef<string>(sessionId);
  sessionIdRef.current = sessionId;

  const isWindowFocusedRef = useRef<boolean>(true);
  const isMountedRef = useRef<boolean>(true);
  const lastUserInputTimeRef = useRef<number>(0);
  const triggerImmediatePollRef = useRef<() => void>(() => {});
  const onProcessExitRef = useRef(onProcessExit);
  onProcessExitRef.current = onProcessExit;
  const onStageClipboardBlobRef = useRef(onStageClipboardBlob);
  onStageClipboardBlobRef.current = onStageClipboardBlob;

  const onDataDisposableRef = useRef<{ dispose: () => void } | null>(null);

  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const writeActiveRef = useRef<number>(0);
  const syncHoldRef = useRef(createSyncOutputHold());
  const syncHoldTimerRef = useRef<number | null>(null);
  const foregroundScanStateRef = useRef<ForegroundOutputScanState>({
    endsWithCarriageReturn: false,
    scanTail: '',
  });

  const altScreenSplitTailRef = useRef<string>('');
  const fitDeferredRef = useRef<boolean>(false);
  const writeDecoderRef = useRef<TextDecoder>(new TextDecoder('utf-8', { fatal: false }));
  const utf8DecoderRef = useRef<TextDecoder>(new TextDecoder('utf-8', { fatal: false }));
  const fitNowRef = useRef<() => void>(() => {});

  const resizeInFlightRef = useRef<boolean>(false);
  const queuedResizeDimsRef = useRef<{ cols: number; rows: number } | null>(null);
  const lastColsRef = useRef<number>(0);
  const lastRowsRef = useRef<number>(0);

  const dispatchSerializedResize = useCallback(
    (targetSessionId: string, cols: number, rows: number) => {
      if (!targetSessionId || cols <= 0 || rows <= 0) return;
      queuedResizeDimsRef.current = { cols, rows };
      if (resizeInFlightRef.current) return;

      const step = () => {
        const nextDims = queuedResizeDimsRef.current;
        if (!nextDims || sessionIdRef.current !== targetSessionId) {
          resizeInFlightRef.current = false;
          queuedResizeDimsRef.current = null;
          return;
        }
        queuedResizeDimsRef.current = null;
        resizeInFlightRef.current = true;
        void invokeCommand('resize_terminal', {
          sessionId: targetSessionId,
          columns: nextDims.cols,
          rows: nextDims.rows,
        })
          .then(() => {
            if (queuedResizeDimsRef.current && sessionIdRef.current === targetSessionId) {
              step();
              return;
            }
            resizeInFlightRef.current = false;
          })
          .catch(() => {
            resizeInFlightRef.current = false;
          });
      };
      step();
    },
    []
  );

  const fitTerminal = useCallback(() => {
    const host = containerRef.current;
    const term = termRef.current;
    const fit = fitAddonRef.current;
    if (!host || !fit || !term) return;
    try {
      safeFitTerminal(term, fit, host);
      if (term.cols !== lastColsRef.current || term.rows !== lastRowsRef.current) {
        lastColsRef.current = term.cols;
        lastRowsRef.current = term.rows;
        if (sessionIdRef.current) {
          dispatchSerializedResize(sessionIdRef.current, term.cols, term.rows);
        }
      }
    } catch {}
  }, [dispatchSerializedResize]);

  fitNowRef.current = fitTerminal;

  useImperativeHandle(ref, () => ({
    clear: () => {
      termRef.current?.clear();
      termRef.current?.focus();
    },
    focus: () => {
      termRef.current?.focus();
    },
    fit: () => {
      fitTerminal();
    },
  }));

  const stopPolling = useCallback(() => {
    if (pollingRef.current !== null) {
      window.clearTimeout(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const writeRaw = useCallback((data: Uint8Array | string, onFlushed?: () => void) => {
    writeActiveRef.current += 1;
    const releaseWrite = () => {
      writeActiveRef.current = Math.max(0, writeActiveRef.current - 1);
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

          const live = sessionId ? liveTerms.get(sessionId) : undefined;
          const isVisible =
            typeof document !== 'undefined' &&
            document.visibilityState === 'visible' &&
            isWindowFocusedRef.current &&
            (!live || isLiveTerminalVisible(live));

          const timer = setTimeout(done, isVisible ? 100 : 15);
          const text =
            typeof data === 'string'
              ? data
              : writeDecoderRef.current.decode(data, { stream: true });

          const deliverText = (chunkText: string, cb: () => void) => {
            if (!chunkText) {
              cb();
              return;
            }
            const refreshPlan = classifyForegroundOutputRefresh(chunkText, {
              scanState: foregroundScanStateRef.current,
            });
            writeTerminalOutputWithRefresh(term, chunkText, {
              forceViewportRefresh: refreshPlan.forceViewportRefresh,
              followupViewportRefresh: refreshPlan.followupViewportRefresh,
              clearTextureAtlasOnFollowup: refreshPlan.clearTextureAtlasOnFollowup,
              shouldRefreshViewportSynchronously: () => true,
              shouldDeferAtlasClear: () =>
                writeActiveRef.current > 1 || syncHoldRef.current.pending,
              onParsed: cb,
            });
          };

          if (text) {
            const hasPendingResize = fitDeferredRef.current;
            const split = splitAlternateScreenEnterChunk(
              text,
              altScreenSplitTailRef.current,
              hasPendingResize
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
              return;
            }
            deliverText(text, () => {
              clearTimeout(timer);
              done();
            });
          } else {
            term.write(data, () => {
              clearTimeout(timer);
              done();
            });
          }
        })
    );

    writeQueueRef.current = next.catch(() => {
      releaseWrite();
    });
    return writeQueueRef.current;
  }, [sessionId]);

  const enqueueWrite = useCallback(
    (chunk: Uint8Array | string, onFlushed?: () => void): Promise<void> => {
      const ready = syncHoldRef.current.push(chunk);
      if (syncHoldRef.current.pending) {
        if (syncHoldTimerRef.current !== null) {
          window.clearTimeout(syncHoldTimerRef.current);
        }
        const timeoutMs = syncHoldRef.current.holding
          ? SYNC_OUTPUT_MAX_HOLD_MS
          : SYNC_OUTPUT_CURSOR_RESTORE_HOLD_MS;
        syncHoldTimerRef.current = window.setTimeout(() => {
          syncHoldTimerRef.current = null;
          const frame = syncHoldRef.current.flush();
          if (frame) {
            writeRaw(frame, onFlushed);
          }
        }, timeoutMs);
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
    },
    [writeRaw]
  );

  // Initialize xterm instance (new or reattached)
  useEffect(() => {
    if (!containerRef.current) return;

    let term: Terminal;
    let fitAddon: FitAddon;
    let cleanupDomBlockFill: (() => void) | undefined;

    const existing = sessionId ? liveTerms.get(sessionId) : undefined;
    if (existing && existing.term.element) {
      containerRef.current.innerHTML = '';
      containerRef.current.appendChild(existing.term.element);
      term = existing.term;
      fitAddon = existing.fit;
      cleanupDomBlockFill = existing.cleanupDomBlockFill;
      termRef.current = term;
      fitAddonRef.current = fitAddon;
      const appearance = getTerminalAppearancePrefs();
      term.options.fontFamily = resolveTerminalFontFamily(appearance.fontFamilyId);
      term.options.fontSize = appearance.fontSize;
      term.options.lineHeight = appearance.lineHeight;
      term.options.cursorStyle = appearance.cursorStyle;
      term.options.cursorBlink = appearance.cursorBlink;
      if (sessionId) {
        activeMountedSessions.add(sessionId);
        stopParkedPolling(sessionId);
      }
      fitTerminal();
    } else {
      containerRef.current.innerHTML = '';
      const prefs = getTerminalAppearancePrefs();

      term = new Terminal({
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
          brightMagenta: '#e5b3a3',
          brightCyan: '#7fdcd9',
          brightWhite: '#ffffff',
        },
        fontFamily: resolveTerminalFontFamily(prefs.fontFamilyId),
        fontSize: prefs.fontSize,
        lineHeight: prefs.lineHeight,
        cursorBlink: prefs.cursorBlink,
        cursorStyle: prefs.cursorStyle,
        convertEol: true,
        scrollback: 10000,
        ...buildWindowsConptyOptions(DEFAULT_WINDOWS_CONPTY_BUILD_NUMBER),
      });

      (term.options as unknown as { scrollbar?: { width?: number } }).scrollbar = {
        width: TERMINAL_SCROLLBAR_WIDTH_PX,
      };

      fitAddon = new StableCellFitAddon();
      term.loadAddon(fitAddon);

      activateTerminalUnicodeProvider(term);
      cleanupDomBlockFill = attachDomBlockFillCleanup(term);

      // Link provider (Ctrl+Click to open)
      term.registerLinkProvider({
        provideLinks(bufferLineNumber, callback) {
          const line = term.buffer.active.getLine(bufferLineNumber - 1);
          if (!line) {
            callback(undefined);
            return;
          }
          const text = line.translateToString(true);
          const links = extractTerminalLinks(text);
          callback(
            links.map((link) => ({
              range: {
                start: { x: link.start + 1, y: bufferLineNumber },
                end: { x: link.end, y: bufferLineNumber },
              },
              text: link.text,
              activate(_event, textValue) {
                const candidate = textValue.trim().replace(/^['"`(<\[]+|['"`)>\].,;:]+$/g, '');
                if (link.kind === 'web') {
                  openTerminalWebLink(candidate, workspaceId);
                } else {
                  openFileInRightDock({
                    candidate,
                    workspaceId,
                    collapseTree: true,
                  });
                }
              },
              hover() {
                if (link.kind === 'web') {
                  const target = getTerminalWebLinksTarget();
                  term.element?.setAttribute(
                    'title',
                    target === 'external'
                      ? 'Ctrl + Click para abrir en el navegador externo'
                      : 'Ctrl + Click para abrir en el navegador integrado'
                  );
                } else {
                  term.element?.setAttribute('title', 'Ctrl + Click para previsualizar archivo');
                }
              },
              leave() {
                term.element?.removeAttribute('title');
              },
            }))
          );
        },
      });

      term.open(containerRef.current);
    }

    termRef.current = term;
    fitAddonRef.current = fitAddon;
    if (sessionId) {
      liveTerms.set(sessionId, { term, fit: fitAddon, cleanupDomBlockFill });
    }
    fitTerminal();

    onDataDisposableRef.current?.dispose();
    onDataDisposableRef.current = term.onData((data: string) => {
      lastUserInputTimeRef.current = Date.now();
      if (!sessionIdRef.current) return;
      void invokeCommand('write_terminal', {
        sessionId: sessionIdRef.current,
        owner: 'user',
        input: data,
      })
        .then(() => triggerImmediatePollRef.current())
        .catch(() => {});
    });

    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && !event.altKey) {
        if (event.key.toLowerCase() === 'c') {
          const selection = term.getSelection();
          if (selection && selection.length > 0) {
            navigator.clipboard.writeText(selection).catch(() => {});
            return false;
          }
        }
        if (event.key.toLowerCase() === 'v') {
          event.preventDefault();
          if (typeof navigator !== 'undefined' && navigator.clipboard?.read) {
            void navigator.clipboard.read().then(async (items) => {
              for (const item of items) {
                const imgType = item.types.find((t) => t.toLowerCase().startsWith('image/'));
                if (imgType) {
                  const blob = await item.getType(imgType);
                  if (onStageClipboardBlobRef.current?.(blob, imgType)) {
                    return;
                  }
                }
              }
              const text = await navigator.clipboard.readText().catch(() => '');
              if (text) term.paste(text);
            }).catch(() => {
              void navigator.clipboard.readText().then((text) => {
                if (text) term.paste(text);
              }).catch(() => {});
            });
          } else if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
            void navigator.clipboard.readText().then((text) => {
              if (text) term.paste(text);
            }).catch(() => {});
          }
          return false;
        }
      }
      return true;
    });

    return () => {
      onDataDisposableRef.current?.dispose();
      onDataDisposableRef.current = null;
    };
  }, [sessionId, workspaceId, fitTerminal]);

  // Window focus / visibility listeners
  useEffect(() => {
    const onFocus = () => {
      isWindowFocusedRef.current = true;
      triggerImmediatePollRef.current?.();
      termRef.current?.refresh(0, Math.max(0, (termRef.current.rows || 1) - 1));
    };
    const onBlur = () => {
      isWindowFocusedRef.current = false;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        isWindowFocusedRef.current = true;
        triggerImmediatePollRef.current?.();
      } else {
        isWindowFocusedRef.current = false;
      }
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Output polling loop
  useEffect(() => {
    if (!sessionId) return;
    let active = true;

    const tick = async () => {
      if (!active || !isMountedRef.current) return;
      let nextDelay = 40;

      try {
        const res: any = await invokeCommand('read_terminal_output', {
          sessionId,
          owner: 'user',
        });

        if (!active || !isMountedRef.current) return;

        const now = Date.now();
        const hasRecentUserInput = now - lastUserInputTimeRef.current < 4000;
        const live = liveTerms.get(sessionId);
        const isVisible =
          typeof document !== 'undefined' &&
          document.visibilityState === 'visible' &&
          isWindowFocusedRef.current &&
          (!live || isLiveTerminalVisible(live));

        if (res?.kind === 'output' && res.bytesBase64) {
          const bytes = base64ToUint8Array(res.bytesBase64);
          await enqueueWrite(bytes);
          nextDelay = syncHoldRef.current.pending ? 6 : isVisible ? 16 : 50;

          try {
            const text = utf8DecoderRef.current.decode(bytes, { stream: true });
            if (text) {
              recordTerminalOutput(sessionId, text, { workspaceId, engine });
            }
          } catch {}
        } else if (res?.kind === 'exited') {
          markTerminalExited(sessionId);
          const code = res.status?.code ?? 0;
          if (termRef.current) {
            termRef.current.write(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`);
          }
          onProcessExitRef.current?.(code);
          return;
        } else if (res?.kind === 'none') {
          nextDelay = hasRecentUserInput ? 40 : isVisible ? 120 : 350;
        }
      } catch {
        nextDelay = 250;
      }

      if (active && isMountedRef.current) {
        pollingRef.current = window.setTimeout(tick, nextDelay);
      }
    };

    triggerImmediatePollRef.current = () => {
      if (pollingRef.current !== null) {
        window.clearTimeout(pollingRef.current);
      }
      void tick();
    };

    pollingRef.current = window.setTimeout(tick, 40);

    return () => {
      active = false;
      stopPolling();
    };
  }, [sessionId, workspaceId, engine, enqueueWrite, stopPolling]);

  // ResizeObserver and layout resize listener
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let resizeTimer: number | null = null;
    const onContainerResize = () => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        fitTerminal();
      }, 32);
    };

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => onContainerResize());
      ro.observe(container);
    }

    const handleWindowResize = () => onContainerResize();
    const handleLayoutResize = () => fitTerminal();

    window.addEventListener('resize', handleWindowResize);
    window.addEventListener('kite:layout-resized', handleLayoutResize);

    return () => {
      ro?.disconnect();
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      window.removeEventListener('resize', handleWindowResize);
      window.removeEventListener('kite:layout-resized', handleLayoutResize);
    };
  }, [fitTerminal]);

  // Theme appearance change sync
  useEffect(() => {
    const onPrefsChange = () => {
      const next = getTerminalAppearancePrefs();
      const term = termRef.current;
      if (term) {
        term.options.fontSize = next.fontSize;
        term.options.fontFamily = resolveTerminalFontFamily(next.fontFamilyId);
        term.options.lineHeight = next.lineHeight;
        term.options.cursorBlink = next.cursorBlink;
        term.options.cursorStyle = next.cursorStyle;
        fitTerminal();
      }
    };

    window.addEventListener(TERMINAL_APPEARANCE_CHANGED_EVENT, onPrefsChange);
    return () => window.removeEventListener(TERMINAL_APPEARANCE_CHANGED_EVENT, onPrefsChange);
  }, [fitTerminal]);

  // Cleanup on unmount: park DOM element in #terminal-parking
  useEffect(() => {
    isMountedRef.current = true;
    if (sessionId) {
      activeMountedSessions.add(sessionId);
      stopParkedPolling(sessionId);
      syncParkedPollers();
    }

    return () => {
      isMountedRef.current = false;
      if (sessionId) {
        activeMountedSessions.delete(sessionId);
      }
      stopPolling();
      if (syncHoldTimerRef.current !== null) {
        window.clearTimeout(syncHoldTimerRef.current);
        syncHoldTimerRef.current = null;
      }

      if (sessionId) {
        const live = liveTerms.get(sessionId);
        if (live?.term.element && live.term.element.isConnected) {
          try {
            terminalParking().appendChild(live.term.element);
          } catch {}
        }
        syncParkedPollers();
      }
    };
  }, [sessionId, stopPolling]);

  return (
    <div
      ref={containerRef}
      className={`terminal-surface-host ${className}`}
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        backgroundColor: '#0a0a0a',
      }}
      onClick={() => termRef.current?.focus()}
    />
  );
});

XtermDomSurface.displayName = 'XtermDomSurface';
