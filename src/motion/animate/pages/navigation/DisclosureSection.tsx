import {
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { usePresence } from '../../../usePresence';
import { motionSurfaceClass } from '../../../surface';
import { useLabMotion, useLabReduce } from '../../context';
import { CompareScene, SceneButton, type CompareVariant, type CompareView } from '../../frame';
import { ChevronDownIcon } from '../../ui';
import { clamp, useCanHover } from './shared';

/* -------------------------------------------------------------------------- */
/* 5 — Accordion, pagination, tooltip                                         */
/* -------------------------------------------------------------------------- */

export function Disclosure({
  mode,
  open,
  onToggle,
  title,
  meta,
  triggerId,
  panelId,
  nested = false,
  children,
}: {
  mode: CompareVariant;
  open: boolean;
  onToggle: () => void;
  title: string;
  meta?: string;
  triggerId: string;
  panelId: string;
  nested?: boolean;
  children: ReactNode;
}) {
  const tokens = useLabMotion();
  const reduce = useLabReduce();

  return (
    <div className={`cmp-accordion__item${nested ? ' p2-nested-item' : ''}`}>
      <button
        type="button"
        className="cmp-accordion__trigger"
        id={triggerId}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <span className="p2-disclosure-title">
          {title}
          {meta && <span className="p2-disclosure-meta">{meta}</span>}
        </span>
        {mode === 'animate' ? (
          <motion.span
            className="cmp-accordion__chevron"
            animate={{ rotate: open ? 180 : 0 }}
            initial={false}
            transition={reduce ? tokens.tweens.instant : tokens.tweens.disclosure}
            aria-hidden="true"
          >
            <ChevronDownIcon size={13} />
          </motion.span>
        ) : (
          <ChevronDownIcon
            size={13}
            className={`cmp-accordion__chevron${open ? ' is-open' : ''}`}
          />
        )}
      </button>

      {mode === 'animate' ? (
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="body"
              id={panelId}
              role="region"
              aria-labelledby={triggerId}
              initial={{ height: 0, opacity: 0, filter: tokens.blur.disclosure }}
              animate={{
                height: 'auto',
                opacity: 1,
                filter: 'blur(0px)',
                transitionEnd: { filter: 'none' },
                transition: tokens.tweens.disclosure,
              }}
              exit={{
                height: 0,
                opacity: 0,
                filter: tokens.blur.disclosure,
                transition: tokens.tweens.disclosure,
              }}
              style={{ overflow: 'hidden' }}
            >
              <div className={`cmp-accordion__body${nested ? ' p2-nested-body' : ''}`}>{children}</div>
            </motion.div>
          )}
        </AnimatePresence>
      ) : (
        open && (
          <div
            id={panelId}
            role="region"
            aria-labelledby={triggerId}
            className={`cmp-accordion__body${nested ? ' p2-nested-body' : ''}`}
          >
            {children}
          </div>
        )
      )}
    </div>
  );
}

export const ACCORDION_ITEMS: readonly { id: string; title: string; body: string; meta: string }[] = [
  {
    id: 'contexto',
    title: 'Contexto del agente',
    meta: '2 reglas',
    body: 'Kite resume las últimas herramientas y conserva el borde vivo del hilo.',
  },
  {
    id: 'permisos',
    title: 'Permisos y aprobaciones',
    meta: 'estricto',
    body: 'Las escrituras piden aprobación; las lecturas pasan sin interrumpir. Las reglas anidadas heredan del proyecto.',
  },
  {
    id: 'herramientas',
    title: 'Herramientas',
    meta: '6 activas',
    body: 'Terminal, archivos, búsqueda, navegador, diff y motion audit.',
  },
];

export const PAGE_COUNT = 5;
export const PAGE_WIDTH = 28;

export interface DisclosurePaneProps {
  mode: CompareVariant;
  sections: string[];
  nestedOpen: boolean;
  page: number;
  tooltipFor: string | null;
  onToggleSection: (id: string) => void;
  onToggleNested: () => void;
  onPage: (page: number) => void;
  onTooltip: (id: string | null) => void;
}

export function DisclosurePane({
  mode,
  sections,
  nestedOpen,
  page,
  tooltipFor,
  onToggleSection,
  onToggleNested,
  onPage,
  onTooltip,
}: DisclosurePaneProps) {
  const tokens = useLabMotion();
  const reduce = useLabReduce();
  const base = useId();
  const canHover = useCanHover();
  const pagesRef = useRef<HTMLDivElement>(null);

  const activeTip = tooltipFor;

  const movePage = (delta: number) => {
    const next = clamp(page + delta, 1, PAGE_COUNT);
    onPage(next);
    window.requestAnimationFrame(() => {
      pagesRef.current?.querySelectorAll<HTMLButtonElement>('button')[next - 1]?.focus();
    });
  };

  const handlePageKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      movePage(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      movePage(1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      onPage(1);
    } else if (event.key === 'End') {
      event.preventDefault();
      onPage(PAGE_COUNT);
    }
  };

  const tips: Record<string, { label: string; text: string }> = {
    compact: { label: 'Vista compacta', text: 'Menos filas por pantalla; el scroll sigue en el borde.' },
    share: { label: 'Compartir', text: 'Copia el enlace del hilo con el punto de lectura.' },
  };

  return (
    <div className="p2-stage p2-disclosure-demo">
      <div className="p2-subhead">
        Acordeón <span>múltiple + anidado</span>
      </div>

      <div className="cmp-accordion">
        {ACCORDION_ITEMS.map((item) => {
          const open = sections.includes(item.id);
          return (
            <Disclosure
              key={item.id}
              mode={mode}
              open={open}
              onToggle={() => onToggleSection(item.id)}
              title={item.title}
              meta={item.meta}
              triggerId={`${base}-acc-${item.id}`}
              panelId={`${base}-acc-panel-${item.id}`}
            >
              <p className="p2-disclosure-copy">{item.body}</p>
              {item.id === 'permisos' && (
                <Disclosure
                  mode={mode}
                  open={nestedOpen}
                  onToggle={onToggleNested}
                  title="Reglas por proyecto"
                  meta="anidado"
                  triggerId={`${base}-nested-trigger`}
                  panelId={`${base}-nested-panel`}
                  nested
                >
                  <p className="p2-disclosure-copy">
                    Este proyecto exige aprobación para <code>src/motion/**</code> y permite
                    lecturas sin interrumpir.
                  </p>
                </Disclosure>
              )}
            </Disclosure>
          );
        })}
      </div>

      <div className="p2-lower-grid">
        <div className="p2-block">
          <div className="p2-subhead">
            Paginación <span>indicador deslizante</span>
          </div>
          <nav className="p2-pagination" aria-label="Paginación de resultados">
            <button
              type="button"
              className="p2-page-arrow"
              aria-label="Página anterior"
              disabled={page === 1}
              onClick={() => movePage(-1)}
            >
              ‹
            </button>
            <div className="p2-pagination__pages" ref={pagesRef} onKeyDown={handlePageKeys}>
              {mode === 'kite' ? (
                <span
                  className="p2-page-indicator p2-tab-indicator--kite"
                  style={{ transform: `translateX(${(page - 1) * PAGE_WIDTH}px)` }}
                  aria-hidden="true"
                />
              ) : (
                <motion.span
                  className="p2-page-indicator"
                  animate={{ x: (page - 1) * PAGE_WIDTH }}
                  initial={false}
                  transition={reduce ? tokens.tweens.instant : tokens.springs.selection}
                  aria-hidden="true"
                />
              )}
              {Array.from({ length: PAGE_COUNT }, (_, index) => index + 1).map((number) => (
                <button
                  key={number}
                  type="button"
                  className={`p2-page-btn${number === page ? ' is-current' : ''}`}
                  aria-label={`Página ${number}`}
                  aria-current={number === page ? 'page' : undefined}
                  tabIndex={number === page ? 0 : -1}
                  onClick={() => onPage(number)}
                >
                  <span className="p2-page-btn__label">{number}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="p2-page-arrow"
              aria-label="Página siguiente"
              disabled={page === PAGE_COUNT}
              onClick={() => movePage(1)}
            >
              ›
            </button>
            <span className="p2-pagination__meta" aria-live="polite">
              Página {page} de {PAGE_COUNT} · 24 resultados
            </span>
          </nav>
        </div>

        <div className="p2-block">
          <div className="p2-subhead">
            Tooltip <span>hover + foco</span>
          </div>
          <div className="p2-tooltip-row">
            {(['compact', 'share'] as const).map((id) => {
              const spec = tips[id];
              const isActive = activeTip === id;
              return (
                <span
                  key={id}
                  className="p2-tip-anchor"
                  onPointerEnter={canHover ? () => onTooltip(id) : undefined}
                  onPointerLeave={
                    canHover
                      ? (event) => {
                          const button = event.currentTarget.querySelector('button');
                          if (!button || button !== document.activeElement) onTooltip(null);
                        }
                      : undefined
                  }
                >
                  <SceneButton
                    mode={mode}
                    variant="ghost"
                    className="cmp-btn--sm"
                    aria-describedby={isActive ? `${base}-tip-${id}` : undefined}
                    onFocus={() => onTooltip(id)}
                    onBlur={() => onTooltip(null)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Escape') return;
                      event.preventDefault();
                      onTooltip(null);
                      event.currentTarget.blur();
                    }}
                  >
                    {spec.label}
                  </SceneButton>
                  <span className="p2-tip" role="presentation">
                    <TooltipBubble mode={mode} open={isActive} id={`${base}-tip-${id}`}>
                      {spec.text}
                    </TooltipBubble>
                  </span>
                </span>
              );
            })}
          </div>
          <p className="p2-tooltip-hint">
            En Animate UI el tooltip crece desde <code>scale.tooltip</code>; en Kite entra con el
            popover CSS.
          </p>
        </div>
      </div>
    </div>
  );
}

export function TooltipBubble({
  mode,
  open,
  id,
  children,
}: {
  mode: CompareVariant;
  open: boolean;
  id: string;
  children: ReactNode;
}) {
  const tokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <span
        id={id}
        role="tooltip"
        className={`p2-tip__bubble ${motionSurfaceClass(presence.phase, 'popover')}`}
      >
        {children}
      </span>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.span
          id={id}
          role="tooltip"
          className="p2-tip__bubble"
          initial={{
            opacity: 0,
            scale: reduce ? 1 : tokens.scale.tooltip,
            filter: tokens.surfaceBlur,
          }}
          animate={{
            opacity: 1,
            scale: 1,
            filter: 'blur(0px)',
            transition: tokens.springs.pop,
          }}
          exit={{
            opacity: 0,
            scale: reduce ? 1 : tokens.scale.tooltip,
            filter: tokens.surfaceBlur,
            transition: tokens.tweens.dismiss,
          }}
          style={{ transformOrigin: 'bottom center' }}
        >
          {children}
        </motion.span>
      )}
    </AnimatePresence>
  );
}

export function DisclosureSection({ view }: { view: CompareView }) {
  const [sections, setSections] = useState<string[]>(['contexto']);
  const [nestedOpen, setNestedOpen] = useState(false);
  const [page, setPage] = useState(2);
  const [tooltipFor, setTooltipFor] = useState<string | null>(null);

  const toggleSection = (id: string) => {
    setSections((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  };

  return (
    <CompareScene
      index="2.5"
      title="Disclosures, paginación y tooltip"
      target="Accordion · Pagination · Tooltip"
      note="Abrí varias secciones, incluida la anidada. La altura se anima con transition.disclosure y el chevron gira con el panel. La paginación mueve su indicador en spring.selection; el tooltip aparece por hover y por foco."
      view={view}
    >
      {(mode) => (
        <DisclosurePane
          mode={mode}
          sections={sections}
          nestedOpen={nestedOpen}
          page={page}
          tooltipFor={tooltipFor}
          onToggleSection={toggleSection}
          onToggleNested={() => setNestedOpen((value) => !value)}
          onPage={setPage}
          onTooltip={setTooltipFor}
        />
      )}
    </CompareScene>
  );
}
