import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatItem } from '../../../types';
import { activityTraceLabel, summarizeWorkBurst } from './activityPresentation';
import { isInternalDispatchItem, visibleAssistantText } from './chatItemHelpers';
import { expandCitations } from './citationChip';

export interface ThreadTurnEntry {
  userItemId: string;
  index: number;
  promptTitle: string;
  assistantPreview: string;
  createdAtUnixMs: number;
  timeLabel: string;
}

function stripMarkdown(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[#>*+-]+\s+/gm, '')
    .replace(/[*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatTurnTimestamp(unixMs: number | null | undefined): string {
  if (!unixMs || !Number.isFinite(unixMs) || unixMs < 86_400_000) return '';
  try {
    const raw = new Date(unixMs).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    return raw
      .replace(/\bAM\b/i, 'a.m.')
      .replace(/\bPM\b/i, 'p.m.');
  } catch {
    return '';
  }
}

interface CachedSettledTurn {
  userItem: ChatItem;
  userText: string;
  sliceLen: number;
  lastItem: ChatItem | undefined;
  lastText: string | undefined;
  lastStatus: string | null | undefined;
  runningFlag: boolean;
  entry: ThreadTurnEntry;
}

const MAX_CACHED_SETTLED_TURNS = 512;
const settledTurnCache = new Map<string, CachedSettledTurn>();

export function buildThreadTurns(items: ChatItem[], running = false): ThreadTurnEntry[] {
  if (settledTurnCache.size > MAX_CACHED_SETTLED_TURNS) {
    settledTurnCache.clear();
  }
  const userIndices: number[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item && item.kind === 'user' && !isInternalDispatchItem(item)) {
      userIndices.push(i);
    }
  }
  const humanTurnCount = userIndices.length;
  const turns: ThreadTurnEntry[] = [];
  for (let tIdx = 0; tIdx < humanTurnCount; tIdx += 1) {
    const i = userIndices[tIdx]!;
    const endIdx = tIdx + 1 < humanTurnCount ? userIndices[tIdx + 1]! : items.length;
    const item = items[i]!;
    const isLastTurn = tIdx === humanTurnCount - 1;
    const turnRunning = isLastTurn && running;
    const sliceLen = endIdx - i;
    const lastItem = endIdx > i + 1 ? items[endIdx - 1] : undefined;
    const cached = settledTurnCache.get(item.id);
    if (
      cached &&
      cached.userItem === item &&
      cached.userText === (item.text || '') &&
      cached.sliceLen === sliceLen &&
      cached.lastItem === lastItem &&
      cached.lastText === lastItem?.text &&
      cached.lastStatus === lastItem?.status &&
      cached.runningFlag === turnRunning
    ) {
      turns.push(
        cached.entry.index === tIdx ? cached.entry : { ...cached.entry, index: tIdx }
      );
      continue;
    }

    const rawPrompt = stripMarkdown(expandCitations(item.text || ''));
    const promptTitle = rawPrompt || (item.attachments?.length ? 'Attached files' : 'Message');

    const assistantParts: string[] = [];
    const workItems: ChatItem[] = [];
    for (let j = i + 1; j < endIdx; j += 1) {
      const next = items[j];
      if (!next) continue;
      if (next.kind === 'assistant') {
        const visible = visibleAssistantText(next.text ?? '').trim();
        if (visible) assistantParts.push(visible);
      } else if (next.kind === 'tool' || next.kind === 'command' || next.kind === 'reasoning') {
        workItems.push(next);
      }
    }

    const joinedAssistant = stripMarkdown(assistantParts.join(' '));
    let assistantPreview = joinedAssistant;
    if (!assistantPreview) {
      if (workItems.length > 0) {
        const lastWork = workItems[workItems.length - 1];
        assistantPreview =
          summarizeWorkBurst(workItems) ||
          (lastWork ? activityTraceLabel(lastWork) : '') ||
          (turnRunning ? 'Working…' : 'Completed actions');
      } else {
        assistantPreview = turnRunning ? 'Working…' : 'No response yet';
      }
    }

    const entry: ThreadTurnEntry = {
      userItemId: item.id,
      index: tIdx,
      promptTitle,
      assistantPreview,
      createdAtUnixMs: item.createdAtUnixMs ?? 0,
      timeLabel: formatTurnTimestamp(item.createdAtUnixMs),
    };
    settledTurnCache.set(item.id, {
      userItem: item,
      userText: item.text || '',
      sliceLen,
      lastItem,
      lastText: lastItem?.text,
      lastStatus: lastItem?.status,
      runningFlag: turnRunning,
      entry,
    });
    turns.push(entry);
  }
  return turns;
}

export interface ThreadTurnRailProps {
  items: ChatItem[];
  running?: boolean;
  transcriptRef: React.RefObject<HTMLDivElement | null>;
  onEnsureAllVisible?: () => void;
}

export const ThreadTurnRail: React.FC<ThreadTurnRailProps> = React.memo(({
  items,
  running = false,
  transcriptRef,
  onEnsureAllVisible,
}) => {
  const turns = useMemo(() => buildThreadTurns(items, running), [items, running]);
  const [activeIndex, setActiveIndex] = useState<number>(() => Math.max(0, turns.length - 1));
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const dotsRef = useRef<HTMLDivElement | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const lastActiveRef = useRef<number>(activeIndex);
  lastActiveRef.current = activeIndex;
  const turnsRef = useRef<ThreadTurnEntry[]>(turns);
  turnsRef.current = turns;
  const turnOffsetsCacheRef = useRef<{
    turnsRef: ThreadTurnEntry[];
    scrollHeight: number;
    clientHeight: number;
    clientWidth: number;
    offsets: Array<{ index: number; top: number }>;
  } | null>(null);

  const commitActiveIndex = useCallback((nextIndex: number) => {
    if (lastActiveRef.current === nextIndex) return;
    lastActiveRef.current = nextIndex;
    setActiveIndex(nextIndex);
  }, []);

  useEffect(() => {
    if (turns.length === 0) {
      turnOffsetsCacheRef.current = null;
      setActiveIndex(0);
      setHoveredIndex(null);
      return;
    }
    setActiveIndex((prev) => (prev >= turns.length ? turns.length - 1 : prev));
  }, [turns.length]);

  useEffect(() => {
    const list = dotsRef.current;
    if (!list || list.scrollHeight <= list.clientHeight) return;
    const activeEl = list.children.item(activeIndex) as HTMLElement | null;
    if (!activeEl) return;
    const itemTop = activeEl.offsetTop;
    const itemBottom = itemTop + activeEl.offsetHeight;
    if (itemTop < list.scrollTop) {
      list.scrollTop = Math.max(0, itemTop - 4);
    } else if (itemBottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = itemBottom - list.clientHeight + 4;
    }
  }, [activeIndex, turns.length]);

  const cancelScheduledSync = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  const syncActiveFromScroll = useCallback(() => {
    cancelScheduledSync();
    const currentTurns = turnsRef.current;
    const container = transcriptRef.current;
    if (!container || currentTurns.length === 0) return;

    const { scrollTop, scrollHeight, clientHeight, clientWidth } = container;
    if (scrollHeight - scrollTop - clientHeight <= 36) {
      commitActiveIndex(currentTurns.length - 1);
      return;
    }

    const cache = turnOffsetsCacheRef.current;
    let offsets: Array<{ index: number; top: number }>;
    if (
      cache &&
      cache.turnsRef === currentTurns &&
      cache.scrollHeight === scrollHeight &&
      cache.clientHeight === clientHeight &&
      cache.clientWidth === clientWidth
    ) {
      offsets = cache.offsets;
    } else {
      const containerRect = container.getBoundingClientRect();
      const nodeById = new Map<string, HTMLElement>();
      const nodes = container.querySelectorAll<HTMLElement>('[data-turn-user-id]');
      for (let i = 0; i < nodes.length; i += 1) {
        const el = nodes[i];
        const id = el?.dataset.turnUserId;
        if (id) nodeById.set(id, el);
      }
      offsets = [];
      for (let idx = 0; idx < currentTurns.length; idx += 1) {
        const turn = currentTurns[idx]!;
        const node = nodeById.get(turn.userItemId);
        if (!node) continue;
        const top = node.getBoundingClientRect().top - containerRect.top + scrollTop;
        offsets.push({ index: idx, top });
      }
      turnOffsetsCacheRef.current = {
        turnsRef: currentTurns,
        scrollHeight,
        clientHeight,
        clientWidth,
        offsets,
      };
    }

    const thresholdScrollTop = scrollTop + Math.min(180, clientHeight * 0.4);
    let nextIndex = 0;
    for (let i = 0; i < offsets.length; i += 1) {
      const entry = offsets[i]!;
      if (entry.top <= thresholdScrollTop) {
        nextIndex = entry.index;
      } else {
        break;
      }
    }
    commitActiveIndex(nextIndex);
  }, [transcriptRef, commitActiveIndex, cancelScheduledSync]);

  const scheduleSyncFromScroll = useCallback(() => {
    if (turnsRef.current.length === 0) return;
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
    }
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      syncActiveFromScroll();
    });
  }, [syncActiveFromScroll]);

  useEffect(() => {
    const container = transcriptRef.current;
    if (!container || turns.length === 0) return;
    syncActiveFromScroll();
    container.addEventListener('scroll', scheduleSyncFromScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', scheduleSyncFromScroll);
      cancelScheduledSync();
    };
  }, [transcriptRef, turns.length, syncActiveFromScroll, scheduleSyncFromScroll, cancelScheduledSync]);

  const handleSelectTurn = useCallback(
    (turn: ThreadTurnEntry) => {
      commitActiveIndex(turn.index);
      const scrollTarget = () => {
        const root = transcriptRef.current ?? document;
        const target = root.querySelector<HTMLElement>(`[data-turn-user-id="${turn.userItemId}"]`);
        if (target && typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return true;
        }
        return false;
      };

      if (!scrollTarget() && onEnsureAllVisible) {
        onEnsureAllVisible();
        requestAnimationFrame(() => {
          scrollTarget();
        });
      }
    },
    [transcriptRef, onEnsureAllVisible, commitActiveIndex],
  );

  if (turns.length === 0) return null;

  const previewTurn = hoveredIndex !== null ? turns[hoveredIndex] ?? null : null;

  return (
    <nav
      className="chat-turn-rail"
      aria-label="Conversation turns"
      onMouseLeave={() => setHoveredIndex(null)}
    >
      <div className="chat-turn-rail__dots" role="list" ref={dotsRef}>
        {turns.map((turn) => {
          const isActive = turn.index === activeIndex;
          const isHovered = turn.index === hoveredIndex;
          return (
            <button
              key={turn.userItemId}
              type="button"
              role="listitem"
              className={`chat-turn-rail__dot${isActive ? ' is-active' : ''}${isHovered ? ' is-hovered' : ''}`}
              aria-label={`Turn ${turn.index + 1} of ${turns.length}: ${turn.promptTitle}`}
              aria-current={isActive ? 'step' : undefined}
              onMouseEnter={() => setHoveredIndex(turn.index)}
              onFocus={() => setHoveredIndex(turn.index)}
              onBlur={() => setHoveredIndex((curr) => (curr === turn.index ? null : curr))}
              onClick={() => handleSelectTurn(turn)}
            >
              <span className="chat-turn-rail__pip" />
            </button>
          );
        })}
      </div>

      {previewTurn ? (
        <div className="chat-turn-rail__card" role="tooltip">
          <div className="chat-turn-rail__card-title">{previewTurn.promptTitle}</div>
          <div className="chat-turn-rail__card-body">{previewTurn.assistantPreview}</div>
          <div className="chat-turn-rail__card-footer">
            <span className="chat-turn-rail__card-count">
              {previewTurn.index + 1} of {turns.length}
            </span>
            {previewTurn.timeLabel ? (
              <time className="chat-turn-rail__card-time">{previewTurn.timeLabel}</time>
            ) : null}
          </div>
        </div>
      ) : null}
    </nav>
  );
});
ThreadTurnRail.displayName = 'ThreadTurnRail';
