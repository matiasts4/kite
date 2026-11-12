import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { useResetCountdownClock } from '../../lib/quota/useResetCountdownClock';
import {
  type ProviderQuotaStatus,
  type QuotaPreferences,
  resolveEnabledProviderIds,
} from '../../lib/quota/types';
import { diagnoseProvider } from '../../lib/quota/providerState';
import { saveQuotaPreferences } from '../../lib/quota/quotaManager';
import { openSettingsTab } from '../../lib/settingsNav';
import { listSavedAccountsFull, switchAccountProfile } from '../../lib/ipc';
import type { SavedAccountProfile } from '../../types';
import { MOTION_EXIT_MS } from '../../motion/contract';
import { surfaceMotion } from '../../motion/standard/surfaces';
import { QuotaPopoverHeader } from './popover/QuotaPopoverHeader';
import { QuotaPopoverContent } from './popover/QuotaPopoverContent';

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
  const accountsDropdownRef = useRef<HTMLDivElement>(null);
  const [isAccountsExpanded, setIsAccountsExpanded] = useState(false);
  const [savedAccounts, setSavedAccounts] = useState<SavedAccountProfile[]>([]);
  const [unregisteredLiveSession, setUnregisteredLiveSession] = useState<{
    email: string;
    planName?: string | null;
  } | null>(null);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [switchingAccountId, setSwitchingAccountId] = useState<string | null>(null);
  const [switchFeedback, setSwitchFeedback] = useState<string | null>(null);

  const handleOpenSettings = (providerId?: string) => {
    onClose();
    openSettingsTab('quotas', providerId);
  };

  const toggleAccountsExpanded = () => {
    setIsAccountsExpanded((prev) => !prev);
  };

  const fetchAccounts = useCallback(async (prov: string) => {
    setLoadingAccounts(true);
    setSwitchFeedback(null);
    try {
      const res = await listSavedAccountsFull(prov);
      setSavedAccounts(res.profiles || []);
      setUnregisteredLiveSession(
        res.unregisteredLiveSession
          ? {
              email: res.unregisteredLiveSession.email,
              planName: res.unregisteredLiveSession.planName,
            }
          : null
      );
    } catch {
      setSavedAccounts([]);
    } finally {
      setLoadingAccounts(false);
    }
  }, []);

  useEffect(() => {
    if (isAccountsExpanded) {
      void fetchAccounts(selectedProvider);
    }
  }, [isAccountsExpanded, selectedProvider, fetchAccounts]);

  const handleSwitchAccount = async (profileId: string) => {
    setSwitchingAccountId(profileId);
    setSwitchFeedback(null);
    try {
      const res = await switchAccountProfile(selectedProvider, profileId);
      if (res.success) {
        setSwitchFeedback('Cuenta activada');
        window.dispatchEvent(
          new CustomEvent('kite:terminal-command', {
            detail: { command: 'restart-agent' },
          })
        );
        void onRefresh();
        void fetchAccounts(selectedProvider);
      } else {
        setSwitchFeedback(res.error || 'Error al cambiar cuenta');
      }
    } catch (err: any) {
      setSwitchFeedback(err?.message || 'Error al cambiar cuenta');
    } finally {
      setSwitchingAccountId(null);
    }
  };

  const currentQuota = allQuotas[selectedProvider] || null;
  const diagnostic = diagnoseProvider(currentQuota);
  const activeIds = resolveEnabledProviderIds(prefs);
  const activeIdsKey = activeIds.join('|');

  const resetCountdown = useResetCountdownClock(currentQuota?.timeUntilResetMs);
  const hasData = diagnostic.state === 'ok';
  const remPct = hasData ? currentQuota?.primaryRemainingPercent ?? 100 : null;

  // Horizontal navigation for the provider tab strip
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
      if (isAccountsExpanded && accountsDropdownRef.current && !accountsDropdownRef.current.contains(target)) {
        if (!target.closest('.subscription-quota-account-toggle')) {
          setIsAccountsExpanded(false);
          return;
        }
      }
      if (popoverRef.current && !popoverRef.current.contains(target)) {
        if (!target.closest('.subscription-quota-badge')) {
          onClose();
        }
      }
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [onClose, isAccountsExpanded]);

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
        transformOrigin: 'top right',
        width: '410px',
        maxWidth: 'calc(100vw - 24px)',
        maxHeight: 'calc(100vh - 60px)',
        backgroundColor: 'var(--menu-glass, #121214)',
        backdropFilter: 'var(--menu-backdrop, blur(20px))',
        WebkitBackdropFilter: 'var(--menu-backdrop, blur(20px))',
        border: '1px solid var(--block-stroke)',
        borderRadius: 'var(--card-radius, 12px)',
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
      <QuotaPopoverHeader
        activeIds={activeIds}
        selectedProvider={selectedProvider}
        onSelectProvider={onSelectProvider}
        allQuotas={allQuotas}
        tabsRef={tabsRef}
        canScrollLeft={canScrollLeft}
        canScrollRight={canScrollRight}
        onScrollTabs={(d) => scrollTabs(d as -1 | 1)}
        onRefresh={onRefresh}
        isRefreshing={isRefreshing}
        onOpenAccounts={toggleAccountsExpanded}
        onOpenSettings={handleOpenSettings}
        onClose={onClose}
      />

      {/* Selected Provider Details */}
      <QuotaPopoverContent
        activeIdsCount={activeIds.length}
        selectedProvider={selectedProvider}
        currentQuota={currentQuota}
        diagnostic={diagnostic}
        remPct={remPct}
        resetCountdown={resetCountdown}
        savedAccounts={savedAccounts}
        unregisteredLiveSession={unregisteredLiveSession}
        isAccountsExpanded={isAccountsExpanded}
        accountsDropdownRef={accountsDropdownRef}
        switchFeedback={switchFeedback}
        loadingAccounts={loadingAccounts}
        switchingAccountId={switchingAccountId}
        onSwitchAccount={handleSwitchAccount}
        onOpenSettings={handleOpenSettings}
        onToggleAccounts={toggleAccountsExpanded}
      />

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
              borderRadius: 'var(--control-radius, 8px)',
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
