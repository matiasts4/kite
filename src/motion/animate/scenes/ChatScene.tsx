import React, { Fragment, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import '../../../components/views/chat.css';
import { ThinkingOrb } from 'thinking-orbs';
import {
  ChatItemRow,
  ChatWorkGroup,
  groupTranscriptRows,
  liveThoughtLine,
} from '../../../components/views/chat/ChatItemRow';
import { SubagentGroupRow } from '../../../components/views/chat/SubagentActivityCard';
import { ChatApprovalCard } from '../../../components/views/chat/ChatApprovalCard';
import { MarkdownMessage } from '../../../components/views/chat/MarkdownMessage';
import type { ChatItem } from '../../../types';
import type { ApprovalRequest } from '../../../components/views/chat/types';
import { useLabMotion, useLabReduce } from '../context';
import {
  CompareScene,
  SceneButton,
  type CompareVariant,
  type CompareView,
} from '../frame';
import {
  BellIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  CopyIcon,
  PlusIcon,
} from '../ui';
import { StopIcon, ArrowUpIcon } from './helpers';
import {
  ATTACHMENTS,
  CHAT_MODELS,
  CHAT_REPLY,
  SAMPLE_APPROVAL,
  SEED_CHAT_ITEMS,
  type ChatAttachment,
  type ChatModelId,
} from './chatData';
import { ModelPopover } from './ChatModelPopover';

export { MarkdownMessage };

export function TitleBar({ className = '', ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <header className={`titlebar titlebar--synced ${className}`.trim()} {...props}>
      <span className="titlebar__title">TitleBar</span>
    </header>
  );
}

function ChatPane({
  mode,
  messages,
  streamingId,
  draft,
  attachments,
  copied,
  model,
  quotaOpen,
  approval,
  approvalState,
  onDraft,
  onSend,
  onStop,
  onAttach,
  onRemoveAttachment,
  onCopy,
  onModel,
  onToggleQuota,
  onCloseQuota,
  onApprove,
  onDeny,
}: {
  mode: CompareVariant;
  messages: ChatItem[];
  streamingId: string | null;
  draft: string;
  attachments: ChatAttachment[];
  copied: boolean;
  model: ChatModelId;
  quotaOpen: boolean;
  approval: ApprovalRequest | null;
  approvalState: 'pending' | 'approved' | 'denied';
  onDraft: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onAttach: () => void;
  onRemoveAttachment: (id: string) => void;
  onCopy: () => void;
  onModel: (next: ChatModelId) => void;
  onToggleQuota: () => void;
  onCloseQuota: () => void;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [liveSec, setLiveSec] = useState(2.3);
  const sending = streamingId !== null;
  const activeModel = CHAT_MODELS.find((item) => item.id === model) ?? CHAT_MODELS[0];

  useEffect(() => {
    if (!sending) return;
    const timer = window.setInterval(() => {
      setLiveSec((s) => +(s + 0.1).toFixed(1));
    }, 150);
    return () => window.clearInterval(timer);
  }, [sending]);

  useEffect(() => {
    const node = transcriptRef.current;
    if (!node) return;
    const scroll = () => {
      if (atBottomRef.current) node.scrollTop = node.scrollHeight;
    };
    scroll();
    const first = window.setTimeout(scroll, 120);
    const second = window.setTimeout(scroll, 320);
    return () => {
      window.clearTimeout(first);
      window.clearTimeout(second);
    };
  }, [messages, streamingId]);

  const handleScroll = () => {
    const node = transcriptRef.current;
    if (!node) return;
    const next = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
    atBottomRef.current = next;
    setAtBottom(next);
  };

  const scrollToBottom = () => {
    const node = transcriptRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
  };

  const transcriptRows = groupTranscriptRows(messages);
  const thinkingDuration = sending ? `${liveSec}s` : '1.8s';
  const reasoningItem = messages.find((m) => m.kind === 'reasoning');
  const headlineExtracted = liveThoughtLine(reasoningItem?.text);
  const thinkingHeadline = sending
    ? 'Generando respuesta y sincronizando estado…'
    : headlineExtracted || 'Pensamiento: Analizando dependencias de TitleBar y audio…';

  return (
    <div className={`cmp-chat p6-mode p6-mode--${mode}`}>
      <header className="cmp-chat__head">
        <div className="cmp-chat__title">
          <strong>Refactor del transcript</strong>
          <span>agent · feat/motion</span>
        </div>
        <div className="cmp-chat__head-actions">
          <SceneButton
            mode={mode}
            variant="icon"
            onClick={onCopy}
            aria-label={copied ? 'Transcript copiado' : 'Copiar transcript'}
          >
            {mode === 'animate' ? (
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={copied ? 'check' : 'copy'}
                  className="p6-icon-swap"
                  initial={{
                    opacity: 0,
                    scale: reduce ? 1 : motionTokens.scale.icon,
                    filter: motionTokens.blur.icon,
                  }}
                  animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                  exit={{
                    opacity: 0,
                    scale: reduce ? 1 : motionTokens.scale.icon,
                    filter: motionTokens.blur.icon,
                    transition: motionTokens.tweens.swap,
                  }}
                  transition={motionTokens.springs.pop}
                >
                  {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                </motion.span>
              </AnimatePresence>
            ) : copied ? (
              <CheckIcon size={13} />
            ) : (
              <CopyIcon size={13} />
            )}
          </SceneButton>
          <div className="cmp-anchor">
            <SceneButton
              mode={mode}
              variant="ghost"
              className="cmp-chip"
              onClick={onToggleQuota}
              aria-expanded={quotaOpen}
              aria-haspopup="dialog"
            >
              {activeModel.label}
              <ChevronDownIcon size={11} />
            </SceneButton>
            <ModelPopover
              mode={mode}
              open={quotaOpen}
              model={model}
              onModel={onModel}
              onClose={onCloseQuota}
            />
          </div>
          <SceneButton mode={mode} variant="icon" aria-label="Notificaciones">
            <BellIcon size={14} />
          </SceneButton>
        </div>
      </header>

      <div
        className="cmp-chat__transcript chat-transcript"
        ref={transcriptRef}
        onScroll={handleScroll}
        aria-live="polite"
      >
        <div className="chat-transcript__column">
          {transcriptRows.map((row) => {
            if (row.kind === 'work') {
              return (
                <Fragment key={row.id}>
                  <ChatWorkGroup items={row.items} running={sending} />
                  {approval && (
                    <div className="cmp-approval-slot">
                      {approvalState === 'pending' ? (
                        <ChatApprovalCard
                          approval={approval}
                          allowLabel="Aprobar"
                          denyLabel="Rechazar"
                          onDecision={(decision) => {
                            if (decision === 'allowOnce' || decision === 'allowForSession') {
                              onApprove(approval.id);
                            } else {
                              onDeny(approval.id);
                            }
                          }}
                        />
                      ) : (
                        <div
                          className={`p6-approval__stamp-card p6-approval__stamp-card--${approvalState}`}
                        >
                          <strong>
                            {approvalState === 'approved' ? '✓ Aprobado' : '✕ Rechazado'}
                          </strong>
                          <span>{approval.title}</span>
                        </div>
                      )}
                    </div>
                  )}
                </Fragment>
              );
            }

            if (row.kind === 'subagentGroup') {
              return <SubagentGroupRow key={row.id} items={row.items} />;
            }

            return (
              <ChatItemRow
                key={row.item.id}
                item={row.item}
                enter={row.item.id === streamingId}
                onEditUserMessage={(text) => onDraft(text)}
              />
            );
          })}
        </div>
      </div>

      {mode === 'animate' ? (
        <AnimatePresence>
          {!atBottom && (
            <motion.button
              type="button"
              className="p6-live-edge"
              onClick={scrollToBottom}
              initial={{ opacity: 0, y: reduce ? 0 : 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reduce ? 0 : 4, transition: motionTokens.tweens.dismiss }}
              transition={motionTokens.tweens.fade}
            >
              Ir al final
            </motion.button>
          )}
        </AnimatePresence>
      ) : (
        !atBottom && (
          <button type="button" className="p6-live-edge motion-row-in" onClick={scrollToBottom}>
            Ir al final
          </button>
        )
      )}

      {/* Persistent Cognitive Thinking Bar docked directly above composer */}
      <div className="cmp-thinking-bar chat-thinking-bar">
        <div className="chat-thinking-bar__lead">
          <ThinkingOrb state={sending ? 'weaving' : 'solving'} size={20} color="#38bdf8" />
          <span className="chat-thinking-bar__timer">{thinkingDuration}</span>
          <strong className="chat-thinking-bar__headline">{thinkingHeadline}</strong>
        </div>
        <button
          type="button"
          className="chat-thinking-bar__stop secondary-button"
          onClick={onStop}
          title="Detener ejecución"
          aria-label="Detener ejecución"
        >
          <StopIcon size={10} />
          <span>Detener</span>
        </button>
      </div>

      <footer className="cmp-composer">
        {/* Mode, model, and effort selector pills with 10px squircle geometry */}
        <div className="p6-composer__pills">
          <button type="button" className="p6-composer-pill">
            <span className="p6-composer-pill__dot" />
            <span>Modo: Build</span>
          </button>
          <button type="button" className="p6-composer-pill" onClick={onToggleQuota}>
            <span>{activeModel.label}</span>
            <ChevronDownIcon size={10} />
          </button>
          <button type="button" className="p6-composer-pill">
            <span>Esfuerzo: Alto</span>
          </button>
        </div>

        <div className="p6-composer__row">
          <button
            type="button"
            className="chat-composer__attach p6-attach-circle"
            onClick={onAttach}
            disabled={attachments.length >= ATTACHMENTS.length}
            aria-label="Adjuntar archivo"
            title="Adjuntar archivo"
          >
            <PlusIcon size={14} />
          </button>

          <input
            className="cmp-composer__input"
            value={draft}
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            }}
            placeholder="Pedile algo a Kite…"
            aria-label="Mensaje para el agente"
          />

          {sending ? (
            <button
              type="button"
              aria-label="Detener generación"
              title="Detener ejecución"
              className="chat-composer__stop p6-send-prism p6-stop-circle"
              onClick={onStop}
            >
              <StopIcon size={10} />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Enviar mensaje"
              title="Enviar prompt (Enter)"
              disabled={!draft.trim() && attachments.length === 0}
              className="chat-composer__send p6-send-prism"
              onClick={onSend}
            >
              <ArrowUpIcon size={16} />
            </button>
          )}
        </div>

        {attachments.length > 0 && (
          <div className="p6-composer__files">
            {attachments.map((file) => (
              <span key={file.id} className="p6-attach">
                {file.name}
                <button
                  type="button"
                  className="p6-attach__x"
                  onClick={() => onRemoveAttachment(file.id)}
                  aria-label={`Quitar ${file.name}`}
                >
                  <CloseIcon size={9} />
                </button>
              </span>
            ))}
          </div>
        )}
      </footer>
    </div>
  );
}

export function ChatScene({ view }: { view: CompareView }) {
  const [messages, setMessages] = useState<ChatItem[]>(SEED_CHAT_ITEMS);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [quotaOpen, setQuotaOpen] = useState(false);
  const [model, setModel] = useState<ChatModelId>('opus');
  const [copied, setCopied] = useState(false);
  const [approval, _setApproval] = useState<ApprovalRequest | null>(SAMPLE_APPROVAL);
  const [approvalState, setApprovalState] = useState<'pending' | 'approved' | 'denied'>('pending');
  const sequence = useRef(SEED_CHAT_ITEMS.length + 10);
  const streamTimers = useRef<number[]>([]);
  const uiTimers = useRef<number[]>([]);

  useEffect(
    () => () => {
      streamTimers.current.forEach((id) => window.clearTimeout(id));
      uiTimers.current.forEach((id) => window.clearTimeout(id));
    },
    []
  );

  const nextId = () => {
    sequence.current += 1;
    return `m${sequence.current}`;
  };

  const clearStreamTimers = () => {
    streamTimers.current.forEach((id) => window.clearTimeout(id));
    streamTimers.current = [];
  };

  const startStream = (replyId: string) => {
    const words = CHAT_REPLY.split(' ');
    let index = 0;
    const tick = () => {
      index += 1;
      setMessages((prev) =>
        prev.map((message) =>
          message.id === replyId ? { ...message, text: words.slice(0, index).join(' ') } : message
        )
      );
      if (index < words.length) {
        streamTimers.current.push(window.setTimeout(tick, 45));
        return;
      }
      setStreamingId(null);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === replyId ? { ...m, streaming: false, status: 'completed' } : m
        )
      );
    };
    streamTimers.current.push(window.setTimeout(tick, 140));
  };

  const send = () => {
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    const userId = nextId();
    const replyId = nextId();
    setMessages((prev) => [
      ...prev,
      {
        id: userId,
        kind: 'user',
        text: text || 'Revisá estos archivos.',
        title: null,
        detail: null,
        status: 'completed',
        streaming: false,
        exitCode: null,
        createdAtUnixMs: Date.now(),
        attachments: attachments.map((a) => ({ displayName: a.name, byteSize: 14540 })),
      },
      {
        id: replyId,
        kind: 'assistant',
        text: '',
        title: null,
        detail: null,
        status: 'inProgress',
        streaming: true,
        exitCode: null,
        createdAtUnixMs: Date.now(),
        attachments: [],
      },
    ]);
    setDraft('');
    setAttachments([]);
    setStreamingId(replyId);
    startStream(replyId);
  };

  const stop = () => {
    clearStreamTimers();
    setMessages((prev) =>
      prev.map((message) => {
        if (message.id === streamingId) {
          return {
            ...message,
            text: message.text || 'Detenido antes de responder.',
            streaming: false,
            status: 'completed',
          };
        }
        return message;
      })
    );
    setStreamingId(null);
  };

  const attach = () => {
    const next = ATTACHMENTS.find(
      (item) => !attachments.some((current) => current.id === item.id)
    );
    if (!next) return;
    setAttachments((prev) => [...prev, next]);
  };

  const copy = () => {
    setCopied(true);
    uiTimers.current.push(window.setTimeout(() => setCopied(false), 1400));
  };

  const approve = (_id: string) => {
    setApprovalState('approved');
  };

  const deny = (_id: string) => {
    setApprovalState('denied');
  };

  return (
    <CompareScene
      index="01"
      title="Chat completo"
      target="ChatView · SingleThreadPane"
      note="Misma conversación y mismo estado en las dos columnas con componentes reales de Kite: ChatItemRow, ChatWorkGroup, ChatApprovalCard, ThinkingOrb y MarkdownMessage."
      view={view}
    >
      {(mode) => (
        <ChatPane
          mode={mode}
          messages={messages}
          streamingId={streamingId}
          draft={draft}
          attachments={attachments}
          copied={copied}
          model={model}
          quotaOpen={quotaOpen}
          approval={approval}
          approvalState={approvalState}
          onDraft={setDraft}
          onSend={send}
          onStop={stop}
          onAttach={attach}
          onRemoveAttachment={(id) =>
            setAttachments((prev) => prev.filter((item) => item.id !== id))
          }
          onCopy={copy}
          onModel={setModel}
          onToggleQuota={() => setQuotaOpen((value) => !value)}
          onCloseQuota={() => setQuotaOpen(false)}
          onApprove={approve}
          onDeny={deny}
        />
      )}
    </CompareScene>
  );
}
