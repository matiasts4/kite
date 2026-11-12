import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { usePresence } from '../../usePresence';
import { motionSurfaceClass } from '../../surface';
import { useLabMotion } from '../context';
import {
  CompareScene,
  SceneButton,
  type CompareVariant,
  type CompareView,
} from '../frame';
import { CloseIcon } from '../ui';

interface ToastItem {
  id: number;
  tone: 'ok' | 'warn';
  text: string;
}

const NOTIFICATIONS = [
  { id: 'n1', title: 'Sesión completada', detail: 'feat/motion · hace 4 min', tone: 'ok' },
  { id: 'n2', title: 'Presupuesto al 72%', detail: 'Quedan 1.284 tickets', tone: 'warn' },
  { id: 'n3', title: 'Nuevo modelo disponible', detail: 'Kite 2 · Opus', tone: 'ok' },
];

function UsageModal({
  mode,
  open,
  onClose,
  onNotify,
}: {
  mode: CompareVariant;
  open: boolean;
  onClose: () => void;
  onNotify: () => void;
}) {
  const motionTokens = useLabMotion();
  const presence = usePresence(open);

  const body = (
    <>
      <div className="cmp-modal__head">
        <strong>Consumo del mes</strong>
        <SceneButton mode={mode} variant="icon" onClick={onClose} aria-label="Cerrar consumo">
          <CloseIcon size={13} />
        </SceneButton>
      </div>
      <p className="cmp-muted">
        El panel se endereza desde scale 0.8 y rotateX −20° mientras el scrim funde por detrás.
      </p>
      <div className="cmp-modal__stats">
        <div>
          <span>Tickets</span>
          <strong>1.284</strong>
        </div>
        <div>
          <span>Tokens</span>
          <strong>72%</strong>
        </div>
        <div>
          <span>Sesiones</span>
          <strong>18</strong>
        </div>
      </div>
      <div className="cmp-modal__actions">
        <SceneButton
          mode={mode}
          variant="primary"
          onClick={() => {
            onNotify();
            onClose();
          }}
        >
          Actualizar plan
        </SceneButton>
        <SceneButton mode={mode} variant="ghost" onClick={onClose}>
          Cerrar
        </SceneButton>
      </div>
    </>
  );

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div className="cmp-modal-layer">
        <div
          className={`cmp-scrim ${motionSurfaceClass(presence.phase, 'scrim')}`}
          onClick={onClose}
          aria-hidden="true"
        />
        <div
          className={`cmp-modal ${motionSurfaceClass(presence.phase, 'modal')}`}
          role="dialog"
          aria-modal="true"
          aria-label="Consumo del mes"
        >
          {body}
        </div>
      </div>
    );
  }

  return (
    <div className="cmp-modal-layer">
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
      <div className="cmp-modal-perspective">
        <AnimatePresence>
          {open && (
            <motion.div
              className="cmp-modal-fade"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: motionTokens.tweens.dialogFade }}
              exit={{ opacity: 0, transition: motionTokens.tweens.dismiss }}
            >
              <motion.div
                className="cmp-modal"
                role="dialog"
                aria-modal="true"
                aria-label="Consumo del mes"
                initial={{
                  scale: motionTokens.scale.dialog,
                  rotateX: -20,
                  y: motionTokens.travel(8),
                }}
                animate={{ scale: 1, rotateX: 0, y: 0, transition: motionTokens.springs.dialog }}
                exit={{
                  scale: motionTokens.scale.dialog,
                  rotateX: -20,
                  y: motionTokens.travel(8),
                  transition: motionTokens.tweens.dismiss,
                }}
              >
                {body}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function AlertsPane({
  mode,
  modalOpen,
  onOpenModal,
  onCloseModal,
  toasts,
  onNotify,
}: {
  mode: CompareVariant;
  modalOpen: boolean;
  onOpenModal: () => void;
  onCloseModal: () => void;
  toasts: ToastItem[];
  onNotify: () => void;
}) {
  const motionTokens = useLabMotion();

  return (
    <div className="cmp-alerts">
      <header className="cmp-card__head">
        <div>
          <strong>Uso y notificaciones</strong>
          <span>resumen del workspace</span>
        </div>
        <span className="cmp-badge">live</span>
      </header>

      <div className="cmp-usage">
        <div className="cmp-usage__stat">
          <span>Tokens</span>
          <strong>72%</strong>
          <div className="cmp-meter cmp-meter--sm">
            <div className="cmp-meter__fill" style={{ width: '72%' }} />
          </div>
        </div>
        <div className="cmp-usage__stat">
          <span>Sesiones</span>
          <strong>18</strong>
        </div>
        <div className="cmp-usage__stat">
          <span>Tickets</span>
          <strong>1.284</strong>
        </div>
      </div>

      <div className="cmp-alerts__actions">
        <SceneButton mode={mode} variant="primary" onClick={onOpenModal}>
          Ver consumo
        </SceneButton>
        <SceneButton mode={mode} onClick={onNotify}>
          Simular notificación
        </SceneButton>
      </div>

      <div className="cmp-notifications">
        <span className="cmp-notifications__title">Recientes</span>
        {NOTIFICATIONS.map((item) => (
          <div key={item.id} className="cmp-notification">
            <span className={`cmp-notification__dot cmp-notification__dot--${item.tone}`} />
            <div>
              <strong>{item.title}</strong>
              <span>{item.detail}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="cmp-toasts" aria-live="polite">
        <AnimatePresence initial={false}>
          {toasts.map((toast) =>
            mode === 'kite' ? (
              <div key={toast.id} className={`cmp-toast cmp-toast--${toast.tone} motion-row-in`}>
                <span className="cmp-toast__dot" aria-hidden="true" />
                {toast.text}
              </div>
            ) : (
              <motion.div
                key={toast.id}
                layout="position"
                className={`cmp-toast cmp-toast--${toast.tone}`}
                initial={{
                  opacity: 0,
                  y: '100%',
                  scale: motionTokens.scale.toast,
                  filter: motionTokens.surfaceBlur,
                }}
                animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
                exit={{
                  opacity: 0,
                  scale: motionTokens.scale.toast,
                  filter: motionTokens.surfaceBlur,
                  transition: motionTokens.tweens.dismiss,
                }}
                transition={motionTokens.springs.toast}
                style={{ originY: 1 }}
              >
                <span className="cmp-toast__dot" aria-hidden="true" />
                {toast.text}
              </motion.div>
            )
          )}
        </AnimatePresence>
      </div>

      <UsageModal
        mode={mode}
        open={modalOpen}
        onClose={onCloseModal}
        onNotify={onNotify}
      />
    </div>
  );
}

export function AlertsScene({ view }: { view: CompareView }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const sequence = useRef(0);
  const timers = useRef<number[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach((id) => window.clearTimeout(id));
    },
    []
  );

  const notify = () => {
    sequence.current += 1;
    const id = sequence.current;
    const tone = id % 2 === 0 ? 'warn' : 'ok';
    setToasts((prev) => [
      ...prev,
      { id, tone, text: tone === 'ok' ? 'Cambios guardados' : 'La sesión venció' },
    ]);
    timers.current.push(
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
      }, 3400)
    );
  };

  return (
    <CompareScene
      index="04"
      title="Consumo y notificaciones"
      target="UsageDashboardModal · NotificationsView"
      note="Abrí el consumo y simulá una notificación. Kite funde el modal y sube el toast unos píxeles; Animate UI lo endereza desde el centro y el toast entra desde el borde con overshoot."
      view={view}
    >
      {(mode) => (
        <AlertsPane
          mode={mode}
          modalOpen={modalOpen}
          onOpenModal={() => setModalOpen(true)}
          onCloseModal={() => setModalOpen(false)}
          toasts={toasts}
          onNotify={notify}
        />
      )}
    </CompareScene>
  );
}
