import React, { useState, useRef, useEffect, useReducer, useCallback } from 'react';
import { invokeCommand } from '../../../lib/ipc';
import { BrandLogo, getEngineDisplayName } from './engineMetadata';

export type AutoPilotMode = 'complete' | 'dream' | 'harden' | 'review' | 'task';
export type AutoPilotPhase = 'off' | 'watching' | 'thinking' | 'waiting' | 'done' | 'stuck';

export interface AgentAutoPilotProps {
  profile: {
    id: string;
    name: string;
    engine: string;
  };
  paneId: string;
  sessionId: string;
  phase: 'suspended' | 'loading' | 'running' | 'exited' | 'error';
  readOnly?: boolean;
  onSessionRestart?: (nextSessionId: string) => void;
}

interface State {
  mode: AutoPilotMode;
  task: string;
  phase: AutoPilotPhase;
  menuOpen: boolean;
  detail: string;
}

type Action =
  | { type: 'chooseMode'; mode: AutoPilotMode }
  | { type: 'editTask'; task: string }
  | { type: 'setMenu'; open: boolean }
  | { type: 'setPhase'; phase: AutoPilotPhase }
  | { type: 'transition'; phase: AutoPilotPhase; detail: string };

const initialState: State = {
  mode: 'complete',
  task: '',
  phase: 'off',
  menuOpen: false,
  detail: 'Auto is off.',
};

function autoPilotReducer(state: State, action: Action): State {
  switch (action.type) {
    case 'chooseMode':
      return { ...state, mode: action.mode };
    case 'editTask':
      return { ...state, task: action.task };
    case 'setMenu':
      return { ...state, menuOpen: action.open };
    case 'setPhase':
      return { ...state, phase: action.phase };
    case 'transition':
      return { ...state, phase: action.phase, detail: action.detail };
    default:
      return state;
  }
}

// Icons
const ZapIcon = ({ size = 12, fill = 'none', className = '' }: { size?: number; fill?: string; className?: string }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);

const SquareIcon = ({ size = 7, fill = 'currentColor' }: { size?: number; fill?: string }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill={fill}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
  </svg>
);

const CheckCircleIcon = ({ size = 10 }: { size?: number }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </svg>
);

const SparklesIcon = ({ size = 12 }: { size?: number }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
    <path d="M5 3v4" />
    <path d="M19 17v4" />
    <path d="M3 5h4" />
    <path d="M17 19h4" />
  </svg>
);

const ShieldIcon = ({ size = 12 }: { size?: number }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
    <path d="M12 22V2" />
  </svg>
);

const SearchIcon = ({ size = 12 }: { size?: number }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const TextCursorInputIcon = ({ size = 10 }: { size?: number }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 4h1a3 3 0 0 1 3 3 3 3 0 0 1 3-3h1" />
    <path d="M13 20h-1a3 3 0 0 1-3-3 3 3 0 0 1-3 3H5" />
    <path d="M9 4v16" />
    <line x1="17" y1="8" x2="21" y2="8" />
    <line x1="19" y1="6" x2="19" y2="10" />
  </svg>
);

const AlertTriangleIcon = ({ size = 11 }: { size?: number }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

const ChevronLeftIcon = ({ size = 10, strokeWidth = 2.5 }: { size?: number; strokeWidth?: number }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

interface AutoModeDef {
  id: AutoPilotMode;
  label: string;
  detail: string;
  chip: string;
  glyph: React.FC<{ size?: number; className?: string }>;
}

const MODES: AutoModeDef[] = [
  { id: 'complete', label: 'Complete', detail: 'Finish what this agent started.', chip: 'Complete', glyph: CheckCircleIcon },
  { id: 'dream', label: 'Dream', detail: 'Keep building — Auto picks what’s next.', chip: 'Dream', glyph: SparklesIcon },
  { id: 'harden', label: 'Harden', detail: 'Run the project’s checks, fix failures.', chip: 'Harden', glyph: ShieldIcon },
  { id: 'review', label: 'Review', detail: 'Read the diff and fix the defects.', chip: 'Review', glyph: SearchIcon },
  { id: 'task', label: 'Custom task', detail: 'Type the goal; Auto drives to it.', chip: 'Auto', glyph: TextCursorInputIcon },
];

export const AgentAutoPilot: React.FC<AgentAutoPilotProps> = ({
  profile,
  paneId,
  sessionId,
  phase: terminalPhase,
  readOnly = false,
}) => {
  const [state, dispatch] = useReducer(autoPilotReducer, initialState);
  const { mode, task, phase, menuOpen, detail } = state;
  const [customTaskOpen, setCustomTaskOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const turnsCompletedRef = useRef(0);
  const previousPromptsRef = useRef<string[]>([]);
  const activeLoopRef = useRef(0);

  const engineName = getEngineDisplayName(profile.engine);
  const isEngaged = phase === 'watching' || phase === 'thinking' || phase === 'waiting';
  const isTerminalDoneOrStuck = phase === 'done' || phase === 'stuck';
  const currentModeDef = MODES.find((m) => m.id === mode) ?? MODES[0];
  const Glyph = currentModeDef.glyph;

  // Auto focus textarea when custom task opens
  useEffect(() => {
    if (customTaskOpen) {
      textareaRef.current?.focus({ preventScroll: true });
    }
  }, [customTaskOpen]);

  // Click outside to close popover
  useEffect(() => {
    if (!menuOpen) return;
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current && !popoverRef.current.contains(target) && triggerRef.current && !triggerRef.current.contains(target)) {
        dispatch({ type: 'setMenu', open: false });
        setCustomTaskOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dispatch({ type: 'setMenu', open: false });
        setCustomTaskOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  // Stop handler
  const handleStop = useCallback((reason = 'Auto stopped. The Agent terminal is still available.') => {
    activeLoopRef.current += 1;
    void invokeCommand('cancel_autopilot', {}).catch(() => {});
    dispatch({ type: 'transition', phase: 'off', detail: reason });
  }, []);

  // Drive Auto turn loop
  const driveTurn = useCallback(async (selectedMode: AutoPilotMode, taskText: string) => {
    const loopId = (activeLoopRef.current += 1);
    dispatch({ type: 'transition', phase: 'thinking', detail: 'Auto is deciding next turn…' });

    try {
      const decision = await invokeCommand<{
        action?: string;
        prompt?: string;
        reason?: string;
        objective?: string;
        turnsRemaining?: number;
      }>('autopilot_next', {
        request: {
          supportedSchemaVersion: 1,
          agentId: profile.id,
          paneId,
          sessionId,
          runId: globalThis.crypto.randomUUID(),
          generation: 1,
          turn: {
            supportedSchemaVersion: 1,
            task: selectedMode === 'task' ? taskText : '',
            mode: selectedMode,
            engine: profile.engine,
            transcript: '',
            turnsCompleted: turnsCompletedRef.current,
            previousPrompts: previousPromptsRef.current,
            objective: null,
            objectivesCompleted: 0,
            completedObjectives: [],
          },
        },
      });

      if (activeLoopRef.current !== loopId) return;

      if (!decision || decision.action === 'stuck') {
        dispatch({
          type: 'transition',
          phase: 'stuck',
          detail: decision?.reason || 'Auto stopped because this agent needs attention.',
        });
        return;
      }

      if (decision.action === 'complete') {
        dispatch({
          type: 'transition',
          phase: 'done',
          detail: decision.reason || 'Auto verified that all objectives are complete.',
        });
        return;
      }

      if (decision.action === 'prompt' && decision.prompt) {
        turnsCompletedRef.current += 1;
        previousPromptsRef.current.push(decision.prompt);
        dispatch({
          type: 'transition',
          phase: 'watching',
          detail: decision.reason || `Auto turn ${turnsCompletedRef.current} submitted.`,
        });

        // Write prompt to terminal session
        try {
          await invokeCommand('write_terminal', {
            sessionId,
            data: decision.prompt + '\r',
          });
        } catch (err) {
          console.warn('[AutoPilot] failed to write terminal input:', err);
        }
      }
    } catch (err: any) {
      if (activeLoopRef.current !== loopId) return;
      dispatch({
        type: 'transition',
        phase: 'stuck',
        detail: err?.message || 'Auto encountered an unexpected error.',
      });
    }
  }, [profile.id, profile.engine, paneId, sessionId]);

  const handleEngageMode = (m: AutoPilotMode) => {
    dispatch({ type: 'chooseMode', mode: m });
    dispatch({ type: 'setMenu', open: false });
    setCustomTaskOpen(false);
    void driveTurn(m, task);
  };

  const handleCustomTaskSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!task.trim()) return;
    dispatch({ type: 'chooseMode', mode: 'task' });
    dispatch({ type: 'setMenu', open: false });
    setCustomTaskOpen(false);
    void driveTurn('task', task);
  };


  // Render trigger / capsule button
  let triggerElement: React.ReactNode;
  if (isEngaged) {
    triggerElement = (
      <button
        type="button"
        className="agent-auto__capsule"
        data-state={phase}
        disabled={readOnly}
        onClick={() => handleStop()}
        ref={triggerRef}
        title={detail}
        aria-label={`Stop Auto — ${currentModeDef.chip}`}
      >
        <Glyph size={10} className="agent-auto__capsule-glyph" />
        <span>{currentModeDef.chip}</span>
        <SquareIcon size={7} fill="currentColor" />
      </button>
    );
  } else if (isTerminalDoneOrStuck) {
    triggerElement = (
      <button
        type="button"
        className="agent-auto__capsule"
        data-state={phase}
        disabled={readOnly}
        onClick={() => dispatch({ type: 'setMenu', open: !menuOpen })}
        ref={triggerRef}
        title={detail}
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
      >
        {phase === 'done' ? <CheckCircleIcon size={10} /> : <AlertTriangleIcon size={10} />}
        <span>{phase === 'done' ? 'Done' : 'Stuck'}</span>
      </button>
    );
  } else {
    triggerElement = (
      <button
        type="button"
        className="agent-auto__trigger"
        disabled={readOnly || terminalPhase === 'loading' || terminalPhase === 'suspended'}
        onClick={() => dispatch({ type: 'setMenu', open: !menuOpen })}
        ref={triggerRef}
        title="Let Auto drive this agent"
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
      >
        <ZapIcon size={12} />
        Auto
      </button>
    );
  }

  return (
    <div className="agent-auto" data-state={phase}>
      {triggerElement}

      {menuOpen ? (
        <div className="agent-auto__popover" ref={popoverRef} role="dialog" aria-label="Auto">
          <div id="agent-auto-menu">
            <header className="agent-auto__header">
              <ZapIcon size={11} fill="currentColor" className="agent-auto__bolt" />
              <strong>Auto</strong>
              <span className="agent-auto__engine">
                <BrandLogo engine={profile.engine} size={14} />
                {engineName}
              </span>
            </header>

            {isTerminalDoneOrStuck ? (
              <div className="agent-auto__verdict">
                <p className="agent-auto__mode-line">
                  <Glyph size={10} />
                  {currentModeDef.label}
                </p>
                <p className="agent-auto__reason" data-state={phase}>
                  {phase === 'done' ? <CheckCircleIcon size={11} /> : <AlertTriangleIcon size={11} />}
                  <span>{detail}</span>
                </p>
                <footer className="agent-auto__footer">
                  <span />
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => {
                      dispatch({ type: 'transition', phase: 'off', detail: 'Auto is off.' });
                      setCustomTaskOpen(false);
                    }}
                  >
                    {phase === 'done' ? 'Run Auto again' : 'Back to Auto'}
                  </button>
                </footer>
              </div>
            ) : customTaskOpen ? (
              <form className="agent-auto__form" onSubmit={handleCustomTaskSubmit}>
                <div className="agent-auto__form-nav">
                  <button
                    type="button"
                    className="agent-auto__back"
                    onClick={() => setCustomTaskOpen(false)}
                    aria-label="Back to Auto modes"
                  >
                    <ChevronLeftIcon size={10} strokeWidth={2.5} />
                    Modes
                  </button>
                  <span className="agent-auto__mode-chip">
                    <TextCursorInputIcon size={10} />
                    Custom task
                  </span>
                </div>
                <textarea
                  className="agent-auto__task"
                  rows={2}
                  maxLength={4000}
                  placeholder="Describe what finished looks like…"
                  ref={textareaRef}
                  value={task}
                  onChange={(e) => dispatch({ type: 'editTask', task: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing && task.trim()) {
                      e.preventDefault();
                      handleCustomTaskSubmit(e);
                    }
                  }}
                  aria-label="Task for Auto"
                />
                <p className="agent-auto__note">
                  Auto prompts {engineName} turn by turn — verifying, unblocking, and answering questions — until this is done.
                </p>
                <footer className="agent-auto__footer">
                  <span className="agent-auto__credits">2 credits</span>
                  <button type="submit" className="primary-button" disabled={!task.trim()}>
                    Engage Auto
                  </button>
                </footer>
              </form>
            ) : (
              <div className="agent-auto__menu">
                <p className="agent-auto__lede">Pick how Auto should drive {engineName}.</p>
                <div className="agent-auto__modes" role="menu" aria-label="Auto modes">
                  {MODES.map((item) => {
                    const ItemGlyph = item.glyph;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className="agent-auto__mode"
                        role="menuitem"
                        aria-label={`Auto mode: ${item.label}`}
                        onClick={() => {
                          if (item.id === 'task') {
                            setCustomTaskOpen(true);
                          } else {
                            handleEngageMode(item.id);
                          }
                        }}
                      >
                        <ItemGlyph size={12} />
                        <span>
                          <strong>{item.label}</strong>
                          <small>{item.detail}</small>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="agent-auto__note">
                  2 credits per check-in. Auto stops on its own if the agent gets stuck.
                </p>
              </div>
            )}
          </div>
        </div>
      ) : null}

      <span className="sr-only" aria-live="polite">{detail}</span>
    </div>
  );
};

export default AgentAutoPilot;
