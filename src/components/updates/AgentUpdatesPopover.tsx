import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { BrandLogo } from '../views/agents/engineMetadata';
import { openSettingsTab } from '../../lib/settingsNav';
import type { AgentUpdatesSummary, ToolJobProgress } from '../../types/agentUpdates';
import { triggerAgentToolJob } from '../../lib/agentUpdates';
import {
  ArrowRightIcon,
  ArrowUpIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  RefreshIcon,
} from '../titlebar/TopbarPopoverIcons';
import '../titlebar/topbar-popovers.css';
import './agent-updates-popover.css';

export interface AgentUpdatesPopoverProps {
  summary: AgentUpdatesSummary;
  activeJobs: Record<string, ToolJobProgress>;
  isChecking?: boolean;
  onRefresh: () => void;
  onClose: () => void;
  anchorRect?: DOMRect | null;
}

export const AgentUpdatesPopover: React.FC<AgentUpdatesPopoverProps> = ({
  summary,
  activeJobs,
  isChecking = false,
  onRefresh,
  onClose,
  anchorRect,
}) => {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [updatingEngines, setUpdatingEngines] = useState<Record<string, boolean>>({});
  const [startErrors, setStartErrors] = useState<Record<string, string>>({});

  // Compute fixed position anchored directly under the badge
  const [position, setPosition] = useState<{ top: number; right: number }>({ top: 44, right: 16 });

  useEffect(() => {
    if (anchorRect) {
      const top = Math.round(anchorRect.bottom + 6);
      const right = Math.max(12, Math.round(window.innerWidth - anchorRect.right));
      setPosition({ top, right });
    }
  }, [anchorRect]);

  // Click outside and escape handler
  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (popoverRef.current && !popoverRef.current.contains(target)) {
        if (!target.closest('[data-agent-updates-badge]')) {
          onClose();
        }
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const outdatedList = Object.values(summary.advisories).filter((a) => a.state === 'outdated');

  const handleUpdate = async (engine: string) => {
    setStartErrors((prev) => {
      if (!(engine in prev)) return prev;
      const next = { ...prev };
      delete next[engine];
      return next;
    });
    setUpdatingEngines((prev) => ({ ...prev, [engine]: true }));
    try {
      const started = await triggerAgentToolJob(engine, 'update');
      if (started?.status === 'failed' && started.error) {
        setStartErrors((prev) => ({ ...prev, [engine]: started.error! }));
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err || 'No se pudo iniciar la actualización.');
      setStartErrors((prev) => ({ ...prev, [engine]: message }));
    } finally {
      setUpdatingEngines((prev) => ({ ...prev, [engine]: false }));
    }
  };

  const handleOpenSettings = (providerId?: string) => {
    onClose();
    openSettingsTab('quotas', providerId);
  };

  const popoverNode = (
    <motion.div
      ref={popoverRef}
      role="dialog"
      aria-label="Actualizaciones de agentes"
      className="tp-popover agent-updates-popover"
      initial={{ opacity: 0, scale: 0.97, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, y: -4 }}
      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
      style={{
        top: `${position.top}px`,
        right: `${position.right}px`,
      }}
    >
      {/* Header */}
      <div className="tp-popover__header">
        <div className="tp-popover__identity">
          <div className="tp-popover__emblem" aria-hidden="true">
            <ArrowUpIcon size={14} strokeWidth={2.1} />
          </div>
          <div className="tp-popover__title-group">
            <div className="tp-popover__title-row">
              <h3 className="tp-popover__title">Actualizaciones disponibles</h3>
              {outdatedList.length > 0 && (
                <span className="tp-pill tp-pill--accent">{outdatedList.length}</span>
              )}
            </div>
            <span className="tp-popover__subtitle">
              {outdatedList.length === 0
                ? 'Todos los motores instalados están al día'
                : outdatedList.length === 1
                  ? '1 agente con versión nueva'
                  : `${outdatedList.length} agentes con versión nueva`}
            </span>
          </div>
        </div>

        <div className="tp-popover__actions">
          <button
            type="button"
            className="tp-icon-btn"
            aria-label="Revisar actualizaciones"
            title="Revisar actualizaciones"
            onClick={onRefresh}
            disabled={isChecking}
          >
            <RefreshIcon size={13} className={isChecking ? 'tp-spin' : undefined} />
          </button>
          <button
            type="button"
            className="tp-icon-btn"
            aria-label="Cerrar"
            title="Cerrar"
            onClick={onClose}
          >
            <CloseIcon size={14} />
          </button>
        </div>
      </div>

      {/* Outdated list */}
      <div className="au-list scroll-quiet">
        {outdatedList.length === 0 ? (
          <div className="tp-empty">
            <span className="tp-empty__halo" aria-hidden="true">
              <CheckCircleIcon size={18} />
            </span>
            <strong className="tp-empty__title">
              Todos los agentes instalados están actualizados
            </strong>
            <p className="tp-empty__desc">
              Tus CLI locales coinciden con la última versión publicada.
            </p>
          </div>
        ) : (
          outdatedList.map((adv) => {
            const job = activeJobs[adv.engine];
            const startError = startErrors[adv.engine];
            const isRunning = Boolean(updatingEngines[adv.engine]) || job?.status === 'running';
            const isSucceeded = !isRunning && job?.status === 'succeeded';
            const isFailed = !isRunning && (job?.status === 'failed' || Boolean(startError));
            const failureMessage =
              startError ||
              (job?.status === 'failed'
                ? job.error || 'No se pudo completar la actualización.'
                : undefined);

            return (
              <div key={adv.engine} className="au-row">
                <div className="au-row__top">
                  {/* Brand & Versions */}
                  <div className="au-row__main">
                    <div className="au-row__pedestal">
                      <BrandLogo engine={adv.engine} size={20} />
                    </div>
                    <div className="au-row__meta">
                      <div className="au-row__name" title={adv.displayName}>
                        {adv.displayName}
                      </div>
                      <div className="au-version-track">
                        <span className="au-version-chip au-version-chip--from">
                          v{adv.currentVersion || '—'}
                        </span>
                        <ArrowRightIcon size={10} className="au-version-arrow" />
                        <span className="au-version-chip au-version-chip--to">
                          v{adv.latestVersion}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Action button / status */}
                  <div className="au-row__action">
                    {isRunning ? (
                      <div className="au-status-pill au-status-pill--running" role="status">
                        <RefreshIcon size={12} className="tp-spin" />
                        <span>Actualizando...</span>
                      </div>
                    ) : isSucceeded ? (
                      <div className="au-status-pill au-status-pill--done" role="status">
                        <CheckIcon size={12} />
                        <span>Al día</span>
                      </div>
                    ) : isFailed ? (
                      <button
                        type="button"
                        className="tp-btn tp-btn--sm tp-btn--danger"
                        onClick={() => handleUpdate(adv.engine)}
                      >
                        Reintentar
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="tp-btn tp-btn--sm tp-btn--primary"
                        onClick={() => handleUpdate(adv.engine)}
                      >
                        Actualizar
                      </button>
                    )}
                  </div>
                </div>

                {isFailed && failureMessage && (
                  <div className="au-row__error" role="alert">
                    {failureMessage}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer link to existing settings */}
      <div className="tp-footer">
        <button
          type="button"
          className="tp-footer-link"
          onClick={() => handleOpenSettings(outdatedList[0]?.engine)}
        >
          <span>Configuración de proveedores y agentes</span>
          <ChevronRightIcon size={12} />
        </button>

        <span className="tp-footer-meta">{summary.installedCount} instalados</span>
      </div>
    </motion.div>
  );

  return createPortal(
    <AnimatePresence>{popoverNode}</AnimatePresence>,
    document.body
  );
};
