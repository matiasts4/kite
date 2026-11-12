import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { usePresence } from '../../../usePresence';
import { motionSurfaceClass } from '../../../surface';
import { useLabMotion, useLabReduce } from '../../context';
import { CompareScene, SceneButton, type CompareVariant, type CompareView } from '../../frame';
import { CloseIcon } from '../../ui';
import { SearchGlyph, useMenuAutoFocus } from './shared';

/* -------------------------------------------------------------------------- */
/* 4 — Command palette                                                        */
/* -------------------------------------------------------------------------- */

export interface PaletteCommand {
  id: string;
  label: string;
  group: string;
  hint: string;
}

export const PALETTE_COMMANDS: readonly PaletteCommand[] = [
  { id: 'pal-settings', label: 'Abrir ajustes', group: 'Navegación', hint: 'Ctrl ,' },
  { id: 'pal-new-thread', label: 'Nuevo hilo', group: 'Acciones', hint: 'Ctrl N' },
  { id: 'pal-search', label: 'Buscar archivo', group: 'Navegación', hint: 'Ctrl P' },
  { id: 'pal-theme', label: 'Cambiar tema', group: 'Apariencia', hint: 'Ctrl J' },
  { id: 'pal-archive', label: 'Archivar hilo', group: 'Acciones', hint: '' },
  { id: 'pal-shortcuts', label: 'Ver atajos', group: 'Ayuda', hint: '?' },
  { id: 'pal-models', label: 'Cambiar modelo', group: 'Modelos', hint: 'Ctrl M' },
];

export function filterCommands(query: string): readonly PaletteCommand[] {
  const needle = query.trim().toLocaleLowerCase('es');
  if (!needle) return PALETTE_COMMANDS;
  return PALETTE_COMMANDS.filter(
    (command) =>
      command.label.toLocaleLowerCase('es').includes(needle) ||
      command.group.toLocaleLowerCase('es').includes(needle)
  );
}

export interface PalettePaneProps {
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

export function PalettePane({
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

export function PaletteSection({ view }: { view: CompareView }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteActiveId, setPaletteActiveId] = useState<string | null>(null);
  const [paletteResult, setPaletteResult] = useState<string | null>(null);

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

  return (
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
  );
}
