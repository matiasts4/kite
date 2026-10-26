import React, { useState, useRef, useEffect, useCallback, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { BotIcon, PencilRulerIcon, CheckIcon } from '../ChatIcons';
import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from './ComposerControl';
import { getAnchoredPopoverCoords, PopoverCoords } from './anchoredPosition';
import type { DriverChoice } from '../../../../lib/session/types';
import type { ChatMode } from '../types';

export interface WorkModePickerPopoverProps {
  workModes?: DriverChoice[];
  currentAgent?: string | null;
  currentPlan?: boolean;
  currentMode: ChatMode;
  disabled?: boolean;
  onSelectWorkMode: (patch: {
    agent?: string | null;
    plan?: boolean;
    mode?: ChatMode;
  }) => void;
}

const PANEL_WIDTH = 270;
const PANEL_HEIGHT = 160;

export const WorkModePickerPopover: React.FC<WorkModePickerPopoverProps> = ({
  workModes,
  currentAgent,
  currentPlan,
  currentMode,
  disabled = false,
  onSelectWorkMode,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [coords, setCoords] = useState<PopoverCoords | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const effectiveChoices = useMemo<DriverChoice[]>(() => {
    if (workModes && workModes.length > 0) return workModes;
    return [
      { id: 'build', label: 'Build', detail: 'Works with the permission mode below', plan: false } as DriverChoice,
      { id: 'plan', label: 'Plan', detail: 'Reads and plans, changes nothing', plan: true } as DriverChoice,
    ];
  }, [workModes]);

  const activeChoice = useMemo<DriverChoice>(() => {
    if (currentAgent) {
      const match = effectiveChoices.find((c) => c.id === currentAgent);
      if (match) return match;
    }
    if (currentPlan || currentMode === 'readOnly') {
      const planMatch = effectiveChoices.find((c) => (c as any).plan || c.id === 'plan');
      if (planMatch) return planMatch;
    }
    const buildMatch = effectiveChoices.find((c) => !(c as any).plan && c.id === 'build');
    return buildMatch || effectiveChoices[0];
  }, [effectiveChoices, currentAgent, currentPlan, currentMode]);

  const isPlanMode = Boolean((activeChoice as any).plan || activeChoice.id === 'plan');

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const measuredHeight = panelRef.current?.offsetHeight || PANEL_HEIGHT;
    setCoords(getAnchoredPopoverCoords(triggerRef.current, PANEL_WIDTH, measuredHeight, 8, 'top', 'center'));
  }, []);

  useLayoutEffect(() => {
    if (isOpen) {
      updatePosition();
    }
  }, [isOpen, updatePosition]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current &&
        !triggerRef.current.contains(target) &&
        panelRef.current &&
        !panelRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updatePosition);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updatePosition);
    };
  }, [isOpen, updatePosition]);

  return (
    <>
      <ComposerControl
        ref={triggerRef}
        role="combobox"
        aria-label="Work mode and agent"
        aria-expanded={isOpen}
        title={`Work mode: ${activeChoice.label}${activeChoice.detail ? ` (${activeChoice.detail})` : ''}`}
        disabled={disabled}
        data-state={isOpen ? 'open' : 'closed'}
        active={isPlanMode}
        onClick={() => {
          if (!disabled) setIsOpen((prev) => !prev);
        }}
      >
        <ComposerControlIcon
          icon={isPlanMode ? PencilRulerIcon : BotIcon}
          size={14}
          className={isPlanMode ? 'text-primary' : 'text-muted-foreground'}
        />
        <span className="kite-composer-control-label font-medium">{activeChoice.label}</span>
        <ComposerControlChevron />
      </ComposerControl>

      {isOpen &&
        coords &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Select Work Mode or Agent"
            className="kite-floating-card kite-context-menu"
            style={{
              left: `${coords.left}px`,
              top: `${coords.top}px`,
              width: `${PANEL_WIDTH}px`,
            }}
          >
            <div
              style={{
                padding: '0.375rem 0.625rem 0.25rem',
                fontSize: '0.625rem',
                fontWeight: 600,
                color: 'var(--muted-foreground, #71717a)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Work Modes & Agents
            </div>

            <div className="kite-context-menu-list">
              {effectiveChoices.map((choice) => {
                const isSelected = choice.id === activeChoice.id;
                const choiceIsPlan = Boolean((choice as any).plan || choice.id === 'plan');
                return (
                  <button
                    key={choice.id}
                    type="button"
                    className={`kite-context-menu-item ${
                      isSelected ? 'kite-context-menu-item--selected' : ''
                    }`}
                    onClick={() => {
                      if (choiceIsPlan) {
                        onSelectWorkMode({
                          agent: choice.id === 'plan' ? null : choice.id,
                          plan: true,
                          mode: 'readOnly',
                        });
                      } else {
                        onSelectWorkMode({
                          agent: choice.id === 'build' ? null : choice.id,
                          plan: false,
                          mode: currentMode === 'readOnly' ? 'acceptEdits' : currentMode,
                        });
                      }
                      setIsOpen(false);
                    }}
                  >
                    {choiceIsPlan ? (
                      <PencilRulerIcon size={14} className="shrink-0 text-primary" />
                    ) : (
                      <BotIcon size={14} className="shrink-0 text-icon-muted" />
                    )}
                    <div
                      className="kite-context-menu-item-text"
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '2px',
                        textAlign: 'left',
                        minWidth: 0,
                      }}
                    >
                      <span
                        style={{
                          fontWeight: 500,
                          color: 'var(--text-primary, #ffffff)',
                          lineHeight: '1.2',
                        }}
                      >
                        {choice.label}
                      </span>
                      {choice.detail && (
                        <span
                          style={{
                            fontSize: '0.6875rem',
                            color: 'var(--muted-foreground, #71717a)',
                            lineHeight: '1.25',
                            whiteSpace: 'normal',
                          }}
                        >
                          {choice.detail}
                        </span>
                      )}
                    </div>
                    {isSelected && (
                      <CheckIcon size={13} className="shrink-0 text-primary" style={{ marginLeft: 'auto' }} />
                    )}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body
        )}
    </>
  );
};
