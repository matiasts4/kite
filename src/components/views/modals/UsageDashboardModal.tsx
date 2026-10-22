import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { invokeCommand } from '../../../lib/ipc';
import { usePresence } from '../../../motion/usePresence';
import { motionSurfaceClass } from '../../../motion/surface';
import './usageDashboard.css';

export interface UsageDashboardModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface UsageDay {
  day: string;
  total: number;
}

interface UsageWindow {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
}

interface AgentUsageEntry {
  engine: string;
  today: UsageWindow;
  last7Days: UsageWindow;
  last30Days: UsageWindow;
  allTime: UsageWindow;
  firstDay: string | null;
  activeDays: number;
  days: UsageDay[];
}

interface AgentUsageSnapshot {
  generatedAtMs: number;
  refreshIncomplete: boolean;
  scannedFiles: number;
  agents: AgentUsageEntry[];
}

const ENGINES = ['claude-code', 'codex', 'grok', 'open-code', 'gemini', 'droid', 'cursor'] as const;

const ENGINE_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  grok: 'Grok Build',
  'open-code': 'OpenCode',
  gemini: 'Gemini',
  droid: 'Droid',
  cursor: 'Cursor',
};

// Compact token label
function compactTokenLabel(val: number): string {
  const n = Math.max(0, val);
  const units: [number, string][] = [
    [1, ''],
    [1e3, 'k'],
    [1e6, 'M'],
    [1e9, 'B'],
  ];
  let r = 0;
  while (r + 1 < units.length && n >= units[r + 1][0]) {
    r += 1;
  }
  for (;;) {
    const [t, unit] = units[r] ?? [1, ''];
    const a = n / t;
    const o = t === 1 || a >= 100 ? Math.round(a) : Math.round(a * 10) / 10;
    if (o >= 1e3 && r + 1 < units.length) {
      r += 1;
      continue;
    }
    return `${o}${unit}`;
  }
}

function formatDateKey(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function getPastDate(daysAgo: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d;
}

function usageIntensity(val: number, max: number): number {
  if (val <= 0 || max <= 0) return 0;
  const ratio = val / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.45) return 3;
  if (ratio > 0.2) return 2;
  return 1;
}

// Brand Logo component
const EngineLogo: React.FC<{ engine: string; size?: number }> = ({ engine, size = 18 }) => {
  switch (engine) {
    case 'claude-code':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill="#d97757" />
          <path d="M8 15.5l4-7 4 7m-6.5-2.5h5" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'codex':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill="#3b82f6" />
          <path d="M7 10l5-3 5 3v4l-5 3-5-3v-4z" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'grok':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill="#52525b" />
          <path d="M8 8l8 8m0-8l-8 8" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      );
    case 'open-code':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill="#06b6d4" />
          <path d="M9 8l-3 4 3 4m6-8l3 4-3 4" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'gemini':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill="#8b5cf6" />
          <path d="M12 5c0 3.866 3.134 7 7 7-3.866 0-7 3.134-7 7 0-3.866-3.134-7-7-7 3.866 0 7-3.134 7-7z" fill="#ffffff" />
        </svg>
      );
    case 'droid':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill="#e88d42" />
          <path d="M7 13a5 5 0 0 1 10 0v2H7v-2zm2-2l-1.5-2m6.5 2l1.5-2" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case 'cursor':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill="#94a3b8" />
          <polygon points="7 6 7 17 11 13 16 13 7 6" fill="#ffffff" />
        </svg>
      );
    default:
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill="#3b82f6" />
          <circle cx="12" cy="12" r="4" fill="#ffffff" />
        </svg>
      );
  }
};

export const UsageDashboardModal: React.FC<UsageDashboardModalProps> = ({ isOpen, onClose }) => {
  const layerPresence = usePresence(isOpen);
  const [snapshot, setSnapshot] = useState<AgentUsageSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [scanning, setScanning] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState<boolean>(false);
  const shareBtnRef = useRef<HTMLButtonElement | null>(null);

  const fetchSnapshot = useCallback(async () => {
    try {
      setLoading(true);
      const res = await invokeCommand<AgentUsageSnapshot>('agent_usage_snapshot');
      if (res) {
        setSnapshot(res);
      }
    } catch (err) {
      console.warn('[UsageDashboardModal] Error fetching snapshot:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleRescan = useCallback(async () => {
    try {
      setScanning(true);
      setStatusMessage('Rescanning local agent logs…');
      const res = await invokeCommand<AgentUsageSnapshot>('agent_usage_snapshot');
      if (res) {
        setSnapshot(res);
      }
      setStatusMessage('Log rescan completed.');
      setTimeout(() => setStatusMessage(null), 3000);
    } catch (err) {
      console.warn('[UsageDashboardModal] Error rescanning:', err);
      setStatusMessage('Rescan failed.');
      setTimeout(() => setStatusMessage(null), 3000);
    } finally {
      setScanning(false);
    }
  }, []);

  const handleSaveCard = async (period: 'today' | 'week') => {
    setShareOpen(false);
    try {
      setStatusMessage('Saving usage share card…');
      await invokeCommand('agent_usage_save_card', { period });
      setStatusMessage(`Usage card saved for ${period === 'today' ? 'today' : 'last 7 days'}.`);
      setTimeout(() => setStatusMessage(null), 3500);
    } catch {
      setStatusMessage('Card could not be saved to desktop.');
      setTimeout(() => setStatusMessage(null), 3000);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchSnapshot();
    }
  }, [isOpen, fetchSnapshot]);

  // Handle ESC key
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // Calculations
  const agents = useMemo(() => snapshot?.agents || [], [snapshot]);

  const lifetimeTotal = useMemo(() => {
    return agents.reduce((sum, a) => sum + (a.allTime?.total || 0), 0);
  }, [agents]);

  const todayTotal = useMemo(() => {
    return agents.reduce((sum, a) => sum + (a.today?.total || 0), 0);
  }, [agents]);

  const mergedDaysMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of agents) {
      for (const d of a.days || []) {
        map.set(d.day, (map.get(d.day) ?? 0) + d.total);
      }
    }
    return map;
  }, [agents]);

  const bestDay = useMemo(() => {
    let best: { day: string; total: number } | null = null;
    for (const [day, total] of mergedDaysMap.entries()) {
      if (!best || total > best.total || (total === best.total && day < best.day)) {
        best = { day, total };
      }
    }
    return best;
  }, [mergedDaysMap]);

  const activeDaysCount = useMemo(() => mergedDaysMap.size, [mergedDaysMap]);

  const firstDay = useMemo(() => {
    const list = agents
      .map((a) => a.firstDay)
      .filter((d): d is string => Boolean(d))
      .sort();
    return list[0] ?? null;
  }, [agents]);

  // 26 Weeks Heatmap
  const maxDayVal = useMemo(() => {
    return Math.max(0, ...Array.from(mergedDaysMap.values()));
  }, [mergedDaysMap]);

  const heatmapCols = useMemo(() => {
    const offset = 175 + new Date().getDay();
    return Array.from({ length: 26 }, (_, colIdx) =>
      Array.from({ length: 7 }, (_, rowIdx) => {
        const daysAgo = offset - (colIdx * 7 + rowIdx);
        if (daysAgo < 0) return null;
        const dStr = formatDateKey(getPastDate(daysAgo));
        return {
          day: dStr,
          total: mergedDaysMap.get(dStr) ?? 0,
        };
      })
    );
  }, [mergedDaysMap]);

  // 30 Days Bar Chart
  const days30 = useMemo(() => {
    const engineDaysMap = new Map<string, Map<string, number>>();
    for (const a of agents) {
      engineDaysMap.set(a.engine, new Map((a.days || []).map((d) => [d.day, d.total])));
    }

    const res = Array.from({ length: 30 }, (_, idx) => {
      const dStr = formatDateKey(getPastDate(29 - idx));
      const segments = ENGINES.map((eng) => ({
        engine: eng,
        total: engineDaysMap.get(eng)?.get(dStr) ?? 0,
      })).filter((s) => s.total > 0);
      const total = segments.reduce((sum, s) => sum + s.total, 0);
      return { day: dStr, segments, total };
    });

    return res;
  }, [agents]);

  const peak30Days = useMemo(() => {
    return Math.max(1, ...days30.map((d) => d.total));
  }, [days30]);

  // By Agent
  const maxAgentTotal = useMemo(() => {
    return Math.max(1, lifetimeTotal);
  }, [lifetimeTotal]);

  if (!layerPresence.mounted) return null;

  const scrimMotion = motionSurfaceClass(layerPresence.phase, 'scrim');
  const modalMotion = motionSurfaceClass(layerPresence.phase, 'modal');

  const modalContent = (
    <div
      className={`usage-dash-portal-backdrop${scrimMotion ? ` ${scrimMotion}` : ''}`}
      onClick={onClose}
      role="presentation"
    >
      <dialog
        aria-describedby="usage-dash-desc"
        aria-labelledby="usage-dash-title"
        className={`ui-sheet usage-dash${modalMotion ? ` ${modalMotion}` : ''}`}
        onClick={(e) => e.stopPropagation()}
        open
      >
        <form className="ui-sheet__form" onSubmit={(e) => e.preventDefault()}>
          <header className="ui-sheet__heading">
            <h2 className="ui-sheet__title" id="usage-dash-title">
              Token usage
            </h2>
            <div className="ui-sheet__description" id="usage-dash-desc">
              Scanned from your coding agents’ local logs · this machine
            </div>
          </header>

          <img
            alt=""
            aria-hidden="true"
            className="usage-dash__logo"
            src="/assets/kite-symbol.png"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />

          <div className="usage-dash__actions">
            {scanning && (
              <span className="usage-dash__scanning">
                <svg
                  className="animate-spin"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  aria-hidden="true"
                >
                  <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                </svg>
                Scanning…
              </span>
            )}

            <button
              aria-expanded={shareOpen}
              aria-haspopup="menu"
              className={`usage-dash__share${shareOpen ? ' usage-dash__share--open' : ''}`}
              disabled={loading}
              onClick={() => setShareOpen((v) => !v)}
              ref={shareBtnRef}
              title="Save a shareable PNG of your usage"
              type="button"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M12 2v13" />
                <path d="m16 6-4-4-4 4" />
                <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
              </svg>
              Share
            </button>

            {shareOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: '40px',
                  right: '80px',
                  background: 'var(--pane, #1e1e1f)',
                  border: '1px solid var(--block-stroke, rgba(255,255,255,0.1))',
                  borderRadius: 'var(--radius-chip, 6px)',
                  padding: '4px',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                  zIndex: 20,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '2px',
                  minWidth: '160px',
                }}
              >
                <button
                  type="button"
                  onClick={() => handleSaveCard('today')}
                  className="settings-rail__row"
                  style={{ height: '28px', fontSize: '12px' }}
                >
                  Save today’s card
                </button>
                <button
                  type="button"
                  onClick={() => handleSaveCard('week')}
                  className="settings-rail__row"
                  style={{ height: '28px', fontSize: '12px' }}
                >
                  Save last 7 days card
                </button>
              </div>
            )}

            <button
              className="settings-rail__back"
              disabled={scanning || loading}
              onClick={handleRescan}
              title="Rescan agent logs"
              type="button"
              style={{ padding: '0 8px' }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                <path d="M21 3v5h-5" />
              </svg>
            </button>

            <button
              className="settings-rail__back"
              onClick={onClose}
              title="Close"
              type="button"
              style={{ padding: '0 8px' }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>

          <div aria-hidden="true" className="usage-dash__rule" />

          <div className="usage-dash__main">
            {statusMessage && (
              <p className="usage-dash__status" role="status">
                {statusMessage}
              </p>
            )}

            {loading && !snapshot ? (
              <p className="usage-dash__status" role="status">
                <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true" style={{ marginRight: '6px' }}>
                  <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                </svg>
                Scanning agent logs — the first scan can take a minute…
              </p>
            ) : (
              <div className="usage-dash__scroll scroll-quiet">
                {snapshot?.refreshIncomplete && (
                  <p className="usage-dash__partial" role="status">
                    Showing a bounded partial refresh after scanning {snapshot.scannedFiles.toLocaleString()} files.
                  </p>
                )}

                {/* Metric Summary Tiles */}
                <div className="usage-dash__tiles">
                  <div className="usage-dash__tile">
                    <span className="usage-dash__tile-label">Lifetime</span>
                    <span className="usage-dash__tile-value">{compactTokenLabel(lifetimeTotal)}</span>
                    <span className="usage-dash__tile-detail">
                      {firstDay ? `since ${firstDay}` : 'no usage found yet'}
                    </span>
                  </div>

                  <div className="usage-dash__tile">
                    <span className="usage-dash__tile-label">Today</span>
                    <span className="usage-dash__tile-value">{compactTokenLabel(todayTotal)}</span>
                    <span className="usage-dash__tile-detail">all agents</span>
                  </div>

                  <div className="usage-dash__tile">
                    <span className="usage-dash__tile-label">Best day</span>
                    <span className="usage-dash__tile-value">{compactTokenLabel(bestDay?.total ?? 0)}</span>
                    <span className="usage-dash__tile-detail">{bestDay?.day ?? '—'}</span>
                  </div>

                  <div className="usage-dash__tile">
                    <span className="usage-dash__tile-label">Active days</span>
                    <span className="usage-dash__tile-value">{activeDaysCount}</span>
                    <span className="usage-dash__tile-detail">with any usage</span>
                  </div>
                </div>

                {/* 26 Weeks Daily Activity Heatmap */}
                <section className="usage-dash__card">
                  <h2>
                    Daily activity <span>last 26 weeks</span>
                  </h2>
                  <div className="usage-dash__heatmap-wrap">
                    <div className="usage-dash__heatmap" role="img" aria-label="Daily activity, last 26 weeks">
                      {heatmapCols.map((col, colIdx) => (
                        <div key={colIdx} className="usage-dash__heat-col">
                          {col.map((cell, rowIdx) =>
                            cell === null ? (
                              <i key={rowIdx} className="usage-dash__heat-cell usage-dash__heat-cell--void" />
                            ) : (
                              <i
                                key={cell.day}
                                className={`usage-dash__heat-cell usage-dash__heat-cell--${usageIntensity(
                                  cell.total,
                                  maxDayVal
                                )}`}
                                title={`${cell.day} — ${compactTokenLabel(cell.total)} tokens`}
                              />
                            )
                          )}
                        </div>
                      ))}
                    </div>

                    <div aria-hidden="true" className="usage-dash__heat-legend">
                      less
                      {[0, 1, 2, 3, 4].map((lvl) => (
                        <i key={lvl} className={`usage-dash__heat-cell usage-dash__heat-cell--${lvl}`} />
                      ))}
                      more
                    </div>
                  </div>
                </section>

                {/* 30 Days Bar Chart */}
                <section className="usage-dash__card">
                  <h2>
                    Last 30 days <span>tokens per day by agent</span>
                  </h2>
                  <div className="usage-dash__chart-wrap">
                    <div className="usage-dash__chart" role="img" aria-label="Tokens per day, last 30 days">
                      {days30.map((d) => (
                        <div
                          key={d.day}
                          className="usage-dash__bar"
                          title={`${d.day} — ${compactTokenLabel(d.total)} tokens`}
                        >
                          {d.segments.map((seg) => (
                            <i
                              key={seg.engine}
                              className={`usage-dash__bar-seg usage-dash__seg--${seg.engine}`}
                              style={{ height: `${(seg.total / peak30Days) * 100}%` }}
                            />
                          ))}
                        </div>
                      ))}
                    </div>

                    <div className="usage-dash__chart-meta">
                      <span>{days30[0]?.day}</span>
                      <span className="usage-dash__chart-max">peak {compactTokenLabel(peak30Days)}</span>
                      <span>{days30[days30.length - 1]?.day}</span>
                    </div>

                    <div className="usage-dash__legend">
                      {ENGINES.map((eng) => (
                        <span key={eng} className="usage-dash__legend-item">
                          <i className={`usage-dash__legend-dot usage-dash__seg--${eng}`} />
                          {ENGINE_LABELS[eng]}
                        </span>
                      ))}
                    </div>
                  </div>
                </section>

                {/* Breakdown By Agent All Time */}
                <section className="usage-dash__card">
                  <h2>
                    By agent <span>all time</span>
                  </h2>
                  <ul className="usage-dash__agents">
                    {ENGINES.map((eng) => {
                      const agent = agents.find((a) => a.engine === eng);
                      const allTime = agent?.allTime;
                      const total = allTime?.total ?? 0;
                      const pct = maxAgentTotal > 0 ? (total / maxAgentTotal) * 100 : 0;
                      const cacheTotal = (allTime?.cacheRead ?? 0) + (allTime?.cacheWrite ?? 0);

                      return (
                        <li key={eng} className="usage-dash__agent">
                          <EngineLogo engine={eng} size={18} />
                          <div className="usage-dash__agent-body">
                            <div className="usage-dash__agent-head">
                              <span className="usage-dash__agent-name">{ENGINE_LABELS[eng]}</span>
                              <span className="usage-dash__agent-total">{compactTokenLabel(total)}</span>
                            </div>

                            <div className="usage-dash__agent-track">
                              <i
                                className={`usage-dash__agent-fill usage-dash__seg--${eng}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>

                            <span className="usage-dash__agent-breakdown">
                              in {compactTokenLabel(allTime?.input ?? 0)} · out{' '}
                              {compactTokenLabel(allTime?.output ?? 0)} · cache{' '}
                              {compactTokenLabel(cacheTotal)} · {agent?.activeDays ?? 0} active days
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              </div>
            )}
          </div>
        </form>
      </dialog>
    </div>
  );

  return createPortal(modalContent, document.body);
};
