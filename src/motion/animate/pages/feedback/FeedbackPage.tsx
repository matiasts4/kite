import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  AnimatePresence,
  animate,
  motion,
  useAnimate,
  useAnimationControls,
} from 'motion/react';
import { motionSurfaceClass } from '../../../surface';
import { usePresence } from '../../../usePresence';
import { useLabMotion, useLabReduce } from '../../context';
import {
  CompareScene,
  SceneButton,
  type CompareVariant,
  type CompareView,
} from '../../frame';
import { BellIcon, CheckIcon, CloseIcon, PlusIcon, SwapLabel } from '../../ui';
import './feedback.css';

const REMOVE_MS = 240;
const TOAST_TTL_MS = 5600;

/** transition.shake from the Animate UI tokens; LabTweens does not expose it yet. */
const SHAKE_EASE: [number, number, number, number] = [0.77, 0, 0.175, 1];

/** tokens.ts paces spring.bounce at runtime but omits it from the LabSprings type. */
type SpringsWithBounce = ReturnType<typeof useLabMotion>['springs'] & {
  bounce: ReturnType<typeof useLabMotion>['springs']['pop'];
};

function useBounceSpring() {
  const motionTokens = useLabMotion();
  return (motionTokens.springs as SpringsWithBounce).bounce;
}

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

function ToastsScene({ view }: { view: CompareView }) {
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

/* -------------------------------------------------------------------------- */
/* Scene 2 — Banners + inline validation                                      */
/* -------------------------------------------------------------------------- */

type BannerTone = 'info' | 'ok' | 'error';

const BANNER_TONES: BannerTone[] = ['info', 'ok', 'error'];

const BANNER_COPY: Record<BannerTone, { label: string; title: string; body: string; action?: string }> = {
  info: {
    label: 'Info',
    title: 'Nueva versión disponible',
    body: 'Kite 0.2 trae diffs más rápidos y un dock redimensionable.',
  },
  ok: {
    label: 'Éxito',
    title: 'Workspace sincronizado',
    body: 'Los 12 hilos y sus adjuntos quedaron guardados.',
  },
  error: {
    label: 'Error',
    title: 'No pudimos conectar',
    body: 'El servicio de runs no respondió. Revisá la red y reintentá.',
    action: 'Reintentar',
  },
};

function BannerBody({
  mode,
  tone,
  onDismiss,
}: {
  mode: CompareVariant;
  tone: BannerTone;
  onDismiss: () => void;
}) {
  const copy = BANNER_COPY[tone];
  return (
    <div
      className="p3-banner"
      data-tone={tone}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <span className="p3-banner__icon" aria-hidden="true">
        {tone === 'ok' ? <CheckIcon size={11} /> : tone === 'error' ? '!' : 'i'}
      </span>
      <div className="p3-banner__copy">
        <strong>{copy.title}</strong>
        <span>{copy.body}</span>
      </div>
      {copy.action && (
        <SceneButton mode={mode} variant="ghost" className="cmp-btn--sm" onClick={onDismiss}>
          {copy.action}
        </SceneButton>
      )}
      <SceneButton
        mode={mode}
        variant="icon"
        className="p3-banner__close"
        onClick={onDismiss}
        aria-label={`Cerrar aviso: ${copy.title}`}
      >
        <CloseIcon size={11} />
      </SceneButton>
    </div>
  );
}

function KiteBannerSlot({
  tone,
  open,
  onDismiss,
}: {
  tone: BannerTone;
  open: boolean;
  onDismiss: () => void;
}) {
  const presence = usePresence(open);
  if (!presence.mounted) return null;
  return (
    <div
      className={`p3-banner-clip ${motionSurfaceClass(presence.phase, 'popover')}`}
    >
      <BannerBody mode="kite" tone={tone} onDismiss={onDismiss} />
    </div>
  );
}

function AnimateBannerSlot({
  tone,
  open,
  onDismiss,
}: {
  tone: BannerTone;
  open: boolean;
  onDismiss: () => void;
}) {
  const motionTokens = useLabMotion();
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key={tone}
          className="p3-banner-clip"
          initial={{ height: 0, opacity: 0, filter: motionTokens.blur.disclosure }}
          animate={{
            height: 'auto',
            opacity: 1,
            filter: 'blur(0px)',
            transition: motionTokens.tweens.disclosure,
          }}
          exit={{
            height: 0,
            opacity: 0,
            filter: motionTokens.blur.disclosure,
            transition: motionTokens.tweens.disclosure,
          }}
        >
          <BannerBody mode="animate" tone={tone} onDismiss={onDismiss} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ValidationForm({
  mode,
  email,
  error,
  status,
  shakeNonce,
  onEmail,
  onSubmit,
}: {
  mode: CompareVariant;
  email: string;
  error: string | null;
  status: string;
  shakeNonce: number;
  onEmail: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const controls = useAnimationControls();
  const [kiteShaking, setKiteShaking] = useState(false);
  const errorId = `p3-email-error-${mode}`;
  const statusId = `p3-email-status-${mode}`;

  useEffect(() => {
    if (shakeNonce === 0 || reduce) return;
    if (mode === 'kite') {
      setKiteShaking(false);
      const frame = window.requestAnimationFrame(() => setKiteShaking(true));
      return () => window.cancelAnimationFrame(frame);
    }
    const distance = motionTokens.shift.shake;
    void controls.start({
      x: [0, -distance, distance, -distance * 0.66, distance * 0.33, 0],
      transition: { duration: 0.4 * motionTokens.tempo, ease: SHAKE_EASE },
    });
    return undefined;
  }, [shakeNonce, reduce, mode, controls, motionTokens]);

  const describedBy = error ? errorId : status ? statusId : undefined;
  const row = (
    <div className="p3-field__row">
      <input
        id={`p3-email-${mode}`}
        className="p3-input"
        value={email}
        onChange={(event) => onEmail(event.target.value)}
        placeholder="ana@kite.dev"
        inputMode="email"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />
      <SceneButton
        mode={mode}
        variant="primary"
        className="cmp-btn--sm"
        type="submit"
        disabled={!email.trim()}
      >
        Invitar
      </SceneButton>
    </div>
  );

  return (
    <form className="p3-form" onSubmit={onSubmit} noValidate>
      <label className="p3-field__label" htmlFor={`p3-email-${mode}`}>
        Correo del workspace
      </label>
      {mode === 'kite' ? (
        <div
          className={`p3-field${error ? ' is-invalid' : ''}${
            kiteShaking ? ' is-shaking' : ''
          }`}
          onAnimationEnd={() => setKiteShaking(false)}
        >
          {row}
        </div>
      ) : (
        <motion.div className={`p3-field${error ? ' is-invalid' : ''}`} animate={controls}>
          {row}
        </motion.div>
      )}
      {error && (
        <p className="p3-field__error" id={errorId} role="alert">
          <span aria-hidden="true">!</span>
          {error}
        </p>
      )}
      {!error && status && (
        <p className="p3-field__ok" id={statusId} role="status">
          <CheckIcon size={10} />
          {status}
        </p>
      )}
    </form>
  );
}

function BannersColumn({
  mode,
  banners,
  onToggle,
  onDismiss,
  email,
  error,
  status,
  shakeNonce,
  onEmail,
  onSubmit,
}: {
  mode: CompareVariant;
  banners: Record<BannerTone, boolean>;
  onToggle: (tone: BannerTone) => void;
  onDismiss: (tone: BannerTone) => void;
  email: string;
  error: string | null;
  status: string;
  shakeNonce: number;
  onEmail: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const dismissAndReturnFocus = (tone: BannerTone) => {
    onDismiss(tone);
    window.setTimeout(() => {
      document.getElementById(`p3-banner-toggle-${mode}-${tone}`)?.focus();
    }, 0);
  };

  return (
    <div className="p3-pane" data-mode={mode}>
      <div className="p3-toolbar">
        {BANNER_TONES.map((tone) => (
          <SceneButton
            key={tone}
            id={`p3-banner-toggle-${mode}-${tone}`}
            mode={mode}
            variant={banners[tone] ? 'default' : 'ghost'}
            className="cmp-btn--sm"
            aria-pressed={banners[tone]}
            onClick={() => onToggle(tone)}
          >
            {BANNER_COPY[tone].label}
          </SceneButton>
        ))}
        <span className="p3-hint">Alterná cada aviso para ver entrada y salida.</span>
      </div>

      <div className="p3-banner-stack">
        {BANNER_TONES.map((tone) =>
          mode === 'kite' ? (
            <KiteBannerSlot
              key={tone}
              tone={tone}
              open={banners[tone]}
              onDismiss={() => dismissAndReturnFocus(tone)}
            />
          ) : (
            <AnimateBannerSlot
              key={tone}
              tone={tone}
              open={banners[tone]}
              onDismiss={() => dismissAndReturnFocus(tone)}
            />
          )
        )}
      </div>

      <ValidationForm
        mode={mode}
        email={email}
        error={error}
        status={status}
        shakeNonce={shakeNonce}
        onEmail={onEmail}
        onSubmit={onSubmit}
      />
    </div>
  );
}

function BannersScene({ view }: { view: CompareView }) {
  const [banners, setBanners] = useState<Record<BannerTone, boolean>>({
    info: true,
    ok: false,
    error: false,
  });
  const [email, setEmail] = useState('ana@kite.dev');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [shakeNonce, setShakeNonce] = useState(0);

  const toggleBanner = (tone: BannerTone) => {
    setBanners((prev) => ({ ...prev, [tone]: !prev[tone] }));
  };

  const dismissBanner = (tone: BannerTone) => {
    setBanners((prev) => ({ ...prev, [tone]: false }));
  };

  const changeEmail = (value: string) => {
    setEmail(value);
    setError(null);
    setStatus('');
  };

  const submitInvite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setError('Ingresá un correo válido, por ejemplo ana@kite.dev.');
      setStatus('');
      setShakeNonce((nonce) => nonce + 1);
      return;
    }
    setError(null);
    setStatus(`Invitación enviada a ${value}.`);
  };

  return (
    <CompareScene
      index="3.2"
      title="Banners y validación"
      target="Banner · FieldError"
      note="Avisos info, éxito y error que empujan el contenido. Kite funde y traslada 4 px; Animate UI abre la altura con transition.disclosure y blur. Abajo, el campo inválido sacude el bloque: CSS en Kite, keyframes con shift.shake y transition.shake en Animate UI."
      view={view}
    >
      {(mode) => (
        <BannersColumn
          mode={mode}
          banners={banners}
          onToggle={toggleBanner}
          onDismiss={dismissBanner}
          email={email}
          error={error}
          status={status}
          shakeNonce={shakeNonce}
          onEmail={changeEmail}
          onSubmit={submitInvite}
        />
      )}
    </CompareScene>
  );
}

/* -------------------------------------------------------------------------- */
/* Scene 3 — Progress                                                         */
/* -------------------------------------------------------------------------- */

function AnimatedCounter({ value }: { value: number }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const [display, setDisplay] = useState(value);
  const current = useRef(value);

  useEffect(() => {
    if (reduce) {
      current.current = value;
      setDisplay(value);
      return undefined;
    }
    if (current.current === value) return undefined;
    const controls = animate(current.current, value, {
      ...motionTokens.springs.number,
      onUpdate: (latest: number) => {
        const next = Math.round(latest);
        current.current = next;
        setDisplay(next);
      },
      onComplete: () => {
        current.current = value;
        setDisplay(value);
      },
    });
    return () => controls.stop();
  }, [value, reduce, motionTokens]);

  return <span className="p3-counter__value">{display.toLocaleString('es-AR')}</span>;
}

function ProgressColumn({
  mode,
  value,
  indeterminate,
  onValue,
  onToggleIndeterminate,
}: {
  mode: CompareVariant;
  value: number;
  indeterminate: boolean;
  onValue: (next: number) => void;
  onToggleIndeterminate: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - value / 100);
  const tickets = 240 + value * 10;

  return (
    <div className="p3-pane" data-mode={mode}>
      <div className="p3-panel">
        <div className="p3-panel__head">
          <strong>Sincronización del workspace</strong>
          <span className="cmp-badge">{value}%</span>
        </div>

        <div className="p3-progress-top">
          <div className="p3-ring">
            <svg
              viewBox="0 0 88 88"
              role="img"
              aria-label={`Progreso de sincronización: ${value} por ciento`}
            >
              <circle className="p3-ring__track" cx="44" cy="44" r={radius} />
              {mode === 'kite' ? (
                <circle
                  className="p3-ring__value"
                  cx="44"
                  cy="44"
                  r={radius}
                  strokeDasharray={circumference}
                  style={{ strokeDashoffset: offset }}
                />
              ) : (
                <motion.circle
                  className="p3-ring__value"
                  cx="44"
                  cy="44"
                  r={radius}
                  strokeDasharray={circumference}
                  initial={false}
                  animate={{ strokeDashoffset: offset }}
                  transition={reduce ? { duration: 0 } : motionTokens.springs.number}
                />
              )}
            </svg>
            <span className="p3-ring__label" aria-hidden="true">
              {value}%
            </span>
          </div>

          <div className="p3-progress-side">
            <div
              className="cmp-meter p3-track"
              role="progressbar"
              aria-label="Progreso de sincronización"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={value}
            >
              {mode === 'kite' ? (
                <span
                  className="cmp-meter__fill p3-fill p3-fill--kite"
                  style={{ width: `${value}%` }}
                />
              ) : reduce ? (
                <span
                  className="cmp-meter__fill p3-fill"
                  style={{ width: `${value}%` }}
                />
              ) : (
                <motion.span
                  className="cmp-meter__fill p3-fill"
                  initial={false}
                  animate={{ scaleX: value / 100 }}
                  transition={motionTokens.springs.number}
                  style={{ transformOrigin: 'left center' }}
                />
              )}
            </div>

            <div className="p3-counter">
              <span className="p3-counter__label">Tickets usados</span>
              {mode === 'animate' ? (
                <AnimatedCounter value={tickets} />
              ) : (
                <span className="p3-counter__value">
                  {tickets.toLocaleString('es-AR')}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="p3-controls">
          <SceneButton
            mode={mode}
            variant="ghost"
            className="cmp-btn--sm"
            onClick={() => onValue(Math.max(0, value - 10))}
          >
            −10
          </SceneButton>
          <input
            className="p3-range"
            type="range"
            min={0}
            max={100}
            step={1}
            value={value}
            onChange={(event) => onValue(Number(event.target.value))}
            aria-label="Progreso de sincronización"
          />
          <SceneButton
            mode={mode}
            variant="ghost"
            className="cmp-btn--sm"
            onClick={() => onValue(Math.min(100, value + 10))}
          >
            +10
          </SceneButton>
          <SceneButton
            mode={mode}
            variant="ghost"
            className="cmp-btn--sm"
            onClick={() => onValue(0)}
          >
            Reiniciar
          </SceneButton>
        </div>
        <p className="p3-hint">
          El rango responde a las flechas del teclado; la barra, el anillo y el contador leen el
          mismo valor.
        </p>
      </div>

      <div className="p3-panel">
        <div className="p3-panel__head">
          <strong>Subida en curso</strong>
          <SceneButton
            mode={mode}
            variant={indeterminate ? 'ghost' : 'primary'}
            className="cmp-btn--sm"
            onClick={onToggleIndeterminate}
            aria-pressed={indeterminate}
          >
            {indeterminate ? 'Detener' : 'Iniciar subida'}
          </SceneButton>
        </div>

        <div
          className="cmp-meter p3-track"
          role="progressbar"
          aria-label="Subida de archivo"
          aria-valuetext={indeterminate ? 'Subiendo' : 'En pausa'}
          aria-busy={indeterminate}
        >
          {indeterminate &&
            (mode === 'kite' && !reduce ? (
              <span className="p3-indeterminate p3-indeterminate--css" />
            ) : mode === 'animate' && !reduce ? (
              <motion.span
                className="p3-indeterminate"
                initial={false}
                animate={{ x: ['-120%', '320%'] }}
                transition={{ duration: 1.15, ease: 'linear', repeat: Infinity }}
              />
            ) : (
              <span className="p3-indeterminate is-static" />
            ))}
        </div>
        <p className="p3-hint">
          Sin valor conocido: Kite usa una animación CSS lineal; Animate UI mueve el mismo bloque
          con un loop de Motion y lo congela con reduced motion.
        </p>
      </div>
    </div>
  );
}

function ProgressScene({ view }: { view: CompareView }) {
  const [value, setValue] = useState(42);
  const [indeterminate, setIndeterminate] = useState(false);

  return (
    <CompareScene
      index="3.3"
      title="Progreso"
      target="ProgressBar · ProgressRing · Counter"
      note="Un valor compartido mueve la barra determinada, el anillo y el contador de tickets. Kite transiciona ancho y stroke con CSS; Animate UI lleva ambos con spring.number y hace rodar el número. La subida indeterminada usa un loop lineal que se detiene con reduced motion."
      view={view}
    >
      {(mode) => (
        <ProgressColumn
          mode={mode}
          value={value}
          indeterminate={indeterminate}
          onValue={setValue}
          onToggleIndeterminate={() => setIndeterminate((current) => !current)}
        />
      )}
    </CompareScene>
  );
}

/* -------------------------------------------------------------------------- */
/* Scene 4 — Skeletons and spinners                                           */
/* -------------------------------------------------------------------------- */

function Spinner({
  mode,
  size = 14,
}: {
  mode: CompareVariant;
  size?: number;
}) {
  const reduce = useLabReduce();

  if (mode === 'kite') {
    return (
      <span
        className="p3-spinner p3-spinner--css"
        style={{ width: size, height: size }}
        aria-hidden="true"
      />
    );
  }

  return (
    <motion.span
      className="p3-spinner"
      style={{ width: size, height: size }}
      aria-hidden="true"
      animate={
        reduce
          ? { rotate: 0, opacity: [1, 0.4, 1] }
          : { rotate: 360, opacity: 1 }
      }
      transition={
        reduce
          ? { duration: 1.8, repeat: Infinity, ease: 'easeInOut' }
          : { duration: 0.9, repeat: Infinity, ease: 'linear' }
      }
    />
  );
}

function ProfileSkeleton() {
  return (
    <div className="p3-skel" aria-hidden="true">
      <div className="p3-skel__profile">
        <span className="p3-skel__avatar p3-shimmer" />
        <div className="p3-skel__lines">
          <span className="p3-skel__bar p3-shimmer" style={{ width: '58%' }} />
          <span className="p3-skel__bar p3-shimmer" style={{ width: '36%' }} />
        </div>
      </div>
      <span className="p3-skel__bar p3-shimmer p3-skel__bar--wide" />
      <span className="p3-skel__bar p3-shimmer" style={{ width: '86%' }} />
      <div className="p3-skel__stats">
        <span className="p3-skel__block p3-shimmer" />
        <span className="p3-skel__block p3-shimmer" />
        <span className="p3-skel__block p3-shimmer" />
      </div>
    </div>
  );
}

function ProfileContent() {
  return (
    <div className="p3-profile">
      <span className="p3-avatar" aria-hidden="true">
        KV
      </span>
      <div className="p3-profile__copy">
        <strong>Kite View</strong>
        <span>Workspace de Ana · 14 miembros</span>
      </div>
      <span className="cmp-badge">pro</span>
      <div className="p3-profile__stats">
        <div>
          <span>Hilos</span>
          <strong>12</strong>
        </div>
        <div>
          <span>Runs</span>
          <strong>48</strong>
        </div>
        <div>
          <span>Tickets</span>
          <strong>660</strong>
        </div>
      </div>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="p3-page-preview" aria-hidden="true">
      <div className="p3-page-preview__head">
        <span className="p3-skel__bar p3-shimmer" style={{ width: '44%' }} />
        <span className="p3-skel__bar p3-shimmer" style={{ width: '20%' }} />
      </div>
      {[0, 1, 2].map((row) => (
        <div key={row} className="p3-page-preview__row">
          <span className="p3-skel__bar p3-shimmer" style={{ width: '54%' }} />
          <span className="p3-skel__block p3-shimmer p3-skel__block--sm" />
        </div>
      ))}
    </div>
  );
}

function PageContent() {
  const runs = [
    { id: 'feat/motion', state: 'ok', detail: 'hace 2 min' },
    { id: 'fix/dock', state: 'ok', detail: 'hace 18 min' },
    { id: 'agents/preview', state: 'warn', detail: 'ayer' },
  ];
  return (
    <div className="p3-page-preview">
      {runs.map((run) => (
        <div key={run.id} className="p3-page-preview__row p3-page-preview__row--loaded">
          <span>{run.id}</span>
          <span className={`cmp-badge${run.state === 'warn' ? ' p3-badge--warn' : ''}`}>
            {run.state === 'ok' ? 'ok' : 'warn'}
          </span>
          <span className="p3-hint">{run.detail}</span>
        </div>
      ))}
    </div>
  );
}

function SkeletonColumn({
  mode,
  cardLoading,
  pageLoading,
  saving,
  syncing,
  saveNote,
  onReloadCard,
  onReloadPage,
  onSave,
  onSync,
}: {
  mode: CompareVariant;
  cardLoading: boolean;
  pageLoading: boolean;
  saving: boolean;
  syncing: boolean;
  saveNote: string;
  onReloadCard: () => void;
  onReloadPage: () => void;
  onSave: () => void;
  onSync: () => void;
}) {
  const motionTokens = useLabMotion();

  return (
    <div className="p3-pane" data-mode={mode}>
      <div className="p3-skel-grid">
        <section className="p3-demo-card" aria-busy={cardLoading} aria-live="polite">
          <div className="p3-demo-card__head">
            <span className="p3-panel__label">Tarjeta del workspace</span>
            <SceneButton
              mode={mode}
              variant="ghost"
              className="cmp-btn--sm"
              onClick={onReloadCard}
              disabled={cardLoading}
            >
              Recargar
            </SceneButton>
          </div>

          {mode === 'kite' ? (
            cardLoading ? (
              <ProfileSkeleton />
            ) : (
              <div className="motion-row-in">
                <ProfileContent />
              </div>
            )
          ) : (
            <div className="p3-crossfade">
              <AnimatePresence mode="popLayout" initial={false}>
                {cardLoading ? (
                  <motion.div
                    key="skeleton"
                    aria-hidden="true"
                    exit={{ opacity: 0, transition: motionTokens.tweens.fade }}
                  >
                    <ProfileSkeleton />
                  </motion.div>
                ) : (
                  <motion.div
                    key="content"
                    initial={{ opacity: 0, filter: motionTokens.surfaceBlur }}
                    animate={{
                      opacity: 1,
                      filter: 'blur(0px)',
                      transition: motionTokens.tweens.reveal,
                    }}
                  >
                    <ProfileContent />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </section>

        <section className="p3-demo-card" aria-busy={pageLoading}>
          <div className="p3-demo-card__head">
            <span className="p3-panel__label">Historial de runs</span>
            <SceneButton
              mode={mode}
              variant="ghost"
              className="cmp-btn--sm"
              onClick={onReloadPage}
              disabled={pageLoading}
            >
              Recargar
            </SceneButton>
          </div>

          {mode === 'kite' ? (
            pageLoading ? (
              <PageSkeleton />
            ) : (
              <div className="motion-row-in">
                <PageContent />
              </div>
            )
          ) : (
            <div className="p3-crossfade">
              <AnimatePresence mode="popLayout" initial={false}>
                {pageLoading ? (
                  <motion.div
                    key="skeleton"
                    aria-hidden="true"
                    exit={{ opacity: 0, transition: motionTokens.tweens.fade }}
                  >
                    <PageSkeleton />
                  </motion.div>
                ) : (
                  <motion.div
                    key="content"
                    initial={{ opacity: 0, filter: motionTokens.surfaceBlur }}
                    animate={{
                      opacity: 1,
                      filter: 'blur(0px)',
                      transition: motionTokens.tweens.reveal,
                    }}
                  >
                    <PageContent />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </section>
      </div>

      <div className="p3-inline" role="status" aria-live="polite">
        {syncing ? (
          <>
            <Spinner mode={mode} size={13} />
            <span>Sincronizando 3 cambios…</span>
          </>
        ) : (
          <>
            <span className="p3-inline__dot" aria-hidden="true" />
            <span>Todo sincronizado</span>
          </>
        )}
        <SceneButton
          mode={mode}
          variant="ghost"
          className="cmp-btn--sm p3-inline__action"
          onClick={onSync}
          disabled={syncing}
        >
          Sincronizar
        </SceneButton>
      </div>

      <div className="p3-toolbar p3-toolbar--between">
        <span className="p3-hint">El shimmer se detiene con reduced motion; el spinner gira más lento.</span>
        <SceneButton
          mode={mode}
          variant="primary"
          className="p3-save-card"
          onClick={onSave}
          disabled={saving}
        >
          {saving && <Spinner mode={mode} size={12} />}
          {mode === 'animate' ? (
            <SwapLabel
              value={saving ? 'Guardando…' : 'Guardar tarjeta'}
              labels={['Guardar tarjeta', 'Guardando…']}
            />
          ) : saving ? (
            'Guardando…'
          ) : (
            'Guardar tarjeta'
          )}
        </SceneButton>
      </div>
      {saveNote && (
        <p className="p3-hint p3-save-note" role="status" aria-live="polite">
          {saveNote}
        </p>
      )}
    </div>
  );
}

function SkeletonsScene({ view }: { view: CompareView }) {
  const [cardLoading, setCardLoading] = useState(true);
  const [pageLoading, setPageLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [saveNote, setSaveNote] = useState('');
  const cardTimer = useRef<number | null>(null);
  const pageTimer = useRef<number | null>(null);
  const saveTimer = useRef<number | null>(null);
  const syncTimer = useRef<number | null>(null);

  useEffect(() => {
    cardTimer.current = window.setTimeout(() => setCardLoading(false), 1400);
    pageTimer.current = window.setTimeout(() => setPageLoading(false), 1850);
    return () => {
      [cardTimer, pageTimer, saveTimer, syncTimer].forEach((timer) => {
        if (timer.current !== null) window.clearTimeout(timer.current);
      });
    };
  }, []);

  const reloadCard = () => {
    if (cardTimer.current !== null) window.clearTimeout(cardTimer.current);
    setCardLoading(true);
    cardTimer.current = window.setTimeout(() => setCardLoading(false), 1400);
  };

  const reloadPage = () => {
    if (pageTimer.current !== null) window.clearTimeout(pageTimer.current);
    setPageLoading(true);
    pageTimer.current = window.setTimeout(() => setPageLoading(false), 1700);
  };

  const saveCard = () => {
    if (saving) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    setSaving(true);
    setSaveNote('');
    saveTimer.current = window.setTimeout(() => {
      setSaving(false);
      setSaveNote('Tarjeta guardada en el workspace.');
    }, 1400);
  };

  const syncNow = () => {
    if (syncing) return;
    if (syncTimer.current !== null) window.clearTimeout(syncTimer.current);
    setSyncing(true);
    syncTimer.current = window.setTimeout(() => setSyncing(false), 1800);
  };

  return (
    <CompareScene
      index="3.4"
      title="Skeletons y spinners"
      target="Skeleton · LoadingButton · Spinner"
      note="Skeleton con shimmer que se cruza con el contenido real, spinner de botón, spinner inline y skeleton de página. Kite cambia en seco con una entrada de 180 ms; Animate UI superpone la salida del skeleton con un fade y revela el contenido desde blur.surface."
      view={view}
    >
      {(mode) => (
        <SkeletonColumn
          mode={mode}
          cardLoading={cardLoading}
          pageLoading={pageLoading}
          saving={saving}
          syncing={syncing}
          saveNote={saveNote}
          onReloadCard={reloadCard}
          onReloadPage={reloadPage}
          onSave={saveCard}
          onSync={syncNow}
        />
      )}
    </CompareScene>
  );
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

function StatusScene({ view }: { view: CompareView }) {
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

/* -------------------------------------------------------------------------- */

export function FeedbackPage({ view }: { view: CompareView }) {
  return (
    <div className="p3-page" data-page="03" data-view={view}>
      <ToastsScene view={view} />
      <BannersScene view={view} />
      <ProgressScene view={view} />
      <SkeletonsScene view={view} />
      <StatusScene view={view} />
    </div>
  );
}
