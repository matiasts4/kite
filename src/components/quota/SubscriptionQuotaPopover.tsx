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
import { guidedLoginCoordinator } from '../../lib/accounts/guidedLoginCoordinator';
import { useAccountVault } from '../../lib/accounts/useAccountVault';
import { AccountConfirmDialogs } from '../accounts/AccountVaultUI';
import { MOTION_EXIT_MS } from '../../motion/contract';
import { surfaceMotion } from '../../motion/standard/surfaces';
import { ArrowRightIcon } from '../titlebar/TopbarPopoverIcons';
import { QuotaPopoverHeader } from './popover/QuotaPopoverHeader';
import { QuotaPopoverContent } from './popover/QuotaPopoverContent';
import '../titlebar/topbar-popovers.css';
import './quota-popover.css';

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

  const vault = useAccountVault(selectedProvider, { autoLoad: phase === 'in' });
  const hasSubDialogOpen = Boolean(
    vault.busyConfirm || vault.deleteConfirmProfile || vault.overwritePrompt
  );

  const handleOpenSettings = (providerId?: string) => {
    onClose();
    openSettingsTab('quotas', providerId);
  };

  const toggleAccountsExpanded = () => {
    setIsAccountsExpanded((prev) => !prev);
  };

  useEffect(() => {
    vault.clearFeedback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProvider]);

  const handleSwitchAccount = async (profileId: string) => {
    const res = await vault.switchAccount(profileId);
    if (res.success) {
      void onRefresh();
    }
  };

  const handleCloseResidualProcesses = async () => {
    const res = await vault.closeResidualProcesses();
    if (res.success) {
      void onRefresh();
    }
    return res;
  };

  const handleSaveCurrent = async (label?: string) => {
    const res = await vault.saveCurrentAccount(label, { source: 'popover' });
    if (res.success) {
      void onRefresh();
    }
    return res.success;
  };

  const handleRenameProfile = async (profileId: string, label: string) => {
    const res = await vault.renameProfile(profileId, label);
    return res.success;
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
      const top = Math.round(anchorRect.bottom + 6);
      const right = Math.max(12, Math.round(window.innerWidth - anchorRect.right));
      setPosition({ top, right });
    }
  }, [anchorRect]);

  // Close on outside click or Escape
  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (hasSubDialogOpen) return;
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
    const handleKeyDown = (e: KeyboardEvent) => {
      if (hasSubDialogOpen) return;
      if (e.key === 'Escape') {
        if (isAccountsExpanded) {
          setIsAccountsExpanded(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, isAccountsExpanded, hasSubDialogOpen]);

  const popoverNode = (
    <motion.div
      {...surfaceMotion('popover', { exitMs: MOTION_EXIT_MS })}
      ref={popoverRef}
      role="dialog"
      aria-label="Cuotas de suscripción IA"
      className="tp-popover subscription-quota-popover"
      style={{
        top: `${position.top}px`,
        right: `${position.right}px`,
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
        isAccountsExpanded={isAccountsExpanded}
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
        savedAccounts={vault.profiles}
        unregisteredLiveSession={vault.unregisteredLiveSession}
        authTelemetry={vault.authTelemetry}
        isAccountsExpanded={isAccountsExpanded}
        accountsDropdownRef={accountsDropdownRef}
        switchFeedback={vault.error || vault.notice}
        isErrorFeedback={Boolean(vault.error)}
        loadingAccounts={vault.loading}
        switchingAccountId={vault.switchingId}
        saving={vault.saving}
        renamingId={vault.renamingId}
        closingProcesses={vault.closingProcesses}
        lastFailedSwitch={vault.lastFailedSwitch}
        autoSwitchPolicy={vault.autoSwitchPolicy}
        autoSwitchRuntimeStatus={vault.autoSwitchRuntimeStatus}
        pendingAutoSwitchConfirmations={vault.pendingAutoSwitchConfirmations}
        autoSwitchResuming={vault.autoSwitchResuming}
        onSwitchAccount={handleSwitchAccount}
        onSaveCurrent={handleSaveCurrent}
        onRenameProfile={handleRenameProfile}
        onCloseResidualProcesses={handleCloseResidualProcesses}
        onResumeAutoSwitch={vault.resumeAutoSwitch}
        onAlignIde={vault.alignIde}
        onReauth={() => {
          void guidedLoginCoordinator.start(selectedProvider);
        }}
        onOpenSettings={handleOpenSettings}
        onToggleAccounts={toggleAccountsExpanded}
      />

      {/* Footer controls with official ui-switch and Token Heatmap link */}
      <div className="tp-footer">
        <div className="qt-pop-switch-row">
          <button
            type="button"
            role="switch"
            aria-checked={prefs.autoDetectActive}
            aria-label="Detección automática del agente activo"
            className="ui-switch"
            onClick={() => {
              saveQuotaPreferences({ autoDetectActive: !prefs.autoDetectActive });
            }}
          >
            <span aria-hidden="true" className="ui-switch__knob" />
          </button>
          <span>Detección auto</span>
        </div>

        {onOpenTokenUsage && (
          <button
            type="button"
            className="tp-btn tp-btn--sm tp-btn--secondary"
            onClick={() => {
              onClose();
              onOpenTokenUsage();
            }}
          >
            <span>Mapa de tokens</span>
            <ArrowRightIcon size={11} />
          </button>
        )}
      </div>
    </motion.div>
  );

  return (
    <>
      {createPortal(
        <AnimatePresence>{phase === 'in' && popoverNode}</AnimatePresence>,
        document.body
      )}
      <AccountConfirmDialogs
        busyConfirm={vault.busyConfirm}
        deleteConfirmProfile={vault.deleteConfirmProfile}
        overwritePrompt={vault.overwritePrompt}
        saving={vault.saving}
        deletingId={vault.deletingId}
        switchingId={vault.switchingId}
        onConfirmBusy={async () => {
          const res = await vault.confirmBusySwitch();
          if (res?.success) void onRefresh();
        }}
        onCancelBusy={vault.cancelBusySwitch}
        onConfirmDelete={vault.confirmDeleteProfile}
        onCancelDelete={vault.cancelDeleteProfile}
        onConfirmOverwriteUpdate={async () => {
          const res = await vault.confirmOverwriteUpdate();
          if (res.success) void onRefresh();
        }}
        onConfirmOverwriteRename={async () => {
          const res = await vault.confirmOverwriteRename();
          if (res.success) void onRefresh();
        }}
        onCancelOverwrite={vault.cancelOverwritePrompt}
      />
    </>
  );
};
