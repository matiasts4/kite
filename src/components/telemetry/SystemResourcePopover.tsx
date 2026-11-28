import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  type SystemMetricsSnapshot,
  type SystemMetricsHistoryPoint,
  type SystemMetricsPreferences,
  type BadgeMetricDisplayMode,
  formatBytes,
  formatUptime,
  getPressureColors,
  saveSystemMetricsPreferences,
} from '../../lib/systemMetrics';
import { MOTION_EXIT_MS } from '../../motion/contract';
import { surfaceMotion } from '../../motion/standard/surfaces';
import { CircularGauge, Sparkline } from './TelemetryGauges';
import { MemoryProcessTab } from './tabs/MemoryProcessTab';
import { OverviewTab } from './tabs/OverviewTab';
import { CpuTab } from './tabs/CpuTab';
import { DiskTab } from './tabs/DiskTab';
import { ContextTab } from './tabs/ContextTab';
import { loadContextMonitor } from '../../lib/contextMonitor';
import { getRuntimeTransportMetrics, type RuntimeTransportMetrics } from '../../lib/ipc/chat';
import {
  ArrowRightIcon,
  CloseIcon,
  CpuChipIcon,
  InfoCircleIcon,
  RefreshIcon,
} from '../titlebar/TopbarPopoverIcons';
import '../titlebar/topbar-popovers.css';
import './telemetry-popover.css';

export interface SystemResourcePopoverProps {
  snapshot: SystemMetricsSnapshot;
  history: SystemMetricsHistoryPoint[];
  prefs: SystemMetricsPreferences;
  isRefreshing: boolean;
  onRefresh: () => void;
  onClose: () => void;
  anchorRect?: DOMRect | null;
  phase?: 'in' | 'out';
}

type ResourceTab = 'overview' | 'memory' | 'cpu' | 'disk' | 'context';

function getBreakdownTone(groupId: string): string {
  if (groupId === 'mcps') return 'mcps';
  if (groupId === 'agents') return 'agents';
  if (groupId === 'terminals') return 'terminals';
  if (groupId === 'webview') return 'webview';
  return 'core';
}

export const SystemResourcePopover: React.FC<SystemResourcePopoverProps> = ({
  snapshot,
  history,
  prefs,
  isRefreshing,
  onRefresh,
  onClose,
  anchorRect,
  phase = 'in',
}) => {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<ResourceTab>('overview');
  const [uiFps, setUiFps] = useState<number>(60);
  const [procCategoryFilter, setProcCategoryFilter] = useState<'all' | 'agents' | 'mcp' | 'terminals' | 'webview' | 'core' | 'build'>('all');
  const [procSearchQuery, setProcSearchQuery] = useState<string>('');
  const hasWorkspaces = Boolean(snapshot?.runtime.workspaces && snapshot.runtime.workspaces.length > 0);
  const [procViewMode, setProcViewMode] = useState<'projects' | 'terminals' | 'flat'>(hasWorkspaces ? 'projects' : 'flat');
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const [contextSummary, setContextSummary] = useState<{
    tokensSaved: number;
    savingsPercent: number;
    requests: number;
    wastedTurn0Tokens?: number;
  } | null>(null);
  const [transportMetrics, setTransportMetrics] = useState<RuntimeTransportMetrics | null>(null);

  useEffect(() => {
    let active = true;
    void loadContextMonitor().then((res) => {
      if (active && res.status === 'online') {
        setContextSummary({
          tokensSaved: res.view.lifetime.tokensSaved,
          savingsPercent: res.view.lifetime.savingsPercent,
          requests: res.view.lifetime.requests,
          wastedTurn0Tokens: res.view.audit.wastedTokens,
        });
      }
    });
    return () => {
      active = false;
    };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'overview') {
      return;
    }
    let active = true;
    void Promise.resolve(getRuntimeTransportMetrics())
      .then((metrics) => {
        if (active) {
          setTransportMetrics(metrics ?? null);
        }
      })
      .catch((err) => {
        console.warn('[SystemResourcePopover] Failed to load runtime transport metrics:', err);
        if (active) {
          setTransportMetrics(null);
        }
      });
    return () => {
      active = false;
    };
  }, [activeTab]);

  // Measure live UI frame rate only on tabs that render the FPS readout
  useEffect(() => {
    if (activeTab !== 'overview' && activeTab !== 'cpu') {
      return;
    }
    let frameCount = 0;
    let lastTime = performance.now();
    let rafId = 0;
    const tick = (now: number) => {
      frameCount += 1;
      const elapsed = now - lastTime;
      if (elapsed >= 600) {
        const currentFps = Math.min(144, Math.max(1, Math.round((frameCount * 1000) / elapsed)));
        setUiFps((prev) => (prev === currentFps ? prev : currentFps));
        frameCount = 0;
        lastTime = now;
      }
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [activeTab]);

  // Position anchored to the TitleBar pill
  const [position, setPosition] = useState<{ top: number; right: number }>({ top: 44, right: 80 });

  useEffect(() => {
    if (anchorRect) {
      const top = Math.round(anchorRect.bottom + 6);
      const right = Math.max(12, Math.round(window.innerWidth - anchorRect.right));
      setPosition({ top, right });
    }
  }, [anchorRect]);

  // Close on click outside or Escape
  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (popoverRef.current && !popoverRef.current.contains(target)) {
        if (!target.closest('.system-resource-badge')) {
          onClose();
        }
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const pressureTheme = useMemo(
    () => getPressureColors(snapshot.memory.pressure),
    [snapshot.memory.pressure]
  );
  const appRamHistory = useMemo(() => history.map((h) => h.appRamMb), [history]);
  const appCpuHistory = useMemo(() => history.map((h) => h.appCpuPct), [history]);
  const sysCpuHistory = useMemo(() => history.map((h) => h.sysCpuPct), [history]);

  const cpuColor =
    snapshot.cpu.systemUsagePercent > 80
      ? 'var(--status-failed)'
      : snapshot.cpu.systemUsagePercent > 50
        ? 'var(--warning-text)'
        : 'var(--accent)';

  const diskColor =
    snapshot.disk.usagePercent > 90
      ? 'var(--status-failed)'
      : snapshot.disk.usagePercent > 75
        ? 'var(--warning-text)'
        : 'var(--tm-violet)';

  const intervals: Array<2000 | 3000 | 5000 | 10000> = [2000, 3000, 5000, 10000];
  const badgeModes: Array<{ id: BadgeMetricDisplayMode; label: string }> = [
    { id: 'ram_only', label: 'Solo RAM' },
    { id: 'ram_and_cpu', label: 'RAM + CPU' },
    { id: 'ram_percent', label: '% Sistema' },
  ];

  const breakdownItems = snapshot.runtime.breakdown.map((group) => {
    const pctOfApp =
      snapshot.memory.appTotalBytes > 0
        ? Math.round((group.memoryBytes / snapshot.memory.appTotalBytes) * 100)
        : 0;
    return {
      ...group,
      pctOfApp,
      tone: getBreakdownTone(group.id),
    };
  });

  const popoverNode = (
    <motion.div
      {...surfaceMotion('popover', { exitMs: MOTION_EXIT_MS })}
      ref={popoverRef}
      role="dialog"
      aria-label="Monitor de recursos del sistema y de la aplicación"
      className="tp-popover tp-popover--opaque system-resource-popover"
      style={{
        top: `${position.top}px`,
        right: `${position.right}px`,
        background: 'var(--menu-plate, var(--pane))',
        backdropFilter: 'none',
        WebkitBackdropFilter: 'none',
        contain: 'layout style paint',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Top Header */}
      <div className="tp-popover__header">
        <div className="tp-popover__identity">
          <div
            className="tm-emblem"
            style={{
              backgroundColor: pressureTheme.tint,
              borderColor: pressureTheme.stroke,
              color: pressureTheme.color,
            }}
            aria-hidden="true"
          >
            <CpuChipIcon size={14} />
          </div>
          <div className="tp-popover__title-group">
            <div className="tp-popover__title-row">
              <h3 className="tp-popover__title">Monitor de Recursos</h3>
              <span
                className="tm-pressure-pill"
                style={{
                  backgroundColor: pressureTheme.tint,
                  color: pressureTheme.color,
                  borderColor: pressureTheme.stroke,
                }}
              >
                <span className="tm-pressure-pill__dot" aria-hidden="true" />
                {pressureTheme.label}
              </span>
            </div>
            <div className="tp-popover__subtitle">
              PID {snapshot.pid} · Activo {formatUptime(snapshot.uptimeSeconds)} · IPC{' '}
              {snapshot.ipcLatencyMs}ms
            </div>
          </div>
        </div>

        {/* Refresh & Close Controls */}
        <div className="tp-popover__actions">
          <button
            type="button"
            className="tp-icon-btn"
            onClick={onRefresh}
            title="Actualizar métricas ahora"
            aria-label="Actualizar métricas ahora"
          >
            <RefreshIcon size={13} className={isRefreshing ? 'tp-spin' : undefined} />
          </button>

          <button
            type="button"
            className="tp-icon-btn"
            onClick={onClose}
            title="Cerrar"
            aria-label="Cerrar monitor de recursos"
          >
            <CloseIcon size={14} />
          </button>
        </div>
      </div>

      {/* Category Switcher Tabs */}
      <div className="tm-tabs-wrap">
        <div
          role="tablist"
          aria-label="Categorías de consumo"
          className="tp-segmented tm-tabs"
        >
          {(
            [
              { id: 'overview', label: 'Resumen' },
              { id: 'memory', label: 'RAM' },
              { id: 'cpu', label: 'CPU' },
              { id: 'disk', label: 'Disco' },
              { id: 'context', label: 'Contexto' },
            ] as const
          ).map((tab) => {
            const isSelected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isSelected}
                onClick={() => setActiveTab(tab.id)}
                className="tp-segmented__item"
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Content Area — compositor-isolated single scroll viewport */}
      <div
        className="system-resource-popover__scroll scroll-quiet"
        style={{
          transform: 'translateZ(0)',
          willChange: 'scroll-position',
          contain: 'content',
          overscrollBehavior: 'contain',
        }}
      >
        {/* HERO CARD: App Total RAM (Visible in Overview & Memory) */}
        {(activeTab === 'overview' || activeTab === 'memory') && (
          <div className="tm-hero-card">
            <div className="tm-hero-top">
              <div className="tm-hero-left">
                <CircularGauge
                  percentage={snapshot.memory.systemUsagePercent}
                  color={pressureTheme.color}
                  label={`${Math.round(snapshot.memory.systemUsagePercent)}%`}
                />
                <div>
                  <div className="tm-hero-kicker">RAM Total de la Aplicación</div>
                  <div className="tm-hero-value">
                    {formatBytes(snapshot.memory.appTotalBytes)}
                  </div>
                  <div className="tm-hero-sub">
                    {snapshot.memory.appShareOfSystemPercent}% de{' '}
                    {formatBytes(snapshot.memory.systemTotalBytes, 0)} del sistema
                    {snapshot.memory.appPrivateBytes != null && (
                      <span className="tm-hero-sub--accent">
                        · {formatBytes(snapshot.memory.appPrivateBytes)} priv.
                      </span>
                    )}
                  </div>
                  <div className="tm-hero-sub">
                    UI + Core: <strong>{formatBytes(snapshot.memory.appCoreBytes)}</strong>
                    {' · '}
                    Agentes:{' '}
                    <strong>
                      {formatBytes(
                        snapshot.memory.appAgentsBytes ?? snapshot.memory.appTerminalsBytes
                      )}
                    </strong>
                    {snapshot.memory.appMcpsBytes != null && snapshot.memory.appMcpsBytes > 0 && (
                      <>
                        {' · '}
                        MCPs:{' '}
                        <strong className="tm-hero-sub--violet">
                          {formatBytes(snapshot.memory.appMcpsBytes)}
                        </strong>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div className="tm-hero-spark">
                <Sparkline
                  values={appRamHistory}
                  color={pressureTheme.color}
                  width={114}
                  height={34}
                />
                <span className="tm-hero-spark__caption">
                  Evolución en vivo ({history.length} muestras)
                </span>
              </div>
            </div>

            {/* Explanatory note in Memory Tab */}
            {activeTab === 'memory' && (
              <div className="tm-callout">
                <InfoCircleIcon size={13} />
                <div>
                  <strong>¿Por qué varía el consumo?</strong> La{' '}
                  <em>Memoria Privada</em> es la RAM exclusiva reservada por Kite y los agentes. El{' '}
                  <em>Working Set</em> incluye páginas compartidas de Windows y Chromium multi-contadas por
                  proceso, y varía bruscamente al nacer o morir subprocesos de compilación o tests.
                </div>
              </div>
            )}

            {/* Unified Segmented Memory Allocation Bar & Legend */}
            <div className="tm-alloc-section">
              {breakdownItems.length > 0 && (
                <div className="tm-alloc-bar" aria-hidden="true">
                  {breakdownItems.map((group) => (
                    <div
                      key={group.id}
                      className={`tm-alloc-seg tm-alloc-seg--${group.tone}`}
                      style={{ width: `${Math.max(4, group.pctOfApp)}%` }}
                    />
                  ))}
                </div>
              )}

              <div className="tm-breakdown-list">
                {breakdownItems.map((group) => (
                  <div key={group.id} className="tm-breakdown-row">
                    <div className="tm-breakdown-left">
                      <span className={`tm-dot tm-dot--${group.tone}`} aria-hidden="true" />
                      <span className="tm-breakdown-label">{group.label}</span>
                      <span className="tm-breakdown-count">({group.processCount} proc.)</span>
                    </div>
                    <div className="tm-breakdown-value">
                      {formatBytes(group.memoryBytes)}{' '}
                      <span className="tm-breakdown-pct">({group.pctOfApp}%)</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Jump to Memory Details button in overview */}
              {activeTab === 'overview' && (
                <button
                  type="button"
                  className="tm-nav-row"
                  onClick={() => setActiveTab('memory')}
                >
                  <span>
                    Ver desglose de subprocesos (
                    {snapshot.runtime.processes?.length || snapshot.runtime.processCount} activos)
                  </span>
                  <span className="tm-nav-row__cta">
                    <ArrowRightIcon size={12} />
                  </span>
                </button>
              )}

              {/* System Host RAM & JS Heap Spec Sheet */}
              <div className="tm-spec-sheet">
                <div className="tm-spec-row">
                  <span className="tm-spec-label">RAM Física del Equipo:</span>
                  <span className="tm-spec-val">
                    {formatBytes(snapshot.memory.systemUsedBytes)} /{' '}
                    {formatBytes(snapshot.memory.systemTotalBytes)} (
                    {snapshot.memory.systemUsagePercent}%)
                  </span>
                </div>

                {snapshot.memory.jsHeapUsedBytes != null && (
                  <div className="tm-spec-row">
                    <span className="tm-spec-label">Memoria Heap JS (V8 UI):</span>
                    <span className="tm-spec-val">
                      {formatBytes(snapshot.memory.jsHeapUsedBytes)}
                      {snapshot.memory.jsHeapLimitBytes
                        ? ` / ${formatBytes(snapshot.memory.jsHeapLimitBytes, 0)}`
                        : ''}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* DETAILED PROCESS BREAKDOWN (Exclusively in Memory Tab) */}
        {activeTab === 'memory' && (
          <MemoryProcessTab
            snapshot={snapshot}
            onRefresh={onRefresh}
            procCategoryFilter={procCategoryFilter}
            setProcCategoryFilter={setProcCategoryFilter}
            procSearchQuery={procSearchQuery}
            setProcSearchQuery={setProcSearchQuery}
            procViewMode={procViewMode}
            setProcViewMode={setProcViewMode}
            expandedSections={expandedSections}
            setExpandedSections={setExpandedSections}
          />
        )}

        {/* OVERVIEW GRID: CPU, Disk, & Runtime Health Cards */}
        {activeTab === 'overview' && (
          <OverviewTab
            snapshot={snapshot}
            appCpuHistory={appCpuHistory}
            cpuColor={cpuColor}
            diskColor={diskColor}
            uiFps={uiFps}
            contextSummary={contextSummary}
            transportMetrics={transportMetrics}
            onSelectTab={setActiveTab}
          />
        )}

        {/* DETAILED CPU TAB */}
        {activeTab === 'cpu' && (
          <CpuTab
            snapshot={snapshot}
            sysCpuHistory={sysCpuHistory}
            cpuColor={cpuColor}
            uiFps={uiFps}
          />
        )}

        {/* DETAILED DISK TAB */}
        {activeTab === 'disk' && (
          <DiskTab
            snapshot={snapshot}
            diskColor={diskColor}
          />
        )}

        {/* CONTEXT ENGINE TELEMETRY TAB */}
        {activeTab === 'context' && <ContextTab />}
      </div>

      {/* Footer Controls: Update Frequency & Badge Display Mode */}
      <div className="tm-footer">
        <div className="tm-footer__row">
          <span className="tm-footer__label">Mostrar en barra superior:</span>
          <div className="tm-footer-seg">
            {badgeModes.map((m) => {
              const active = prefs.badgeMode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  className={`tm-footer-seg__btn${active ? ' tm-footer-seg__btn--active' : ''}`}
                  onClick={() => saveSystemMetricsPreferences({ badgeMode: m.id })}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="tm-footer__row">
          <span className="tm-footer__label">Frecuencia de actualización:</span>
          <div className="tm-footer-seg">
            {intervals.map((ms) => {
              const active = prefs.refreshIntervalMs === ms;
              return (
                <button
                  key={ms}
                  type="button"
                  className={`tm-footer-seg__btn${active ? ' tm-footer-seg__btn--active' : ''}`}
                  onClick={() => saveSystemMetricsPreferences({ refreshIntervalMs: ms })}
                >
                  {ms / 1000}s
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </motion.div>
  );

  return createPortal(
    <AnimatePresence>{phase === 'in' && popoverNode}</AnimatePresence>,
    document.body
  );
};
