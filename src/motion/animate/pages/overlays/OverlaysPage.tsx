import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { AnimatePresence, motion, useDragControls } from 'motion/react';
import { motionSurfaceClass } from '../../../surface';
import { usePresence } from '../../../usePresence';
import { useLabMotion, useLabReduce } from '../../context';
import {
  CompareScene,
  SceneButton,
  type CompareVariant,
  type CompareView,
} from '../../frame';
import { BellIcon, CheckIcon, ChevronDownIcon, CloseIcon, MoreIcon } from '../../ui';
import './overlays.css';

/** Close the top surface on Escape. */
function useEscapeClose(active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, onClose]);
}

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

/* -------------------------------------------------------------------------- */
/* Scene 2 — Sheet and drawer                                                  */
/* -------------------------------------------------------------------------- */

type SheetSide = 'right' | 'left' | 'bottom';
type SheetDetent = 'half' | 'full';

const SHEET_TITLES: Record<SheetSide, string> = {
  right: 'Detalles del archivo',
  left: 'Historial del hilo',
  bottom: 'Notas del hilo',
};

function SheetBody({
  side,
  mode,
  onClose,
}: {
  side: SheetSide;
  mode: CompareVariant;
  onClose: () => void;
}) {
  return (
    <>
      <div className="p5-sheet__head">
        <div className="p5-sheet__title">
          <strong>{SHEET_TITLES[side]}</strong>
          <span>{side === 'bottom' ? 'hoja inferior' : `desde la ${side === 'right' ? 'derecha' : 'izquierda'}`}</span>
        </div>
        <SceneButton
          mode={mode}
          variant="icon"
          onClick={onClose}
          aria-label="Cerrar hoja"
        >
          <CloseIcon size={12} />
        </SceneButton>
      </div>

      {side === 'right' && (
        <div className="p5-sheet__rows">
          <div>
            <span>Ruta</span>
            <strong>src/motion/surface.ts</strong>
          </div>
          <div>
            <span>Tamaño</span>
            <strong>2.1 kB</strong>
          </div>
          <div>
            <span>Cambios</span>
            <strong className="p5-up">+6 −1</strong>
          </div>
          <div>
            <span>Estado</span>
            <strong>Sin guardar</strong>
          </div>
          <p className="p5-hint">
            La hoja entra desde su borde con transition.sheet y sale más rápido con
            transition.dismiss.
          </p>
        </div>
      )}

      {side === 'left' && (
        <ol className="p5-timeline">
          <li>
            <span className="p5-timeline__dot p5-timeline__dot--ok" />
            <div>
              <strong>Contrato de motion actualizado</strong>
              <span>hace 2 min</span>
            </div>
          </li>
          <li>
            <span className="p5-timeline__dot" />
            <div>
              <strong>Hoja animada agregada</strong>
              <span>hace 9 min</span>
            </div>
          </li>
          <li>
            <span className="p5-timeline__dot" />
            <div>
              <strong>Revisión del transcript</strong>
              <span>hace 24 min</span>
            </div>
          </li>
          <li>
            <span className="p5-timeline__dot p5-timeline__dot--warn" />
            <div>
              <strong>Presupuesto al 72%</strong>
              <span>hace 1 h</span>
            </div>
          </li>
        </ol>
      )}

      {side === 'bottom' && (
        <div className="p5-sheet__rows">
          <p className="cmp-muted">
            La hoja hace snap entre media altura y completa. Arrastrá hacia abajo para
            cerrarla; hacia arriba para expandirla.
          </p>
          <div className="p5-sheet__note">
            <strong>Nota para el agente</strong>
            <span>Revisar el borde vivo del transcript antes de publicar.</span>
          </div>
          <div className="p5-sheet__note">
            <strong>Siguiente paso</strong>
            <span>Comparar la salida en 140 ms contra el spring de Animate UI.</span>
          </div>
          <SceneButton mode={mode} variant="primary" onClick={onClose}>
            Guardar nota
          </SceneButton>
        </div>
      )}
    </>
  );
}

function BottomSheet({
  mode,
  open,
  detent,
  onDetent,
  onClose,
}: {
  mode: CompareVariant;
  open: boolean;
  detent: SheetDetent;
  onDetent: (next: SheetDetent) => void;
  onClose: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const dragControls = useDragControls();
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const active = useRef(false);
  const startY = useRef(0);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    startY.current = event.clientY;
    active.current = true;
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!active.current) return;
    setOffset(Math.max(-56, event.clientY - startY.current));
  };

  const settle = () => {
    if (!active.current) return;
    active.current = false;
    setDragging(false);
    const travel = offset;
    if (travel > 110) {
      onClose();
      return;
    }
    setOffset(0);
    if (travel < -40) onDetent('full');
    else if (travel > 36 && detent === 'full') onDetent('half');
  };

  const title = (
    <>
      <div className="p5-sheet__head p5-sheet__head--bottom">
        <div className="p5-sheet__title">
          <strong>{SHEET_TITLES.bottom}</strong>
          <span>{detent === 'full' ? 'completa' : 'media altura'}</span>
        </div>
        <span className="cmp-badge">{detent === 'full' ? 'full' : 'half'}</span>
        <SceneButton
          mode={mode}
          variant="ghost"
          className="cmp-btn--sm"
          onClick={() => onDetent(detent === 'full' ? 'half' : 'full')}
        >
          {detent === 'full' ? 'Contraer' : 'Expandir'}
        </SceneButton>
        <SceneButton
          mode={mode}
          variant="icon"
          onClick={onClose}
          aria-label="Cerrar hoja inferior"
        >
          <CloseIcon size={12} />
        </SceneButton>
      </div>
      <SheetBody side="bottom" mode={mode} onClose={onClose} />
    </>
  );

  if (mode === 'animate' && open) {
    return (
      <motion.aside
        className={`p5-sheet p5-sheet--bottom p5-sheet--motion${detent === 'full' ? ' is-full' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={SHEET_TITLES.bottom}
        drag={reduce ? false : 'y'}
        dragControls={dragControls}
        dragListener={false}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={0.18}
        dragSnapToOrigin
        onDragEnd={(_event, info) => {
          if (info.offset.y > 110 || info.velocity.y > 600) onClose();
          else if (info.offset.y < -40) onDetent('full');
          else if (info.offset.y > 36 && detent === 'full') onDetent('half');
        }}
        initial={{
          y: reduce ? 0 : '100%',
          opacity: 0,
          height: detent === 'full' ? 330 : 230,
        }}
        animate={{
          y: 0,
          opacity: 1,
          height: detent === 'full' ? 330 : 230,
          transition: motionTokens.tweens.sheet,
        }}
        exit={{
          y: reduce ? 0 : '100%',
          opacity: 0,
          transition: motionTokens.tweens.dismiss,
        }}
      >
        <div
          className="p5-sheet__handle"
          onPointerDown={(event) => dragControls.start(event)}
          style={{ touchAction: 'none' }}
          aria-hidden="true"
        >
          <span className="p5-sheet__grip" />
        </div>
        {title}
      </motion.aside>
    );
  }

  return (
    <aside
      className={`p5-sheet p5-sheet--bottom p5-sheet--kite${detent === 'full' ? ' is-full' : ''}${
        dragging ? ' is-dragging' : ''
      }${reduce ? ' is-static' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={SHEET_TITLES.bottom}
      style={{ transform: `translateY(${offset}px)` }}
    >
      <div
        className="p5-sheet__handle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={settle}
        onPointerCancel={settle}
        aria-hidden="true"
      >
        <span className="p5-sheet__grip" />
      </div>
      {title}
    </aside>
  );
}

function SheetSurface({
  mode,
  open,
  side,
  detent,
  onDetent,
  onClose,
}: {
  mode: CompareVariant;
  open: boolean;
  side: SheetSide;
  detent: SheetDetent;
  onDetent: (next: SheetDetent) => void;
  onClose: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    const panelClass =
      side === 'bottom'
        ? presence.phase === 'out'
          ? 'p5-sheet-css-out'
          : 'p5-sheet-css-in'
        : motionSurfaceClass(presence.phase, side === 'left' ? 'panel-left' : 'panel');
    return (
      <div className="p5-sheet-layer">
        <div
          className={`cmp-scrim ${motionSurfaceClass(presence.phase, 'scrim')}`}
          onClick={onClose}
          aria-hidden="true"
        />
        {side === 'bottom' ? (
          <div className={`p5-sheet-anim p5-sheet-anim--bottom ${panelClass}`}>
            <BottomSheet
              mode={mode}
              open={open}
              detent={detent}
              onDetent={onDetent}
              onClose={onClose}
            />
          </div>
        ) : (
          <aside
            className={`p5-sheet p5-sheet--${side} ${panelClass}`}
            role="dialog"
            aria-modal="true"
            aria-label={SHEET_TITLES[side]}
          >
            <SheetBody side={side} mode={mode} onClose={onClose} />
          </aside>
        )}
      </div>
    );
  }

  return (
    <div className="p5-sheet-layer">
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
        {open &&
          (side === 'bottom' ? (
            <BottomSheet
              key="bottom"
              mode={mode}
              open={open}
              detent={detent}
              onDetent={onDetent}
              onClose={onClose}
            />
          ) : (
            <motion.aside
              key={side}
              className={`p5-sheet p5-sheet--${side}`}
              role="dialog"
              aria-modal="true"
              aria-label={SHEET_TITLES[side]}
              initial={{
                x: reduce ? 0 : side === 'right' ? '100%' : '-100%',
                opacity: 0,
              }}
              animate={{ x: 0, opacity: 1, transition: motionTokens.tweens.sheet }}
              exit={{
                x: reduce ? 0 : side === 'right' ? '100%' : '-100%',
                opacity: 0,
                transition: motionTokens.tweens.dismiss,
              }}
            >
              <SheetBody side={side} mode={mode} onClose={onClose} />
            </motion.aside>
          ))}
      </AnimatePresence>
    </div>
  );
}

function SheetStage({
  mode,
  open,
  side,
  detent,
  onOpen,
  onDetent,
  onClose,
}: {
  mode: CompareVariant;
  open: boolean;
  side: SheetSide;
  detent: SheetDetent;
  onOpen: (side: SheetSide) => void;
  onDetent: (next: SheetDetent) => void;
  onClose: () => void;
}) {
  return (
    <div className="p5-stage p5-stage--sheet">
      <div className="p5-toolbar">
        <SceneButton mode={mode} onClick={() => onOpen('right')}>
          Hoja derecha
        </SceneButton>
        <SceneButton mode={mode} onClick={() => onOpen('left')}>
          Hoja izquierda
        </SceneButton>
        <SceneButton mode={mode} onClick={() => onOpen('bottom')}>
          Hoja inferior
        </SceneButton>
      </div>
      <p className="p5-hint">
        La hoja inferior se arrastra: el scrim la sigue, hace snap entre media altura y
        completa, y la salida es más rápida que la entrada.
      </p>
      <div className="p5-mock" aria-hidden="true">
        <div className="p5-mock__head">
          <span>src/motion/surface.ts</span>
          <span>sin guardar</span>
        </div>
        <div className="p5-mock__row">
          <span className="p5-mock__dot p5-mock__dot--accent" />
          export type MotionSurfaceKind = 'panel' | 'scrim';
        </div>
        <div className="p5-mock__row">
          <span className="p5-mock__dot" />
          motionSurfaceClass(phase, kind)
        </div>
        <div className="p5-mock__row">
          <span className="p5-mock__dot p5-mock__dot--green" />
          La hoja se monta durante su salida y después se desmonta.
        </div>
      </div>
      {open && <p className="p5-status">Hoja abierta: {SHEET_TITLES[side]}.</p>}

      <SheetSurface
        mode={mode}
        open={open}
        side={side}
        detent={detent}
        onDetent={onDetent}
        onClose={onClose}
      />
    </div>
  );
}

export function SheetScene({ view }: { view: CompareView }) {
  const [side, setSide] = useState<SheetSide>('right');
  const [open, setOpen] = useState(false);
  const [detent, setDetent] = useState<SheetDetent>('half');

  const openSheet = (next: SheetSide) => {
    setSide(next);
    if (next === 'bottom') setDetent('half');
    setOpen(true);
  };

  useEscapeClose(open, () => setOpen(false));

  return (
    <CompareScene
      index="02"
      title="Sheet y drawer"
      target="Sheet · Drawer"
      note="Derecha, izquierda y abajo, con un mismo estado. En Animate UI la entrada usa transition.sheet (400 ms) y la salida transition.dismiss (200 ms); Kite ya entra en 180 ms y sale en 140 ms."
      view={view}
    >
      {(mode) => (
        <SheetStage
          mode={mode}
          open={open}
          side={side}
          detent={detent}
          onOpen={openSheet}
          onDetent={setDetent}
          onClose={() => setOpen(false)}
        />
      )}
    </CompareScene>
  );
}

/* -------------------------------------------------------------------------- */
/* Scene 3 — Popover, menu, tooltip and hover card                             */
/* -------------------------------------------------------------------------- */

interface SubmenuEntry {
  id: string;
  label: string;
}

const SUBMENU_ITEMS: SubmenuEntry[] = [
  { id: 'copy-link', label: 'Copiar enlace' },
  { id: 'send-email', label: 'Enviar por correo' },
  { id: 'export-md', label: 'Exportar Markdown' },
];

const TOOLTIPS: { id: string; label: string; text: string }[] = [
  { id: 'save', label: 'Guardar', text: 'Guardar (⌘S)' },
  { id: 'discard', label: 'Descartar', text: 'Descartar (esc)' },
];

function QuotaCard({ mode, onClose }: { mode: CompareVariant; onClose: () => void }) {
  return (
    <>
      <div className="cmp-popover__head">
        <strong>Cuota del workspace</strong>
        <SceneButton
          mode={mode}
          variant="icon"
          onClick={onClose}
          aria-label="Cerrar cuota"
        >
          <CloseIcon size={12} />
        </SceneButton>
      </div>
      <p>72% restante este mes.</p>
      <div className="cmp-meter cmp-meter--sm">
        <div className="cmp-meter__fill" style={{ width: '72%' }} />
      </div>
      <div className="p5-popover__foot">
        <span>Quedan 1.284 tickets</span>
        <span>Renueva el 1.º</span>
      </div>
    </>
  );
}

function QuotaSurface({
  mode,
  open,
  onClose,
  align = 'end',
}: {
  mode: CompareVariant;
  open: boolean;
  onClose: () => void;
  align?: 'start' | 'end';
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div className={`p5-anchor-pop p5-anchor-pop--${align}`}>
        <div className={`cmp-popover ${motionSurfaceClass(presence.phase, 'popover')}`}>
          <QuotaCard mode={mode} onClose={onClose} />
        </div>
      </div>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={`p5-anchor-pop p5-anchor-pop--${align}`}
          initial={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.popover,
            y: reduce ? 0 : -motionTokens.travel(4),
            filter: motionTokens.surfaceBlur,
          }}
          animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
          exit={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.popover,
            y: reduce ? 0 : -motionTokens.travel(4),
            filter: motionTokens.surfaceBlur,
            transition: motionTokens.tweens.dismiss,
          }}
          transition={motionTokens.springs.pop}
          style={{ transformOrigin: align === 'end' ? 'top right' : 'top left' }}
        >
          <div className="cmp-popover">
            <QuotaCard mode={mode} onClose={onClose} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function SubmenuSurface({
  mode,
  open,
  onSelect,
}: {
  mode: CompareVariant;
  open: boolean;
  onSelect: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);
  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setHovered(null);
  }, [open]);

  const items = SUBMENU_ITEMS.map((item) =>
    mode === 'animate' ? (
      <button
        key={item.id}
        type="button"
        role="menuitem"
        className="cmp-menu__item"
        onPointerEnter={() => setHovered(item.id)}
        onFocus={() => setHovered(item.id)}
        onBlur={() => setHovered(null)}
        onClick={onSelect}
      >
        {hovered === item.id && (
          <motion.span
            layoutId="p5-submenu-highlight"
            className="cmp-menu__highlight"
            initial={false}
            transition={motionTokens.springs.highlight}
          />
        )}
        <span className="cmp-menu__label">{item.label}</span>
      </button>
    ) : (
      <button
        key={item.id}
        type="button"
        role="menuitem"
        className="cmp-menu__item"
        onClick={onSelect}
      >
        {item.label}
      </button>
    )
  );

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div
        className={`cmp-menu p5-submenu ${motionSurfaceClass(presence.phase, 'popover')}`}
        role="menu"
      >
        {items}
      </div>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="cmp-menu p5-submenu p5-menu--motion"
          role="menu"
          initial={{ opacity: 0, scale: reduce ? 1 : motionTokens.scale.menu }}
          animate={{ opacity: 1, scale: 1, transition: motionTokens.tweens.menu }}
          exit={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.menu,
            transition: motionTokens.tweens.dismiss,
          }}
          style={{ transformOrigin: 'top left' }}
        >
          {items}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function MenuSurface({
  mode,
  open,
  submenuOpen,
  onSubmenu,
  onClose,
}: {
  mode: CompareVariant;
  open: boolean;
  submenuOpen: boolean;
  onSubmenu: (value: boolean) => void;
  onClose: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);
  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setHovered(null);
  }, [open]);

  const item = (
    id: string,
    label: string,
    options: { danger?: boolean; submenu?: boolean; icon?: boolean } = {}
  ) =>
    mode === 'animate' ? (
      <button
        key={id}
        type="button"
        role="menuitem"
        aria-haspopup={options.submenu ? 'menu' : undefined}
        aria-expanded={options.submenu ? submenuOpen : undefined}
        className={`cmp-menu__item${options.danger ? ' cmp-menu__item--danger' : ''}`}
        onPointerEnter={() => {
          setHovered(id);
          if (options.submenu) onSubmenu(true);
        }}
        onFocus={() => {
          setHovered(id);
          if (options.submenu) onSubmenu(true);
        }}
        onBlur={() => setHovered(null)}
        onClick={() => {
          if (options.submenu) onSubmenu(!submenuOpen);
          else onClose();
        }}
      >
        {hovered === id && (
          <motion.span
            layoutId="p5-menu-highlight"
            className="cmp-menu__highlight"
            initial={false}
            transition={motionTokens.springs.highlight}
          />
        )}
        <span className="cmp-menu__label">{label}</span>
        {options.submenu && (
          <ChevronDownIcon size={11} className="p5-chevron-right" />
        )}
      </button>
    ) : (
      <button
        key={id}
        type="button"
        role="menuitem"
        aria-haspopup={options.submenu ? 'menu' : undefined}
        aria-expanded={options.submenu ? submenuOpen : undefined}
        className={`cmp-menu__item${options.danger ? ' cmp-menu__item--danger' : ''}`}
        onPointerEnter={() => {
          if (options.submenu) onSubmenu(true);
        }}
        onClick={() => {
          if (options.submenu) onSubmenu(!submenuOpen);
          else onClose();
        }}
      >
        <span className="cmp-menu__label">{label}</span>
        {options.submenu && (
          <ChevronDownIcon size={11} className="p5-chevron-right" />
        )}
      </button>
    );

  const menu = (
    <>
      {item('open', 'Abrir en el editor')}
      <div className="p5-submenu-anchor">
        {item('share', 'Compartir', { submenu: true })}
        <SubmenuSurface mode={mode} open={submenuOpen} onSelect={onClose} />
      </div>
      {item('archive', 'Archivar', { danger: true })}
    </>
  );

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div
        className={`cmp-menu p5-menu ${motionSurfaceClass(presence.phase, 'popover')}`}
        role="menu"
        onPointerLeave={() => {
          setHovered(null);
          onSubmenu(false);
        }}
      >
        {menu}
      </div>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="cmp-menu p5-menu p5-menu--motion"
          role="menu"
          initial={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.menu,
            y: reduce ? 0 : -4,
          }}
          animate={{
            opacity: 1,
            scale: 1,
            y: 0,
            transition: motionTokens.tweens.menu,
          }}
          exit={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.menu,
            y: reduce ? 0 : -4,
            transition: motionTokens.tweens.dismiss,
          }}
          style={{ transformOrigin: 'top left' }}
          onPointerLeave={() => {
            setHovered(null);
            onSubmenu(false);
          }}
        >
          {menu}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function TooltipBubble({
  mode,
  open,
  warm,
  text,
  id,
}: {
  mode: CompareVariant;
  open: boolean;
  warm: boolean;
  text: string;
  id: string;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    if (warm && !open) return null;
    return (
      <div className="p5-anchor-pop p5-anchor-pop--center p5-anchor-pop--above">
        <div
          className={`p5-tooltip ${
            warm ? '' : motionSurfaceClass(presence.phase, 'popover')
          }`}
          role="tooltip"
          id={id}
        >
          {text}
        </div>
      </div>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <div className="p5-anchor-pop p5-anchor-pop--center p5-anchor-pop--above">
          <motion.div
            initial={
              warm
                ? false
                : {
                    opacity: 0,
                    scale: reduce ? 1 : motionTokens.scale.tooltip,
                    y: reduce ? 0 : 4,
                  }
            }
            animate={{
              opacity: 1,
              scale: 1,
              y: 0,
              transition: warm ? { duration: 0 } : motionTokens.springs.pop,
            }}
            exit={
              warm
                ? { opacity: 0, transition: { duration: 0 } }
                : {
                    opacity: 0,
                    scale: reduce ? 1 : motionTokens.scale.tooltip,
                    y: reduce ? 0 : 4,
                    transition: motionTokens.tweens.dismiss,
                  }
            }
            style={{ transformOrigin: 'bottom center' }}
          >
            <div className="p5-tooltip" role="tooltip" id={id}>
              {text}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

function HoverCardBody({ mode }: { mode: CompareVariant }) {
  return (
    <>
      <div className="p5-hovercard__head">
        <span className="p5-avatar" aria-hidden="true">
          MC
        </span>
        <div className="p5-hovercard__id">
          <strong>Mira Chen</strong>
          <span>@mira · Sistemas de diseño</span>
        </div>
      </div>
      <p className="p5-hovercard__bio">
        Mantiene el sistema de motion de Kite y revisa los contratos de animación.
      </p>
      <div className="p5-hovercard__stats">
        <div>
          <strong>18</strong>
          <span>hilos</span>
        </div>
        <div>
          <strong>4</strong>
          <span>revisiones</span>
        </div>
        <div>
          <strong>hace 2 h</strong>
          <span>activa</span>
        </div>
      </div>
      <div className="p5-hovercard__actions">
        <SceneButton mode={mode} variant="primary" className="cmp-btn--sm">
          Seguir
        </SceneButton>
        <SceneButton mode={mode} variant="ghost" className="cmp-btn--sm">
          Mensaje
        </SceneButton>
      </div>
    </>
  );
}

function HoverCardSurface({
  mode,
  open,
}: {
  mode: CompareVariant;
  open: boolean;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div className="p5-anchor-pop p5-anchor-pop--above">
        <div className={`p5-hovercard ${motionSurfaceClass(presence.phase, 'popover')}`}>
          <HoverCardBody mode={mode} />
        </div>
      </div>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="p5-anchor-pop p5-anchor-pop--above"
          initial={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.popover,
            y: reduce ? 0 : 6,
            filter: motionTokens.surfaceBlur,
          }}
          animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
          exit={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.popover,
            y: reduce ? 0 : 6,
            filter: motionTokens.surfaceBlur,
            transition: motionTokens.tweens.dismiss,
          }}
          transition={motionTokens.springs.pop}
          style={{ transformOrigin: 'bottom left' }}
        >
          <div className="p5-hovercard">
            <HoverCardBody mode={mode} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function AnchorStage({
  mode,
  popoverOpen,
  menuOpen,
  submenuOpen,
  tooltipId,
  tooltipWarm,
  hoverCardOpen,
  onTogglePopover,
  onToggleMenu,
  onSubmenu,
  onCloseMenu,
  onShowTooltip,
  onHideTooltip,
  onShowHoverCard,
  onHideHoverCard,
}: {
  mode: CompareVariant;
  popoverOpen: boolean;
  menuOpen: boolean;
  submenuOpen: boolean;
  tooltipId: string | null;
  tooltipWarm: boolean;
  hoverCardOpen: boolean;
  onTogglePopover: () => void;
  onToggleMenu: () => void;
  onSubmenu: (value: boolean) => void;
  onCloseMenu: () => void;
  onShowTooltip: (id: string) => void;
  onHideTooltip: () => void;
  onShowHoverCard: () => void;
  onHideHoverCard: () => void;
}) {
  return (
    <div className="p5-stage p5-stage--anchors">
      <p className="p5-hint">
        Cada superficie crece desde su trigger. Una vez abierto un tooltip, el siguiente
        aparece sin espera: el timing cálido dura 300 ms.
      </p>

      <div className="p5-anchor-grid">
        <div className="p5-demo">
          <span className="p5-demo__label">Menú</span>
          <div className="p5-demo__row p5-anchor">
            <SceneButton
              mode={mode}
              variant="icon"
              aria-label="Más acciones del hilo"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={onToggleMenu}
            >
              <MoreIcon size={13} />
            </SceneButton>
            <span className="p5-demo__caption">Abrir, compartir, archivar</span>
            <MenuSurface
              mode={mode}
              open={menuOpen}
              submenuOpen={submenuOpen}
              onSubmenu={onSubmenu}
              onClose={onCloseMenu}
            />
          </div>
        </div>

        <div className="p5-demo">
          <span className="p5-demo__label">Popover</span>
          <div className="p5-demo__row p5-anchor">
            <SceneButton
              mode={mode}
              variant="ghost"
              className="cmp-chip"
              aria-expanded={popoverOpen}
              onClick={onTogglePopover}
            >
              Kite 2 · 72%
              <ChevronDownIcon size={11} />
            </SceneButton>
            <QuotaSurface
              mode={mode}
              open={popoverOpen}
              onClose={onTogglePopover}
              align="start"
            />
          </div>
        </div>

        <div className="p5-demo">
          <span className="p5-demo__label">Tooltip</span>
          <div className="p5-demo__row">
            {TOOLTIPS.map((tooltip) => (
              <div
                key={tooltip.id}
                className="p5-anchor"
                onPointerEnter={() => onShowTooltip(tooltip.id)}
                onPointerLeave={onHideTooltip}
              >
                <SceneButton
                  mode={mode}
                  variant="ghost"
                  className="cmp-btn--sm"
                  aria-describedby={`p5-tooltip-${mode}-${tooltip.id}`}
                  onFocus={() => onShowTooltip(tooltip.id)}
                  onBlur={onHideTooltip}
                >
                  {tooltip.label}
                </SceneButton>
                <TooltipBubble
                  mode={mode}
                  open={tooltipId === tooltip.id}
                  warm={tooltipWarm}
                  text={tooltip.text}
                  id={`p5-tooltip-${mode}-${tooltip.id}`}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="p5-demo">
          <span className="p5-demo__label">Hover card</span>
          <div
            className="p5-demo__row p5-anchor"
            onPointerEnter={onShowHoverCard}
            onPointerLeave={onHideHoverCard}
          >
            <button
              type="button"
              className="p5-author"
              onFocus={onShowHoverCard}
              onBlur={onHideHoverCard}
            >
              <span className="p5-avatar p5-avatar--sm" aria-hidden="true">
                MC
              </span>
              Mira Chen
            </button>
            <HoverCardSurface mode={mode} open={hoverCardOpen} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function AnchorScene({ view }: { view: CompareView }) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [tooltipId, setTooltipId] = useState<string | null>(null);
  const [tooltipWarm, setTooltipWarm] = useState(false);
  const [hoverCardOpen, setHoverCardOpen] = useState(false);

  const tooltipTimer = useRef<number | null>(null);
  const warmResetTimer = useRef<number | null>(null);
  const warmRef = useRef(false);
  const hoverTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (tooltipTimer.current) window.clearTimeout(tooltipTimer.current);
      if (warmResetTimer.current) window.clearTimeout(warmResetTimer.current);
      if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    },
    []
  );

  const showTooltip = (id: string) => {
    if (warmResetTimer.current) {
      window.clearTimeout(warmResetTimer.current);
      warmResetTimer.current = null;
    }
    if (tooltipTimer.current) window.clearTimeout(tooltipTimer.current);
    if (warmRef.current) {
      setTooltipWarm(true);
      setTooltipId(id);
      return;
    }
    tooltipTimer.current = window.setTimeout(() => {
      tooltipTimer.current = null;
      warmRef.current = true;
      setTooltipWarm(false);
      setTooltipId(id);
    }, 180);
  };

  const hideTooltip = () => {
    if (tooltipTimer.current) {
      window.clearTimeout(tooltipTimer.current);
      tooltipTimer.current = null;
    }
    setTooltipId(null);
    if (warmResetTimer.current) window.clearTimeout(warmResetTimer.current);
    warmResetTimer.current = window.setTimeout(() => {
      warmRef.current = false;
      setTooltipWarm(false);
    }, 300);
  };

  const showHoverCard = () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHoverCardOpen(true), 180);
  };

  const hideHoverCard = () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    setHoverCardOpen(false);
  };

  const closeMenu = () => {
    setMenuOpen(false);
    setSubmenuOpen(false);
  };

  useEscapeClose(popoverOpen || menuOpen, () => {
    setPopoverOpen(false);
    closeMenu();
  });

  return (
    <CompareScene
      index="03"
      title="Popover, menú y tooltip"
      target="Popover · Menu · Tooltip · HoverCard"
      note="Origen en el trigger, highlight que se desliza con spring.highlight y un submenú con ítem destructivo. Los tooltips se calientan: el primero espera 180 ms, los siguientes abren al instante."
      view={view}
    >
      {(mode) => (
        <AnchorStage
          mode={mode}
          popoverOpen={popoverOpen}
          menuOpen={menuOpen}
          submenuOpen={submenuOpen}
          tooltipId={tooltipId}
          tooltipWarm={tooltipWarm}
          hoverCardOpen={hoverCardOpen}
          onTogglePopover={() => setPopoverOpen((value) => !value)}
          onToggleMenu={() => {
            setMenuOpen((value) => !value);
            setSubmenuOpen(false);
          }}
          onSubmenu={setSubmenuOpen}
          onCloseMenu={closeMenu}
          onShowTooltip={showTooltip}
          onHideTooltip={hideTooltip}
          onShowHoverCard={showHoverCard}
          onHideHoverCard={hideHoverCard}
        />
      )}
    </CompareScene>
  );
}

/* -------------------------------------------------------------------------- */
/* Scene 4 — Command palette                                                   */
/* -------------------------------------------------------------------------- */

interface LabCommand {
  id: string;
  label: string;
  shortcut: string;
  keywords: string;
}

const COMMANDS: LabCommand[] = [
  {
    id: 'settings',
    label: 'Abrir ajustes',
    shortcut: '⌘,',
    keywords: 'preferencias configuracion',
  },
  {
    id: 'search',
    label: 'Buscar en el workspace',
    shortcut: '⌘⇧F',
    keywords: 'find archivos buscar',
  },
  {
    id: 'new-thread',
    label: 'Nuevo hilo',
    shortcut: '⌘N',
    keywords: 'crear agente chat',
  },
  {
    id: 'model',
    label: 'Cambiar modelo',
    shortcut: '⌘M',
    keywords: 'kite opus modelo',
  },
  {
    id: 'notifications',
    label: 'Abrir notificaciones',
    shortcut: '⌘⇧N',
    keywords: 'alertas inbox',
  },
  {
    id: 'shortcuts',
    label: 'Ver atajos de teclado',
    shortcut: '?',
    keywords: 'keyboard ayuda',
  },
];

function PaletteSurface({
  mode,
  open,
  query,
  selected,
  items,
  onQuery,
  onMove,
  onSelect,
  onRun,
  onRunAt,
  onClose,
}: {
  mode: CompareVariant;
  open: boolean;
  query: string;
  selected: number;
  items: LabCommand[];
  onQuery: (value: string) => void;
  onMove: (delta: number) => void;
  onSelect: (index: number) => void;
  onRun: () => void;
  onRunAt: (index: number) => void;
  onClose: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    if (mode === 'kite' && !presence.mounted) return;
    inputRef.current?.focus();
  }, [open, mode, presence.mounted]);

  const results =
    items.length === 0 ? (
      <div className="p5-palette__empty">Sin resultados para “{query}”.</div>
    ) : (
      items.map((command, index) => {
        const isSelected = index === selected;
        return (
          <button
            key={command.id}
            id={`p5-command-${mode}-${command.id}`}
            type="button"
            role="option"
            aria-selected={isSelected}
            className={`p5-palette__item${
              mode === 'kite' && isSelected ? ' is-selected' : ''
            }`}
            onPointerEnter={() => onSelect(index)}
            onFocus={() => onSelect(index)}
            onClick={() => onRunAt(index)}
          >
            {mode === 'animate' && isSelected && (
              <motion.span
                layoutId="p5-palette-highlight"
                className="p5-palette__highlight"
                initial={false}
                transition={motionTokens.springs.highlight}
              />
            )}
            <span className="p5-palette__label">{command.label}</span>
            <kbd className="p5-kbd">{command.shortcut}</kbd>
          </button>
        );
      })
    );

  const panel = (
    <>
      <div className="p5-palette__search">
        <span className="p5-palette__prompt" aria-hidden="true">
          ›
        </span>
        <input
          ref={inputRef}
          className="p5-palette__input"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              onMove(1);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              onMove(-1);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              onRun();
            }
          }}
          placeholder="Buscar acciones…"
          aria-label="Buscar acciones"
          aria-controls={`p5-palette-list-${mode}`}
          aria-activedescendant={
            items.length > 0 ? `p5-command-${mode}-${items[selected]?.id ?? ''}` : undefined
          }
          role="combobox"
          aria-expanded={open}
        />
        <kbd className="p5-kbd">esc</kbd>
      </div>
      <div
        className="p5-palette__list"
        id={`p5-palette-list-${mode}`}
        role="listbox"
        aria-label="Acciones disponibles"
      >
        {results}
      </div>
      <div className="p5-palette__foot">
        <span>↑↓ moverse · ↵ ejecutar · esc cerrar</span>
        <span>{items.length} resultados</span>
      </div>
    </>
  );

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div
        className={`p5-palette-scrim ${motionSurfaceClass(presence.phase, 'scrim')}`}
        onClick={onClose}
      >
        <div
          className={`p5-palette ${motionSurfaceClass(presence.phase, 'popover')}`}
          role="dialog"
          aria-modal="true"
          aria-label="Paleta de comandos"
          onClick={(event) => event.stopPropagation()}
        >
          {panel}
        </div>
      </div>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="p5-palette-scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: motionTokens.tweens.menu }}
          exit={{ opacity: 0, transition: motionTokens.tweens.menu }}
          onClick={onClose}
        >
          <motion.div
            className="p5-palette"
            role="dialog"
            aria-modal="true"
            aria-label="Paleta de comandos"
            initial={{ opacity: 0, scale: reduce ? 1 : motionTokens.scale.menu }}
            animate={{ opacity: 1, scale: 1, transition: motionTokens.tweens.menu }}
            exit={{
              opacity: 0,
              scale: reduce ? 1 : motionTokens.scale.menu,
              transition: motionTokens.tweens.menu,
            }}
            style={{ transformOrigin: 'center top' }}
            onClick={(event) => event.stopPropagation()}
          >
            {panel}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function PaletteStage({
  mode,
  open,
  query,
  selected,
  items,
  lastRun,
  onOpen,
  onQuery,
  onMove,
  onSelect,
  onRun,
  onRunAt,
  onClose,
}: {
  mode: CompareVariant;
  open: boolean;
  query: string;
  selected: number;
  items: LabCommand[];
  lastRun: string | null;
  onOpen: () => void;
  onQuery: (value: string) => void;
  onMove: (delta: number) => void;
  onSelect: (index: number) => void;
  onRun: () => void;
  onRunAt: (index: number) => void;
  onClose: () => void;
}) {
  return (
    <div className="p5-stage p5-stage--palette">
      <div className="p5-toolbar">
        <SceneButton mode={mode} variant="primary" onClick={onOpen}>
          Buscar acciones
          <kbd className="p5-kbd">⌘K</kbd>
        </SceneButton>
        <span className="p5-hint p5-hint--inline">o usá ⌘K / Ctrl K desde cualquier lado</span>
      </div>
      <p className="p5-hint">
        El filtro no re-anima resultados. El highlight se desliza con spring.highlight y
        la selección con Enter ejecuta la acción.
      </p>
      <div className="p5-mock" aria-hidden="true">
        <div className="p5-mock__head">
          <span>Workspace</span>
          <span>6 acciones</span>
        </div>
        <div className="p5-mock__row">
          <span className="p5-mock__dot p5-mock__dot--accent" />
          src/motion/contract.ts
        </div>
        <div className="p5-mock__row">
          <span className="p5-mock__dot" />
          src/motion/usePresence.ts
        </div>
        <div className="p5-mock__row">
          <span className="p5-mock__dot p5-mock__dot--green" />
          src/motion/surface.ts
        </div>
      </div>
      <p className="p5-status" role="status">
        {lastRun ? `Ejecutado: ${lastRun}` : 'Todavía no ejecutaste ninguna acción.'}
      </p>

      <PaletteSurface
        mode={mode}
        open={open}
        query={query}
        selected={selected}
        items={items}
        onQuery={onQuery}
        onMove={onMove}
        onSelect={onSelect}
        onRun={onRun}
        onRunAt={onRunAt}
        onClose={onClose}
      />
    </div>
  );
}

export function PaletteScene({ view }: { view: CompareView }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [lastRun, setLastRun] = useState<string | null>(null);

  const normalized = query.trim().toLowerCase();
  const filtered = COMMANDS.filter(
    (command) =>
      command.label.toLowerCase().includes(normalized) ||
      command.keywords.includes(normalized)
  );
  const selectedIndex =
    filtered.length === 0 ? 0 : Math.min(selected, filtered.length - 1);

  const openPalette = () => {
    setQuery('');
    setSelected(0);
    setOpen(true);
  };

  const closePalette = () => setOpen(false);

  const runSelected = () => {
    const command = filtered[selectedIndex];
    if (!command) return;
    setLastRun(command.label);
    setOpen(false);
  };

  const runAt = (index: number) => {
    const command = filtered[index];
    if (!command) return;
    setLastRun(command.label);
    setOpen(false);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
        setQuery('');
        setSelected(0);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEscapeClose(open, closePalette);

  return (
    <CompareScene
      index="04"
      title="Command palette"
      target="CommandPalette"
      note="Abrí con ⌘K o con el botón. El panel entra desde scale.menu en transition.menu, el filtro no re-anima resultados y el highlight se desliza con spring.highlight mientras el teclado mueve la selección."
      view={view}
    >
      {(mode) => (
        <PaletteStage
          mode={mode}
          open={open}
          query={query}
          selected={selectedIndex}
          items={filtered}
          lastRun={lastRun}
          onOpen={openPalette}
          onQuery={(value) => {
            setQuery(value);
            setSelected(0);
          }}
          onMove={(delta) => {
            if (filtered.length === 0) return;
            setSelected(
              (current) => (current + delta + filtered.length) % filtered.length
            );
          }}
          onSelect={(index) => setSelected(index)}
          onRun={runSelected}
          onRunAt={runAt}
          onClose={closePalette}
        />
      )}
    </CompareScene>
  );
}

/* -------------------------------------------------------------------------- */
/* Scene 5 — Notification center, quota and file picker                        */
/* -------------------------------------------------------------------------- */

type InboxSurface = 'none' | 'notifications' | 'quota' | 'picker';

interface NotificationItem {
  id: string;
  title: string;
  detail: string;
  time: string;
  tone: 'ok' | 'warn';
  read: boolean;
}

const SEED_NOTIFICATIONS: NotificationItem[] = [
  {
    id: 'n1',
    title: 'Sesión completada',
    detail: 'feat/motion · revisión del contrato',
    time: '4 min',
    tone: 'ok',
    read: false,
  },
  {
    id: 'n2',
    title: 'Presupuesto al 72%',
    detail: 'Quedan 1.284 tickets este mes',
    time: '22 min',
    tone: 'warn',
    read: false,
  },
  {
    id: 'n3',
    title: 'Nuevo modelo disponible',
    detail: 'Kite 2 · Opus ya está en el selector',
    time: '1 h',
    tone: 'ok',
    read: true,
  },
];

const FILES = [
  { path: 'src/motion/contract.ts', size: '1.8 kB' },
  { path: 'src/motion/surface.ts', size: '2.1 kB' },
  { path: 'src/motion/usePresence.ts', size: '0.9 kB' },
  { path: 'src/motion/animate/frame.tsx', size: '4.6 kB' },
  { path: 'src/motion/animate/tokens.ts', size: '5.2 kB' },
];

function NotificationRow({
  mode,
  item,
  onToggle,
}: {
  mode: CompareVariant;
  item: NotificationItem;
  onToggle: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const className = `p5-notif${item.read ? ' is-read' : ''}`;
  const content = (
    <>
      <span className="p5-notif__mark" aria-hidden="true">
        {mode === 'animate' ? (
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={item.read ? 'read' : 'unread'}
              className="p5-notif__mark-inner"
              initial={{ opacity: 0, scale: reduce ? 1 : motionTokens.scale.icon }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: reduce ? 1 : motionTokens.scale.icon }}
              transition={motionTokens.tweens.swap}
            >
              {item.read ? (
                <CheckIcon size={11} className="p5-notif__check" />
              ) : (
                <span className={`p5-notif__dot p5-notif__dot--${item.tone}`} />
              )}
            </motion.span>
          </AnimatePresence>
        ) : item.read ? (
          <CheckIcon size={11} className="p5-notif__check" />
        ) : (
          <span className={`p5-notif__dot p5-notif__dot--${item.tone}`} />
        )}
      </span>
      <span className="p5-notif__body">
        <strong>{item.title}</strong>
        <span>{item.detail}</span>
      </span>
      <span className="p5-notif__time">{item.time}</span>
    </>
  );

  if (mode === 'animate') {
    return (
      <motion.button
        type="button"
        layout="position"
        className={className}
        onClick={onToggle}
        aria-label={item.read ? `Marcar ${item.title} como no leída` : `Marcar ${item.title} como leída`}
      >
        {content}
      </motion.button>
    );
  }

  return (
    <button
      type="button"
      className={className}
      onClick={onToggle}
      aria-label={item.read ? `Marcar ${item.title} como no leída` : `Marcar ${item.title} como leída`}
    >
      {content}
    </button>
  );
}

function NotificationPanel({
  mode,
  open,
  items,
  unread,
  onToggleRead,
  onMarkAll,
  onClear,
  onRestore,
  onClose,
}: {
  mode: CompareVariant;
  open: boolean;
  items: NotificationItem[];
  unread: number;
  onToggleRead: (id: string) => void;
  onMarkAll: () => void;
  onClear: () => void;
  onRestore: () => void;
  onClose: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);

  const panel = (
    <>
      <div className="p5-panel__head">
        <span className="p5-panel__title">Notificaciones</span>
        {unread > 0 && <span className="p5-panel__count">{unread}</span>}
        <SceneButton
          mode={mode}
          variant="icon"
          onClick={onClose}
          aria-label="Cerrar notificaciones"
        >
          <CloseIcon size={12} />
        </SceneButton>
      </div>

      {items.length === 0 ? (
        <div className="p5-empty">
          <BellIcon size={18} />
          <strong>Sin notificaciones</strong>
          <span>Cuando un agente termine una tarea, la vas a ver acá.</span>
          <SceneButton mode={mode} variant="ghost" className="cmp-btn--sm" onClick={onRestore}>
            Restaurar demo
          </SceneButton>
        </div>
      ) : (
        <div className="p5-panel__list">
          {items.map((item) => (
            <NotificationRow
              key={item.id}
              mode={mode}
              item={item}
              onToggle={() => onToggleRead(item.id)}
            />
          ))}
        </div>
      )}

      <div className="p5-panel__foot">
        <SceneButton
          mode={mode}
          variant="ghost"
          className="cmp-btn--sm"
          onClick={onMarkAll}
          disabled={unread === 0}
        >
          Marcar todo
        </SceneButton>
        <SceneButton
          mode={mode}
          variant="ghost"
          className="cmp-btn--sm"
          onClick={onClear}
          disabled={items.length === 0}
        >
          Limpiar
        </SceneButton>
      </div>
    </>
  );

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div className={`p5-panel ${motionSurfaceClass(presence.phase, 'popover')}`}>
        {panel}
      </div>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="p5-panel"
          initial={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.popover,
            y: reduce ? 0 : -4,
            filter: motionTokens.surfaceBlur,
          }}
          animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
          exit={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.popover,
            y: reduce ? 0 : -4,
            filter: motionTokens.surfaceBlur,
            transition: motionTokens.tweens.dismiss,
          }}
          transition={motionTokens.springs.pop}
          style={{ transformOrigin: 'top right' }}
        >
          {panel}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function FilePicker({
  mode,
  open,
  query,
  onQuery,
  onPick,
}: {
  mode: CompareVariant;
  open: boolean;
  query: string;
  onQuery: (value: string) => void;
  onPick: (path: string) => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);
  const files = FILES.filter((file) =>
    file.path.toLowerCase().includes(query.trim().toLowerCase())
  );

  const content = (
    <>
      <div className="p5-picker__head">
        <span>Abrir archivo</span>
        <kbd className="p5-kbd">⌘P</kbd>
      </div>
      <div className="p5-picker__search">
        <input
          className="p5-picker__input"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Filtrar archivos…"
          aria-label="Filtrar archivos"
        />
      </div>
      <div className="p5-picker__list">
        {files.length === 0 ? (
          <div className="p5-picker__empty">Sin coincidencias.</div>
        ) : (
          files.map((file) => (
            <button
              key={file.path}
              type="button"
              className="p5-picker__item"
              onClick={() => onPick(file.path)}
            >
              <span>{file.path}</span>
              <small>{file.size}</small>
            </button>
          ))
        )}
      </div>
    </>
  );

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div className={`p5-picker ${motionSurfaceClass(presence.phase, 'popover')}`}>
        {content}
      </div>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="p5-picker"
          initial={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.menu,
            y: reduce ? 0 : -4,
          }}
          animate={{
            opacity: 1,
            scale: 1,
            y: 0,
            transition: motionTokens.tweens.menu,
          }}
          exit={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.menu,
            y: reduce ? 0 : -4,
            transition: motionTokens.tweens.dismiss,
          }}
          style={{ transformOrigin: 'top left' }}
        >
          {content}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function InboxStage({
  mode,
  surface,
  items,
  unread,
  pickerQuery,
  selectedFile,
  onToggleSurface,
  onCloseSurface,
  onToggleRead,
  onMarkAll,
  onClear,
  onRestore,
  onPickerQuery,
  onPick,
}: {
  mode: CompareVariant;
  surface: InboxSurface;
  items: NotificationItem[];
  unread: number;
  pickerQuery: string;
  selectedFile: string | null;
  onToggleSurface: (next: Exclude<InboxSurface, 'none'>) => void;
  onCloseSurface: () => void;
  onToggleRead: (id: string) => void;
  onMarkAll: () => void;
  onClear: () => void;
  onRestore: () => void;
  onPickerQuery: (value: string) => void;
  onPick: (path: string) => void;
}) {
  return (
    <div className="p5-stage p5-stage--inbox">
      {surface !== 'none' && (
        <div
          className="p5-clickaway"
          onClick={onCloseSurface}
          aria-hidden="true"
        />
      )}

      <div className="p5-inbox-head">
        <div className="p5-anchor p5-bell">
          <SceneButton
            mode={mode}
            variant="icon"
            aria-label={`Notificaciones${unread > 0 ? `, ${unread} sin leer` : ''}`}
            aria-expanded={surface === 'notifications'}
            onClick={() => onToggleSurface('notifications')}
          >
            <BellIcon size={14} />
          </SceneButton>
          {unread > 0 && (
            <span className="p5-bell__badge" aria-hidden="true">
              {unread}
            </span>
          )}
          <NotificationPanel
            mode={mode}
            open={surface === 'notifications'}
            items={items}
            unread={unread}
            onToggleRead={onToggleRead}
            onMarkAll={onMarkAll}
            onClear={onClear}
            onRestore={onRestore}
            onClose={onCloseSurface}
          />
        </div>

        <div className="p5-anchor">
          <SceneButton
            mode={mode}
            variant="ghost"
            className="cmp-chip"
            aria-expanded={surface === 'quota'}
            onClick={() => onToggleSurface('quota')}
          >
            Kite 2 · 72%
            <ChevronDownIcon size={11} />
          </SceneButton>
          <QuotaSurface
            mode={mode}
            open={surface === 'quota'}
            onClose={onCloseSurface}
            align="start"
          />
        </div>

        <div className="p5-anchor p5-inbox-head__file">
          <SceneButton
            mode={mode}
            variant="ghost"
            className="cmp-btn--sm"
            aria-expanded={surface === 'picker'}
            onClick={() => onToggleSurface('picker')}
          >
            Abrir archivo
          </SceneButton>
          <FilePicker
            mode={mode}
            open={surface === 'picker'}
            query={pickerQuery}
            onQuery={onPickerQuery}
            onPick={onPick}
          />
        </div>
      </div>

      <p className="p5-hint">
        Panel, cuota y selector comparten una sola superficie: abrir una cierra la otra.
        Las filas no leídas se marcan con un click.
      </p>

      <div className="p5-mock" aria-hidden="true">
        <div className="p5-mock__head">
          <span>Actividad</span>
          <span>{items.length} eventos</span>
        </div>
        <div className="p5-mock__row">
          <span className="p5-mock__dot p5-mock__dot--green" />
          El agente terminó la revisión de overlays.
        </div>
        <div className="p5-mock__row">
          <span className="p5-mock__dot p5-mock__dot--accent" />
          La cuota del workspace sigue en 72%.
        </div>
        <div className="p5-mock__row">
          <span className="p5-mock__dot" />
          Tres archivos esperan revisión.
        </div>
      </div>

      <p className="p5-status">
        {selectedFile ? `Archivo abierto: ${selectedFile}` : 'Ningún archivo abierto todavía.'}
      </p>
    </div>
  );
}

export function InboxScene({ view }: { view: CompareView }) {
  const [surface, setSurface] = useState<InboxSurface>('none');
  const [items, setItems] = useState<NotificationItem[]>(() =>
    SEED_NOTIFICATIONS.map((item) => ({ ...item }))
  );
  const [pickerQuery, setPickerQuery] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const unread = items.filter((item) => !item.read).length;

  const toggleSurface = (next: Exclude<InboxSurface, 'none'>) => {
    setSurface((current) => (current === next ? 'none' : next));
  };

  const toggleRead = (id: string) => {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, read: !item.read } : item))
    );
  };

  const markAll = () => {
    setItems((current) => current.map((item) => ({ ...item, read: true })));
  };

  const clearAll = () => setItems([]);

  const restore = () => {
    setItems(SEED_NOTIFICATIONS.map((item) => ({ ...item })));
  };

  const pickFile = (path: string) => {
    setSelectedFile(path);
    setSurface('none');
  };

  useEscapeClose(surface !== 'none', () => setSurface('none'));

  return (
    <CompareScene
      index="05"
      title="Notificaciones y cuota"
      target="NotificationCenter · QuotaPopover · FilePicker"
      note="Un solo estado de superficie para el panel, la cuota y el selector de archivos. Marcá leídas, vaciá el panel para ver el estado vacío y abrí un archivo desde el selector."
      view={view}
    >
      {(mode) => (
        <InboxStage
          mode={mode}
          surface={surface}
          items={items}
          unread={unread}
          pickerQuery={pickerQuery}
          selectedFile={selectedFile}
          onToggleSurface={toggleSurface}
          onCloseSurface={() => setSurface('none')}
          onToggleRead={toggleRead}
          onMarkAll={markAll}
          onClear={clearAll}
          onRestore={restore}
          onPickerQuery={setPickerQuery}
          onPick={pickFile}
        />
      )}
    </CompareScene>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export function OverlaysPage({ view }: { view: CompareView }) {
  return (
    <div className="p5-page" data-page="05" data-view={view}>
      <DialogScene view={view} />
      <SheetScene view={view} />
      <AnchorScene view={view} />
      <PaletteScene view={view} />
      <InboxScene view={view} />
    </div>
  );
}
