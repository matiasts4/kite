import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useAnimate } from 'motion/react';
import { useLabMotion, useLabReduce } from '../../context';
import {
  CompareScene,
  SceneButton,
  type CompareVariant,
  type CompareView,
} from '../../frame';
import { BellIcon, CloseIcon, PlusIcon, SwapLabel } from '../../ui';
import { Spinner } from './SkeletonsSection';

/** tokens.ts paces spring.bounce at runtime but omits it from the LabSprings type. */
type SpringsWithBounce = ReturnType<typeof useLabMotion>['springs'] & {
  bounce: ReturnType<typeof useLabMotion>['springs']['pop'];
};

function useBounceSpring() {
  const motionTokens = useLabMotion();
  return (motionTokens.springs as SpringsWithBounce).bounce;
}

/* -------------------------------------------------------------------------- */
/* Scene 5 — Badges, states and save status                                   */
/* -------------------------------------------------------------------------- */

type RunListState = 'ready' | 'empty' | 'error';
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
type AgentStatus = 'activo' | 'pausado' | 'error';

const AGENT_STATUSES: AgentStatus[] = ['activo', 'pausado', 'error'];

const STATUS_LABELS: Record<AgentStatus, string> = {
  activo: 'Activo',
  pausado: 'Pausado',
  error: 'Con errores',
};

const SAVE_LABELS: Record<SaveStatus, string> = {
  idle: 'Guardar cambios',
  saving: 'Guardando…',
  saved: 'Guardado',
  error: 'Reintentar',
};

const SAVE_HINTS: Record<SaveStatus, string> = {
  idle: 'Sin cambios pendientes.',
  saving: 'Escribiendo la configuración…',
  saved: 'Cambios guardados en el workspace.',
  error: 'No se pudo guardar. Probá de nuevo.',
};

const SAVE_BADGES: Record<SaveStatus, string> = {
  idle: 'listo',
  saving: 'guardando',
  saved: 'guardado',
  error: 'error',
};

function CountBadge({ mode, count }: { mode: CompareVariant; count: number }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const bump = useBounceSpring();
  const [scope, animateBadge] = useAnimate<HTMLSpanElement>();
  const previous = useRef(count);

  useEffect(() => {
    if (count > previous.current && !reduce && scope.current) {
      void animateBadge(scope.current, { scale: [1.15, 1] }, bump);
    }
    previous.current = count;
  }, [count, reduce, animateBadge, scope, motionTokens, bump]);

  if (mode === 'kite') {
    return (
      <span
        className="p3-notif"
        role="img"
        aria-label={`${count} notificaciones sin leer`}
      >
        <BellIcon size={16} />
        {count > 0 && <span className="p3-count">{count}</span>}
      </span>
    );
  }

  return (
    <span
      className="p3-notif"
      role="img"
      aria-label={`${count} notificaciones sin leer`}
    >
      <BellIcon size={16} />
      {count > 0 && (
        <motion.span ref={scope} className="p3-count">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={count}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6, transition: motionTokens.tweens.swap }}
              transition={motionTokens.tweens.swap}
            >
              {count}
            </motion.span>
          </AnimatePresence>
        </motion.span>
      )}
    </span>
  );
}

function LiveBadge({ mode }: { mode: CompareVariant }) {
  const reduce = useLabReduce();

  return (
    <span className="p3-live">
      {mode === 'animate' && !reduce ? (
        <motion.span
          className="p3-live__dot"
          aria-hidden="true"
          animate={{ opacity: [1, 0.35, 1], scale: [1, 1.2, 1] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
        />
      ) : (
        <span
          className={`p3-live__dot${mode === 'kite' && !reduce ? ' p3-live__dot--css' : ''}`}
          aria-hidden="true"
        />
      )}
      En vivo
    </span>
  );
}

function RunHistory({
  mode,
  state,
  onState,
  reduce,
}: {
  mode: CompareVariant;
  state: RunListState;
  onState: (next: RunListState) => void;
  reduce: boolean;
}) {
  const motionTokens = useLabMotion();

  const body =
    state === 'ready' ? (
      <div className="p3-runs">
        <div className="p3-run">
          <span className="p3-run__name">feat/motion</span>
          <span className="cmp-badge">ok</span>
          <span className="p3-hint">hace 2 min</span>
        </div>
        <div className="p3-run">
          <span className="p3-run__name">fix/dock</span>
          <span className="cmp-badge">ok</span>
          <span className="p3-hint">hace 18 min</span>
        </div>
        <div className="p3-run">
          <span className="p3-run__name">agents/preview</span>
          <span className="cmp-badge p3-badge--warn">warn</span>
          <span className="p3-hint">ayer</span>
        </div>
      </div>
    ) : state === 'empty' ? (
      <div className="p3-state">
        <span className="p3-state__icon" aria-hidden="true">
          <PlusIcon size={14} />
        </span>
        <h3>Sin ejecuciones todavía</h3>
        <p>Cuando un agente corra una tarea, el historial aparece acá.</p>
        <SceneButton
          mode={mode}
          variant="primary"
          className="cmp-btn--sm"
          onClick={() => onState('ready')}
        >
          Crear ejecución
        </SceneButton>
      </div>
    ) : (
      <div className="p3-state">
        <span className="p3-state__icon p3-state__icon--error" aria-hidden="true">
          <CloseIcon size={14} />
        </span>
        <h3>No pudimos cargar el historial</h3>
        <p>El servicio de runs no respondió. Reintentá en unos segundos.</p>
        <SceneButton
          mode={mode}
          variant="primary"
          className="cmp-btn--sm"
          onClick={() => onState('ready')}
        >
          Reintentar
        </SceneButton>
      </div>
    );

  return (
    <section className="p3-panel p3-history">
      <div className="p3-panel__head">
        <strong>Historial de ejecuciones</strong>
        <div className="p3-segment" role="group" aria-label="Estado del historial">
          {(['ready', 'empty', 'error'] as RunListState[]).map((next) => (
            <button
              key={next}
              type="button"
              className={`p3-segment__item${state === next ? ' is-active' : ''}`}
              aria-pressed={state === next}
              onClick={() => onState(next)}
            >
              {next === 'ready' ? 'Con datos' : next === 'empty' ? 'Vacío' : 'Error'}
            </button>
          ))}
        </div>
      </div>

      {mode === 'kite' ? (
        <div key={state} className="motion-row-in p3-state-wrap">
          {body}
        </div>
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={state}
            className="p3-state-wrap"
            initial={{
              opacity: 0,
              x: reduce ? 0 : motionTokens.travel(motionTokens.shift.tabs),
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
              x: reduce ? 0 : -motionTokens.travel(motionTokens.shift.tabs),
              filter: motionTokens.blur.panel,
              transition: motionTokens.tweens.panelOut,
            }}
          >
            {body}
          </motion.div>
        </AnimatePresence>
      )}

      <span className="p3-sr" role="status" aria-live="polite">
        {state === 'ready'
          ? 'Historial cargado.'
          : state === 'empty'
            ? 'El historial está vacío.'
            : 'Error al cargar el historial.'}
      </span>
    </section>
  );
}

function StatusColumn({
  mode,
  count,
  unread,
  status,
  runState,
  saveStatus,
  simulateError,
  onCount,
  onToggleRead,
  onCycleStatus,
  onRunState,
  onSave,
  onSimulateError,
}: {
  mode: CompareVariant;
  count: number;
  unread: boolean;
  status: AgentStatus;
  runState: RunListState;
  saveStatus: SaveStatus;
  simulateError: boolean;
  onCount: (next: number) => void;
  onToggleRead: () => void;
  onCycleStatus: () => void;
  onRunState: (next: RunListState) => void;
  onSave: () => void;
  onSimulateError: (next: boolean) => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const bump = useBounceSpring();

  return (
    <div className="p3-pane" data-mode={mode}>
      <div className="p3-status-grid">
        <div className="p3-tile">
          <span className="p3-tile__label">Presencia</span>
          <LiveBadge mode={mode} />
          <span className="p3-hint">Sesión conectada al workspace.</span>
        </div>

        <div className="p3-tile">
          <span className="p3-tile__label">Contador</span>
          <div className="p3-tile__row">
            <CountBadge mode={mode} count={count} />
            <SceneButton
              mode={mode}
              variant="ghost"
              className="cmp-btn--sm"
              onClick={() => onCount(count + 1)}
            >
              +1
            </SceneButton>
            <SceneButton
              mode={mode}
              variant="ghost"
              className="cmp-btn--sm"
              onClick={() => onCount(Math.max(0, count - 1))}
            >
              −1
            </SceneButton>
          </div>
          <span className="p3-hint">Solo el aumento hace bump en Animate UI.</span>
          <span className="p3-sr" role="status" aria-live="polite">
            {count} notificaciones sin leer.
          </span>
        </div>

        <div className="p3-tile">
          <span className="p3-tile__label">Sin leer</span>
          <div className="p3-tile__row">
            <span className="p3-unread-anchor">
              <BellIcon size={16} />
              {mode === 'animate' ? (
                <AnimatePresence>
                  {unread && (
                    <motion.span
                      className="p3-unread"
                      initial={{ scale: reduce ? 1 : motionTokens.scale.icon, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      exit={{
                        scale: reduce ? 1 : motionTokens.scale.icon,
                        opacity: 0,
                        transition: motionTokens.tweens.dismiss,
                      }}
                      transition={bump}
                      aria-hidden="true"
                    />
                  )}
                </AnimatePresence>
              ) : (
                unread && <span className="p3-unread motion-row-in" aria-hidden="true" />
              )}
            </span>
            <SceneButton
              mode={mode}
              variant="ghost"
              className="cmp-btn--sm"
              onClick={onToggleRead}
              aria-pressed={unread}
            >
              {unread ? 'Marcar leído' : 'Marcar no leído'}
            </SceneButton>
          </div>
          <span className="p3-hint">El punto aparece y desaparece con el estado.</span>
        </div>

        <div className="p3-tile">
          <span className="p3-tile__label">Estado del agente</span>
          <div className="p3-tile__row">
            <span
              className="p3-pill"
              data-status={status}
              role="status"
              aria-live="polite"
            >
              <span className="p3-pill__dot" aria-hidden="true" />
              {mode === 'animate' ? (
                <SwapLabel
                  value={STATUS_LABELS[status]}
                  labels={['Activo', 'Pausado', 'Con errores']}
                />
              ) : (
                STATUS_LABELS[status]
              )}
            </span>
            <SceneButton
              mode={mode}
              variant="ghost"
              className="cmp-btn--sm"
              onClick={onCycleStatus}
            >
              Cambiar
            </SceneButton>
          </div>
          <span className="p3-hint">El color transiciona; la etiqueta se cruza con blur.</span>
        </div>
      </div>

      <div className="p3-status-panels">
        <RunHistory mode={mode} state={runState} onState={onRunState} reduce={reduce} />

        <section className="p3-panel p3-save">
          <div className="p3-panel__head">
            <strong>Guardado del agente</strong>
            <span className="cmp-badge" data-save={saveStatus}>
              {SAVE_BADGES[saveStatus]}
            </span>
          </div>

          <div className="p3-save__row">
            <SceneButton
              mode={mode}
              variant={saveStatus === 'error' ? 'primary' : 'default'}
              className="p3-save__button"
              onClick={onSave}
              disabled={saveStatus === 'saving'}
            >
              {saveStatus === 'saving' && <Spinner mode={mode} size={11} />}
              {mode === 'animate' ? (
                <SwapLabel
                  value={SAVE_LABELS[saveStatus]}
                  labels={['Guardar cambios', 'Guardando…', 'Guardado', 'Reintentar']}
                />
              ) : (
                SAVE_LABELS[saveStatus]
              )}
            </SceneButton>
            <label className="p3-check">
              <input
                type="checkbox"
                checked={simulateError}
                onChange={(event) => onSimulateError(event.target.checked)}
              />
              Simular fallo
            </label>
          </div>

          <p
            className={`p3-save__status${saveStatus === 'error' ? ' is-error' : ''}`}
            role="status"
            aria-live="polite"
          >
            {SAVE_HINTS[saveStatus]}
          </p>
        </section>
      </div>
    </div>
  );
}

export function BadgesSection({ view }: { view: CompareView }) {
  const [count, setCount] = useState(3);
  const [unread, setUnread] = useState(true);
  const [status, setStatus] = useState<AgentStatus>('activo');
  const [runState, setRunState] = useState<RunListState>('ready');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [simulateError, setSimulateError] = useState(false);
  const saveTimer = useRef<number | null>(null);
  const idleTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    },
    []
  );

  const cycleStatus = () => {
    setStatus((current) => {
      const next = AGENT_STATUSES[(AGENT_STATUSES.indexOf(current) + 1) % AGENT_STATUSES.length];
      return next;
    });
  };

  const save = () => {
    if (saveStatus === 'saving') return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    setSaveStatus('saving');
    saveTimer.current = window.setTimeout(() => {
      if (simulateError) {
        setSaveStatus('error');
        return;
      }
      setSaveStatus('saved');
      idleTimer.current = window.setTimeout(() => setSaveStatus('idle'), 1500);
    }, 950);
  };

  return (
    <CompareScene
      index="3.5"
      title="Badges, estados y guardado"
      target="Badge · StatusPill · EmptyState · SaveButton"
      note="Presencia en vivo, contador con bump, punto de no leído y píldora de estado. Abajo, historial vacío o con error y su reintento, más el botón de guardado idle → saving → saved → error. Activá «Simular fallo» para ver el error y reintentar."
      view={view}
    >
      {(mode) => (
        <StatusColumn
          mode={mode}
          count={count}
          unread={unread}
          status={status}
          runState={runState}
          saveStatus={saveStatus}
          simulateError={simulateError}
          onCount={setCount}
          onToggleRead={() => setUnread((value) => !value)}
          onCycleStatus={cycleStatus}
          onRunState={setRunState}
          onSave={save}
          onSimulateError={setSimulateError}
        />
      )}
    </CompareScene>
  );
}

export { BadgesSection as StatusScene };
