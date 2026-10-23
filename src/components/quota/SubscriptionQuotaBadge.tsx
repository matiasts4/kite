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
import { type ProviderQuotaStatus, PROVIDERS, PROVIDER_LABELS, resolveEnabledProviderIds } from '../../lib/quota/types';
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

  const enabledProviderIds = resolveEnabledProviderIds(prefs);

  const detected = detectProviderFromSession(activeEngine || activeSessionTitle);
  const displayProvider =
    selectedProvider && enabledProviderIds.includes(selectedProvider)
      ? selectedProvider
      : resolveDisplayProvider(prefs, detected, quotas);

  // Keep the pill visible even with zero providers: it is the entry point to
  // add them from the quota popover.
  const popoverProvider = displayProvider || PROVIDERS.ANTIGRAVITY;

  const currentQuota = displayProvider ? quotas[displayProvider] || null : null;

  const hasData = Boolean(
    currentQuota &&
    currentQuota.isAvailable &&
    currentQuota.windows &&
    currentQuota.windows.length > 0
  );

  const remPct = hasData ? currentQuota?.primaryRemainingPercent ?? 100 : null;
  const usedPct = hasData ? currentQuota?.primaryUsagePercent ?? (100 - (remPct ?? 100)) : null;
  const label = displayProvider ? PROVIDER_LABELS[displayProvider] || displayProvider : 'Cuotas';

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
  const badgeTitle = !displayProvider
    ? 'Cuotas de suscripción IA: agregá un proveedor para empezar'
    : hasData
    ? `${label}${windowLabel ? ` (${windowLabel})` : ''}: ${remPct}% de cuota restante.${currentQuota?.error ? ` (${currentQuota.error})` : ''} Clic para ver detalles y límites.`
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
        {displayProvider ? (
          <BrandLogo engine={displayProvider} size={13} />
        ) : (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ color: 'var(--text-secondary)' }}
          >
            <circle cx="12" cy="12" r="9" />
            <line x1="12" y1="8" x2="12" y2="16" />
            <line x1="8" y1="12" x2="16" y2="12" />
          </svg>
        )}

        {displayProvider ? (
          <QuotaProgressRing
            percentage={remPct ?? 100}
            size={13}
            strokeWidth={2}
            dimmed={!hasData}
          />
        ) : null}

        {!displayProvider ? (
          <span
            style={{
              fontWeight: 600,
              fontSize: '10px',
              color: 'var(--text-secondary)',
              whiteSpace: 'nowrap',
            }}
          >
            Cuotas
          </span>
        ) : hasData && remPct != null ? (
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
      </button>

      {popoverPresence.mounted && (
        <SubscriptionQuotaPopover
          allQuotas={quotas}
          selectedProvider={popoverProvider}
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
