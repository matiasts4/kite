import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { QuotaProgressRing } from './QuotaProgressRing';
import { formatDetailedReset, useResetCountdownClock } from '../../lib/quota/useResetCountdownClock';
import {
  type ProviderQuotaStatus,
  type QuotaPreferences,
  PROVIDER_LABELS,
  SHORT_PROVIDER_LABELS,
  resolveEnabledProviderIds,
} from '../../lib/quota/types';
import { diagnoseProvider } from '../../lib/quota/providerState';
import { BrandLogo } from '../views/agents/engineMetadata';
import { saveQuotaPreferences } from '../../lib/quota/quotaManager';
import { openSettingsTab } from '../../lib/settingsNav';
import { MOTION_EXIT_MS } from '../../motion/contract';
import { surfaceMotion } from '../../motion/standard/surfaces';

export interface SubscriptionQuotaPopoverProps {
  allQuotas: Record<string, ProviderQuotaStatus>;
  selectedProvider: string;
  onSelectProvider: (providerId: string) => void;
  onRefresh: () => void;
  isRefreshing?: boolean;
  onClose: () => void;
  onOpenTokenUsage?: () => void;
  prefs: QuotaPreferences;
  anchorRect?: DOMRect | null;
  phase?: 'in' | 'out';
}

export const SubscriptionQuotaPopover: React.FC<SubscriptionQuotaPopoverProps> = ({
  allQuotas,
  selectedProvider,
  onSelectProvider,
  onRefresh,
  isRefreshing = false,
  onClose,
  onOpenTokenUsage,
  prefs,
  anchorRect,
  phase = 'in',
}) => {
  const popoverRef = useRef<HTMLDivElement>(null);

  const handleOpenSettings = (providerId?: string) => {
    onClose();
    openSettingsTab('quotas', providerId);
  };
  const openAccounts = () => handleOpenSettings(selectedProvider);

  const currentQuota = allQuotas[selectedProvider] || null;
  const diagnostic = diagnoseProvider(currentQuota);
  const activeIds = resolveEnabledProviderIds(prefs);
  const activeIdsKey = activeIds.join('|');

  const resetCountdown = useResetCountdownClock(currentQuota?.timeUntilResetMs);
  const hasData = diagnostic.state === 'ok';
  const remPct = hasData ? currentQuota?.primaryRemainingPercent ?? 100 : null;

  // Horizontal navigation for the provider tab strip (more than 3 providers
  // overflow the popover header on narrow widths).
  const tabsRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateTabScrollState = useCallback(() => {
    const el = tabsRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft < max - 1);
  }, []);

  useEffect(() => {
    updateTabScrollState();
    const el = tabsRef.current;
    if (!el) return;
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateTabScrollState) : null;
    observer?.observe(el);
    el.addEventListener('scroll', updateTabScrollState, { passive: true });
    window.addEventListener('resize', updateTabScrollState);
    return () => {
      observer?.disconnect();
      el.removeEventListener('scroll', updateTabScrollState);
      window.removeEventListener('resize', updateTabScrollState);
    };
  }, [updateTabScrollState, activeIdsKey]);

  // Keep the selected tab visible when switching providers.
  useEffect(() => {
    const el = tabsRef.current?.querySelector<HTMLElement>(
      `[data-provider-tab="${selectedProvider}"]`
    );
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [selectedProvider]);

  const scrollTabs = (direction: -1 | 1) => {
    tabsRef.current?.scrollBy({ left: direction * 140, behavior: 'smooth' });
  };

  // Compute fixed position anchored to the badge
  const [position, setPosition] = useState<{ top: number; right: number }>({ top: 44, right: 16 });

  useEffect(() => {
    if (anchorRect) {
      const top = anchorRect.bottom + 6;
      const right = Math.max(12, window.innerWidth - anchorRect.right);
      setPosition({ top, right });
    }
  }, [anchorRect]);

  // Close on outside click
  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (popoverRef.current && !popoverRef.current.contains(target)) {
        if (!target.closest('.subscription-quota-badge')) {
          onClose();
        }
      }
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [onClose]);

  const popoverNode = (
    <motion.div
      {...surfaceMotion('popover', { exitMs: MOTION_EXIT_MS })}
      ref={popoverRef}
      role="dialog"
      aria-label="Cuotas de suscripción IA"
      className="subscription-quota-popover"
      style={{
        position: 'fixed',
        top: `${position.top}px`,
        right: `${position.right}px`,
        // The panel's right edge sits under the badge, so it grows from that corner.
        transformOrigin: 'top right',
        width: '410px',
        maxWidth: 'calc(100vw - 24px)',
        maxHeight: 'calc(100vh - 60px)',
        backgroundColor: 'var(--menu-glass, #121214)',
        backdropFilter: 'var(--menu-backdrop, blur(20px))',
        WebkitBackdropFilter: 'var(--menu-backdrop, blur(20px))',
        border: '1px solid var(--block-stroke)',
        borderRadius: '12px',
        boxShadow: '0 16px 40px rgba(0, 0, 0, 0.35)',
        padding: '14px',
        color: 'var(--text-primary)',
        fontSize: '12px',
        zIndex: 10001,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header & Provider Tabs */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--block-stroke)',
          paddingBottom: '10px',
          marginBottom: '12px',
          gap: '8px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '2px',
            flex: 1,
            minWidth: 0,
          }}
        >
          <button
            type="button"
            aria-label="Proveedores anteriores"
            title="Proveedores anteriores"
            disabled={!canScrollLeft}
            onClick={() => scrollTabs(-1)}
            style={{
              flexShrink: 0,
              background: 'none',
              border: 'none',
              padding: '2px',
              borderRadius: '4px',
              color: 'var(--text-secondary)',
              cursor: canScrollLeft ? 'pointer' : 'default',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              visibility: canScrollLeft ? 'visible' : 'hidden',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>

          <div
            ref={tabsRef}
            onWheel={(e) => {
              const el = tabsRef.current;
              if (!el || el.scrollWidth <= el.clientWidth) return;
              el.scrollLeft += e.deltaY;
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              overflowX: 'auto',
              scrollbarWidth: 'none',
              flex: 1,
              minWidth: 0,
              scrollBehavior: 'smooth',
            }}
          >
            {activeIds.map((id) => {
              const shortLabel = SHORT_PROVIDER_LABELS[id] || PROVIDER_LABELS[id] || id;
              const fullLabel = PROVIDER_LABELS[id] || id;
              const q = allQuotas[id];
              const d = diagnoseProvider(q);
              const isActive = id === selectedProvider;

              return (
                <button
                  key={id}
                  type="button"
                  data-provider-tab={id}
                  onClick={() => onSelectProvider(id)}
                  title={`${fullLabel} (${d.statusLabel})`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '5px',
                    padding: '4px 8px',
                    borderRadius: '6px',
                    fontSize: '11px',
                    fontWeight: isActive ? 600 : 400,
                    border: isActive
                      ? '1px solid var(--accent-tint-strong)'
                      : '1px solid transparent',
                    backgroundColor: isActive
                      ? 'var(--accent-tint)'
                      : d.state !== 'not_installed'
                      ? 'var(--block-fill)'
                      : 'transparent',
                    color: isActive
                      ? 'var(--accent)'
                      : d.state === 'ok'
                      ? 'var(--text-primary)'
                      : d.state === 'detected'
                      ? 'var(--text-secondary)'
                      : d.state === 'signed_out' || d.state === 'error'
                      ? 'var(--warning-text)'
                      : 'var(--text-secondary)',
                    cursor: 'pointer',
                    transition: 'all 120ms ease',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  <BrandLogo engine={id} size={13} />
                  <span>{shortLabel}</span>
                  {d.state === 'ok' && (
                    <span
                      style={{
                        width: '5px',
                        height: '5px',
                        borderRadius: '50%',
                        backgroundColor: 'var(--status-running)',
                        display: 'inline-block',
                      }}
                    />
                  )}
                  {(d.state === 'signed_out' || d.state === 'error') && (
                    <span
                      style={{
                        width: '5px',
                        height: '5px',
                        borderRadius: '50%',
                        backgroundColor: 'var(--warning-text)',
                        display: 'inline-block',
                      }}
                    />
                  )}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            aria-label="Proveedores siguientes"
            title="Proveedores siguientes"
            disabled={!canScrollRight}
            onClick={() => scrollTabs(1)}
            style={{
              flexShrink: 0,
              background: 'none',
              border: 'none',
              padding: '2px',
              borderRadius: '4px',
              color: 'var(--text-secondary)',
              cursor: canScrollRight ? 'pointer' : 'default',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              visibility: canScrollRight ? 'visible' : 'hidden',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>

        {/* Action icons - Sleek SVGs, zero emojis */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '3px', flexShrink: 0 }}>
          <button
            type="button"
            onClick={onRefresh}
            title="Actualizar cuotas"
            style={{
              background: 'none',
              border: 'none',
              padding: '5px',
              borderRadius: '4px',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                animation: isRefreshing ? 'spin 1s linear infinite' : 'none',
              }}
            >
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
              <path d="M16 21h5v-5" />
            </svg>
          </button>

          <button
            type="button"
            onClick={openAccounts}
            title="Cambiar cuentas / Bóveda multi-cuenta"
            style={{
              background: 'none',
              border: 'none',
              padding: '5px',
              borderRadius: '4px',
              color: 'var(--accent)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </button>

          <button
            type="button"
            onClick={() => handleOpenSettings(selectedProvider)}
            title="Configuración de proveedores y cuotas"
            style={{
              background: 'none',
              border: 'none',
              padding: '5px',
              borderRadius: '4px',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>

          <button
            type="button"
            onClick={onClose}
            title="Cerrar"
            style={{
              background: 'none',
              border: 'none',
              padding: '5px',
              borderRadius: '4px',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Selected Provider Details */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', overflowY: 'auto' }}>
        {activeIds.length === 0 ? (
          <div
            style={{
              padding: '18px 14px',
              backgroundColor: 'var(--block-fill)',
              border: '1px dashed var(--block-stroke)',
              borderRadius: '8px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              alignItems: 'flex-start',
            }}
          >
            <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
              No agregaste ningún proveedor
            </div>
            <p style={{ margin: 0, fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
              Elegí qué cuotas querés monitorear. Tus claves y sesiones existentes siguen
              guardadas; solo se muestran los proveedores que agregues manualmente.
            </p>
            <button
              type="button"
              onClick={() => handleOpenSettings()}
              style={{
                backgroundColor: 'var(--accent-tint)',
                border: '1px solid var(--accent-tint-strong)',
                borderRadius: '6px',
                padding: '6px 12px',
                color: 'var(--accent)',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Agregar proveedor
            </button>
          </div>
        ) : (
          <>
        {/* Case 1: Active with real live quota windows */}
        {diagnostic.state === 'ok' && currentQuota && (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                backgroundColor: 'var(--block-fill)',
                border: '1px solid var(--block-stroke)',
                borderRadius: '8px',
                padding: '10px 12px',
              }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div
                    style={{
                      position: 'relative',
                      width: 36,
                      height: 36,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <QuotaProgressRing
                      percentage={remPct ?? 100}
                      size={36}
                      strokeWidth={3}
                      dimmed={!hasData}
                    />
                    <div
                      style={{
                        position: 'absolute',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        pointerEvents: 'none',
                      }}
                    >
                      <BrandLogo engine={selectedProvider} size={16} />
                    </div>
                  </div>

                  <div>
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: '13px',
                        color: 'var(--text-primary)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                      }}
                    >
                      {currentQuota.displayName}
                      <span
                        style={{
                          fontSize: '9px',
                          fontWeight: 500,
                          padding: '1px 5px',
                          borderRadius: '4px',
                          backgroundColor: 'var(--accent-tint)',
                          color: 'var(--accent)',
                          border: '1px solid var(--accent-tint-strong)',
                        }}
                      >
                        En línea
                      </span>
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                      {resetCountdown
                        ? `Resetea en ${resetCountdown}`
                        : formatDetailedReset(currentQuota.timeUntilResetMs)}
                    </div>
                  </div>
                </div>

                <div style={{ textAlign: 'right' }}>
                  <div
                    style={{
                      fontSize: '18px',
                      fontWeight: 700,
                      lineHeight: 1,
                      color:
                        remPct != null && remPct < 20
                          ? 'var(--status-failed)'
                          : remPct != null && remPct < 45
                          ? 'var(--warning-text)'
                          : 'var(--accent)',
                    }}
                  >
                    {remPct}%
                  </div>
                  <div style={{ fontSize: '9px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                    {currentQuota.metadata?.primaryWindowLabel
                      ? String(currentQuota.metadata.primaryWindowLabel)
                      : currentQuota.metadata?.primaryWindow === '5h'
                        ? 'Límite de 5 horas'
                        : 'Restante'}
                  </div>
                </div>
              </div>

            {/* Badges / Metadata row */}
            {currentQuota.metadata && Object.keys(currentQuota.metadata).length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                {currentQuota.metadata.planType && (
                  <span
                    style={{
                      fontSize: '10px',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      backgroundColor: 'var(--accent-tint)',
                      color: 'var(--accent)',
                      border: '1px solid var(--accent-tint-strong)',
                    }}
                  >
                    Plan: {currentQuota.metadata.planType}
                  </span>
                )}
                {currentQuota.metadata.email && (
                  <span
                    style={{
                      fontSize: '10px',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      backgroundColor: 'var(--block-fill)',
                      color: 'var(--text-secondary)',
                      border: '1px solid var(--block-stroke)',
                    }}
                  >
                    {currentQuota.metadata.email}
                  </span>
                )}
                {currentQuota.metadata.tier && (
                  <span
                    style={{
                      fontSize: '10px',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      backgroundColor: 'var(--block-fill)',
                      color: 'var(--text-secondary)',
                      border: '1px solid var(--block-stroke)',
                    }}
                  >
                    Tier: {String(currentQuota.metadata.tier)}
                  </span>
                )}
                {selectedProvider === 'opencode' && currentQuota.metadata.authSource && (
                  <span
                    style={{
                      fontSize: '10px',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      backgroundColor: 'var(--block-fill)',
                      color: 'var(--text-secondary)',
                      border: '1px solid var(--block-stroke)',
                    }}
                  >
                    Fuente: {String(currentQuota.metadata.authSource)}
                  </span>
                )}
              </div>
            )}

            {/* Multi-Account Switcher Quick Pill */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 10px',
                borderRadius: '6px',
                backgroundColor: 'var(--block-fill)',
                border: '1px solid var(--block-stroke)',
                marginTop: '4px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                <span style={{ fontSize: '11px', color: 'var(--text-secondary)', flexShrink: 0 }}>Cuenta activa:</span>
                <span
                  style={{
                    fontSize: '11px',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {currentQuota.metadata?.email ? String(currentQuota.metadata.email) : 'Sesión nativa activa'}
                </span>
              </div>
              <button
                type="button"
                onClick={openAccounts}
                style={{
                  background: 'none',
                  border: '1px solid var(--accent-tint-strong)',
                  backgroundColor: 'var(--accent-tint)',
                  color: 'var(--accent)',
                  padding: '3px 8px',
                  borderRadius: '4px',
                  fontSize: '11px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  flexShrink: 0,
                  marginLeft: '8px',
                }}
              >
                Cambiar cuenta...
              </button>
            </div>

            {/* Individual windows breakdown */}
            {currentQuota.windows && currentQuota.windows.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div
                  style={{
                    fontSize: '10px',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    color: 'var(--text-secondary)',
                    marginTop: '2px',
                  }}
                >
                  Ventanas y Límites de Modelos
                </div>

                {currentQuota.windows.map((win, idx) => {
                  const rem = Math.round(win.remainingFraction * 100);
                  const used = Math.round(win.usagePercent);

                  return (
                    <div
                      key={idx}
                      style={{
                        backgroundColor: 'var(--chip-fill)',
                        border: '1px solid var(--block-stroke)',
                        borderRadius: '6px',
                        padding: '7px 9px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '4px',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'baseline',
                          gap: '8px',
                          fontSize: '11px',
                        }}
                      >
                        <span
                          style={{
                            color: 'var(--text-primary)',
                            fontWeight: 500,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={win.name}
                        >
                          {win.name}
                        </span>
                        <span
                          style={{
                            fontSize: '10px',
                            color: rem < 20 ? 'var(--status-failed)' : rem < 45 ? 'var(--warning-text)' : 'var(--text-secondary)',
                            fontVariantNumeric: 'tabular-nums',
                            whiteSpace: 'nowrap',
                            flexShrink: 0,
                          }}
                        >
                          {rem}% restante ({used}% usado)
                        </span>
                      </div>

                      <div
                        style={{
                          height: '4px',
                          width: '100%',
                          backgroundColor: 'var(--block-stroke)',
                          borderRadius: '2px',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            height: '100%',
                            width: `${used}%`,
                            backgroundColor:
                              used > 80
                                ? 'var(--status-failed)'
                                : used > 55
                                ? 'var(--warning-text)'
                                : 'var(--status-running)',
                            borderRadius: '2px',
                            transition: 'width 300ms ease',
                          }}
                        />
                      </div>

                      {win.timeUntilResetMs != null && win.timeUntilResetMs > 0 && (
                        <div style={{ fontSize: '9px', color: 'var(--text-secondary)' }}>
                          {formatDetailedReset(win.timeUntilResetMs)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* Case 2: Detected locally, honest without fake quota windows */}
        {diagnostic.state === 'detected' && (
          <div
            style={{
              padding: '16px 14px',
              backgroundColor: 'var(--block-fill)',
              borderRadius: '8px',
              border: '1px solid var(--block-stroke)',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '8px',
                  backgroundColor: 'var(--accent-tint)',
                  border: '1px solid var(--accent-tint-strong)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <BrandLogo engine={selectedProvider} size={18} />
              </div>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {PROVIDER_LABELS[selectedProvider] || selectedProvider}
                  <span
                    style={{
                      fontSize: '9px',
                      fontWeight: 500,
                      padding: '1px 5px',
                      borderRadius: '4px',
                      backgroundColor: 'var(--accent-tint)',
                      color: 'var(--accent)',
                      border: '1px solid var(--accent-tint-strong)',
                    }}
                  >
                    Sesión local activa
                  </span>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  {currentQuota?.metadata?.source ? String(currentQuota.metadata.source) : 'Herramienta CLI detectada'}
                </div>
              </div>
            </div>

            <div
              style={{
                fontSize: '11px',
                color: 'var(--text-secondary)',
                backgroundColor: 'var(--chip-fill)',
                padding: '8px 10px',
                borderRadius: '6px',
                border: '1px solid var(--block-fill)',
                lineHeight: 1.4,
              }}
            >
              Este proveedor no expone cuotas ni créditos mediante una API de facturación en vivo. Está listo para ser usado directamente por los agentes de Kite.
            </div>

            <button
              type="button"
              onClick={() => handleOpenSettings(selectedProvider)}
              style={{
                alignSelf: 'flex-start',
                background: 'none',
                border: 'none',
                padding: 0,
                color: 'var(--accent)',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              <span>Ver detalles de configuración</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </button>
          </div>
        )}

        {/* Case 3: Error / Session Required / Not configured */}
        {(diagnostic.state === 'signed_out' || diagnostic.state === 'error' || diagnostic.state === 'not_installed') && (
          <div
            style={{
              padding: '16px 14px',
              backgroundColor:
                diagnostic.state === 'error'
                  ? 'var(--danger-fill)'
                  : diagnostic.state === 'signed_out'
                  ? 'var(--warning-tint)'
                  : 'var(--block-fill)',
              borderRadius: '8px',
              border: `1px solid ${
                diagnostic.state === 'error'
                  ? 'var(--danger-fill)'
                  : diagnostic.state === 'signed_out'
                  ? 'var(--warning-tint)'
                  : 'var(--block-stroke)'
              }`,
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
              <div
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '8px',
                  backgroundColor: 'var(--block-fill)',
                  border: '1px solid var(--block-stroke)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <BrandLogo engine={selectedProvider} size={18} />
              </div>

              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {PROVIDER_LABELS[selectedProvider] || selectedProvider}
                  <span
                    style={{
                      fontSize: '9px',
                      fontWeight: 500,
                      padding: '1px 5px',
                      borderRadius: '4px',
                      backgroundColor:
                        diagnostic.state === 'error'
                          ? 'var(--danger-fill)'
                          : diagnostic.state === 'signed_out'
                          ? 'var(--warning-tint)'
                          : 'var(--block-stroke)',
                      color:
                        diagnostic.state === 'error'
                          ? 'var(--status-failed)'
                          : diagnostic.state === 'signed_out'
                          ? 'var(--warning-text)'
                          : 'var(--text-secondary)',
                      border: `1px solid ${
                        diagnostic.state === 'error'
                          ? 'var(--danger-fill)'
                          : diagnostic.state === 'signed_out'
                          ? 'var(--warning-tint)'
                          : 'var(--block-stroke)'
                      }`,
                    }}
                  >
                    {diagnostic.statusLabel}
                  </span>
                </div>

                <p style={{ margin: '4px 0 0', fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                  {diagnostic.detail}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => handleOpenSettings(selectedProvider)}
              style={{
                marginTop: '2px',
                backgroundColor: 'var(--accent-tint)',
                border: '1px solid var(--accent-tint-strong)',
                borderRadius: '6px',
                padding: '6px 12px',
                color: 'var(--accent)',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                alignSelf: 'flex-start',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <span>Configurar {PROVIDER_LABELS[selectedProvider] || selectedProvider}</span>
            </button>
          </div>
        )}
          </>
        )}
      </div>

      {/* Footer controls with official ui-switch and Token Heatmap link */}
      <div
        style={{
          borderTop: '1px solid var(--block-stroke)',
          marginTop: '12px',
          paddingTop: '10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
        }}
      >
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
          <button
            type="button"
            role="switch"
            aria-checked={prefs.autoDetectActive}
            aria-label="Detección automática del agente activo"
            className="ui-switch"
            onClick={() => {
              saveQuotaPreferences({ autoDetectActive: !prefs.autoDetectActive });
            }}
            style={{ cursor: 'pointer' }}
          >
            <span aria-hidden="true" className="ui-switch__knob" />
          </button>
          <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Detección auto</span>
        </div>

        {onOpenTokenUsage && (
          <button
            type="button"
            onClick={() => {
              onClose();
              onOpenTokenUsage();
            }}
            style={{
              background: 'var(--block-stroke)',
              border: '1px solid var(--block-stroke)',
              borderRadius: '6px',
              padding: '4px 9px',
              fontSize: '11px',
              fontWeight: 500,
              color: 'var(--text-primary)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <span>Mapa de tokens</span>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
        )}
      </div>
    </motion.div>
  );

  return createPortal(
    <AnimatePresence>{phase === 'in' && popoverNode}</AnimatePresence>,
    document.body
  );
};
