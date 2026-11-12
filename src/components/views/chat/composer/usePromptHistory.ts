import { useRef, useEffect } from 'react';
import type { KeyboardEvent, MutableRefObject } from 'react';
import type { ChatItem } from '../../../../types';
import {
  extractUserPromptHistory,
  getNextHistoryIndex,
  isNoNewlineBefore,
  isNoNewlineAfter,
  isPlainKey,
} from './composerTextHelpers';

export function usePromptHistory({
  threadId,
  threadItems = [],
  prompt,
  caretRef,
  onChangePrompt,
}: {
  threadId: string;
  threadItems?: ChatItem[];
  prompt: string;
  caretRef: MutableRefObject<{ start: number; end: number }>;
  onChangePrompt: (text: string) => void;
}) {
  const historyStateRef = useRef<{ owner: string; index: number | null; draft: string }>({
    owner: threadId,
    index: null,
    draft: '',
  });

  useEffect(() => {
    historyStateRef.current = { owner: threadId, index: null, draft: '' };
  }, [threadId]);

  const resetPromptHistory = () => {
    historyStateRef.current = { owner: threadId, index: null, draft: '' };
  };

  const handleHistoryKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const isUp = e.key === 'ArrowUp';
    if ((!isUp && e.key !== 'ArrowDown') || !isPlainKey(e)) return false;

    const target = e.currentTarget;
    const fullField = target.value === prompt;
    const selectionStart = fullField ? target.selectionStart : caretRef.current.start;
    const selectionEnd = fullField ? target.selectionEnd : caretRef.current.end;
    if (selectionStart !== selectionEnd) return false;

    if (isUp ? !isNoNewlineBefore(prompt, selectionStart) : !isNoNewlineAfter(prompt, selectionStart)) {
      return false;
    }

    const history = extractUserPromptHistory(threadItems);
    if (history.length === 0) return false;

    const currentIdx = historyStateRef.current.owner === threadId ? historyStateRef.current.index : null;
    const resolvedIdx = currentIdx !== null && prompt === history[currentIdx] ? currentIdx : null;

    if (resolvedIdx === null && isUp) {
      historyStateRef.current.draft = prompt;
    }

    const nextIdx = getNextHistoryIndex(history.length, resolvedIdx, isUp ? 'older' : 'newer');
    if (nextIdx !== undefined) {
      e.preventDefault();
      historyStateRef.current = {
        owner: threadId,
        index: nextIdx,
        draft: historyStateRef.current.draft,
      };
      const nextText = nextIdx === null ? historyStateRef.current.draft : (history[nextIdx] ?? '');
      onChangePrompt(nextText);
      requestAnimationFrame(() => {
        if (!fullField) return;
        target.focus();
        target.setSelectionRange(nextText.length, nextText.length);
      });
      return true;
    }
    return false;
  };

  return { handleHistoryKey, resetPromptHistory };
}
