import React, { useCallback, useEffect, useState } from 'react';
import type { SavedAccountProfile } from '../../../types';
import {
  deleteAccountProfile,
  listSavedAccountsFull,
  saveCurrentAccountProfile,
  switchAccountProfile,
} from '../../../lib/ipc';
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
  const [profiles, setProfiles] = useState<SavedAccountProfile[]>([]);
  const [unregisteredSession, setUnregisteredSession] = useState<{
    email: string;
    planName?: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const providerLabel = MULTI_ACCOUNT_PROVIDERS.find((p) => p.id === provider)?.label ?? provider;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listSavedAccountsFull(provider);
      setProfiles(res.profiles || []);
      setUnregisteredSession(
        res.unregisteredLiveSession ? { email: res.unregisteredLiveSession.email, planName: res.unregisteredLiveSession.planName } : null
      );
    } catch {
      setError('No se pudieron cargar las cuentas guardadas.');
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    setError(null);
    setNotice(null);
    void refresh();
  }, [refresh]);

  const handleSwitch = async (id: string) => {
    if (switchingId) return;
    setSwitchingId(id);
    setError(null);
    setNotice(null);
    // Optimistically reflect active account immediately for instantaneous visual feedback
    setProfiles((prev) =>
      prev.map((p) => ({
        ...p,
        isActive: p.id === id,
      }))
    );
    try {
      const res = await switchAccountProfile(provider, id);
      if (res.success && res.profile) {
        const restartedCount = (res as any).terminalsRestarted ?? 0;
        const terminalNotice =
          restartedCount > 0
            ? ` (${restartedCount} terminal${restartedCount > 1 ? 'es' : ''} actualizada${restartedCount > 1 ? 's' : ''})`
            : '';
        setNotice(`Sesión cambiada a «${res.profile.label}»${terminalNotice}.`);
        window.dispatchEvent(
          new CustomEvent('kite:terminal-command', {
            detail: { command: 'restart-agent' },
          })
        );
        void refresh();
        onChanged?.();
      } else {
        setError(res.error || 'No se pudo cambiar la sesión.');
        await refresh();
      }
    } catch (err: any) {
      setError(err?.message || 'Error al cambiar cuenta');
      await refresh();
    } finally {
      setSwitchingId(null);
    }
  };

  const handleSave = async (overrideLabel?: string) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const profileName = overrideLabel || label.trim() || `Cuenta ${profiles.length + 1}`;
      const res = await saveCurrentAccountProfile(provider, profileName);
      if (res.success && res.profile) {
        setNotice(`Sesión actual guardada como «${res.profile.label}».`);
        setLabel('');
        void refresh();
        onChanged?.();
      } else {
        setError(res.error || 'No se pudo guardar la sesión actual.');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('¿Eliminar este perfil guardado de la bóveda?')) return;
    await deleteAccountProfile(provider, id);
    await refresh();
    onChanged?.();
  };

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

      {error ? <div className="qt-banner" data-tone="error">{error}</div> : null}
      {notice ? <div className="qt-banner" data-tone="ok">{notice}</div> : null}

      {unregisteredSession ? (
        <div className="qt-banner" data-tone="warn" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
          <div>
            <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <SparklesIcon size={13} />
              <span>Sesión en uso no registrada:</span>
            </strong>{' '}
            <code>{unregisteredSession.email}</code>
            <div style={{ fontSize: '11px', opacity: 0.85, marginTop: '2px' }}>
              Esta cuenta está activa en tu sistema operativo pero aún no la has guardado en la bóveda de {providerLabel}.
            </div>
          </div>
          <button
            type="button"
            className="qt-button qt-button--primary"
            style={{ whiteSpace: 'nowrap' }}
            disabled={saving}
            onClick={() => handleSave(unregisteredSession.email)}
          >
            Guardar en bóveda
          </button>
        </div>
      ) : null}

      {loading && profiles.length === 0 ? (
        <div className="qt-empty">Cargando cuentas…</div>
      ) : profiles.length === 0 ? (
        <div className="qt-empty">
          <strong>Aún no hay cuentas de {providerLabel} en la bóveda.</strong>
          <span>Guarda la sesión con la que estás trabajando para empezar a rotar cuentas en un clic.</span>
        </div>
      ) : (
        <div className="qt-accounts">
          {profiles.map((prof) => {
            const pct =
              prof.primaryRemainingPercent != null ? Math.round(prof.primaryRemainingPercent) : null;
            const reset = formatReset(prof.timeUntilResetMs, prof.primaryResetAt);
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
                    <div className="qt-account__name">
                      <span>{prof.label}</span>
                      {prof.isActive ? <span className="qt-chip" data-tone="ok">Activa</span> : null}
                    </div>
                    <div className="qt-account__meta">{prof.email || 'Sin correo detectado'}</div>
                  </div>
                </header>

                {prof.planName ? <div className="qt-account__plan">{prof.planName}</div> : null}

                <div className="qt-account__quota">
                  {pct !== null ? (
                    <>
                      <div className="qt-account__quota-row">
                        <span className="qt-account__pct" data-tone={toneFor(pct)}>{pct}%</span>
                        <span className="qt-account__hint">disponible</span>
                      </div>
                      <div className="qt-meter" data-tone={toneFor(pct)}>
                        <span style={{ width: `${Math.max(2, pct)}%` }} />
                      </div>
                      {reset ? <div className="qt-account__hint">{reset}</div> : null}
                    </>
                  ) : (
                    <div className="qt-account__hint">Cuota no disponible todavía</div>
                  )}
                </div>

                <footer className="qt-account__actions">
                  {prof.isActive ? (
                    <span className="qt-account__hint">En uso ahora</span>
                  ) : (
                    <button
                      type="button"
                      className="qt-button qt-button--primary"
                      disabled={switchingId === prof.id}
                      onClick={() => handleSwitch(prof.id)}
                    >
                      {switchingId === prof.id ? 'Cambiando…' : 'Activar'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="qt-button qt-button--ghost"
                    onClick={() => handleDelete(prof.id)}
                    title="Eliminar perfil"
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
        <input
          className="qt-input"
          type="text"
          placeholder="Nombre de la cuenta (ej. Google Pro Personal)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSave();
          }}
        />
        <button type="button" className="qt-button qt-button--primary" disabled={saving} onClick={() => void handleSave()}>
          {saving ? 'Guardando…' : 'Guardar sesión'}
        </button>
      </div>

      {provider === 'antigravity' ? (
        <details className="qt-howto">
          <summary>¿Cómo agrego otra cuenta de Antigravity?</summary>
          <ol>
            <li>Abre <strong>Antigravity IDE</strong> e inicia sesión con tu otra cuenta de Google AI Pro.</li>
            <li>Cierra Antigravity para liberar los archivos de sesión.</li>
            <li>Vuelve aquí, escribe un nombre y pulsa <strong>Guardar sesión</strong>.</li>
          </ol>
          <p>El inicio de sesión se hace una sola vez por cuenta; después rotas en un clic, sin proxies externos.</p>
        </details>
      ) : null}
    </div>
  );
};
