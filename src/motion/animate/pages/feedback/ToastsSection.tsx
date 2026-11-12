import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { motionSurfaceClass } from '../../../surface';
import { usePresence } from '../../../usePresence';
import { useLabMotion, useLabReduce } from '../../context';
import {
  CompareScene,
  SceneButton,
  type CompareVariant,
  type CompareView,
} from '../../frame';
import { CheckIcon, CloseIcon } from '../../ui';

const REMOVE_MS = 240;
const TOAST_TTL_MS = 5600;

/* -------------------------------------------------------------------------- */
/* Scene 1 — Toasts                                                           */
/* -------------------------------------------------------------------------- */

type ToastTone = 'ok' | 'warn' | 'error';

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  message: string;
  action: string;
  auto: boolean;
  leaving: boolean;
}

const TOAST_COPY: Record<ToastTone, Pick<ToastItem, 'title' | 'message' | 'action'>> = {
  ok: {
    title: 'Cambios guardados',
    message: 'La configuración del agente quedó sincronizada.',
    action: 'Deshacer',
  },
  warn: {
    title: 'Cuota al 82%',
    message: 'Quedan pocos tickets para este mes.',
    action: 'Revisar',
  },
  error: {
    title: 'No se pudo publicar',
    message: 'El agente perdió la conexión con el workspace.',
    action: 'Reintentar',
  },
};

const SEED_TOASTS: ToastItem[] = [
  { id: 1, tone: 'ok', ...TOAST_COPY.ok, auto: false, leaving: false },
  { id: 2, tone: 'warn', ...TOAST_COPY.warn, auto: false, leaving: false },
  { id: 3, tone: 'error', ...TOAST_COPY.error, auto: false, leaving: false },
];

function ToastBody({
  mode,
  toast,
  onDismiss,
  onAction,
}: {
  mode: CompareVariant;
  toast: ToastItem;
  onDismiss: (id: number) => void;
  onAction: (toast: ToastItem) => void;
}) {
  return (
    <>
      <span className="p3-toast__mark" aria-hidden="true">
        {toast.tone === 'ok' ? <CheckIcon size={10} /> : toast.tone === 'warn' ? '!' : '×'}
      </span>
      <div className="p3-toast__copy">
        <strong>{toast.title}</strong>
        <span>{toast.message}</span>
      </div>
      <SceneButton
        mode={mode}
        variant="ghost"
        className="p3-toast__action"
        onClick={() => onAction(toast)}
      >
        {toast.action}
      </SceneButton>
      <SceneButton
        mode={mode}
        variant="icon"
        className="p3-toast__close"
        onClick={() => onDismiss(toast.id)}
        aria-label={`Descartar ${toast.title}`}
      >
        <CloseIcon size={11} />
      </SceneButton>
      {toast.auto && (
        <span className="p3-toast__progress" aria-hidden="true">
          <i />
        </span>
      )}
    </>
  );
}

/** Kite toast: CSS enter/exit, manual pointer drag, timed removal from the list. */
function KiteToast({
  toast,
  isFront,
  onDismiss,
  onAction,
}: {
  toast: ToastItem;
  isFront: boolean;
  onDismiss: (id: number) => void;
  onAction: (toast: ToastItem) => void;
}) {
  const presence = usePresence(!toast.leaving);
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const startX = useRef<number | null>(null);
  const dragOffset = useRef(0);
  const [entered, setEntered] = useState(false);

  if (!presence.mounted) return null;

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    startX.current = event.clientX;
    dragOffset.current = 0;
    if (!entered) setEntered(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const node = nodeRef.current;
    if (startX.current === null || !node) return;
    dragOffset.current = event.clientX - startX.current;
    node.style.transition = 'none';
    node.style.transform = `translateX(${dragOffset.current}px)`;
  };

  const finishDrag = (allowDismiss: boolean) => {
    const travelled = dragOffset.current;
    const node = nodeRef.current;
    startX.current = null;
    dragOffset.current = 0;
    if (node) {
      node.style.transition = 'transform 160ms var(--motion-ease)';
      node.style.transform = '';
    }
    if (allowDismiss && Math.abs(travelled) > 64) onDismiss(toast.id);
  };

  const phaseClass =
    presence.phase === 'in'
      ? entered
        ? ''
        : 'motion-row-in'
      : motionSurfaceClass('out', 'popover');

  return (
    <div
      ref={nodeRef}
      className={`p3-toast${isFront ? '' : ' is-back'} ${phaseClass}`.trim()}
      data-tone={toast.tone}
      onAnimationEnd={() => {
        if (presence.phase === 'in') setEntered(true);
      }}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={() => finishDrag(true)}
      onPointerCancel={() => finishDrag(false)}
    >
      <ToastBody mode="kite" toast={toast} onDismiss={onDismiss} onAction={onAction} />
    </div>
  );
}

/** Animate UI toast: enters from the edge, exits in place, swipe to dismiss. */
function AnimateToast({
  toast,
  isFront,
  expanded,
  onDismiss,
  onAction,
}: {
  toast: ToastItem;
  isFront: boolean;
  expanded: boolean;
  onDismiss: (id: number) => void;
  onAction: (toast: ToastItem) => void;
}) {
  const motionTokens = useLabMotion();

  return (
    <motion.div
      layout="position"
      className={`p3-toast${isFront || expanded ? '' : ' is-back'}`}
      data-tone={toast.tone}
      initial={{
        opacity: 0,
        y: '100%',
        scale: motionTokens.scale.toast,
        filter: motionTokens.surfaceBlur,
      }}
      animate={{
        opacity: isFront || expanded ? 1 : 0.62,
        y: 0,
        scale: 1,
        filter: 'blur(0px)',
        transition: motionTokens.springs.toast,
      }}
      exit={{
        opacity: 0,
        scale: motionTokens.scale.toast,
        filter: motionTokens.surfaceBlur,
        transition: motionTokens.tweens.dismiss,
      }}
      transition={motionTokens.springs.toast}
      style={{ originY: 1 }}
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={{ left: 0.04, right: 0.4 }}
      onDragEnd={(_, info) => {
        if (Math.abs(info.offset.x) > 64) onDismiss(toast.id);
      }}
    >
      <ToastBody mode="animate" toast={toast} onDismiss={onDismiss} onAction={onAction} />
    </motion.div>
  );
}

function ToastColumn({
  mode,
  toasts,
  onAdd,
  onDismiss,
  onClear,
  onAction,
  actionNote,
}: {
  mode: CompareVariant;
  toasts: ToastItem[];
  onAdd: (tone: ToastTone) => void;
  onDismiss: (id: number) => void;
  onClear: () => void;
  onAction: (toast: ToastItem) => void;
  actionNote: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = toasts.filter((toast) => !toast.leaving);
  const frontId = visible[visible.length - 1]?.id;

  const releaseFocus = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (!next || !event.currentTarget.contains(next)) setExpanded(false);
  };

  return (
    <div className="p3-pane" data-mode={mode}>
      <div className="p3-toast-stage">
        <div className="p3-toolbar">
          <SceneButton
            mode={mode}
            variant="primary"
            className="cmp-btn--sm"
            onClick={() => onAdd('ok')}
          >
            Éxito
          </SceneButton>
          <SceneButton
            mode={mode}
            variant="ghost"
            className="cmp-btn--sm p3-tone-warn"
            onClick={() => onAdd('warn')}
          >
            Aviso
          </SceneButton>
          <SceneButton
            mode={mode}
            variant="ghost"
            className="cmp-btn--sm p3-tone-error"
            onClick={() => onAdd('error')}
          >
            Error
          </SceneButton>
          <SceneButton
            mode={mode}
            variant="ghost"
            className="cmp-btn--sm"
            onClick={onClear}
            disabled={visible.length === 0}
          >
            Limpiar
          </SceneButton>
        </div>

        <p className="p3-hint">
          Pasá el puntero o tabulá para expandir la pila. Los avisos nuevos expiran solos a los
          5,6 s con barra de progreso; los tres de muestra quedan fijos.
        </p>

        <div className="p3-toast-stage__floor" aria-hidden="true">
          <span className="p3-toast-stage__line" />
          <span className="p3-toast-stage__line p3-toast-stage__line--short" />
          <span className="p3-toast-stage__line" />
          <span className="p3-toast-stage__line p3-toast-stage__line--short" />
        </div>

        <span className="p3-hint p3-toast-stage__note" role="status">
          {actionNote || 'La pila vive en el borde inferior derecho.'}
        </span>

        <div
          className={`p3-toasts${expanded ? ' is-expanded' : ''}`}
          aria-live="polite"
          aria-label="Pila de notificaciones"
          onPointerEnter={() => setExpanded(true)}
          onPointerLeave={() => setExpanded(false)}
          onFocusCapture={() => setExpanded(true)}
          onBlurCapture={releaseFocus}
        >
          {mode === 'kite' ? (
            toasts.map((toast) => (
              <KiteToast
                key={toast.id}
                toast={toast}
                isFront={toast.id === frontId}
                onDismiss={onDismiss}
                onAction={onAction}
              />
            ))
          ) : (
            <AnimatePresence initial={false}>
              {visible.map((toast) => (
                <AnimateToast
                  key={toast.id}
                  toast={toast}
                  isFront={toast.id === frontId}
                  expanded={expanded}
                  onDismiss={onDismiss}
                  onAction={onAction}
                />
              ))}
            </AnimatePresence>
          )}
        </div>
      </div>
    </div>
  );
}

export function ToastsSection({ view }: { view: CompareView }) {
  const reduce = useLabReduce();
  const [toasts, setToasts] = useState<ToastItem[]>(SEED_TOASTS);
  const [actionNote, setActionNote] = useState('');
  const sequence = useRef(SEED_TOASTS.length);
  const timers = useRef(new Map<number, number[]>());

  useEffect(
    () => () => {
      timers.current.forEach((handles) => {
        handles.forEach((handle) => window.clearTimeout(handle));
      });
      timers.current.clear();
    },
    []
  );

  const track = (id: number, callback: () => void, delay: number) => {
    const handle = window.setTimeout(callback, delay);
    timers.current.set(id, [...(timers.current.get(id) ?? []), handle]);
  };

  const clearFor = (id: number) => {
    timers.current.get(id)?.forEach((handle) => window.clearTimeout(handle));
    timers.current.delete(id);
  };

  const remove = (id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  };

  const beginLeave = (id: number) => {
    clearFor(id);
    setToasts((prev) =>
      prev.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast))
    );
    track(id, () => remove(id), reduce ? 0 : REMOVE_MS);
  };

  const addToast = (tone: ToastTone) => {
    sequence.current += 1;
    const id = sequence.current;
    const item: ToastItem = {
      id,
      tone,
      ...TOAST_COPY[tone],
      auto: true,
      leaving: false,
    };
    setActionNote('');
    setToasts((prev) => [...prev, item]);
    track(id, () => beginLeave(id), TOAST_TTL_MS);
  };

  const clearToasts = () => {
    toasts
      .filter((toast) => !toast.leaving)
      .forEach((toast) => beginLeave(toast.id));
  };

  const runAction = (toast: ToastItem) => {
    setActionNote(`Acción «${toast.action}» aplicada sobre «${toast.title}».`);
    beginLeave(toast.id);
  };

  return (
    <CompareScene
      index="3.1"
      title="Toasts"
      target="Toast stack · notifications"
      note="Tres tonos, pila con solapamiento y expansión al pasar el puntero. Kite entra con transform y opacidad y se descarta con botón o arrastre; Animate UI sube desde el borde con spring.toast, reordena la pila con layout y deja que el gesto siga al puntero."
      view={view}
    >
      {(mode) => (
        <ToastColumn
          mode={mode}
          toasts={toasts}
          onAdd={addToast}
          onDismiss={beginLeave}
          onClear={clearToasts}
          onAction={runAction}
          actionNote={actionNote}
        />
      )}
    </CompareScene>
  );
}

export { ToastsSection as ToastsScene };
