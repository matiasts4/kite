import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { animate, motion, useMotionValue, type PanInfo } from 'motion/react';
import { useLabMotion } from '../../context';
import {
  CompareScene,
  SceneButton,
  type CompareVariant,
  type CompareView,
} from '../../frame';

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

export function KanbanScene({ view }: { view: CompareView }) {
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
