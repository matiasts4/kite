import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChatItem } from '../../../types';
import { activityTraceLabel, summarizeWorkBurst } from './activityPresentation';
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

export function buildThreadTurns(items: ChatItem[], running = false): ThreadTurnEntry[] {
  const turns: ThreadTurnEntry[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item || item.kind !== 'user') continue;

    const rawPrompt = stripMarkdown(expandCitations(item.text || ''));
    const promptTitle = rawPrompt || (item.attachments?.length ? 'Attached files' : 'Message');

    const assistantParts: string[] = [];
    const workItems: ChatItem[] = [];
    for (let j = i + 1; j < items.length; j += 1) {
      const next = items[j];
      if (!next) continue;
      if (next.kind === 'user') break;
      if (next.kind === 'assistant' && next.text?.trim()) {
        assistantParts.push(next.text.trim());
      } else if (next.kind === 'tool' || next.kind === 'command' || next.kind === 'reasoning') {
        workItems.push(next);
      }
    }

    const joinedAssistant = stripMarkdown(assistantParts.join(' '));
    const isLastTurn = turns.length === items.filter((it) => it.kind === 'user').length - 1;
    let assistantPreview = joinedAssistant;
    if (!assistantPreview) {
      if (workItems.length > 0) {
        const lastWork = workItems[workItems.length - 1];
        assistantPreview =
          summarizeWorkBurst(workItems) ||
          (lastWork ? activityTraceLabel(lastWork) : '') ||
          (isLastTurn && running ? 'Working…' : 'Completed actions');
      } else {
        assistantPreview = isLastTurn && running ? 'Working…' : 'No response yet';
      }
    }

    turns.push({
      userItemId: item.id,
      index: turns.length,
      promptTitle,
      assistantPreview,
      createdAtUnixMs: item.createdAtUnixMs ?? 0,
      timeLabel: formatTurnTimestamp(item.createdAtUnixMs),
    });
  }
  return turns;
}

export interface ThreadTurnRailProps {
  items: ChatItem[];
  running?: boolean;
  transcriptRef: React.RefObject<HTMLDivElement | null>;
  onEnsureAllVisible?: () => void;
}

export const ThreadTurnRail: React.FC<ThreadTurnRailProps> = ({
  items,
  running = false,
  transcriptRef,
  onEnsureAllVisible,
}) => {
  const turns = useMemo(() => buildThreadTurns(items, running), [items, running]);
  const [activeIndex, setActiveIndex] = useState<number>(() => Math.max(0, turns.length - 1));
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  useEffect(() => {
    if (turns.length === 0) {
      setActiveIndex(0);
      setHoveredIndex(null);
      return;
    }
    setActiveIndex((prev) => (prev >= turns.length ? turns.length - 1 : prev));
  }, [turns.length]);

  const syncActiveFromScroll = useCallback(() => {
    const container = transcriptRef.current;
    if (!container || turns.length === 0) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    if (scrollHeight - scrollTop - clientHeight <= 36) {
      setActiveIndex(turns.length - 1);
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const thresholdY = containerRect.top + Math.min(180, containerRect.height * 0.4);
    let current = 0;

    for (let idx = 0; idx < turns.length; idx += 1) {
      const turn = turns[idx];
      const node = container.querySelector<HTMLElement>(`[data-turn-user-id="${turn.userItemId}"]`);
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      if (rect.top <= thresholdY) {
        current = idx;
      } else {
        break;
      }
    }
    setActiveIndex(current);
  }, [transcriptRef, turns]);

  useEffect(() => {
    const container = transcriptRef.current;
    if (!container || turns.length === 0) return;
    syncActiveFromScroll();
    container.addEventListener('scroll', syncActiveFromScroll, { passive: true });
    return () => container.removeEventListener('scroll', syncActiveFromScroll);
  }, [transcriptRef, turns.length, syncActiveFromScroll]);

  const handleSelectTurn = useCallback(
    (turn: ThreadTurnEntry) => {
      setActiveIndex(turn.index);
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
    [transcriptRef, onEnsureAllVisible],
  );

  if (turns.length === 0) return null;

  const previewTurn = hoveredIndex !== null ? turns[hoveredIndex] ?? null : null;

  return (
    <nav
      className="chat-turn-rail"
      aria-label="Conversation turns"
      onMouseLeave={() => setHoveredIndex(null)}
    >
      <div className="chat-turn-rail__dots" role="list">
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
};
