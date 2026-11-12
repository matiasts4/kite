import {
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { usePresence } from '../../../usePresence';
import { motionSurfaceClass } from '../../../surface';
import { useLabMotion, useLabReduce } from '../../context';
import { CompareScene, SceneButton, type CompareVariant, type CompareView } from '../../frame';
import { CloseIcon } from '../../ui';
import { clamp } from './shared';

/* -------------------------------------------------------------------------- */
/* 6 — Dock / resizable panel                                                 */
/* -------------------------------------------------------------------------- */

export const DOCK_PRESETS = [160, 240, 320] as const;
export const DOCK_MIN = 150;
export const DOCK_MAX = 340;

export function snapDockWidth(width: number): number {
  let nearest: number = DOCK_PRESETS[0];
  for (const preset of DOCK_PRESETS) {
    if (Math.abs(preset - width) < Math.abs(nearest - width)) nearest = preset;
  }
  return Math.abs(nearest - width) <= 28 ? nearest : Math.round(width);
}

export interface DockPaneProps {
  mode: CompareVariant;
  open: boolean;
  width: number;
  onOpenChange: (open: boolean) => void;
  onWidth: (width: number) => void;
}

export function DockPane({ mode, open, width, onOpenChange, onWidth }: DockPaneProps) {
  const tokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);
  const domId = useId();
  const panelDomId = `${domId}-dock-panel`;
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number; latest: number } | null>(null);
  const toggleRef = useRef<HTMLSpanElement>(null);

  const focusToggle = () =>
    toggleRef.current?.querySelector<HTMLButtonElement>('button')?.focus();

  const closeDock = () => {
    onOpenChange(false);
    window.requestAnimationFrame(focusToggle);
  };

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: width, latest: width };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const dragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = clamp(drag.startWidth + (drag.startX - event.clientX), DOCK_MIN, DOCK_MAX);
    drag.latest = Math.round(next);
    onWidth(drag.latest);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onWidth(snapDockWidth(drag.latest));
  };

  const resizeByKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = clamp(width + 16, DOCK_MIN, DOCK_MAX);
    else if (event.key === 'ArrowRight') next = clamp(width - 16, DOCK_MIN, DOCK_MAX);
    else if (event.key === 'Home') next = DOCK_PRESETS[0];
    else if (event.key === 'End') next = DOCK_PRESETS[DOCK_PRESETS.length - 1];
    if (next === null) return;
    event.preventDefault();
    onWidth(next);
  };

  const dockBody = (
    <>
      <div className="p2-dock__head">
        <strong>Inspector</strong>
        <span className="p2-dock__measure">{width} px</span>
        <SceneButton
          mode={mode}
          variant="icon"
          aria-label="Cerrar inspector"
          onClick={closeDock}
        >
          <CloseIcon size={12} />
        </SceneButton>
      </div>
      <div className="p2-dock__rows">
        <div className="p2-dock__row">
          <span>Archivo</span>
          <strong>contract.ts</strong>
        </div>
        <div className="p2-dock__row">
          <span>Estado</span>
          <strong className="p2-dock__ok">sin cambios</strong>
        </div>
        <div className="p2-dock__row">
          <span>Ancho</span>
          <strong>{width} px</strong>
        </div>
      </div>
      <p className="p2-dock__hint">
        El marco entra con <code>transform</code>. El ancho no tiene transición: se ajusta directo
        mientras arrastrás.
      </p>
      <div
        className="p2-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Redimensionar inspector"
        aria-valuemin={DOCK_MIN}
        aria-valuemax={DOCK_MAX}
        aria-valuenow={width}
        aria-valuetext={`${width} píxeles`}
        tabIndex={0}
        onPointerDown={startDrag}
        onPointerMove={dragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={resizeByKey}
      >
        <span className="p2-resizer__grip" aria-hidden="true" />
      </div>
    </>
  );

  return (
    <div className="p2-stage p2-dock-demo">
      <div className="p2-dock-toolbar">
        <span ref={toggleRef} className="p2-ref">
          <SceneButton
            mode={mode}
            variant={open ? 'default' : 'primary'}
            aria-expanded={open}
            aria-controls={panelDomId}
            onClick={() => {
              if (open) closeDock();
              else onOpenChange(true);
            }}
          >
            {open ? 'Cerrar inspector' : 'Abrir inspector'}
          </SceneButton>
        </span>
        <div className="p2-presets" role="group" aria-label="Anchos del inspector">
          {DOCK_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className={`p2-preset${width === preset ? ' is-picked' : ''}`}
              aria-pressed={width === preset}
              disabled={!open}
              onClick={() => onWidth(preset)}
            >
              {preset}
            </button>
          ))}
        </div>
        <span className="p2-dock-toolbar__meta">
          snap {DOCK_PRESETS.join(' / ')} px · arrastrá el borde
        </span>
      </div>

      <div className={`p2-dock-stage${dragging ? ' is-dragging' : ''}`}>
        <div className="p2-dock-main" aria-hidden="true">
          <div className="p2-dock-main__bar">
            <span>src/motion/contract.ts</span>
            <span className="cmp-badge">typescript</span>
          </div>
          <div className="p2-dock-main__code">
            <span>export const MOTION_ENTER_MS = 180;</span>
            <span>export const MOTION_EXIT_MS = 140;</span>
            <span> </span>
            <span>export function prefersReducedMotion() {'{'}</span>
            <span>  return document.documentElement.dataset.motion === 'reduce';</span>
            <span>{'}'}</span>
          </div>
          <div className="p2-dock-main__note">
            El editor no reflowea durante la entrada del panel; el ancho solo cambia al arrastrar
            o al elegir un preset.
          </div>
        </div>

        {mode === 'kite' ? (
          presence.mounted && (
            <aside
              id={panelDomId}
              className={`p2-dock ${motionSurfaceClass(presence.phase, 'panel')}`}
              style={{ width }}
              aria-label="Inspector de archivos"
            >
              {dockBody}
            </aside>
          )
        ) : (
          <AnimatePresence>
            {open && (
              <motion.aside
                id={panelDomId}
                className="p2-dock"
                style={{ width }}
                aria-label="Inspector de archivos"
                initial={{ x: '100%' }}
                animate={{ x: 0, transition: tokens.tweens.sheet }}
                exit={{ x: '100%', transition: tokens.tweens.dismiss }}
              >
                {dockBody}
              </motion.aside>
            )}
          </AnimatePresence>
        )}
      </div>

      <p className="p2-dock-caption">
        Arrastrá para redimensionar, soltá cerca de un preset para hacer snap. El ancho se escribe
        sin transición; solo el marco se mueve.
        {reduce ? ' Reduced motion: el panel aparece sin desplazamiento.' : ''}
      </p>
    </div>
  );
}

export function DockSection({ view }: { view: CompareView }) {
  const [dockOpen, setDockOpen] = useState(true);
  const [dockWidth, setDockWidth] = useState(240);

  return (
    <CompareScene
      index="2.6"
      title="Dock y paneles redimensionables"
      target="RightDock · ResizablePanel"
      note="Abrí y cerrá el inspector: entra con transform, nunca animando el ancho. Arrastrá el borde izquierdo o usá ← → con el separador enfocado; al soltar cerca de 160 / 240 / 320 hace snap."
      view={view}
    >
      {(mode) => (
        <DockPane
          mode={mode}
          open={dockOpen}
          width={dockWidth}
          onOpenChange={setDockOpen}
          onWidth={setDockWidth}
        />
      )}
    </CompareScene>
  );
}
