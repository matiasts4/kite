import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { PromptProjectileOverlay } from '../components/code/PromptProjectileOverlay';
import { ZedOrb, type ZedOrbState } from '../components/ZedOrb';
import '../components/zedFloat.css';
import {
  dispatchPromptWhenPaneReady,
  followLiveEdge,
  isAtLiveEdge,
  prefersReducedMotion,
  pulseZedOrb,
} from './contract';
import { usePresence } from './usePresence';
import { motionSurfaceClass } from './surface';
import { useDiffsMenuPresence } from './diffsLab';
import '../components/views/diffs/diffs.css';
import { AppIntro } from './AppIntro';
import { APP_INTRO_MIN_MS } from './contract';
import './motionLab.css';

type LabRow =
  | { id: string; kind: 'user' | 'assistant'; text: string }
  | { id: string; kind: 'action' | 'approval'; text: string };

const SEED_ROWS: LabRow[] = [
  { id: 'u1', text: 'Revisá el transcript y seguí el borde vivo.', kind: 'user' },
  {
    id: 'a1',
    text: 'La columna de esta prueba mide 880 px, por encima de los 640 del agente.',
    kind: 'assistant',
  },
];

function AppIntroDemo() {
  const [open, setOpen] = useState(true);
  const [run, setRun] = useState(0);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => setOpen(false), APP_INTRO_MIN_MS);
    return () => window.clearTimeout(timer);
  }, [open, run]);

  return (
    <section className="motion-lab__section">
      <h2>Entrada de la aplicación</h2>
      <p className="motion-lab__note">
        Splash de arranque: mínimo {APP_INTRO_MIN_MS / 1000}s mientras el bootstrap corre debajo. Salida con
        scrim + panel del contrato.
      </p>
      <button
        type="button"
        className="motion-lab__button"
        onClick={() => {
          setRun((n) => n + 1);
          setOpen(true);
        }}
      >
        Repetir intro
      </button>
      <AppIntro key={run} open={open} />
    </section>
  );
}

function PopoverDemo() {
  const [open, setOpen] = useState(false);
  const presence = usePresence(open);
  return (
    <section className="motion-lab__section">
      <h2>Cuotas y notificaciones</h2>
      <p className="motion-lab__note">
        Entran desde el ancla, unos píxeles, sin escala. La salida termina antes de desmontar.
      </p>
      <div className="motion-lab__stage">
        <div className="motion-lab__badge">
          <button type="button" className="motion-lab__button" onClick={() => setOpen((v) => !v)}>
            Cuota 72%
          </button>
        </div>
        {presence.mounted && (
          <div className={`motion-lab__popover ${motionSurfaceClass(presence.phase, 'popover')}`}>
            <strong>Cuota de suscripción</strong>
            <p>72% restante. El panel no aparece entero de un frame al siguiente.</p>
          </div>
        )}
      </div>
    </section>
  );
}

function LeftRailDemo() {
  const [open, setOpen] = useState(true);
  const presence = usePresence(open);
  return (
    <section className="motion-lab__section">
      <h2>Sidebar izquierda</h2>
      <p className="motion-lab__note">Mismo contrato que el rail de workspaces, con salida hacia la izquierda.</p>
      <div className="motion-lab__row">
        <button type="button" className="motion-lab__button" onClick={() => setOpen((v) => !v)}>
          {open ? 'Ocultar rail' : 'Mostrar rail'}
        </button>
      </div>
      <div className="motion-lab__stage motion-lab__dock-stage">
        {presence.mounted && (
          <aside className={`motion-lab__left-rail ${motionSurfaceClass(presence.phase, 'panel-left')}`}>
            Workspaces · agentes · hilos
          </aside>
        )}
        <div className="motion-lab__dock-main">Editor</div>
      </div>
    </section>
  );
}

function MenuDemo() {
  const [open, setOpen] = useState(false);
  const presence = usePresence(open);
  return (
    <section className="motion-lab__section">
      <h2>Menús contextuales</h2>
      <p className="motion-lab__note">SelectMenu y ui-menu del sidebar usan la curva popover.</p>
      <div className="motion-lab__stage">
        <button type="button" className="motion-lab__button" onClick={() => setOpen((v) => !v)}>
          Abrir menú
        </button>
        {presence.mounted && (
          <div className={`motion-lab__menu ${motionSurfaceClass(presence.phase, 'popover')}`}>
            <div className="motion-lab__menu-row">Renombrar</div>
            <div className="motion-lab__menu-row">Archivar</div>
          </div>
        )}
      </div>
    </section>
  );
}

function DockDemo() {
  const [open, setOpen] = useState(false);
  const presence = usePresence(open);
  return (
    <section className="motion-lab__section">
      <h2>Sidebar derecha</h2>
      <p className="motion-lab__note">El cascarón se desplaza con translate. El ancho no se anima.</p>
      <div className="motion-lab__row">
        <button type="button" className="motion-lab__button" onClick={() => setOpen((v) => !v)}>
          {open ? 'Cerrar panel' : 'Abrir panel'}
        </button>
      </div>
      <div className="motion-lab__stage motion-lab__dock-stage">
        <div className="motion-lab__dock-main">Área de trabajo</div>
        {presence.mounted && (
          <aside className={`motion-lab__dock ${motionSurfaceClass(presence.phase, 'panel')}`}>
            Archivos, diffs y browser viven en el producto. Acá solo se prueba el marco.
          </aside>
        )}
      </div>
    </section>
  );
}

function TranscriptDemo() {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const atEdgeRef = useRef(true);
  const [rows, setRows] = useState<LabRow[]>(SEED_ROWS);
  const seenRef = useRef<Set<string>>(new Set(SEED_ROWS.map((row) => row.id)));
  const enterRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const column = columnRef.current;
    const scroller = scrollerRef.current;
    if (!column || !scroller || typeof ResizeObserver === 'undefined') return;
    let prev = column.getBoundingClientRect().height;
    const observer = new ResizeObserver(() => {
      const next = column.getBoundingClientRect().height;
      const delta = next - prev;
      prev = next;
      scroller.scrollTop = followLiveEdge(scroller.scrollTop, delta, atEdgeRef.current);
    });
    observer.observe(column);
    return () => observer.disconnect();
  }, []);

  const push = (row: LabRow) => {
    if (!seenRef.current.has(row.id)) enterRef.current.add(row.id);
    setRows((prev) => [...prev, row]);
  };

  return (
    <section className="motion-lab__section">
      <h2>Transcript del agente</h2>
      <p className="motion-lab__note">
        Las acciones nuevas entran una vez. El texto que ya está no se vuelve a animar. Si subís el
        scroll, el seguimiento se detiene.
      </p>
      <div className="motion-lab__row">
        <button
          type="button"
          className="motion-lab__button"
          onClick={() =>
            push({
              id: `tool-${Date.now()}`,
              kind: 'action',
              text: 'Leyó src/motion/contract.ts',
            })
          }
        >
          Añadir acción
        </button>
        <button
          type="button"
          className="motion-lab__button"
          onClick={() =>
            push({
              id: `ok-${Date.now()}`,
              kind: 'approval',
              text: 'Aprobación · editar AgentChatShell',
            })
          }
        >
          Añadir aprobación
        </button>
        <button
          type="button"
          className="motion-lab__button"
          onClick={() =>
            setRows((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.kind === 'assistant') {
                next[next.length - 1] = { ...last, text: `${last.text} Sigue el stream.` };
              } else {
                next.push({
                  id: `asst-${Date.now()}`,
                  kind: 'assistant',
                  text: 'Respuesta en curso.',
                });
              }
              return next;
            })
          }
        >
          Crecer respuesta
        </button>
      </div>
      <div className="motion-lab__stage">
        <div
          className="motion-lab__transcript"
          ref={scrollerRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            atEdgeRef.current = isAtLiveEdge(el.scrollHeight, el.scrollTop, el.clientHeight);
          }}
        >
          <div className="motion-lab__column" ref={columnRef}>
            {rows.map((row) => {
              const enter = enterRef.current.has(row.id) ? 'motion-row-in' : '';
              if (row.kind === 'user') {
                return (
                  <div key={row.id} className="motion-lab__user">
                    {row.text}
                  </div>
                );
              }
              if (row.kind === 'assistant') {
                return (
                  <div key={row.id} className="motion-lab__assistant">
                    {row.text}
                  </div>
                );
              }
              return (
                <div key={row.id} className={`motion-lab__${row.kind} ${enter}`}>
                  {row.text}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

const LAB_DIFF_FILES = [
  { path: 'index.html', added: 2, removed: 1 },
  { path: 'src/motion/contract.ts', added: 14, removed: 0 },
  { path: 'src/App.tsx', added: 1, removed: 3 },
];

function DiffsDemo() {
  const [fileIdx, setFileIdx] = useState(0);
  const [cardOpen, setCardOpen] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuPresence = useDiffsMenuPresence(menuOpen);
  const file = LAB_DIFF_FILES[fileIdx];

  return (
    <section className="motion-lab__section">
      <h2>Diffs (dock)</h2>
      <p className="motion-lab__note">
        Mismas clases que producción (<code>diffs.css</code>, <code>DiffsView</code>): fade al cambiar
        archivo, expand de tarjeta y menús con salida.
      </p>
      <div className="motion-lab__row">
        <button
          type="button"
          className="motion-lab__button"
          onClick={() => setFileIdx((i) => (i + 1) % LAB_DIFF_FILES.length)}
        >
          Siguiente archivo
        </button>
        <button type="button" className="motion-lab__button" onClick={() => setCardOpen((v) => !v)}>
          {cardOpen ? 'Colapsar tarjeta' : 'Expandir tarjeta'}
        </button>
        <button type="button" className="motion-lab__button" onClick={() => setMenuOpen((v) => !v)}>
          Menú diff options
        </button>
      </div>
      <div className="motion-lab__stage motion-lab__diffs-stage">
        <div className="motion-lab__diffs-toolbar">
          <span className="motion-lab__diffs-folder">Frontend App</span>
          <span className="motion-lab__diffs-pill">All</span>
        </div>
        <div className="motion-lab__diffs-body">
          <div className="motion-lab__diff-card">
            <button
              type="button"
              className="motion-lab__diff-card-head"
              onClick={() => setCardOpen((v) => !v)}
            >
              {file.path}
              <span className="motion-lab__diff-stats">
                +{file.added} −{file.removed}
              </span>
            </button>
            {cardOpen && (
              <div className="diff-file-card-content">
                <pre>{`@@ -1,3 +1,4 @@\n- old line\n+ new line`}</pre>
              </div>
            )}
          </div>
          <div key={file.path} className="diffs-focused-content motion-lab__diff-focused">
            <strong>{file.path}</strong>
            <p>Vista focused: el contenido hace fade al cambiar de archivo (key en la ruta).</p>
          </div>
        </div>
        <div className="motion-lab__diffs-menu-anchor">
          {menuPresence.mounted && (
            <div
              className={`ui-menu diffs-overflow-menu scroll-quiet motion-lab__diffs-menu-prod${
                menuPresence.motionClass ? ` ${menuPresence.motionClass}` : ''
              }`}
              role="menu"
              aria-label="Diff display options (lab)"
            >
              <div className="ui-menu__header" role="presentation">
                <span className="ui-menu__title">Diff options</span>
              </div>
              <div className="ui-menu__row" role="menuitem">
                <span className="ui-menu__label">
                  <span className="ui-menu__row-title">Focused</span>
                </span>
              </div>
              <div className="ui-menu__row" role="menuitem">
                <span className="ui-menu__label">
                  <span className="ui-menu__row-title">Stream</span>
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function TasksDemo() {
  const [showCard, setShowCard] = useState(false);
  return (
    <section className="motion-lab__section">
      <h2>Tasks</h2>
      <p className="motion-lab__note">
        El tab Tasks no tiene keyframes propios hoy: kanban usa drag nativo; modales y selects heredan
        Sheet / SelectMenu del kit global. Solo tendría sentido animar aquí un gesto concreto (p. ej. tarjeta
        al soltar en otra columna) antes de tocar <code>TicketsView</code>.
      </p>
      <div className="motion-lab__row">
        <button type="button" className="motion-lab__button" onClick={() => setShowCard((v) => !v)}>
          {showCard ? 'Quitar tarjeta demo' : 'Añadir tarjeta demo'}
        </button>
      </div>
      <div className="motion-lab__stage motion-lab__tasks-board">
        <div className="motion-lab__tasks-col">
          <span>Todo</span>
          {showCard && <article className="motion-lab__task-card motion-row-in">KITE-42 · Motion lab</article>}
        </div>
        <div className="motion-lab__tasks-col">
          <span>Doing</span>
        </div>
        <div className="motion-lab__tasks-col">
          <span>Done</span>
        </div>
      </div>
    </section>
  );
}

function ModalsDemo() {
  const [open, setOpen] = useState(false);
  const presence = usePresence(open);
  return (
    <section className="motion-lab__section">
      <h2>Modales y sheets</h2>
      <p className="motion-lab__note">Scrim + panel (What&apos;s new, Usage, Archived chats).</p>
      <button type="button" className="motion-lab__button" onClick={() => setOpen(true)}>
        Abrir modal de prueba
      </button>
      {presence.mounted && (
        <div className="motion-lab__modal-layer">
          <div
            className={`motion-lab__modal-scrim ${motionSurfaceClass(presence.phase, 'scrim')}`}
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            className={`motion-lab__modal-panel ${motionSurfaceClass(presence.phase, 'modal')}`}
            role="dialog"
            aria-label="Modal de prueba"
          >
            <h3>Token usage</h3>
            <p>El panel baja unos píxeles y el scrim hace fade. Misma curva que en producción.</p>
            <button type="button" className="motion-lab__button" onClick={() => setOpen(false)}>
              Cerrar
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

const ZED_ORB_STATES: { id: ZedOrbState; label: string }[] = [
  { id: 'connected', label: 'Esperando' },
  { id: 'listening', label: 'Escuchando' },
  { id: 'thinking', label: 'Ejecutando' },
  { id: 'speaking', label: 'Hablando' },
  { id: 'error', label: 'Error' },
  { id: 'connecting', label: 'Conectando' },
  { id: 'idle', label: 'Reposo' },
  { id: 'muted', label: 'Silenciado' },
];

function zedOrbLevel(state: ZedOrbState): number {
  if (state === 'listening' || state === 'speaking') return 0.62;
  if (state === 'thinking' || state === 'connecting') return 0.38;
  if (state === 'error') return 0.22;
  return 0;
}

function ZedDemo() {
  const [terminal, setTerminal] = useState(false);
  const [ack, setAck] = useState(false);
  const [landedPrompt, setLandedPrompt] = useState<string | null>(null);
  const [orbState, setOrbState] = useState<ZedOrbState>('connected');

  useEffect(() => {
    let timer = 0;
    const onAck = () => {
      setAck(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setAck(false), 180);
    };
    const onStaged = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; prompt?: string }>).detail;
      if (detail?.sessionId === 'lab-session' && detail.prompt) {
        setLandedPrompt(detail.prompt);
      }
    };
    window.addEventListener('kite:zed-orb-ack', onAck);
    window.addEventListener('kite:terminal-staged-prompt', onStaged);
    return () => {
      window.removeEventListener('kite:zed-orb-ack', onAck);
      window.removeEventListener('kite:terminal-staged-prompt', onStaged);
      window.clearTimeout(timer);
    };
  }, []);

  const spawn = () => {
    setTerminal(true);
    dispatchPromptWhenPaneReady({
      targetPaneId: 'lab-terminal',
      targetSessionId: 'lab-session',
      agentName: 'Zed',
      engine: 'kite',
      prompt: 'Inyectar este prompt en la terminal de prueba',
    });
  };

  return (
    <section className="motion-lab__section">
      <h2>Zed</h2>
      <p className="motion-lab__note">
        El mismo orbe WebGL de 72px que flota en la app. Cada botón fija un estado de{' '}
        <code>ZedOrb</code>. El proyectil sigue siendo el punto con estela: el texto aparece en la
        terminal cuando llega.
      </p>
      <div className="motion-lab__row" role="group" aria-label="Estados del orbe de Zed">
        {ZED_ORB_STATES.map((item) => (
          <button
            key={item.id}
            type="button"
            className="motion-lab__button"
            aria-pressed={orbState === item.id}
            onClick={() => setOrbState(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="motion-lab__row">
        <button type="button" className="motion-lab__button" onClick={spawn}>
          Abrir terminal e inyectar
        </button>
        <button
          type="button"
          className="motion-lab__button"
          onClick={() => {
            setTerminal(false);
            setLandedPrompt(null);
            pulseZedOrb();
          }}
        >
          Cerrar terminal
        </button>
      </div>
      <div className="motion-lab__stage motion-lab__zed">
        <div className="motion-lab__zed-orb">
          <div className="zed-float__orb-container">
            <div className={`zed-float__orb${ack ? ' motion-orb-ack' : ''}`}>
              <ZedOrb
                state={orbState}
                size={72}
                level={zedOrbLevel(orbState)}
                ariaLabel={`Orbe de Zed, ${orbState}`}
              />
            </div>
          </div>
          <span className="motion-lab__zed-state">{orbState}</span>
        </div>
        {terminal && (
          <div
            className="motion-lab__terminal motion-terminal-in"
            data-leaf-id="lab-terminal"
            data-session-id="lab-session"
            data-testid="terminal-pane"
          >
            <div>kite · sesión de prueba</div>
            <div className={landedPrompt ? 'motion-row-in' : undefined}>
              {landedPrompt ? `› ${landedPrompt}` : '$ esperando el prompt…'}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export const MotionLab: React.FC = () => {
  const [reduced, setReduced] = useState(() => prefersReducedMotion());

  useEffect(() => {
    document.documentElement.dataset.motion = reduced ? 'reduce' : 'full';
    return () => {
      delete document.documentElement.dataset.motion;
    };
  }, [reduced]);

  return (
    <div className="motion-lab">
      <div className="motion-lab__inner">
        <header className="motion-lab__header">
          <div>
            <h1>Laboratorio de movimiento</h1>
            <p>
              Sandbox del kit: probá acá antes de llevar animaciones al producto. Agent / Code / Thread mode
              no se tocan.
            </p>
          </div>
          <label className="motion-lab__switch">
            <input
              type="checkbox"
              checked={reduced}
              onChange={(event) => {
                const next = event.target.checked;
                document.documentElement.dataset.motion = next ? 'reduce' : 'full';
                setReduced(next);
              }}
            />
            Reduced motion
          </label>
        </header>
        <AppIntroDemo />
        <PopoverDemo />
        <LeftRailDemo />
        <MenuDemo />
        <DockDemo />
        <DiffsDemo />
        <TasksDemo />
        <ModalsDemo />
        <TranscriptDemo />
        <ZedDemo />
      </div>
      <PromptProjectileOverlay />
    </div>
  );
};

export function renderMotionLab(root: HTMLElement): void {
  ReactDOM.createRoot(root).render(<MotionLab />);
}
