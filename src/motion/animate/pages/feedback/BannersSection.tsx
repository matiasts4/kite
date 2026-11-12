import {
  useEffect,
  useState,
  type FormEvent,
} from 'react';
import {
  AnimatePresence,
  motion,
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
import { CheckIcon, CloseIcon } from '../../ui';

/** transition.shake from the Animate UI tokens; LabTweens does not expose it yet. */
const SHAKE_EASE: [number, number, number, number] = [0.77, 0, 0.175, 1];

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

export function BannersSection({ view }: { view: CompareView }) {
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

export { BannersSection as BannersScene };
