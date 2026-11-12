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
import { useEscapeClose } from './shared';

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
