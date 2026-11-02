import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { BrandLogo } from '../views/agents/engineMetadata';
import { openSettingsTab } from '../../lib/settingsNav';
import type { AgentUpdatesSummary, ToolJobProgress } from '../../types/agentUpdates';
import { triggerAgentToolJob } from '../../lib/agentUpdates';

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

  // Compute fixed position anchored directly under the badge
  const [position, setPosition] = useState<{ top: number; right: number }>({ top: 44, right: 16 });

  useEffect(() => {
    if (anchorRect) {
      const top = anchorRect.bottom + 6;
      const right = Math.max(12, window.innerWidth - anchorRect.right);
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
    setUpdatingEngines((prev) => ({ ...prev, [engine]: true }));
    try {
      await triggerAgentToolJob(engine, 'update');
    } finally {
      // Keep tracking via activeJobs
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
      className="agent-updates-popover"
      initial={{ opacity: 0, scale: 0.96, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, y: -4 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      style={{
        position: 'fixed',
        top: `${position.top}px`,
        right: `${position.right}px`,
        transformOrigin: 'top right',
        width: '360px',
        maxWidth: 'calc(100vw - 24px)',
        maxHeight: 'min(520px, calc(100vh - 80px))',
        backgroundColor: 'var(--surface-elevated, #1a1a1f)',
        color: 'var(--text-primary, #e2e8f0)',
        borderRadius: 'var(--card-radius, 12px)',
        border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
        boxShadow: 'var(--shadow-popover, 0 12px 36px rgba(0, 0, 0, 0.45))',
        zIndex: 9999,
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
          padding: '12px 14px',
          borderBottom: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.06))',
          backgroundColor: 'var(--surface-card, rgba(255, 255, 255, 0.02))',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div
            style={{
              width: '24px',
              height: '24px',
              borderRadius: 'var(--control-radius, 8px)',
              backgroundColor: 'color-mix(in srgb, var(--accent, #5c8fff) 18%, transparent)',
              color: 'var(--accent, #5c8fff)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
              Actualizaciones disponibles
            </h3>
            <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
              {outdatedList.length === 1 ? '1 agente con versión nueva' : `${outdatedList.length} agentes con versión nueva`}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <button
            type="button"
            aria-label="Revisar actualizaciones"
            title="Revisar actualizaciones"
            onClick={onRefresh}
            disabled={isChecking}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: isChecking ? 'default' : 'pointer',
              padding: '4px',
              borderRadius: 'var(--control-radius, 8px)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: isChecking ? 0.6 : 1,
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                animation: isChecking ? 'spin 1s linear infinite' : 'none',
              }}
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Cerrar"
            title="Cerrar"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              padding: '4px',
              borderRadius: 'var(--control-radius, 8px)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Outdated list */}
      <div
        style={{
          padding: '8px',
          overflowY: 'auto',
          maxHeight: '360px',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}
      >
        {outdatedList.length === 0 ? (
          <div
            style={{
              padding: '24px 16px',
              textAlign: 'center',
              color: 'var(--text-secondary)',
              fontSize: '12px',
            }}
          >
            <span style={{ display: 'block', fontSize: '18px', marginBottom: '6px' }}>✨</span>
            Todos los agentes instalados están actualizados
          </div>
        ) : (
          outdatedList.map((adv) => {
            const job = activeJobs[adv.engine];
            const isRunning = job?.status === 'running' || updatingEngines[adv.engine];
            const isSucceeded = job?.status === 'succeeded';
            const isFailed = job?.status === 'failed';

            return (
              <div
                key={adv.engine}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 10px',
                  borderRadius: 'var(--control-radius, 8px)',
                  backgroundColor: 'var(--surface-sunken, rgba(255, 255, 255, 0.03))',
                  border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.04))',
                  gap: '10px',
                }}
              >
                {/* Brand & Versions */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1 }}>
                  <div style={{ flexShrink: 0 }}>
                    <BrandLogo engine={adv.engine} size={22} />
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {adv.displayName}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <span>v{adv.currentVersion || '—'}</span>
                      <span style={{ color: 'var(--text-tertiary, rgba(255, 255, 255, 0.3))' }}>→</span>
                      <strong style={{ color: 'var(--accent, #5c8fff)', fontWeight: 600 }}>v{adv.latestVersion}</strong>
                    </div>
                  </div>
                </div>

                {/* Action button */}
                <div style={{ flexShrink: 0 }}>
                  {isRunning ? (
                    <div
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '4px 10px',
                        borderRadius: 'var(--control-radius, 8px)',
                        fontSize: '11px',
                        fontWeight: 600,
                        color: 'var(--accent, #5c8fff)',
                        backgroundColor: 'color-mix(in srgb, var(--accent, #5c8fff) 12%, transparent)',
                        height: '28px',
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite' }}>
                        <polyline points="23 4 23 10 17 10" />
                        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                      </svg>
                      <span>Actualizando...</span>
                    </div>
                  ) : isSucceeded ? (
                    <div
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        padding: '4px 10px',
                        borderRadius: 'var(--control-radius, 8px)',
                        fontSize: '11px',
                        fontWeight: 600,
                        color: 'var(--status-running, #10b981)',
                        backgroundColor: 'rgba(16, 185, 129, 0.1)',
                        height: '28px',
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      <span>Al día</span>
                    </div>
                  ) : isFailed ? (
                    <button
                      type="button"
                      onClick={() => handleUpdate(adv.engine)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        padding: '4px 10px',
                        borderRadius: 'var(--control-radius, 8px)',
                        fontSize: '11px',
                        fontWeight: 600,
                        color: 'var(--danger-text, #ef4444)',
                        backgroundColor: 'rgba(239, 68, 68, 0.1)',
                        border: '1px solid rgba(239, 68, 68, 0.2)',
                        cursor: 'pointer',
                        height: '28px',
                      }}
                    >
                      <span>Reintentar</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleUpdate(adv.engine)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        padding: '0 12px',
                        height: '28px',
                        borderRadius: 'var(--control-radius, 8px)',
                        fontSize: '11px',
                        fontWeight: 600,
                        color: '#fff',
                        backgroundColor: 'var(--accent, #5c8fff)',
                        border: 'none',
                        cursor: 'pointer',
                        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.2)',
                        transition: 'background-color 0.15s ease',
                      }}
                    >
                      Actualizar
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer link to existing settings */}
      <div
        style={{
          padding: '10px 14px',
          borderTop: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.06))',
          backgroundColor: 'var(--surface-card, rgba(255, 255, 255, 0.015))',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <button
          type="button"
          onClick={() => handleOpenSettings(outdatedList[0]?.engine)}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            color: 'var(--accent, #5c8fff)',
            fontSize: '11px',
            fontWeight: 500,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
          }}
        >
          <span>Configuración de proveedores y agentes</span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>

        <span style={{ fontSize: '10px', color: 'var(--text-tertiary, rgba(255, 255, 255, 0.35))' }}>
          {summary.installedCount} instalados
        </span>
      </div>
    </motion.div>
  );

  return createPortal(
    <AnimatePresence>{popoverNode}</AnimatePresence>,
    document.body
  );
};
