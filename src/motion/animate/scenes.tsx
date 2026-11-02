import { Fragment, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import '../../components/views/chat.css';
import '../../components/views/settings.css';
import { ThinkingOrb } from 'thinking-orbs';
import {
  ChatItemRow,
  ChatWorkGroup,
  groupTranscriptRows,
  liveThoughtLine,
} from '../../components/views/chat/ChatItemRow';
import { ChatApprovalCard } from '../../components/views/chat/ChatApprovalCard';
import { MarkdownMessage } from '../../components/views/chat/MarkdownMessage';
import { ZedHeroCard } from '../../components/views/settings/zed/ZedHeroCard';
import {
  DEFAULT_OPERATOR_CONFIG,
  DEFAULT_ZED_PERSONA,
  type OperatorConfig,
  type OperatorProviderId,
} from '../../lib/operator/operatorConfig';
import type { ChatItem } from '../../types';
import type { ApprovalRequest } from '../../components/views/chat/types';
import { usePresence } from '../usePresence';
import { motionSurfaceClass } from '../surface';
import { useLabMotion, useLabReduce } from './context';
import {
  CompareScene,
  SceneButton,
  type CompareVariant,
  type CompareView,
} from './frame';
import {
  BellIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  CopyIcon,
  MoreIcon,
  PlusIcon,
  SwapLabel,
} from './ui';

/* -------------------------------------------------------------------------- */
/* Local icons (the shared ui.tsx is owned by the lab shell)                   */
/* -------------------------------------------------------------------------- */

interface LocalIconProps {
  size?: number;
  className?: string;
}

function localIconProps(size: number, className?: string) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true,
  };
}

function SearchIcon({ size = 14, className }: LocalIconProps) {
  return (
    <svg {...localIconProps(size, className)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function SidebarIcon({ size = 14, className }: LocalIconProps) {
  return (
    <svg {...localIconProps(size, className)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      <path d="m14 10 2 2-2 2" />
    </svg>
  );
}

function TerminalIcon({ size = 14, className }: LocalIconProps) {
  return (
    <svg {...localIconProps(size, className)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3" />
      <path d="M13 15h4" />
    </svg>
  );
}

function StopIcon({ size = 14, className }: LocalIconProps) {
  return (
    <svg {...localIconProps(size, className)}>
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ArrowUpIcon({ size = 16, className }: LocalIconProps) {
  return (
    <svg {...localIconProps(size, className)}>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

function ChevronRightIcon({ size = 14, className }: LocalIconProps) {
  return (
    <svg {...localIconProps(size, className)}>
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Scene 1 — Chat pane                                                         */
/* -------------------------------------------------------------------------- */

export { MarkdownMessage };

interface ChatAttachment {
  id: string;
  name: string;
}

const ATTACHMENTS: ChatAttachment[] = [
  { id: 'a1', name: 'TitleBar.tsx' },
  { id: 'a2', name: 'RightDock.tsx' },
  { id: 'a3', name: 'chat.css' },
];

const CHAT_MODELS = [
  { id: 'opus', label: 'Kite 2 · Opus', detail: 'razonamiento largo', quota: 72 },
  { id: 'sonnet', label: 'Kite 2 · Sonnet', detail: 'equilibrado', quota: 45 },
  { id: 'haiku', label: 'Kite 2 · Haiku', detail: 'rápido', quota: 88 },
] as const;

type ChatModelId = (typeof CHAT_MODELS)[number]['id'];

const CHAT_REPLY =
  'Listo: leo el archivo, ajusto el borde vivo y te dejo el diff en el dock.';

const SAMPLE_APPROVAL: ApprovalRequest = {
  id: 'appr-titlebar',
  toolName: 'write',
  title: 'Escribir en src/components/TitleBar.tsx',
  detail: `--- a/src/components/TitleBar.tsx
+++ b/src/components/TitleBar.tsx
@@ -14,6 +14,8 @@
+import { DictationControl } from './DictationControl';
+import { SyncStatusBadge } from './SyncStatusBadge';`,
  risk: 'fileChange',
  impact: 'Modificará 1 archivo en el workspace actual (+18 −4 líneas).',
};

const SEED_CHAT_ITEMS: ChatItem[] = [
  {
    id: 'm1',
    kind: 'user',
    text: 'Refactoricemos TitleBar.tsx para incorporar el control de dictado y el estado de sincronización.',
    title: null,
    detail: null,
    status: 'completed',
    streaming: false,
    exitCode: null,
    createdAtUnixMs: Date.now() - 45000,
    attachments: [
      { displayName: 'src/components/TitleBar.tsx', byteSize: 14540 },
    ],
  },
  {
    id: 'm2',
    kind: 'reasoning',
    text: '**Analizando dependencias de TitleBar y el hook useDictation**\n\nRevisando TitleBar.tsx para integrar el control de dictado por voz y el badge de estado sin alterar el layout existente en modo ventana y pantalla completa.',
    title: null,
    detail: null,
    status: 'completed',
    streaming: true,
    exitCode: null,
    durationSeconds: 1.8,
    createdAtUnixMs: Date.now() - 40000,
    attachments: [],
  },
  {
    id: 'm3a',
    kind: 'tool',
    title: 'cat src/components/TitleBar.tsx',
    detail: 'src/components/TitleBar.tsx · 412 líneas',
    toolName: 'cat',
    toolKind: 'fileChange',
    status: 'completed',
    streaming: false,
    exitCode: 0,
    durationSeconds: 0.4,
    createdAtUnixMs: Date.now() - 35000,
    attachments: [],
    text: 'export function TitleBar() {\n  return <header className="titlebar">TitleBar</header>;\n}',
  },
  {
    id: 'm3b',
    kind: 'command',
    title: 'npm test -- --filter=TitleBar · Exit 0',
    command: 'npm test -- --filter=TitleBar',
    detail: 'npm test -- --filter=TitleBar · Exit 0',
    toolName: 'npm',
    toolKind: 'commandExecution',
    status: 'completed',
    streaming: false,
    exitCode: 0,
    durationSeconds: 1.2,
    createdAtUnixMs: Date.now() - 30000,
    attachments: [],
    text: 'PASS src/components/TitleBar.test.tsx (4 tests)\n  ✓ TitleBar mounts with window controls\n  ✓ Dictation trigger toggles audio recording\n  ✓ SyncStatus reflects workspace state\nTests: 4 passed, 4 total',
  },
  {
    id: 'm3c',
    kind: 'tool',
    title: 'Edit src/components/TitleBar.tsx',
    detail: 'src/components/TitleBar.tsx · +18 −4',
    toolName: 'edit',
    toolKind: 'fileChange',
    status: 'completed',
    streaming: false,
    exitCode: 0,
    addedLines: 18,
    removedLines: 4,
    durationSeconds: 0.8,
    createdAtUnixMs: Date.now() - 25000,
    attachments: [],
    text: `--- a/src/components/TitleBar.tsx
+++ b/src/components/TitleBar.tsx
@@ -14,6 +14,8 @@
 import { ZedOrb } from './ZedOrb';
+import { DictationControl } from './DictationControl';
+import { SyncStatusBadge } from './SyncStatusBadge';

 export function TitleBar() {
-  return <header className="titlebar" />;
+  return (
+    <header className="titlebar titlebar--synced">
+      <DictationControl />
+      <SyncStatusBadge />
     </header>
   );
 }`,
  },
  {
    id: 'm4',
    kind: 'assistant',
    text: `He completado el refactor de \`TitleBar.tsx\`. Los cambios aplicados son:

- **DictationControl**: Añadido con soporte para streaming de voz y feedback táctil.
- **SyncStatusBadge**: Indicador de sincronización en tiempo real con animación de pulso.

\`\`\`tsx
export function TitleBar() {
  return (
    <header className="titlebar titlebar--synced">
      <DictationControl />
      <SyncStatusBadge />
    </header>
  );
}
\`\`\`

Todos los tests unitarios pasaron exitosamente (\`4 passed\`). ¿Querés que ejecute el build de producción?`,
    title: null,
    detail: null,
    status: 'completed',
    streaming: false,
    exitCode: null,
    createdAtUnixMs: Date.now() - 5000,
    attachments: [],
  },
];

function ModelContent({
  mode,
  model,
  onModel,
  onClose,
}: {
  mode: CompareVariant;
  model: ChatModelId;
  onModel: (next: ChatModelId) => void;
  onClose: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const active = CHAT_MODELS.find((item) => item.id === model) ?? CHAT_MODELS[0];

  return (
    <>
      <div className="cmp-popover__head">
        <strong>Modelo y cuota</strong>
        <SceneButton mode={mode} variant="icon" onClick={onClose} aria-label="Cerrar cuota">
          <CloseIcon size={12} />
        </SceneButton>
      </div>
      {mode === 'animate' ? (
        <motion.div
          className="p6-models"
          role="radiogroup"
          aria-label="Modelo"
          initial="hidden"
          animate="show"
          variants={{ show: { transition: { staggerChildren: motionTokens.stagger } } }}
        >
          {CHAT_MODELS.map((item) => {
            const selected = item.id === model;
            return (
              <motion.button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`p6-model${selected ? ' is-active' : ''}`}
                onClick={() => onModel(item.id)}
                variants={{
                  hidden: {
                    opacity: 0,
                    y: reduce ? 0 : motionTokens.travel(4),
                    filter: motionTokens.itemBlur,
                  },
                  show: {
                    opacity: 1,
                    y: 0,
                    filter: 'blur(0px)',
                    transition: motionTokens.tweens.reveal,
                  },
                }}
              >
                {selected && (
                  <motion.span
                    layoutId="cmp-chat-model"
                    className="p6-model__indicator"
                    initial={false}
                    transition={motionTokens.springs.highlight}
                  />
                )}
                <span className="p6-model__text">
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </span>
                <span className="p6-model__quota">{item.quota}%</span>
              </motion.button>
            );
          })}
        </motion.div>
      ) : (
        <div className="p6-models" role="radiogroup" aria-label="Modelo">
          {CHAT_MODELS.map((item) => {
            const selected = item.id === model;
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`p6-model${selected ? ' is-active' : ''}`}
                onClick={() => onModel(item.id)}
              >
                <span className="p6-model__text">
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </span>
                <span className="p6-model__quota">{item.quota}%</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="p6-quota">
        <span>Cuota restante</span>
        <strong>{active.quota}%</strong>
      </div>
      <div className="cmp-meter cmp-meter--sm p6-quota-meter">
        {mode === 'animate' ? (
          <motion.div
            key={active.id}
            className="cmp-meter__fill p6-quota-meter__fill"
            style={{ width: `${active.quota}%` }}
            initial={{ x: reduce ? 0 : '-100%' }}
            animate={{ x: 0 }}
            transition={motionTokens.springs.number}
          />
        ) : (
          <div className="cmp-meter__fill" style={{ width: `${active.quota}%` }} />
        )}
      </div>
      <p className="cmp-muted">Se renueva el 1 de cada mes.</p>
    </>
  );
}

function ModelPopover({
  mode,
  open,
  model,
  onModel,
  onClose,
}: {
  mode: CompareVariant;
  open: boolean;
  model: ChatModelId;
  onModel: (next: ChatModelId) => void;
  onClose: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div className={`cmp-popover ${motionSurfaceClass(presence.phase, 'popover')}`}>
        <ModelContent mode={mode} model={model} onModel={onModel} onClose={onClose} />
      </div>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="cmp-popover"
          initial={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.popover,
            y: reduce ? 0 : -motionTokens.travel(4),
            filter: motionTokens.surfaceBlur,
          }}
          animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
          exit={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.popover,
            y: reduce ? 0 : -motionTokens.travel(4),
            filter: motionTokens.surfaceBlur,
            transition: motionTokens.tweens.dismiss,
          }}
          transition={motionTokens.springs.pop}
          style={{ transformOrigin: 'top right' }}
        >
          <ModelContent mode={mode} model={model} onModel={onModel} onClose={onClose} />
        </motion.div>
      )}
    </AnimatePresence>
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

/* -------------------------------------------------------------------------- */
/* Scene 2 — Settings card                                                     */
/* -------------------------------------------------------------------------- */

type SettingsTabId = 'general' | 'models' | 'usage';
type ApprovalMode = 'ask' | 'auto' | 'never';
type LanguageId = 'es' | 'en' | 'pt';
type ModelId = 'opus' | 'sonnet' | 'haiku';

interface SettingsValues {
  streaming: boolean;
  remember: boolean;
  approval: ApprovalMode;
  language: LanguageId;
  model: ModelId;
  temperature: number;
  workspace: string;
}

interface SettingsHandlers {
  onStreaming: () => void;
  onRemember: () => void;
  onApproval: (next: ApprovalMode) => void;
  onLanguage: (next: LanguageId) => void;
  onModel: (next: ModelId) => void;
  onTemperature: (next: number) => void;
  onWorkspace: (next: string) => void;
  onTouchWorkspace: () => void;
}

const DEFAULT_SETTINGS: SettingsValues = {
  streaming: true,
  remember: false,
  approval: 'ask',
  language: 'es',
  model: 'opus',
  temperature: 40,
  workspace: 'kite-motion',
};

const SETTINGS_TABS: { id: SettingsTabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'models', label: 'Modelos' },
  { id: 'usage', label: 'Consumo' },
];

const SETTINGS_SECTIONS = [
  {
    id: 'context',
    title: 'Contexto del agente',
    body: 'Cuando el hilo crece, Kite resume las últimas herramientas y conserva el borde vivo.',
  },
  {
    id: 'permissions',
    title: 'Permisos y aprobaciones',
    body: 'Las escrituras piden aprobación; las lecturas pasan sin interrumpir.',
  },
];

const APPROVAL_OPTIONS: { id: ApprovalMode; label: string }[] = [
  { id: 'ask', label: 'Preguntar' },
  { id: 'auto', label: 'Automático' },
  { id: 'never', label: 'Nunca' },
];

const APPROVAL_LABELS: Record<ApprovalMode, string> = {
  ask: 'Preguntar',
  auto: 'Automático',
  never: 'Nunca',
};

const LANGUAGE_OPTIONS = [
  { id: 'es', label: 'Español' },
  { id: 'en', label: 'English' },
  { id: 'pt', label: 'Português' },
];

const MODEL_OPTIONS = [
  { id: 'opus', label: 'Kite 2 · Opus' },
  { id: 'sonnet', label: 'Kite 2 · Sonnet' },
  { id: 'haiku', label: 'Kite 2 · Haiku' },
];

function workspaceError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'El nombre no puede estar vacío.';
  if (trimmed.length < 3) return 'Usá al menos 3 caracteres.';
  if (trimmed.length > 24) return 'Máximo 24 caracteres.';
  return null;
}

function SettingsSlider({
  mode,
  value,
  onChange,
}: {
  mode: CompareVariant;
  value: number;
  onChange: (next: number) => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();

  return (
    <div className="p6-slider">
      <div className="p6-slider__track" aria-hidden="true">
        {mode === 'animate' ? (
          <motion.div
            className="p6-slider__fill"
            initial={false}
            animate={{ scaleX: value / 100 }}
            transition={reduce ? motionTokens.tweens.instant : motionTokens.springs.thumb}
            style={{ transformOrigin: 'left center' }}
          />
        ) : (
          <div className="p6-slider__fill p6-slider__fill--css" style={{ width: `${value}%` }} />
        )}
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={value}
        className="p6-slider__input"
        aria-label="Creatividad"
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <strong className="p6-slider__value">{value}%</strong>
    </div>
  );
}

function ResetDialog({
  mode,
  open,
  onClose,
  onConfirm,
}: {
  mode: CompareVariant;
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);

  const body = (
    <>
      <div className="cmp-modal__head">
        <strong>¿Restablecer los ajustes?</strong>
        <SceneButton mode={mode} variant="icon" onClick={onClose} aria-label="Cerrar confirmación">
          <CloseIcon size={12} />
        </SceneButton>
      </div>
      <p className="cmp-muted">
        Se pierden los cambios de esta sesión y vuelven los valores por defecto.
      </p>
      <div className="cmp-modal__actions">
        <SceneButton mode={mode} variant="default" className="secondary-button" onClick={onClose}>
          Cancelar
        </SceneButton>
        <SceneButton mode={mode} variant="primary" className="primary-button" onClick={onConfirm}>
          Restablecer
        </SceneButton>
      </div>
    </>
  );

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div className="cmp-modal-layer p6-reset">
        <div
          className={`cmp-scrim ${motionSurfaceClass(presence.phase, 'scrim')}`}
          onClick={onClose}
          aria-hidden="true"
        />
        <div
          className={`cmp-modal ${motionSurfaceClass(presence.phase, 'modal')}`}
          role="dialog"
          aria-modal="true"
          aria-label="Restablecer ajustes"
        >
          {body}
        </div>
      </div>
    );
  }

  return (
    <div className="cmp-modal-layer p6-reset">
      <AnimatePresence>
        {open && (
          <motion.div
            className="cmp-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: motionTokens.tweens.overlay }}
            exit={{ opacity: 0, transition: motionTokens.tweens.overlay }}
            onClick={onClose}
            aria-hidden="true"
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {open && (
          <motion.div
            className="cmp-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Restablecer ajustes"
            initial={{
              opacity: 0,
              scale: reduce ? 1 : motionTokens.scale.dialog,
              y: reduce ? 0 : motionTokens.travel(6),
            }}
            animate={{
              opacity: 1,
              scale: 1,
              y: 0,
              transition: reduce ? motionTokens.tweens.fade : motionTokens.springs.dialog,
            }}
            exit={{
              opacity: 0,
              scale: reduce ? 1 : motionTokens.scale.dialog,
              y: reduce ? 0 : motionTokens.travel(6),
              transition: motionTokens.tweens.dismiss,
            }}
          >
            {body}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SettingsBody({
  mode,
  tab,
  values,
  handlers,
  openSection,
  onToggleSection,
  workspaceInvalid,
  workspaceTouched,
  operatorConfig,
  testingProvider,
  savedToast,
  onRunProbe,
}: {
  mode: CompareVariant;
  tab: SettingsTabId;
  values: SettingsValues;
  handlers: SettingsHandlers;
  openSection: string | null;
  onToggleSection: (id: string) => void;
  workspaceInvalid: string | null;
  workspaceTouched: boolean;
  operatorConfig: OperatorConfig;
  testingProvider: OperatorProviderId | null;
  savedToast: boolean;
  onRunProbe: (providerId: OperatorProviderId) => void;
}) {
  const motionTokens = useLabMotion();

  if (tab === 'models') {
    return (
      <div className="ui-card">
        <div className="settings-row ui-card__row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Modelo por defecto</h3>
            <p>Se usa cuando un hilo no declara uno.</p>
          </div>
          <div className="ui-segmented" role="radiogroup" aria-label="Modelo por defecto">
            {MODEL_OPTIONS.map((opt) => {
              const selected = values.model === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-pressed={selected}
                  className="ui-segmented__item"
                  onClick={() => handlers.onModel(opt.id as ModelId)}
                >
                  {mode === 'animate' && selected && (
                    <motion.span
                      layoutId="cmp-settings-model"
                      className="ui-segmented__indicator"
                      initial={false}
                      transition={motionTokens.springs.selection}
                    />
                  )}
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="settings-row ui-card__row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Creatividad</h3>
            <p>Cuánto se permite improvisar al modelo.</p>
          </div>
          <SettingsSlider mode={mode} value={values.temperature} onChange={handlers.onTemperature} />
        </div>

        <div className="settings-row ui-card__row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Aprobaciones</h3>
            <p>Preguntar antes de escribir archivos.</p>
          </div>
          <span className="cmp-badge">{APPROVAL_LABELS[values.approval]}</span>
        </div>
      </div>
    );
  }

  if (tab === 'usage') {
    return (
      <div className="ui-card">
        <div className="settings-row ui-card__row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Tokens del mes</h3>
            <p>72% del presupuesto del workspace.</p>
          </div>
          <strong className="cmp-metric">72%</strong>
        </div>
        <div className="cmp-meter" style={{ margin: '0 20px 16px' }}>
          <div className="cmp-meter__fill" style={{ width: '72%' }} />
        </div>
        <div className="settings-row ui-card__row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Sesiones activas</h3>
            <p>Una por cada agente conectado.</p>
          </div>
          <strong className="cmp-metric">18</strong>
        </div>
      </div>
    );
  }

  return (
    <div className="cmp-settings__rows" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* REAL ZedHeroCard with 64px ZedOrb, BorderBeam, and MetalFx latency probe */}
      <ZedHeroCard
        persona={operatorConfig.persona ?? DEFAULT_ZED_PERSONA}
        config={operatorConfig}
        savedToast={savedToast}
        testingProvider={testingProvider}
        onRunProbe={onRunProbe}
      />

      {/* Real settings group using .ui-card, .ui-switch, .ui-segmented, and .ui-field */}
      <div className="ui-card">
        <div className="settings-row ui-card__row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Streaming en vivo</h3>
            <p>Mostrar los tokens a medida que llegan en tiempo real.</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={values.streaming}
            aria-label="Streaming en vivo"
            className="ui-switch"
            onClick={handlers.onStreaming}
          >
            <span className="ui-switch__knob" />
          </button>
        </div>

        <div className="settings-row ui-card__row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Recordar permisos</h3>
            <p>No volver a preguntar por las lecturas de esta sesión.</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={values.remember}
            aria-label="Recordar permisos"
            className="ui-switch"
            onClick={handlers.onRemember}
          >
            <span className="ui-switch__knob" />
          </button>
        </div>

        <div className="settings-row ui-card__row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Aprobaciones</h3>
            <p>Qué pasa antes de escribir un archivo o ejecutar comandos.</p>
          </div>
          <div className="ui-segmented" role="radiogroup" aria-label="Aprobaciones">
            {APPROVAL_OPTIONS.map((opt) => {
              const selected = values.approval === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-pressed={selected}
                  className="ui-segmented__item"
                  onClick={() => handlers.onApproval(opt.id)}
                >
                  {mode === 'animate' && selected && (
                    <motion.span
                      layoutId="cmp-settings-approval"
                      className="ui-segmented__indicator"
                      initial={false}
                      transition={motionTokens.springs.selection}
                    />
                  )}
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="settings-row ui-card__row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Nombre del workspace</h3>
            <p>Se muestra en el rail y en los exports.</p>
          </div>
          <div className="p6-field" style={{ minWidth: 200 }}>
            <input
              className={`ui-field p6-input${workspaceInvalid && workspaceTouched ? ' is-invalid' : ''}`}
              value={values.workspace}
              onChange={(event) => handlers.onWorkspace(event.target.value)}
              onBlur={handlers.onTouchWorkspace}
              aria-label="Nombre del workspace"
              aria-invalid={Boolean(workspaceInvalid && workspaceTouched)}
            />
            {workspaceInvalid && workspaceTouched && (
              <span className="p6-field__error">{workspaceInvalid}</span>
            )}
          </div>
        </div>

        <div className="settings-row ui-card__row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Idioma de la interfaz</h3>
            <p>Copy y mensajes del agente.</p>
          </div>
          <div className="ui-segmented" role="radiogroup" aria-label="Idioma de la interfaz">
            {LANGUAGE_OPTIONS.map((opt) => {
              const selected = values.language === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-pressed={selected}
                  className="ui-segmented__item"
                  onClick={() => handlers.onLanguage(opt.id as LanguageId)}
                >
                  {mode === 'animate' && selected && (
                    <motion.span
                      layoutId="cmp-settings-language"
                      className="ui-segmented__indicator"
                      initial={false}
                      transition={motionTokens.springs.selection}
                    />
                  )}
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="cmp-accordion">
        {SETTINGS_SECTIONS.map((section) => {
          const isOpen = openSection === section.id;
          return (
            <div key={section.id} className="cmp-accordion__item">
              <button
                type="button"
                className="cmp-accordion__trigger"
                aria-expanded={isOpen}
                onClick={() => onToggleSection(section.id)}
              >
                <span>{section.title}</span>
                {mode === 'animate' ? (
                  <motion.span
                    className="cmp-accordion__chevron"
                    animate={{ rotate: isOpen ? 180 : 0 }}
                    transition={motionTokens.tweens.disclosure}
                  >
                    <ChevronDownIcon size={13} />
                  </motion.span>
                ) : (
                  <ChevronDownIcon
                    size={13}
                    className={`cmp-accordion__chevron${isOpen ? ' is-open' : ''}`}
                  />
                )}
              </button>
              {mode === 'animate' ? (
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      key="content"
                      initial={{
                        height: 0,
                        opacity: 0,
                        filter: motionTokens.blur.disclosure,
                      }}
                      animate={{
                        height: 'auto',
                        opacity: 1,
                        filter: 'blur(0px)',
                        transitionEnd: { filter: 'none' },
                        transition: motionTokens.tweens.disclosure,
                      }}
                      exit={{
                        height: 0,
                        opacity: 0,
                        filter: motionTokens.blur.disclosure,
                        transition: motionTokens.tweens.disclosure,
                      }}
                      style={{ overflow: 'hidden' }}
                    >
                      <div className="cmp-accordion__body">{section.body}</div>
                    </motion.div>
                  )}
                </AnimatePresence>
              ) : (
                isOpen && <div className="cmp-accordion__body">{section.body}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SettingsTabBar({
  mode,
  tab,
  onSelect,
}: {
  mode: CompareVariant;
  tab: SettingsTabId;
  onSelect: (next: SettingsTabId) => void;
}) {
  const motionTokens = useLabMotion();
  return (
    <div className="cmp-tabs" role="tablist" aria-label="Ajustes del agente">
      {SETTINGS_TABS.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={tab === item.id}
          className={`cmp-tabs__tab${tab === item.id ? ' is-active' : ''}`}
          onClick={() => onSelect(item.id)}
        >
          {mode === 'animate' && tab === item.id && (
            <motion.span
              layoutId="cmp-settings-indicator"
              className="cmp-tabs__indicator"
              initial={false}
              transition={motionTokens.springs.selection}
            />
          )}
          <span className="cmp-tabs__label">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

function UnsavedBanner({
  mode,
  onSave,
  onDiscard,
}: {
  mode: CompareVariant;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();

  const inner = (
    <div className="p6-banner__inner">
      <div className="p6-banner__text">
        <strong>Tenés cambios sin guardar.</strong>
        <span>Se aplican al workspace cuando guardás.</span>
      </div>
      <div className="p6-banner__actions">
        <SceneButton mode={mode} variant="default" className="cmp-btn--sm secondary-button" onClick={onDiscard}>
          Descartar
        </SceneButton>
        <SceneButton mode={mode} variant="primary" className="cmp-btn--sm primary-button" onClick={onSave}>
          Guardar
        </SceneButton>
      </div>
    </div>
  );

  if (mode === 'kite') {
    return <div className="p6-banner motion-row-in">{inner}</div>;
  }

  return (
    <motion.div
      className="p6-banner"
      initial={{ height: 0, opacity: 0, y: reduce ? 0 : -4 }}
      animate={{ height: 'auto', opacity: 1, y: 0, transition: motionTokens.tweens.disclosure }}
      exit={{ height: 0, opacity: 0, transition: motionTokens.tweens.panelOut }}
      style={{ overflow: 'hidden' }}
    >
      {inner}
    </motion.div>
  );
}

function SettingsPane({
  mode,
  tab,
  onSelectTab,
  values,
  handlers,
  openSection,
  onToggleSection,
  save,
  dirty,
  workspaceInvalid,
  workspaceTouched,
  resetOpen,
  operatorConfig,
  testingProvider,
  savedToast,
  onRunProbe,
  onSave,
  onOpenReset,
  onCloseReset,
  onConfirmReset,
  onDiscard,
}: {
  mode: CompareVariant;
  tab: SettingsTabId;
  onSelectTab: (next: SettingsTabId) => void;
  values: SettingsValues;
  handlers: SettingsHandlers;
  openSection: string | null;
  onToggleSection: (id: string) => void;
  save: 'idle' | 'saving' | 'saved';
  dirty: boolean;
  workspaceInvalid: string | null;
  workspaceTouched: boolean;
  resetOpen: boolean;
  operatorConfig: OperatorConfig;
  testingProvider: OperatorProviderId | null;
  savedToast: boolean;
  onRunProbe: (providerId: OperatorProviderId) => void;
  onSave: () => void;
  onOpenReset: () => void;
  onCloseReset: () => void;
  onConfirmReset: () => void;
  onDiscard: () => void;
}) {
  const motionTokens = useLabMotion();
  const saveLabel =
    save === 'saving' ? 'Guardando…' : save === 'saved' ? 'Guardado' : 'Guardar cambios';

  return (
    <div className={`cmp-settings p6-mode p6-mode--${mode}`}>
      <header className="cmp-card__head">
        <div>
          <strong>Ajustes del agente</strong>
          <span>configuración local y operador</span>
        </div>
        <span className="cmp-badge">agent</span>
      </header>

      <SettingsTabBar mode={mode} tab={tab} onSelect={onSelectTab} />

      <div className="cmp-settings__panel-wrap">
        {mode === 'animate' ? (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={tab}
              className="cmp-settings__panel"
              initial={{
                opacity: 0,
                x: motionTokens.travel(motionTokens.shift.tabs),
                filter: motionTokens.blur.panel,
              }}
              animate={{
                opacity: 1,
                x: 0,
                filter: 'blur(0px)',
                transition: motionTokens.tweens.panelIn,
              }}
              exit={{
                opacity: 0,
                x: -motionTokens.travel(motionTokens.shift.tabs),
                filter: motionTokens.blur.panel,
                transition: motionTokens.tweens.panelOut,
              }}
            >
              <SettingsBody
                mode={mode}
                tab={tab}
                values={values}
                handlers={handlers}
                openSection={openSection}
                onToggleSection={onToggleSection}
                workspaceInvalid={workspaceInvalid}
                workspaceTouched={workspaceTouched}
                operatorConfig={operatorConfig}
                testingProvider={testingProvider}
                savedToast={savedToast}
                onRunProbe={onRunProbe}
              />
            </motion.div>
          </AnimatePresence>
        ) : (
          <div className="cmp-settings__panel">
            <SettingsBody
              mode={mode}
              tab={tab}
              values={values}
              handlers={handlers}
              openSection={openSection}
              onToggleSection={onToggleSection}
              workspaceInvalid={workspaceInvalid}
              workspaceTouched={workspaceTouched}
              operatorConfig={operatorConfig}
              testingProvider={testingProvider}
              savedToast={savedToast}
              onRunProbe={onRunProbe}
            />
          </div>
        )}
      </div>

      {mode === 'animate' ? (
        <AnimatePresence initial={false}>
          {dirty && save === 'idle' && (
            <UnsavedBanner
              key="banner"
              mode={mode}
              onSave={onSave}
              onDiscard={onDiscard}
            />
          )}
        </AnimatePresence>
      ) : (
        dirty && save === 'idle' && <UnsavedBanner mode={mode} onSave={onSave} onDiscard={onDiscard} />
      )}

      <footer className="cmp-card__foot">
        <SceneButton mode={mode} variant="default" className="secondary-button" onClick={onOpenReset} disabled={!dirty}>
          Restablecer
        </SceneButton>
        <SceneButton
          mode={mode}
          variant="primary"
          className="primary-button"
          onClick={onSave}
          disabled={save === 'saving' || !dirty}
        >
          {mode === 'animate' ? (
            <SwapLabel
              value={saveLabel}
              labels={['Guardar cambios', 'Guardando…', 'Guardado']}
            />
          ) : (
            saveLabel
          )}
        </SceneButton>
      </footer>

      <ResetDialog
        mode={mode}
        open={resetOpen}
        onClose={onCloseReset}
        onConfirm={onConfirmReset}
      />
    </div>
  );
}

export function SettingsScene({ view }: { view: CompareView }) {
  const [tab, setTab] = useState<SettingsTabId>('general');
  const [values, setValues] = useState<SettingsValues>(DEFAULT_SETTINGS);
  const [baseline, setBaseline] = useState<SettingsValues>(DEFAULT_SETTINGS);
  const [touched, setTouched] = useState(false);
  const [openSection, setOpenSection] = useState<string | null>(null);
  const [save, setSave] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [resetOpen, setResetOpen] = useState(false);
  const [operatorConfig, _setOperatorConfig] = useState<OperatorConfig>(DEFAULT_OPERATOR_CONFIG);
  const [testingProvider, setTestingProvider] = useState<OperatorProviderId | null>(null);
  const [savedToast, setSavedToast] = useState(false);
  const timers = useRef<number[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach((id) => window.clearTimeout(id));
    },
    []
  );

  const dirty = JSON.stringify(values) !== JSON.stringify(baseline);
  const invalidName = workspaceError(values.workspace);

  const update = <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const handlers: SettingsHandlers = {
    onStreaming: () => update('streaming', !values.streaming),
    onRemember: () => update('remember', !values.remember),
    onApproval: (next) => update('approval', next),
    onLanguage: (next) => update('language', next),
    onModel: (next) => update('model', next),
    onTemperature: (next) => update('temperature', next),
    onWorkspace: (next) => update('workspace', next),
    onTouchWorkspace: () => setTouched(true),
  };

  const handleRunProbe = (providerId: OperatorProviderId) => {
    setTestingProvider(providerId);
    timers.current.push(
      window.setTimeout(() => {
        setTestingProvider(null);
        setSavedToast(true);
        timers.current.push(window.setTimeout(() => setSavedToast(false), 2000));
      }, 1200)
    );
  };

  const saveSettings = () => {
    if (save === 'saving') return;
    if (invalidName) {
      setTouched(true);
      return;
    }
    setSave('saving');
    timers.current.push(
      window.setTimeout(() => {
        setBaseline(values);
        setSave('saved');
        timers.current.push(window.setTimeout(() => setSave('idle'), 1500));
      }, 950)
    );
  };

  const resetSettings = () => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
    setValues(DEFAULT_SETTINGS);
    setBaseline(DEFAULT_SETTINGS);
    setTouched(false);
    setSave('idle');
    setResetOpen(false);
  };

  return (
    <CompareScene
      index="02"
      title="Ajustes completos"
      target="SettingsView · AgentSettingsTab"
      note="La misma tarjeta con tabs, switch, segmented controls, fields, validación, ZedHeroCard con orbe de 64px y BorderBeam, y diálogo de reset."
      view={view}
    >
      {(mode) => (
        <SettingsPane
          mode={mode}
          tab={tab}
          onSelectTab={setTab}
          values={values}
          handlers={handlers}
          openSection={openSection}
          onToggleSection={(id) =>
            setOpenSection((current) => (current === id ? null : id))
          }
          save={save}
          dirty={dirty}
          workspaceInvalid={invalidName}
          workspaceTouched={touched}
          resetOpen={resetOpen}
          operatorConfig={operatorConfig}
          testingProvider={testingProvider}
          savedToast={savedToast}
          onRunProbe={handleRunProbe}
          onSave={saveSettings}
          onOpenReset={() => setResetOpen(true)}
          onCloseReset={() => setResetOpen(false)}
          onConfirmReset={resetSettings}
          onDiscard={() => {
            setValues(baseline);
            setTouched(false);
          }}
        />
      )}
    </CompareScene>
  );
}

/* -------------------------------------------------------------------------- */
/* Scene 3 — Workspace rail + dock + diff + terminal                           */
/* -------------------------------------------------------------------------- */

interface ThreadNode {
  id: string;
  title: string;
  detail: string;
  state: 'running' | 'idle' | 'done';
  children?: ThreadNode[];
}

const THREADS: ThreadNode[] = [
  {
    id: 't1',
    title: 'Refactor del transcript',
    detail: 'hace 2 min',
    state: 'running',
    children: [
      { id: 't1a', title: 'Subagente · borde vivo', detail: '8 s', state: 'running' },
    ],
  },
  { id: 't2', title: 'Motion contract', detail: 'hace 18 min', state: 'idle' },
  {
    id: 't3',
    title: 'Preview Animate UI',
    detail: 'ayer',
    state: 'done',
    children: [
      { id: 't3a', title: 'Skills · install', detail: 'ayer', state: 'done' },
      { id: 't3b', title: 'Tokens · port', detail: 'ayer', state: 'done' },
    ],
  },
];

const PROJECTS = ['kite-motion', 'agent-shell', 'motion-lab'];

interface DiffRow {
  type: 'ctx' | 'add' | 'del';
  no: string;
  text: string;
}

const DIFF_ROWS: DiffRow[] = [
  { type: 'ctx', no: '12', text: 'export const MOTION_ENTER_MS = 180;' },
  { type: 'del', no: '13', text: 'export const MOTION_EXIT_MS = 120;' },
  { type: 'add', no: '13', text: 'export const MOTION_EXIT_MS = 140;' },
  { type: 'ctx', no: '14', text: '' },
  { type: 'ctx', no: '15', text: 'export function prefersReducedMotion() {' },
  { type: 'del', no: '16', text: '  return false;' },
  { type: 'add', no: '16', text: "  return document.documentElement.dataset.motion === 'reduce';" },
  { type: 'ctx', no: '17', text: '}' },
];

interface TerminalLine {
  id: string;
  tone: 'cmd' | 'out' | 'ok';
  text: string;
}

const SEED_TERMINAL: TerminalLine[] = [
  { id: 'l1', tone: 'cmd', text: '$ npm run test -- motion' },
  { id: 'l2', tone: 'out', text: 'vitest run · 14 archivos' },
  { id: 'l3', tone: 'ok', text: '✓ 42 tests passed' },
];

function ProjectSubmenu({
  mode,
  open,
  onMoveTo,
}: {
  mode: CompareVariant;
  open: boolean;
  onMoveTo: (project: string) => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);

  const rows = (
    <>
      {PROJECTS.map((project) => (
        <button
          key={project}
          type="button"
          role="menuitem"
          className="cmp-menu__item"
          onClick={() => onMoveTo(project)}
        >
          <span className="cmp-menu__label">Proyecto · {project}</span>
        </button>
      ))}
    </>
  );

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div
        className={`cmp-menu p6-ws__submenu ${motionSurfaceClass(presence.phase, 'panel-left')}`}
        role="menu"
        aria-label="Mover a proyecto"
      >
        {rows}
      </div>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="cmp-menu p6-ws__submenu"
          role="menu"
          aria-label="Mover a proyecto"
          initial={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.menu,
            x: reduce ? 0 : -motionTokens.travel(4),
          }}
          animate={{
            opacity: 1,
            scale: 1,
            x: 0,
            transition: reduce ? motionTokens.tweens.fade : motionTokens.tweens.menu,
          }}
          exit={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.menu,
            x: reduce ? 0 : -motionTokens.travel(4),
            transition: motionTokens.tweens.dismiss,
          }}
          style={{ transformOrigin: 'left top' }}
        >
          {rows}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ThreadMenu({
  mode,
  open,
  onClose,
  submenuOpen,
  onSubmenu,
  onSelect,
  onMoveTo,
}: {
  mode: CompareVariant;
  open: boolean;
  onClose: () => void;
  submenuOpen: boolean;
  onSubmenu: (next: boolean) => void;
  onSelect: () => void;
  onMoveTo: (project: string) => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);
  const [hovered, setHovered] = useState<string | null>(null);

  const highlight = (id: string) =>
    mode === 'animate' && hovered === id ? (
      <motion.span
        layoutId="cmp-thread-highlight"
        className="cmp-menu__highlight"
        initial={false}
        transition={motionTokens.springs.highlight}
      />
    ) : null;

  const leave = () => {
    setHovered(null);
    onSubmenu(false);
  };

  const rows = (
    <>
      <button
        type="button"
        role="menuitem"
        className="cmp-menu__item"
        onPointerEnter={() => setHovered('open')}
        onFocus={() => setHovered('open')}
        onBlur={() => setHovered(null)}
        onClick={onSelect}
      >
        {highlight('open')}
        <span className="cmp-menu__label">Abrir hilo</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className={`cmp-menu__item p6-ws__menu-row${submenuOpen ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={submenuOpen}
        onPointerEnter={() => {
          setHovered('move');
          onSubmenu(true);
        }}
        onFocus={() => {
          setHovered('move');
          onSubmenu(true);
        }}
        onBlur={() => setHovered(null)}
        onClick={() => onSubmenu(true)}
      >
        {highlight('move')}
        <span className="cmp-menu__label">
          Mover a
          <ChevronRightIcon size={10} />
        </span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="cmp-menu__item"
        onPointerEnter={() => setHovered('rename')}
        onFocus={() => setHovered('rename')}
        onBlur={() => setHovered(null)}
        onClick={onClose}
      >
        {highlight('rename')}
        <span className="cmp-menu__label">Renombrar</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="cmp-menu__item cmp-menu__item--danger"
        onPointerEnter={() => setHovered('archive')}
        onFocus={() => setHovered('archive')}
        onBlur={() => setHovered(null)}
        onClick={onClose}
      >
        {highlight('archive')}
        <span className="cmp-menu__label">Archivar</span>
      </button>
      <ProjectSubmenu mode={mode} open={submenuOpen} onMoveTo={onMoveTo} />
    </>
  );

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div
        className={`cmp-menu ${motionSurfaceClass(presence.phase, 'popover')}`}
        role="menu"
        aria-label="Opciones del hilo"
        onPointerLeave={leave}
      >
        {rows}
      </div>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="cmp-menu"
          role="menu"
          aria-label="Opciones del hilo"
          initial={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.menu,
            y: reduce ? 0 : -motionTokens.travel(4),
          }}
          animate={{
            opacity: 1,
            scale: 1,
            y: 0,
            transition: reduce ? motionTokens.tweens.fade : motionTokens.tweens.menu,
          }}
          exit={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.menu,
            y: reduce ? 0 : -motionTokens.travel(4),
            transition: motionTokens.tweens.dismiss,
          }}
          style={{ transformOrigin: 'top right' }}
          onPointerLeave={leave}
        >
          {rows}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Dock({
  mode,
  open,
  onClose,
  onShowDiff,
}: {
  mode: CompareVariant;
  open: boolean;
  onClose: () => void;
  onShowDiff: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);

  const content = (
    <>
      <div className="cmp-dock__head">
        <strong>Cambios</strong>
        <SceneButton mode={mode} variant="icon" onClick={onClose} aria-label="Cerrar dock">
          <CloseIcon size={12} />
        </SceneButton>
      </div>
      <div className="cmp-dock__files">
        <div>
          <span>src/motion/contract.ts</span>
          <em>+14</em>
        </div>
        <div>
          <span>src/App.tsx</span>
          <em>+3 −1</em>
        </div>
        <div>
          <span>src/App.css</span>
          <em>−2</em>
        </div>
      </div>
      <p className="cmp-muted">El dock se desplaza con transform; el ancho no se anima.</p>
      <div className="p6-dock__actions">
        <SceneButton mode={mode} className="cmp-btn--sm" onClick={onShowDiff}>
          Ver diff
        </SceneButton>
      </div>
    </>
  );

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <>
        <div
          className={`cmp-scrim ${motionSurfaceClass(presence.phase, 'scrim')}`}
          onClick={onClose}
          aria-hidden="true"
        />
        <aside className={`cmp-dock ${motionSurfaceClass(presence.phase, 'panel')}`}>{content}</aside>
      </>
    );
  }

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            className="cmp-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: motionTokens.tweens.overlay }}
            exit={{ opacity: 0, transition: motionTokens.tweens.overlay }}
            onClick={onClose}
            aria-hidden="true"
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {open && (
          <motion.aside
            className="cmp-dock"
            initial={{ x: reduce ? 0 : '100%', opacity: 0 }}
            animate={{
              x: 0,
              opacity: 1,
              transition: reduce ? motionTokens.tweens.fade : motionTokens.tweens.sheet,
            }}
            exit={{
              x: reduce ? 0 : '100%',
              opacity: 0,
              transition: motionTokens.tweens.dismiss,
            }}
          >
            {content}
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
}

function DiffViewer({ mode }: { mode: CompareVariant }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();

  return (
    <div className="p6-diff">
      <div className="p6-diff__head">
        <span>src/motion/contract.ts</span>
        <span className="p6-diff__stats">
          <em>+4</em>
          <strong>−2</strong>
        </span>
      </div>
      <div className="p6-diff__rows" key={mode}>
        {DIFF_ROWS.map((row, index) =>
          mode === 'animate' ? (
            <motion.div
              key={`${row.no}-${row.type}-${index}`}
              className={`p6-diff__row p6-diff__row--${row.type}`}
              initial={{
                opacity: 0,
                x: reduce ? 0 : -motionTokens.travel(4),
                filter: motionTokens.itemBlur,
              }}
              animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
              transition={{
                ...motionTokens.itemSpring,
                delay: reduce ? 0 : index * motionTokens.stagger,
              }}
            >
              <span className="p6-diff__no">{row.no}</span>
              <span className="p6-diff__sign">
                {row.type === 'add' ? '+' : row.type === 'del' ? '−' : ''}
              </span>
              <span className="p6-diff__code">{row.text || ' '}</span>
            </motion.div>
          ) : (
            <div
              key={`${row.no}-${row.type}-${index}`}
              className={`p6-diff__row p6-diff__row--${row.type} motion-row-in`}
              style={{ animationDelay: `${index * 18}ms` }}
            >
              <span className="p6-diff__no">{row.no}</span>
              <span className="p6-diff__sign">
                {row.type === 'add' ? '+' : row.type === 'del' ? '−' : ''}
              </span>
              <span className="p6-diff__code">{row.text || ' '}</span>
            </div>
          )
        )}
      </div>
    </div>
  );
}

function TerminalPane({
  mode,
  open,
  lines,
  command,
  onCommand,
  onSubmit,
  onClose,
}: {
  mode: CompareVariant;
  open: boolean;
  lines: TerminalLine[];
  command: string;
  onCommand: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);

  const content = (
    <div className="p6-terminal__inner">
      <div className="p6-terminal__head">
        <span>terminal · zsh</span>
        <SceneButton mode={mode} variant="icon" onClick={onClose} aria-label="Cerrar terminal">
          <CloseIcon size={11} />
        </SceneButton>
      </div>
      <div className="p6-terminal__lines">
        {lines.map((line) => (
          <div key={line.id} className={`p6-terminal__line p6-terminal__line--${line.tone}`}>
            {line.text}
          </div>
        ))}
      </div>
      <form
        className="p6-terminal__form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <span className="p6-terminal__prompt" aria-hidden="true">
          $
        </span>
        <input
          className="p6-terminal__input"
          value={command}
          onChange={(event) => onCommand(event.target.value)}
          placeholder="npm run test"
          aria-label="Comando de terminal"
        />
      </form>
    </div>
  );

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div className={`p6-terminal ${motionSurfaceClass(presence.phase, 'terminal')}`}>
        {content}
      </div>
    );
  }

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          className="p6-terminal"
          initial={{ height: 0, opacity: 0 }}
          animate={{
            height: 'auto',
            opacity: 1,
            transition: reduce ? motionTokens.tweens.fade : motionTokens.tweens.disclosure,
          }}
          exit={{
            height: 0,
            opacity: 0,
            transition: motionTokens.tweens.panelOut,
          }}
          style={{ overflow: 'hidden' }}
        >
          {content}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function WorkspacePane({
  mode,
  threads,
  filter,
  onFilter,
  collapsed,
  onToggleRail,
  selectedThread,
  expanded,
  onToggleExpanded,
  onSelectThread,
  menuFor,
  onToggleMenu,
  submenuOpen,
  onSubmenu,
  project,
  onMoveTo,
  dockOpen,
  onToggleDock,
  onShowDiff,
  view,
  onView,
  terminalOpen,
  onToggleTerminal,
  terminalLines,
  command,
  onCommand,
  onSubmitCommand,
  onCloseTerminal,
}: {
  mode: CompareVariant;
  threads: ThreadNode[];
  filter: string;
  onFilter: (value: string) => void;
  collapsed: boolean;
  onToggleRail: () => void;
  selectedThread: string;
  expanded: string[];
  onToggleExpanded: (id: string) => void;
  onSelectThread: (id: string) => void;
  menuFor: string | null;
  onToggleMenu: (id: string) => void;
  submenuOpen: boolean;
  onSubmenu: (next: boolean) => void;
  project: string;
  onMoveTo: (next: string) => void;
  dockOpen: boolean;
  onToggleDock: () => void;
  onShowDiff: () => void;
  view: 'editor' | 'diff';
  onView: (next: 'editor' | 'diff') => void;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  terminalLines: TerminalLine[];
  command: string;
  onCommand: (value: string) => void;
  onSubmitCommand: () => void;
  onCloseTerminal: () => void;
}) {
  const motionTokens = useLabMotion();
  const railClass = `cmp-workspace__rail p6-ws__rail${
    mode === 'kite' ? ' p6-ws__rail--kite' : ''
  }${collapsed ? ' is-collapsed' : ''}`;
  const filtering = filter.trim().length > 0;

  const miniRail = (
    <div className="p6-ws__rail-mini">
      <SceneButton
        mode={mode}
        variant="icon"
        onClick={onToggleRail}
        aria-label="Expandir sidebar"
      >
        <SidebarIcon size={13} />
      </SceneButton>
      {THREADS.map((thread) => (
        <button
          key={thread.id}
          type="button"
          className={`p6-ws__mini${selectedThread === thread.id ? ' is-active' : ''}`}
          title={thread.title}
          aria-label={thread.title}
          onClick={() => onSelectThread(thread.id)}
        >
          <span className={`cmp-thread__dot cmp-thread__dot--${thread.state}`} aria-hidden="true" />
        </button>
      ))}
    </div>
  );

  const fullRail = (
    <>
      <div className="p6-ws__rail-head">
        <span>Hilos</span>
        <SceneButton
          mode={mode}
          variant="icon"
          onClick={onToggleRail}
          aria-label="Colapsar sidebar"
        >
          <SidebarIcon size={13} />
        </SceneButton>
      </div>

      <div className="p6-ws__search">
        <SearchIcon size={12} />
        <input
          className="p6-ws__search-input"
          value={filter}
          onChange={(event) => onFilter(event.target.value)}
          placeholder="Filtrar hilos"
          aria-label="Filtrar hilos"
        />
      </div>

      <div className="p6-ws__project">Proyecto · {project}</div>

      <div className="p6-ws__tree">
        {threads.length === 0 && (
          <p className="p6-ws__empty">Sin hilos que coincidan.</p>
        )}
        {threads.map((thread) => {
          const hasChildren = Boolean(thread.children && thread.children.length > 0);
          const isOpen = expanded.includes(thread.id) || (filtering && hasChildren);
          return (
            <div key={thread.id} className="p6-ws__node">
              <div
                className={`cmp-thread p6-ws__thread${
                  selectedThread === thread.id ? ' is-active' : ''
                }`}
              >
                {hasChildren ? (
                  <button
                    type="button"
                    className="p6-ws__chev"
                    aria-label={isOpen ? `Contraer ${thread.title}` : `Expandir ${thread.title}`}
                    aria-expanded={isOpen}
                    onClick={() => onToggleExpanded(thread.id)}
                  >
                    {mode === 'animate' ? (
                      <motion.span
                        className="p6-ws__chevicon"
                        animate={{ rotate: isOpen ? 90 : 0 }}
                        transition={motionTokens.tweens.disclosure}
                      >
                        <ChevronRightIcon size={10} />
                      </motion.span>
                    ) : (
                      <ChevronRightIcon
                        size={10}
                        className={`p6-ws__chevicon${isOpen ? ' is-open' : ''}`}
                      />
                    )}
                  </button>
                ) : (
                  <span className="p6-ws__chev p6-ws__chev--empty" aria-hidden="true" />
                )}
                <span
                  className={`cmp-thread__dot cmp-thread__dot--${thread.state}`}
                  aria-hidden="true"
                />
                <button
                  type="button"
                  className="cmp-thread__text p6-ws__thread-button"
                  onClick={() => onSelectThread(thread.id)}
                >
                  <span>{thread.title}</span>
                  <small>{thread.detail}</small>
                </button>
                <SceneButton
                  mode={mode}
                  variant="icon"
                  className="cmp-thread__more"
                  aria-label={`Opciones de ${thread.title}`}
                  aria-haspopup="menu"
                  aria-expanded={menuFor === thread.id}
                  onClick={() => onToggleMenu(thread.id)}
                >
                  <MoreIcon size={12} />
                </SceneButton>
                <ThreadMenu
                  mode={mode}
                  open={menuFor === thread.id}
                  onClose={() => onToggleMenu(thread.id)}
                  submenuOpen={submenuOpen}
                  onSubmenu={onSubmenu}
                  onSelect={() => {
                    onSelectThread(thread.id);
                    onToggleMenu(thread.id);
                  }}
                  onMoveTo={onMoveTo}
                />
              </div>
              {hasChildren && isOpen && (
                <div className="p6-ws__children">
                  {thread.children?.map((child) => (
                    <button
                      key={child.id}
                      type="button"
                      className={`p6-ws__child${
                        selectedThread === child.id ? ' is-active' : ''
                      }`}
                      onClick={() => onSelectThread(child.id)}
                    >
                      <span
                        className={`cmp-thread__dot cmp-thread__dot--${child.state}`}
                        aria-hidden="true"
                      />
                      <span className="p6-ws__child-text">
                        <span>{child.title}</span>
                        <small>{child.detail}</small>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );

  return (
    <div className={`cmp-workspace p6-ws p6-mode p6-mode--${mode}`}>
      {mode === 'animate' ? (
        <motion.aside
          className={railClass}
          layout
          transition={motionTokens.springs.reflow}
          aria-label="Hilos del workspace"
        >
          {collapsed ? miniRail : fullRail}
        </motion.aside>
      ) : (
        <aside className={railClass} aria-label="Hilos del workspace">
          {collapsed ? miniRail : fullRail}
        </aside>
      )}

      <main className="cmp-editor p6-ws__editor">
        <header className="cmp-editor__head p6-ws__editor-head">
          <div className="cmp-tabs p6-ws__tabs" role="tablist" aria-label="Vista del editor">
            {(['editor', 'diff'] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={view === item}
                className={`cmp-tabs__tab${view === item ? ' is-active' : ''}`}
                onClick={() => onView(item)}
              >
                {mode === 'animate' && view === item && (
                  <motion.span
                    layoutId="cmp-workspace-tab"
                    className="cmp-tabs__indicator"
                    initial={false}
                    transition={motionTokens.springs.selection}
                  />
                )}
                <span className="cmp-tabs__label">{item === 'editor' ? 'Editor' : 'Diff'}</span>
              </button>
            ))}
          </div>
          <div className="p6-ws__editor-actions">
            <SceneButton
              mode={mode}
              variant="ghost"
              className="cmp-btn--sm"
              onClick={onToggleTerminal}
              aria-pressed={terminalOpen}
            >
              <TerminalIcon size={12} />
              Terminal
            </SceneButton>
            <SceneButton
              mode={mode}
              variant="ghost"
              className="cmp-btn--sm"
              onClick={onToggleDock}
            >
              {dockOpen ? 'Cerrar dock' : 'Abrir dock'}
            </SceneButton>
          </div>
        </header>

        <div className="p6-ws__body">
          {view === 'editor' ? (
            <pre className="cmp-editor__code">{`export const MOTION_ENTER_MS = 180;
export const MOTION_EXIT_MS = 140;

export function prefersReducedMotion() {
  return document.documentElement.dataset.motion === 'reduce';
}`}</pre>
          ) : (
            <DiffViewer mode={mode} />
          )}
        </div>

        <TerminalPane
          mode={mode}
          open={terminalOpen}
          lines={terminalLines}
          command={command}
          onCommand={onCommand}
          onSubmit={onSubmitCommand}
          onClose={onCloseTerminal}
        />

        <Dock mode={mode} open={dockOpen} onClose={onToggleDock} onShowDiff={onShowDiff} />
      </main>
    </div>
  );
}

export function WorkspaceScene({ view }: { view: CompareView }) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [dockOpen, setDockOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<string[]>(['t1']);
  const [filter, setFilter] = useState('');
  const [selectedThread, setSelectedThread] = useState('t1');
  const [project, setProject] = useState(PROJECTS[0]);
  const [editorView, setEditorView] = useState<'editor' | 'diff'>('editor');
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>(SEED_TERMINAL);
  const [command, setCommand] = useState('');
  const sequence = useRef(SEED_TERMINAL.length);

  const query = filter.trim().toLowerCase();
  const visibleThreads = THREADS.filter(
    (thread) =>
      !query ||
      thread.title.toLowerCase().includes(query) ||
      thread.children?.some((child) => child.title.toLowerCase().includes(query))
  );

  const runCommand = () => {
    const value = command.trim();
    if (!value) return;
    sequence.current += 2;
    const base = sequence.current;
    setTerminalLines((prev) => [
      ...prev,
      { id: `l${base - 1}`, tone: 'cmd', text: `$ ${value}` },
      { id: `l${base}`, tone: 'ok', text: `✓ ${value} · ok` },
    ]);
    setCommand('');
  };

  return (
    <CompareScene
      index="03"
      title="Workspace completo"
      target="Sidebar · SelectMenu · RightDock · Diff · Terminal"
      note="Rail colapsable con hilos anidados y filtro, menú con submenú, editor con diff, terminal y dock derecho. Abrí el menú de un hilo, colapsá el rail o cambiá a Diff: el estado es uno y las dos columnas lo comparten."
      view={view}
    >
      {(mode) => (
        <WorkspacePane
          mode={mode}
          threads={visibleThreads}
          filter={filter}
          onFilter={setFilter}
          collapsed={collapsed}
          onToggleRail={() => setCollapsed((value) => !value)}
          selectedThread={selectedThread}
          expanded={expanded}
          onToggleExpanded={(id) =>
            setExpanded((prev) =>
              prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
            )
          }
          onSelectThread={setSelectedThread}
          menuFor={menuFor}
          onToggleMenu={(id) => {
            setMenuFor((current) => (current === id ? null : id));
            setSubmenuOpen(false);
          }}
          submenuOpen={submenuOpen}
          onSubmenu={setSubmenuOpen}
          project={project}
          onMoveTo={(next) => {
            setProject(next);
            setMenuFor(null);
            setSubmenuOpen(false);
          }}
          dockOpen={dockOpen}
          onToggleDock={() => setDockOpen((value) => !value)}
          onShowDiff={() => {
            setEditorView('diff');
            setDockOpen(false);
          }}
          view={editorView}
          onView={setEditorView}
          terminalOpen={terminalOpen}
          onToggleTerminal={() => setTerminalOpen((value) => !value)}
          terminalLines={terminalLines}
          command={command}
          onCommand={setCommand}
          onSubmitCommand={runCommand}
          onCloseTerminal={() => setTerminalOpen(false)}
        />
      )}
    </CompareScene>
  );
}

/* -------------------------------------------------------------------------- */
/* Scene 4 — Usage modal + notifications                                       */
/* -------------------------------------------------------------------------- */

interface ToastItem {
  id: number;
  tone: 'ok' | 'warn';
  text: string;
}

const NOTIFICATIONS = [
  { id: 'n1', title: 'Sesión completada', detail: 'feat/motion · hace 4 min', tone: 'ok' },
  { id: 'n2', title: 'Presupuesto al 72%', detail: 'Quedan 1.284 tickets', tone: 'warn' },
  { id: 'n3', title: 'Nuevo modelo disponible', detail: 'Kite 2 · Opus', tone: 'ok' },
];

function UsageModal({
  mode,
  open,
  onClose,
  onNotify,
}: {
  mode: CompareVariant;
  open: boolean;
  onClose: () => void;
  onNotify: () => void;
}) {
  const motionTokens = useLabMotion();
  const presence = usePresence(open);

  const body = (
    <>
      <div className="cmp-modal__head">
        <strong>Consumo del mes</strong>
        <SceneButton mode={mode} variant="icon" onClick={onClose} aria-label="Cerrar consumo">
          <CloseIcon size={13} />
        </SceneButton>
      </div>
      <p className="cmp-muted">
        El panel se endereza desde scale 0.8 y rotateX −20° mientras el scrim funde por detrás.
      </p>
      <div className="cmp-modal__stats">
        <div>
          <span>Tickets</span>
          <strong>1.284</strong>
        </div>
        <div>
          <span>Tokens</span>
          <strong>72%</strong>
        </div>
        <div>
          <span>Sesiones</span>
          <strong>18</strong>
        </div>
      </div>
      <div className="cmp-modal__actions">
        <SceneButton
          mode={mode}
          variant="primary"
          onClick={() => {
            onNotify();
            onClose();
          }}
        >
          Actualizar plan
        </SceneButton>
        <SceneButton mode={mode} variant="ghost" onClick={onClose}>
          Cerrar
        </SceneButton>
      </div>
    </>
  );

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div className="cmp-modal-layer">
        <div
          className={`cmp-scrim ${motionSurfaceClass(presence.phase, 'scrim')}`}
          onClick={onClose}
          aria-hidden="true"
        />
        <div
          className={`cmp-modal ${motionSurfaceClass(presence.phase, 'modal')}`}
          role="dialog"
          aria-modal="true"
          aria-label="Consumo del mes"
        >
          {body}
        </div>
      </div>
    );
  }

  return (
    <div className="cmp-modal-layer">
      <AnimatePresence>
        {open && (
          <motion.div
            className="cmp-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: motionTokens.tweens.overlay }}
            exit={{ opacity: 0, transition: motionTokens.tweens.overlay }}
            onClick={onClose}
            aria-hidden="true"
          />
        )}
      </AnimatePresence>
      <div className="cmp-modal-perspective">
        <AnimatePresence>
          {open && (
            <motion.div
              className="cmp-modal-fade"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: motionTokens.tweens.dialogFade }}
              exit={{ opacity: 0, transition: motionTokens.tweens.dismiss }}
            >
              <motion.div
                className="cmp-modal"
                role="dialog"
                aria-modal="true"
                aria-label="Consumo del mes"
                initial={{
                  scale: motionTokens.scale.dialog,
                  rotateX: -20,
                  y: motionTokens.travel(8),
                }}
                animate={{ scale: 1, rotateX: 0, y: 0, transition: motionTokens.springs.dialog }}
                exit={{
                  scale: motionTokens.scale.dialog,
                  rotateX: -20,
                  y: motionTokens.travel(8),
                  transition: motionTokens.tweens.dismiss,
                }}
              >
                {body}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function AlertsPane({
  mode,
  modalOpen,
  onOpenModal,
  onCloseModal,
  toasts,
  onNotify,
}: {
  mode: CompareVariant;
  modalOpen: boolean;
  onOpenModal: () => void;
  onCloseModal: () => void;
  toasts: ToastItem[];
  onNotify: () => void;
}) {
  const motionTokens = useLabMotion();

  return (
    <div className="cmp-alerts">
      <header className="cmp-card__head">
        <div>
          <strong>Uso y notificaciones</strong>
          <span>resumen del workspace</span>
        </div>
        <span className="cmp-badge">live</span>
      </header>

      <div className="cmp-usage">
        <div className="cmp-usage__stat">
          <span>Tokens</span>
          <strong>72%</strong>
          <div className="cmp-meter cmp-meter--sm">
            <div className="cmp-meter__fill" style={{ width: '72%' }} />
          </div>
        </div>
        <div className="cmp-usage__stat">
          <span>Sesiones</span>
          <strong>18</strong>
        </div>
        <div className="cmp-usage__stat">
          <span>Tickets</span>
          <strong>1.284</strong>
        </div>
      </div>

      <div className="cmp-alerts__actions">
        <SceneButton mode={mode} variant="primary" onClick={onOpenModal}>
          Ver consumo
        </SceneButton>
        <SceneButton mode={mode} onClick={onNotify}>
          Simular notificación
        </SceneButton>
      </div>

      <div className="cmp-notifications">
        <span className="cmp-notifications__title">Recientes</span>
        {NOTIFICATIONS.map((item) => (
          <div key={item.id} className="cmp-notification">
            <span className={`cmp-notification__dot cmp-notification__dot--${item.tone}`} />
            <div>
              <strong>{item.title}</strong>
              <span>{item.detail}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="cmp-toasts" aria-live="polite">
        <AnimatePresence initial={false}>
          {toasts.map((toast) =>
            mode === 'kite' ? (
              <div key={toast.id} className={`cmp-toast cmp-toast--${toast.tone} motion-row-in`}>
                <span className="cmp-toast__dot" aria-hidden="true" />
                {toast.text}
              </div>
            ) : (
              <motion.div
                key={toast.id}
                layout="position"
                className={`cmp-toast cmp-toast--${toast.tone}`}
                initial={{
                  opacity: 0,
                  y: '100%',
                  scale: motionTokens.scale.toast,
                  filter: motionTokens.surfaceBlur,
                }}
                animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
                exit={{
                  opacity: 0,
                  scale: motionTokens.scale.toast,
                  filter: motionTokens.surfaceBlur,
                  transition: motionTokens.tweens.dismiss,
                }}
                transition={motionTokens.springs.toast}
                style={{ originY: 1 }}
              >
                <span className="cmp-toast__dot" aria-hidden="true" />
                {toast.text}
              </motion.div>
            )
          )}
        </AnimatePresence>
      </div>

      <UsageModal
        mode={mode}
        open={modalOpen}
        onClose={onCloseModal}
        onNotify={onNotify}
      />
    </div>
  );
}

export function AlertsScene({ view }: { view: CompareView }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const sequence = useRef(0);
  const timers = useRef<number[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach((id) => window.clearTimeout(id));
    },
    []
  );

  const notify = () => {
    sequence.current += 1;
    const id = sequence.current;
    const tone = id % 2 === 0 ? 'warn' : 'ok';
    setToasts((prev) => [
      ...prev,
      { id, tone, text: tone === 'ok' ? 'Cambios guardados' : 'La sesión venció' },
    ]);
    timers.current.push(
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
      }, 3400)
    );
  };

  return (
    <CompareScene
      index="04"
      title="Consumo y notificaciones"
      target="UsageDashboardModal · NotificationsView"
      note="Abrí el consumo y simulá una notificación. Kite funde el modal y sube el toast unos píxeles; Animate UI lo endereza desde el centro y el toast entra desde el borde con overshoot."
      view={view}
    >
      {(mode) => (
        <AlertsPane
          mode={mode}
          modalOpen={modalOpen}
          onOpenModal={() => setModalOpen(true)}
          onCloseModal={() => setModalOpen(false)}
          toasts={toasts}
          onNotify={notify}
        />
      )}
    </CompareScene>
  );
}
