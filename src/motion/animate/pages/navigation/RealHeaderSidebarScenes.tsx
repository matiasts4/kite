import { useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { motion } from 'motion/react';
import { useLabMotion, useLabReduce } from '../../context';
import { CompareScene, SceneButton, type CompareVariant, type CompareView } from '../../frame';

// Production Kite components
import { TitleBar, type TitleBarMode } from '../../../../components/TitleBar';
import { SubscriptionQuotaBadge } from '../../../../components/quota/SubscriptionQuotaBadge';
import { SystemResourceBadge } from '../../../../components/telemetry/SystemResourceBadge';
import { Sidebar } from '../../../../components/Sidebar';
import type { AgentProfile, Workspace } from '../../../../types';
import type { ChatThreadSummary, WorkMode } from '../../../../components/sidebar/types';

/* -------------------------------------------------------------------------- */
/* Seed Data for Authentic Navigation & Rosters                               */
/* -------------------------------------------------------------------------- */

const SEED_WORKSPACES: Workspace[] = [
  {
    id: 'ws-kite',
    displayName: 'kite',
    createdAtUnixMs: Date.now() - 86400000 * 7,
    lastOpenedAtUnixMs: Date.now() - 1000 * 60 * 12,
    pinned: true,
    available: true,
  },
  {
    id: 'ws-motion',
    displayName: 'kite-motion-lab',
    createdAtUnixMs: Date.now() - 86400000 * 3,
    lastOpenedAtUnixMs: Date.now() - 1000 * 60 * 45,
    pinned: false,
    available: true,
  },
];

const SEED_AGENTS: AgentProfile[] = [
  {
    id: 'ag-antigravity',
    name: 'Antigravity Lead',
    engine: 'antigravity',
    purpose: 'Arquitectura reactiva y orquestación integral de Kite',
    avatar: null,
    createdAtUnixMs: Date.now() - 86400000 * 5,
    pinned: true,
    order: 0,
  },
  {
    id: 'ag-claude',
    name: 'Claude Architect',
    engine: 'claude',
    purpose: 'Refactorización, tipado estricto y calidad de código',
    avatar: null,
    createdAtUnixMs: Date.now() - 86400000 * 4,
    pinned: true,
    order: 1,
  },
  {
    id: 'ag-zed',
    name: 'Zed Operator',
    engine: 'opencode',
    purpose: 'Ejecución autónoma de tareas de terminal y compilación',
    avatar: null,
    createdAtUnixMs: Date.now() - 86400000 * 2,
    pinned: false,
    order: 2,
  },
  {
    id: 'ag-grok',
    name: 'Grok Builder',
    engine: 'grok',
    purpose: 'Prototipado rápido de micro-interacciones y UI Motion',
    avatar: null,
    createdAtUnixMs: Date.now() - 86400000 * 1,
    pinned: false,
    order: 3,
  },
];

const SEED_THREADS: ChatThreadSummary[] = [
  {
    id: 'th-header-integration',
    title: 'Integración TitleBar y Telemetría',
    workspaceId: 'ws-kite',
    updatedAtUnixMs: Date.now() - 1000 * 60 * 3,
    pinned: true,
    isPinned: true,
    status: 'running',
    provider: 'opencode',
  },
  {
    id: 'th-spring-tokens',
    title: 'Tokens spring.selection y spring.highlight',
    workspaceId: 'ws-kite',
    updatedAtUnixMs: Date.now() - 1000 * 60 * 28,
    pinned: true,
    isPinned: true,
    status: 'idle',
    provider: 'claude',
  },
  {
    id: 'th-zed-orb',
    title: 'Sincronización Zed Mini-Orb y Plasma',
    workspaceId: 'ws-motion',
    updatedAtUnixMs: Date.now() - 1000 * 60 * 115,
    pinned: false,
    isPinned: false,
    status: 'waiting',
    provider: 'opencode',
  },
  {
    id: 'th-perf-audit',
    title: 'Auditoría de tasa de refresco 60fps',
    workspaceId: 'ws-motion',
    updatedAtUnixMs: Date.now() - 1000 * 60 * 350,
    pinned: false,
    isPinned: false,
    status: 'idle',
    provider: 'grok',
  },
];

const SEED_ACTIVITY: Record<
  string,
  { runningCount?: number; needsYou?: boolean; atUnixMs?: number; line?: string }
> = {
  'ag-antigravity': {
    runningCount: 1,
    needsYou: false,
    atUnixMs: Date.now() - 12000,
    line: 'Compilando esquemas y sincronizando tokens',
  },
  'ag-zed': {
    runningCount: 0,
    needsYou: true,
    atUnixMs: Date.now() - 55000,
    line: 'Esperando confirmación de comando',
  },
};

const SEED_AVAILABILITY = {
  hasProbed: true,
  antigravity: true,
  claude: true,
  opencode: true,
  grok: true,
  cursor: true,
};

const MODE_DESCRIPTIONS: Record<TitleBarMode, { label: string; desc: string }> = {
  agent: { label: 'Agent', desc: 'Agentes autónomos con memoria persistente' },
  code: { label: 'Code', desc: 'Edición en carpetas, terminal y diffs' },
  chat: { label: 'Thread', desc: 'Conversaciones enfocadas e hilos de trabajo' },
};

/* -------------------------------------------------------------------------- */
/* Isolated Mode Switcher (Kite CSS vs Animate UI Spring Physics)             */
/* -------------------------------------------------------------------------- */

interface IsolatedModeToggleProps {
  mode: CompareVariant;
  activeMode: TitleBarMode;
  onChange: (m: TitleBarMode) => void;
}

function IsolatedModeToggle({ mode, activeMode, onChange }: IsolatedModeToggleProps) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const trackRef = useRef<HTMLFieldSetElement>(null);

  const updateThumb = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    const active = el.querySelector('.mode-toggle__item--active') as HTMLElement | null;
    if (!active) return;
    const parentRect = el.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    if (activeRect.width === 0 || parentRect.height === 0 || el.offsetHeight === 0) return;
    const scale = parentRect.height / el.offsetHeight || 1;
    el.style.setProperty('--thumb-x', `${(activeRect.left - parentRect.left) / scale - el.clientLeft}px`);
    el.style.setProperty('--thumb-w', `${activeRect.width / scale}px`);
  }, []);

  useLayoutEffect(() => {
    updateThumb();
  }, [activeMode, updateThumb]);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const onResize = () => updateThumb();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
    observer?.observe(el);
    for (const btn of el.querySelectorAll('button')) observer?.observe(btn);
    return () => observer?.disconnect();
  }, [updateThumb]);

  const items: { id: TitleBarMode; label: string }[] = [
    { id: 'agent', label: 'Agent' },
    { id: 'code', label: 'Code' },
    { id: 'chat', label: 'Thread' },
  ];

  if (mode === 'animate') {
    return (
      <fieldset aria-label="Selector de modo" className="mode-toggle mode-toggle--animate">
        {items.map((item) => {
          const isActive = activeMode === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={isActive}
              className={`mode-toggle__item${isActive ? ' mode-toggle__item--active' : ''}`}
              data-label={item.label}
              onClick={() => onChange(item.id)}
            >
              {isActive && (
                <motion.span
                  layoutId="isolated-mode-thumb-spring"
                  className="mode-toggle__spring-thumb"
                  transition={reduce ? { duration: 0 } : motionTokens.springs.selection}
                />
              )}
              <span className="mode-toggle__item-label" style={{ position: 'relative', zIndex: 1 }}>
                {item.label}
              </span>
            </button>
          );
        })}
      </fieldset>
    );
  }

  return (
    <fieldset
      ref={trackRef}
      aria-label="Selector de modo"
      className="mode-toggle"
      data-mode={activeMode}
      data-thumb-ready=""
    >
      {items.map((item) => {
        const isActive = activeMode === item.id;
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={isActive}
            className={`mode-toggle__item${isActive ? ' mode-toggle__item--active' : ''}`}
            data-label={item.label}
            onClick={() => onChange(item.id)}
          >
            {item.label}
          </button>
        );
      })}
    </fieldset>
  );
}

/* -------------------------------------------------------------------------- */
/* Main Export: RealHeaderSidebarScenes Component                             */
/* -------------------------------------------------------------------------- */

export function RealHeaderSidebarScenes({ view }: { view: CompareView }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();

  // Shared state for Scene A (Full TitleBar)
  const [headerMode, setHeaderMode] = useState<TitleBarMode>('agent');
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [operatorVisible, setOperatorVisible] = useState(false);
  const [browserVisible, setBrowserVisible] = useState(false);
  const [unreadNotifications, setUnreadNotifications] = useState(3);
  const [lastAction, setLastAction] = useState<string>('Modo activo: Agent · Listo');

  // Shared state for Scene B (Isolated controls)
  const [isolatedMode, setIsolatedMode] = useState<TitleBarMode>('agent');
  const [isolatedZedActive, setIsolatedZedActive] = useState(false);

  // Shared state for Scene C (Real Sidebar & Rosters)
  const [sidebarMode, setSidebarMode] = useState<WorkMode>('agent');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>('ag-antigravity');
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>('th-header-integration');
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>('ws-kite');
  const [appearance, setAppearance] = useState<'dark' | 'light'>('dark');
  const [workspaces, setWorkspaces] = useState<Workspace[]>(SEED_WORKSPACES);
  const [agents, setAgents] = useState<AgentProfile[]>(SEED_AGENTS);
  const [threads, setThreads] = useState<ChatThreadSummary[]>(SEED_THREADS);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? agents[0];
  const selectedThread = threads.find((t) => t.id === selectedThreadId) ?? threads[0];
  const selectedWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId) ?? workspaces[0];

  return (
    <>
      {/* ================================================================== */}
      {/* Scene A: Barra Superior Completa (TitleBar Real)                  */}
      {/* ================================================================== */}
      <CompareScene
        index="2.0A"
        title="Barra superior completa (TitleBar real)"
        target="TitleBar · ModeSwitcher · Telemetry · Quota · Zed"
        note="Cabecera oficial de Kite montada con estado interactivo completo: selector de modo con cápsula deslizante (Agent · Code · Thread), botón de asistente Zed con mini-orb y corona de plasma, medidor de consumo y cuotas con popover, monitor de hardware y recursos del sistema, y botón de sidebar."
        view={view}
      >
        {(mode) => (
          <div className="p2-stage">
            <div className={`p2-real-header-box${mode === 'animate' ? ' p2-real-header-box--animate' : ''}`}>
              <TitleBar
                title="Kite"
                activeMode={headerMode}
                onModeChange={(m) => {
                  setHeaderMode(m);
                  setSidebarMode(m);
                  setLastAction(`Modo cambiado a: ${MODE_DESCRIPTIONS[m].label}`);
                }}
                sidebarVisible={sidebarVisible}
                onToggleSidebar={() => {
                  setSidebarVisible((prev) => !prev);
                  setLastAction(sidebarVisible ? 'Barra lateral ocultada' : 'Barra lateral restaurada');
                }}
                operatorVisible={operatorVisible}
                onToggleOperator={() => {
                  setOperatorVisible((prev) => !prev);
                  setLastAction(operatorVisible ? 'Asistente Zed desactivado' : 'Asistente Zed activado');
                }}
                browserVisible={browserVisible}
                onToggleBrowser={() => {
                  setBrowserVisible((prev) => !prev);
                  setLastAction(browserVisible ? 'Panel lateral cerrado' : 'Panel lateral abierto');
                }}
                unreadCount={unreadNotifications}
                onOpenNotifications={() => {
                  setUnreadNotifications(0);
                  setLastAction('Centro de notificaciones desplegado');
                }}
                onOpenUsage={() => {
                  setLastAction('Panel de uso y cuotas desplegado');
                }}
                platform="windows"
                activeSessionTitle="Motion Lab Preview — Navegación"
                activeEngine="antigravity"
              />
            </div>

            <div className="p2-real-hud">
              <div className="p2-real-hud__items">
                <span className="p2-real-hud__pill">
                  Modo: <strong>{MODE_DESCRIPTIONS[headerMode].label}</strong>
                </span>
                <span className="p2-real-hud__pill">
                  Sidebar: <strong>{sidebarVisible ? 'Visible' : 'Oculta'}</strong>
                </span>
                <span className="p2-real-hud__pill">
                  Zed: <strong>{operatorVisible ? 'Activo (Escuchando)' : 'En espera'}</strong>
                </span>
                <span className="p2-real-hud__pill">
                  Motor: <strong>{mode === 'animate' ? 'Animate UI Springs' : 'Kite CSS Native'}</strong>
                </span>
              </div>
              <span className="p2-real-hud__action">Acción: {lastAction}</span>
            </div>
          </div>
        )}
      </CompareScene>

      {/* ================================================================== */}
      {/* Scene B: Controles Clave de la Cabecera (Inspección Aislada)        */}
      {/* ================================================================== */}
      <CompareScene
        index="2.0B"
        title="Controles clave de la cabecera (inspección aislada)"
        target="ModeToggle · QuotaBadge · ResourceBadge · ZedOrb"
        note="Los 4 componentes fundamentales de la cabecera aislados para inspección minuciosa: selector de modo con geometría squircle y cápsula deslizante (en Animate UI propulsado por spring.selection), monitor de consumo IA con anillo de progreso y popover, monitor de recursos del sistema con refresco en vivo vía ThinkingOrb, y botón de asistente Zed de 32px con mini-orb volumétrico."
        view={view}
      >
        {(mode) => (
          <div className="p2-stage">
            <div className="p2-isolated-grid">
              {/* 1. Selector de Modo Superior */}
              <div className="p2-isolated-card">
                <div className="p2-isolated-card__header">
                  <span className="p2-isolated-card__title">1. Selector de Modo Superior</span>
                  <span className="p2-status-pill p2-status-pill--active">
                    {mode === 'animate' ? 'spring.selection' : 'CSS transition'}
                  </span>
                </div>
                <div className="p2-isolated-card__body">
                  <IsolatedModeToggle
                    mode={mode}
                    activeMode={isolatedMode}
                    onChange={setIsolatedMode}
                  />
                </div>
                <p className="p2-isolated-card__hint">
                  {mode === 'animate'
                    ? 'Animate UI utiliza resortes sin overshoot ni saltos de ancho, adaptándose con exactitud al texto de cada pastilla.'
                    : 'Kite hoy utiliza una transición CSS con interpolación lineal estándar de 180ms.'}
                </p>
              </div>

              {/* 2. Monitoreo de Consumo y Cuotas */}
              <div className="p2-isolated-card">
                <div className="p2-isolated-card__header">
                  <span className="p2-isolated-card__title">2. Consumo y Cuotas IA</span>
                  <span className="p2-plan-pill">Ultra Plan</span>
                </div>
                <div className="p2-isolated-card__body">
                  <SubscriptionQuotaBadge
                    activeEngine="antigravity"
                    activeSessionTitle="Motion Lab Preview"
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: '11px', color: 'var(--alab-text)', fontWeight: 600 }}>
                      Tokens & Límite
                    </span>
                    <span style={{ fontSize: '9.5px', color: 'var(--alab-muted)' }}>
                      12.4k consumidos · Clic para popover
                    </span>
                  </div>
                </div>
                <p className="p2-isolated-card__hint">
                  Badge interactivo con anillo de progreso SVG, BorderBeam en estados de estrés y popover de cuotas por proveedor.
                </p>
              </div>

              {/* 3. Monitoreo de Recursos del Sistema */}
              <div className="p2-isolated-card">
                <div className="p2-isolated-card__header">
                  <span className="p2-isolated-card__title">3. Recursos del Sistema</span>
                  <span className="p2-status-pill p2-status-pill--ok">Telemetry Live</span>
                </div>
                <div className="p2-isolated-card__body">
                  <SystemResourceBadge />
                  <div className="p2-resource-bars">
                    <div className="p2-resource-bar-row">
                      <span className="p2-resource-bar-label">RAM App</span>
                      <div className="p2-bar-track">
                        <motion.div
                          className="p2-bar-fill p2-bar-fill--ram"
                          animate={{ width: '42%' }}
                          transition={reduce ? { duration: 0 } : motionTokens.springs.highlight}
                        />
                      </div>
                      <span className="p2-resource-bar-val">284 MB</span>
                    </div>
                    <div className="p2-resource-bar-row">
                      <span className="p2-resource-bar-label">CPU App</span>
                      <div className="p2-bar-track">
                        <motion.div
                          className="p2-bar-fill p2-bar-fill--cpu"
                          animate={{ width: '18%' }}
                          transition={reduce ? { duration: 0 } : motionTokens.springs.highlight}
                        />
                      </div>
                      <span className="p2-resource-bar-val">3.2%</span>
                    </div>
                  </div>
                </div>
                <p className="p2-isolated-card__hint">
                  Supervisión de huella de memoria RAM y CPU en tiempo real. Al refrescar, ThinkingOrb activa animación estelar.
                </p>
              </div>

              {/* 4. Botón Asistente Zed */}
              <div className="p2-isolated-card">
                <div className="p2-isolated-card__header">
                  <span className="p2-isolated-card__title">4. Asistente Zed (Mini-Orb)</span>
                  <span
                    className={`p2-status-pill ${
                      isolatedZedActive ? 'p2-status-pill--active' : ''
                    }`}
                  >
                    {isolatedZedActive ? 'Escuchando (Activo)' : 'En espera'}
                  </span>
                </div>
                <div className="p2-isolated-card__body p2-isolated-card__body--center">
                  <button
                    type="button"
                    className={`chrome-button zed-toggle-button p2-standalone-zed${
                      isolatedZedActive ? ' chrome-button--selected zed-toggle-button--active' : ''
                    }`}
                    onClick={() => setIsolatedZedActive(!isolatedZedActive)}
                    aria-pressed={isolatedZedActive}
                    title="Asistente Zed (Operador y Voz)"
                  >
                    <span
                      className="zed-mini-orb"
                      data-active={isolatedZedActive ? 'true' : 'false'}
                      aria-hidden="true"
                    >
                      <span className="zed-mini-orb__halo" />
                      <svg
                        className="zed-mini-orb__ring"
                        viewBox="0 0 24 24"
                        fill="none"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <defs>
                          <linearGradient
                            id={`zed-iso-ring-${mode}`}
                            x1="0%"
                            y1="0%"
                            x2="100%"
                            y2="100%"
                          >
                            <stop offset="0%" stopColor="#e0f2fe" stopOpacity="0.95" />
                            <stop offset="45%" stopColor="#38bdf8" stopOpacity="0.75" />
                            <stop offset="80%" stopColor="#818cf8" stopOpacity="0.25" />
                            <stop offset="100%" stopColor="#c084fc" stopOpacity="0" />
                          </linearGradient>
                        </defs>
                        <circle
                          cx="12"
                          cy="12"
                          r="10.2"
                          stroke={`url(#zed-iso-ring-${mode})`}
                          strokeWidth="1.25"
                          strokeLinecap="round"
                          strokeDasharray="34 30"
                        />
                      </svg>
                      <span className="zed-mini-orb__sphere">
                        <span className="zed-mini-orb__plasma" />
                        <span className="zed-mini-orb__core" />
                        <span className="zed-mini-orb__specular" />
                      </span>
                    </span>
                  </button>
                  <div className="p2-zed-info">
                    <strong>Orb 3D volumétrico (32px)</strong>
                    <small>
                      {isolatedZedActive
                        ? 'Halo pulsante y plasma orbital activo'
                        : 'Rotación lenta y brillo especular pasivo'}
                    </small>
                  </div>
                </div>
                <p className="p2-isolated-card__hint">
                  Hacé clic para alternar el estado activo. Presenta halo atmosférico difuso, anillo orbital giratorio y esfera de plasma reflectante.
                </p>
              </div>
            </div>
          </div>
        )}
      </CompareScene>

      {/* ================================================================== */}
      {/* Scene C: Barra Lateral Real (Sidebar y Rosters)                   */}
      {/* ================================================================== */}
      <CompareScene
        index="2.0C"
        title="Barra lateral real (Sidebar y rosters)"
        target="Sidebar · AgentRoster · ThreadRoster · WorkspaceRoster · SidebarFooter"
        note="Barra lateral de producción Kite completamente viva e integrada: AgentRoster con avatares 3D procedimentales bot-avatars e indicadores de estado, ThreadRoster con hilos anclados y menús de acción, y SidebarFooter con identidad de usuario, plan Ultra, balance de tokens y acceso a configuración."
        view={view}
      >
        {(mode) => (
          <div className="p2-stage">
            <div className="p2-sidebar-toolbar">
              <div className="p2-sidebar-modes">
                <button
                  type="button"
                  className={`p2-sidebar-mode-btn${sidebarMode === 'agent' ? ' is-active' : ''}`}
                  onClick={() => setSidebarMode('agent')}
                >
                  Agent ({agents.length})
                </button>
                <button
                  type="button"
                  className={`p2-sidebar-mode-btn${sidebarMode === 'chat' ? ' is-active' : ''}`}
                  onClick={() => setSidebarMode('chat')}
                >
                  Thread ({threads.length})
                </button>
                <button
                  type="button"
                  className={`p2-sidebar-mode-btn${sidebarMode === 'code' ? ' is-active' : ''}`}
                  onClick={() => setSidebarMode('code')}
                >
                  Workspace ({workspaces.length})
                </button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <SceneButton
                  mode={mode}
                  variant="ghost"
                  onClick={() => setSidebarCollapsed((v) => !v)}
                  style={{ fontSize: '11px', height: '26px', padding: '0 8px' }}
                >
                  {sidebarCollapsed ? 'Expandir barra' : 'Colapsar barra'}
                </SceneButton>
              </div>
            </div>

            <div className="p2-real-sidebar-stage">
              <div className="p2-real-sidebar-frame">
                <Sidebar
                  mode={sidebarMode}
                  hidden={sidebarCollapsed}
                  workspaces={workspaces}
                  agents={agents}
                  threads={threads}
                  selectedWorkspaceId={selectedWorkspaceId}
                  onSelectWorkspace={(id) => setSelectedWorkspaceId(id)}
                  selectedAgentId={selectedAgentId}
                  onSelectAgent={(id) => setSelectedAgentId(id)}
                  selectedThreadId={selectedThreadId}
                  onSelectThread={(id) => setSelectedThreadId(id)}
                  onNewAgent={() => {
                    const id = `ag-custom-${Date.now()}`;
                    setAgents((prev) => [
                      ...prev,
                      {
                        id,
                        name: 'Nuevo Agente',
                        engine: 'antigravity',
                        purpose: 'Agente interactivo creado desde la vista previa',
                        avatar: null,
                        createdAtUnixMs: Date.now(),
                        pinned: false,
                        order: prev.length,
                      },
                    ]);
                    setSelectedAgentId(id);
                  }}
                  onAddWorkspace={() => {
                    const id = `ws-custom-${Date.now()}`;
                    setWorkspaces((prev) => [
                      ...prev,
                      {
                        id,
                        displayName: 'nuevo-proyecto',
                        createdAtUnixMs: Date.now(),
                        lastOpenedAtUnixMs: Date.now(),
                        pinned: false,
                        available: true,
                      },
                    ]);
                    setSelectedWorkspaceId(id);
                  }}
                  onNewChat={() => {
                    const id = `th-custom-${Date.now()}`;
                    setThreads((prev) => [
                      {
                        id,
                        title: 'Nueva conversación exploratoria',
                        workspaceId: selectedWorkspaceId,
                        updatedAtUnixMs: Date.now(),
                        pinned: false,
                        status: 'idle',
                        provider: 'opencode',
                      },
                      ...prev,
                    ]);
                    setSelectedThreadId(id);
                  }}
                  onTogglePinAgent={(id, pinned) => {
                    setAgents((prev) =>
                      prev.map((a) => (a.id === id ? { ...a, pinned } : a))
                    );
                  }}
                  onTogglePinThread={(id, pinned) => {
                    setThreads((prev) =>
                      prev.map((t) => (t.id === id ? { ...t, pinned, isPinned: pinned } : t))
                    );
                  }}
                  onTogglePinWorkspace={(id, pinned) => {
                    setWorkspaces((prev) =>
                      prev.map((w) => (w.id === id ? { ...w, pinned } : w))
                    );
                  }}
                  onOpenSettings={() => {
                    alert('Ajustes de cuenta Kite: Ultra Plan activo.');
                  }}
                  appearance={appearance}
                  onToggleAppearance={() =>
                    setAppearance((curr) => (curr === 'dark' ? 'light' : 'dark'))
                  }
                  accountName="Federico"
                  accountTier="Ultra Plan"
                  accountTierPaid={true}
                  creditsLabel="12.4k tokens"
                  agentActivity={SEED_ACTIVITY}
                  availability={SEED_AVAILABILITY}
                />
              </div>

              {/* Detail Inspector next to the Sidebar */}
              <div className="p2-real-sidebar-inspector">
                {sidebarMode === 'agent' && (
                  <>
                    <div className="p2-real-sidebar-inspector__head">
                      <div className="p2-inspector-avatar-badge">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="12" cy="8" r="5" />
                          <path d="M20 21a8 8 0 1 0-16 0" />
                        </svg>
                      </div>
                      <div className="p2-real-sidebar-inspector__title">
                        <strong>{selectedAgent.name}</strong>
                        <span>Motor: {selectedAgent.engine} · {selectedAgent.pinned ? 'Fijado' : 'General'}</span>
                      </div>
                    </div>
                    <div className="p2-inspector-fields">
                      <div className="p2-inspector-row">
                        <span>Propósito</span>
                        <strong>{selectedAgent.purpose}</strong>
                      </div>
                      <div className="p2-inspector-row">
                        <span>Estado</span>
                        <strong>
                          {SEED_ACTIVITY[selectedAgent.id]?.runningCount
                            ? 'Ejecutando proceso'
                            : SEED_ACTIVITY[selectedAgent.id]?.needsYou
                            ? 'Esperando entrada'
                            : 'En reposo'}
                        </strong>
                      </div>
                      {SEED_ACTIVITY[selectedAgent.id]?.line && (
                        <div className="p2-inspector-row">
                          <span>Última línea</span>
                          <strong style={{ fontSize: '10px', color: 'var(--alab-accent)' }}>
                            {SEED_ACTIVITY[selectedAgent.id]?.line}
                          </strong>
                        </div>
                      )}
                    </div>
                  </>
                )}

                {sidebarMode === 'chat' && (
                  <>
                    <div className="p2-real-sidebar-inspector__head">
                      <div className="p2-inspector-avatar-badge">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                        </svg>
                      </div>
                      <div className="p2-real-sidebar-inspector__title">
                        <strong>{selectedThread.title}</strong>
                        <span>Proveedor: {selectedThread.provider || 'antigravity'}</span>
                      </div>
                    </div>
                    <div className="p2-inspector-fields">
                      <div className="p2-inspector-row">
                        <span>Estado del hilo</span>
                        <strong style={{ textTransform: 'capitalize' }}>{selectedThread.status || 'idle'}</strong>
                      </div>
                      <div className="p2-inspector-row">
                        <span>Workspace asociado</span>
                        <strong>{selectedThread.workspaceId || 'Global'}</strong>
                      </div>
                      <div className="p2-inspector-row">
                        <span>Fijado al inicio</span>
                        <strong>{selectedThread.pinned ? 'Sí' : 'No'}</strong>
                      </div>
                    </div>
                  </>
                )}

                {sidebarMode === 'code' && (
                  <>
                    <div className="p2-real-sidebar-inspector__head">
                      <div className="p2-inspector-avatar-badge">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        </svg>
                      </div>
                      <div className="p2-real-sidebar-inspector__title">
                        <strong>{selectedWorkspace.displayName}</strong>
                        <span>ID: {selectedWorkspace.id}</span>
                      </div>
                    </div>
                    <div className="p2-inspector-fields">
                      <div className="p2-inspector-row">
                        <span>Ruta local</span>
                        <strong>E:/kite</strong>
                      </div>
                      <div className="p2-inspector-row">
                        <span>Disponibilidad</span>
                        <strong style={{ color: '#34c759' }}>Online · Listo</strong>
                      </div>
                      <div className="p2-inspector-row">
                        <span>Sesiones activas</span>
                        <strong>2 terminales · 1 editor</strong>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </CompareScene>
    </>
  );
}
