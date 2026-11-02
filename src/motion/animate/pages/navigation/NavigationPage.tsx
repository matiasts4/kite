import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { AnimatePresence, Reorder, motion } from 'motion/react';
import { usePresence } from '../../../usePresence';
import { motionSurfaceClass } from '../../../surface';
import { useLabMotion, useLabReduce } from '../../context';
import { CompareScene, SceneButton, type CompareVariant, type CompareView } from '../../frame';
import { CheckIcon, ChevronDownIcon, CloseIcon } from '../../ui';
import { RealHeaderSidebarScenes } from './RealHeaderSidebarScenes';
import './navigation.css';

type Direction = 1 | -1;

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function useCanHover(): boolean {
  const [canHover, setCanHover] = useState(
    () => window.matchMedia('(hover: hover) and (pointer: fine)').matches
  );

  useEffect(() => {
    const query = window.matchMedia('(hover: hover) and (pointer: fine)');
    const update = () => setCanHover(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return canHover;
}

function useMenuAutoFocus(open: boolean) {
  const [autoFocus, setAutoFocus] = useState(false);
  useEffect(() => {
    if (!open) setAutoFocus(false);
  }, [open]);
  return [autoFocus, setAutoFocus] as const;
}

function focusFirstIn(element: HTMLElement | null): void {
  element
    ?.querySelector<HTMLButtonElement>('button[role^="menuitem"], button[role="menuitem"]')
    ?.focus();
}

/* -------------------------------------------------------------------------- */
/* Icons                                                                      */
/* -------------------------------------------------------------------------- */

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

type NavGlyphKind = 'home' | 'chat' | 'folder' | 'sliders';

function NavGlyph({ kind }: { kind: NavGlyphKind }) {
  if (kind === 'home') {
    return (
      <Glyph>
        <path d="M3 11 12 3l9 8" />
        <path d="M5 10v11h14V10" />
        <path d="M10 21v-6h4v6" />
      </Glyph>
    );
  }
  if (kind === 'chat') {
    return (
      <Glyph>
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </Glyph>
    );
  }
  if (kind === 'folder') {
    return (
      <Glyph>
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </Glyph>
    );
  }
  return (
    <Glyph>
      <path d="M4 7h8M16 7h4M4 17h4M12 17h8" />
      <circle cx="14" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </Glyph>
  );
}

function SearchGlyph() {
  return (
    <Glyph>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Glyph>
  );
}

function GripIcon() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
      <circle cx="2.5" cy="3" r="1.2" />
      <circle cx="7.5" cy="3" r="1.2" />
      <circle cx="2.5" cy="7" r="1.2" />
      <circle cx="7.5" cy="7" r="1.2" />
      <circle cx="2.5" cy="11" r="1.2" />
      <circle cx="7.5" cy="11" r="1.2" />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* 1 — Tabs                                                                   */
/* -------------------------------------------------------------------------- */

type HTabId =
  | 'general'
  | 'modelos'
  | 'apariencia'
  | 'atajos'
  | 'extensiones'
  | 'equipo'
  | 'avanzado';

const H_TABS: readonly { id: HTabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'modelos', label: 'Modelos' },
  { id: 'apariencia', label: 'Apariencia' },
  { id: 'atajos', label: 'Atajos' },
  { id: 'extensiones', label: 'Extensiones' },
  { id: 'equipo', label: 'Equipo' },
  { id: 'avanzado', label: 'Avanzado' },
];

const H_PANELS: Record<HTabId, { title: string; body: string; meta: string; rows: string[] }> = {
  general: {
    title: 'Preferencias generales',
    body: 'El hilo abre en el último punto de lectura y conserva el borde vivo.',
    meta: '3 reglas',
    rows: ['Abrir en el último punto', 'Recordar el ancho del rail'],
  },
  modelos: {
    title: 'Modelos del workspace',
    body: 'Kite 2 · Opus para hilos largos; Flash para tareas de una sola vuelta.',
    meta: '2 modelos',
    rows: ['Modelo por defecto: Opus', 'Fallback: Flash'],
  },
  apariencia: {
    title: 'Apariencia',
    body: 'El tema sigue al sistema y el laboratorio fuerza el modo oscuro.',
    meta: 'oscuro',
    rows: ['Tema del sistema', 'Densidad compacta'],
  },
  atajos: {
    title: 'Atajos',
    body: 'La paleta de comandos y el buscador comparten el mismo registro.',
    meta: 'Ctrl K',
    rows: ['Paleta de comandos', 'Buscar en el hilo'],
  },
  extensiones: {
    title: 'Extensiones',
    body: 'Dos extensiones activas revisan el diff antes de aplicar un cambio.',
    meta: '2 activas',
    rows: ['Motion audit', 'Diff guard'],
  },
  equipo: {
    title: 'Equipo',
    body: 'Tres personas comparten el workspace y el presupuesto mensual.',
    meta: '3 miembros',
    rows: ['Marina · owner', 'Leo · editor'],
  },
  avanzado: {
    title: 'Avanzado',
    body: 'Las escrituras piden aprobación; las lecturas pasan sin interrumpir.',
    meta: 'estricto',
    rows: ['Aprobaciones por escritura', 'Telemetría local'],
  },
};

const H_TAB_WIDTH = 84;

type VTabId = 'hilos' | 'archivos' | 'git' | 'registro';

const V_TABS: readonly { id: VTabId; label: string; body: string }[] = [
  { id: 'hilos', label: 'Hilos', body: '4 hilos activos · 2 sin leer' },
  { id: 'archivos', label: 'Archivos', body: 'src/motion/contract.ts tocado hace 2 min' },
  { id: 'git', label: 'Git', body: 'feat/agent-sessions · 3 archivos sin commit' },
  { id: 'registro', label: 'Registro', body: '18 eventos de la sesión actual' },
];

const V_TAB_HEIGHT = 34;

interface SwapPanelProps {
  mode: CompareVariant;
  activeKey: string;
  direction: Direction;
  panelId: string;
  labelledBy: string;
  className?: string;
  children: ReactNode;
}

/** One tab panel: CSS swap for Kite, panelOut / panelIn for Animate UI. */
function SwapPanel({
  mode,
  activeKey,
  direction,
  panelId,
  labelledBy,
  className = '',
  children,
}: SwapPanelProps) {
  const tokens = useLabMotion();
  const reduce = useLabReduce();
  const classes = `p2-swap-panel ${className}`.trim();

  if (mode === 'kite') {
    return (
      <div
        key={activeKey}
        id={panelId}
        className={`${classes} p2-panel-in`}
        data-dir={direction}
        role="tabpanel"
        aria-labelledby={labelledBy}
        tabIndex={0}
      >
        {children}
      </div>
    );
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={activeKey}
        id={panelId}
        className={classes}
        role="tabpanel"
        aria-labelledby={labelledBy}
        tabIndex={0}
        initial={{
          opacity: 0,
          x: reduce ? 0 : direction * tokens.travel(tokens.shift.tabs),
          filter: tokens.blur.panel,
        }}
        animate={{
          opacity: 1,
          x: 0,
          filter: 'blur(0px)',
          transition: tokens.tweens.panelIn,
        }}
        exit={{
          opacity: 0,
          x: reduce ? 0 : -direction * tokens.travel(tokens.shift.tabs),
          filter: tokens.blur.panel,
          transition: tokens.tweens.panelOut,
        }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

function TabPanelBody({
  title,
  body,
  meta,
  rows,
}: {
  title: string;
  body: string;
  meta: string;
  rows: string[];
}) {
  return (
    <>
      <div className="p2-tabpanel__head">
        <strong>{title}</strong>
        <span className="cmp-badge">{meta}</span>
      </div>
      <p className="p2-tabpanel__body">{body}</p>
      <ul className="p2-tabpanel__rows">
        {rows.map((row) => (
          <li key={row}>
            <span className="p2-dot" aria-hidden="true" />
            {row}
          </li>
        ))}
      </ul>
    </>
  );
}

interface TabsPaneProps {
  mode: CompareVariant;
  hTab: { id: HTabId; direction: Direction };
  vTab: { id: VTabId; direction: Direction };
  onHTab: (id: HTabId) => void;
  onVTab: (id: VTabId) => void;
}

function TabsPane({ mode, hTab, vTab, onHTab, onVTab }: TabsPaneProps) {
  const tokens = useLabMotion();
  const reduce = useLabReduce();
  const base = useId();
  const hIndex = H_TABS.findIndex((tab) => tab.id === hTab.id);
  const vIndex = V_TABS.findIndex((tab) => tab.id === vTab.id);

  const handleHKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys = H_TABS.map((tab) => tab.id);
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (hIndex + 1) % keys.length;
    else if (event.key === 'ArrowLeft') next = (hIndex - 1 + keys.length) % keys.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = keys.length - 1;
    if (next === null) return;
    event.preventDefault();
    onHTab(keys[next]);
    const tab = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next];
    tab?.focus();
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  const handleVKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys = V_TABS.map((tab) => tab.id);
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = (vIndex + 1) % keys.length;
    else if (event.key === 'ArrowUp') next = (vIndex - 1 + keys.length) % keys.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = keys.length - 1;
    if (next === null) return;
    event.preventDefault();
    onVTab(keys[next]);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  const hPanel = H_PANELS[hTab.id];
  const vPanel = V_TABS[vIndex];

  return (
    <div className="p2-stage p2-tabs-demo">
      <div className="p2-subhead">
        Tabs horizontales <span>7 tabs · overflow</span>
      </div>

      <div className="p2-tabbar">
        <div
          className="p2-tablist"
          role="tablist"
          aria-label="Ajustes del agente"
          onKeyDown={handleHKeys}
        >
          {mode === 'kite' ? (
            <span
              className="p2-tab-indicator p2-tab-indicator--kite"
              style={{ transform: `translateX(${hIndex * H_TAB_WIDTH}px)` }}
              aria-hidden="true"
            />
          ) : (
            <motion.span
              className="p2-tab-indicator"
              animate={{ x: hIndex * H_TAB_WIDTH }}
              initial={false}
              transition={reduce ? tokens.tweens.instant : tokens.springs.selection}
              aria-hidden="true"
            />
          )}
          {H_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`${base}-h-${tab.id}`}
              aria-selected={hTab.id === tab.id}
              aria-controls={`${base}-h-panel`}
              tabIndex={hTab.id === tab.id ? 0 : -1}
              className={`p2-tab${hTab.id === tab.id ? ' is-active' : ''}`}
              onClick={() => onHTab(tab.id)}
            >
              <span className="p2-tab__label">{tab.label}</span>
            </button>
          ))}
        </div>
      </div>
      <span className="p2-scroll-hint">Desplazá el tablist para ver los últimos tabs.</span>

      <SwapPanel
        mode={mode}
        activeKey={hTab.id}
        direction={hTab.direction}
        panelId={`${base}-h-panel`}
        labelledBy={`${base}-h-${hTab.id}`}
        className="p2-tabpanel"
      >
        <TabPanelBody {...hPanel} />
      </SwapPanel>

      <div className="p2-subhead p2-subhead--gap">
        Tabs verticales <span>orientación vertical</span>
      </div>
      <div className="p2-vtabs-demo">
        <div
          className="p2-vtablist"
          role="tablist"
          aria-orientation="vertical"
          aria-label="Explorador del workspace"
          onKeyDown={handleVKeys}
        >
          {mode === 'kite' ? (
            <span
              className="p2-vtab-indicator p2-tab-indicator--kite"
              style={{ transform: `translateY(${vIndex * V_TAB_HEIGHT}px)` }}
              aria-hidden="true"
            />
          ) : (
            <motion.span
              className="p2-vtab-indicator"
              animate={{ y: vIndex * V_TAB_HEIGHT }}
              initial={false}
              transition={reduce ? tokens.tweens.instant : tokens.springs.selection}
              aria-hidden="true"
            />
          )}
          {V_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`${base}-v-${tab.id}`}
              aria-selected={vTab.id === tab.id}
              aria-controls={`${base}-v-panel`}
              tabIndex={vTab.id === tab.id ? 0 : -1}
              className={`p2-vtab${vTab.id === tab.id ? ' is-active' : ''}`}
              onClick={() => onVTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <SwapPanel
          mode={mode}
          activeKey={vTab.id}
          direction={vTab.direction}
          panelId={`${base}-v-panel`}
          labelledBy={`${base}-v-${vTab.id}`}
          className="p2-vpanel"
        >
          <span className="p2-vpanel__title">{vPanel?.label}</span>
          <p>{vPanel?.body}</p>
          <span className="cmp-badge">workspace</span>
        </SwapPanel>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 2 — Sidebar                                                                */
/* -------------------------------------------------------------------------- */

type SidebarItemId = 'inicio' | 'hilos' | 'archivos' | 'ajustes';
type NestedThreadId = 'th-refactor' | 'th-motion' | 'th-preview';
type FavoriteId = 'fav-hilos' | 'fav-archivos' | 'fav-notas';

const NAV_ITEMS: readonly { id: SidebarItemId; label: string; glyph: NavGlyphKind }[] = [
  { id: 'inicio', label: 'Inicio', glyph: 'home' },
  { id: 'hilos', label: 'Hilos', glyph: 'chat' },
  { id: 'archivos', label: 'Archivos', glyph: 'folder' },
  { id: 'ajustes', label: 'Ajustes', glyph: 'sliders' },
];

const NESTED_THREADS: readonly { id: NestedThreadId; label: string }[] = [
  { id: 'th-refactor', label: 'Refactor del transcript' },
  { id: 'th-motion', label: 'Motion contract' },
  { id: 'th-preview', label: 'Preview Animate UI' },
];

const FAVORITES: Record<FavoriteId, string> = {
  'fav-hilos': 'Hilos',
  'fav-archivos': 'Archivos',
  'fav-notas': 'Notas',
};

const SIDEBAR_LABELS: Record<string, string> = {
  inicio: 'Inicio',
  hilos: 'Hilos',
  archivos: 'Archivos',
  ajustes: 'Ajustes',
  'th-refactor': 'Refactor del transcript',
  'th-motion': 'Motion contract',
  'th-preview': 'Preview Animate UI',
  ...FAVORITES,
};

function SideLabel({
  mode,
  collapsed,
  children,
  className = '',
}: {
  mode: CompareVariant;
  collapsed: boolean;
  children: ReactNode;
  className?: string;
}) {
  const tokens = useLabMotion();
  const reduce = useLabReduce();
  const classes = `p2-side-label ${className}`.trim();

  if (mode === 'animate') {
    return (
      <motion.span
        className={classes}
        animate={{ opacity: collapsed ? 0 : 1, filter: collapsed ? tokens.swapBlur : 'blur(0px)' }}
        transition={reduce ? tokens.tweens.instant : tokens.tweens.swap}
      >
        {children}
      </motion.span>
    );
  }

  return <span className={classes}>{children}</span>;
}

function FavoriteRow({
  mode,
  id,
  label,
  collapsed,
  active,
  onSelect,
  onMove,
}: {
  mode: CompareVariant;
  id: FavoriteId;
  label: string;
  collapsed: boolean;
  active: boolean;
  onSelect: (id: FavoriteId) => void;
  onMove: (id: FavoriteId, delta: number) => void;
}) {
  return (
    <>
      <span className="p2-fav__grip" aria-hidden="true">
        <GripIcon />
      </span>
      <button
        type="button"
        className={`p2-fav__btn${active ? ' is-active' : ''}`}
        aria-label={`${label} — Alt+flechas para reordenar`}
        onClick={() => onSelect(id)}
        onKeyDown={(event) => {
          if (!event.altKey) return;
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          onMove(id, event.key === 'ArrowUp' ? -1 : 1);
        }}
      >
        <span className="p2-fav__dot" aria-hidden="true" />
        <SideLabel mode={mode} collapsed={collapsed}>
          {label}
        </SideLabel>
      </button>
    </>
  );
}

interface SidebarPaneProps {
  mode: CompareVariant;
  collapsed: boolean;
  active: string;
  treeOpen: boolean;
  favorites: FavoriteId[];
  onToggleCollapse: () => void;
  onSelect: (id: string) => void;
  onToggleTree: () => void;
  onFavoritesChange: (next: FavoriteId[]) => void;
  onMoveFavorite: (id: FavoriteId, delta: number) => void;
}

function SidebarPane({
  mode,
  collapsed,
  active,
  treeOpen,
  favorites,
  onToggleCollapse,
  onSelect,
  onToggleTree,
  onFavoritesChange,
  onMoveFavorite,
}: SidebarPaneProps) {
  const tokens = useLabMotion();
  const reduce = useLabReduce();
  const base = useId();
  const [dragFavorite, setDragFavorite] = useState<FavoriteId | null>(null);
  const parentActive = active === 'hilos' || NESTED_THREADS.some((thread) => thread.id === active);
  const activeLabel = SIDEBAR_LABELS[active] ?? 'Inicio';
  const sidebarWidth = collapsed ? 56 : 208;

  const dropFavorite = (targetId: FavoriteId) => {
    if (!dragFavorite || dragFavorite === targetId) {
      setDragFavorite(null);
      return;
    }
    const from = favorites.indexOf(dragFavorite);
    const to = favorites.indexOf(targetId);
    setDragFavorite(null);
    if (from < 0 || to < 0) return;
    const next = [...favorites];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onFavoritesChange(next);
  };

  const header = (
    <div className="p2-sidebar__head">
      <span className="p2-sidebar__mark" aria-hidden="true">
        K
      </span>
      <SideLabel mode={mode} collapsed={collapsed} className="p2-sidebar__brand">
        kite / motion
      </SideLabel>
      <button
        type="button"
        className="p2-collapse"
        aria-label={collapsed ? 'Expandir barra lateral' : 'Colapsar barra lateral'}
        aria-expanded={!collapsed}
        aria-controls={`${base}-nav`}
        onClick={onToggleCollapse}
      >
        {mode === 'animate' ? (
          <motion.span
            className="p2-collapse__glyph"
            animate={{ rotate: collapsed ? -90 : 90 }}
            initial={false}
            transition={reduce ? tokens.tweens.instant : tokens.tweens.swap}
          >
            <ChevronDownIcon size={13} />
          </motion.span>
        ) : (
          <ChevronDownIcon
            size={13}
            className={`p2-collapse__glyph${collapsed ? ' is-collapsed' : ''}`}
          />
        )}
      </button>
    </div>
  );

  const body = (
    <>
      {header}

      <div className="p2-sidebar__section">
        <SideLabel mode={mode} collapsed={collapsed}>
          Favoritos
        </SideLabel>
      </div>

      {mode === 'animate' ? (
        <Reorder.Group
          axis="y"
          values={favorites}
          onReorder={onFavoritesChange}
          className="p2-fav-list"
          aria-label="Favoritos reordenables"
        >
          {favorites.map((id) => (
            <Reorder.Item
              key={id}
              value={id}
              className="p2-fav"
              transition={reduce ? tokens.tweens.instant : tokens.springs.reflow}
            >
              <FavoriteRow
                mode={mode}
                id={id}
                label={FAVORITES[id]}
                collapsed={collapsed}
                active={active === id}
                onSelect={onSelect}
                onMove={onMoveFavorite}
              />
            </Reorder.Item>
          ))}
        </Reorder.Group>
      ) : (
        <ul className="p2-fav-list" aria-label="Favoritos reordenables">
          {favorites.map((id) => (
            <li
              key={id}
              className={`p2-fav${dragFavorite === id ? ' is-dragging' : ''}`}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => {
                event.preventDefault();
                dropFavorite(id);
              }}
            >
              <span
                className="p2-fav__grip is-draggable"
                aria-hidden="true"
                draggable
                onDragStart={(event) => {
                  setDragFavorite(id);
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', id);
                }}
                onDragEnd={() => setDragFavorite(null)}
              >
                <GripIcon />
              </span>
              <button
                type="button"
                className={`p2-fav__btn${active === id ? ' is-active' : ''}`}
                aria-label={`${FAVORITES[id]} — Alt+flechas para reordenar`}
                onClick={() => onSelect(id)}
                onKeyDown={(event) => {
                  if (!event.altKey) return;
                  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                  event.preventDefault();
                  onMoveFavorite(id, event.key === 'ArrowUp' ? -1 : 1);
                }}
              >
                <span className="p2-fav__dot" aria-hidden="true" />
                <SideLabel mode={mode} collapsed={collapsed}>
                  {FAVORITES[id]}
                </SideLabel>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="p2-sidebar__section">
        <SideLabel mode={mode} collapsed={collapsed}>
          Navegación
        </SideLabel>
      </div>

      <nav id={`${base}-nav`} aria-label="Navegación del workspace">
        <ul className="p2-side-nav">
          {NAV_ITEMS.map((item) => {
            const isActive = item.id === 'hilos' ? parentActive : active === item.id;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className={`p2-side-item${isActive ? ' is-active' : ''}`}
                  aria-current={isActive ? 'page' : undefined}
                  aria-expanded={item.id === 'hilos' ? treeOpen : undefined}
                  aria-controls={item.id === 'hilos' ? `${base}-threads` : undefined}
                  onClick={() => {
                    onSelect(item.id);
                    if (item.id === 'hilos') onToggleTree();
                  }}
                >
                  {mode === 'animate' && isActive && (
                    <motion.span
                      layoutId="p2-side-highlight"
                      className="p2-side-highlight"
                      initial={false}
                      transition={reduce ? tokens.tweens.instant : tokens.springs.highlight}
                      aria-hidden="true"
                    />
                  )}
                  <span className="p2-side-item__icon">
                    <NavGlyph kind={item.glyph} />
                  </span>
                  <SideLabel mode={mode} collapsed={collapsed}>
                    {item.label}
                  </SideLabel>
                  {item.id === 'hilos' && !collapsed && (
                    <span className={`p2-side-item__chevron${treeOpen ? ' is-open' : ''}`}>
                      {mode === 'animate' ? (
                        <motion.span
                          animate={{ rotate: treeOpen ? 180 : 0 }}
                          initial={false}
                          transition={reduce ? tokens.tweens.instant : tokens.tweens.disclosure}
                        >
                          <ChevronDownIcon size={12} />
                        </motion.span>
                      ) : (
                        <ChevronDownIcon size={12} />
                      )}
                    </span>
                  )}
                </button>

                {item.id === 'hilos' &&
                  !collapsed &&
                  (mode === 'animate' ? (
                    <AnimatePresence initial={false}>
                      {treeOpen && (
                        <motion.ul
                          id={`${base}-threads`}
                          className="p2-sidebar__nested"
                          role="group"
                          aria-label="Hilos del workspace"
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
                          {NESTED_THREADS.map((thread) => (
                            <li key={thread.id}>
                              <button
                                type="button"
                                className={`p2-side-child${
                                  active === thread.id ? ' is-active' : ''
                                }`}
                                aria-current={active === thread.id ? 'page' : undefined}
                                onClick={() => onSelect(thread.id)}
                              >
                                {mode === 'animate' && active === thread.id && (
                                  <motion.span
                                    layoutId="p2-side-child-highlight"
                                    className="p2-side-highlight"
                                    initial={false}
                                    transition={
                                      reduce ? tokens.tweens.instant : tokens.springs.highlight
                                    }
                                    aria-hidden="true"
                                  />
                                )}
                                <SideLabel mode={mode} collapsed={false}>
                                  {thread.label}
                                </SideLabel>
                              </button>
                            </li>
                          ))}
                        </motion.ul>
                      )}
                    </AnimatePresence>
                  ) : (
                    treeOpen && (
                      <ul
                        id={`${base}-threads`}
                        className="p2-sidebar__nested"
                        role="group"
                        aria-label="Hilos del workspace"
                      >
                        {NESTED_THREADS.map((thread) => (
                          <li key={thread.id}>
                            <button
                              type="button"
                              className={`p2-side-child${
                                active === thread.id ? ' is-active' : ''
                              }`}
                              aria-current={active === thread.id ? 'page' : undefined}
                              onClick={() => onSelect(thread.id)}
                            >
                              {thread.label}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )
                  ))}
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="p2-sidebar__footer">
        <span className="p2-avatar" aria-hidden="true">
          MP
        </span>
        <div className="p2-sidebar__footer-copy">
          <SideLabel mode={mode} collapsed={collapsed}>
            Marina P.
          </SideLabel>
          <SideLabel mode={mode} collapsed={collapsed} className="p2-sidebar__plan">
            Plan Pro
          </SideLabel>
        </div>
      </div>
    </>
  );

  return (
    <div className="p2-sidebar-demo">
      {mode === 'kite' ? (
        <aside
          className={`p2-sidebar p2-sidebar--kite${collapsed ? ' is-collapsed' : ''}`}
          style={{ width: sidebarWidth }}
          aria-label="Barra lateral del workspace"
        >
          {body}
        </aside>
      ) : (
        <motion.aside
          className={`p2-sidebar${collapsed ? ' is-collapsed' : ''}`}
          initial={false}
          animate={{ width: sidebarWidth }}
          transition={reduce ? tokens.tweens.instant : tokens.tweens.panelIn}
          aria-label="Barra lateral del workspace"
        >
          {body}
        </motion.aside>
      )}

      <div className="p2-sidebar-main">
        <span className="p2-subhead">Vista activa</span>
        <strong className="p2-sidebar-main__title">{activeLabel}</strong>
        <p>
          La barra conserva el estado al colapsar. Las etiquetas se desvanecen y el contenido
          principal ocupa el ancho liberado.
        </p>
        <div className="p2-sidebar-main__order" aria-live="polite">
          Orden: {favorites.map((id) => FAVORITES[id]).join(' · ')}
        </div>
        <div className="p2-sidebar-main__hint">
          Arrastrá un favorito o usá <kbd className="p2-kbd">Alt</kbd> +{' '}
          <kbd className="p2-kbd">↑</kbd>/<kbd className="p2-kbd">↓</kbd>. Las dos columnas
          comparten el orden.
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 3 — Menus                                                                  */
/* -------------------------------------------------------------------------- */

type MenuEntry =
  | { kind: 'separator'; id: string }
  | { kind: 'action'; id: string; label: string; danger?: boolean; hint?: string }
  | { kind: 'check'; id: string; label: string; checked: boolean }
  | { kind: 'submenu'; id: string; label: string; items: { id: string; label: string }[] };

type MenubarId = 'archivo' | 'editar';

interface MenuPanelProps {
  mode: CompareVariant;
  entries: MenuEntry[];
  onAction: (id: string) => void;
  onToggleCheck: (id: string) => void;
  onRequestClose: (restoreFocus: boolean) => void;
  autoFocus: boolean;
}

function Submenu({
  mode,
  items,
  labelledBy,
  autoFocus,
  onPick,
  onBack,
}: {
  mode: CompareVariant;
  items: { id: string; label: string }[];
  labelledBy: string;
  autoFocus: boolean;
  onPick: (id: string) => void;
  onBack: () => void;
}) {
  const tokens = useLabMotion();
  const reduce = useLabReduce();
  const highlightKey = useId();
  const [hovered, setHovered] = useState<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (!autoFocus) return;
    itemRefs.current.get(items[0]?.id)?.focus();
    // Focus only when the submenu is opened from the keyboard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  const move = (delta: number) => {
    const index = items.findIndex((item) => itemRefs.current.get(item.id) === document.activeElement);
    const next = (index + delta + items.length) % items.length;
    itemRefs.current.get(items[next]?.id)?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Escape' || event.key === 'ArrowLeft' || event.key === 'Tab') {
      event.preventDefault();
      onBack();
    }
  };

  const rows = items.map((item) => (
    <button
      key={item.id}
      ref={(node) => {
        if (node) itemRefs.current.set(item.id, node);
        else itemRefs.current.delete(item.id);
      }}
      type="button"
      role="menuitem"
      tabIndex={-1}
      className="cmp-menu__item"
      onPointerEnter={() => setHovered(item.id)}
      onFocus={() => setHovered(item.id)}
      onClick={() => onPick(item.id)}
    >
      {mode === 'animate' && hovered === item.id && (
        <motion.span
          layoutId={`p2-submenu-highlight-${highlightKey}`}
          className="cmp-menu__highlight"
          initial={false}
          transition={reduce ? tokens.tweens.instant : tokens.springs.highlight}
          aria-hidden="true"
        />
      )}
      <span className="cmp-menu__label">{item.label}</span>
    </button>
  ));

  if (mode === 'kite') {
    return (
      <div
        className="cmp-menu p2-submenu p2-menu--kite"
        role="menu"
        aria-labelledby={labelledBy}
        onKeyDown={handleKeyDown}
      >
        {rows}
      </div>
    );
  }

  return (
    <motion.div
      className="cmp-menu p2-submenu p2-menu--animate"
      role="menu"
      aria-labelledby={labelledBy}
      onKeyDown={handleKeyDown}
      initial={{ opacity: 0, scale: reduce ? 1 : tokens.scale.menu }}
      animate={{ opacity: 1, scale: 1, transition: tokens.tweens.menu }}
      style={{ transformOrigin: 'top left' }}
    >
      {rows}
    </motion.div>
  );
}

function MenuPanel({
  mode,
  entries,
  onAction,
  onToggleCheck,
  onRequestClose,
  autoFocus,
}: MenuPanelProps) {
  const tokens = useLabMotion();
  const reduce = useLabReduce();
  const canHover = useCanHover();
  const highlightKey = useId();
  const [hovered, setHovered] = useState<string | null>(null);
  const [submenu, setSubmenu] = useState<{ id: string; focusFirst: boolean } | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());

  const focusables = entries.filter((entry) => entry.kind !== 'separator');

  useEffect(() => {
    if (!autoFocus) return;
    const first = focusables[0];
    if (first) itemRefs.current.get(first.id)?.focus();
    // The menu mounts (or remounts) when it opens; focus once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  const focusItem = (index: number) => {
    const entry = focusables[index];
    if (entry) itemRefs.current.get(entry.id)?.focus();
  };

  const closeSubmenu = () => {
    if (!submenu) return;
    const trigger = itemRefs.current.get(submenu.id);
    setSubmenu(null);
    trigger?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('.p2-submenu')) return;

    const current = focusables.findIndex(
      (entry) => itemRefs.current.get(entry.id) === document.activeElement
    );

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = current < 0 ? 0 : (current + delta + focusables.length) % focusables.length;
      focusItem(next);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusItem(event.key === 'Home' ? 0 : focusables.length - 1);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (submenu) closeSubmenu();
      else onRequestClose(true);
      return;
    }
    if (event.key === 'Tab') {
      onRequestClose(false);
      return;
    }
    if (event.key === 'ArrowRight') {
      const entry = focusables[current];
      if (entry?.kind === 'submenu') {
        event.preventDefault();
        setSubmenu({ id: entry.id, focusFirst: true });
      }
      return;
    }
    if (event.key === 'ArrowLeft' && submenu) {
      event.preventDefault();
      closeSubmenu();
    }
  };

  const choose = (id: string) => {
    onAction(id);
    onRequestClose(true);
  };

  return (
    <div
      className="p2-menu-panel"
      role="none"
      onKeyDown={handleKeyDown}
      onPointerLeave={() => {
        setHovered(null);
        setSubmenu(null);
      }}
    >
      {entries.map((entry) => {
        if (entry.kind === 'separator') {
          return <div key={entry.id} className="p2-menu__sep" role="separator" />;
        }

        if (entry.kind === 'submenu') {
          return (
            <div
              key={entry.id}
              className="p2-sub-wrap"
              role="none"
              onPointerEnter={
                canHover
                  ? () => {
                      setHovered(entry.id);
                      setSubmenu((current) =>
                        current?.id === entry.id ? current : { id: entry.id, focusFirst: false }
                      );
                    }
                  : undefined
              }
            >
              <button
                id={`${highlightKey}-${entry.id}`}
                ref={(node) => {
                  if (node) itemRefs.current.set(entry.id, node);
                  else itemRefs.current.delete(entry.id);
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-haspopup="menu"
                aria-expanded={submenu?.id === entry.id}
                className="cmp-menu__item"
                onPointerEnter={() => setHovered(entry.id)}
                onFocus={() => setHovered(entry.id)}
                onClick={() =>
                  setSubmenu((current) =>
                    current?.id === entry.id ? null : { id: entry.id, focusFirst: true }
                  )
                }
              >
                {mode === 'animate' && hovered === entry.id && (
                  <motion.span
                    layoutId={`p2-menu-highlight-${highlightKey}`}
                    className="cmp-menu__highlight"
                    initial={false}
                    transition={reduce ? tokens.tweens.instant : tokens.springs.highlight}
                    aria-hidden="true"
                  />
                )}
                <span className="cmp-menu__label">{entry.label}</span>
                <span className="p2-menu-item__chevron" aria-hidden="true">
                  <ChevronDownIcon size={11} />
                </span>
              </button>
              {submenu?.id === entry.id && (
                <Submenu
                  mode={mode}
                  items={entry.items}
                  labelledBy={`${highlightKey}-${entry.id}`}
                  onPick={choose}
                  onBack={closeSubmenu}
                  autoFocus={submenu.focusFirst}
                />
              )}
            </div>
          );
        }

        const isCheck = entry.kind === 'check';
        return (
          <button
            key={entry.id}
            ref={(node) => {
              if (node) itemRefs.current.set(entry.id, node);
              else itemRefs.current.delete(entry.id);
            }}
            type="button"
            role={isCheck ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={isCheck ? entry.checked : undefined}
            tabIndex={-1}
            className={`cmp-menu__item${entry.kind === 'action' && entry.danger ? ' cmp-menu__item--danger' : ''}`}
            onPointerEnter={
              canHover
                ? () => {
                    setHovered(entry.id);
                    setSubmenu(null);
                  }
                : undefined
            }
            onFocus={() => setHovered(entry.id)}
            onClick={() => {
              if (entry.kind === 'check') onToggleCheck(entry.id);
              else choose(entry.id);
            }}
          >
            {mode === 'animate' && hovered === entry.id && (
              <motion.span
                layoutId={`p2-menu-highlight-${highlightKey}`}
                className="cmp-menu__highlight"
                initial={false}
                transition={reduce ? tokens.tweens.instant : tokens.springs.highlight}
                aria-hidden="true"
              />
            )}
            {isCheck && (
              <span className={`p2-menu-item__check${entry.checked ? ' is-checked' : ''}`}>
                {mode === 'animate' && entry.checked ? (
                  <motion.span
                    initial={{ opacity: 0, scale: reduce ? 1 : tokens.scale.icon }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={reduce ? tokens.tweens.instant : tokens.tweens.swap}
                  >
                    <CheckIcon size={11} />
                  </motion.span>
                ) : (
                  <CheckIcon size={11} />
                )}
              </span>
            )}
            <span className="cmp-menu__label">{entry.label}</span>
            {entry.kind === 'action' && entry.hint && (
              <span className="p2-menu-item__hint">{entry.hint}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

interface MenuSurfaceProps {
  mode: CompareVariant;
  open: boolean;
  entries: MenuEntry[];
  onAction: (id: string) => void;
  onToggleCheck: (id: string) => void;
  onClose: () => void;
  onRestoreFocus: () => void;
  autoFocus: boolean;
  labelledBy: string;
  className?: string;
  style?: CSSProperties;
  surfaceId?: string;
  layoutId?: string;
  contentKey?: string;
  handoffDirection?: Direction;
  animateContent?: boolean;
}

function MenuSurface({
  mode,
  open,
  entries,
  onAction,
  onToggleCheck,
  onClose,
  onRestoreFocus,
  autoFocus,
  labelledBy,
  className = '',
  style,
  surfaceId,
  layoutId,
  contentKey,
  handoffDirection = 1,
  animateContent = false,
}: MenuSurfaceProps) {
  const tokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);
  const classes = `cmp-menu p2-menu p2-menu--${mode} ${className}`.trim();

  const requestClose = (restoreFocus: boolean) => {
    onClose();
    if (restoreFocus) window.requestAnimationFrame(onRestoreFocus);
  };

  const panel = (
    <MenuPanel
      mode={mode}
      entries={entries}
      onAction={onAction}
      onToggleCheck={onToggleCheck}
      onRequestClose={requestClose}
      autoFocus={autoFocus}
    />
  );

  const content =
    animateContent && mode === 'animate' ? (
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={contentKey ?? 'menu'}
          className="p2-menu-content"
          role="none"
          initial={{
            opacity: 0,
            x: reduce ? 0 : handoffDirection * tokens.shift.handoff,
          }}
          animate={{ opacity: 1, x: 0, transition: tokens.tweens.fade }}
          exit={{
            opacity: 0,
            x: reduce ? 0 : -handoffDirection * tokens.shift.handoff,
            transition: tokens.tweens.fade,
          }}
        >
          {panel}
        </motion.div>
      </AnimatePresence>
    ) : (
      panel
    );

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div
        id={surfaceId}
        className={`${classes} ${motionSurfaceClass(presence.phase, 'popover')}`}
        style={style}
        role="menu"
        aria-labelledby={labelledBy}
      >
        {content}
      </div>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          id={surfaceId}
          className={classes}
          style={{ transformOrigin: 'top left', ...style }}
          role="menu"
          aria-labelledby={labelledBy}
          layoutId={layoutId}
          transition={layoutId ? tokens.springs.selection : undefined}
          initial={{ opacity: 0, scale: reduce ? 1 : tokens.scale.menu }}
          animate={{ opacity: 1, scale: 1, transition: tokens.tweens.menu }}
          exit={{
            opacity: 0,
            scale: reduce ? 1 : tokens.scale.menu,
            transition: tokens.tweens.dismiss,
          }}
        >
          {content}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const MENU_ACTION_LABELS: Record<string, string> = {
  'drop-open': 'Hilo abierto',
  'drop-duplicate': 'Hilo duplicado',
  'drop-rename': 'Renombrar hilo',
  'drop-export-md': 'Exportado a Markdown',
  'drop-export-pdf': 'Exportado a PDF',
  'drop-archive': 'Hilo archivado',
  'ctx-open': 'Archivo abierto',
  'ctx-copy': 'Ruta copiada',
  'ctx-reveal': 'Mostrado en el árbol',
  'ctx-delete': 'Archivo eliminado del índice',
  'bar-new': 'Archivo nuevo',
  'bar-open': 'Archivo abierto',
  'bar-save': 'Archivo guardado',
  'bar-undo': 'Deshacer',
  'bar-redo': 'Rehacer',
  'bar-find': 'Buscar en el archivo',
};

const MENUBAR_ENTRIES: Record<MenubarId, MenuEntry[]> = {
  archivo: [
    { kind: 'action', id: 'bar-new', label: 'Nuevo archivo', hint: 'Ctrl N' },
    { kind: 'action', id: 'bar-open', label: 'Abrir…', hint: 'Ctrl O' },
    { kind: 'action', id: 'bar-save', label: 'Guardar', hint: 'Ctrl S' },
  ],
  editar: [
    { kind: 'action', id: 'bar-undo', label: 'Deshacer', hint: 'Ctrl Z' },
    { kind: 'action', id: 'bar-redo', label: 'Rehacer', hint: 'Ctrl Y' },
    { kind: 'action', id: 'bar-find', label: 'Buscar en el archivo', hint: 'Ctrl F' },
  ],
};

interface MenusPaneProps {
  mode: CompareVariant;
  dropdownOpen: boolean;
  dropdownNotify: boolean;
  contextMenu: { open: boolean; x: number; y: number };
  menubar: { menu: MenubarId | null; direction: Direction };
  lastAction: string;
  onDropdownOpenChange: (open: boolean) => void;
  onDropdownNotifyChange: (checked: boolean) => void;
  onOpenContext: (x: number, y: number) => void;
  onCloseContext: () => void;
  onMenubarChange: (menu: MenubarId | null) => void;
  onAction: (id: string) => void;
}

function MenusPane({
  mode,
  dropdownOpen,
  dropdownNotify,
  contextMenu,
  menubar,
  lastAction,
  onDropdownOpenChange,
  onDropdownNotifyChange,
  onOpenContext,
  onCloseContext,
  onMenubarChange,
  onAction,
}: MenusPaneProps) {
  const base = useId();
  const tokens = useLabMotion();
  const reduce = useLabReduce();
  const canHover = useCanHover();
  const [dropdownAutoFocus, setDropdownAutoFocus] = useMenuAutoFocus(dropdownOpen);
  const [contextAutoFocus, setContextAutoFocus] = useMenuAutoFocus(contextMenu.open);
  const [menubarAutoFocus, setMenubarAutoFocus] = useMenuAutoFocus(menubar.menu !== null);
  const [hoveredMenubar, setHoveredMenubar] = useState<MenubarId | null>(null);
  const dropdownTrigger = useRef<HTMLSpanElement>(null);
  const contextStage = useRef<HTMLDivElement>(null);
  const contextTarget = useRef<HTMLSpanElement>(null);
  const menubarRefs = useRef<Record<MenubarId, HTMLSpanElement | null>>({
    archivo: null,
    editar: null,
  });

  const dropdownTriggerId = `${base}-dropdown-trigger`;
  const contextTriggerId = `${base}-context-trigger`;
  const menubarIds: Record<MenubarId, string> = {
    archivo: `${base}-menubar-archivo`,
    editar: `${base}-menubar-editar`,
  };

  const dropdownEntries: MenuEntry[] = [
    { kind: 'action', id: 'drop-open', label: 'Abrir hilo', hint: '↵' },
    { kind: 'action', id: 'drop-duplicate', label: 'Duplicar' },
    { kind: 'action', id: 'drop-rename', label: 'Renombrar' },
    { kind: 'separator', id: 'drop-sep-1' },
    {
      kind: 'submenu',
      id: 'drop-export',
      label: 'Exportar',
      items: [
        { id: 'drop-export-md', label: 'Markdown' },
        { id: 'drop-export-pdf', label: 'PDF' },
      ],
    },
    {
      kind: 'check',
      id: 'drop-notify',
      label: 'Notificaciones',
      checked: dropdownNotify,
    },
    { kind: 'separator', id: 'drop-sep-2' },
    { kind: 'action', id: 'drop-archive', label: 'Archivar hilo', danger: true },
  ];

  const contextEntries: MenuEntry[] = [
    { kind: 'action', id: 'ctx-open', label: 'Abrir archivo' },
    { kind: 'action', id: 'ctx-copy', label: 'Copiar ruta' },
    { kind: 'action', id: 'ctx-reveal', label: 'Mostrar en el árbol' },
    { kind: 'separator', id: 'ctx-sep' },
    { kind: 'action', id: 'ctx-delete', label: 'Quitar del índice', danger: true },
  ];

  const focusDropdownTrigger = () =>
    dropdownTrigger.current?.querySelector<HTMLButtonElement>('button')?.focus();
  const focusContextTrigger = () =>
    contextTarget.current?.querySelector<HTMLButtonElement>('button')?.focus();
  const focusMenubarTrigger = (id: MenubarId) =>
    menubarRefs.current[id]?.querySelector<HTMLButtonElement>('button')?.focus();

  const openContextAt = (x: number, y: number) => {
    setContextAutoFocus(true);
    onOpenContext(x, y);
  };

  const contextPoint = (clientX: number, clientY: number, height: number) => {
    const rect = contextStage.current?.getBoundingClientRect();
    if (!rect) return { x: 16, y: 16 };
    return {
      x: clamp(clientX - rect.left, 8, Math.max(8, rect.width - 188)),
      y: clamp(clientY - rect.top, 8, Math.max(8, height - 12)),
    };
  };

  const toggleDropdown = () => {
    if (dropdownOpen) {
      onDropdownOpenChange(false);
      return;
    }
    setDropdownAutoFocus(true);
    onDropdownOpenChange(true);
  };

  const menubarMenu = menubar.menu;
  const activeMenubarId = menubarMenu ?? 'archivo';

  return (
    <div className="p2-stage p2-menus-demo">
      <div className="p2-menus-grid">
        <div className="p2-block">
          <div className="p2-subhead">
            Dropdown <span>submenú + check</span>
          </div>
          <div className="p2-anchor">
            <span ref={dropdownTrigger} className="p2-ref">
              <SceneButton
                id={dropdownTriggerId}
                mode={mode}
                onClick={toggleDropdown}
                aria-haspopup="menu"
                aria-expanded={dropdownOpen}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && dropdownOpen) {
                    event.preventDefault();
                    onDropdownOpenChange(false);
                    return;
                  }
                  if (event.key !== 'ArrowDown') return;
                  event.preventDefault();
                  if (!dropdownOpen) {
                    setDropdownAutoFocus(true);
                    onDropdownOpenChange(true);
                  } else {
                    focusFirstIn(document.getElementById(`${base}-dropdown-menu`));
                  }
                }}
              >
                Acciones
                <ChevronDownIcon size={11} />
              </SceneButton>
            </span>
            <MenuSurface
              mode={mode}
              open={dropdownOpen}
              entries={dropdownEntries}
              onAction={onAction}
              onToggleCheck={(id) => {
                if (id === 'drop-notify') onDropdownNotifyChange(!dropdownNotify);
              }}
              onClose={() => onDropdownOpenChange(false)}
              onRestoreFocus={focusDropdownTrigger}
              autoFocus={dropdownAutoFocus}
              labelledBy={dropdownTriggerId}
              surfaceId={`${base}-dropdown-menu`}
              className="p2-dropdown-menu"
              style={{ top: 'calc(100% + 6px)', left: 0, right: 'auto' }}
            />
          </div>
          <p className="p2-menu-status" role="status">
            {lastAction}
          </p>
        </div>

        <div className="p2-block">
          <div className="p2-subhead">
            Context menu <span>clic derecho</span>
          </div>
          <div
            className="p2-context-stage"
            ref={contextStage}
            onContextMenu={(event) => {
              event.preventDefault();
              const rect = contextStage.current?.getBoundingClientRect();
              if (!rect) return;
              const point = contextPoint(event.clientX, event.clientY, rect.height);
              openContextAt(point.x, point.y);
            }}
          >
            <div className="p2-context-file">
              <span className="p2-context-file__badge" aria-hidden="true">
                TS
              </span>
              <div>
                <strong>contract.ts</strong>
                <span>src/motion/contract.ts</span>
              </div>
            </div>
            <span ref={contextTarget} className="p2-ref">
              <SceneButton
                id={contextTriggerId}
                mode={mode}
                variant="ghost"
                className="cmp-btn--sm"
                aria-haspopup="menu"
                aria-expanded={contextMenu.open}
                onClick={() => {
                  const rect = contextStage.current?.getBoundingClientRect();
                  if (!rect) return;
                  openContextAt(16, 62);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && contextMenu.open) {
                    event.preventDefault();
                    onCloseContext();
                    return;
                  }
                  if (!(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
                    return;
                  }
                  event.preventDefault();
                  const rect = contextStage.current?.getBoundingClientRect();
                  if (!rect) return;
                  openContextAt(16, 62);
                }}
              >
                Abrir menú contextual
              </SceneButton>
            </span>
            <span className="p2-context-hint">Clic derecho · Shift+F10</span>
            <MenuSurface
              mode={mode}
              open={contextMenu.open}
              entries={contextEntries}
              onAction={onAction}
              onToggleCheck={() => undefined}
              onClose={onCloseContext}
              onRestoreFocus={focusContextTrigger}
              autoFocus={contextAutoFocus}
              labelledBy={contextTriggerId}
              surfaceId={`${base}-context-menu`}
              className="p2-context-menu"
              style={{ top: contextMenu.y, left: contextMenu.x, right: 'auto' }}
            />
          </div>
        </div>
      </div>

      <div className="p2-menubar-block">
        <div className="p2-subhead">
          Menubar <span>handoff entre dos menús</span>
        </div>
        <div
          className={`p2-menubar${menubarMenu ? ' is-open' : ''}`}
          onPointerLeave={() => setHoveredMenubar(null)}
        >
          <div className="p2-menubar__bar" role="menubar" aria-label="Menú del editor">
            {(['archivo', 'editar'] as const).map((id) => {
              const isOpen = menubarMenu === id;
              const lit = isOpen || hoveredMenubar === id;
              return (
                <span
                  key={id}
                  ref={(node) => {
                    menubarRefs.current[id] = node;
                  }}
                  className="p2-ref"
                  role="none"
                >
                  <button
                    type="button"
                    role="menuitem"
                    id={menubarIds[id]}
                    className={`p2-menubar__trigger${isOpen ? ' is-open' : ''}`}
                    aria-haspopup="menu"
                    aria-expanded={isOpen}
                    onPointerEnter={
                      canHover
                        ? () => {
                            setHoveredMenubar(id);
                            if (menubarMenu && menubarMenu !== id) {
                              setMenubarAutoFocus(false);
                              onMenubarChange(id);
                            }
                          }
                        : undefined
                    }
                    onFocus={() => setHoveredMenubar(id)}
                    onBlur={() => setHoveredMenubar(null)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape' && menubarMenu) {
                        event.preventDefault();
                        onMenubarChange(null);
                        return;
                      }
                      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                        event.preventDefault();
                        const other: MenubarId = id === 'archivo' ? 'editar' : 'archivo';
                        focusMenubarTrigger(other);
                        if (menubarMenu) {
                          setMenubarAutoFocus(true);
                          onMenubarChange(other);
                        }
                        return;
                      }
                      if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        if (menubarMenu === id) {
                          focusFirstIn(document.getElementById(`${base}-menubar-menu`));
                        } else {
                          setMenubarAutoFocus(true);
                          onMenubarChange(id);
                        }
                      }
                    }}
                    onClick={() => {
                      if (menubarMenu === id) {
                        onMenubarChange(null);
                      } else {
                        setMenubarAutoFocus(true);
                        onMenubarChange(id);
                      }
                    }}
                  >
                    {lit && mode === 'animate' && (
                      <motion.span
                        layoutId="p2-menubar-trigger-highlight"
                        className="p2-menubar__highlight"
                        initial={false}
                        transition={reduce ? tokens.tweens.instant : tokens.springs.highlight}
                        aria-hidden="true"
                      />
                    )}
                    <span className="p2-menubar__label">
                      {id === 'archivo' ? 'Archivo' : 'Editar'}
                    </span>
                  </button>
                </span>
              );
            })}
          </div>

          <MenuSurface
            mode={mode}
            open={menubarMenu !== null}
            entries={MENUBAR_ENTRIES[activeMenubarId]}
            onAction={onAction}
            onToggleCheck={() => undefined}
            onClose={() => onMenubarChange(null)}
            onRestoreFocus={() => focusMenubarTrigger(activeMenubarId)}
            autoFocus={menubarAutoFocus}
            labelledBy={menubarIds[activeMenubarId]}
            surfaceId={`${base}-menubar-menu`}
            layoutId={mode === 'animate' ? 'p2-menubar-popover' : undefined}
            contentKey={activeMenubarId}
            handoffDirection={menubar.direction}
            animateContent
            className="p2-menubar__menu"
            style={{ top: 'calc(100% + 6px)', left: activeMenubarId === 'editar' ? 84 : 0, right: 'auto' }}
          />
        </div>
        <p className="p2-menu-status">{lastAction}</p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 4 — Command palette                                                        */
/* -------------------------------------------------------------------------- */

interface PaletteCommand {
  id: string;
  label: string;
  group: string;
  hint: string;
}

const PALETTE_COMMANDS: readonly PaletteCommand[] = [
  { id: 'pal-settings', label: 'Abrir ajustes', group: 'Navegación', hint: 'Ctrl ,' },
  { id: 'pal-new-thread', label: 'Nuevo hilo', group: 'Acciones', hint: 'Ctrl N' },
  { id: 'pal-search', label: 'Buscar archivo', group: 'Navegación', hint: 'Ctrl P' },
  { id: 'pal-theme', label: 'Cambiar tema', group: 'Apariencia', hint: 'Ctrl J' },
  { id: 'pal-archive', label: 'Archivar hilo', group: 'Acciones', hint: '' },
  { id: 'pal-shortcuts', label: 'Ver atajos', group: 'Ayuda', hint: '?' },
  { id: 'pal-models', label: 'Cambiar modelo', group: 'Modelos', hint: 'Ctrl M' },
];

function filterCommands(query: string): readonly PaletteCommand[] {
  const needle = query.trim().toLocaleLowerCase('es');
  if (!needle) return PALETTE_COMMANDS;
  return PALETTE_COMMANDS.filter(
    (command) =>
      command.label.toLocaleLowerCase('es').includes(needle) ||
      command.group.toLocaleLowerCase('es').includes(needle)
  );
}

interface PalettePaneProps {
  mode: CompareVariant;
  open: boolean;
  query: string;
  activeId: string | null;
  result: string | null;
  onOpen: () => void;
  onClose: () => void;
  onQuery: (value: string) => void;
  onMove: (delta: number) => void;
  onHighlight: (id: string) => void;
  onSelect: (id: string | null) => void;
}

function PalettePane({
  mode,
  open,
  query,
  activeId,
  result,
  onOpen,
  onClose,
  onQuery,
  onMove,
  onHighlight,
  onSelect,
}: PalettePaneProps) {
  const tokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);
  const base = useId();
  const [autoFocus, setAutoFocus] = useMenuAutoFocus(open);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const filtered = filterCommands(query);
  const triggerId = `${base}-palette-trigger`;
  const listId = `${base}-palette-list`;
  const mounted = mode === 'kite' ? presence.mounted : open;

  useEffect(() => {
    if (mounted && autoFocus) inputRef.current?.focus();
  }, [mounted, autoFocus]);

  const closePalette = () => {
    const restore = autoFocus;
    onClose();
    if (restore) {
      window.requestAnimationFrame(() =>
        triggerRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
      );
    }
  };

  const openPalette = () => {
    setAutoFocus(true);
    onOpen();
  };

  const chooseCommand = (id: string | null) => {
    const restore = autoFocus;
    onSelect(id);
    if (restore) {
      window.requestAnimationFrame(() =>
        triggerRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
      );
    }
  };

  const handlePanelKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closePalette();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      onMove(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter' && event.target === inputRef.current) {
      event.preventDefault();
      chooseCommand(activeId);
      return;
    }
    if (event.key !== 'Tab') return;
    const nodes = panelRef.current?.querySelectorAll<HTMLElement>('input, button:not([tabindex="-1"])');
    if (!nodes || nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const panelBody = (
    <>
      <div className="p2-palette__search">
        <span className="p2-palette__search-icon" aria-hidden="true">
          <SearchGlyph />
        </span>
        <input
          ref={inputRef}
          className="p2-palette__input"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Buscar comandos…"
          role="combobox"
          aria-label="Buscar comandos"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeId ? `${base}-${activeId}` : undefined}
        />
        <SceneButton
          mode={mode}
          variant="ghost"
          className="cmp-btn--icon"
          aria-label="Cerrar paleta"
          onClick={closePalette}
        >
          <CloseIcon size={12} />
        </SceneButton>
      </div>

      <div
        id={listId}
        className="p2-palette__list"
        role="listbox"
        aria-label="Comandos disponibles"
      >
        {filtered.length === 0 ? (
          <div className="p2-palette__empty">Sin resultados para “{query}”.</div>
        ) : (
          filtered.map((command) => {
            const isActive = command.id === activeId;
            return (
              <button
                key={command.id}
                id={`${base}-${command.id}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={isActive}
                className={`p2-palette__item${isActive ? ' is-active' : ''}`}
                onPointerEnter={() => {
                  if (!isActive) onHighlight(command.id);
                }}
                onClick={() => chooseCommand(command.id)}
              >
                {mode === 'animate' && isActive && (
                  <motion.span
                    layoutId={`p2-palette-highlight-${base}`}
                    className="p2-palette__highlight"
                    initial={false}
                    transition={reduce ? tokens.tweens.instant : tokens.springs.highlight}
                    aria-hidden="true"
                  />
                )}
                <span className="p2-palette__label">{command.label}</span>
                <span className="p2-palette__group">{command.group}</span>
                {command.hint && <kbd className="p2-kbd">{command.hint}</kbd>}
              </button>
            );
          })
        )}
      </div>

      <div className="p2-palette__foot">
        <span>
          <kbd className="p2-kbd">↑</kbd> <kbd className="p2-kbd">↓</kbd> navegar
        </span>
        <span>
          <kbd className="p2-kbd">Enter</kbd> ejecutar
        </span>
        <span>
          <kbd className="p2-kbd">Esc</kbd> cerrar
        </span>
      </div>
    </>
  );

  const triggerBar = (
    <div className="p2-palette-stage__bar">
      <span ref={triggerRef} className="p2-ref">
        <SceneButton
          id={triggerId}
          mode={mode}
          variant={open ? 'default' : 'primary'}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-keyshortcuts="Control+K"
          onClick={openPalette}
        >
          Abrir paleta
        </SceneButton>
      </span>
      <span className="p2-palette-stage__shortcut">
        <kbd className="p2-kbd">Ctrl</kbd>
        <kbd className="p2-kbd">K</kbd>
      </span>
      <span className="p2-palette-stage__result" role="status">
        {result ? `Última: ${result}` : 'Sin selección'}
      </span>
    </div>
  );

  return (
    <div
      className="p2-palette-stage"
      onKeyDown={(event) => {
        if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
        event.preventDefault();
        openPalette();
      }}
    >
      <div className="p2-palette-stage__bg" aria-hidden="true">
        <div className="p2-palette-stage__line is-wide" />
        <div className="p2-palette-stage__line" />
        <div className="p2-palette-stage__line is-short" />
      </div>

      {triggerBar}

      {mode === 'kite' ? (
        presence.mounted && (
          <div className="p2-palette-layer">
            <div
              className={`cmp-scrim ${motionSurfaceClass(presence.phase, 'scrim')}`}
              onClick={closePalette}
              aria-hidden="true"
            />
            <div
              ref={panelRef}
              className={`p2-palette p2-palette--kite ${motionSurfaceClass(presence.phase, 'popover')}`}
              role="dialog"
              aria-label="Paleta de comandos"
              onKeyDown={handlePanelKeys}
              onClick={(event) => event.stopPropagation()}
            >
              {panelBody}
            </div>
          </div>
        )
      ) : (
        <AnimatePresence>
          {open && (
            <motion.div
              key="palette-layer"
              className="p2-palette-layer p2-palette-layer--animate"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: tokens.tweens.menu }}
              exit={{ opacity: 0, transition: tokens.tweens.menu }}
              onClick={closePalette}
            >
              <motion.div
                ref={panelRef}
                className="p2-palette"
                role="dialog"
                aria-label="Paleta de comandos"
                onKeyDown={handlePanelKeys}
                onClick={(event) => event.stopPropagation()}
                initial={{ opacity: 0, scale: reduce ? 1 : tokens.scale.menu }}
                animate={{ opacity: 1, scale: 1, transition: tokens.tweens.menu }}
                exit={{ opacity: 0, scale: reduce ? 1 : tokens.scale.menu, transition: tokens.tweens.menu }}
                style={{ transformOrigin: 'center' }}
              >
                {panelBody}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 5 — Accordion, pagination, tooltip                                         */
/* -------------------------------------------------------------------------- */

function Disclosure({
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

const ACCORDION_ITEMS: readonly { id: string; title: string; body: string; meta: string }[] = [
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

const PAGE_COUNT = 5;
const PAGE_WIDTH = 28;

interface DisclosurePaneProps {
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

function DisclosurePane({
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

function TooltipBubble({
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

/* -------------------------------------------------------------------------- */
/* 6 — Dock / resizable panel                                                 */
/* -------------------------------------------------------------------------- */

const DOCK_PRESETS = [160, 240, 320] as const;
const DOCK_MIN = 150;
const DOCK_MAX = 340;

function snapDockWidth(width: number): number {
  let nearest: number = DOCK_PRESETS[0];
  for (const preset of DOCK_PRESETS) {
    if (Math.abs(preset - width) < Math.abs(nearest - width)) nearest = preset;
  }
  return Math.abs(nearest - width) <= 28 ? nearest : Math.round(width);
}

interface DockPaneProps {
  mode: CompareVariant;
  open: boolean;
  width: number;
  onOpenChange: (open: boolean) => void;
  onWidth: (width: number) => void;
}

function DockPane({ mode, open, width, onOpenChange, onWidth }: DockPaneProps) {
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

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export function NavigationPage({ view }: { view: CompareView }) {
  const [hTab, setHTab] = useState<{ id: HTabId; direction: Direction }>({
    id: 'general',
    direction: 1,
  });
  const [vTab, setVTab] = useState<{ id: VTabId; direction: Direction }>({
    id: 'hilos',
    direction: 1,
  });

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarActive, setSidebarActive] = useState('hilos');
  const [treeOpen, setTreeOpen] = useState(true);
  const [favorites, setFavorites] = useState<FavoriteId[]>([
    'fav-hilos',
    'fav-archivos',
    'fav-notas',
  ]);

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownNotify, setDropdownNotify] = useState(true);
  const [contextMenu, setContextMenu] = useState({ open: false, x: 16, y: 16 });
  const [menubar, setMenubar] = useState<{ menu: MenubarId | null; direction: Direction }>({
    menu: null,
    direction: 1,
  });
  const [lastAction, setLastAction] = useState('Sin acciones todavía');

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteActiveId, setPaletteActiveId] = useState<string | null>(null);
  const [paletteResult, setPaletteResult] = useState<string | null>(null);

  const [sections, setSections] = useState<string[]>(['contexto']);
  const [nestedOpen, setNestedOpen] = useState(false);
  const [page, setPage] = useState(2);
  const [tooltipFor, setTooltipFor] = useState<string | null>(null);

  const [dockOpen, setDockOpen] = useState(true);
  const [dockWidth, setDockWidth] = useState(240);

  const selectHTab = (id: HTabId) => {
    const nextIndex = H_TABS.findIndex((tab) => tab.id === id);
    setHTab((current) => {
      const currentIndex = H_TABS.findIndex((tab) => tab.id === current.id);
      return { id, direction: nextIndex >= currentIndex ? 1 : -1 };
    });
  };

  const selectVTab = (id: VTabId) => {
    const nextIndex = V_TABS.findIndex((tab) => tab.id === id);
    setVTab((current) => {
      const currentIndex = V_TABS.findIndex((tab) => tab.id === current.id);
      return { id, direction: nextIndex >= currentIndex ? 1 : -1 };
    });
  };

  const moveFavorite = (id: FavoriteId, delta: number) => {
    setFavorites((current) => {
      const from = current.indexOf(id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const changeMenubar = (menu: MenubarId | null) => {
    setMenubar((current) => {
      if (menu === null) return { menu: null, direction: current.direction };
      if (current.menu === menu) return current;
      const direction: Direction =
        current.menu === null ? 1 : menu === 'editar' ? 1 : -1;
      return { menu, direction };
    });
  };

  const handleMenuAction = (id: string) => {
    setLastAction(MENU_ACTION_LABELS[id] ?? id);
  };

  const openPalette = () => {
    setPaletteOpen(true);
    setPaletteActiveId(filterCommands(paletteQuery)[0]?.id ?? null);
  };

  const changePaletteQuery = (value: string) => {
    setPaletteQuery(value);
    setPaletteActiveId(filterCommands(value)[0]?.id ?? null);
  };

  const movePalette = (delta: number) => {
    const list = filterCommands(paletteQuery);
    if (list.length === 0) {
      setPaletteActiveId(null);
      return;
    }
    const index = list.findIndex((command) => command.id === paletteActiveId);
    const next = index < 0 ? 0 : (index + delta + list.length) % list.length;
    setPaletteActiveId(list[next]?.id ?? null);
  };

  const choosePalette = (id: string | null) => {
    const command = PALETTE_COMMANDS.find((item) => item.id === id);
    if (!command) return;
    setPaletteResult(command.label);
    setPaletteOpen(false);
  };

  const toggleSection = (id: string) => {
    setSections((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  };

  return (
    <div className="p2-page" data-page="02" data-view={view}>
      <RealHeaderSidebarScenes view={view} />

      <CompareScene
        index="2.1"
        title="Tabs y paneles"
        target="TabBar · SettingsTabs · VerticalTabs"
        note="El mismo tab activo en las dos columnas. Kite mueve el indicador con una transición CSS y cambia el panel de golpe; Animate UI lo lleva en spring.selection y encadena panelOut / panelIn con blur. Probá ← →, Home y End."
        view={view}
      >
        {(mode) => (
          <TabsPane
            mode={mode}
            hTab={hTab}
            vTab={vTab}
            onHTab={selectHTab}
            onVTab={selectVTab}
          />
        )}
      </CompareScene>

      <CompareScene
        index="2.2"
        title="Sidebar completa"
        target="Sidebar · SidebarGroup · ThreadTree"
        note="Colapsá la barra, cambiá de sección y arrastrá los favoritos. El highlight activo se desliza en Animate UI; las etiquetas se desvanecen mientras el ancho se cierra. Las dos columnas comparten el estado."
        view={view}
      >
        {(mode) => (
          <SidebarPane
            mode={mode}
            collapsed={sidebarCollapsed}
            active={sidebarActive}
            treeOpen={treeOpen}
            favorites={favorites}
            onToggleCollapse={() => setSidebarCollapsed((value) => !value)}
            onSelect={setSidebarActive}
            onToggleTree={() => setTreeOpen((value) => !value)}
            onFavoritesChange={setFavorites}
            onMoveFavorite={moveFavorite}
          />
        )}
      </CompareScene>

      <CompareScene
        index="2.3"
        title="Menús y menubar"
        target="DropdownMenu · ContextMenu · Menubar"
        note="Abrí el dropdown con el teclado (Enter o ↓), recorré con flechas, abrí el submenú con → y probá el check. El clic derecho abre el menú contextual. En el menubar, pasá de Archivo a Editar con el menú abierto: Animate UI mueve el popover y entrega el contenido."
        view={view}
      >
        {(mode) => (
          <MenusPane
            mode={mode}
            dropdownOpen={dropdownOpen}
            dropdownNotify={dropdownNotify}
            contextMenu={contextMenu}
            menubar={menubar}
            lastAction={lastAction}
            onDropdownOpenChange={setDropdownOpen}
            onDropdownNotifyChange={setDropdownNotify}
            onOpenContext={(x, y) => setContextMenu({ open: true, x, y })}
            onCloseContext={() => setContextMenu((current) => ({ ...current, open: false }))}
            onMenubarChange={changeMenubar}
            onAction={handleMenuAction}
          />
        )}
      </CompareScene>

      <CompareScene
        index="2.4"
        title="Command palette"
        target="CommandPalette · QuickOpen"
        note="Abrí la paleta, filtrá y movete con ↑ ↓. Kite cambia la fila activa de golpe; Animate UI desliza el highlight con spring.highlight. La paleta entra con scale.menu y transition.menu, sin el tilt de un diálogo."
        view={view}
      >
        {(mode) => (
          <PalettePane
            mode={mode}
            open={paletteOpen}
            query={paletteQuery}
            activeId={paletteActiveId}
            result={paletteResult}
            onOpen={openPalette}
            onClose={() => setPaletteOpen(false)}
            onQuery={changePaletteQuery}
            onMove={movePalette}
            onHighlight={setPaletteActiveId}
            onSelect={choosePalette}
          />
        )}
      </CompareScene>

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
    </div>
  );
}
