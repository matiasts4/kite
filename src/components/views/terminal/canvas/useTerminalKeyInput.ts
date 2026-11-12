import React, { useRef } from 'react';
import { recordTerminalUserInput } from './terminalBenchMetrics';
import { encodeVtKey } from './terminalInputKeyEncoder';
import { selectionRows, type SelectionPoint } from './terminalCanvasTypes';

export interface UseTerminalKeyInputOptions {
  sessionId?: string;
  sendInput: (data: string, clearSelection?: boolean) => void;
  pasteTextToTerminal: (raw: string) => void;
  armFastPoll: (ms: number) => void;
  copySelectionToClipboard: () => boolean;
  selectionStartRef: React.MutableRefObject<SelectionPoint | null>;
  selectionEndRef: React.MutableRefObject<SelectionPoint | null>;
  scrollbackOffsetRef: React.MutableRefObject<number>;
  gridRowsRef: React.MutableRefObject<number>;
  scheduleRender: (rows?: number[]) => void;
  findOpenRef: React.MutableRefObject<boolean>;
  setFindOpen: (open: boolean) => void;
  onStageClipboardBlobRef: React.MutableRefObject<((blob: Blob, mimeType: string) => boolean) | undefined>;
  kittyKeyboardFlagsRef: React.MutableRefObject<number>;
  win32InputModeRef: React.MutableRefObject<boolean>;
  applicationCursorRef: React.MutableRefObject<boolean>;
  alternateScreenRef: React.MutableRefObject<boolean>;
  requestScrollLines: (lines: number) => void;
}

export function useTerminalKeyInput({
  sendInput,
  pasteTextToTerminal,
  armFastPoll,
  copySelectionToClipboard,
  selectionStartRef,
  selectionEndRef,
  scrollbackOffsetRef,
  gridRowsRef,
  scheduleRender,
  findOpenRef,
  setFindOpen,
  onStageClipboardBlobRef,
  kittyKeyboardFlagsRef,
  win32InputModeRef,
  applicationCursorRef,
  alternateScreenRef,
  requestScrollLines,
}: UseTerminalKeyInputOptions) {
  const isComposingRef = useRef(false);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    recordTerminalUserInput();
    if (e.nativeEvent.isComposing) return;
    armFastPoll(1000);

    // Ctrl/Cmd + C / V clipboard shortcuts
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === 'c') {
        if (e.shiftKey || copySelectionToClipboard()) {
          const start = selectionStartRef.current;
          const end = selectionEndRef.current;
          selectionStartRef.current = null;
          selectionEndRef.current = null;
          scheduleRender(
            selectionRows(start, end, scrollbackOffsetRef.current, gridRowsRef.current),
          );
          e.preventDefault();
          return;
        }
        if (!e.metaKey) {
          sendInput('\x03');
          e.preventDefault();
          return;
        }
      }
      if (key === 'f') {
        e.preventDefault();
        findOpenRef.current = true;
        setFindOpen(true);
        return;
      }
      if (key === 'v') {
        e.preventDefault();
        if (e.shiftKey && typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
          void navigator.clipboard.readText().then((txt) => {
            if (txt) pasteTextToTerminal(txt);
          });
          return;
        }
        void (async () => {
          const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
          if (clipboard?.read) {
            try {
              const items = await clipboard.read();
              for (const item of items) {
                const imgType = item.types.find((type) => type.toLowerCase().startsWith('image/'));
                if (!imgType) continue;
                const blob = await item.getType(imgType);
                if (onStageClipboardBlobRef.current?.(blob, imgType)) return;
              }
            } catch {
              // Fall through to text. A path already on the clipboard still pastes.
            }
          }
          const readText = clipboard?.readText?.bind(clipboard);
          const text = readText ? await readText().catch(() => '') : '';
          if (text) pasteTextToTerminal(text);
        })();
        return;
      }
    }

    const vtSeq = encodeVtKey(e, {
      kittyFlags: kittyKeyboardFlagsRef.current,
      win32Mode: win32InputModeRef.current,
      applicationCursor: applicationCursorRef.current,
      alternateScreen: alternateScreenRef.current,
      gridRows: gridRowsRef.current,
      onScrollPageUp: () => requestScrollLines(Math.max(1, gridRowsRef.current - 2)),
      onScrollPageDown: () => requestScrollLines(-Math.max(1, gridRowsRef.current - 2)),
    });

    if (vtSeq !== null) {
      e.preventDefault();
      sendInput(vtSeq);
    } else if (e.shiftKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
      e.preventDefault();
    }
  };

  const handleInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    if (isComposingRef.current) return;
    const value = e.currentTarget.value;
    if (value) {
      sendInput(value);
      e.currentTarget.value = '';
    }
  };

  const handleCompositionStart = () => {
    isComposingRef.current = true;
  };

  const handleCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    isComposingRef.current = false;
    const value = e.currentTarget.value || e.data;
    if (value) {
      sendInput(value);
      e.currentTarget.value = '';
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData('text/plain');
    if (text) {
      e.preventDefault();
      pasteTextToTerminal(text);
    }
  };

  return {
    isComposingRef,
    handleKeyDown,
    handleInput,
    handleCompositionStart,
    handleCompositionEnd,
    handlePaste,
  };
}
