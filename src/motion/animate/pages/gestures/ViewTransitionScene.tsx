import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useLabMotion, useLabReduce } from '../../context';
import {
  CompareScene,
  SceneButton,
  type CompareVariant,
  type CompareView,
} from '../../frame';
import { ArrowRightIcon } from '../../ui';

/* -------------------------------------------------------------------------- */
/* 08.05 — View transition, stagger, interruption                              */
/* -------------------------------------------------------------------------- */

type ThreadTone = 'running' | 'idle' | 'done';

interface LabThread {
  id: string;
  short: string;
  title: string;
  detail: string;
  tone: ThreadTone;
  messages: string[];
}

const LAB_THREADS: LabThread[] = [
  {
    id: 'transcript',
    short: 'Transcript',
    title: 'Refactor del transcript',
    detail: 'hace 2 min',
    tone: 'running',
    messages: [
      'El transcript mide 880 px y conserva el borde vivo.',
      'El ancla se recalcula antes de sumar la fila nueva.',
      'Si el lector está arriba, no se mueve.',
      'El umbral queda en 48 px.',
    ],
  },
  {
    id: 'contract',
    short: 'Contrato',
    title: 'Motion contract',
    detail: 'hace 18 min',
    tone: 'idle',
    messages: [
      'Entran 180 ms, salen 140 ms, transform y opacity.',
      'Nada anima width, height, top ni left.',
      'Las superficies comparten el mismo helper.',
      'El reduced motion apaga la animación, no el fade.',
    ],
  },
  {
    id: 'preview',
    short: 'Preview',
    title: 'Preview Animate UI',
    detail: 'ayer',
    tone: 'done',
    messages: [
      'Nueve páginas con un mismo estado por escena.',
      'Los tokens salen de un solo módulo.',
      'El nivel y el tempo solo mueven la columna derecha.',
      'La página 08 cierra gestos y estructura.',
    ],
  },
];

function ThreadChips({
  mode,
  thread,
  onSelect,
  chipsRef,
}: {
  mode: CompareVariant;
  thread: LabThread;
  onSelect: (id: string) => void;
  chipsRef: RefObject<Map<string, HTMLButtonElement>>;
}) {
  const motionTokens = useLabMotion();

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = LAB_THREADS.findIndex((item) => item.id === thread.id);
    const step = event.key === 'ArrowRight' ? 1 : LAB_THREADS.length - 1;
    const next = LAB_THREADS[(index + step) % LAB_THREADS.length];
    onSelect(next.id);
    requestAnimationFrame(() => chipsRef.current?.get(next.id)?.focus());
  };

  return (
    <div
      className="p8-chips"
      role="tablist"
      aria-label="Cambiar de hilo"
      onKeyDown={onKeyDown}
    >
      {LAB_THREADS.map((item) => {
        const selected = item.id === thread.id;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={selected}
            className={`p8-chip${selected ? ' is-selected' : ''}`}
            onClick={() => onSelect(item.id)}
            ref={(element) => {
              if (element) chipsRef.current?.set(item.id, element);
            }}
          >
            {mode === 'animate' && selected && (
              <motion.span
                layoutId="p8-chip-indicator"
                className="p8-chip__indicator"
                initial={false}
                transition={motionTokens.springs.selection}
              />
            )}
            <span className="p8-chip__label">{item.short}</span>
          </button>
        );
      })}
    </div>
  );
}

function ThreadPane({
  mode,
  thread,
  stamp,
  chipsRef,
  layerRef,
  onBack,
  onSelectThread,
  onReplay,
}: {
  mode: CompareVariant;
  thread: LabThread;
  stamp: number;
  chipsRef: RefObject<Map<string, HTMLButtonElement>>;
  layerRef: RefObject<HTMLDivElement>;
  onBack: () => void;
  onSelectThread: (id: string) => void;
  onReplay: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();

  return (
    <div
      ref={layerRef}
      tabIndex={-1}
      className="p8-pane"
      role="region"
      aria-label={thread.title}
    >
      <header className="p8-pane__head">
        <SceneButton
          mode={mode}
          variant="ghost"
          className="p8-mini"
          onClick={onBack}
          aria-label="Volver a la bandeja"
        >
          ←
        </SceneButton>
        {mode === 'animate' ? (
          <motion.span
            layoutId={`p8-thread-title-${thread.id}`}
            className="p8-pane__title"
            transition={motionTokens.springs.dialog}
          >
            {thread.title}
          </motion.span>
        ) : (
          <span className="p8-pane__title">{thread.title}</span>
        )}
        <span className="cmp-badge">{thread.detail}</span>
      </header>

      <ThreadChips
        mode={mode}
        thread={thread}
        onSelect={onSelectThread}
        chipsRef={chipsRef}
      />

      <div className="p8-messages" key={`${thread.id}-${stamp}`}>
        {thread.messages.map((message, index) =>
          mode === 'animate' ? (
            <motion.div
              key={message}
              className="p8-message"
              initial={{
                opacity: 0,
                y: reduce ? 0 : motionTokens.travel(6),
                filter: reduce ? 'blur(0px)' : motionTokens.itemBlur,
              }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{
                ...motionTokens.springs.pop,
                delay: reduce ? 0 : index * motionTokens.stagger,
              }}
            >
              {message}
            </motion.div>
          ) : (
            <div key={message} className="p8-message motion-row-in">
              {message}
            </div>
          )
        )}
      </div>

      <footer className="p8-pane__foot">
        <SceneButton mode={mode} variant="ghost" className="cmp-btn--sm" onClick={onReplay}>
          Re-disparar
        </SceneButton>
        <span className="p8-pane__hint">
          stagger {motionTokens.stagger.toFixed(2)} s · {mode === 'animate' ? 'spring' : 'CSS'}
        </span>
      </footer>
    </div>
  );
}

function ViewPane({
  mode,
  view,
  thread,
  stamp,
  note,
  owner,
  onOpenThread,
  onBack,
  onSelectThread,
  onReplay,
}: {
  mode: CompareVariant;
  view: 'inbox' | 'thread';
  thread: LabThread;
  stamp: number;
  note: string;
  owner: CompareVariant | null;
  onOpenThread: (id: string) => void;
  onBack: () => void;
  onSelectThread: (id: string) => void;
  onReplay: () => void;
}) {
  const motionTokens = useLabMotion();
  const chipsRef = useRef(new Map<string, HTMLButtonElement>());
  const layerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);
  const wasThread = useRef(false);

  useEffect(() => {
    const nowThread = view === 'thread';
    const entering = nowThread && !wasThread.current;
    const leaving = !nowThread && wasThread.current;
    wasThread.current = nowThread;
    if (owner !== mode) return;
    if (entering) {
      layerRef.current?.focus();
      return;
    }
    if (leaving && pendingFocus.current) {
      const id = pendingFocus.current;
      pendingFocus.current = null;
      rowRefs.current.get(id)?.focus();
    }
  }, [view, owner, mode]);

  const inboxLayer = (
    <div className="p8-inbox">
      <span className="p8-kicker">Bandeja · 3 hilos</span>
      {LAB_THREADS.map((item) => (
        <button
          key={item.id}
          type="button"
          className="p8-thread-row"
          ref={(element) => {
            if (element) rowRefs.current.set(item.id, element);
          }}
          onClick={() => {
            pendingFocus.current = item.id;
            onOpenThread(item.id);
          }}
        >
          <span className={`p8-dot p8-dot--${item.tone}`} aria-hidden="true" />
          <span className="p8-thread-row__text">
            {mode === 'animate' ? (
              <motion.span
                layoutId={`p8-thread-title-${item.id}`}
                className="p8-thread-row__title"
                transition={motionTokens.springs.dialog}
              >
                {item.title}
              </motion.span>
            ) : (
              <span className="p8-thread-row__title">{item.title}</span>
            )}
            <small>{item.detail}</small>
          </span>
          <ArrowRightIcon size={12} />
        </button>
      ))}
    </div>
  );

  const threadLayer = (
    <ThreadPane
      mode={mode}
      thread={thread}
      stamp={stamp}
      chipsRef={chipsRef}
      layerRef={layerRef}
      onBack={onBack}
      onSelectThread={onSelectThread}
      onReplay={onReplay}
    />
  );

  const layerState = {
    initial: { opacity: 0, x: motionTokens.travel(motionTokens.shift.navigation), zIndex: 5 },
    animate: {
      opacity: 1,
      x: 0,
      zIndex: 5,
      transition: motionTokens.tweens.panelIn,
    },
    exit: {
      opacity: 0,
      x: -motionTokens.travel(motionTokens.shift.navigation),
      zIndex: 0,
      transition: motionTokens.tweens.panelOut,
    },
  };

  return (
    <div className="p8-view">
      <div className="p8-view__bar">
        <span className="p8-kicker">Vista</span>
        <span className="p8-view__state">
          {view === 'inbox' ? 'Bandeja' : `Hilo · ${thread.short}`}
        </span>
        <span className="p8-chip-static">← → cambian de hilo</span>
      </div>

      <div className="p8-view__stage">
        {mode === 'animate' ? (
          <AnimatePresence initial={false}>
            {view === 'inbox' ? (
              <motion.div
                key="inbox"
                className="p8-view__layer"
                {...layerState}
              >
                {inboxLayer}
              </motion.div>
            ) : (
              <motion.div
                key="thread"
                className="p8-view__layer"
                {...layerState}
              >
                {threadLayer}
              </motion.div>
            )}
          </AnimatePresence>
        ) : (
          <div key={view} className="p8-view__layer motion-panel-in">
            {view === 'inbox' ? inboxLayer : threadLayer}
          </div>
        )}
      </div>

      <p className="p8-note" aria-live={owner === mode ? 'polite' : 'off'}>
        {note ||
          (mode === 'animate'
            ? 'Abrí un hilo: el título viaja de la fila al panel. Cambiá rápido con los chips o ← →.'
            : 'Abrí un hilo: Kite cambia de vista sin compartir el título.')}
      </p>
    </div>
  );
}

export function ViewTransitionScene({ view }: { view: CompareView }) {
  const [mode, setMode] = useState<'inbox' | 'thread'>('inbox');
  const [threadId, setThreadId] = useState(LAB_THREADS[0].id);
  const [stamp, setStamp] = useState(0);
  const [note, setNote] = useState('');
  const [owner, setOwner] = useState<CompareVariant | null>(null);

  const thread = LAB_THREADS.find((item) => item.id === threadId) ?? LAB_THREADS[0];
  const titleOf = (id: string) => LAB_THREADS.find((item) => item.id === id)?.short ?? '';

  return (
    <CompareScene
      index="05"
      title="Cambio de vista, stagger e interrupción"
      target="ShellView · AnimatePresence"
      note="La bandeja y el hilo comparten el título con layoutId: la capa que entra queda por encima de la que se apaga. Los mensajes entran en stagger (solo en Expressive) y los chips mueven su indicador con spring.selection: cambiá rápido y retoma desde donde está. Kite cambia de vista sin compartir el título."
      view={view}
    >
      {(paneMode) => (
        <ViewPane
          mode={paneMode}
          view={mode}
          thread={thread}
          stamp={stamp}
          note={note}
          owner={owner}
          onOpenThread={(id) => {
            setThreadId(id);
            setMode('thread');
            setOwner(paneMode);
            setNote(`Hilo abierto: ${titleOf(id)}.`);
          }}
          onBack={() => {
            setMode('inbox');
            setOwner(paneMode);
            setNote('Volviste a la bandeja.');
          }}
          onSelectThread={(id) => {
            setThreadId(id);
            setStamp((value) => value + 1);
            setOwner(paneMode);
            setNote(`Hilo: ${titleOf(id)}.`);
          }}
          onReplay={() => {
            setStamp((value) => value + 1);
            setOwner(paneMode);
            setNote('Stagger re-disparado.');
          }}
        />
      )}
    </CompareScene>
  );
}
