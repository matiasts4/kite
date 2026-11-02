import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
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
import { CloseIcon, PlusIcon, SwapLabel } from '../../ui';
import { P7Checkbox, P7Dots } from './parts';

/* -------------------------------------------------------------------------- */
/* Model                                                                      */
/* -------------------------------------------------------------------------- */

type AgentStatus = 'active' | 'paused' | 'draft';
type AgentFilter = 'all' | 'active' | 'draft';
type AvatarTone = 'blue' | 'green' | 'amber' | 'violet';

interface Agent {
  id: string;
  name: string;
  role: string;
  initials: string;
  model: string;
  tone: AvatarTone;
  status: AgentStatus;
  sessions: number;
}

type PermissionId = 'read' | 'write' | 'shell';

const STATUS_LABELS: Record<AgentStatus, string> = {
  active: 'Activo',
  paused: 'En pausa',
  draft: 'Borrador',
};

const STATUS_LABELS_LIST = ['Activo', 'En pausa', 'Borrador'] as const;

const FILTERS: { id: AgentFilter; label: string }[] = [
  { id: 'all', label: 'Todos' },
  { id: 'active', label: 'Activos' },
  { id: 'draft', label: 'Borradores' },
];

const SEED_AGENTS: Agent[] = [
  {
    id: 'a1',
    name: 'Orbital',
    role: 'Refactor de transcript',
    initials: 'OR',
    model: 'Kite 2 · Opus',
    tone: 'blue',
    status: 'active',
    sessions: 128,
  },
  {
    id: 'a2',
    name: 'Bruma',
    role: 'Revisión de contratos',
    initials: 'BR',
    model: 'Kite 2 · Sonnet',
    tone: 'green',
    status: 'active',
    sessions: 74,
  },
  {
    id: 'a3',
    name: 'Faro',
    role: 'Migraciones de esquema',
    initials: 'FA',
    model: 'Kite 1 · Haiku',
    tone: 'amber',
    status: 'paused',
    sessions: 31,
  },
];

const MODEL_OPTIONS = [
  { value: 'Kite 2 · Opus', hint: 'Razonamiento largo, costo alto' },
  { value: 'Kite 2 · Sonnet', hint: 'Equilibrio para el día a día' },
  { value: 'Kite 1 · Haiku', hint: 'Respuestas cortas y rápidas' },
];

const CREATE_STEPS = [
  {
    title: 'Nombre del agente',
    hint: 'Un identificador corto, visible en el rail del workspace.',
  },
  {
    title: 'Modelo base',
    hint: 'El modelo se puede cambiar después desde los ajustes del agente.',
  },
  {
    title: 'Permisos',
    hint: 'Las escrituras y los comandos siempre piden aprobación en el hilo.',
  },
];

const PERMISSIONS: { id: PermissionId; label: string; hint: string }[] = [
  { id: 'read', label: 'Leer archivos', hint: 'Explorar el repo sin interrumpir.' },
  { id: 'write', label: 'Escribir archivos', hint: 'Proponer cambios y pedir aprobación.' },
  { id: 'shell', label: 'Ejecutar comandos', hint: 'Correr tests y scripts del proyecto.' },
];

const DEFAULT_PERMISSIONS: Record<PermissionId, boolean> = {
  read: true,
  write: false,
  shell: false,
};

/* -------------------------------------------------------------------------- */
/* Shared state                                                               */
/* -------------------------------------------------------------------------- */

function useAgentsDemo() {
  const [agents, setAgents] = useState<Agent[]>(SEED_AGENTS);
  const [filter, setFilter] = useState<AgentFilter>('all');
  const [selectedId, setSelectedId] = useState('a1');
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createStep, setCreateStep] = useState(0);
  const [createDir, setCreateDir] = useState<1 | -1>(1);
  const [name, setName] = useState('');
  const [model, setModel] = useState(MODEL_OPTIONS[0].value);
  const [permissions, setPermissions] = useState<Record<PermissionId, boolean>>({
    ...DEFAULT_PERMISSIONS,
  });
  const sequence = useRef(3);
  const timers = useRef<number[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach((id) => window.clearTimeout(id));
    },
    []
  );

  const filtered = agents.filter((agent) => {
    if (filter === 'all') return true;
    return agent.status === filter;
  });

  const reload = () => {
    if (loading) return;
    setLoading(true);
    timers.current.push(
      window.setTimeout(() => {
        setLoading(false);
      }, 1100)
    );
  };

  const select = (id: string) => setSelectedId(id);

  const toggleStatus = (id: string) => {
    setAgents((prev) =>
      prev.map((agent) => {
        if (agent.id !== id) return agent;
        const status: AgentStatus = agent.status === 'active' ? 'paused' : 'active';
        return { ...agent, status };
      })
    );
  };

  const openCreate = () => {
    setCreateOpen(true);
    setCreateStep(0);
    setCreateDir(1);
    setName('');
    setModel(MODEL_OPTIONS[0].value);
    setPermissions({ ...DEFAULT_PERMISSIONS });
  };

  const closeCreate = () => setCreateOpen(false);

  const nextCreate = () => {
    if (createStep === 0 && !name.trim()) return;
    if (createStep === CREATE_STEPS.length - 1) {
      sequence.current += 1;
      const id = `a${sequence.current}`;
      const trimmed = name.trim();
      const created: Agent = {
        id,
        name: trimmed,
        role: 'Agente nuevo del workspace',
        initials: trimmed.slice(0, 2).toUpperCase(),
        model,
        tone: 'violet',
        status: 'draft',
        sessions: 0,
      };
      setAgents((prev) => [...prev, created]);
      setSelectedId(id);
      setFilter('all');
      setCreateOpen(false);
      setCreateStep(0);
      return;
    }
    setCreateDir(1);
    setCreateStep((step) => step + 1);
  };

  const backCreate = () => {
    if (createStep === 0) return;
    setCreateDir(-1);
    setCreateStep((step) => step - 1);
  };

  const togglePermission = (id: PermissionId) => {
    setPermissions((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return {
    agents,
    filtered,
    filter,
    setFilter,
    selectedId,
    select,
    loading,
    reload,
    createOpen,
    openCreate,
    closeCreate,
    createStep,
    createDir,
    name,
    setName,
    model,
    setModel,
    permissions,
    togglePermission,
    nextCreate,
    backCreate,
    toggleStatus,
  };
}

type AgentsDemo = ReturnType<typeof useAgentsDemo>;

/* -------------------------------------------------------------------------- */
/* Cards                                                                      */
/* -------------------------------------------------------------------------- */

function AgentStatusPill({ mode, status }: { mode: CompareVariant; status: AgentStatus }) {
  return (
    <span className={`p7-status p7-status--${status}`}>
      <span className="p7-status__dot" aria-hidden="true" />
      {mode === 'animate' ? (
        <SwapLabel value={STATUS_LABELS[status]} labels={STATUS_LABELS_LIST} />
      ) : (
        STATUS_LABELS[status]
      )}
    </span>
  );
}

function AgentCard({
  mode,
  agent,
  selected,
  onSelect,
  onToggleStatus,
}: {
  mode: CompareVariant;
  agent: Agent;
  selected: boolean;
  onSelect: () => void;
  onToggleStatus: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const statusAction = agent.status === 'active' ? 'Pausar' : 'Activar';

  const body = (
    <>
      <div className="p7-agent__top">
        <span className={`p7-avatar p7-avatar--${agent.tone}`} aria-hidden="true">
          {agent.initials}
        </span>
        <span className="p7-agent__id">
          <strong>{agent.name}</strong>
          <span>{agent.role}</span>
        </span>
        <AgentStatusPill mode={mode} status={agent.status} />
      </div>
      <span className="p7-agent__model">{agent.model}</span>
    </>
  );

  const content = (
    <>
      {mode === 'animate' && selected ? (
        <motion.span
          layoutId="p7-agent-selection"
          className="p7-agent__ring"
          initial={false}
          transition={motionTokens.springs.selection}
          aria-hidden="true"
        />
      ) : null}

      {mode === 'animate' ? (
        <motion.button
          type="button"
          className="p7-agent__main"
          onClick={onSelect}
          aria-pressed={selected}
          initial={{ transform: 'scale(1)' }}
          whileTap={{ transform: `scale(${reduce ? 1 : motionTokens.scale.choice})` }}
          transition={motionTokens.springs.press}
        >
          {body}
        </motion.button>
      ) : (
        <button type="button" className="p7-agent__main" onClick={onSelect} aria-pressed={selected}>
          {body}
        </button>
      )}

      <div className="p7-agent__foot">
        <span className="p7-agent__sessions">{agent.sessions} sesiones</span>
        <SceneButton
          mode={mode}
          variant="ghost"
          className="cmp-btn--sm"
          onClick={onToggleStatus}
        >
          {statusAction}
        </SceneButton>
      </div>
    </>
  );

  const className = `p7-agent p7-agent--${mode}${selected ? ' is-selected' : ''}`;

  if (mode === 'animate') {
    return (
      <motion.div
        layout
        role="listitem"
        className={className}
        initial={{
          opacity: 0,
          y: motionTokens.travel(6),
          filter: motionTokens.itemBlur,
        }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        exit={{
          opacity: 0,
          scale: reduce ? 1 : motionTokens.scale.choice,
          filter: motionTokens.itemBlur,
          transition: motionTokens.tweens.dismiss,
        }}
        whileHover={reduce ? undefined : { y: -2 }}
        transition={motionTokens.springs.highlight}
      >
        {content}
      </motion.div>
    );
  }

  return (
    <div role="listitem" className={className}>
      {content}
    </div>
  );
}

function AgentSkeleton() {
  return (
    <div className="p7-skeleton" aria-hidden="true">
      <div className="p7-skeleton__top">
        <span className="p7-skeleton__avatar p7-pulse" />
        <span className="p7-skeleton__lines">
          <span className="p7-skeleton__bar p7-skeleton__bar--title p7-pulse" />
          <span className="p7-skeleton__bar p7-skeleton__bar--short p7-pulse" />
        </span>
      </div>
      <span className="p7-skeleton__bar p7-skeleton__bar--long p7-pulse" />
      <span className="p7-skeleton__bar p7-skeleton__bar--mid p7-pulse" />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Create flow                                                                */
/* -------------------------------------------------------------------------- */

function CreateForm({ mode, demo }: { mode: CompareVariant; demo: AgentsDemo }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const step = CREATE_STEPS[demo.createStep];
  const isLast = demo.createStep === CREATE_STEPS.length - 1;
  const nextDisabled = demo.createStep === 0 && demo.name.trim().length === 0;

  const variants = {
    enter: (dir: number) => ({
      opacity: 0,
      x: reduce ? 0 : dir * motionTokens.shift.step,
      filter: motionTokens.blur.panel,
    }),
    center: {
      opacity: 1,
      x: 0,
      filter: 'blur(0px)',
      transition: motionTokens.tweens.panelIn,
    },
    exit: (dir: number) => ({
      opacity: 0,
      x: reduce ? 0 : -dir * motionTokens.shift.step,
      filter: motionTokens.blur.panel,
      transition: motionTokens.tweens.panelOut,
    }),
  };

  const stepBody = (
    <div className="p7-create__step-inner">
      <h3 className="p7-create__step-title">{step.title}</h3>
      <p className="p7-hint">{step.hint}</p>

      {demo.createStep === 0 ? (
        <div className="p7-field">
          <label htmlFor={`p7-agent-name-${mode}`}>Nombre</label>
          <input
            id={`p7-agent-name-${mode}`}
            className="p7-input"
            value={demo.name}
            onChange={(event) => demo.setName(event.target.value)}
            placeholder="AG-04 · Revisor"
            autoFocus
          />
          <span className="p7-hint">Se normaliza a mayúsculas en el avatar.</span>
        </div>
      ) : null}

      {demo.createStep === 1 ? (
        <div className="p7-models" role="group" aria-label="Modelo base">
          {MODEL_OPTIONS.map((option) => {
            const active = demo.model === option.value;
            return (
              <button
                key={option.value}
                type="button"
                className={`p7-model p7-model--${mode}${active ? ' is-active' : ''}`}
                aria-pressed={active}
                onClick={() => demo.setModel(option.value)}
              >
                {mode === 'animate' && active ? (
                  <motion.span
                    layoutId="p7-model-selection"
                    className="p7-model__ring"
                    initial={false}
                    transition={motionTokens.springs.selection}
                    aria-hidden="true"
                  />
                ) : null}
                <strong>{option.value}</strong>
                <span>{option.hint}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {demo.createStep === 2 ? (
        <div className="p7-check-list">
          {PERMISSIONS.map((permission) => (
            <P7Checkbox
              key={permission.id}
              mode={mode}
              checked={demo.permissions[permission.id]}
              onChange={() => demo.togglePermission(permission.id)}
              label={permission.label}
              hint={permission.hint}
            />
          ))}
        </div>
      ) : null}
    </div>
  );

  return (
    <>
      <header className="p7-create__head">
        <div>
          <strong>Nuevo agente</strong>
          <span aria-live="polite">
            Paso {demo.createStep + 1} de {CREATE_STEPS.length} · {step.title}
          </span>
        </div>
        <SceneButton
          mode={mode}
          variant="icon"
          onClick={demo.closeCreate}
          aria-label="Cerrar creación de agente"
        >
          <CloseIcon size={13} />
        </SceneButton>
      </header>

      <div className="p7-create__body">
        <P7Dots mode={mode} count={CREATE_STEPS.length} active={demo.createStep} />
        <div className="p7-create__stage">
          {mode === 'animate' ? (
            <AnimatePresence mode="wait" initial={false} custom={demo.createDir}>
              <motion.div
                key={demo.createStep}
                custom={demo.createDir}
                variants={variants}
                initial="enter"
                animate="center"
                exit="exit"
              >
                {stepBody}
              </motion.div>
            </AnimatePresence>
          ) : (
            <div key={demo.createStep} className="motion-panel-in">
              {stepBody}
            </div>
          )}
        </div>
      </div>

      <footer className="p7-create__foot">
        <SceneButton
          mode={mode}
          variant="ghost"
          className="cmp-btn--sm"
          onClick={demo.backCreate}
          disabled={demo.createStep === 0}
        >
          Atrás
        </SceneButton>
        <SceneButton
          mode={mode}
          variant="primary"
          className="cmp-btn--sm"
          onClick={demo.nextCreate}
          disabled={nextDisabled}
        >
          {isLast ? 'Crear agente' : 'Siguiente'}
        </SceneButton>
      </footer>
    </>
  );
}

function CreateDrawer({
  mode,
  demo,
  presence,
}: {
  mode: CompareVariant;
  demo: AgentsDemo;
  presence: ReturnType<typeof usePresence>;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const closeOnEscape = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') demo.closeCreate();
  };

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <>
        <div
          className={`cmp-scrim ${motionSurfaceClass(presence.phase, 'scrim')}`}
          onClick={demo.closeCreate}
          aria-hidden="true"
        />
        <aside
          className={`p7-create ${motionSurfaceClass(presence.phase, 'panel')}`}
          role="dialog"
          aria-label="Nuevo agente"
          onKeyDown={closeOnEscape}
        >
          <CreateForm mode={mode} demo={demo} />
        </aside>
      </>
    );
  }

  return (
    <>
      <AnimatePresence>
        {demo.createOpen ? (
          <motion.div
            className="cmp-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: motionTokens.tweens.overlay }}
            exit={{ opacity: 0, transition: motionTokens.tweens.overlay }}
            onClick={demo.closeCreate}
            aria-hidden="true"
          />
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {demo.createOpen ? (
          <motion.aside
            className="p7-create"
            role="dialog"
            aria-label="Nuevo agente"
            initial={{ x: reduce ? 0 : '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1, transition: motionTokens.tweens.sheet }}
            exit={{
              x: reduce ? 0 : '100%',
              opacity: 0,
              transition: motionTokens.tweens.dismiss,
            }}
            onKeyDown={closeOnEscape}
          >
            <CreateForm mode={mode} demo={demo} />
          </motion.aside>
        ) : null}
      </AnimatePresence>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Pane                                                                       */
/* -------------------------------------------------------------------------- */

function AgentsPane({ mode, demo }: { mode: CompareVariant; demo: AgentsDemo }) {
  const motionTokens = useLabMotion();
  const presence = usePresence(demo.createOpen);

  const stateKey = demo.loading
    ? 'loading'
    : demo.filtered.length === 0
      ? `empty-${demo.filter}`
      : `grid-${demo.filter}`;

  const grid =
    demo.loading ? (
      <div className="p7-agents__grid">
        <AgentSkeleton />
        <AgentSkeleton />
        <AgentSkeleton />
      </div>
    ) : demo.filtered.length === 0 ? (
      <div className="p7-empty">
        <span className="p7-empty__mark" aria-hidden="true">
          <PlusIcon size={16} />
        </span>
        <strong>
          {demo.filter === 'draft' ? 'No hay borradores' : 'No hay agentes activos'}
        </strong>
        <p>
          Creá un agente y elegí su modelo y permisos. Va a quedar como borrador hasta que lo
          actives.
        </p>
        <SceneButton
          mode={mode}
          variant="primary"
          className="cmp-btn--sm"
          onClick={demo.openCreate}
          aria-haspopup="dialog"
        >
          <PlusIcon size={12} />
          Crear agente
        </SceneButton>
      </div>
    ) : (
      <div className="p7-agents__grid" role="list">
        {mode === 'animate' ? (
          <AnimatePresence initial={false}>
            {demo.filtered.map((agent) => (
              <AgentCard
                key={agent.id}
                mode={mode}
                agent={agent}
                selected={demo.selectedId === agent.id}
                onSelect={() => demo.select(agent.id)}
                onToggleStatus={() => demo.toggleStatus(agent.id)}
              />
            ))}
          </AnimatePresence>
        ) : (
          demo.filtered.map((agent) => (
            <AgentCard
              key={agent.id}
              mode={mode}
              agent={agent}
              selected={demo.selectedId === agent.id}
              onSelect={() => demo.select(agent.id)}
              onToggleStatus={() => demo.toggleStatus(agent.id)}
            />
          ))
        )}
      </div>
    );

  return (
    <div className="p7-agents">
      <header className="cmp-card__head">
        <div>
          <strong>Agentes del workspace</strong>
          <span>{demo.agents.length} configurados · mismo estado en las dos columnas</span>
        </div>
        <span className="cmp-badge">{demo.loading ? 'cargando' : 'en vivo'}</span>
      </header>

      <div className="p7-agents__toolbar">
        <div className="p7-filters" role="group" aria-label="Filtrar agentes">
          {FILTERS.map((item) => {
            const active = demo.filter === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={`p7-filter p7-filter--${mode}${active ? ' is-active' : ''}`}
                aria-pressed={active}
                onClick={() => demo.setFilter(item.id)}
              >
                {mode === 'animate' && active ? (
                  <motion.span
                    layoutId="p7-agent-filter"
                    className="p7-filter__indicator"
                    initial={false}
                    transition={motionTokens.springs.selection}
                    aria-hidden="true"
                  />
                ) : null}
                <span className="p7-filter__label">{item.label}</span>
              </button>
            );
          })}
        </div>

        <span className="p7-agents__spacer" />

        <SceneButton
          mode={mode}
          variant="ghost"
          className="cmp-btn--sm"
          onClick={demo.reload}
          disabled={demo.loading}
        >
          {mode === 'animate' ? (
            <SwapLabel
              value={demo.loading ? 'Cargando…' : 'Recargar'}
              labels={['Recargar', 'Cargando…']}
            />
          ) : demo.loading ? (
            'Cargando…'
          ) : (
            'Recargar'
          )}
        </SceneButton>
        <SceneButton
          mode={mode}
          variant="primary"
          className="cmp-btn--sm"
          onClick={demo.openCreate}
          aria-haspopup="dialog"
        >
          <PlusIcon size={12} />
          Nuevo agente
        </SceneButton>
      </div>

      <div className="p7-agents__body" aria-busy={demo.loading}>
        {mode === 'animate' ? (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={stateKey}
              className="p7-agents__state"
              initial={{
                opacity: 0,
                y: motionTokens.travel(6),
                filter: motionTokens.surfaceBlur,
              }}
              animate={{
                opacity: 1,
                y: 0,
                filter: 'blur(0px)',
                transition: motionTokens.tweens.reveal,
              }}
              exit={{
                opacity: 0,
                filter: motionTokens.surfaceBlur,
                transition: motionTokens.tweens.dismiss,
              }}
            >
              {grid}
            </motion.div>
          </AnimatePresence>
        ) : (
          <div key={stateKey} className="p7-agents__state motion-row-in">
            {grid}
          </div>
        )}
      </div>

      <CreateDrawer mode={mode} demo={demo} presence={presence} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Scene                                                                      */
/* -------------------------------------------------------------------------- */

export function AgentsScene({ view }: { view: CompareView }) {
  const demo = useAgentsDemo();

  return (
    <CompareScene
      index="05"
      title="Galería de agentes"
      target="AgentsView · AgentCard · CreateAgentFlow"
      note="Misma selección, mismo filtro y mismo flujo de creación. Kite cambia el borde y abre el drawer con la animación de panel de 180 ms; Animate UI desliza el anillo entre tarjetas, dibuja el check y entra desde el borde."
      view={view}
    >
      {(mode) => <AgentsPane mode={mode} demo={demo} />}
    </CompareScene>
  );
}
