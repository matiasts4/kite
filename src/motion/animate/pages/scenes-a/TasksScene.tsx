import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { usePresence } from '../../../usePresence';
import { motionSurfaceClass } from '../../../surface';
import { useLabMotion, useLabReduce } from '../../context';
import {
  CompareScene,
  SceneButton,
  type CompareVariant,
  type CompareView,
} from '../../frame';
import { CheckIcon, CloseIcon, PlusIcon } from '../../ui';
import './scenes-a.css';

type TaskStatus = 'backlog' | 'doing' | 'review';
type TaskPriority = 'high' | 'medium' | 'blocked';
type TaskScope = 'all' | 'blocked' | 'mine';

interface TaskCard {
  id: string;
  title: string;
  agent: 'kite' | 'motion' | 'docs';
  priority: TaskPriority;
  status: TaskStatus;
}

interface DragState {
  id: string;
  dx: number;
  dy: number;
  target: TaskStatus | null;
}

const COLUMNS: { id: TaskStatus; label: string; hint: string }[] = [
  { id: 'backlog', label: 'Pendientes', hint: 'sin arrancar' },
  { id: 'doing', label: 'En curso', hint: 'agente activo' },
  { id: 'review', label: 'Revisión', hint: 'esperando OK' },
];

const SCOPES: { id: TaskScope; label: string }[] = [
  { id: 'all', label: 'Todas' },
  { id: 'blocked', label: 'Bloqueadas' },
  { id: 'mine', label: 'Mías' },
];

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  high: 'Alta',
  medium: 'Media',
  blocked: 'Bloqueada',
};

const SEED_TASKS: TaskCard[] = [
  { id: 'k1', title: 'Extender el transcript', agent: 'kite', priority: 'high', status: 'doing' },
  { id: 'k2', title: 'Aprobar el diff del dock', agent: 'motion', priority: 'medium', status: 'review' },
  { id: 'k3', title: 'Portar tokens de spring', agent: 'motion', priority: 'medium', status: 'backlog' },
  { id: 'k4', title: 'Arreglar el foco del composer', agent: 'kite', priority: 'high', status: 'backlog' },
  { id: 'k5', title: 'Skill de iconos animados', agent: 'docs', priority: 'blocked', status: 'doing' },
  { id: 'k6', title: 'Página 06 del lab', agent: 'kite', priority: 'high', status: 'doing' },
  { id: 'k7', title: 'Revisar reduced motion', agent: 'docs', priority: 'medium', status: 'review' },
  { id: 'k8', title: 'Capturas del tablero', agent: 'docs', priority: 'blocked', status: 'backlog' },
];

function matchesScope(card: TaskCard, scope: TaskScope): boolean {
  if (scope === 'blocked') return card.priority === 'blocked';
  if (scope === 'mine') return card.agent === 'kite';
  return true;
}

function TaskCardView({
  mode,
  card,
  selected,
  fresh,
  dragging,
  offset,
  onToggleSelect,
  onStartDrag,
}: {
  mode: CompareVariant;
  card: TaskCard;
  selected: boolean;
  fresh: boolean;
  dragging: boolean;
  offset: { x: number; y: number } | null;
  onToggleSelect: (id: string) => void;
  onStartDrag: (event: ReactPointerEvent<HTMLDivElement>, id: string) => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const dx = offset?.x ?? 0;
  const dy = offset?.y ?? 0;

  const body = (
    <>
      <div className="p6-task__top">
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={`Seleccionar ${card.title}`}
          className={`p6-task__check${selected ? ' is-on' : ''}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onToggleSelect(card.id);
          }}
        >
          {mode === 'animate' ? (
            <svg
              width={9}
              height={9}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <motion.path
                d="M20 6 9 17 4 12"
                initial={false}
                animate={{ pathLength: selected ? 1 : 0, opacity: selected ? 1 : 0 }}
                transition={motionTokens.springs.press}
              />
            </svg>
          ) : selected ? (
            <CheckIcon size={9} />
          ) : null}
        </button>
        <span className="p6-task__title">{card.title}</span>
      </div>
      <div className="p6-task__meta">
        <span className={`p6-prio p6-prio--${card.priority}`}>{PRIORITY_LABEL[card.priority]}</span>
        <span className={`p6-agent p6-agent--${card.agent}`}>@{card.agent}</span>
      </div>
    </>
  );

  if (mode === 'animate') {
    return (
      <motion.div
        layout={!dragging}
        className={`p6-task${selected ? ' is-selected' : ''}${dragging ? ' is-dragging' : ''}`}
        initial={{
          opacity: 0,
          y: reduce ? 0 : motionTokens.travel(6),
          filter: motionTokens.itemBlur,
        }}
        animate={{
          opacity: 1,
          x: dragging ? dx : 0,
          y: dragging ? dy : 0,
          scale: dragging && !reduce ? 1.02 : 1,
          filter: 'blur(0px)',
        }}
        exit={{
          opacity: 0,
          y: reduce ? 0 : -motionTokens.travel(4),
          filter: motionTokens.itemBlur,
          transition: motionTokens.tweens.dismiss,
        }}
        transition={dragging ? motionTokens.tweens.instant : motionTokens.springs.reflow}
        onPointerDown={(event) => onStartDrag(event, card.id)}
      >
        {body}
      </motion.div>
    );
  }

  return (
    <div
      className={`p6-task${selected ? ' is-selected' : ''}${dragging ? ' is-dragging' : ''}${
        fresh ? ' motion-row-in' : ''
      }`}
      style={dragging ? { transform: `translate(${dx}px, ${dy}px)` } : undefined}
      onPointerDown={(event) => onStartDrag(event, card.id)}
    >
      {body}
    </div>
  );
}

function TaskDetailSheet({
  mode,
  task,
  open,
  onClose,
  onStatus,
  onRemove,
}: {
  mode: CompareVariant;
  task: TaskCard | null;
  open: boolean;
  onClose: () => void;
  onStatus: (status: TaskStatus) => void;
  onRemove: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);

  const body = task ? (
    <>
      <div className="p6-sheet__head">
        <span>Detalle de tarea</span>
        <SceneButton mode={mode} variant="icon" onClick={onClose} aria-label="Cerrar detalle">
          <CloseIcon size={12} />
        </SceneButton>
      </div>
      <h3 className="p6-sheet__title">{task.title}</h3>
      <div className="p6-sheet__meta">
        <span className={`p6-prio p6-prio--${task.priority}`}>
          {PRIORITY_LABEL[task.priority]}
        </span>
        <span className={`p6-agent p6-agent--${task.agent}`}>@{task.agent}</span>
      </div>
      <span className="p6-sheet__label">Estado</span>
      <div className="p6-sheet__status" role="radiogroup" aria-label="Estado de la tarea">
        {COLUMNS.map((column) => {
          const selected = task.status === column.id;
          return (
            <button
              key={column.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`p6-sheet__statusitem${selected ? ' is-active' : ''}`}
              onClick={() => onStatus(column.id)}
            >
              {mode === 'animate' && selected && (
                <motion.span
                  layoutId="cmp-task-status"
                  className="p6-sheet__indicator"
                  initial={false}
                  transition={motionTokens.springs.selection}
                />
              )}
              <span className="p6-sheet__statuslabel">{column.label}</span>
            </button>
          );
        })}
      </div>
      <p className="p6-sheet__copy">
        Cambiar el estado acá mueve la tarjeta en las dos columnas. El detalle no bloquea el
        tablero: el scrim se cierra con click.
      </p>
      <div className="p6-sheet__actions">
        <SceneButton mode={mode} variant="ghost" className="p6-danger" onClick={onRemove}>
          Eliminar
        </SceneButton>
        <SceneButton mode={mode} variant="primary" onClick={onClose}>
          Listo
        </SceneButton>
      </div>
    </>
  ) : null;

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div className="p6-board-layer">
        <div
          className={`cmp-scrim ${motionSurfaceClass(presence.phase, 'scrim')}`}
          onClick={onClose}
          aria-hidden="true"
        />
        <aside
          className={`p6-sheet ${motionSurfaceClass(presence.phase, 'panel')}`}
          role="dialog"
          aria-modal="true"
          aria-label="Detalle de tarea"
        >
          {body}
        </aside>
      </div>
    );
  }

  return (
    <div className="p6-board-layer">
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
        {open && task && (
          <motion.aside
            className="p6-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Detalle de tarea"
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
            {body}
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  );
}

function TasksBoard({
  mode,
  cards,
  query,
  onQuery,
  scope,
  onScope,
  selected,
  onToggleSelect,
  onOpenDetail,
  onMoveCard,
  onAddCard,
  lastAddedId,
  detailTask,
  detailOpen,
  onCloseDetail,
  onStatus,
  onRemove,
  onBulkMove,
  onBulkRemove,
  onClearSelection,
}: {
  mode: CompareVariant;
  cards: TaskCard[];
  query: string;
  onQuery: (value: string) => void;
  scope: TaskScope;
  onScope: (next: TaskScope) => void;
  selected: string[];
  onToggleSelect: (id: string) => void;
  onOpenDetail: (id: string) => void;
  onMoveCard: (id: string, status: TaskStatus) => void;
  onAddCard: (status: TaskStatus, title: string) => void;
  lastAddedId: string | null;
  detailTask: TaskCard | null;
  detailOpen: boolean;
  onCloseDetail: () => void;
  onStatus: (id: string, status: TaskStatus) => void;
  onRemove: (id: string) => void;
  onBulkMove: (status: TaskStatus) => void;
  onBulkRemove: () => void;
  onClearSelection: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const boardRef = useRef<HTMLDivElement | null>(null);
  const dragCleanup = useRef<(() => void) | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [addingIn, setAddingIn] = useState<TaskStatus | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const normalizedQuery = query.trim().toLowerCase();

  useEffect(() => () => dragCleanup.current?.(), []);

  const columnAt = (x: number, y: number): TaskStatus | null => {
    const board = boardRef.current;
    if (!board) return null;
    const nodes = Array.from(board.querySelectorAll<HTMLElement>('[data-p6-column]'));
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return (node.dataset.p6Column as TaskStatus | undefined) ?? null;
      }
    }
    return null;
  };

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>, id: string) => {
    if (event.button !== 0) return;
    const card = cards.find((item) => item.id === id);
    if (!card) return;
    event.preventDefault();
    dragCleanup.current?.();
    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;

    const onMove = (native: PointerEvent) => {
      const dx = native.clientX - startX;
      const dy = native.clientY - startY;
      if (!active && Math.hypot(dx, dy) < 5) return;
      active = true;
      setDrag({
        id,
        dx,
        dy,
        target: columnAt(native.clientX, native.clientY),
      });
    };

    const onUp = (native: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      dragCleanup.current = null;
      if (active) {
        const target = columnAt(native.clientX, native.clientY);
        if (target && target !== card.status) onMoveCard(id, target);
        setDrag(null);
      } else {
        onOpenDetail(id);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    dragCleanup.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  };

  const commitNew = (status: TaskStatus) => {
    const title = newTitle.trim();
    if (!title) return;
    onAddCard(status, title);
    setNewTitle('');
    setAddingIn(null);
  };

  const visible = (card: TaskCard) =>
    matchesScope(card, scope) &&
    (!normalizedQuery || card.title.toLowerCase().includes(normalizedQuery));

  const bulkBar =
    selected.length > 0 ? (
      <div className="p6-bulk__inner">
        <strong className="p6-bulk__count">{selected.length} seleccionadas</strong>
        <div className="p6-bulk__actions">
          <SceneButton
            mode={mode}
            className="cmp-btn--sm"
            onClick={() => onBulkMove('doing')}
          >
            Mover a En curso
          </SceneButton>
          <SceneButton
            mode={mode}
            variant="ghost"
            className="cmp-btn--sm p6-danger"
            onClick={onBulkRemove}
          >
            Eliminar
          </SceneButton>
          <SceneButton
            mode={mode}
            variant="ghost"
            className="cmp-btn--sm"
            onClick={onClearSelection}
          >
            Limpiar
          </SceneButton>
        </div>
      </div>
    ) : null;

  return (
    <div className={`p6-tasks p6-mode p6-mode--${mode}`}>
      <header className="p6-tasks__head">
        <div className="p6-tasks__title">
          <strong>Tablero del agente</strong>
          <span>
            {cards.length} tarjetas · {cards.filter((card) => card.priority === 'blocked').length}{' '}
            bloqueadas
          </span>
        </div>
        <span className="cmp-badge">kanban</span>
      </header>

      <div className="p6-tasks__filters">
        <input
          className="p6-search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Buscar tareas…"
          aria-label="Buscar tareas"
        />
        <div className="p6-scope" role="radiogroup" aria-label="Filtro de tareas">
          {SCOPES.map((item) => {
            const active = scope === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={active}
                className={`p6-scope__item${active ? ' is-active' : ''}`}
                onClick={() => onScope(item.id)}
              >
                {mode === 'animate' && active && (
                  <motion.span
                    layoutId="cmp-task-scope"
                    className="p6-scope__indicator"
                    initial={false}
                    transition={motionTokens.springs.selection}
                  />
                )}
                <span className="p6-scope__label">{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {mode === 'animate' ? (
        <AnimatePresence initial={false}>
          {bulkBar && (
            <motion.div
              className="p6-bulk"
              initial={{ height: 0, opacity: 0, y: reduce ? 0 : -4 }}
              animate={{
                height: 'auto',
                opacity: 1,
                y: 0,
                transition: motionTokens.tweens.disclosure,
              }}
              exit={{ height: 0, opacity: 0, transition: motionTokens.tweens.panelOut }}
              style={{ overflow: 'hidden' }}
            >
              {bulkBar}
            </motion.div>
          )}
        </AnimatePresence>
      ) : (
        bulkBar && <div className="p6-bulk motion-row-in">{bulkBar}</div>
      )}

      <div className="p6-board" ref={boardRef}>
        {COLUMNS.map((column) => {
          const list = cards.filter((card) => card.status === column.id && visible(card));
          const isTarget = drag?.target === column.id;
          return (
            <section
              key={column.id}
              className={`p6-col${isTarget ? ' is-drop' : ''}`}
              data-p6-column={column.id}
              aria-label={column.label}
            >
              <header className="p6-col__head">
                <span className={`p6-col__dot p6-col__dot--${column.id}`} aria-hidden="true" />
                <strong>{column.label}</strong>
                <span className="p6-col__count">{list.length}</span>
              </header>

              <div className="p6-col__body">
                <AnimatePresence initial={false}>
                  {list.map((card) => (
                    <TaskCardView
                      key={card.id}
                      mode={mode}
                      card={card}
                      selected={selected.includes(card.id)}
                      fresh={card.id === lastAddedId}
                      dragging={drag?.id === card.id}
                      offset={drag?.id === card.id ? { x: drag.dx, y: drag.dy } : null}
                      onToggleSelect={onToggleSelect}
                      onStartDrag={startDrag}
                    />
                  ))}
                </AnimatePresence>
                {list.length === 0 && (
                  <p className="p6-col__empty">
                    {normalizedQuery || scope !== 'all' ? 'Sin resultados' : 'Nada por acá'}
                  </p>
                )}
              </div>

              <footer className="p6-col__foot">
                {addingIn === column.id ? (
                  <form
                    className="p6-col__form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      commitNew(column.id);
                    }}
                  >
                    <input
                      autoFocus
                      className="p6-col__input"
                      value={newTitle}
                      onChange={(event) => setNewTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          setAddingIn(null);
                          setNewTitle('');
                        }
                      }}
                      placeholder="Nueva tarea…"
                      aria-label={`Nueva tarea en ${column.label}`}
                    />
                  </form>
                ) : (
                  <button
                    type="button"
                    className="p6-col__add"
                    onClick={() => {
                      setAddingIn(column.id);
                      setNewTitle('');
                    }}
                  >
                    <PlusIcon size={11} />
                    Agregar
                  </button>
                )}
              </footer>
            </section>
          );
        })}
      </div>

      <TaskDetailSheet
        mode={mode}
        task={detailTask}
        open={detailOpen}
        onClose={onCloseDetail}
        onStatus={(status) => {
          if (detailTask) onStatus(detailTask.id, status);
        }}
        onRemove={() => {
          if (detailTask) onRemove(detailTask.id);
        }}
      />
    </div>
  );
}

export function TasksScene({ view }: { view: CompareView }) {
  const [cards, setCards] = useState<TaskCard[]>(SEED_TASKS);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<TaskScope>('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [lastAddedId, setLastAddedId] = useState<string | null>(null);
  const sequence = useRef(SEED_TASKS.length);

  const detailTask = cards.find((card) => card.id === detailId) ?? null;

  const toggleSelect = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const moveCard = (id: string, status: TaskStatus) => {
    setCards((prev) => prev.map((card) => (card.id === id ? { ...card, status } : card)));
  };

  const addCard = (status: TaskStatus, title: string) => {
    sequence.current += 1;
    const id = `k${sequence.current}`;
    setCards((prev) => [...prev, { id, title, agent: 'kite', priority: 'medium', status }]);
    setLastAddedId(id);
  };

  const removeCard = (id: string) => {
    setCards((prev) => prev.filter((card) => card.id !== id));
    setSelected((prev) => prev.filter((item) => item !== id));
    setDetailId((current) => (current === id ? null : current));
  };

  const bulkMove = (status: TaskStatus) => {
    setCards((prev) =>
      prev.map((card) => (selected.includes(card.id) ? { ...card, status } : card))
    );
    setSelected([]);
  };

  const bulkRemove = () => {
    setCards((prev) => prev.filter((card) => !selected.includes(card.id)));
    setDetailId((current) => (current && selected.includes(current) ? null : current));
    setSelected([]);
  };

  return (
    <CompareScene
      index="04"
      title="Tareas · kanban"
      target="TaskBoard · TaskDetailSheet"
      note="Tablero con tres columnas, arrastre simplificado, filtros, selección múltiple, alta y baja de tarjetas, badges y sheet de detalle. Arrastrá una tarjeta a otra columna o abrila para cambiar su estado: las dos columnas comparten el mismo tablero."
      view={view}
    >
      {(mode) => (
        <TasksBoard
          mode={mode}
          cards={cards}
          query={query}
          onQuery={setQuery}
          scope={scope}
          onScope={setScope}
          selected={selected}
          onToggleSelect={toggleSelect}
          onOpenDetail={setDetailId}
          onMoveCard={moveCard}
          onAddCard={addCard}
          lastAddedId={lastAddedId}
          detailTask={detailTask}
          detailOpen={detailId !== null && detailTask !== null}
          onCloseDetail={() => setDetailId(null)}
          onStatus={moveCard}
          onRemove={removeCard}
          onBulkMove={bulkMove}
          onBulkRemove={bulkRemove}
          onClearSelection={() => setSelected([])}
        />
      )}
    </CompareScene>
  );
}
