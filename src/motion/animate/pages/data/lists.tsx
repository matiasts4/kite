import {
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { AnimatePresence, motion, useMotionValue } from 'motion/react';
import { useLabMotion, useLabReduce } from '../../context';
import { CompareScene, SceneButton, type CompareVariant, type CompareView } from '../../frame';
import { ChevronDownIcon, CloseIcon, PlusIcon } from '../../ui';

/* -------------------------------------------------------------------------- */
/* Scene 1 — Lists: add/remove, reorder, filter grid, swipe row                */
/* -------------------------------------------------------------------------- */

type TaskStatus = 'active' | 'done' | 'archived';
type TaskFilter = 'all' | 'active' | 'done';

interface Task {
  id: string;
  label: string;
  meta: string;
  status: TaskStatus;
}

const SEED_TASKS: Task[] = [
  {
    id: 't1',
    label: 'Revisar el diff de contract.ts',
    meta: 'agent · hace 2 min',
    status: 'active',
  },
  {
    id: 't2',
    label: 'Aprobar la escritura de surface.ts',
    meta: 'agent · hace 5 min',
    status: 'active',
  },
  {
    id: 't3',
    label: 'Cerrar el hilo del transcript',
    meta: 'vos · hace 12 min',
    status: 'done',
  },
  {
    id: 't4',
    label: 'Archivar la sesión vieja',
    meta: 'sistema · ayer',
    status: 'archived',
  },
];

const FILTERS: { id: TaskFilter; label: string }[] = [
  { id: 'all', label: 'Todas' },
  { id: 'active', label: 'Activas' },
  { id: 'done', label: 'Hechas' },
];

const STATUS_LABEL: Record<TaskStatus, string> = {
  active: 'activa',
  done: 'hecha',
  archived: 'archivada',
};

function matches(task: Task, filter: TaskFilter): boolean {
  if (filter === 'all') return true;
  return task.status === filter;
}

interface ListsColumnProps {
  mode: CompareVariant;
  tasks: Task[];
  visible: Task[];
  filter: TaskFilter;
  lastAdded: string | null;
  notice: boolean;
  onFilter: (filter: TaskFilter) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onDismissNotice: () => void;
  onRestoreNotice: () => void;
}

function KiteSwipeRow({ onDismiss }: { onDismiss: () => void }) {
  const reduce = useLabReduce();
  const rowRef = useRef<HTMLDivElement>(null);
  const drag = useRef({
    active: false,
    startX: 0,
    startY: 0,
    startTime: 0,
    dx: 0,
  });

  const snapBack = (animated: boolean) => {
    const row = rowRef.current;
    if (!row) return;
    row.style.transition = animated ? 'transform 220ms cubic-bezier(0.16, 1, 0.3, 1)' : 'none';
    row.style.transform = 'translateX(0)';
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button')) return;
    drag.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      startTime: event.timeStamp,
      dx: 0,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (rowRef.current) rowRef.current.style.transition = 'none';
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state.active) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dx) < 10) return;
    state.dx = Math.max(-150, Math.min(0, dx));
    if (rowRef.current) rowRef.current.style.transform = `translateX(${state.dx}px)`;
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state.active) return;
    state.active = false;
    const elapsed = Math.max(1, event.timeStamp - state.startTime);
    const velocity = ((event.clientX - state.startX) / elapsed) * 1000;
    if (state.dx < -90 || velocity < -500) {
      onDismiss();
      return;
    }
    snapBack(!reduce);
  };

  const onPointerCancel = () => {
    drag.current.active = false;
    snapBack(!reduce);
  };

  return (
    <div className="p4-swipe">
      <div className="p4-swipe__under" aria-hidden="true">
        Descartar
      </div>
      <div
        ref={rowRef}
        className="p4-swipe__row"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <span>La sesión contract.ts terminó</span>
        <SceneButton mode="kite" variant="ghost" className="cmp-btn--sm" onClick={onDismiss}>
          Descartar
        </SceneButton>
      </div>
    </div>
  );
}

function AnimateSwipeRow({ onDismiss }: { onDismiss: () => void }) {
  const motionTokens = useLabMotion();
  const x = useMotionValue(0);
  const snap = motionTokens.springs.reflow;
  const bounce = 'stiffness' in snap ? snap : null;

  return (
    <div className="p4-swipe">
      <div className="p4-swipe__under" aria-hidden="true">
        Descartar
      </div>
      <motion.div
        className="p4-swipe__row"
        drag="x"
        dragDirectionLock
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={{ left: 0.6, right: 0 }}
        dragTransition={
          bounce ? { bounceStiffness: bounce.stiffness, bounceDamping: bounce.damping } : undefined
        }
        onDragEnd={(_event, info) => {
          if (info.offset.x < -90 || info.velocity.x < -500) {
            x.stop();
            onDismiss();
          }
        }}
        style={{ x }}
        whileDrag={{ cursor: 'grabbing' }}
      >
        <span>La sesión contract.ts terminó</span>
        <SceneButton
          mode="animate"
          variant="ghost"
          className="cmp-btn--sm"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onDismiss}
        >
          Descartar
        </SceneButton>
      </motion.div>
    </div>
  );
}

export function ListsScene({ view }: { view: CompareView }) {
  const [tasks, setTasks] = useState<Task[]>(SEED_TASKS);
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [lastAdded, setLastAdded] = useState<string | null>(null);
  const [notice, setNotice] = useState(true);
  const [said, setSaid] = useState('');
  const sequence = useRef(SEED_TASKS.length);

  const visible = tasks.filter((task) => matches(task, filter));

  const addTask = () => {
    sequence.current += 1;
    const id = `t${sequence.current}`;
    const label = `Tarea nueva ${sequence.current}`;
    setTasks((prev) => [
      { id, label, meta: 'vos · ahora', status: 'active' },
      ...prev,
    ]);
    setLastAdded(id);
    if (filter === 'done') setFilter('active');
    setSaid(`${label} agregada`);
  };

  const removeTask = (id: string) => {
    const task = tasks.find((item) => item.id === id);
    setTasks((prev) => prev.filter((item) => item.id !== id));
    setSaid(`${task?.label ?? 'Tarea'} quitada`);
  };

  const moveTask = (id: string, dir: -1 | 1) => {
    const order = tasks.filter((task) => matches(task, filter)).map((task) => task.id);
    const index = order.indexOf(id);
    const targetId = order[index + dir];
    if (!targetId) return;
    setTasks((prev) => {
      const from = prev.findIndex((task) => task.id === id);
      const to = prev.findIndex((task) => task.id === targetId);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    const task = tasks.find((item) => item.id === id);
    setSaid(`${task?.label ?? 'Tarea'} ${dir < 0 ? 'subió' : 'bajó'} una posición`);
  };

  return (
    <>
      <CompareScene
        index="01"
        title="Listas que se reordenan y se filtran"
        target="TaskList · FilterGrid · SwipeRow"
        note="Agregá, quitá y reordená tareas, cambiá el filtro y descartá el aviso. Las filas que quedan hacen lugar sobre spring.reflow y las que entran o salen funden; Kite recompone el layout sin interpolación."
        view={view}
      >
        {(mode) => (
          <ListsColumn
            mode={mode}
            tasks={tasks}
            visible={visible}
            filter={filter}
            lastAdded={lastAdded}
            notice={notice}
            onFilter={setFilter}
            onAdd={addTask}
            onRemove={removeTask}
            onMove={moveTask}
            onDismissNotice={() => {
              setNotice(false);
              setSaid('Aviso descartado');
            }}
            onRestoreNotice={() => {
              setNotice(true);
              setSaid('Aviso restaurado');
            }}
          />
        )}
      </CompareScene>
      <p className="p4-sr" aria-live="polite">
        {said}
      </p>
    </>
  );
}

function ListsColumn({
  mode,
  tasks,
  visible,
  filter,
  lastAdded,
  notice,
  onFilter,
  onAdd,
  onRemove,
  onMove,
  onDismissNotice,
  onRestoreNotice,
}: ListsColumnProps) {
  const motionTokens = useLabMotion();
  const rootRef = useRef<HTMLDivElement>(null);

  const focusInColumn = (selector: string) => {
    requestAnimationFrame(() => {
      rootRef.current?.querySelector<HTMLElement>(selector)?.focus();
    });
  };

  const moveRow = (event: ReactMouseEvent<HTMLButtonElement>, id: string, dir: -1 | 1) => {
    const root = event.currentTarget.closest<HTMLElement>('[data-engine]');
    onMove(id, dir);
    requestAnimationFrame(() => {
      const target = root?.querySelector<HTMLElement>(
        `[data-task="${id}"] [data-move="${dir}"] button:not(:disabled)`
      );
      (
        target ??
        root?.querySelector<HTMLElement>(
          `[data-task="${id}"] .p4-row__actions button:not(:disabled)`
        )
      )?.focus();
    });
  };

  const removeRow = (event: ReactMouseEvent<HTMLButtonElement>, id: string) => {
    const root = event.currentTarget.closest<HTMLElement>('[data-engine]');
    const index = visible.findIndex((task) => task.id === id);
    const nextId = visible[index + 1]?.id ?? visible[index - 1]?.id;
    onRemove(id);
    requestAnimationFrame(() => {
      if (!root) return;
      const nextButton = nextId
        ? root.querySelector<HTMLElement>(
            `[data-task="${nextId}"] .p4-row__actions button:not(:disabled)`
          )
        : null;
      (nextButton ?? root.querySelector<HTMLElement>('[data-add] button'))?.focus();
    });
  };

  const rowBody = (task: Task, index: number) => (
    <>
      <span className={`p4-row__dot p4-row__dot--${task.status}`} aria-hidden="true" />
      <div className="p4-row__text">
        <span>{task.label}</span>
        <small>
          {task.meta} · {STATUS_LABEL[task.status]}
        </small>
      </div>
      <div className="p4-row__actions">
        <span data-move="-1">
          <SceneButton
            mode={mode}
            variant="icon"
            aria-label={`Subir ${task.label}`}
            disabled={index === 0}
            onClick={(event) => moveRow(event, task.id, -1)}
          >
            <ChevronDownIcon size={10} className="p4-chev-up" />
          </SceneButton>
        </span>
        <span data-move="1">
          <SceneButton
            mode={mode}
            variant="icon"
            aria-label={`Bajar ${task.label}`}
            disabled={index === visible.length - 1}
            onClick={(event) => moveRow(event, task.id, 1)}
          >
            <ChevronDownIcon size={10} />
          </SceneButton>
        </span>
        <span>
          <SceneButton
            mode={mode}
            variant="icon"
            aria-label={`Quitar ${task.label}`}
            onClick={(event) => removeRow(event, task.id)}
          >
            <CloseIcon size={10} />
          </SceneButton>
        </span>
      </div>
    </>
  );

  return (
    <div ref={rootRef} className="p4-lists" data-engine={mode}>
      <div className="p4-lists__head">
        <div className="p4-lists__title">
          <strong>Cola del agente</strong>
          <span className="p4-hint">
            {visible.length} de {tasks.length} · reordená con las flechas
          </span>
        </div>
        <span data-add>
          <SceneButton
            mode={mode}
            variant="primary"
            className="cmp-btn--sm"
            onClick={() => {
              onAdd();
              focusInColumn('[data-add] button');
            }}
          >
            <PlusIcon size={11} />
            Agregar
          </SceneButton>
        </span>
      </div>

      <div className="p4-chips" role="group" aria-label="Filtrar tareas">
        {FILTERS.map((item) => {
          const active = filter === item.id;
          return (
            <SceneButton
              key={item.id}
              mode={mode}
              variant="ghost"
              className={`cmp-btn--sm p4-chip${active ? ' is-on' : ''}`}
              aria-pressed={active}
              onClick={() => onFilter(item.id)}
            >
              {item.label}
            </SceneButton>
          );
        })}
      </div>

      <ul className="p4-rows">
        {mode === 'animate' ? (
          <AnimatePresence mode="popLayout" initial={false}>
            {visible.map((task, index) => (
              <motion.li
                key={task.id}
                layout="position"
                data-task={task.id}
                className={`p4-row p4-row--${task.status}`}
                initial={{
                  opacity: 0,
                  y: motionTokens.travel(6),
                  filter: motionTokens.itemBlur,
                }}
                animate={{
                  opacity: 1,
                  y: 0,
                  filter: 'blur(0px)',
                  transition: {
                    ...motionTokens.itemSpring,
                    opacity: motionTokens.tweens.fade,
                  },
                }}
                exit={{
                  opacity: 0,
                  scale: 0.97,
                  transition: motionTokens.tweens.fade,
                }}
                transition={motionTokens.itemSpring}
              >
                {rowBody(task, index)}
              </motion.li>
            ))}
          </AnimatePresence>
        ) : (
          visible.map((task, index) => (
            <li
              key={task.id}
              data-task={task.id}
              className={`p4-row p4-row--${task.status}${
                task.id === lastAdded ? ' motion-row-in' : ''
              }`}
            >
              {rowBody(task, index)}
            </li>
          ))
        )}
      </ul>

      <div className="p4-grid-block">
        <div className="p4-grid-block__head">
          <span className="p4-label">Grilla filtrada</span>
          <span className="p4-hint">{visible.length} resultados</span>
        </div>
        <div className="p4-grid">
          {mode === 'animate' ? (
            <AnimatePresence mode="popLayout" initial={false}>
              {visible.slice(0, 4).map((task) => (
                <motion.div
                  key={task.id}
                  layout
                  className={`p4-tile p4-tile--${task.status}`}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{
                    opacity: 1,
                    scale: 1,
                    transition: {
                      ...motionTokens.itemSpring,
                      opacity: motionTokens.tweens.fade,
                    },
                  }}
                  exit={{ opacity: 0, scale: 0.95, transition: motionTokens.tweens.fade }}
                  transition={motionTokens.itemSpring}
                >
                  <strong>{task.label}</strong>
                  <span>{STATUS_LABEL[task.status]}</span>
                </motion.div>
              ))}
            </AnimatePresence>
          ) : (
            visible.slice(0, 4).map((task) => (
              <div key={task.id} className={`p4-tile p4-tile--${task.status}`}>
                <strong>{task.label}</strong>
                <span>{STATUS_LABEL[task.status]}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="p4-swipe-block">
        <div className="p4-grid-block__head">
          <span className="p4-label">Aviso descartable</span>
          <span className="p4-hint">arrastrá a la izquierda o usá el botón</span>
        </div>
        {mode === 'animate' ? (
          <AnimatePresence mode="popLayout" initial={false}>
            {notice && (
              <motion.div
                key="notice"
                exit={{
                  opacity: 0,
                  x: '-100%',
                  transition: motionTokens.tweens.dismiss,
                }}
              >
                <AnimateSwipeRow onDismiss={onDismissNotice} />
              </motion.div>
            )}
          </AnimatePresence>
        ) : notice ? (
          <KiteSwipeRow onDismiss={onDismissNotice} />
        ) : null}
        {!notice && (
          <div className="p4-swipe-block__gone">
            <span>Aviso descartado.</span>
            <SceneButton mode={mode} variant="ghost" className="cmp-btn--sm" onClick={onRestoreNotice}>
              Restaurar
            </SceneButton>
          </div>
        )}
      </div>
    </div>
  );
}
