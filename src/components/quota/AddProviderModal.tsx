import React, { useState, useMemo, useId, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { surfaceMotion } from '../../motion/standard/surfaces';
import { springs, tweens } from '../../motion/standard/tokens';
import { BrandLogo } from '../ui/BrandLogo';
import {
  PROVIDER_LABELS,
  type ProviderQuotaStatus,
} from '../../lib/quota/types';
import { diagnoseProvider } from '../../lib/quota/providerState';
import { ENGINE_METADATA } from '../views/agents/engineMetadata';
import { PROVIDER_CONFIGS_ES } from './QuotaSettingsModal';
import { type ProviderDetectedSession } from '../../lib/quota/sessionDetection';
import { getProviderConnectionMeta } from '../../lib/quota/connectionMethods';
import { XIcon } from '../views/settings/icons';

export interface AddProviderModalProps {
  isOpen: boolean;
  onClose: () => void;
  availableProviders: string[];
  quotas: Record<string, ProviderQuotaStatus>;
  detectedSessions?: Record<string, ProviderDetectedSession>;
  onAdd: (providerIds: string[]) => void;
}

export const AddProviderModal: React.FC<AddProviderModalProps> = ({
  isOpen,
  onClose,
  availableProviders,
  quotas,
  detectedSessions = {},
  onAdd,
}) => {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (isOpen) {
      setSelectedIds([]);
      setSearchQuery('');
    }
  }, [isOpen]);

  const filteredProviders = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return availableProviders;
    return availableProviders.filter((id) => {
      const label = (PROVIDER_LABELS[id] || id).toLowerCase();
      const meta = ENGINE_METADATA[id];
      const vendor = (meta?.vendor || '').toLowerCase();
      const cfg = PROVIDER_CONFIGS_ES[id];
      const desc = (cfg?.desc || '').toLowerCase();
      return id.toLowerCase().includes(q) || label.includes(q) || vendor.includes(q) || desc.includes(q);
    });
  }, [availableProviders, searchQuery]);

  const detectedCount = useMemo(() => {
    return filteredProviders.filter((id) => {
      const s = detectedSessions[id];
      if (s) return s.hasSession;
      const diag = diagnoseProvider(quotas[id]);
      return diag.state === 'ok' || diag.state === 'detected';
    }).length;
  }, [filteredProviders, detectedSessions, quotas]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const selectAll = () => {
    setSelectedIds([...filteredProviders]);
  };

  const selectDetectedOnly = () => {
    const detected = filteredProviders.filter((id) => {
      const s = detectedSessions[id];
      if (s) return s.hasSession;
      const diag = diagnoseProvider(quotas[id]);
      return diag.state === 'ok' || diag.state === 'detected';
    });
    setSelectedIds(detected);
  };

  const clearSelection = () => {
    setSelectedIds([]);
  };

  const handleConfirm = () => {
    if (selectedIds.length === 0) return;
    onAdd(selectedIds);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  };

  if (!isOpen) return null;

  const content = (
    <motion.div
      key="add-provider-scrim"
      {...surfaceMotion('scrim')}
      transition={tweens.overlay}
      className="qt-modal-scrim"
      onClick={onClose}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <motion.div
        key="add-provider-dialog"
        {...surfaceMotion('dialog')}
        transition={springs.dialog}
        className="qt-modal-container"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
      >
        {/* Header */}
        <header className="qt-modal-header">
          <div className="qt-modal-header__brand">
            <span className="qt-modal-icon-badge" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </span>
            <div>
              <h2 id={titleId} className="qt-modal-title">
                Agregar proveedores de IA
              </h2>
              <p id={descId} className="qt-modal-desc">
                Selecciona los proveedores que deseas monitorear y conectar a Kite.
              </p>
            </div>
          </div>
          <button
            type="button"
            className="qt-modal-close"
            onClick={onClose}
            aria-label="Cerrar"
          >
            <XIcon size={14} />
          </button>
        </header>

        {/* Toolbar & Search */}
        <div className="qt-modal-toolbar">
          <div className="qt-modal-search-wrapper">
            <svg className="qt-modal-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              className="qt-modal-search-input"
              placeholder="Buscar por nombre, proveedor o modelo (ej. Claude, Grok, Codex)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoFocus
            />
            {searchQuery ? (
              <button
                type="button"
                className="qt-modal-search-clear"
                onClick={() => setSearchQuery('')}
                aria-label="Limpiar búsqueda"
              >
                <XIcon size={13} />
              </button>
            ) : null}
          </div>

          <div className="qt-modal-quick-actions">
            <button
              type="button"
              className="qt-button qt-button--ghost"
              onClick={selectAll}
              disabled={filteredProviders.length === 0}
            >
              Seleccionar todos ({filteredProviders.length})
            </button>
            <button
              type="button"
              className="qt-button qt-button--ghost"
              onClick={selectDetectedOnly}
              disabled={detectedCount === 0}
            >
              Solo con sesión detectada {detectedCount > 0 ? `(${detectedCount})` : ''}
            </button>
            {selectedIds.length > 0 ? (
              <button
                type="button"
                className="qt-button qt-button--ghost"
                onClick={clearSelection}
              >
                Deseleccionar todos
              </button>
            ) : null}
          </div>
        </div>

        {/* Body / Provider Grid */}
        <div className="qt-modal-body">
          {filteredProviders.length === 0 ? (
            <div className="qt-empty" style={{ margin: '20px 0' }}>
              <strong>
                {availableProviders.length === 0
                  ? 'Todos los proveedores soportados ya están agregados'
                  : 'No se encontraron proveedores que coincidan con la búsqueda'}
              </strong>
              <span>
                {availableProviders.length === 0
                  ? 'Puedes administrarlos y ordenarlos desde la lista superior.'
                  : 'Prueba buscando con otro término.'}
              </span>
            </div>
          ) : (
            <div className="qt-provider-cards-grid">
              {filteredProviders.map((id) => {
                const isSelected = selectedIds.includes(id);
                const s = detectedSessions[id];
                const diag = diagnoseProvider(quotas[id]);
                const meta = ENGINE_METADATA[id];
                const metaMethod = getProviderConnectionMeta(id);
                const cfg = PROVIDER_CONFIGS_ES[id];
                const label = PROVIDER_LABELS[id] || id;
                const vendor = meta?.vendor || 'IA';

                const tone = s
                  ? s.statusTone
                  : diag.state === 'ok' || diag.state === 'detected'
                  ? 'ok'
                  : diag.state === 'not_installed'
                  ? 'idle'
                  : 'warn';

                const statusLabel = s
                  ? s.statusLabel
                  : diag.state === 'ok' || diag.state === 'detected'
                  ? 'Sesión detectada'
                  : diag.state === 'not_installed'
                  ? 'Conectar (CLI / API Key)'
                  : 'Atención requerida';

                const accountHint = s?.email || s?.accountLabel || s?.terminalTitle;

                return (
                  <div
                    key={id}
                    className="qt-provider-pick-card"
                    data-selected={isSelected ? '' : undefined}
                    data-detected={s?.hasSession ? 'true' : undefined}
                    onClick={() => toggleSelect(id)}
                  >
                    <div className="qt-provider-pick-card__checkbox">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {}} // Controlled via card click
                        aria-label={`Seleccionar ${label}`}
                        tabIndex={-1}
                      />
                    </div>

                    <div className="qt-provider-pick-card__logo-tile">
                      <BrandLogo engine={id} size={26} />
                    </div>

                    <div className="qt-provider-pick-card__info">
                      <div className="qt-provider-pick-card__title-row">
                        <span className="qt-provider-pick-card__name">{label}</span>
                        <span className="qt-provider-pick-card__vendor">{vendor}</span>
                      </div>
                      <p className="qt-provider-pick-card__desc">
                        {cfg?.desc || 'Integración con CLI y monitoreo de límites.'}
                      </p>
                      <div className="qt-provider-pick-card__status-row">
                        <span className="qt-chip" data-tone={tone}>
                          <span className="qt-status-dot" data-tone={tone} />
                          {statusLabel}
                        </span>
                        {accountHint ? (
                          <span className="qt-provider-pick-card__account-detail" title={accountHint}>
                            {accountHint}
                          </span>
                        ) : (
                          <div className="qt-provider-pick-card__methods-tags" title="Métodos disponibles">
                            {metaMethod?.supportsCli ? <span className="qt-method-tag">CLI</span> : null}
                            {metaMethod?.supportsApiKey ? <span className="qt-method-tag">API Key</span> : null}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <footer className="qt-modal-footer">
          <div className="qt-modal-footer__count">
            {selectedIds.length > 0 ? (
              <span>
                <strong>{selectedIds.length}</strong> proveedor{selectedIds.length === 1 ? '' : 'es'} seleccionado{selectedIds.length === 1 ? '' : 's'}
              </span>
            ) : (
              <span className="qt-hint">Selecciona al menos un proveedor para continuar</span>
            )}
          </div>
          <div className="qt-modal-footer__actions">
            <button
              type="button"
              className="qt-button"
              onClick={onClose}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="qt-button qt-button--primary"
              disabled={selectedIds.length === 0}
              onClick={handleConfirm}
            >
              {selectedIds.length > 0
                ? `Agregar ${selectedIds.length} proveedor${selectedIds.length === 1 ? '' : 'es'}`
                : 'Agregar proveedores'}
            </button>
          </div>
        </footer>
      </motion.div>
    </motion.div>
  );

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>{isOpen ? content : null}</AnimatePresence>,
    document.querySelector('.app-frame--scaled') ?? document.body
  );
};
