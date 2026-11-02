import React, { useState, useRef } from 'react';
import { useAgentUpdates } from '../../lib/agentUpdates';
import { AgentUpdatesPopover } from './AgentUpdatesPopover';

export interface AgentUpdatesBadgeProps {
  className?: string;
}

export const AgentUpdatesBadge: React.FC<AgentUpdatesBadgeProps> = ({ className = '' }) => {
  const { summary, activeJobs, isChecking, refresh } = useAgentUpdates();
  const [isOpen, setIsOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const outdatedCount = summary?.outdatedCount ?? 0;

  // Discrete policy: Hide if 0 agents are outdated
  if (outdatedCount === 0) {
    return null;
  }

  const handleToggle = () => {
    if (!isOpen && buttonRef.current) {
      setAnchorRect(buttonRef.current.getBoundingClientRect());
      setIsOpen(true);
    } else {
      setIsOpen(false);
    }
  };

  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }} className={className}>
      <button
        ref={buttonRef}
        type="button"
        data-agent-updates-badge=""
        aria-label={`${outdatedCount} actualizaciones de agentes disponibles`}
        title={`${outdatedCount} actualizaciones de agentes disponibles`}
        aria-expanded={isOpen}
        onClick={handleToggle}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '5px',
          height: 'var(--control-row, 28px)',
          minHeight: 'var(--control-row, 28px)',
          padding: '0 8px',
          borderRadius: 'var(--control-radius, 8px)',
          backgroundColor: 'color-mix(in srgb, var(--accent, #5c8fff) 12%, transparent)',
          border: '1px solid color-mix(in srgb, var(--accent, #5c8fff) 30%, transparent)',
          color: 'var(--text-primary, #e2e8f0)',
          fontSize: '11px',
          fontWeight: 600,
          cursor: 'pointer',
          transition: 'all 0.15s ease',
          outline: 'none',
        }}
      >
        {/* Animated up-arrow glyph */}
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--accent, #5c8fff)',
          }}
          aria-hidden="true"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5" />
            <polyline points="5 12 12 5 19 12" />
          </svg>
        </span>

        {/* Count chip */}
        <span
          style={{
            fontSize: '11px',
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--text-primary)',
            letterSpacing: '0.01em',
          }}
        >
          {outdatedCount}
        </span>
      </button>

      {isOpen && summary && (
        <AgentUpdatesPopover
          summary={summary}
          activeJobs={activeJobs}
          isChecking={isChecking}
          onRefresh={() => refresh(true)}
          onClose={() => setIsOpen(false)}
          anchorRect={anchorRect}
        />
      )}
    </div>
  );
};
