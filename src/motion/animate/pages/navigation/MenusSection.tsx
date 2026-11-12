import { useId, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { useLabMotion, useLabReduce } from '../../context';
import { CompareScene, SceneButton, type CompareVariant, type CompareView } from '../../frame';
import { ChevronDownIcon } from '../../ui';
import { clamp, focusFirstIn, useCanHover, useMenuAutoFocus, type Direction } from './shared';
import { MenuSurface, type MenuEntry } from './MenuSurface';

/* -------------------------------------------------------------------------- */
/* 3 — Menus                                                                  */
/* -------------------------------------------------------------------------- */

export type MenubarId = 'archivo' | 'editar';

export const MENU_ACTION_LABELS: Record<string, string> = {
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

export const MENUBAR_ENTRIES: Record<MenubarId, MenuEntry[]> = {
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

export interface MenusPaneProps {
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

export function MenusPane({
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

export function MenusSection({ view }: { view: CompareView }) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownNotify, setDropdownNotify] = useState(true);
  const [contextMenu, setContextMenu] = useState({ open: false, x: 16, y: 16 });
  const [menubar, setMenubar] = useState<{ menu: MenubarId | null; direction: Direction }>({
    menu: null,
    direction: 1,
  });
  const [lastAction, setLastAction] = useState('Sin acciones todavía');

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

  return (
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
  );
}
