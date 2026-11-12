import {
  useId,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useLabMotion, useLabReduce } from '../../context';
import { CompareScene, type CompareVariant, type CompareView } from '../../frame';
import type { Direction } from './shared';

/* -------------------------------------------------------------------------- */
/* 1 — Tabs                                                                   */
/* -------------------------------------------------------------------------- */

export type HTabId =
  | 'general'
  | 'modelos'
  | 'apariencia'
  | 'atajos'
  | 'extensiones'
  | 'equipo'
  | 'avanzado';

export const H_TABS: readonly { id: HTabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'modelos', label: 'Modelos' },
  { id: 'apariencia', label: 'Apariencia' },
  { id: 'atajos', label: 'Atajos' },
  { id: 'extensiones', label: 'Extensiones' },
  { id: 'equipo', label: 'Equipo' },
  { id: 'avanzado', label: 'Avanzado' },
];

export const H_PANELS: Record<HTabId, { title: string; body: string; meta: string; rows: string[] }> = {
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

export const H_TAB_WIDTH = 84;

export type VTabId = 'hilos' | 'archivos' | 'git' | 'registro';

export const V_TABS: readonly { id: VTabId; label: string; body: string }[] = [
  { id: 'hilos', label: 'Hilos', body: '4 hilos activos · 2 sin leer' },
  { id: 'archivos', label: 'Archivos', body: 'src/motion/contract.ts tocado hace 2 min' },
  { id: 'git', label: 'Git', body: 'feat/agent-sessions · 3 archivos sin commit' },
  { id: 'registro', label: 'Registro', body: '18 eventos de la sesión actual' },
];

export const V_TAB_HEIGHT = 34;

export interface SwapPanelProps {
  mode: CompareVariant;
  activeKey: string;
  direction: Direction;
  panelId: string;
  labelledBy: string;
  className?: string;
  children: ReactNode;
}

/** One tab panel: CSS swap for Kite, panelOut / panelIn for Animate UI. */
export function SwapPanel({
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

export function TabPanelBody({
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

export interface TabsPaneProps {
  mode: CompareVariant;
  hTab: { id: HTabId; direction: Direction };
  vTab: { id: VTabId; direction: Direction };
  onHTab: (id: HTabId) => void;
  onVTab: (id: VTabId) => void;
}

export function TabsPane({ mode, hTab, vTab, onHTab, onVTab }: TabsPaneProps) {
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

export function TabsSection({ view }: { view: CompareView }) {
  const [hTab, setHTab] = useState<{ id: HTabId; direction: Direction }>({
    id: 'general',
    direction: 1,
  });
  const [vTab, setVTab] = useState<{ id: VTabId; direction: Direction }>({
    id: 'hilos',
    direction: 1,
  });

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

  return (
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
  );
}
