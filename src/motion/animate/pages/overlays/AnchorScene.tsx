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
import { ChevronDownIcon, MoreIcon } from '../../ui';
import { useEscapeClose } from './shared';
import { QuotaSurface } from './QuotaSurface';
import { MenuSurface } from './AnchorMenu';

export { QuotaCard, QuotaSurface } from './QuotaSurface';
export { SubmenuSurface, MenuSurface } from './AnchorMenu';

/* -------------------------------------------------------------------------- */
/* Scene 3 — Popover, menu, tooltip and hover card                             */
/* -------------------------------------------------------------------------- */

const TOOLTIPS: { id: string; label: string; text: string }[] = [
  { id: 'save', label: 'Guardar', text: 'Guardar (⌘S)' },
  { id: 'discard', label: 'Descartar', text: 'Descartar (esc)' },
];

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
