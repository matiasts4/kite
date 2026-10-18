import React, { useState, useEffect, useRef } from 'react';
import { IconBold, IconItalic } from './appIcons';

const SCRATCHPAD_KEY = 'kite-code.side-panel.app.scratchpad.v1';
const LEGACY_STORAGE_KEY = 'BM_STORAGE_SCRATCHPAD_CONTENT';

export interface ScratchpadAppProps {
  embedded?: boolean;
}

export const ScratchpadApp: React.FC<ScratchpadAppProps> = () => {
  const [content, setContent] = useState<string>(() => {
    try {
      const v1 = localStorage.getItem(SCRATCHPAD_KEY);
      if (v1) {
        const parsed = JSON.parse(v1);
        if (typeof parsed?.text === 'string') return parsed.text;
      }
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy) return legacy;
    } catch {
      // Local storage unreadable
    }
    return `# Kite Scratchpad\n\nQuick engineering scratchpad for temporary notes, curl commands, JSON drafts, or code snippets.\n\n- [x] Investigate WebSocket backoff logic\n- [ ] Profile memory usage on 1400x900 viewport\n- [ ] Validate IPC boundaries in rust handlers\n`;
  });

  const [isBold, setIsBold] = useState(false);
  const [isItalic, setIsItalic] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(
        SCRATCHPAD_KEY,
        JSON.stringify({ schemaVersion: 2, text: content, runs: [] })
      );
      localStorage.setItem(LEGACY_STORAGE_KEY, content);
    } catch {
      // ignore
    }
  }, [content]);

  const insertWrap = (before: string, after: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const prev = content.substring(0, start);
    const selected = content.substring(start, end);
    const next = content.substring(end);

    const replacement = `${before}${selected || 'text'}${after}`;
    const nextContent = `${prev}${replacement}${next}`;
    setContent(nextContent);

    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + before.length, start + before.length + (selected ? selected.length : 4));
    }, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        setIsBold((v) => !v);
        insertWrap('**', '**');
      } else if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        setIsItalic((v) => !v);
        insertWrap('*', '*');
      }
    }
  };

  return (
    <section className="scratchpad" aria-label="Scratchpad">
      <header className="scratchpad__header">
        <h2 className="scratchpad__title">Scratchpad</h2>
        <span className="scratchpad__where">Saved locally on this PC</span>
      </header>

      <fieldset className="scratchpad__formatting" aria-label="Text formatting">
        <button
          type="button"
          className="chrome-button scratchpad__format"
          aria-label="Bold"
          aria-pressed={isBold}
          onClick={() => {
            setIsBold((v) => !v);
            insertWrap('**', '**');
          }}
          title="Bold (Ctrl+B)"
        >
          <IconBold size={13} />
        </button>
        <button
          type="button"
          className="chrome-button scratchpad__format"
          aria-label="Italic"
          aria-pressed={isItalic}
          onClick={() => {
            setIsItalic((v) => !v);
            insertWrap('*', '*');
          }}
          title="Italic (Ctrl+I)"
        >
          <IconItalic size={13} />
        </button>
      </fieldset>

      <div className="scratchpad__editor">
        <textarea
          ref={textareaRef}
          className="tiptap"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Jot notes, curl commands, JSON drafts, or paste snippets…"
          spellCheck={false}
          style={{
            width: '100%',
            height: '100%',
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 'var(--text-row)',
            lineHeight: 'var(--leading-row)',
            resize: 'none',
            boxSizing: 'border-box',
          }}
        />
      </div>
    </section>
  );
};
