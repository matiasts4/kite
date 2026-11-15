import React, { useMemo, useState } from 'react';
import '../views/settings/quotas-tab.css';
import type {
  AutoSwitchPolicy,
  AutoSwitchRuntimeStatus,
  PendingAutoSwitchConfirmation,
  SavedAccountProfile,
} from '../../types';
import { resolveOrderedAutoSwitchProfiles } from '../../lib/accounts/accountVaultStore';
import { formatTimeUntil } from '../../lib/quota/useResetCountdownClock';

export interface AutoSwitchPauseSummary {
  title: string;
  detail?: string;
  tone: 'warn' | 'error';
}

export function formatAutoSwitchPauseMessage(
  status: AutoSwitchRuntimeStatus
): AutoSwitchPauseSummary {
  switch (status.pauseReason) {
    case 'ALL_ACCOUNTS_EXHAUSTED': {
      const resetMs =
        typeof status.nextResetMs === 'number' && Number.isFinite(status.nextResetMs)
          ? status.nextResetMs
          : status.nextResetAt
            ? Date.parse(status.nextResetAt) - Date.now()
            : null;
      const resetCountdown =
        resetMs != null && Number.isFinite(resetMs) ? formatTimeUntil(resetMs) : null;
      return {
        title: 'Auto-cambio pausado: todas las cuentas en 0%',
        detail: resetCountdown
          ? `Próximo reset estimado en ${resetCountdown}.`
          : status.nextResetAt
            ? `Próximo reset estimado: ${status.nextResetAt}.`
            : 'Ninguna cuenta elegible tiene cuota disponible en este momento.',
        tone: 'warn',
      };
    }
    case 'CIRCUIT_BREAKER_PAUSED':
      return {
        title: 'Auto-cambio pausado por seguridad',
        detail: `${status.recentSwitchCount} rotaciones consecutivas alcanzaron el límite temporal.`,
        tone: 'error',
      };
    case 'IDE_PROCESS_BUSY':
      return {
        title: 'Auto-cambio pausado: el IDE está abierto',
        detail: status.baseAppTitles?.length
          ? `Cierra ${status.baseAppTitles.join(', ')} y presiona Reanudar.`
          : 'Cierra el IDE activo y presiona Reanudar para continuar.',
        tone: 'error',
      };
    case 'RESIDUAL_PROCESSES_BLOCKING':
      return {
        title: 'Auto-cambio pausado: procesos residuales bloqueando',
        detail:
          status.residualProcessCount && status.residualProcessCount > 0
            ? `${status.residualProcessCount} proceso(s) secundarios de Antigravity bloquean la rotación.`
            : 'Procesos secundarios de Antigravity impiden actualizar los archivos de sesión.',
        tone: 'error',
      };
    case 'BUSY_TERMINALS_DEFERRED':
      return {
        title: 'Auto-cambio en espera por terminales ocupadas',
        detail:
          'Existen turnos o terminales activas. Puedes esperar a que finalicen o reanudar manualmente.',
        tone: 'warn',
      };
    default:
      return {
        title: 'Auto-cambio pausado',
        detail:
          status.pauseReason ||
          'Revisa el estado de tus cuentas y presiona Reanudar cuando estés listo.',
        tone: 'warn',
      };
  }
}

export interface AutoSwitchStatusBannerProps {
  status: AutoSwitchRuntimeStatus;
  resuming?: boolean;
  closingProcesses?: boolean;
  pendingCount?: number;
  compact?: boolean;
  onResume?: () => void | Promise<unknown>;
  onCloseResidualProcesses?: () => void | Promise<unknown>;
}

export const AutoSwitchStatusBanner: React.FC<AutoSwitchStatusBannerProps> = ({
  status,
  resuming = false,
  closingProcesses = false,
  pendingCount = 0,
  compact = false,
  onResume,
  onCloseResidualProcesses,
}) => {
  const inCooldown =
    !status.paused &&
    typeof status.cooldownUntilMs === 'number' &&
    status.cooldownUntilMs > Date.now();
  const cooldownSeconds = inCooldown
    ? Math.max(1, Math.ceil((status.cooldownUntilMs! - Date.now()) / 1000))
    : 0;

  if (!status.paused && !inCooldown && pendingCount === 0) {
    return null;
  }

  const pauseCopy = status.paused ? formatAutoSwitchPauseMessage(status) : null;
  const showCloseResidual =
    status.paused &&
    status.pauseReason === 'RESIDUAL_PROCESSES_BLOCKING' &&
    Boolean(onCloseResidualProcesses);

  return (
    <div className={`qt-auto-banners${compact ? ' qt-auto-banners--compact' : ''}`}>
      {pauseCopy ? (
        <div
          className="qt-banner qt-auto-banner"
          data-tone={pauseCopy.tone}
          role="status"
        >
          <div className="qt-auto-banner__copy">
            <strong>{pauseCopy.title}</strong>
            {pauseCopy.detail ? (
              <span className="qt-auto-banner__detail">{pauseCopy.detail}</span>
            ) : null}
          </div>
          <div className="qt-auto-banner__actions">
            {showCloseResidual ? (
              <button
                type="button"
                className="qt-button qt-button--sm qt-button--danger"
                disabled={closingProcesses || resuming}
                onClick={() => void onCloseResidualProcesses?.()}
              >
                {closingProcesses ? 'Cerrando…' : 'Cerrar procesos Antigravity'}
              </button>
            ) : null}
            {onResume ? (
              <button
                type="button"
                className="qt-button qt-button--sm qt-button--primary"
                disabled={resuming || closingProcesses}
                onClick={() => void onResume()}
              >
                {resuming ? 'Reanudando…' : 'Reanudar'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {inCooldown ? (
        <div className="qt-banner qt-auto-banner" data-tone="warn">
          <div className="qt-auto-banner__copy">
            <strong>Enfriamiento activo ({cooldownSeconds}s)</strong>
            <span className="qt-auto-banner__detail">
              Pausa breve tras una rotación reciente para evitar cambios en cascada.
            </span>
          </div>
        </div>
      ) : null}

      {pendingCount > 0 ? (
        <div className="qt-banner qt-auto-banner" data-tone="warn">
          <div className="qt-auto-banner__copy">
            <strong>
              {pendingCount === 1
                ? '1 confirmación de cambio automático pendiente'
                : `${pendingCount} confirmaciones de cambio automático pendientes`}
            </strong>
            <span className="qt-auto-banner__detail">
              Revisa Notificaciones para elegir modelo destino o confirmar el cambio.
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export interface AutoSwitchSettingsPanelProps {
  variant?: 'full' | 'compact';
  provider: string;
  profiles: SavedAccountProfile[];
  policy: AutoSwitchPolicy;
  status: AutoSwitchRuntimeStatus;
  pendingConfirmations?: PendingAutoSwitchConfirmation[];
  saving?: boolean;
  resuming?: boolean;
  closingProcesses?: boolean;
  onUpdatePolicy: (patch: Partial<AutoSwitchPolicy>) => void | Promise<unknown>;
  onToggleAccountEligibility: (accountId: string) => void | Promise<unknown>;
  onMoveAccountPriority: (
    accountId: string,
    direction: 'up' | 'down'
  ) => void | Promise<unknown>;
  onResume: () => void | Promise<unknown>;
  onCloseResidualProcesses?: () => void | Promise<unknown>;
  onConfirmPending?: (
    confirmation: PendingAutoSwitchConfirmation,
    selectedModelId?: string
  ) => void | Promise<unknown>;
  onDismissPending?: (confirmationId: string) => void | Promise<unknown>;
}

export const AutoSwitchSettingsPanel: React.FC<AutoSwitchSettingsPanelProps> = ({
  variant = 'full',
  provider: _provider,
  profiles,
  policy,
  status,
  pendingConfirmations = [],
  saving = false,
  resuming = false,
  closingProcesses = false,
  onUpdatePolicy,
  onToggleAccountEligibility,
  onMoveAccountPriority,
  onResume,
  onCloseResidualProcesses,
  onConfirmPending,
  onDismissPending,
}) => {
  const [compactExpanded, setCompactExpanded] = useState(false);
  const [fullExpanded, setFullExpanded] = useState(false);
  const isCompact = variant === 'compact';
  const showBody = isCompact
    ? compactExpanded
    : policy.enabled ||
      status.paused ||
      pendingConfirmations.length > 0 ||
      fullExpanded;

  const orderedProfiles = useMemo(
    () => resolveOrderedAutoSwitchProfiles(profiles, policy.priorityOrder),
    [profiles, policy.priorityOrder]
  );

  const excludedSet = useMemo(
    () => new Set(policy.excludedAccountIds || []),
    [policy.excludedAccountIds]
  );

  const eligibleCount = useMemo(
    () => orderedProfiles.filter((prof) => !excludedSet.has(prof.id)).length,
    [orderedProfiles, excludedSet]
  );

  const stateChip = status.paused
    ? { label: 'Pausado', tone: 'warn' as const }
    : pendingConfirmations.length > 0
      ? { label: 'Confirmar', tone: 'warn' as const }
      : policy.enabled
        ? { label: 'Activo', tone: 'ok' as const }
        : { label: 'Inactivo', tone: undefined };

  return (
    <section
      className={`qt-auto-panel${isCompact ? ' qt-auto-panel--compact' : ''}`}
      aria-label="Configuración de cambio automático"
    >
      <header className="qt-auto-panel__header">
        <div className="qt-auto-panel__heading">
          <div className="qt-auto-panel__title-row">
            <h4 className="qt-auto-panel__title">Cambio automático al 0%</h4>
            <span className="qt-chip" data-tone={stateChip.tone}>
              {stateChip.label}
            </span>
          </div>
          <p className="qt-auto-panel__subtitle">
            {policy.enabled
              ? `Rotación automática habilitada con ${eligibleCount} cuenta${eligibleCount === 1 ? '' : 's'} elegible${eligibleCount === 1 ? '' : 's'}.`
              : 'Rota automáticamente a otra cuenta guardada cuando la actual alcance 0% de cuota.'}
          </p>
        </div>

        <div className="qt-auto-panel__header-actions">
          {isCompact ? (
            <button
              type="button"
              className="qt-button qt-button--sm"
              aria-expanded={compactExpanded}
              onClick={() => setCompactExpanded((prev) => !prev)}
            >
              Opciones
            </button>
          ) : !policy.enabled && !status.paused && pendingConfirmations.length === 0 ? (
            <button
              type="button"
              className="qt-button qt-button--sm"
              aria-expanded={fullExpanded}
              onClick={() => setFullExpanded((prev) => !prev)}
            >
              Configurar reglas
            </button>
          ) : null}
          <button
            type="button"
            role="switch"
            aria-checked={policy.enabled}
            aria-label="Cambio automático al 0%"
            className="ui-switch"
            disabled={saving}
            onClick={() => void onUpdatePolicy({ enabled: !policy.enabled })}
          >
            <span aria-hidden="true" className="ui-switch__knob" />
          </button>
        </div>
      </header>

      <AutoSwitchStatusBanner
        status={status}
        resuming={resuming}
        closingProcesses={closingProcesses}
        pendingCount={pendingConfirmations.length}
        compact={isCompact}
        onResume={onResume}
        onCloseResidualProcesses={onCloseResidualProcesses}
      />

      {showBody ? (
        <div className="qt-auto-panel__body">
          <div className="qt-auto-grid">
            <label className="qt-auto-field">
              <span>Estrategia de selección</span>
              <select
                aria-label="Estrategia de selección"
                className="qt-input qt-auto-select"
                value={policy.selectionStrategy}
                disabled={saving}
                onChange={(e) =>
                  void onUpdatePolicy({
                    selectionStrategy: e.target
                      .value as AutoSwitchPolicy['selectionStrategy'],
                  })
                }
              >
                <option value="highest_quota">Mayor cuota disponible</option>
                <option value="priority_order">Orden manual de prioridad</option>
              </select>
            </label>

            <label className="qt-auto-field">
              <span>Si cambia el plan o modelo</span>
              <select
                aria-label="Si cambia el plan o modelo"
                className="qt-input qt-auto-select"
                value={policy.modelMismatchPolicy}
                disabled={saving}
                onChange={(e) =>
                  void onUpdatePolicy({
                    modelMismatchPolicy: e.target
                      .value as AutoSwitchPolicy['modelMismatchPolicy'],
                  })
                }
              >
                <option value="confirm_notification">
                  Pedir confirmación (notificación)
                </option>
                <option value="auto_fallback">
                  Elegir equivalente automáticamente
                </option>
              </select>
            </label>

            <label className="qt-auto-field">
              <span>Terminales ocupadas</span>
              <select
                aria-label="Terminales ocupadas"
                className="qt-input qt-auto-select"
                value={policy.busyTerminalsPolicy}
                disabled={saving}
                onChange={(e) =>
                  void onUpdatePolicy({
                    busyTerminalsPolicy: e.target
                      .value as AutoSwitchPolicy['busyTerminalsPolicy'],
                  })
                }
              >
                <option value="wait_idle">Esperar en segundo plano</option>
                <option value="ask">Preguntar antes de cambiar</option>
                <option value="interrupt">Interrumpir y aplicar</option>
              </select>
            </label>
          </div>

          <label className="qt-auto-checkbox">
            <input
              type="checkbox"
              checked={policy.autoContinueChatTurn}
              disabled={saving}
              onChange={(e) =>
                void onUpdatePolicy({ autoContinueChatTurn: e.target.checked })
              }
            />
            <span>Reanudar turno de chat automáticamente tras rotar cuenta</span>
          </label>

          {orderedProfiles.length > 0 ? (
            <div className="qt-auto-accounts">
              <div className="qt-auto-accounts__head">
                <span className="qt-auto-accounts__label">
                  Cuentas elegibles y orden de prioridad
                </span>
                {policy.selectionStrategy !== 'priority_order' ? (
                  <span className="qt-hint">
                    Orden activo solo en «Orden manual de prioridad»
                  </span>
                ) : null}
              </div>

              <div className="qt-auto-accounts__list">
                {orderedProfiles.map((prof, idx) => {
                  const isExcluded = excludedSet.has(prof.id);
                  const disableReorder =
                    saving || policy.selectionStrategy !== 'priority_order';
                  return (
                    <div
                      key={prof.id}
                      className="qt-auto-account-row"
                      data-excluded={isExcluded ? 'true' : undefined}
                    >
                      <label className="qt-auto-account-row__toggle">
                        <input
                          type="checkbox"
                          aria-label={`Incluir ${prof.label}`}
                          checked={!isExcluded}
                          disabled={saving}
                          onChange={() => void onToggleAccountEligibility(prof.id)}
                        />
                        <span className="qt-auto-account-row__order">#{idx + 1}</span>
                        <span className="qt-auto-account-row__name">{prof.label}</span>
                        {prof.email ? (
                          <span className="qt-auto-account-row__email">{prof.email}</span>
                        ) : null}
                      </label>

                      <div className="qt-auto-account-row__controls">
                        {prof.planName ? (
                          <span className="qt-chip">{prof.planName}</span>
                        ) : null}
                        <button
                          type="button"
                          className="qt-button qt-button--sm"
                          aria-label={`Subir prioridad de ${prof.label}`}
                          disabled={disableReorder || idx === 0}
                          onClick={() => void onMoveAccountPriority(prof.id, 'up')}
                          title="Subir prioridad"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="qt-button qt-button--sm"
                          aria-label={`Bajar prioridad de ${prof.label}`}
                          disabled={disableReorder || idx === orderedProfiles.length - 1}
                          onClick={() => void onMoveAccountPriority(prof.id, 'down')}
                          title="Bajar prioridad"
                        >
                          ↓
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {pendingConfirmations.length > 0 && (onConfirmPending || onDismissPending) ? (
            <div className="qt-auto-pending-list">
              {pendingConfirmations.map((item) => {
                const targetModel =
                  item.suggestedFallbackModel || item.availableTargetModels[0];
                return (
                  <div key={item.confirmationId} className="qt-auto-pending-item">
                    <div className="qt-auto-pending-item__copy">
                      <strong>
                        Pendiente: {item.fromAccountLabel || 'actual'} →{' '}
                        {item.toAccountLabel || item.toAccountId}
                      </strong>
                      <span>
                        {targetModel
                          ? `Modelo sugerido: ${targetModel}`
                          : 'Requiere confirmación para continuar'}
                      </span>
                    </div>
                    <div className="qt-auto-pending-item__actions">
                      {onConfirmPending ? (
                        <button
                          type="button"
                          className="qt-button qt-button--sm qt-button--primary"
                          onClick={() => void onConfirmPending(item, targetModel)}
                        >
                          Confirmar cambio
                        </button>
                      ) : null}
                      {onDismissPending ? (
                        <button
                          type="button"
                          className="qt-button qt-button--sm"
                          onClick={() => void onDismissPending(item.confirmationId)}
                        >
                          Descartar
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
};
