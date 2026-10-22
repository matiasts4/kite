import React, { useState, useEffect, useRef } from 'react';
import { QuotaProgressRing } from './QuotaProgressRing';
import { SubscriptionQuotaPopover } from './SubscriptionQuotaPopover';
import {
  subscriptionQuotaManager,
  readQuotaPreferences,
  detectProviderFromSession,
  resolveDisplayProvider,
  QUOTA_PREFS_CHANGED_EVENT,
} from '../../lib/quota/quotaManager';
import { useResetCountdownClock } from '../../lib/quota/useResetCountdownClock';
import { type ProviderQuotaStatus, PROVIDER_LABELS } from '../../lib/quota/types';
import { BrandLogo } from '../views/agents/engineMetadata';
import { usePresence } from '../../motion/usePresence';

export interface SubscriptionQuotaBadgeProps {
  activeSessionTitle?: string | null;
  activeEngine?: string | null;
  onOpenTokenUsage?: () => void;
  className?: string;
}

export const SubscriptionQuotaBadge: React.FC<SubscriptionQuotaBadgeProps> = ({
  activeSessionTitle = null,
  activeEngine = null,
  onOpenTokenUsage,
  className = '',
}) => {
  const [quotas, setQuotas] = useState<Record<string, ProviderQuotaStatus>>({});
  const [prefs, setPrefs] = useState(() => readQuotaPreferences());
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const popoverPresence = usePresence(isOpen);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Subscribe to quota manager updates
  useEffect(() => {
    const unsub = subscriptionQuotaManager.subscribe((data) => {
      setQuotas(data);
    });
    return () => unsub();
  }, []);

  // Listen to preference changes
  useEffect(() => {
    const handler = (e: any) => {
      if (e?.detail) setPrefs(e.detail);
    };
    window.addEventListener(QUOTA_PREFS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(QUOTA_PREFS_CHANGED_EVENT, handler);
  }, []);

  // Handle outside click to close popover
  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        // Popover click outside is handled inside SubscriptionQuotaPopover
      }
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [isOpen]);

  if (!prefs.enabled) {
    return null;
  }

  const detected = detectProviderFromSession(activeEngine || activeSessionTitle);
  const displayProvider = selectedProvider || resolveDisplayProvider(prefs, detected, quotas);
  const currentQuota = quotas[displayProvider] || null;

  const hasData = Boolean(
    currentQuota &&
    currentQuota.isAvailable &&
    currentQuota.windows &&
    currentQuota.windows.length > 0
  );

  const remPct = hasData ? currentQuota?.primaryRemainingPercent ?? 100 : null;
  const usedPct = hasData ? currentQuota?.primaryUsagePercent ?? (100 - (remPct ?? 100)) : null;
  const label = PROVIDER_LABELS[displayProvider] || displayProvider;

  const shortReset = useResetCountdownClock(currentQuota?.timeUntilResetMs);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await subscriptionQuotaManager.fetchAll(true);
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleToggle = () => {
    if (!isOpen && buttonRef.current) {
      setAnchorRect(buttonRef.current.getBoundingClientRect());
    }
    setIsOpen((prev) => !prev);
  };

  const windowLabel = currentQuota?.metadata?.primaryWindowLabel || (currentQuota?.metadata?.primaryWindow === '5h' ? '5h' : null);
  const badgeTitle = hasData
    ? `${label}${windowLabel ? ` (${windowLabel})` : ''}: ${remPct}% de cuota restante.${shortReset ? ` Resetea en ${shortReset}.` : ''}${currentQuota?.error ? ` (${currentQuota.error})` : ''} Clic para ver detalles y límites.`
    : currentQuota?.error || 'Comprobando cuota de suscripción IA...';

  const isUsedMode = prefs.displayMode === 'percent_used';

  return (
    <div
      ref={containerRef}
      className={`subscription-quota-container ${className}`}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={handleToggle}
        title={badgeTitle}
        aria-label={badgeTitle}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className="subscription-quota-pill subscription-quota-badge"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          padding: '0 8px',
          height: '24px',
          width: 'auto',
          borderRadius: 'var(--radius-chip, 6px)',
          border: '1px solid var(--block-stroke)',
          backgroundColor: isOpen ? 'var(--block-stroke)' : 'var(--block-fill)',
          color: 'var(--text-primary, var(--text-primary))',
          fontSize: '11px',
          fontWeight: 500,
          cursor: 'pointer',
          transition: 'all 120ms ease',
          outline: 'none',
          whiteSpace: 'nowrap',
          flexShrink: 0,
          lineHeight: 1,
        }}
      >
        {/* Brand Logo Icon */}
        <BrandLogo engine={displayProvider} size={13} />

        <QuotaProgressRing
          percentage={remPct ?? 100}
          size={13}
          strokeWidth={2}
          dimmed={!hasData}
        />

        {hasData && remPct != null ? (
          <span
            style={{
              fontWeight: 700,
              fontSize: '11px',
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
              color:
                remPct < 20
                  ? 'var(--status-failed)'
                  : remPct < 45
                  ? 'var(--warning-text)'
                  : 'var(--accent)',
            }}
          >
            {isUsedMode ? `${usedPct}% usado` : `${remPct}%`}
          </span>
        ) : (
          <span
            style={{
              fontWeight: 600,
              fontSize: '11px',
              color: 'var(--text-muted, var(--text-secondary))',
            }}
          >
            --
          </span>
        )}

        {shortReset && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '3px',
              fontSize: '10px',
              color: 'var(--text-secondary, var(--text-secondary))',
              borderLeft: '1px solid var(--block-stroke)',
              paddingLeft: '6px',
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <span>{shortReset}</span>
          </span>
        )}
      </button>

      {popoverPresence.mounted && (
        <SubscriptionQuotaPopover
          allQuotas={quotas}
          selectedProvider={displayProvider}
          onSelectProvider={(id) => setSelectedProvider(id)}
          onRefresh={handleRefresh}
          isRefreshing={isRefreshing}
          onClose={() => setIsOpen(false)}
          onOpenTokenUsage={onOpenTokenUsage}
          prefs={prefs}
          anchorRect={anchorRect}
          phase={popoverPresence.phase}
        />
      )}
    </div>
  );
};
