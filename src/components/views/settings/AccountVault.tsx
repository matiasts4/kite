import React, { useEffect, useState } from 'react';
import {
  guidedLoginCoordinator,
  isSameAccountProvider,
  useGuidedLoginState,
} from '../../../lib/accounts/guidedLoginCoordinator';
import {
  formatSplitBrainDetail,
  isSplitBrainActive,
  quotaKeyForProvider,
} from '../../../lib/accounts/accountVaultStore';
import { useAccountVault } from '../../../lib/accounts/useAccountVault';
import { subscriptionQuotaManager } from '../../../lib/quota/quotaManager';
import type { ProviderQuotaStatus } from '../../../lib/quota/types';
import {
  AccountConfirmDialogs,
  PencilIcon,
  RefreshSmallIcon,
  resolveAuthModeLabel,
  resolveCredentialHealthBadge,
} from '../../accounts/AccountVaultUI';
import { BrandLogo } from '../../ui/BrandLogo';
import { SparklesIcon } from './icons';

/** Providers whose local session can be snapshotted into the account vault. */
export const MULTI_ACCOUNT_PROVIDERS: { id: string; label: string }[] = [
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'grok', label: 'Grok' },
  { id: 'opencode', label: 'OpenCode' },
];

const toneFor = (pct: number) => (pct >= 45 ? 'ok' : pct >= 20 ? 'warn' : 'low');

function formatReset(ms?: number | null, resetAt?: string | null): string | null {
  if (ms && ms > 0) {
    const mins = Math.round(ms / 60000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `Reinicia en ${h} h ${m} min` : `Reinicia en ${m} min`;
  }
  return resetAt ? `Reinicia ${resetAt}` : null;
}

export interface AccountVaultProps {
  onChanged?: () => void;
}

export const AccountVault: React.FC<AccountVaultProps> = ({ onChanged }) => {
  const [provider, setProvider] = useState<string>(MULTI_ACCOUNT_PROVIDERS[0].id);
  const [label, setLabel] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const [refreshingQuota, setRefreshingQuota] = useState(false);
  const [liveQuotas, setLiveQuotas] = useState<Record<string, ProviderQuotaStatus>>(() =>
    typeof subscriptionQuotaManager?.getAllQuotas === 'function'
      ? subscriptionQuotaManager.getAllQuotas()
      : {}
  );

  const vault = useAccountVault(provider, { autoLoad: true });
  const loginState = useGuidedLoginState();
  const matchesLoginProvider = isSameAccountProvider(loginState.provider, provider);
  const isConnectingNew =
    matchesLoginProvider &&
    (loginState.phase === 'preparing' ||
      loginState.phase === 'waiting' ||
      loginState.phase === 'saving');

  const providerLabel = MULTI_ACCOUNT_PROVIDERS.find((p) => p.id === provider)?.label ?? provider;

  useEffect(() => {
    setEditingId(null);
    setEditingLabel('');
    vault.clearFeedback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  useEffect(() => {
    if (typeof subscriptionQuotaManager?.subscribe !== 'function') return;
    return subscriptionQuotaManager.subscribe((data) => setLiveQuotas(data));
  }, []);

  const handleSwitch = async (id: string, opts?: { force?: boolean }) => {
    const res = await vault.switchAccount(id, opts);
    if (res.success) {
      onChanged?.();
    }
  };

  const handleSave = async (overrideLabel?: string) => {
    const res = await vault.saveCurrentAccount(
      overrideLabel ?? label,
      { source: overrideLabel ? 'unregistered' : 'manual' }
    );
    if (res.success) {
      if (!overrideLabel) setLabel('');
      onChanged?.();
    }
  };

  const handleConnectNewAccount = async () => {
    if (isConnectingNew) return;
    vault.clearFeedback();
    await guidedLoginCoordinator.start(provider);
  };

  const handleStartRename = (id: string, currentLabel: string) => {
    setEditingId(id);
    setEditingLabel(currentLabel);
  };

  const handleCommitRename = async (id: string) => {
    const res = await vault.renameProfile(id, editingLabel);
    if (res.success) {
      setEditingId(null);
      setEditingLabel('');
      onChanged?.();
    }
  };

  const handleRefreshActiveQuota = async () => {
    if (refreshingQuota) return;
    setRefreshingQuota(true);
    try {
      await vault.refreshQuota();
      onChanged?.();
    } finally {
      setRefreshingQuota(false);
    }
  };

  const activeLiveQuota = liveQuotas[quotaKeyForProvider(provider)];
  const authModeLabel =
    provider === 'antigravity' ? resolveAuthModeLabel(vault.authTelemetry) : null;
  const splitBrain = provider === 'antigravity' && isSplitBrainActive(vault.authTelemetry);
  const splitBrainDetail = splitBrain ? formatSplitBrainDetail(vault.authTelemetry) : null;

  return (
    <div className="qt-vault">
      <div className="qt-segment" role="tablist" aria-label="Proveedor">
        {MULTI_ACCOUNT_PROVIDERS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={provider === p.id}
            className="qt-segment__item"
            data-active={provider === p.id ? '' : undefined}
            onClick={() => setProvider(p.id)}
          >
            <BrandLogo engine={p.id} size={14} />
            <span>{p.label}</span>
          </button>
        ))}
      </div>

      {vault.error ? (
        <div
          className="qt-banner"
          data-tone="error"
          role="alert"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}
        >
          <span>{vault.error}</span>
          <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
            {vault.lastFailedSwitch?.code === 'INVALID_TARGET_PROFILE' ? (
              <button
                type="button"
                className="qt-button qt-button--primary"
                onClick={() => void handleConnectNewAccount()}
              >
                Reautenticar
              </button>
            ) : null}
            {vault.lastFailedSwitch ? (
              <button
                type="button"
                className="qt-button"
                onClick={() => void handleSwitch(vault.lastFailedSwitch!.accountId)}
              >
                Reintentar
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {vault.notice ? <div className="qt-banner" data-tone="ok">{vault.notice}</div> : null}

      {matchesLoginProvider && loginState.phase === 'waiting' ? (
        <div
          className="qt-banner"
          data-tone={loginState.timedOut ? 'warn' : 'ok'}
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}
        >
          <div>
            <div>
              {loginState.timedOut
                ? loginState.notice
                : `Esperando inicio de sesión (${loginState.loginCommand || 'agy acp --login'})...`}
            </div>
            {!loginState.timedOut && loginState.notice ? (
              <div style={{ fontSize: '11px', opacity: 0.85, marginTop: '2px' }}>{loginState.notice}</div>
            ) : null}
          </div>
          <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
            {loginState.timedOut ? (
              <button
                type="button"
                className="qt-button qt-button--primary"
                onClick={() => void guidedLoginCoordinator.retryWaiting()}
              >
                Reintentar
              </button>
            ) : null}
            <button
              type="button"
              className="qt-button"
              onClick={() => void guidedLoginCoordinator.cancelAndRestore()}
            >
              Cancelar y restaurar
            </button>
          </div>
        </div>
      ) : null}

      {matchesLoginProvider && (loginState.phase === 'done' || loginState.phase === 'cancelled') && loginState.notice ? (
        <div className="qt-banner" data-tone="ok">{loginState.notice}</div>
      ) : null}

      {matchesLoginProvider && loginState.phase === 'error' && loginState.error ? (
        <div
          className="qt-banner"
          data-tone="error"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}
        >
          <span>{loginState.error}</span>
          {loginState.canForceStart ? (
            <button
              type="button"
              className="qt-button qt-button--primary"
              onClick={() => void guidedLoginCoordinator.start(provider, { force: true })}
            >
              Forzar y continuar
            </button>
          ) : null}
        </div>
      ) : null}

      {vault.unregisteredLiveSession ? (
        <div className="qt-banner" data-tone="warn" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
          <div>
            <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <SparklesIcon size={13} />
              <span>Sesión en uso no registrada:</span>
            </strong>{' '}
            <code>{vault.unregisteredLiveSession.email}</code>
            <div style={{ fontSize: '11px', opacity: 0.85, marginTop: '2px' }}>
              Esta cuenta está activa en tu sistema operativo pero aún no la has guardado en la bóveda de {providerLabel}.
            </div>
          </div>
          <button
            type="button"
            className="qt-button qt-button--primary qt-button--md"
            style={{ whiteSpace: 'nowrap' }}
            disabled={vault.saving}
            onClick={() => void handleSave(vault.unregisteredLiveSession!.email)}
          >
            Guardar en bóveda
          </button>
        </div>
      ) : null}

      {vault.loading && vault.profiles.length === 0 ? (
        <div className="qt-empty">Cargando cuentas…</div>
      ) : vault.profiles.length === 0 ? (
        <div className="qt-empty">
          <strong>Aún no hay cuentas de {providerLabel} en la bóveda.</strong>
          <span>Guarda la sesión con la que estás trabajando para empezar a rotar cuentas en un clic.</span>
        </div>
      ) : (
        <div className="qt-accounts">
          {vault.profiles.map((prof) => {
            const isEditing = editingId === prof.id;
            const isSwitching = vault.switchingId === prof.id;
            const health = resolveCredentialHealthBadge(prof);
            // Never copy active account's live quota onto inactive cards.
            const livePct =
              prof.isActive && activeLiveQuota?.isAvailable && activeLiveQuota.primaryRemainingPercent != null
                ? Math.round(activeLiveQuota.primaryRemainingPercent)
                : null;
            const pct =
              livePct !== null
                ? livePct
                : prof.primaryRemainingPercent != null
                ? Math.round(prof.primaryRemainingPercent)
                : null;
            const reset = formatReset(
              prof.isActive && activeLiveQuota?.timeUntilResetMs != null
                ? activeLiveQuota.timeUntilResetMs
                : prof.timeUntilResetMs,
              prof.isActive && activeLiveQuota?.primaryResetAt
                ? activeLiveQuota.primaryResetAt
                : prof.primaryResetAt
            );

            return (
              <article key={prof.id} className="qt-account" data-active={prof.isActive ? '' : undefined}>
                <header className="qt-account__head">
                  <div className="qt-account__avatar-lockup">
                    <span className="qt-account__avatar" aria-hidden="true">
                      {(prof.label || '?').trim().charAt(0).toUpperCase()}
                    </span>
                    <span className="qt-account__provider-badge">
                      <BrandLogo engine={provider} size={13} />
                    </span>
                  </div>
                  <div className="qt-account__id">
                    {isEditing ? (
                      <form
                        className="qt-account__rename-row"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void handleCommitRename(prof.id);
                        }}
                      >
                        <input
                          type="text"
                          className="qt-input qt-input--md"
                          aria-label={`Nuevo nombre para ${prof.label}`}
                          value={editingLabel}
                          autoFocus
                          onChange={(e) => setEditingLabel(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              e.stopPropagation();
                              setEditingId(null);
                            }
                          }}
                        />
                        <button
                          type="submit"
                          className="qt-button qt-button--primary"
                          disabled={vault.renamingId === prof.id}
                        >
                          Guardar
                        </button>
                        <button
                          type="button"
                          className="qt-button"
                          onClick={() => setEditingId(null)}
                        >
                          Cancelar
                        </button>
                      </form>
                    ) : (
                      <div className="qt-account__name">
                        <span>{prof.label}</span>
                        <button
                          type="button"
                          className="qt-icon-button"
                          aria-label={`Renombrar perfil ${prof.label}`}
                          title="Renombrar perfil"
                          onClick={() => handleStartRename(prof.id, prof.label)}
                        >
                          <PencilIcon size={12} />
                        </button>
                        {prof.isActive ? <span className="qt-chip" data-tone="ok">Activa</span> : null}
                      </div>
                    )}
                    <div className="qt-account__meta">{prof.email || 'Sin correo detectado'}</div>
                  </div>
                </header>

                <div className="qt-account__badges">
                  {prof.planName ? <div className="qt-account__plan">{prof.planName}</div> : null}
                  {health ? (
                    <span className="qt-chip" data-tone={health.tone}>
                      {health.label}
                    </span>
                  ) : null}
                  {prof.isActive && authModeLabel ? (
                    <span className="qt-chip" data-tone="info">
                      {authModeLabel}
                    </span>
                  ) : null}
                  {prof.isActive && splitBrain ? (
                    <span className="qt-chip" data-tone="warn">
                      IDE desincronizada
                    </span>
                  ) : null}
                </div>

                {prof.isActive && splitBrain ? (
                  <div className="qt-account__split-box">
                    <span>{splitBrainDetail || 'El IDE apunta a otra sesión.'}</span>
                    <button
                      type="button"
                      className="qt-button"
                      disabled={Boolean(vault.switchingId)}
                      onClick={() => void vault.alignIde()}
                    >
                      Alinear IDE
                    </button>
                  </div>
                ) : null}

                <div className="qt-account__quota">
                  {pct !== null ? (
                    <>
                      <div className="qt-account__quota-row">
                        <span className="qt-account__pct" data-tone={toneFor(pct)}>{pct}%</span>
                        <span className="qt-account__hint">disponible</span>
                        {prof.isActive ? (
                          <button
                            type="button"
                            className="qt-icon-button"
                            style={{ marginLeft: 'auto' }}
                            disabled={refreshingQuota}
                            aria-label="Actualizar cuota"
                            title="Actualizar cuota en vivo"
                            onClick={() => void handleRefreshActiveQuota()}
                          >
                            <RefreshSmallIcon size={12} />
                          </button>
                        ) : null}
                      </div>
                      <div className="qt-meter" data-tone={toneFor(pct)}>
                        <span style={{ width: `${Math.max(2, pct)}%` }} />
                      </div>
                      {reset ? <div className="qt-account__hint">{reset}</div> : null}
                    </>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                      <span className="qt-account__hint">
                        {prof.isActive
                          ? 'Cuota no disponible todavía'
                          : 'Activa esta cuenta para consultar su cuota en vivo'}
                      </span>
                      {prof.isActive ? (
                        <button
                          type="button"
                          className="qt-icon-button"
                          disabled={refreshingQuota}
                          aria-label="Actualizar cuota"
                          title="Actualizar cuota en vivo"
                          onClick={() => void handleRefreshActiveQuota()}
                        >
                          <RefreshSmallIcon size={12} />
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>

                <footer className="qt-account__actions">
                  {prof.isActive ? (
                    <span className="qt-account__hint">
                      {isSwitching ? 'Cambiando y verificando...' : 'En uso ahora'}
                    </span>
                  ) : (
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <button
                        type="button"
                        className="qt-button qt-button--primary"
                        disabled={isSwitching || Boolean(vault.switchingId)}
                        onClick={() => void handleSwitch(prof.id)}
                      >
                        {isSwitching ? 'Cambiando y verificando...' : 'Activar'}
                      </button>
                      {health?.needsReauth ? (
                        <button
                          type="button"
                          className="qt-button"
                          disabled={isConnectingNew}
                          onClick={() => void handleConnectNewAccount()}
                        >
                          Reautenticar
                        </button>
                      ) : null}
                    </div>
                  )}
                  <button
                    type="button"
                    className="qt-button qt-button--ghost"
                    onClick={() => vault.requestDeleteProfile(prof)}
                    title="Eliminar perfil guardado"
                  >
                    Eliminar
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      )}

      <div className="qt-save">
        <div className="qt-save__copy">
          <h4>Guardar la sesión actual de {providerLabel}</h4>
          <p>Captura las credenciales de la cuenta activa en tu equipo y las guarda en la bóveda local.</p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', width: '100%' }}>
          <input
            className="qt-input qt-input--md"
            type="text"
            style={{ flex: 1 }}
            placeholder="Nombre de la cuenta (ej. Google Pro Personal)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSave();
            }}
          />
          <button
            type="button"
            className="qt-button qt-button--primary qt-button--md"
            style={{ whiteSpace: 'nowrap' }}
            disabled={vault.saving}
            onClick={() => void handleSave()}
          >
            {vault.saving ? 'Guardando…' : 'Guardar sesión'}
          </button>
          <button
            type="button"
            className="qt-button qt-button--md"
            style={{ whiteSpace: 'nowrap' }}
            disabled={isConnectingNew}
            onClick={() => void handleConnectNewAccount()}
          >
            {isConnectingNew ? 'Preparando…' : '+ Conectar nueva cuenta'}
          </button>
        </div>
      </div>

      {provider === 'antigravity' ? (
        <details className="qt-howto">
          <summary>¿Cómo agrego otra cuenta de Antigravity?</summary>
          <ol>
            <li>Pulsa <strong>+ Conectar nueva cuenta</strong> para abrir una terminal guiada con <code>agy acp --login</code>.</li>
            <li>Completa el inicio de sesión en tu navegador; Kite verificará los tokens OAuth y guardará la cuenta automáticamente.</li>
            <li>Si cancelas el proceso, Kite restaurará tu sesión anterior automáticamente para no interrumpir tu trabajo.</li>
          </ol>
          <p>El inicio de sesión se hace una sola vez por cuenta; después rotas en un clic, sin proxies externos.</p>
        </details>
      ) : null}

      <AccountConfirmDialogs
        busyConfirm={vault.busyConfirm}
        deleteConfirmProfile={vault.deleteConfirmProfile}
        overwritePrompt={vault.overwritePrompt}
        saving={vault.saving}
        deletingId={vault.deletingId}
        switchingId={vault.switchingId}
        onConfirmBusy={async () => {
          const res = await vault.confirmBusySwitch();
          if (res?.success) onChanged?.();
        }}
        onCancelBusy={vault.cancelBusySwitch}
        onConfirmDelete={async () => {
          const res = await vault.confirmDeleteProfile();
          if (res.success) onChanged?.();
        }}
        onCancelDelete={vault.cancelDeleteProfile}
        onConfirmOverwriteUpdate={async () => {
          const res = await vault.confirmOverwriteUpdate();
          if (res.success) {
            setLabel('');
            onChanged?.();
          }
        }}
        onConfirmOverwriteRename={async () => {
          const res = await vault.confirmOverwriteRename();
          if (res.success) {
            setLabel('');
            onChanged?.();
          }
        }}
        onCancelOverwrite={vault.cancelOverwritePrompt}
      />
    </div>
  );
};
