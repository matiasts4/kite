import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  AnimatePresence,
  Reorder,
  animate,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useScroll,
  useSpring,
  type PanInfo,
} from 'motion/react';
import { isAtLiveEdge, prefersReducedMotion } from '../../../contract';
import { motionSurfaceClass } from '../../../surface';
import { usePresence } from '../../../usePresence';
import { useLabMotion, useLabReduce } from '../../context';
import {
  CompareScene,
  SceneButton,
  type CompareVariant,
  type CompareView,
} from '../../frame';
import { ArrowRightIcon, CloseIcon, PlusIcon } from '../../ui';
import './gestures.css';

/* -------------------------------------------------------------------------- */
/* 08.01 — Shared element: card → detail                                       */
/* -------------------------------------------------------------------------- */

type ProjectTone = 'blue' | 'green' | 'amber';

interface Project {
  id: string;
  title: string;
  meta: string;
  body: string;
  tone: ProjectTone;
  files: string[];
}

const PROJECTS: Project[] = [
  {
    id: 'transcript',
    title: 'Transcript vivo',
    meta: '3 archivos',
    body: 'El borde vivo decide si el transcript acompaña o espera a que vuelvas.',
    tone: 'blue',
    files: ['chat/transcript.tsx', 'motion/contract.ts', 'usePresence.ts'],
  },
  {
    id: 'kanban',
    title: 'Tablero',
    meta: '12 tareas',
    body: 'Las tarjetas cambian de columna sin perder su identidad ni su lugar.',
    tone: 'green',
    files: ['tasks/board.tsx', 'tasks/card.tsx', 'useDropTarget.ts'],
  },
  {
    id: 'preview',
    title: 'Preview',
    meta: '9 páginas',
    body: 'Cada página compara el mismo estado con dos motores y un solo control.',
    tone: 'amber',
    files: ['animate/frame.tsx', 'animate/tokens.ts', 'pages/registry.ts'],
  },
];

function ProjectDetail({
  mode,
  project,
  onClose,
}: {
  mode: CompareVariant;
  project: Project;
  onClose: () => void;
}) {
  const motionTokens = useLabMotion();
  const isAnimate = mode === 'animate';

  return (
    <>
      {isAnimate ? (
        <motion.span
          layoutId={`p8-project-cover-${project.id}`}
          className={`p8-detail__cover p8-card__art--${project.tone}`}
          aria-hidden="true"
          transition={motionTokens.springs.dialog}
        />
      ) : (
        <span
          className={`p8-detail__cover p8-card__art--${project.tone}`}
          aria-hidden="true"
        />
      )}

      <div className="p8-detail__body">
        <div className="p8-detail__head">
          {isAnimate ? (
            <motion.strong
              layoutId={`p8-project-title-${project.id}`}
              className="p8-detail__title"
              transition={motionTokens.springs.dialog}
            >
              {project.title}
            </motion.strong>
          ) : (
            <strong className="p8-detail__title">{project.title}</strong>
          )}
          <span className="cmp-badge">{project.meta}</span>
          <SceneButton
            mode={mode}
            variant="icon"
            className="p8-detail__close"
            onClick={onClose}
            aria-label="Cerrar detalle"
          >
            <CloseIcon size={12} />
          </SceneButton>
        </div>

        {isAnimate ? (
          <motion.div
            className="p8-detail__content"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0, transition: motionTokens.tweens.reveal }}
          >
            <p>{project.body}</p>
            <ul>
              {project.files.map((file) => (
                <li key={file}>{file}</li>
              ))}
            </ul>
          </motion.div>
        ) : (
          <div className="p8-detail__content">
            <p>{project.body}</p>
            <ul>
              {project.files.map((file) => (
                <li key={file}>{file}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="p8-detail__foot">
          <SceneButton mode={mode} variant="ghost" onClick={onClose}>
            Volver
          </SceneButton>
        </div>
      </div>
    </>
  );
}

function SharedElementPane({
  mode,
  open,
  owner,
  shown,
  onOpen,
  onClose,
}: {
  mode: CompareVariant;
  open: string | null;
  owner: CompareVariant | null;
  shown: Project | null;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open !== null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const lastOpenId = useRef<string | null>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    const becameOpen = open !== null && !wasOpen.current;
    const becameClosed = open === null && wasOpen.current;
    wasOpen.current = open !== null;
    if (owner !== mode) return;
    if (becameOpen) {
      lastOpenId.current = open;
      panelRef.current?.focus();
      return;
    }
    if (becameClosed && lastOpenId.current) {
      const id = lastOpenId.current;
      lastOpenId.current = null;
      triggers.current.get(id)?.focus();
    }
  }, [open, owner, mode]);

  useEffect(() => {
    if (open === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const baseContent = (
    <>
      <span className="p8-kicker">Proyectos</span>
      <div className="p8-cards">
        {PROJECTS.map((project) =>
          mode === 'animate' ? (
            <motion.button
              key={project.id}
              type="button"
              layoutId={`p8-project-${project.id}`}
              className="p8-card"
              ref={(element) => {
                if (element) triggers.current.set(project.id, element);
              }}
              onClick={() => onOpen(project.id)}
              whileTap={
                reduce
                  ? undefined
                  : {
                      scale: motionTokens.scale.choice,
                      transition: motionTokens.springs.press,
                    }
              }
              transition={motionTokens.springs.dialog}
            >
              <motion.span
                layoutId={`p8-project-cover-${project.id}`}
                className={`p8-card__art p8-card__art--${project.tone}`}
                aria-hidden="true"
                transition={motionTokens.springs.dialog}
              />
              <motion.span
                layoutId={`p8-project-title-${project.id}`}
                className="p8-card__title"
                transition={motionTokens.springs.dialog}
              >
                {project.title}
              </motion.span>
              <span className="p8-card__meta">{project.meta}</span>
            </motion.button>
          ) : (
            <button
              key={project.id}
              type="button"
              className="p8-card"
              ref={(element) => {
                if (element) triggers.current.set(project.id, element);
              }}
              onClick={() => onOpen(project.id)}
            >
              <span
                className={`p8-card__art p8-card__art--${project.tone}`}
                aria-hidden="true"
              />
              <span className="p8-card__title">{project.title}</span>
              <span className="p8-card__meta">{project.meta}</span>
            </button>
          )
        )}
      </div>
      <p className="p8-shared__hint">
        {mode === 'animate'
          ? 'Abrí una tarjeta: la superficie viaja y la capa nueva queda arriba.'
          : 'Abrí una tarjeta: un modal fundido, sin elemento compartido.'}
      </p>
    </>
  );

  return (
    <div className="p8-shared">
      {mode === 'animate' ? (
        <motion.div
          className="p8-shared__base"
          animate={{ opacity: open !== null ? 0.3 : 1 }}
          transition={motionTokens.tweens.fade}
          aria-hidden={open !== null ? true : undefined}
        >
          {baseContent}
        </motion.div>
      ) : (
        <div
          className={`p8-shared__base${open !== null ? ' is-veiled' : ''}`}
          aria-hidden={open !== null ? true : undefined}
        >
          {baseContent}
        </div>
      )}

      <div className="p8-shared__layer">
        {mode === 'kite' ? (
          presence.mounted && shown ? (
            <>
              <div
                className={`p8-shared__scrim ${motionSurfaceClass(presence.phase, 'scrim')}`}
                onClick={onClose}
                aria-hidden="true"
              />
              <div
                ref={panelRef}
                tabIndex={-1}
                className={`p8-detail ${motionSurfaceClass(presence.phase, 'modal')}`}
                role="dialog"
                aria-modal="true"
                aria-label={shown.title}
              >
                <ProjectDetail mode={mode} project={shown} onClose={onClose} />
              </div>
            </>
          ) : null
        ) : (
          <AnimatePresence>
            {open !== null && shown && (
              <motion.div
                key="scrim"
                className="p8-shared__scrim"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: motionTokens.tweens.overlay }}
                exit={{ opacity: 0, transition: motionTokens.tweens.overlay }}
                onClick={onClose}
                aria-hidden="true"
              />
            )}
            {open !== null && shown && (
              <motion.div
                key={`panel-${shown.id}`}
                ref={panelRef}
                tabIndex={-1}
                layoutId={`p8-project-${shown.id}`}
                className="p8-detail"
                role="dialog"
                aria-modal="true"
                aria-label={shown.title}
                transition={motionTokens.springs.dialog}
              >
                <ProjectDetail mode={mode} project={shown} onClose={onClose} />
              </motion.div>
            )}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}

function SharedElementScene({ view }: { view: CompareView }) {
  const [open, setOpen] = useState<string | null>(null);
  const [lastOpen, setLastOpen] = useState<string | null>(null);
  const [owner, setOwner] = useState<CompareVariant | null>(null);

  useEffect(() => {
    if (open !== null) setLastOpen(open);
  }, [open]);

  const shownId = open ?? lastOpen;
  const shown = PROJECTS.find((project) => project.id === shownId) ?? null;

  return (
    <CompareScene
      index="01"
      title="Elemento compartido"
      target="TaskCard → TaskDetail"
      note="La misma tarjeta se abre en detalle: Animate UI comparte la superficie, la portada y el título con layoutId, y la capa nueva se dibuja por encima de la grilla que se apaga. Kite funde un modal y no comparte nada. Escape o Volver cierran."
      view={view}
    >
      {(mode) => (
        <SharedElementPane
          mode={mode}
          open={open}
          owner={owner}
          shown={shown}
          onOpen={(id) => {
            setOwner(mode);
            setOpen(id);
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </CompareScene>
  );
}

/* -------------------------------------------------------------------------- */
/* 08.02 — Reorder                                                             */
/* -------------------------------------------------------------------------- */

const REORDER_LABELS: Record<string, string> = {
  context: 'Contexto',
  tools: 'Herramientas',
  permissions: 'Permisos',
  checks: 'Verificación',
  delivery: 'Entrega',
};

const INITIAL_ORDER = ['context', 'tools', 'permissions', 'checks', 'delivery'];

function ReorderPane({
  mode,
  order,
  note,
  owner,
  onReorder,
}: {
  mode: CompareVariant;
  order: string[];
  note: string;
  owner: CompareVariant | null;
  onReorder: (next: string[], movedId: string) => void;
}) {
  const motionTokens = useLabMotion();
  const rowRefs = useRef(new Map<string, HTMLElement>());

  const place = (id: string, direction: -1 | 1) => {
    const index = order.indexOf(id);
    const to = index + direction;
    if (index < 0 || to < 0 || to >= order.length) return;
    const next = [...order];
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved);
    onReorder(next, id);
    requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
  };

  const actions = (id: string, index: number) => (
    <span className="p8-reorder__actions">
      <SceneButton
        mode={mode}
        variant="ghost"
        className="p8-mini"
        aria-label={`Subir ${REORDER_LABELS[id]}`}
        disabled={index === 0}
        onClick={() => place(id, -1)}
      >
        ↑
      </SceneButton>
      <SceneButton
        mode={mode}
        variant="ghost"
        className="p8-mini"
        aria-label={`Bajar ${REORDER_LABELS[id]}`}
        disabled={index === order.length - 1}
        onClick={() => place(id, 1)}
      >
        ↓
      </SceneButton>
    </span>
  );

  return (
    <div className="p8-reorder-scene">
      <span className="p8-kicker">Orden de ejecución</span>

      {mode === 'animate' ? (
        <Reorder.Group
          as="ol"
          axis="y"
          className="p8-reorder"
          values={order}
          onReorder={(next: string[]) => onReorder(next, '')}
          aria-label="Orden de ejecución"
        >
          {order.map((id, index) => (
            <Reorder.Item
              as="li"
              key={id}
              value={id}
              className="p8-reorder__row is-draggable"
              ref={(element: HTMLElement | null) => {
                if (element) rowRefs.current.set(id, element);
              }}
              tabIndex={-1}
              transition={motionTokens.springs.reflow}
              whileDrag={{ zIndex: 2, boxShadow: '0 12px 28px rgba(0, 0, 0, 0.45)' }}
            >
              <span className="p8-reorder__grip" aria-hidden="true">
                ⠿
              </span>
              <span className="p8-reorder__label">{REORDER_LABELS[id]}</span>
              <span className="p8-reorder__pos">{index + 1}</span>
              {actions(id, index)}
            </Reorder.Item>
          ))}
        </Reorder.Group>
      ) : (
        <ol className="p8-reorder" aria-label="Orden de ejecución">
          {order.map((id, index) => (
            <li
              key={id}
              className="p8-reorder__row"
              ref={(element) => {
                if (element) rowRefs.current.set(id, element);
              }}
              tabIndex={-1}
            >
              <span className="p8-reorder__pos">{index + 1}</span>
              <span className="p8-reorder__label">{REORDER_LABELS[id]}</span>
              {actions(id, index)}
            </li>
          ))}
        </ol>
      )}

      <p className="p8-note" aria-live={owner === mode ? 'polite' : 'off'}>
        {note ||
          (mode === 'animate'
            ? 'Arrastrá una fila o usá ↑ ↓: los vecinos abren lugar.'
            : 'Kite mueve la fila con ↑ ↓ y el orden salta.')}
      </p>
    </div>
  );
}

function ReorderScene({ view }: { view: CompareView }) {
  const [order, setOrder] = useState(INITIAL_ORDER);
  const [note, setNote] = useState('');
  const [owner, setOwner] = useState<CompareVariant | null>(null);

  const commit = (next: string[], movedId: string, from: CompareVariant) => {
    setOrder(next);
    setOwner(from);
    const position = next.indexOf(movedId) + 1;
    setNote(`${REORDER_LABELS[movedId]} pasó a la posición ${position}.`);
  };

  return (
    <CompareScene
      index="02"
      title="Reordenar"
      target="TaskList · reorder"
      note="Una lista de cinco pasos. En Animate UI la fila se arrastra y los vecinos abren lugar con spring.reflow; en Kite solo mueven los botones y el orden salta. ↑ ↓ son el camino de teclado en ambas columnas y el foco queda en la fila movida."
      view={view}
    >
      {(mode) => (
        <ReorderPane
          mode={mode}
          order={order}
          note={note}
          owner={owner}
          onReorder={(next, movedId) => commit(next, movedId, mode)}
        />
      )}
    </CompareScene>
  );
}

/* -------------------------------------------------------------------------- */
/* 08.03 — Kanban drag and drop                                                */
/* -------------------------------------------------------------------------- */

type KanbanColumnId = 'todo' | 'doing' | 'done';

interface KanbanTask {
  id: string;
  title: string;
  tag: string;
}

type KanbanBoard = Record<KanbanColumnId, KanbanTask[]>;

const KANBAN_COLUMNS: { id: KanbanColumnId; label: string }[] = [
  { id: 'todo', label: 'Pendiente' },
  { id: 'doing', label: 'En curso' },
  { id: 'done', label: 'Listo' },
];

const KANBAN_SEED: KanbanBoard = {
  todo: [
    { id: 'prepare', title: 'Preparar el diff', tag: 'git' },
    { id: 'contract', title: 'Revisar el contrato', tag: 'motion' },
  ],
  doing: [{ id: 'transcript', title: 'Transcript vivo', tag: 'scroll' }],
  done: [{ id: 'preview', title: 'Preview 08', tag: 'gestos' }],
};

const KANBAN_LABELS: Record<KanbanColumnId, string> = {
  todo: 'Pendiente',
  doing: 'En curso',
  done: 'Listo',
};

function moveTaskInBoard(board: KanbanBoard, taskId: string, to: KanbanColumnId): KanbanBoard {
  const from = KANBAN_COLUMNS.find((column) =>
    board[column.id].some((task) => task.id === taskId)
  )?.id;
  if (!from || from === to) return board;
  const task = board[from].find((item) => item.id === taskId);
  if (!task) return board;
  return {
    ...board,
    [from]: board[from].filter((item) => item.id !== taskId),
    [to]: [...board[to], task],
  };
}

function KanbanDragCard({
  task,
  column,
  constraints,
  columnAt,
  onLift,
  onHover,
  onDrop,
  children,
}: {
  task: KanbanTask;
  column: KanbanColumnId;
  constraints: RefObject<HTMLDivElement>;
  columnAt: (point: { x: number; y: number }) => KanbanColumnId | null;
  onLift: (column: KanbanColumnId | null) => void;
  onHover: (column: KanbanColumnId | null) => void;
  onDrop: (taskId: string, to: KanbanColumnId) => void;
  children: ReactNode;
}) {
  const motionTokens = useLabMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);

  const snapBack = () => {
    const spring = motionTokens.springs.reflow;
    if ('stiffness' in spring) {
      const options = {
        type: 'spring' as const,
        stiffness: spring.stiffness,
        damping: spring.damping,
        restSpeed: spring.restSpeed,
        restDelta: spring.restDelta,
      };
      animate(x, 0, options);
      animate(y, 0, options);
      return;
    }
    animate(x, 0, {
      type: 'spring' as const,
      visualDuration: spring.visualDuration,
      bounce: spring.bounce,
    });
    animate(y, 0, {
      type: 'spring' as const,
      visualDuration: spring.visualDuration,
      bounce: spring.bounce,
    });
  };

  return (
    <motion.div
      layoutId={`p8-kanban-${task.id}`}
      layout="position"
      drag
      dragConstraints={constraints}
      dragElastic={0.12}
      dragMomentum={false}
      onDragStart={() => onLift(column)}
      onDrag={(_event: unknown, info: PanInfo) => onHover(columnAt(info.point))}
      onDragEnd={(_event: unknown, info: PanInfo) => {
        const target = columnAt(info.point);
        onHover(null);
        onLift(null);
        if (target && target !== column) {
          onDrop(task.id, target);
          return;
        }
        snapBack();
      }}
      whileDrag={{ zIndex: 20, boxShadow: '0 14px 30px rgba(0, 0, 0, 0.5)' }}
      transition={motionTokens.springs.reflow}
      style={{ x, y }}
      className="p8-kanban__card p8-kanban__card--draggable"
    >
      <span className="p8-kanban__title">{task.title}</span>
      <span className="p8-kanban__tag">{task.tag}</span>
      {children}
    </motion.div>
  );
}

function KanbanPane({
  mode,
  board,
  note,
  owner,
  onMove,
}: {
  mode: CompareVariant;
  board: KanbanBoard;
  note: string;
  owner: CompareVariant | null;
  onMove: (taskId: string, to: KanbanColumnId) => void;
}) {
  const boardRef = useRef<HTMLDivElement>(null);
  const columnRefs = useRef(new Map<KanbanColumnId, HTMLElement>());
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const [dragging, setDragging] = useState<string | null>(null);
  const [liftedFrom, setLiftedFrom] = useState<KanbanColumnId | null>(null);
  const [hover, setHover] = useState<KanbanColumnId | null>(null);

  const columnAt = (point: { x: number; y: number }): KanbanColumnId | null => {
    const clientX = point.x - window.scrollX;
    const clientY = point.y - window.scrollY;
    for (const column of KANBAN_COLUMNS) {
      const element = columnRefs.current.get(column.id);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      ) {
        return column.id;
      }
    }
    return null;
  };

  const focusCard = (taskId: string) => {
    requestAnimationFrame(() => cardRefs.current.get(taskId)?.focus());
  };

  const shiftTask = (column: KanbanColumnId) => {
    const index = KANBAN_COLUMNS.findIndex((item) => item.id === column);
    return { previous: KANBAN_COLUMNS[index - 1], next: KANBAN_COLUMNS[index + 1] };
  };

  const moves = (task: KanbanTask, column: KanbanColumnId) => {
    const { previous, next } = shiftTask(column);
    return (
      <span className="p8-kanban__moves">
        <SceneButton
          mode={mode}
          variant="ghost"
          className="p8-mini"
          disabled={!previous}
          aria-label={previous ? `Mover ${task.title} a ${previous.label}` : 'Ya está en la primera columna'}
          onClick={() => {
            if (!previous) return;
            onMove(task.id, previous.id);
            focusCard(task.id);
          }}
        >
          ←
        </SceneButton>
        <SceneButton
          mode={mode}
          variant="ghost"
          className="p8-mini"
          disabled={!next}
          aria-label={next ? `Mover ${task.title} a ${next.label}` : 'Ya está en la última columna'}
          onClick={() => {
            if (!next) return;
            onMove(task.id, next.id);
            focusCard(task.id);
          }}
        >
          →
        </SceneButton>
      </span>
    );
  };

  return (
    <div className="p8-kanban-scene">
      <div className="p8-kanban" ref={boardRef}>
        {KANBAN_COLUMNS.map((column) => (
          <section
            key={column.id}
            ref={(element) => {
              if (element) columnRefs.current.set(column.id, element);
            }}
            className={`p8-kanban__col${hover === column.id ? ' is-over' : ''}`}
            aria-label={column.label}
            onDragOver={
              mode === 'kite'
                ? (event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    setHover(column.id);
                  }
                : undefined
            }
            onDragLeave={
              mode === 'kite'
                ? (event) => {
                    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                    setHover((current) => (current === column.id ? null : current));
                  }
                : undefined
            }
            onDrop={
              mode === 'kite'
                ? (event) => {
                    event.preventDefault();
                    const taskId = event.dataTransfer.getData('text/plain') || dragging;
                    if (taskId) {
                      onMove(taskId, column.id);
                      focusCard(taskId);
                    }
                    setDragging(null);
                    setLiftedFrom(null);
                    setHover(null);
                  }
                : undefined
            }
          >
            <header className="p8-kanban__head">
              <span>{column.label}</span>
              <span className="p8-kanban__count">{board[column.id].length}</span>
            </header>

            <div className="p8-kanban__stack">
              {board[column.id].map((task) =>
                mode === 'animate' ? (
                  <div
                    key={task.id}
                    ref={(element) => {
                      if (element) cardRefs.current.set(task.id, element);
                    }}
                    tabIndex={-1}
                    className="p8-kanban__card-slot"
                  >
                    <KanbanDragCard
                      task={task}
                      column={column.id}
                      constraints={boardRef}
                      columnAt={columnAt}
                      onLift={setLiftedFrom}
                      onHover={setHover}
                      onDrop={onMove}
                    >
                      {moves(task, column.id)}
                    </KanbanDragCard>
                  </div>
                ) : (
                  <div
                    key={task.id}
                    ref={(element) => {
                      if (element) cardRefs.current.set(task.id, element);
                    }}
                    tabIndex={-1}
                    className={`p8-kanban__card${dragging === task.id ? ' is-dragging' : ''}`}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData('text/plain', task.id);
                      event.dataTransfer.effectAllowed = 'move';
                      setDragging(task.id);
                      setLiftedFrom(column.id);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setLiftedFrom(null);
                      setHover(null);
                    }}
                  >
                    <span className="p8-kanban__title">{task.title}</span>
                    <span className="p8-kanban__tag">{task.tag}</span>
                    {moves(task, column.id)}
                  </div>
                )
              )}

              {hover === column.id && hover !== liftedFrom && (
                <div className="p8-kanban__slot" aria-hidden="true">
                  Soltar acá
                </div>
              )}
            </div>
          </section>
        ))}
      </div>

      <p className="p8-note" aria-live={owner === mode ? 'polite' : 'off'}>
        {note ||
          (mode === 'animate'
            ? 'Arrastrá una tarjeta: se levanta, marca el destino y aterriza.'
            : 'Arrastrá con el drag nativo o mové con ← →.')}
      </p>
    </div>
  );
}

function KanbanScene({ view }: { view: CompareView }) {
  const [board, setBoard] = useState<KanbanBoard>(KANBAN_SEED);
  const [note, setNote] = useState('');
  const [owner, setOwner] = useState<CompareVariant | null>(null);

  const move = (taskId: string, to: KanbanColumnId, from: CompareVariant) => {
    const task = KANBAN_COLUMNS.flatMap((column) => board[column.id]).find(
      (item) => item.id === taskId
    );
    const source = KANBAN_COLUMNS.find((column) =>
      board[column.id].some((item) => item.id === taskId)
    )?.id;
    if (!task || !source || source === to) return;
    setBoard((current) => moveTaskInBoard(current, taskId, to));
    setOwner(from);
    setNote(`${task.title} pasó a ${KANBAN_LABELS[to]}.`);
  };

  return (
    <CompareScene
      index="03"
      title="Arrastrar y soltar"
      target="KanbanBoard · drag & drop"
      note="Un tablero de tres columnas. En Animate UI la tarjeta se levanta con el puntero, la columna destino muestra el hueco y el drop aterriza con spring; las demás cierran el lugar. Kite arrastra con el drag nativo y el cambio es inmediato. ← → son la alternativa de teclado."
      view={view}
    >
      {(mode) => (
        <KanbanPane
          mode={mode}
          board={board}
          note={note}
          owner={owner}
          onMove={(taskId, to) => move(taskId, to, mode)}
        />
      )}
    </CompareScene>
  );
}

/* -------------------------------------------------------------------------- */
/* 08.04 — Scroll: progress, reveal, edge fade, live edge                      */
/* -------------------------------------------------------------------------- */

interface ScrollLine {
  id: string;
  kind: 'user' | 'assistant' | 'tool';
  text: string;
}

const SCROLL_SEED: ScrollLine[] = [
  { id: 's1', kind: 'user', text: '¿Seguís el borde vivo cuando llega una línea?' },
  {
    id: 's2',
    kind: 'assistant',
    text: 'Solo si ya estabas abajo. Si estás leyendo arriba, te dejo quieto.',
  },
  { id: 's3', kind: 'tool', text: 'Leyó src/motion/contract.ts' },
  { id: 's4', kind: 'assistant', text: 'El umbral es 48 px y el alto nuevo se suma al scroll.' },
  { id: 's5', kind: 'user', text: 'Mostrame el progreso y el degradado del borde.' },
  { id: 's6', kind: 'assistant', text: 'Progreso en la barra, fades arriba y abajo, y las secciones entran al verlas.' },
];

const NEXT_LINES: { kind: ScrollLine['kind']; text: string }[] = [
  { kind: 'assistant', text: 'El borde vivo mide la distancia al final antes de sumar la fila.' },
  { kind: 'tool', text: 'Actualizó el ancla del transcript' },
  { kind: 'user', text: 'Si estoy arriba, avisame con una pastilla.' },
  { kind: 'assistant', text: 'La pastilla aparece solo cuando llegó algo nuevo.' },
];

function ScrollPane({
  mode,
  lines,
  onAdd,
}: {
  mode: CompareVariant;
  lines: ScrollLine[];
  onAdd: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const viewportRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const percentRef = useRef<HTMLSpanElement>(null);
  const atEdgeRef = useRef(true);
  const previousCount = useRef(lines.length);
  const [atEdge, setAtEdge] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  const { scrollYProgress } = useScroll({ container: viewportRef });
  const numberSpring = motionTokens.springs.number;
  const progress = useSpring(
    scrollYProgress,
    'stiffness' in numberSpring
      ? { stiffness: numberSpring.stiffness, damping: numberSpring.damping }
      : undefined
  );

  useMotionValueEvent(progress, 'change', (value) => {
    if (mode !== 'animate' || !percentRef.current) return;
    percentRef.current.textContent = `${Math.round(value * 100)}%`;
  });

  const handleScroll = () => {
    const element = viewportRef.current;
    if (!element) return;
    const max = element.scrollHeight - element.clientHeight;
    const value = max > 0 ? element.scrollTop / max : 0;
    if (mode === 'kite' && barRef.current) {
      barRef.current.style.transform = `scaleX(${value})`;
    }
    if (mode === 'kite' && percentRef.current) {
      percentRef.current.textContent = `${Math.round(value * 100)}%`;
    }
    const edge = isAtLiveEdge(element.scrollHeight, element.scrollTop, element.clientHeight);
    atEdgeRef.current = edge;
    setAtEdge((current) => (current === edge ? current : edge));
    if (edge) setUnseen(0);
  };

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const edge = isAtLiveEdge(element.scrollHeight, element.scrollTop, element.clientHeight);
    atEdgeRef.current = edge;
    setAtEdge(edge);
  }, []);

  useEffect(() => {
    const element = viewportRef.current;
    const grew = lines.length > previousCount.current;
    previousCount.current = lines.length;
    if (!element || !grew) return;
    if (atEdgeRef.current) {
      element.scrollTo({
        top: element.scrollHeight,
        behavior: reduce ? 'auto' : 'smooth',
      });
      setUnseen(0);
      return;
    }
    setUnseen((count) => count + 1);
  }, [lines.length, reduce]);

  useEffect(() => {
    if (mode !== 'kite') return;
    const root = viewportRef.current;
    if (!root) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]'));
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const key = entry.target.getAttribute('data-reveal');
          if (key) {
            setRevealed((current) =>
              current[key] ? current : { ...current, [key]: true }
            );
          }
          observer.unobserve(entry.target);
        }
      },
      { root, threshold: 0.55 }
    );
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [mode]);

  const jumpToEdge = () => {
    const element = viewportRef.current;
    if (!element) return;
    element.scrollTo({
      top: element.scrollHeight,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
    setUnseen(0);
  };

  const revealBlock = (key: string, title: string, detail: string) => {
    if (mode === 'animate') {
      return (
        <motion.div
          key={key}
          className="p8-reveal"
          initial={{ opacity: 0, y: reduce ? 0 : 8 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ root: viewportRef, amount: 0.55, once: true }}
          transition={motionTokens.tweens.reveal}
        >
          <strong>{title}</strong>
          <span>{detail}</span>
        </motion.div>
      );
    }
    return (
      <div
        key={key}
        className={`p8-reveal${revealed[key] ? ' is-in' : ''}`}
        data-reveal={key}
      >
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
    );
  };

  return (
    <div className="p8-scroll-scene">
      <div className="p8-scroll__head">
        <span className="p8-kicker">Transcript</span>
        <div className="p8-scroll__track" aria-hidden="true">
          {mode === 'animate' ? (
            <motion.div
              className="p8-scroll__bar"
              style={{ scaleX: reduce ? scrollYProgress : progress }}
            />
          ) : (
            <div ref={barRef} className="p8-scroll__bar p8-scroll__bar--kite" />
          )}
        </div>
        <span ref={percentRef} className="p8-scroll__pct">
          0%
        </span>
      </div>

      <div className="p8-scroll__wrap">
        <div className="p8-scroll__frame">
          <motion.div
            ref={viewportRef}
            className="p8-scroll__viewport"
            layoutScroll={mode === 'animate'}
            onScroll={handleScroll}
            tabIndex={0}
            aria-label="Transcript con borde vivo"
          >
          <div className="p8-scroll__inner">
            {revealBlock('first', 'Primer hito', 'El transcript abre en la última sesión.')}
            {revealBlock('second', 'Segundo hito', 'Los bloques entran cuando asoman al viewport.')}

            <div className="p8-transcript">
              <AnimatePresence initial={false}>
                {lines.map((line, index) =>
                  mode === 'animate' ? (
                    <motion.div
                      key={line.id}
                      layout="position"
                      className={`p8-line p8-line--${line.kind}`}
                      initial={{ opacity: 0, y: 6, filter: reduce ? 'blur(0px)' : motionTokens.itemBlur }}
                      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                      transition={motionTokens.springs.pop}
                    >
                      {line.text}
                    </motion.div>
                  ) : (
                    <div
                      key={line.id}
                      className={`p8-line p8-line--${line.kind}${
                        index === lines.length - 1 ? ' motion-row-in' : ''
                      }`}
                    >
                      {line.text}
                    </div>
                  )
                )}
              </AnimatePresence>
              <div className="p8-live" aria-hidden="true">
                <span className="p8-live__dot" />
                borde vivo
              </div>
            </div>
          </div>
          </motion.div>
        </div>

        {unseen > 0 && (
          <SceneButton
            mode={mode}
            variant="ghost"
            className="p8-jump"
            onClick={jumpToEdge}
            aria-label={`Ir al borde vivo, ${unseen} líneas nuevas`}
          >
            ↓ {unseen} nueva{unseen === 1 ? '' : 's'}
          </SceneButton>
        )}
      </div>

      <div className="p8-scroll__foot">
        <SceneButton mode={mode} variant="ghost" className="cmp-btn--sm" onClick={onAdd}>
          <PlusIcon size={11} />
          Agregar línea
        </SceneButton>
        <span className={`p8-scroll__state${atEdge ? ' is-live' : ''}`}>
          {atEdge ? 'En el borde' : 'Lectura pausada'}
        </span>
        <SceneButton
          mode={mode}
          variant="ghost"
          className="cmp-btn--sm"
          onClick={jumpToEdge}
          disabled={atEdge}
        >
          Ir al borde
        </SceneButton>
        <span className="p8-chip-static" aria-live="polite">
          {reduce ? 'reduced · salto' : 'motion · smooth'}
        </span>
      </div>
    </div>
  );
}

function ScrollScene({ view }: { view: CompareView }) {
  const [lines, setLines] = useState<ScrollLine[]>(SCROLL_SEED);
  const sequence = useRef(0);

  const addLine = () => {
    sequence.current += 1;
    const template = NEXT_LINES[(sequence.current - 1) % NEXT_LINES.length];
    setLines((current) => [
      ...current,
      { id: `n${sequence.current}`, kind: template.kind, text: template.text },
    ]);
  };

  return (
    <CompareScene
      index="04"
      title="Scroll"
      target="Transcript · live edge"
      note="Progreso, revelado por intersección, degradado de borde y un transcript que sigue el borde vivo solo si ya estabas abajo. Agregá una línea desde arriba: aparece la pastilla en vez del salto. Con reduced motion el scroll salta y el movimiento se apaga: Animate UI conserva los fades y Kite aparece sin animación."
      view={view}
    >
      {(mode) => (
        <ScrollPane mode={mode} lines={lines} onAdd={addLine} />
      )}
    </CompareScene>
  );
}

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

function ViewTransitionScene({ view }: { view: CompareView }) {
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

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

export function GesturesPage({ view }: { view: CompareView }) {
  return (
    <>
      <SharedElementScene view={view} />
      <ReorderScene view={view} />
      <KanbanScene view={view} />
      <ScrollScene view={view} />
      <ViewTransitionScene view={view} />
    </>
  );
}
