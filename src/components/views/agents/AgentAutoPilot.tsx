import React, { useState, useRef, useEffect, useReducer, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invokeCommand, isTauriEnvironment } from '../../../lib/ipc';
import { BrandLogo, getEngineDisplayName } from './engineMetadata';

const SETTLE_IDLE_MS = 1500;
const WAIT_RECHECK_MS = 2500;
const MAX_WATCH_MS = 30000;
const MAX_TRANSCRIPT_CHARS = 16000;

export type AutoPilotMode = 'complete' | 'dream' | 'harden' | 'review' | 'task';
export type AutoPilotPhase = 'off' | 'watching' | 'thinking' | 'waiting' | 'done' | 'stuck';

export interface AutoPilotThreadItem {
  kind?: string;
  text?: string | null;
  title?: string | null;
}

export interface AutoPilotVerificationResult {
  command: string;
  passed: boolean;
  output?: string;
}

export interface AgentAutoPilotProps {
  profile: {
    id: string;
    name: string;
    engine: string;
  };
  surface?: 'terminal' | 'thread';
  paneId?: string;
  sessionId?: string;
  phase?: 'suspended' | 'loading' | 'running' | 'exited' | 'error';
  threadId?: string | null;
  workspaceId?: string | null;
  threadRunning?: boolean;
  threadItems?: AutoPilotThreadItem[];
  onSubmitThreadPrompt?: (prompt: string) => void | Promise<void>;
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

const DEFAULT_GATE_PRESETS = [
  { id: 'tsc', label: 'TypeScript (tsc)', command: 'npx tsc --noEmit' },
  { id: 'vitest', label: 'Frontend (vitest)', command: 'npx vitest run' },
  { id: 'cargo', label: 'Backend (cargo test)', command: 'cargo test --manifest-path src-tauri/Cargo.toml' },
];

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

export function formatThreadTranscript(items?: AutoPilotThreadItem[]): string {
  if (!Array.isArray(items) || items.length === 0) return '';
  const lines = items
    .slice(-40)
    .map((item) => {
      const role = item.kind || 'message';
      const title = item.title ? `${item.title}: ` : '';
      const text = (item.text || '').trim();
      return text ? `${role}: ${title}${text}` : '';
    })
    .filter(Boolean);
  return lines.join('\n').slice(-MAX_TRANSCRIPT_CHARS);
}

export const AgentAutoPilot: React.FC<AgentAutoPilotProps> = ({
  profile,
  surface = 'terminal',
  paneId = '',
  sessionId = '',
  phase: terminalPhase = 'running',
  threadId = null,
  workspaceId = null,
  threadRunning = false,
  threadItems = [],
  onSubmitThreadPrompt,
  readOnly = false,
}) => {
  const [state, dispatch] = useReducer(autoPilotReducer, initialState);
  const { mode, task, phase, menuOpen, detail } = state;
  const [customTaskOpen, setCustomTaskOpen] = useState(false);
  const [maxTurns, setMaxTurns] = useState<number>(12);
  const [maxWallClockMins, setMaxWallClockMins] = useState<number>(20);
  const [selectedGates, setSelectedGates] = useState<string[]>([]);
  const [customGate, setCustomGate] = useState<string>('');
  const [announceViaArgos, setAnnounceViaArgos] = useState<boolean>(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const turnsCompletedRef = useRef(0);
  const startedAtUnixMsRef = useRef<number | null>(null);
  const previousPromptsRef = useRef<string[]>([]);
  const activeLoopRef = useRef(0);
  const mountedRef = useRef(true);
  const transcriptBufferRef = useRef('');
  const threadItemsRef = useRef<AutoPilotThreadItem[]>(threadItems);
  threadItemsRef.current = threadItems;
  const sawThreadRunningRef = useRef(false);
  const activeWatchRef = useRef<{ loopId: number; mode: AutoPilotMode; taskText: string } | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxWatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const objectiveRef = useRef<string | null>(null);
  const objectivesCompletedRef = useRef(0);
  const completedObjectivesRef = useRef<string[]>([]);
  const driveTurnRef = useRef<
    ((m: AutoPilotMode, t: string, tr?: string, gateResults?: AutoPilotVerificationResult[]) => Promise<void>) | null
  >(null);

  const clearAutoTimers = useCallback(() => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    if (waitTimerRef.current !== null) {
      clearTimeout(waitTimerRef.current);
      waitTimerRef.current = null;
    }
    if (maxWatchTimerRef.current !== null) {
      clearTimeout(maxWatchTimerRef.current);
      maxWatchTimerRef.current = null;
    }
  }, []);

  const captureTranscript = useCallback(async (): Promise<string> => {
    if (surface === 'thread') {
      return formatThreadTranscript(threadItemsRef.current);
    }
    const live = transcriptBufferRef.current.trim();
    if (live.length > 0) {
      return transcriptBufferRef.current.slice(-MAX_TRANSCRIPT_CHARS);
    }
    if (!sessionId) return '';
    try {
      const res = await invokeCommand<{ transcript?: string }>('read_terminal_transcript', {
        sessionId,
      });
      const text = typeof res?.transcript === 'string' ? res.transcript : '';
      return text.slice(-MAX_TRANSCRIPT_CHARS);
    } catch {
      return '';
    }
  }, [surface, sessionId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeLoopRef.current += 1;
      activeWatchRef.current = null;
      clearAutoTimers();
    };
  }, [clearAutoTimers]);

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

  const emitArgosAnnouncement = useCallback(
    (status: 'done' | 'stuck', summary: string) => {
      if (!announceViaArgos || typeof window === 'undefined') return;
      window.dispatchEvent(
        new CustomEvent('kite:agent-announce', {
          detail: {
            source: 'autopilot',
            surface,
            agentId: profile.id,
            agentName: profile.name,
            threadId,
            status,
            message: `${profile.name} AutoPilot ${status === 'done' ? 'completed' : 'needs attention'}: ${summary}`,
          },
        })
      );
    },
    [announceViaArgos, surface, profile.id, profile.name, threadId]
  );

  // Stop handler
  const handleStop = useCallback(
    (reason = `Auto stopped. The Agent ${surface === 'thread' ? 'thread' : 'terminal'} is still available.`) => {
      activeLoopRef.current += 1;
      activeWatchRef.current = null;
      sawThreadRunningRef.current = false;
      clearAutoTimers();
      void invokeCommand('cancel_autopilot', { request: { agentId: profile.id } }).catch(() => {});
      dispatch({ type: 'transition', phase: 'off', detail: reason });
    },
    [clearAutoTimers, profile.id, surface]
  );

  // Drive Auto turn loop
  const driveTurn = useCallback(
    async (
      selectedMode: AutoPilotMode,
      taskText: string,
      capturedTranscript = '',
      verificationResults: AutoPilotVerificationResult[] = []
    ) => {
      const loopId = (activeLoopRef.current += 1);
      activeWatchRef.current = null;
      sawThreadRunningRef.current = false;
      clearAutoTimers();
      if (startedAtUnixMsRef.current === null) {
        startedAtUnixMsRef.current = Date.now();
      }
      dispatch({ type: 'transition', phase: 'thinking', detail: 'Auto is deciding next turn…' });

      const effectiveGates = [
        ...selectedGates,
        ...(customGate.trim() ? [customGate.trim()] : []),
      ];

      try {
        const decision = await invokeCommand<{
          action?: string;
          prompt?: string;
          reason?: string;
          objective?: string;
          gates?: string[];
          turnsRemaining?: number;
        }>('autopilot_next', {
          request: {
            supportedSchemaVersion: 2,
            surface,
            agentId: profile.id,
            agentName: profile.name,
            paneId: paneId || undefined,
            sessionId: sessionId || undefined,
            threadId: threadId || undefined,
            workspaceId: workspaceId || undefined,
            runId: globalThis.crypto.randomUUID(),
            generation: 1,
            maxTurns,
            maxWallClockMins,
            startedAtUnixMs: startedAtUnixMsRef.current,
            verificationGates: effectiveGates,
            verificationResults,
            announceViaArgos,
            turn: {
              supportedSchemaVersion: 1,
              task: selectedMode === 'task' ? taskText : '',
              mode: selectedMode,
              engine: profile.engine,
              transcript: (capturedTranscript || (surface === 'thread' ? formatThreadTranscript(threadItemsRef.current) : '')).slice(
                -MAX_TRANSCRIPT_CHARS
              ),
              turnsCompleted: turnsCompletedRef.current,
              previousPrompts: previousPromptsRef.current.slice(-5),
              objective: objectiveRef.current,
              objectivesCompleted: objectivesCompletedRef.current,
              completedObjectives: completedObjectivesRef.current.slice(-12),
            },
          },
        });

        if (!mountedRef.current || activeLoopRef.current !== loopId) return;

        if (decision?.action === 'verify') {
          const gatesToRun = Array.isArray(decision.gates) && decision.gates.length > 0 ? decision.gates : effectiveGates;
          dispatch({
            type: 'transition',
            phase: 'thinking',
            detail: `Running ${gatesToRun.length} verification gate(s)…`,
          });
          let results: AutoPilotVerificationResult[] = [];
          try {
            const gateRes = await invokeCommand<{ results?: AutoPilotVerificationResult[] }>(
              'run_autopilot_verification_gates',
              {
                request: {
                  workspaceId,
                  gates: gatesToRun,
                },
              }
            );
            results = Array.isArray(gateRes?.results) ? gateRes.results : [];
          } catch (gateErr: any) {
            results = gatesToRun.map((command) => ({
              command,
              passed: false,
              output: gateErr?.message || 'Verification gate command failed to launch.',
            }));
          }
          if (!mountedRef.current || activeLoopRef.current !== loopId) return;
          const nextTranscript = await captureTranscript();
          if (!mountedRef.current || activeLoopRef.current !== loopId) return;
          void driveTurnRef.current?.(selectedMode, taskText, nextTranscript, results);
          return;
        }

        if (!decision || decision.action === 'stuck') {
          const reason = decision?.reason || 'Auto stopped because this agent needs attention.';
          emitArgosAnnouncement('stuck', reason);
          dispatch({
            type: 'transition',
            phase: 'stuck',
            detail: reason,
          });
          return;
        }

        if (decision.action === 'complete') {
          const reason = decision.reason || 'Auto verified that all objectives are complete.';
          emitArgosAnnouncement('done', reason);
          dispatch({
            type: 'transition',
            phase: 'done',
            detail: reason,
          });
          return;
        }

        if (decision.action === 'wait') {
          dispatch({
            type: 'transition',
            phase: 'waiting',
            detail: decision.reason || 'The Agent is still working. Auto will check again.',
          });
          waitTimerRef.current = setTimeout(() => {
            waitTimerRef.current = null;
            if (!mountedRef.current || activeLoopRef.current !== loopId) return;
            void captureTranscript().then((nextTranscript) => {
              if (!mountedRef.current || activeLoopRef.current !== loopId) return;
              void driveTurnRef.current?.(selectedMode, taskText, nextTranscript);
            });
          }, WAIT_RECHECK_MS);
          return;
        }

        if (decision.action === 'advance') {
          if (objectiveRef.current && !completedObjectivesRef.current.includes(objectiveRef.current)) {
            completedObjectivesRef.current = [...completedObjectivesRef.current, objectiveRef.current].slice(-12);
            objectivesCompletedRef.current += 1;
          }
          if (decision.objective) {
            objectiveRef.current = decision.objective;
          }
        } else if (decision.objective) {
          objectiveRef.current = decision.objective;
        }

        if ((decision.action === 'prompt' || decision.action === 'advance') && decision.prompt) {
          transcriptBufferRef.current = '';
          turnsCompletedRef.current += 1;
          previousPromptsRef.current = [...previousPromptsRef.current, decision.prompt].slice(-5);
          activeWatchRef.current = { loopId, mode: selectedMode, taskText };
          dispatch({
            type: 'transition',
            phase: 'watching',
            detail: decision.reason || `Auto turn ${turnsCompletedRef.current} submitted.`,
          });

          if (surface === 'thread') {
            try {
              if (onSubmitThreadPrompt) {
                await onSubmitThreadPrompt(decision.prompt);
              } else if (threadId) {
                await invokeCommand('start_agent_chat_turn', {
                  threadId,
                  agentId: profile.id,
                  prompt: decision.prompt,
                  attachments: [],
                });
              }
            } catch (err) {
              console.warn('[AutoPilot] failed to submit thread turn:', err);
            }
          } else {
            try {
              await invokeCommand('write_terminal', {
                sessionId,
                data: decision.prompt + '\r',
              });
            } catch (err) {
              console.warn('[AutoPilot] failed to write terminal input:', err);
            }
          }

          if (!mountedRef.current || activeLoopRef.current !== loopId) return;
          maxWatchTimerRef.current = setTimeout(() => {
            maxWatchTimerRef.current = null;
            if (!mountedRef.current || activeLoopRef.current !== loopId) return;
            activeWatchRef.current = null;
            clearAutoTimers();
            void captureTranscript().then((nextTranscript) => {
              if (!mountedRef.current || activeLoopRef.current !== loopId) return;
              void driveTurnRef.current?.(selectedMode, taskText, nextTranscript);
            });
          }, MAX_WATCH_MS);
        } else if (decision.action === 'advance') {
          waitTimerRef.current = setTimeout(() => {
            waitTimerRef.current = null;
            if (!mountedRef.current || activeLoopRef.current !== loopId) return;
            void captureTranscript().then((nextTranscript) => {
              if (!mountedRef.current || activeLoopRef.current !== loopId) return;
              void driveTurnRef.current?.(selectedMode, taskText, nextTranscript);
            });
          }, 250);
        }
      } catch (err: any) {
        if (!mountedRef.current || activeLoopRef.current !== loopId) return;
        const msg = err?.message || 'Auto encountered an unexpected error.';
        emitArgosAnnouncement('stuck', msg);
        dispatch({
          type: 'transition',
          phase: 'stuck',
          detail: msg,
        });
      }
    },
    [
      surface,
      profile.id,
      profile.name,
      profile.engine,
      paneId,
      sessionId,
      threadId,
      workspaceId,
      maxTurns,
      maxWallClockMins,
      selectedGates,
      customGate,
      announceViaArgos,
      clearAutoTimers,
      captureTranscript,
      onSubmitThreadPrompt,
      emitArgosAnnouncement,
    ]
  );

  useEffect(() => {
    driveTurnRef.current = driveTurn;
  }, [driveTurn]);

  // Thread surface: detect turn running -> settled transition
  useEffect(() => {
    if (surface !== 'thread') return;
    const watching = activeWatchRef.current;
    if (!watching || activeLoopRef.current !== watching.loopId) return;

    if (threadRunning) {
      sawThreadRunningRef.current = true;
      if (settleTimerRef.current !== null) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      return;
    }

    if (sawThreadRunningRef.current && settleTimerRef.current === null) {
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        if (!mountedRef.current) return;
        const currentWatch = activeWatchRef.current;
        if (!currentWatch || activeLoopRef.current !== currentWatch.loopId) return;
        activeWatchRef.current = null;
        sawThreadRunningRef.current = false;
        clearAutoTimers();
        void captureTranscript().then((nextTranscript) => {
          if (!mountedRef.current || activeLoopRef.current !== currentWatch.loopId) return;
          void driveTurnRef.current?.(currentWatch.mode, currentWatch.taskText, nextTranscript);
        });
      }, SETTLE_IDLE_MS);
    }
  }, [surface, threadRunning, threadItems.length, clearAutoTimers, captureTranscript]);

  // Terminal surface: listen for terminal output/activity to capture transcript and detect turn settle
  useEffect(() => {
    if (surface !== 'terminal' || !isTauriEnvironment() || !sessionId) return;
    let active = true;
    const unlisteners: Array<() => void> = [];

    const scheduleSettleCheck = () => {
      const watching = activeWatchRef.current;
      if (!watching || activeLoopRef.current !== watching.loopId) return;
      if (settleTimerRef.current !== null) {
        clearTimeout(settleTimerRef.current);
      }
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        if (!active || !mountedRef.current) return;
        const currentWatch = activeWatchRef.current;
        if (!currentWatch || activeLoopRef.current !== currentWatch.loopId) return;
        activeWatchRef.current = null;
        clearAutoTimers();
        void captureTranscript().then((nextTranscript) => {
          if (!active || !mountedRef.current || activeLoopRef.current !== currentWatch.loopId) return;
          void driveTurnRef.current?.(currentWatch.mode, currentWatch.taskText, nextTranscript);
        });
      }, SETTLE_IDLE_MS);
    };

    void listen<{ sessionId?: string; paneId?: string; data?: string; text?: string; chunk?: string }>(
      'terminal-output',
      (event) => {
        if (!active) return;
        const p = event.payload;
        if (p?.sessionId !== sessionId && p?.paneId !== paneId) return;
        const chunk = p?.data ?? p?.text ?? p?.chunk ?? '';
        if (chunk) {
          transcriptBufferRef.current = (transcriptBufferRef.current + chunk).slice(-MAX_TRANSCRIPT_CHARS);
        }
        scheduleSettleCheck();
      }
    ).then((unlisten) => {
      if (active) unlisteners.push(unlisten);
      else unlisten();
    });

    void listen<{ sessionId?: string; exited?: boolean }>(
      'terminal://activity',
      (event) => {
        if (!active) return;
        const p = event.payload;
        if (p?.sessionId !== sessionId) return;
        if (p?.exited) {
          const watching = activeWatchRef.current;
          if (watching && activeLoopRef.current === watching.loopId) {
            activeWatchRef.current = null;
            clearAutoTimers();
            dispatch({
              type: 'transition',
              phase: 'stuck',
              detail: 'Terminal exited while Auto was watching.',
            });
          }
          return;
        }
        scheduleSettleCheck();
      }
    ).then((unlisten) => {
      if (active) unlisteners.push(unlisten);
      else unlisten();
    });

    return () => {
      active = false;
      clearAutoTimers();
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, [surface, sessionId, paneId, clearAutoTimers, captureTranscript]);

  const resetLoopCounters = () => {
    turnsCompletedRef.current = 0;
    startedAtUnixMsRef.current = Date.now();
    previousPromptsRef.current = [];
    objectiveRef.current = null;
    objectivesCompletedRef.current = 0;
    completedObjectivesRef.current = [];
  };

  const handleEngageMode = (m: AutoPilotMode) => {
    resetLoopCounters();
    dispatch({ type: 'chooseMode', mode: m });
    dispatch({ type: 'setMenu', open: false });
    setCustomTaskOpen(false);
    void driveTurn(m, task);
  };

  const handleCustomTaskSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!task.trim()) return;
    resetLoopCounters();
    dispatch({ type: 'chooseMode', mode: 'task' });
    dispatch({ type: 'setMenu', open: false });
    setCustomTaskOpen(false);
    void driveTurn('task', task);
  };

  const toggleGate = (command: string) => {
    setSelectedGates((prev) =>
      prev.includes(command) ? prev.filter((item) => item !== command) : [...prev, command]
    );
  };

  const isDisabledForSurface =
    readOnly || (surface === 'terminal' && (terminalPhase === 'loading' || terminalPhase === 'suspended'));

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
        disabled={isDisabledForSurface}
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
    <div className="agent-auto" data-state={phase} data-surface={surface}>
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
                  <span className="agent-auto__credits">Max {maxTurns} turns · {maxWallClockMins}m</span>
                  <button type="submit" className="primary-button" disabled={!task.trim()}>
                    Engage Auto
                  </button>
                </footer>
              </form>
            ) : (
              <div className="agent-auto__menu">
                <p className="agent-auto__lede">
                  Pick how Auto should drive {engineName} ({surface === 'thread' ? 'Thread' : 'Terminal'}).
                </p>
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

                <details className="agent-auto__guardrails">
                  <summary>Guardrails &amp; Verification Gates</summary>
                  <div className="agent-auto__guardrails-body">
                    <div className="agent-auto__limits">
                      <label>
                        <span>Max turns</span>
                        <input
                          type="number"
                          min={1}
                          max={60}
                          value={maxTurns}
                          aria-label="AutoPilot max turns"
                          onChange={(e) => setMaxTurns(Math.max(1, Math.min(60, Number(e.target.value) || 12)))}
                        />
                      </label>
                      <label>
                        <span>Max mins</span>
                        <input
                          type="number"
                          min={1}
                          max={240}
                          value={maxWallClockMins}
                          aria-label="AutoPilot max wall-clock minutes"
                          onChange={(e) => setMaxWallClockMins(Math.max(1, Math.min(240, Number(e.target.value) || 20)))}
                        />
                      </label>
                    </div>
                    <div className="agent-auto__gates">
                      <span className="agent-auto__gates-label">Verification Gates before Done</span>
                      {DEFAULT_GATE_PRESETS.map((gate) => (
                        <label key={gate.id} className="agent-auto__gate-check">
                          <input
                            type="checkbox"
                            checked={selectedGates.includes(gate.command)}
                            onChange={() => toggleGate(gate.command)}
                          />
                          <span>{gate.label}</span>
                        </label>
                      ))}
                      <input
                        type="text"
                        className="agent-auto__custom-gate"
                        placeholder="Custom check (e.g. npm test)"
                        aria-label="Custom verification gate"
                        value={customGate}
                        onChange={(e) => setCustomGate(e.target.value)}
                      />
                    </div>
                    <label className="agent-auto__gate-check">
                      <input
                        type="checkbox"
                        checked={announceViaArgos}
                        onChange={(e) => setAnnounceViaArgos(e.target.checked)}
                      />
                      <span>Announce finish/stuck via Argos</span>
                    </label>
                  </div>
                </details>

                <p className="agent-auto__note">
                  Evaluates turns with your connected provider (offline fallback available) and stops on loop detection.
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
