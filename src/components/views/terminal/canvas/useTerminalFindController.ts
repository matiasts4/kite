import { useState, useRef, useCallback, useEffect } from 'react';
import { invokeCommand } from '../../../../lib/ipc';
import { collectFindHits, type GridFindHit } from './terminalGridText';
import type { CellSnapshot } from './terminalCanvasTypes';

export interface UseTerminalFindControllerOptions {
  sessionId?: string;
  matrixRef: React.MutableRefObject<CellSnapshot[][]>;
  rowWrappedRef: React.MutableRefObject<boolean[]>;
  pullViewport: (args: { deltaLines?: number; absoluteOffset?: number }) => Promise<void>;
  scheduleRender: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  findHitsRef: React.MutableRefObject<GridFindHit[]>;
  findIndexRef: React.MutableRefObject<number>;
  findOpenRef: React.MutableRefObject<boolean>;
}

export function useTerminalFindController({
  sessionId,
  matrixRef,
  rowWrappedRef,
  pullViewport,
  scheduleRender,
  inputRef,
  findHitsRef,
  findIndexRef,
  findOpenRef,
}: UseTerminalFindControllerOptions) {
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findIndex, setFindIndex] = useState(0);
  const [findCount, setFindCount] = useState(0);

  const findQueryRef = useRef('');
  const findInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (findOpen) findInputRef.current?.focus();
  }, [findOpen]);

  useEffect(() => {
    findHitsRef.current = [];
    findQueryRef.current = '';
    findOpenRef.current = false;
    findIndexRef.current = 0;
    setFindOpen(false);
    setFindQuery('');
    setFindIndex(0);
    setFindCount(0);
  }, [sessionId]);

  const applyFindQuery = useCallback(
    (query: string) => {
      findQueryRef.current = query;
      setFindQuery(query);
      if (!query.trim()) {
        findHitsRef.current = [];
        setFindCount(0);
        setFindIndex(0);
        scheduleRender();
        return;
      }
      const local = collectFindHits(matrixRef.current, rowWrappedRef.current, query);
      if (local.length > 0) {
        findHitsRef.current = local;
        setFindCount(local.length);
        setFindIndex(0);
        findIndexRef.current = 0;
        scheduleRender();
        return;
      }
      void invokeCommand<{ hits: Array<{ scrollbackOffset: number; row: number; col: number }> }>(
        'find_terminal_text',
        { sessionId, query, limit: 40 },
      )
        .then(async (res) => {
          const hit = res?.hits?.[0];
          if (!hit || findQueryRef.current !== query) {
            if (findQueryRef.current === query) {
              findHitsRef.current = [];
              setFindCount(0);
              scheduleRender();
            }
            return;
          }
          await pullViewport({ absoluteOffset: hit.scrollbackOffset });
          if (findQueryRef.current !== query) return;
          const next = collectFindHits(matrixRef.current, rowWrappedRef.current, query);
          findHitsRef.current = next;
          setFindCount(next.length);
          setFindIndex(0);
          findIndexRef.current = 0;
          scheduleRender();
        })
        .catch(() => {});
    },
    [pullViewport, scheduleRender, sessionId, matrixRef, rowWrappedRef]
  );

  const stepFind = useCallback(
    (direction: 1 | -1) => {
      const count = findHitsRef.current.length;
      if (count === 0) return;
      const next = (findIndexRef.current + direction + count) % count;
      findIndexRef.current = next;
      setFindIndex(next);
      scheduleRender();
    },
    [scheduleRender]
  );

  const closeFind = useCallback(() => {
    findOpenRef.current = false;
    findHitsRef.current = [];
    setFindOpen(false);
    setFindCount(0);
    scheduleRender();
    inputRef.current?.focus();
  }, [scheduleRender, inputRef]);

  const onViewportMetricsFind = useCallback((_depth: number) => {
    if (findOpenRef.current && findQueryRef.current.trim()) {
      findHitsRef.current = collectFindHits(
        matrixRef.current,
        rowWrappedRef.current,
        findQueryRef.current,
      );
      const count = findHitsRef.current.length;
      setFindCount((prev) => (prev === count ? prev : count));
      setFindIndex((prev) => {
        const next = count === 0 ? 0 : Math.min(prev, count - 1);
        findIndexRef.current = next;
        return next;
      });
    }
  }, [matrixRef, rowWrappedRef]);

  return {
    findOpen,
    setFindOpen,
    findQuery,
    findIndex,
    findCount,
    findHitsRef,
    findIndexRef,
    findQueryRef,
    findOpenRef,
    findInputRef,
    applyFindQuery,
    stepFind,
    closeFind,
    onViewportMetricsFind,
  };
}
