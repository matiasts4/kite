import {
  useEffect,
  useRef,
  useState,
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
import { CloseIcon } from '../../ui';
import { useEscapeClose } from './shared';

/* -------------------------------------------------------------------------- */
/* Scene 1 — Dialog and alert dialog                                           */
/* -------------------------------------------------------------------------- */

type DialogKind = 'default' | 'danger' | 'nested';

interface DialogCopy {
  title: string;
  description: string;
  confirm: string;
  danger?: boolean;
}

const DIALOG_COPY: Record<DialogKind, DialogCopy> = {
  default: {
    title: 'Compartir hilo',
    description: 'Cualquiera con el enlace puede leer el hilo y sus artefactos.',
    confirm: 'Copiar enlace',
  },
  danger: {
    title: '¿Eliminar este hilo?',
    description:
      'Se eliminarán 18 mensajes, el historial de herramientas y los archivos temporales. No se puede deshacer.',
    confirm: 'Eliminar hilo',
    danger: true,
  },
  nested: {
    title: 'Publicar cambios',
    description: 'Se enviarán tres archivos al workspace del equipo.',
    confirm: 'Publicar',
  },
};

function DialogBody({
  mode,
  kind,
  nestedOpen,
  onToggleNested,
  onClose,
  onConfirm,
}: {
  mode: CompareVariant;
  kind: DialogKind;
  nestedOpen: boolean;
  onToggleNested: () => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const motionTokens = useLabMotion();
  const copy = DIALOG_COPY[kind];

  return (
    <>
      <div className="cmp-modal__head">
        <strong id={`p5-dialog-title-${mode}`}>{copy.title}</strong>
        <SceneButton
          mode={mode}
          variant="icon"
          onClick={onClose}
          aria-label="Cerrar diálogo"
        >
          <CloseIcon size={13} />
        </SceneButton>
      </div>
      <p className="cmp-muted">{copy.description}</p>

      {kind === 'default' && (
        <div className="p5-field">
          <span>kite.dev/s/refactor-transcript</span>
          <span className="p5-badge-inline">lectura</span>
        </div>
      )}

      {kind === 'danger' && (
        <div className="p5-callout p5-callout--danger" role="note">
          <span className="p5-callout__dot" aria-hidden="true" />
          Esta acción también cierra la sesión activa.
        </div>
      )}

      {kind === 'nested' && (
        <div className="p5-dialog__nested">
          <div className="p5-dialog__nested-head">
            <span>Cambios incluidos</span>
            <SceneButton
              mode={mode}
              variant="ghost"
              className="cmp-btn--sm"
              onClick={onToggleNested}
              aria-expanded={nestedOpen}
            >
              {nestedOpen ? 'Ocultar diff' : 'Ver diff'}
            </SceneButton>
          </div>
          <div className="p5-dialog__files">
            <div>
              <span>src/motion/contract.ts</span>
              <em>+14 −2</em>
            </div>
            <div>
              <span>src/motion/surface.ts</span>
              <em>+6</em>
            </div>
            <div>
              <span>src/motion/motion.css</span>
              <em>+3 −1</em>
            </div>
          </div>
          {nestedOpen &&
            (mode === 'animate' ? (
              <motion.pre
                className="p5-dialog__diff"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={motionTokens.tweens.fade}
              >
                <code>{`+ export const MOTION_EXIT_MS = 140;`}</code>
              </motion.pre>
            ) : (
              <pre className="p5-dialog__diff motion-row-in">
                <code>{`+ export const MOTION_EXIT_MS = 140;`}</code>
              </pre>
            ))}
        </div>
      )}

      <div className="cmp-modal__actions">
        <SceneButton mode={mode} variant="ghost" onClick={onClose}>
          Cancelar
        </SceneButton>
        <SceneButton
          mode={mode}
          variant="primary"
          className={copy.danger ? 'p5-btn--danger' : undefined}
          onClick={onConfirm}
        >
          {copy.confirm}
        </SceneButton>
      </div>
    </>
  );
}

function DialogSurface({
  mode,
  open,
  kind,
  focusOnOpen,
  nestedOpen,
  onToggleNested,
  onClose,
  onConfirm,
}: {
  mode: CompareVariant;
  open: boolean;
  kind: DialogKind;
  focusOnOpen: boolean;
  nestedOpen: boolean;
  onToggleNested: () => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const labelId = `p5-dialog-title-${mode}`;

  useEffect(() => {
    if (!focusOnOpen) return;
    if (open) {
      if (!returnFocusRef.current && document.activeElement instanceof HTMLElement) {
        returnFocusRef.current = document.activeElement;
      }
      if (mode === 'kite' && !presence.mounted) return;
      panelRef.current?.focus();
      return;
    }
    if (returnFocusRef.current) {
      returnFocusRef.current.focus();
      returnFocusRef.current = null;
    }
  }, [open, focusOnOpen, kind, mode, presence.mounted]);

  const body = (
    <DialogBody
      mode={mode}
      kind={kind}
      nestedOpen={nestedOpen}
      onToggleNested={onToggleNested}
      onClose={onClose}
      onConfirm={onConfirm}
    />
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
          ref={panelRef}
          className={`cmp-modal p5-dialog ${motionSurfaceClass(presence.phase, 'modal')}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelId}
          tabIndex={-1}
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
                ref={panelRef}
                className="cmp-modal p5-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby={labelId}
                tabIndex={-1}
                initial={{
                  scale: reduce ? 1 : motionTokens.scale.dialog,
                  rotateX: reduce ? 0 : -20,
                  y: reduce ? 0 : motionTokens.travel(8),
                  filter: motionTokens.surfaceBlur,
                }}
                animate={{
                  scale: 1,
                  rotateX: 0,
                  y: 0,
                  filter: 'blur(0px)',
                  transitionEnd: { filter: 'none' },
                  transition: motionTokens.springs.dialog,
                }}
                exit={{
                  scale: reduce ? 1 : motionTokens.scale.dialog,
                  rotateX: reduce ? 0 : -20,
                  y: reduce ? 0 : motionTokens.travel(8),
                  filter: motionTokens.surfaceBlur,
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

function DialogStage({
  mode,
  open,
  kind,
  dialogOwner,
  nestedOpen,
  onOpen,
  onToggleNested,
  onClose,
}: {
  mode: CompareVariant;
  open: boolean;
  kind: DialogKind;
  dialogOwner: CompareVariant;
  nestedOpen: boolean;
  onOpen: (kind: DialogKind, mode: CompareVariant) => void;
  onToggleNested: () => void;
  onClose: () => void;
}) {
  return (
    <div className="p5-stage p5-stage--dialog">
      <div className="p5-toolbar">
        <SceneButton mode={mode} onClick={() => onOpen('default', mode)}>
          Compartir hilo
        </SceneButton>
        <SceneButton mode={mode} onClick={() => onOpen('danger', mode)}>
          Confirmar borrado
        </SceneButton>
        <SceneButton mode={mode} onClick={() => onOpen('nested', mode)}>
          Publicar cambios
        </SceneButton>
      </div>
      <p className="p5-hint">
        Escape, el scrim y el botón de cierre hacen lo mismo en las dos columnas. El foco
        entra al diálogo apenas se abre.
      </p>
      <div className="p5-mock" aria-hidden="true">
        <div className="p5-mock__head">
          <span>Hilo activo</span>
          <span>3 archivos</span>
        </div>
        <div className="p5-mock__row">
          <span className="p5-mock__dot p5-mock__dot--green" />
          El agente terminó la revisión del contrato de motion.
        </div>
        <div className="p5-mock__row">
          <span className="p5-mock__dot p5-mock__dot--accent" />
          src/motion/contract.ts espera aprobación.
        </div>
        <div className="p5-mock__row">
          <span className="p5-mock__dot" />
          Compartir el hilo con el equipo de diseño.
        </div>
      </div>

      <DialogSurface
        mode={mode}
        open={open}
        kind={kind}
        focusOnOpen={dialogOwner === mode}
        nestedOpen={nestedOpen}
        onToggleNested={onToggleNested}
        onClose={onClose}
        onConfirm={onClose}
      />
    </div>
  );
}

export function DialogScene({ view }: { view: CompareView }) {
  const [kind, setKind] = useState<DialogKind>('default');
  const [open, setOpen] = useState(false);
  const [owner, setOwner] = useState<CompareVariant>('kite');
  const [nestedOpen, setNestedOpen] = useState(false);

  const openDialog = (next: DialogKind, mode: CompareVariant) => {
    setKind(next);
    setOwner(mode);
    setNestedOpen(false);
    setOpen(true);
  };

  useEscapeClose(open, () => setOpen(false));

  return (
    <CompareScene
      index="01"
      title="Diálogo y alerta"
      target="Dialog · AlertDialog"
      note="El mismo estado abre las dos columnas. Kite funde el modal y sube 10 px; Animate UI lo inclina desde rotateX −20° y lo asienta con spring.dialog, con el scrim fundiendo por detrás."
      view={view}
    >
      {(mode) => (
        <DialogStage
          mode={mode}
          open={open}
          kind={kind}
          dialogOwner={owner}
          nestedOpen={nestedOpen}
          onOpen={openDialog}
          onToggleNested={() => setNestedOpen((value) => !value)}
          onClose={() => setOpen(false)}
        />
      )}
    </CompareScene>
  );
}
