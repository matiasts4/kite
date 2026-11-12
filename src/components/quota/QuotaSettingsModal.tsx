import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  type ProviderQuotaStatus,
  type QuotaPreferences,
  PROVIDER_LABELS,
  ALL_SUPPORTED_PROVIDERS,
} from '../../lib/quota/types';
import {
  readQuotaPreferences,
  saveQuotaPreferences,
  subscriptionQuotaManager,
  QUOTA_PREFS_CHANGED_EVENT,
} from '../../lib/quota/quotaManager';
import { diagnoseProvider } from '../../lib/quota/providerState';
import { saveOpenCodeApiKey, clearOpenCodeApiKey } from '../../lib/ipc';
import { AccountSwitcherModal } from './AccountSwitcherModal';
import { usePresence } from '../../motion/usePresence';
import { motionSurfaceClass } from '../../motion/surface';
import {
  type ProviderMetaConfig,
  PROVIDER_CONFIGS_ES,
} from '../../config/quotaProviderMetadata';
import { QuotaSidebarList } from './settings/QuotaSidebarList';
import { QuotaGeneralSettingsTab } from './settings/QuotaGeneralSettingsTab';
import { QuotaProviderDetailPanel } from './settings/QuotaProviderDetailPanel';

export type { ProviderMetaConfig };
export { PROVIDER_CONFIGS_ES };

export interface QuotaSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  allQuotas?: Record<string, ProviderQuotaStatus>;
  initialSelectedProvider?: string;
}

export const QuotaSettingsModal: React.FC<QuotaSettingsModalProps> = ({
  isOpen,
  onClose,
  allQuotas = {},
  initialSelectedProvider,
}) => {
  const [prefs, setPrefs] = useState<QuotaPreferences>(() => readQuotaPreferences());
  const [selectedTab, setSelectedTab] = useState<string>(() => initialSelectedProvider || 'general');
  const [searchFilter, setSearchFilter] = useState<string>('');
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [verifyFeedback, setVerifyFeedback] = useState<string | null>(null);

  // OpenCode Go form state
  const [openCodeApiKey, setOpenCodeApiKey] = useState<string>('');
  const [openCodeStatus, setOpenCodeStatus] = useState<string | null>(null);

  // Multi-Account Switcher modal state
  const [accountSwitcherOpen, setAccountSwitcherOpen] = useState<boolean>(false);

  useEffect(() => {
    if (!isOpen) return;
    setPrefs(readQuotaPreferences());
    if (initialSelectedProvider) {
      setSelectedTab(initialSelectedProvider);
    }
  }, [isOpen, initialSelectedProvider]);

  useEffect(() => {
    const handler = (e: any) => {
      if (e?.detail) setPrefs(e.detail);
    };
    window.addEventListener(QUOTA_PREFS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(QUOTA_PREFS_CHANGED_EVENT, handler);
  }, []);

  const enabledSet = useMemo(() => {
    return new Set(prefs.enabledProviders ?? []);
  }, [prefs.enabledProviders]);

  const filteredProviders = useMemo(() => {
    if (!searchFilter.trim()) return ALL_SUPPORTED_PROVIDERS;
    const query = searchFilter.toLowerCase().trim();
    return ALL_SUPPORTED_PROVIDERS.filter((id) => {
      const label = PROVIDER_LABELS[id] || id;
      return label.toLowerCase().includes(query) || id.toLowerCase().includes(query);
    });
  }, [searchFilter]);

  const layerPresence = usePresence(isOpen);
  if (!layerPresence.mounted) return null;

  const scrimMotion = motionSurfaceClass(layerPresence.phase, 'scrim');
  const panelMotion = motionSurfaceClass(layerPresence.phase, 'modal');

  const handleToggleMaster = () => {
    saveQuotaPreferences({ enabled: !prefs.enabled });
  };

  const handleToggleAutoDetect = () => {
    saveQuotaPreferences({ autoDetectActive: !prefs.autoDetectActive });
  };

  const handleToggleProvider = (providerId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const currentEnabled = new Set(prefs.enabledProviders ?? []);
    if (currentEnabled.has(providerId)) {
      currentEnabled.delete(providerId);
    } else {
      currentEnabled.add(providerId);
    }
    saveQuotaPreferences({ enabledProviders: Array.from(currentEnabled) });
  };

  const handleEnableAll = () => {
    saveQuotaPreferences({ enabledProviders: [...ALL_SUPPORTED_PROVIDERS] });
  };

  const handleDisableAll = () => {
    saveQuotaPreferences({ enabledProviders: [] });
  };

  const handleEnableConnectedOnly = () => {
    const connected = ALL_SUPPORTED_PROVIDERS.filter((id) => {
      const q = allQuotas[id];
      const d = diagnoseProvider(q);
      return d.state === 'ok' || d.state === 'detected';
    });
    saveQuotaPreferences({ enabledProviders: connected });
  };

  const handlePinProvider = (providerId: string) => {
    const nextPin = prefs.pinnedProvider === providerId ? null : providerId;
    saveQuotaPreferences({ pinnedProvider: nextPin });
  };

  const handleMoveProviderOrder = (providerId: string, direction: 'up' | 'down') => {
    const order = [...prefs.providerOrder];
    const index = order.indexOf(providerId);
    if (index === -1) return;
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= order.length) return;
    const temp = order[index];
    order[index] = order[targetIndex];
    order[targetIndex] = temp;
    saveQuotaPreferences({ providerOrder: order });
  };

  const handleSetDisplayMode = (mode: 'percent_remaining' | 'percent_used' | 'compact') => {
    saveQuotaPreferences({ displayMode: mode });
  };

  const handleCopyCommand = async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedCmd(cmd);
      setTimeout(() => setCopiedCmd(null), 2500);
    } catch (_) {}
  };

  const handleVerifyNow = async (targetId?: string) => {
    setIsVerifying(true);
    setVerifyFeedback(null);
    try {
      const fresh = await subscriptionQuotaManager.fetchAll(true);
      const target = targetId || (selectedTab !== 'general' ? selectedTab : undefined);
      if (target && fresh[target]) {
        const q = fresh[target];
        const d = diagnoseProvider(q);
        if (d.state === 'ok') {
          const rem = q.primaryRemainingPercent;
          setVerifyFeedback(`${q.displayName}: En línea y respondiendo (${rem}% restante)`);
        } else if (d.state === 'detected') {
          setVerifyFeedback(`${q.displayName}: Sesión local detectada activamente`);
        } else if (d.state === 'error' || d.state === 'signed_out') {
          setVerifyFeedback(`${q.displayName}: ${d.detail || d.statusLabel}`);
        } else {
          setVerifyFeedback(`${q.displayName}: No se encontraron credenciales`);
        }
      } else {
        setVerifyFeedback('Estado actualizado con las credenciales locales');
      }
    } catch (err: any) {
      setVerifyFeedback(`Error al verificar: ${err?.message || 'Fallo de conexión'}`);
    } finally {
      setIsVerifying(false);
      setTimeout(() => setVerifyFeedback(null), 5000);
    }
  };

  const handleSaveOpenCode = async () => {
    if (!openCodeApiKey.trim()) return;
    setOpenCodeStatus('Guardando...');
    try {
      const ok = await saveOpenCodeApiKey(openCodeApiKey.trim());
      if (ok) {
        setOpenCodeStatus('API key guardada correctamente');
        setOpenCodeApiKey('');
        await subscriptionQuotaManager.fetchAll(true);
      } else {
        setOpenCodeStatus('Error al guardar la API key');
      }
    } catch (err: any) {
      setOpenCodeStatus(`Error: ${err?.message || 'Fallo al guardar'}`);
    }
    setTimeout(() => setOpenCodeStatus(null), 3500);
  };

  const handleClearOpenCode = async () => {
    setOpenCodeStatus('Limpiando...');
    try {
      await clearOpenCodeApiKey();
      setOpenCodeStatus('Clave de Kite eliminada; la detección de OpenCode sigue activa');
      setOpenCodeApiKey('');
      await subscriptionQuotaManager.fetchAll(true);
    } catch (err: any) {
      setOpenCodeStatus(`Error: ${err?.message || 'Fallo al limpiar'}`);
    }
    setTimeout(() => setOpenCodeStatus(null), 3000);
  };

  const currentSelectedQuota = selectedTab !== 'general' ? allQuotas[selectedTab] : undefined;
  const currentSelectedConfig = selectedTab !== 'general' ? PROVIDER_CONFIGS_ES[selectedTab] : null;
  const currentSelectedDiag = selectedTab !== 'general' ? diagnoseProvider(currentSelectedQuota) : { state: 'not_installed' as const, statusLabel: 'No instalado' };

  return createPortal(
    <div
      className={`usage-dash-portal-backdrop${scrimMotion ? ` ${scrimMotion}` : ''}`}
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10002,
        backgroundColor: 'rgba(0, 0, 0, 0.78)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Configuración de Cuotas y Proveedores IA"
        onClick={(e) => e.stopPropagation()}
        className={panelMotion || undefined}
        style={{
          width: '100%',
          maxWidth: '860px',
          height: '640px',
          maxHeight: '92vh',
          backgroundColor: '#121215',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          borderRadius: 'var(--dialog-radius, 14px)',
          boxShadow: '0 30px 70px rgba(0, 0, 0, 0.85), 0 0 0 1px rgba(255, 255, 255, 0.06)',
          color: '#f4f4f5',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 20px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            backgroundColor: 'rgba(255, 255, 255, 0.02)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span
              style={{
                width: '32px',
                height: '32px',
                borderRadius: 'var(--control-radius, 8px)',
                backgroundColor: 'rgba(52, 211, 153, 0.15)',
                color: '#34d399',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid rgba(52, 211, 153, 0.25)',
              }}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
            </span>
            <div>
              <h2 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: '#fafafa' }}>
                Cuotas y Suscripciones de IA
              </h2>
              <div style={{ fontSize: '11px', color: '#a1a1aa', marginTop: '2px' }}>
                Monitoreo local en tiempo real de límites de uso de Anthropic, OpenAI, Cursor, Google y más.
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar configuración"
            style={{
              background: 'none',
              border: 'none',
              padding: '6px',
              borderRadius: 'var(--control-radius, 8px)',
              color: '#a1a1aa',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* 2-Column Body */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {/* Left Sidebar */}
          <QuotaSidebarList
            selectedTab={selectedTab}
            onSelectTab={setSelectedTab}
            searchFilter={searchFilter}
            onSearchFilterChange={setSearchFilter}
            filteredProviders={filteredProviders}
            enabledSet={enabledSet}
            pinnedProvider={prefs.pinnedProvider}
            allQuotas={allQuotas}
            onEnableAll={handleEnableAll}
            onDisableAll={handleDisableAll}
            onEnableConnectedOnly={handleEnableConnectedOnly}
            onToggleProvider={handleToggleProvider}
          />

          {/* Right Main Content */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {selectedTab === 'general' ? (
              <QuotaGeneralSettingsTab
                prefs={prefs}
                enabledSet={enabledSet}
                onToggleMaster={handleToggleMaster}
                onToggleAutoDetect={handleToggleAutoDetect}
                onSetDisplayMode={handleSetDisplayMode}
                onMoveProviderOrder={handleMoveProviderOrder}
              />
            ) : currentSelectedConfig ? (
              <QuotaProviderDetailPanel
                selectedTab={selectedTab}
                config={currentSelectedConfig}
                quota={currentSelectedQuota}
                diagnostic={currentSelectedDiag}
                isPinned={prefs.pinnedProvider === selectedTab}
                isEnabled={enabledSet.has(selectedTab)}
                onPinProvider={handlePinProvider}
                onToggleProvider={(id) => handleToggleProvider(id)}
                onOpenAccountSwitcher={() => setAccountSwitcherOpen(true)}
                copiedCmd={copiedCmd}
                onCopyCommand={handleCopyCommand}
                openCodeApiKey={openCodeApiKey}
                setOpenCodeApiKey={setOpenCodeApiKey}
                openCodeStatus={openCodeStatus}
                onSaveOpenCode={handleSaveOpenCode}
                onClearOpenCode={handleClearOpenCode}
                isVerifying={isVerifying}
                verifyFeedback={verifyFeedback}
                onVerifyNow={handleVerifyNow}
              />
            ) : null}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            padding: '12px 20px',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            backgroundColor: 'rgba(255, 255, 255, 0.02)',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '6px 18px',
              borderRadius: 'var(--control-radius, 8px)',
              backgroundColor: '#10b981',
              border: 'none',
              color: '#ffffff',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 120ms ease',
            }}
          >
            Listo
          </button>
        </div>
      </div>

      {accountSwitcherOpen && (
        <AccountSwitcherModal
          provider={selectedTab}
          providerLabel={PROVIDER_LABELS[selectedTab] || selectedTab}
          isOpen={accountSwitcherOpen}
          onClose={() => setAccountSwitcherOpen(false)}
          onAccountSwitched={() => {
            void subscriptionQuotaManager.fetchAll(true);
          }}
        />
      )}
    </div>,
    document.body
  );
};
