import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import {
  AnimatePresence,
  motion,
  useInView,
  useMotionValue,
  useSpring,
  type Variants,
} from 'motion/react';
import { usePresence } from '../../../usePresence';
import { motionSurfaceClass } from '../../../surface';
import { useLabMotion, useLabReduce } from '../../context';
import { CompareScene, SceneButton, type CompareVariant, type CompareView } from '../../frame';
import { CloseIcon, SwapLabel } from '../../ui';

/* -------------------------------------------------------------------------- */
/* Scene 3 — Cards: hover lift, press, expanding card, shared element          */
/* -------------------------------------------------------------------------- */

type CoverTone = 'azure' | 'violet' | 'green';

interface LabCard {
  id: string;
  title: string;
  tag: string;
  blurb: string;
  body: string;
  meta: string[];
  cover: CoverTone;
}

const CARDS: LabCard[] = [
  {
    id: 'motion',
    title: 'Contrato de motion',
    tag: 'motion',
    blurb: 'Entrada 180 ms, salida 140 ms. Transform y opacity.',
    body: 'El contrato fija la duración de entrada y salida que usa hoy cada superficie de Kite. La tarjeta se abre en un detalle sin cambiar de superficie: mismo fondo, mismo borde, mismo radio.',
    meta: ['src/motion/contract.ts', '+14 −2'],
    cover: 'azure',
  },
  {
    id: 'presence',
    title: 'Presencia de overlays',
    tag: 'presence',
    blurb: 'El overlay vive hasta que su salida termina.',
    body: 'usePresence mantiene el nodo montado durante MOTION_EXIT_MS y después lo quita. El detalle comparte el layoutId con la tarjeta, así que el ojo sigue el mismo objeto mientras cambia de tamaño.',
    meta: ['src/motion/usePresence.ts', '+9 −1'],
    cover: 'violet',
  },
  {
    id: 'surface',
    title: 'Superficies de motion',
    tag: 'surface',
    blurb: 'Popover, panel, scrim, modal y fila.',
    body: 'Cada fase de una superficie tiene una clase CSS con su keyframe. La tarjeta abierta demuestra lo mismo que esas clases: el contenido nuevo aparece una vez que el marco terminó de moverse.',
    meta: ['src/motion/surface.ts', '+21 −6'],
    cover: 'green',
  },
];

const AGENT_STATUS = [
  { label: 'En línea', tone: 'on' },
  { label: 'En reunión', tone: 'warn' },
  { label: 'Ausente', tone: 'idle' },
] as const;

const AGENT_LABELS: string[] = AGENT_STATUS.map((entry) => entry.label);

/** `.p4-cards` padding, and the detail panel's inset (must match data.css). */
const PANEL_INSET = 10;
const DEFAULT_ANCHOR = { x: 50, y: 50 };

interface OpenAnchor {
  x: number;
  y: number;
}

interface OpenCard {
  id: string;
  origin: CompareVariant;
  /** The card's center as a percentage of the detail panel, for the entrance. */
  anchor: OpenAnchor;
}

export function CardsScene({ view }: { view: CompareView }) {
  const [open, setOpen] = useState<OpenCard | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const openCard = open ? CARDS.find((card) => card.id === open.id) ?? null : null;

  return (
    <CompareScene
      index="03"
      title="Tarjetas y elemento compartido"
      target="ProjectCard · ExpandingCard · SpotlightCard · ProfileCard"
      note="Pasá el puntero y presioná una tarjeta; después abrila. Kite levanta 2 px y escala 0.985 al presionar; Animate UI suma lift con spring, sombra y zoom de portada, y el detalle crece desde la tarjeta con layoutId mientras su contenido entra detrás (escalonado en Expressive). Las dos firmas nuevas —spotlight que sigue al puntero y ficha de agente con pulso de estado— viven solo en la columna Animate UI."
      view={view}
    >
      {(mode) => (
        <CardsColumn
          mode={mode}
          open={
            openCard
              ? {
                  id: openCard.id,
                  origin: open?.origin ?? mode,
                  anchor: open?.anchor ?? DEFAULT_ANCHOR,
                }
              : null
          }
          onOpen={(id, anchor) => setOpen({ id, origin: mode, anchor })}
          onClose={() => setOpen(null)}
        />
      )}
    </CompareScene>
  );
}

function CardsColumn({
  mode,
  open,
  onOpen,
  onClose,
}: {
  mode: CompareVariant;
  open: OpenCard | null;
  onOpen: (id: string, anchor: OpenAnchor) => void;
  onClose: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const extrasRef = useRef<HTMLDivElement>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement | null>());
  const lastMine = useRef<OpenCard | null>(null);
  const lift = Math.min(4, motionTokens.travel(2));

  useEffect(() => {
    for (const node of [gridRef.current, extrasRef.current]) {
      if (!node) continue;
      if (open) {
        node.setAttribute('inert', '');
      } else {
        node.removeAttribute('inert');
      }
    }
  }, [open]);

  useEffect(() => {
    if (open && open.origin === mode) {
      lastMine.current = open;
      return;
    }
    if (!open && lastMine.current) {
      const id = lastMine.current.id;
      lastMine.current = null;
      const frame = requestAnimationFrame(() => triggers.current.get(id)?.focus());
      return () => cancelAnimationFrame(frame);
    }
  }, [open, mode]);

  const card = open ? CARDS.find((item) => item.id === open.id) ?? null : null;

  /**
   * Measure the trigger and hand the detail its origin. The panel is
   * `.p4-cards` inset by PANEL_INSET, so this reads the card's center in the
   * coordinate space the panel will occupy when it mounts.
   */
  const openDetail = (id: string) => {
    const root = rootRef.current;
    const trigger = triggers.current.get(id);
    if (!root || !trigger) {
      onOpen(id, DEFAULT_ANCHOR);
      return;
    }
    const panel = root.getBoundingClientRect();
    const rect = trigger.getBoundingClientRect();
    const width = Math.max(1, panel.width - PANEL_INSET * 2);
    const height = Math.max(1, panel.height - PANEL_INSET * 2);
    const clamp = (value: number) => Math.min(100, Math.max(0, value));
    onOpen(id, {
      x: clamp(((rect.left + rect.width / 2 - (panel.left + PANEL_INSET)) / width) * 100),
      y: clamp(((rect.top + rect.height / 2 - (panel.top + PANEL_INSET)) / height) * 100),
    });
  };

  return (
    <div ref={rootRef} className="p4-cards" data-engine={mode}>
      <div className="p4-cards__head">
        <div>
          <strong>Proyectos del workspace</strong>
          <span className="p4-hint">hover · press · detalle · spotlight · agente</span>
        </div>
        <span className="cmp-badge">
          {mode === 'animate' ? CARDS.length + 2 : CARDS.length} tarjetas
        </span>
      </div>

      <div ref={gridRef} className="p4-cards__grid">
        {CARDS.map((item) =>
          mode === 'animate' ? (
            <motion.button
              key={item.id}
              ref={(node) => {
                triggers.current.set(item.id, node);
              }}
              type="button"
              className="p4-card p4-card--live"
              layoutId={`p4-card-${item.id}`}
              initial={{ scale: 1 }}
              whileHover={
                reduce ? undefined : { y: -lift, transition: motionTokens.springs.highlight }
              }
              whileTap={
                reduce
                  ? undefined
                  : { scale: motionTokens.scale.press, transition: motionTokens.springs.press }
              }
              transition={motionTokens.springs.dialog}
              onClick={() => openDetail(item.id)}
              aria-haspopup="dialog"
            >
              <span className="p4-card__cover" aria-hidden="true">
                <span className="p4-card__cover-art" data-tone={item.cover} />
              </span>
              <span className="p4-card__tag">{item.tag}</span>
              <motion.span
                className="p4-card__title"
                layoutId={`p4-card-title-${item.id}`}
                transition={motionTokens.springs.dialog}
              >
                {item.title}
              </motion.span>
              <span className="p4-card__blurb">{item.blurb}</span>
              <span className="p4-card__foot">
                <span>{item.meta[0]}</span>
                <span className="p4-card__open">Abrir</span>
              </span>
            </motion.button>
          ) : (
            <button
              key={item.id}
              ref={(node) => {
                triggers.current.set(item.id, node);
              }}
              type="button"
              className="p4-card p4-card--kite"
              onClick={() => openDetail(item.id)}
              aria-haspopup="dialog"
            >
              <span className="p4-card__tag">{item.tag}</span>
              <span className="p4-card__title">{item.title}</span>
              <span className="p4-card__blurb">{item.blurb}</span>
              <span className="p4-card__foot">
                <span>{item.meta[0]}</span>
                <span className="p4-card__open">Abrir</span>
              </span>
            </button>
          )
        )}
      </div>

      {mode === 'animate' && (
        <div ref={extrasRef} className="p4-cards__extras">
          <div className="p4-cards__extras-head">
            <span className="p4-label">Firmas nuevas</span>
            <span className="p4-hint">solo Animate UI</span>
          </div>
          <div className="p4-cards__extras-grid">
            <SpotlightCard />
            <AgentCard />
          </div>
        </div>
      )}

      {mode === 'kite' ? (
        <KiteDetail
          open={open !== null}
          card={card}
          focusSelf={open?.origin === mode}
          panelRef={panelRef}
          onClose={onClose}
        />
      ) : (
        <AnimateDetail
          open={card}
          anchor={open?.anchor}
          focusSelf={open?.origin === mode}
          panelRef={panelRef}
          onClose={onClose}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* New signatures: spotlight tilt card and agent/profile card                  */
/* -------------------------------------------------------------------------- */

function SpotlightCard() {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const cardRef = useRef<HTMLDivElement>(null);
  const [lit, setLit] = useState(false);
  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const tiltX = useMotionValue(0);
  const tiltY = useMotionValue(0);
  const glowX = useSpring(pointerX, motionTokens.springs.highlight);
  const glowY = useSpring(pointerY, motionTokens.springs.highlight);
  const rotateX = useSpring(tiltX, motionTokens.springs.pop);
  const rotateY = useSpring(tiltY, motionTokens.springs.pop);
  const maxTilt = Math.min(5, motionTokens.travel(2));

  useEffect(() => {
    if (!reduce) return;
    setLit(false);
    pointerX.set(0);
    pointerY.set(0);
    tiltX.set(0);
    tiltY.set(0);
  }, [reduce, pointerX, pointerY, tiltX, tiltY]);

  const track = (event: ReactPointerEvent<HTMLDivElement>) => {
    const node = cardRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    pointerX.set(x - rect.width / 2);
    pointerY.set(y - rect.height / 2);
    rotateY.set((x / rect.width - 0.5) * maxTilt);
    rotateX.set(-(y / rect.height - 0.5) * maxTilt);
  };

  const reset = () => {
    setLit(false);
    pointerX.set(0);
    pointerY.set(0);
    tiltX.set(0);
    tiltY.set(0);
  };

  const onPointerEnter = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (reduce || event.pointerType !== 'mouse') return;
    setLit(true);
    track(event);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (reduce || event.pointerType !== 'mouse') return;
    track(event);
  };

  return (
    <motion.div
      ref={cardRef}
      className={`p4-card p4-spot${lit && !reduce ? ' is-lit' : ''}`}
      style={reduce ? undefined : { rotateX, rotateY, transformPerspective: 760 }}
      onPointerEnter={onPointerEnter}
      onPointerMove={onPointerMove}
      onPointerLeave={reset}
      onPointerCancel={reset}
    >
      {!reduce && (
        <motion.span
          className="p4-spot__glow"
          aria-hidden="true"
          style={{ x: glowX, y: glowY }}
        />
      )}
      <span className="p4-card__tag">spotlight</span>
      <span className="p4-card__title">Foco del puntero</span>
      <span className="p4-card__blurb">
        La luz sigue al puntero; la tarjeta se inclina apenas y vuelve sola al salir.
      </span>
      <span className="p4-spot__foot">rotateX · rotateY · spring.pop</span>
    </motion.div>
  );
}

function AgentCard() {
  const reduce = useLabReduce();
  const cardRef = useRef<HTMLDivElement>(null);
  const inView = useInView(cardRef, { amount: 0.4 });
  const [tabVisible, setTabVisible] = useState(() => document.visibilityState !== 'hidden');
  const [statusIndex, setStatusIndex] = useState(0);
  const [pinned, setPinned] = useState(false);
  const status = AGENT_STATUS[statusIndex];
  const pulse = inView && tabVisible && !reduce;

  useEffect(() => {
    const onVisibility = () => setTabVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  return (
    <div ref={cardRef} className={`p4-card p4-agent${pinned ? ' is-pinned' : ''}`}>
      <div className="p4-agent__top">
        <span className="p4-agent__avatar" aria-hidden="true">
          <span className="p4-agent__face">MC</span>
          <span className={`p4-agent__dot p4-agent__dot--${status.tone}`}>
            {pulse && (
              <motion.span
                className="p4-agent__pulse"
                initial={{ scale: 1, opacity: 0.6 }}
                animate={{ scale: 2.3, opacity: 0 }}
                transition={{ duration: 2.1, ease: 'easeOut', repeat: Infinity, repeatDelay: 0.35 }}
              />
            )}
          </span>
        </span>
        <span className="p4-agent__id">
          <strong>Mira Chen</strong>
          <span>Diseño de producto</span>
        </span>
        <span className="p4-agent__pin" data-on={pinned} aria-hidden={!pinned}>
          fijada
        </span>
      </div>

      <div className="p4-agent__statusrow">
        <span className="p4-agent__status" role="status">
          <SwapLabel value={status.label} labels={AGENT_LABELS} />
        </span>
        <span className="p4-hint">respuesta ~2 min</span>
      </div>

      <div className="p4-agent__actions" role="group" aria-label="Acciones de Mira">
        <SceneButton
          mode="animate"
          variant="ghost"
          className="cmp-btn--sm"
          onClick={() => setStatusIndex((index) => (index + 1) % AGENT_STATUS.length)}
        >
          Estado
        </SceneButton>
        <SceneButton
          mode="animate"
          variant="ghost"
          className="cmp-btn--sm"
          aria-pressed={pinned}
          onClick={() => setPinned((value) => !value)}
        >
          Fijar
        </SceneButton>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Detail                                                                      */
/* -------------------------------------------------------------------------- */

function CardDetailBody({
  card,
  mode,
  onClose,
}: {
  card: LabCard;
  mode: CompareVariant;
  onClose: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const animate = mode === 'animate';

  const block: Variants | undefined = animate
    ? {
        hidden: reduce
          ? { opacity: 0 }
          : { opacity: 0, y: motionTokens.travel(5), filter: motionTokens.itemBlur },
        show: {
          opacity: 1,
          y: 0,
          filter: 'blur(0px)',
          transition: {
            y: motionTokens.springs.reflow,
            opacity: motionTokens.tweens.fade,
            filter: motionTokens.tweens.fade,
          },
        },
        exit: { opacity: 0, transition: motionTokens.tweens.swap },
      }
    : undefined;

  return (
    <>
      <div className="p4-cards__detail-head">
        <div className="p4-cards__detail-copy">
          <motion.span className="p4-card__tag" variants={block}>
            {card.tag}
          </motion.span>
          {animate ? (
            <motion.h3
              layoutId={`p4-card-title-${card.id}`}
              transition={motionTokens.springs.dialog}
            >
              {card.title}
            </motion.h3>
          ) : (
            <h3>{card.title}</h3>
          )}
        </div>
        <SceneButton mode={mode} variant="icon" aria-label="Cerrar detalle" onClick={onClose}>
          <CloseIcon size={12} />
        </SceneButton>
      </div>
      <motion.p className="p4-cards__detail-body" variants={block}>
        {card.body}
      </motion.p>
      <motion.div className="p4-cards__detail-meta" variants={block}>
        {card.meta.map((item) => (
          <span key={item} className="cmp-badge">
            {item}
          </span>
        ))}
      </motion.div>
      <motion.p className="p4-cards__detail-note" variants={block}>
        El detalle conserva el fondo, el borde y el radio de la tarjeta para que el cambio se lea
        como un solo objeto.
      </motion.p>
      <div className="p4-cards__detail-foot">
        <SceneButton mode={mode} variant="primary" className="cmp-btn--sm" onClick={onClose}>
          Cerrar detalle
        </SceneButton>
      </div>
    </>
  );
}

function KiteDetail({
  open,
  card,
  focusSelf,
  panelRef,
  onClose,
}: {
  open: boolean;
  card: LabCard | null;
  focusSelf: boolean;
  panelRef: RefObject<HTMLDivElement>;
  onClose: () => void;
}) {
  const presence = usePresence(open);
  const lastCard = useRef<LabCard | null>(null);
  if (card) lastCard.current = card;
  const shown = card ?? lastCard.current;

  useEffect(() => {
    if (!presence.mounted || !focusSelf) return undefined;
    const frame = requestAnimationFrame(() => panelRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [presence.mounted, focusSelf, panelRef]);

  if (!presence.mounted || !shown) return null;

  return (
    <>
      <div
        className={`p4-cards__detail-scrim ${motionSurfaceClass(presence.phase, 'scrim')}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={shown.title}
        className={`p4-cards__detail ${motionSurfaceClass(presence.phase, 'modal')}`}
      >
        <CardDetailBody card={shown} mode="kite" onClose={onClose} />
      </div>
    </>
  );
}

function AnimateDetail({
  open,
  anchor,
  focusSelf,
  panelRef,
  onClose,
}: {
  open: LabCard | null;
  anchor?: OpenAnchor;
  focusSelf: boolean;
  panelRef: RefObject<HTMLDivElement>;
  onClose: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const origin = anchor ?? DEFAULT_ANCHOR;

  useEffect(() => {
    if (!open || !focusSelf) return undefined;
    const frame = requestAnimationFrame(() => panelRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, focusSelf, panelRef]);

  /**
   * The panel morphs from the card on `spring.dialog` (layoutId). The content
   * settles from the card's measured center, and everything the card did not
   * already show arrives after the frame starts moving.
   */
  const content: Variants = {
    hidden: reduce ? {} : { scale: motionTokens.scale.choice },
    show: {
      scale: 1,
      transition: {
        ...motionTokens.springs.dialog,
        staggerChildren: reduce ? 0 : motionTokens.stagger,
        delayChildren: reduce ? 0 : motionTokens.tweens.swap.duration / 2,
      },
    },
    exit: {},
  };

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            key="scrim"
            className="p4-cards__detail-scrim"
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
            key="panel"
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={open.title}
            className="p4-cards__detail"
            layoutId={`p4-card-${open.id}`}
            transition={motionTokens.springs.dialog}
            exit={{ opacity: 0, transition: motionTokens.tweens.dismiss }}
          >
            <motion.div
              className="p4-cards__detail-inner"
              style={{ transformOrigin: `${origin.x}% ${origin.y}%` }}
              initial="hidden"
              animate="show"
              exit="exit"
              variants={content}
            >
              <CardDetailBody card={open} mode="animate" onClose={onClose} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
