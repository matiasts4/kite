import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { motionSurfaceClass } from '../../../surface';
import { usePresence } from '../../../usePresence';
import { useLabMotion, useLabReduce } from '../../context';
import {
  CompareScene,
  SceneButton,
  SceneSwitch,
  type CompareVariant,
  type CompareView,
} from '../../frame';
import { ChevronDownIcon } from '../../ui';
import type { Modality } from './shared';

type TabId = 'resumen' | 'actividad' | 'ajustes';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'resumen', label: 'Resumen' },
  { id: 'actividad', label: 'Actividad' },
  { id: 'ajustes', label: 'Ajustes' },
];

const MENU_ITEMS = ['Renombrar', 'Duplicar', 'Archivar'];

function panelContent(tab: TabId) {
  if (tab === 'resumen') {
    return (
      <div className="p9-panel">
        <strong>3 hilos activos</strong>
        <span>Cuota al 72% · 2 agentes en espera.</span>
      </div>
    );
  }
  if (tab === 'actividad') {
    return (
      <div className="p9-panel">
        <ul className="p9-panel-list">
          <li>Sync de cuota completado</li>
          <li>Modelo cambiado a Kite 2</li>
          <li>Hilo archivado por inactividad</li>
        </ul>
      </div>
    );
  }
  return (
    <div className="p9-panel">
      <strong>Ajustes del espacio</strong>
      <span>Tema oscuro · atajos activos · salida segura.</span>
    </div>
  );
}

interface ParityColumnProps {
  mode: CompareVariant;
  tab: TabId;
  direction: number;
  onTab: (tab: TabId, modality: Modality) => void;
  menuOpen: boolean;
  menuIndex: number;
  menuOrigin: CompareVariant | null;
  onMenuOpen: (origin: CompareVariant, index: number, modality: Modality) => void;
  onMenuMove: (index: number, modality: Modality) => void;
  onMenuFocus: (index: number) => void;
  onMenuClose: (modality: Modality) => void;
  onMenuActivate: (index: number, modality: Modality) => void;
  switchOn: boolean;
  onSwitch: () => void;
  onModality: (modality: Modality) => void;
}

function ParityColumn({
  mode,
  tab,
  direction,
  onTab,
  menuOpen,
  menuIndex,
  menuOrigin,
  onMenuOpen,
  onMenuMove,
  onMenuFocus,
  onMenuClose,
  onMenuActivate,
  switchOn,
  onSwitch,
  onModality,
}: ParityColumnProps) {
  const tokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(menuOpen);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const didAutoFocus = useRef(false);
  const triggerId = `p9-menu-trigger-${mode}`;
  const panelId = `p9-panel-${mode}`;
  const activeIndex = TABS.findIndex((item) => item.id === tab);

  useEffect(() => {
    if (!menuOpen) {
      didAutoFocus.current = false;
      return;
    }
    if (menuOrigin !== mode || didAutoFocus.current || !presence.mounted) return;
    didAutoFocus.current = true;
    itemRefs.current[0]?.focus();
  }, [menuOpen, menuOrigin, mode, presence.mounted]);

  const onTabKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    let next = activeIndex;
    if (event.key === 'ArrowRight') next = (activeIndex + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (activeIndex - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;

    event.preventDefault();
    const target = TABS[next];
    onTab(target.id, 'keyboard');
    requestAnimationFrame(() => tabRefs.current[target.id]?.focus());
  };

  const closeAndReturn = (input: Modality) => {
    onMenuClose(input);
    document.getElementById(triggerId)?.focus();
  };

  const onTriggerKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!menuOpen) {
        onMenuOpen(mode, 0, 'keyboard');
        return;
      }
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      onMenuMove((menuIndex + delta + MENU_ITEMS.length) % MENU_ITEMS.length, 'keyboard');
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!menuOpen) {
        onMenuOpen(mode, 0, 'keyboard');
        return;
      }
      onMenuActivate(menuIndex, 'keyboard');
      document.getElementById(triggerId)?.focus();
      return;
    }
    if (event.key === 'Escape' && menuOpen) {
      event.preventDefault();
      closeAndReturn('keyboard');
    }
  };

  const renderItem = (label: string, index: number) => {
    const active = menuIndex === index;
    return (
      <button
        key={label}
        ref={(node) => {
          itemRefs.current[index] = node;
        }}
        type="button"
        role="menuitem"
        className={`cmp-menu__item${mode === 'kite' && active ? ' is-active' : ''}`}
        onClick={(event) => {
          const input: Modality = event.detail === 0 ? 'keyboard' : 'pointer';
          onMenuActivate(index, input);
          document.getElementById(triggerId)?.focus();
        }}
        onFocus={() => onMenuFocus(index)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            const next = (index + delta + MENU_ITEMS.length) % MENU_ITEMS.length;
            onMenuMove(next, 'keyboard');
            itemRefs.current[next]?.focus();
            return;
          }
          if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : MENU_ITEMS.length - 1;
            onMenuMove(next, 'keyboard');
            itemRefs.current[next]?.focus();
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            closeAndReturn('keyboard');
          }
        }}
      >
        {mode === 'animate' && active && (
          <motion.span
            layoutId={`p9-menu-highlight-${mode}`}
            className="cmp-menu__highlight"
            initial={false}
            transition={tokens.springs.highlight}
          />
        )}
        <span className="cmp-menu__label">{label}</span>
      </button>
    );
  };

  const menu = (className: string) => (
    <div className={className} role="menu" aria-label={`Acciones ${mode}`}>
      {MENU_ITEMS.map((label, index) => renderItem(label, index))}
    </div>
  );

  return (
    <div className="p9-parity">
      <div className="cmp-tabs" role="tablist" aria-label={`Paridad de teclado y puntero · ${mode}`}>
        {TABS.map((item) => {
          const selected = tab === item.id;
          return (
            <button
              key={item.id}
              ref={(node) => {
                tabRefs.current[item.id] = node;
              }}
              type="button"
              role="tab"
              id={`p9-tab-${mode}-${item.id}`}
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              className={`cmp-tabs__tab${mode === 'kite' && selected ? ' is-active' : ''}`}
              onClick={(event) =>
                onTab(item.id, event.detail === 0 ? 'keyboard' : 'pointer')
              }
              onKeyDown={onTabKey}
            >
              {mode === 'animate' && selected && (
                <motion.span
                  layoutId={`p9-tab-indicator-${mode}`}
                  className="cmp-tabs__indicator"
                  initial={false}
                  transition={tokens.springs.selection}
                />
              )}
              <span className="cmp-tabs__label">{item.label}</span>
            </button>
          );
        })}
      </div>

      <div className="p9-parity__tools">
        <div className="cmp-anchor">
          <SceneButton
            mode={mode}
            id={triggerId}
            variant="ghost"
            className="cmp-chip"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(event) => {
              const input: Modality = event.detail === 0 ? 'keyboard' : 'pointer';
              if (menuOpen) {
                onMenuClose(input);
                return;
              }
              onMenuOpen(mode, 0, input);
            }}
            onKeyDown={onTriggerKey}
          >
            Acciones
            <ChevronDownIcon size={11} />
          </SceneButton>

          {mode === 'kite'
            ? presence.mounted &&
              menu(`cmp-menu ${motionSurfaceClass(presence.phase, 'popover')}`)
            : (
                <AnimatePresence>
                  {menuOpen && (
                    <motion.div
                      className="cmp-menu"
                      role="menu"
                      aria-label={`Acciones ${mode}`}
                      initial={{
                        opacity: 0,
                        scale: reduce ? 1 : tokens.scale.menu,
                        y: reduce ? 0 : -tokens.travel(3),
                        filter: tokens.surfaceBlur,
                      }}
                      animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
                      exit={{
                        opacity: 0,
                        scale: reduce ? 1 : tokens.scale.menu,
                        y: reduce ? 0 : -tokens.travel(3),
                        filter: tokens.surfaceBlur,
                        transition: tokens.tweens.dismiss,
                      }}
                      transition={reduce ? tokens.tweens.fade : tokens.tweens.menu}
                      style={{ transformOrigin: 'top left' }}
                    >
                      {MENU_ITEMS.map((label, index) => renderItem(label, index))}
                    </motion.div>
                  )}
                </AnimatePresence>
              )}
        </div>

        <label
          className="p9-switch"
          onPointerDownCapture={() => onModality('pointer')}
          onKeyDownCapture={() => onModality('keyboard')}
        >
          <span className="p9-switch__text">Notificaciones</span>
          <SceneSwitch mode={mode} checked={switchOn} onChange={onSwitch} />
        </label>
      </div>

      <div
        id={panelId}
        className="p9-parity__panel"
        role="tabpanel"
        aria-labelledby={`p9-tab-${mode}-${tab}`}
      >
        {mode === 'animate' ? (
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={tab}
              className="p9-parity__panel-inner"
              initial={{
                opacity: 0,
                filter: tokens.blur.panel,
                transform: reduce ? 'none' : `translateX(${tokens.shift.tabs * direction}px)`,
              }}
              animate={{
                opacity: 1,
                filter: 'blur(0px)',
                transform: 'none',
                transition: tokens.tweens.panelIn,
              }}
              exit={{
                opacity: 0,
                filter: tokens.blur.panel,
                transform: reduce ? 'none' : `translateX(${-tokens.shift.tabs * direction}px)`,
                transition: tokens.tweens.panelOut,
              }}
            >
              {panelContent(tab)}
            </motion.div>
          </AnimatePresence>
        ) : (
          <div className="p9-parity__panel-inner">{panelContent(tab)}</div>
        )}
      </div>

      <p className="p9-parity__hint">
        {mode === 'kite'
          ? 'CSS 150/180 ms · sin Motion: el teclado y el puntero cambian el mismo estado.'
          : 'spring.selection · transition.menu · spring.highlight · spring.thumb.'}
      </p>
    </div>
  );
}

export function ParitySection({ view }: { view: CompareView }) {
  const [tab, setTab] = useState<TabId>('resumen');
  const [direction, setDirection] = useState(1);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuOrigin, setMenuOrigin] = useState<CompareVariant | null>(null);
  const [switchOn, setSwitchOn] = useState(true);
  const [modality, setModality] = useState<Modality>('pointer');
  const [status, setStatus] = useState('Listo: usa Tab, flechas, Enter o el puntero.');
  const modalityRef = useRef<Modality>('pointer');

  const label = (input: Modality) => (input === 'keyboard' ? 'Teclado' : 'Puntero');

  const announce = (input: Modality, text: string) => {
    modalityRef.current = input;
    setModality(input);
    setStatus(text);
  };

  const selectTab = (next: TabId, input: Modality) => {
    const from = TABS.findIndex((item) => item.id === tab);
    const to = TABS.findIndex((item) => item.id === next);
    setDirection(to >= from ? 1 : -1);
    setTab(next);
    announce(input, `${label(input)} · pestaña ${TABS[to].label}`);
  };

  const openMenu = (origin: CompareVariant, index: number, input: Modality) => {
    setMenuOrigin(origin);
    setMenuIndex(index);
    setMenuOpen(true);
    announce(input, `${label(input)} · menú abierto en ${MENU_ITEMS[index]}`);
  };

  const moveMenu = (index: number, input: Modality) => {
    setMenuIndex(index);
    announce(input, `${label(input)} · ${MENU_ITEMS[index]}`);
  };

  const focusMenu = (index: number) => setMenuIndex(index);

  const closeMenu = (input: Modality) => {
    setMenuOpen(false);
    setMenuOrigin(null);
    announce(input, `${label(input)} · menú cerrado`);
  };

  const activateMenu = (index: number, input: Modality) => {
    setMenuOpen(false);
    setMenuOrigin(null);
    announce(input, `${label(input)} · ${MENU_ITEMS[index]}`);
  };

  const toggleSwitch = () => {
    const next = !switchOn;
    const input = modalityRef.current;
    setSwitchOn(next);
    announce(input, `${label(input)} · notificaciones ${next ? 'activadas' : 'desactivadas'}`);
  };

  return (
    <>
      <CompareScene
        index="09.4"
        title="Teclado y puntero"
        target="focus-visible · Enter · arrows"
        note="El mismo estado responde a las dos entradas. Pestañas con flechas, menú con Enter y flechas, switch con Espacio. El anillo de foco no espera a ninguna animación."
        view={view}
      >
        {(mode) => (
          <ParityColumn
            mode={mode}
            tab={tab}
            direction={direction}
            onTab={selectTab}
            menuOpen={menuOpen}
            menuIndex={menuIndex}
            menuOrigin={menuOrigin}
            onMenuOpen={openMenu}
            onMenuMove={moveMenu}
            onMenuFocus={focusMenu}
            onMenuClose={closeMenu}
            onMenuActivate={activateMenu}
            switchOn={switchOn}
            onSwitch={toggleSwitch}
            onModality={(next) => {
              modalityRef.current = next;
            }}
          />
        )}
      </CompareScene>

      <div className="p9-parity__status" role="status" aria-live="polite" aria-atomic="true">
        <span className={`p9-input p9-input--${modality}`}>{label(modality)}</span>
        <span>{status}</span>
      </div>

      <div className="p9-keys" aria-label="Atajos del demo">
        <span>
          <kbd>←</kbd>
          <kbd>→</kbd> pestañas
        </span>
        <span>
          <kbd>Enter</kbd> abre menú
        </span>
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> ítems
        </span>
        <span>
          <kbd>Esc</kbd> cierra
        </span>
        <span>
          <kbd>Espacio</kbd> switch
        </span>
        <span>
          <kbd>Tab</kbd> anillo de foco
        </span>
      </div>
    </>
  );
}
