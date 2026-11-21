import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { buildThreadTurns, ThreadTurnRail } from './ThreadTurnRail';
import type { ChatItem } from '../../../types';

function mockItem(
  partial: Partial<ChatItem> & { id: string; kind: ChatItem['kind']; text: string },
): ChatItem {
  return {
    title: null,
    detail: null,
    status: null,
    streaming: false,
    exitCode: null,
    createdAtUnixMs: 1_762_900_080_000,
    attachments: [],
    ...partial,
  };
}

describe('ThreadTurnRail', () => {
  it('groups transcript items into user turns with assistant previews', () => {
    const items: ChatItem[] = [
      mockItem({ id: 'u1', kind: 'user', text: 'First question about Grok' }),
      mockItem({ id: 't1', kind: 'tool', text: '', title: 'Read src/main.ts', filePath: 'src/main.ts' }),
      mockItem({ id: 'a1', kind: 'assistant', text: '**First answer** with `code`.' }),
      mockItem({ id: 'u2', kind: 'user', text: 'Second question about tools' }),
      mockItem({ id: 't2', kind: 'tool', text: '', title: 'Read src/acp.rs', filePath: 'src/acp.rs' }),
    ];

    const turns = buildThreadTurns(items, true);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.promptTitle).toBe('First question about Grok');
    expect(turns[0]?.assistantPreview).toBe('First answer with code.');
    expect(turns[1]?.promptTitle).toBe('Second question about tools');
    expect(turns[1]?.assistantPreview).toBe('Read 1 file');
  });

  it('renders one dot per user turn, shows preview card on hover, and scrolls on click', () => {
    const items: ChatItem[] = [
      mockItem({
        id: 'u1',
        kind: 'user',
        text: 'Primer mensaje de prueba',
        createdAtUnixMs: 1_762_900_080_000,
      }),
      mockItem({
        id: 'a1',
        kind: 'assistant',
        text: 'Respuesta del asistente al primer mensaje.',
      }),
      mockItem({
        id: 'u2',
        kind: 'user',
        text: 'Segundo mensaje de prueba',
        createdAtUnixMs: 1_762_900_140_000,
      }),
      mockItem({
        id: 'a2',
        kind: 'assistant',
        text: 'Segunda respuesta completa.',
      }),
      mockItem({
        id: 'u3',
        kind: 'user',
        text: 'Eh, ¿tenemos algunos errores actualmente? Por ejemplo, de los...',
        createdAtUnixMs: 1_762_900_200_000,
      }),
      mockItem({
        id: 'a3',
        kind: 'assistant',
        text: 'Sí, se puede revisar exactamente ese chat. La traza completa está persistida en kite.sqlite.',
      }),
      mockItem({
        id: 'u4',
        kind: 'user',
        text: 'Cuarto mensaje final',
        createdAtUnixMs: 1_762_900_260_000,
      }),
      mockItem({
        id: 'a4',
        kind: 'assistant',
        text: 'Cuarta respuesta lista.',
      }),
    ];

    const scrollSpy = vi.fn();
    const Wrapper: React.FC = () => {
      const ref = React.useRef<HTMLDivElement | null>(null);
      return (
        <div>
          <ThreadTurnRail items={items} transcriptRef={ref} />
          <div ref={ref}>
            {items
              .filter((it) => it.kind === 'user')
              .map((it) => (
                <article
                  key={it.id}
                  data-turn-user-id={it.id}
                  ref={(node) => {
                    if (node) {
                      node.scrollIntoView = scrollSpy;
                    }
                  }}
                >
                  {it.text}
                </article>
              ))}
          </div>
        </div>
      );
    };

    render(<Wrapper />);

    const nav = screen.getByRole('navigation', { name: 'Conversation turns' });
    expect(nav).toBeInTheDocument();

    const dots = screen.getAllByRole('listitem');
    expect(dots).toHaveLength(4);

    fireEvent.mouseEnter(dots[2]!);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('Eh, ¿tenemos algunos errores actualmente?');
    expect(tooltip).toHaveTextContent('Sí, se puede revisar exactamente ese chat.');
    expect(tooltip).toHaveTextContent('3 of 4');

    fireEvent.click(dots[2]!);
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });

  it('grows turn dots incrementally and keeps the active dot scrolled into view on overflow', () => {
    const initialItems: ChatItem[] = [
      mockItem({ id: 'u1', kind: 'user', text: 'First turn' }),
      mockItem({ id: 'a1', kind: 'assistant', text: 'First answer' }),
    ];

    const Wrapper: React.FC<{ items: ChatItem[] }> = ({ items }) => {
      const ref = React.useRef<HTMLDivElement | null>(null);
      return (
        <div>
          <ThreadTurnRail items={items} transcriptRef={ref} />
          <div ref={ref} />
        </div>
      );
    };

    const { rerender } = render(<Wrapper items={initialItems} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(1);

    const manyItems: ChatItem[] = [];
    for (let idx = 1; idx <= 20; idx += 1) {
      manyItems.push(mockItem({ id: `u${idx}`, kind: 'user', text: `Prompt ${idx}` }));
      manyItems.push(mockItem({ id: `a${idx}`, kind: 'assistant', text: `Reply ${idx}` }));
    }

    rerender(<Wrapper items={manyItems} />);
    const dots = screen.getAllByRole('listitem');
    expect(dots).toHaveLength(20);

    const list = screen.getByRole('list');
    Object.defineProperty(list, 'scrollHeight', { value: 420, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 180, configurable: true });
    const firstDot = dots[0]!;
    const lastDot = dots[19]!;
    Object.defineProperty(firstDot, 'offsetTop', { value: 8, configurable: true });
    Object.defineProperty(firstDot, 'offsetHeight', { value: 14, configurable: true });
    Object.defineProperty(lastDot, 'offsetTop', { value: 360, configurable: true });
    Object.defineProperty(lastDot, 'offsetHeight', { value: 14, configurable: true });

    list.scrollTop = 200;
    fireEvent.click(firstDot);
    expect(firstDot).toHaveAttribute('aria-current', 'step');
    expect(list.scrollTop).toBe(4);

    fireEvent.click(lastDot);
    expect(lastDot).toHaveAttribute('aria-current', 'step');
    expect(list.scrollTop).toBe(198);
  });

  it('excludes internal dispatch envelopes and coordinator wakeups from turn rail entries', () => {
    const internalEnvelope = [
      '[kite from="thread:child-1"]',
      'This is another agent, not the person.',
      'To reply: kite dispatch send thread:child-1 "<reply>"',
      'Irreversible and privileged actions still wait for the person.',
      'BODY:',
      'state: done',
    ].join('\n');

    const turns = buildThreadTurns([
      mockItem({ id: 'u1', kind: 'user', text: 'Run two subagents' }),
      mockItem({ id: 'a1', kind: 'assistant', text: 'Initial table.' }),
      mockItem({ id: 'u-env', kind: 'user', text: internalEnvelope }),
      mockItem({ id: 'a2', kind: 'assistant', text: 'Final synthesis.' }),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.promptTitle).toBe('Run two subagents');
    expect(turns[0]?.assistantPreview).toBe('Initial table. Final synthesis.');
  });

  it('ignores whitespace and protocol-only assistant items when building turn previews', () => {
    const turns = buildThreadTurns([
      mockItem({ id: 'u1', kind: 'user', text: 'Check logs' }),
      mockItem({ id: 't1', kind: 'tool', text: '', title: 'Read app.log', filePath: 'app.log' }),
      mockItem({ id: 'a-proto', kind: 'assistant', text: '{"type":"step-finish","tokens":{"input":10}}' }),
      mockItem({ id: 'a-ws', kind: 'assistant', text: '  \n  ' }),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.assistantPreview).toBe('Read 1 file');
  });

  it('renders turn-rail hover preview card with an opaque solid surface and no glass-overlay translucency', async () => {
    const fsSpecifier = ['node', 'fs'].join(':');
    const fs = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (filePath: string, encoding: 'utf8') => string;
    };
    const chatRailCss = fs.readFileSync('src/components/views/chat/styles/chat-rail.css', 'utf8');
    const visualLangCss = fs.readFileSync('src/visual-language.css', 'utf8');

    const cardBlock = chatRailCss.match(/\.chat-turn-rail__card\s*\{[^}]*\}/)?.[0] ?? '';
    expect(cardBlock).toContain('var(--menu-plate');
    expect(cardBlock).not.toContain('var(--glass-overlay-bg');
    expect(cardBlock).toContain('backdrop-filter: none;');

    const glassCardBlock =
      visualLangCss.match(
        /html\[data-surface-glass='true'\] body\.kite-app \.chat-turn-rail__card\s*\{[^}]*\}/,
      )?.[0] ?? '';
    expect(glassCardBlock).not.toContain('var(--glass-overlay-bg');
  });
});
