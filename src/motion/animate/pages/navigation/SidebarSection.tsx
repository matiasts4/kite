import { useId, useState, type ReactNode } from 'react';
import { AnimatePresence, Reorder, motion } from 'motion/react';
import { useLabMotion, useLabReduce } from '../../context';
import { CompareScene, type CompareVariant, type CompareView } from '../../frame';
import { ChevronDownIcon } from '../../ui';
import { GripIcon, NavGlyph, type NavGlyphKind } from './shared';

/* -------------------------------------------------------------------------- */
/* 2 — Sidebar                                                                */
/* -------------------------------------------------------------------------- */

export type SidebarItemId = 'inicio' | 'hilos' | 'archivos' | 'ajustes';
export type NestedThreadId = 'th-refactor' | 'th-motion' | 'th-preview';
export type FavoriteId = 'fav-hilos' | 'fav-archivos' | 'fav-notas';

export const NAV_ITEMS: readonly { id: SidebarItemId; label: string; glyph: NavGlyphKind }[] = [
  { id: 'inicio', label: 'Inicio', glyph: 'home' },
  { id: 'hilos', label: 'Hilos', glyph: 'chat' },
  { id: 'archivos', label: 'Archivos', glyph: 'folder' },
  { id: 'ajustes', label: 'Ajustes', glyph: 'sliders' },
];

export const NESTED_THREADS: readonly { id: NestedThreadId; label: string }[] = [
  { id: 'th-refactor', label: 'Refactor del transcript' },
  { id: 'th-motion', label: 'Motion contract' },
  { id: 'th-preview', label: 'Preview Animate UI' },
];

export const FAVORITES: Record<FavoriteId, string> = {
  'fav-hilos': 'Hilos',
  'fav-archivos': 'Archivos',
  'fav-notas': 'Notas',
};

export const SIDEBAR_LABELS: Record<string, string> = {
  inicio: 'Inicio',
  hilos: 'Hilos',
  archivos: 'Archivos',
  ajustes: 'Ajustes',
  'th-refactor': 'Refactor del transcript',
  'th-motion': 'Motion contract',
  'th-preview': 'Preview Animate UI',
  ...FAVORITES,
};

export function SideLabel({
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

export function FavoriteRow({
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

export interface SidebarPaneProps {
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

export function SidebarPane({
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

export function SidebarSection({ view }: { view: CompareView }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarActive, setSidebarActive] = useState('hilos');
  const [treeOpen, setTreeOpen] = useState(true);
  const [favorites, setFavorites] = useState<FavoriteId[]>([
    'fav-hilos',
    'fav-archivos',
    'fav-notas',
  ]);

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

  return (
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
  );
}
