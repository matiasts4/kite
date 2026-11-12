import {
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
import { CloseIcon } from '../../ui';
import { useEscapeClose } from './shared';

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
