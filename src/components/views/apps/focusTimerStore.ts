import { useSyncExternalStore } from 'react';

export type FocusTimerMode = 'stopwatch' | 'pomodoro';
export type PomodoroPhase = 'work' | 'shortBreak' | 'longBreak';

export interface StopwatchState {
  startedAt: number | null;
  banked: number;
  laps: number[];
}

export interface PomodoroClock {
  duration: number;
  endsAt: number | null;
  remaining: number;
}

export interface PomodoroState {
  phase: PomodoroPhase;
  clock: PomodoroClock;
  completed: number;
}

export interface FocusTimerSettings {
  workMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
}

export interface FocusTimerState {
  mode: FocusTimerMode;
  stopwatch: StopwatchState;
  pomodoro: PomodoroState;
  settings: FocusTimerSettings;
  notice: { to: PomodoroPhase } | null;
}

export interface LapRow {
  number: number;
  split: number;
  total: number;
}

const STORAGE_KEY = 'kite-code.side-panel.app.focus-timer.v1';
const SCHEMA_VERSION = 1;
const MAX_LAPS = 99;
const MIN_MINUTES = 1;
const MAX_MINUTES = 180;
const SETS_PER_LONG_BREAK = 4;
const MINUTE_MS = 60_000;
const MAX_TIMER_DELAY = 2_147_483_647;
const MAX_TRANSITIONS_PER_SETTLE = 2000;

export const DEFAULT_SETTINGS: FocusTimerSettings = {
  workMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
};

const IDLE_CLOCK: PomodoroClock = { duration: 0, endsAt: null, remaining: 0 };
const INITIAL_STOPWATCH: StopwatchState = { startedAt: null, banked: 0, laps: [] };
const INITIAL_POMODORO: PomodoroState = { phase: 'work', clock: IDLE_CLOCK, completed: 0 };

export const INITIAL_FOCUS_TIMER_STATE: FocusTimerState = {
  mode: 'pomodoro',
  stopwatch: INITIAL_STOPWATCH,
  pomodoro: INITIAL_POMODORO,
  settings: DEFAULT_SETTINGS,
  notice: null,
};

export function stopwatchElapsed(stopwatch: StopwatchState, now: number): number {
  return stopwatch.banked + (stopwatch.startedAt === null ? 0 : Math.max(0, now - stopwatch.startedAt));
}

export function lapRows(stopwatch: StopwatchState): LapRow[] {
  return stopwatch.laps
    .map((total, index) => ({
      number: index + 1,
      split: total - (index === 0 ? 0 : stopwatch.laps[index - 1] ?? 0),
      total,
    }))
    .reverse();
}

export function formatStopwatch(ms: number): string {
  const tenths = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 100)) : 0;
  const seconds = Math.floor(tenths / 10);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const ss = String(seconds % 60).padStart(2, '0');
  const head = hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
  return `${head}.${tenths % 10}`;
}

export function formatCountdown(ms: number): string {
  const totalSeconds = Math.ceil(Math.max(0, ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const ss = String(totalSeconds % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}`
    : `${String(minutes).padStart(2, '0')}:${ss}`;
}

export function describeDuration(ms: number): string {
  const totalSeconds = Math.ceil(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
  if (seconds > 0 || minutes === 0) parts.push(`${seconds} ${seconds === 1 ? 'second' : 'seconds'}`);
  return parts.join(' ');
}

export function phaseLabel(phase: PomodoroPhase): string {
  switch (phase) {
    case 'work':
      return 'Focus';
    case 'shortBreak':
      return 'Short break';
    case 'longBreak':
      return 'Long break';
  }
}

export function phaseDurationMs(phase: PomodoroPhase, settings: FocusTimerSettings): number {
  const minutes =
    phase === 'work' ? settings.workMinutes : phase === 'shortBreak' ? settings.shortBreakMinutes : settings.longBreakMinutes;
  return minutes * MINUTE_MS;
}

export function isPomodoroRunning(pomodoro: PomodoroState): boolean {
  return pomodoro.clock.endsAt !== null;
}

export function isPomodoroPaused(pomodoro: PomodoroState): boolean {
  return pomodoro.clock.endsAt === null && pomodoro.clock.remaining > 0;
}

export function pomodoroRemainingMs(state: FocusTimerState, now: number): number {
  const { pomodoro } = state;
  if (pomodoro.clock.endsAt !== null) return Math.max(0, pomodoro.clock.endsAt - now);
  if (isPomodoroPaused(pomodoro)) return pomodoro.clock.remaining;
  return phaseDurationMs(pomodoro.phase, state.settings);
}

export function setsCompleted(pomodoro: PomodoroState): number {
  const inSet = pomodoro.completed % SETS_PER_LONG_BREAK;
  return inSet === 0 && pomodoro.completed > 0 && pomodoro.phase === 'longBreak' ? SETS_PER_LONG_BREAK : inSet;
}

function nextPhase(phase: PomodoroPhase, completed: number): PomodoroPhase {
  if (phase !== 'work') return 'work';
  return completed > 0 && completed % SETS_PER_LONG_BREAK === 0 ? 'longBreak' : 'shortBreak';
}

function startStopwatch(state: FocusTimerState, now: number): FocusTimerState {
  const { stopwatch } = state;
  if (stopwatch.startedAt !== null) return state;
  return { ...state, stopwatch: { ...stopwatch, startedAt: now } };
}

function pauseStopwatch(state: FocusTimerState, now: number): FocusTimerState {
  const { stopwatch } = state;
  if (stopwatch.startedAt === null) return state;
  return { ...state, stopwatch: { ...stopwatch, banked: stopwatchElapsed(stopwatch, now), startedAt: null } };
}

function lapStopwatch(state: FocusTimerState, now: number): FocusTimerState {
  const { stopwatch } = state;
  if (stopwatch.startedAt === null || stopwatch.laps.length >= MAX_LAPS) return state;
  return { ...state, stopwatch: { ...stopwatch, laps: [...stopwatch.laps, stopwatchElapsed(stopwatch, now)] } };
}

function startPomodoro(state: FocusTimerState, now: number): FocusTimerState {
  const { pomodoro, settings } = state;
  if (isPomodoroRunning(pomodoro)) return state;
  const remaining = isPomodoroPaused(pomodoro) ? pomodoro.clock.remaining : phaseDurationMs(pomodoro.phase, settings);
  return {
    ...state,
    pomodoro: {
      ...pomodoro,
      clock: { duration: phaseDurationMs(pomodoro.phase, settings), endsAt: now + remaining, remaining: 0 },
    },
  };
}

function pausePomodoro(state: FocusTimerState, now: number): FocusTimerState {
  const { pomodoro } = state;
  const endsAt = pomodoro.clock.endsAt;
  if (endsAt === null) return state;
  return {
    ...state,
    pomodoro: {
      ...pomodoro,
      clock: { duration: pomodoro.clock.duration, endsAt: null, remaining: Math.max(0, endsAt - now) },
    },
  };
}

function settlePomodoro(state: FocusTimerState, now: number): { state: FocusTimerState; to: PomodoroPhase | null } {
  let { pomodoro } = state;
  let endsAt = pomodoro.clock.endsAt;
  let to: PomodoroPhase | null = null;
  let transitions = 0;

  while (endsAt !== null && endsAt <= now && transitions < MAX_TRANSITIONS_PER_SETTLE) {
    const completed = pomodoro.phase === 'work' ? pomodoro.completed + 1 : pomodoro.completed;
    const phase = nextPhase(pomodoro.phase, completed);
    const duration = phaseDurationMs(phase, state.settings);
    pomodoro = { phase, completed, clock: { duration, endsAt: endsAt + duration, remaining: 0 } };
    endsAt = pomodoro.clock.endsAt;
    to = phase;
    transitions += 1;
  }

  return { state: transitions === 0 ? state : { ...state, pomodoro }, to };
}

export function clampMinutes(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(parsed))) : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function nonNegativeNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function decodeState(data: Record<string, unknown>): FocusTimerState {
  const stopwatch = asRecord(data.stopwatch);
  const pomodoro = asRecord(data.pomodoro);
  const clock = asRecord(pomodoro.clock);
  const settings = asRecord(data.settings);
  const phase: PomodoroPhase =
    pomodoro.phase === 'shortBreak' || pomodoro.phase === 'longBreak' ? pomodoro.phase : 'work';

  return {
    mode: data.mode === 'stopwatch' ? 'stopwatch' : 'pomodoro',
    stopwatch: {
      startedAt: finiteOrNull(stopwatch.startedAt),
      banked: nonNegativeNumber(stopwatch.banked),
      laps: Array.isArray(stopwatch.laps)
        ? stopwatch.laps
            .filter((lap): lap is number => typeof lap === 'number' && Number.isFinite(lap) && lap >= 0)
            .slice(0, MAX_LAPS)
        : [],
    },
    pomodoro: {
      phase,
      clock: {
        duration: nonNegativeNumber(clock.duration),
        endsAt: finiteOrNull(clock.endsAt),
        remaining: nonNegativeNumber(clock.remaining),
      },
      completed: Math.round(nonNegativeNumber(pomodoro.completed)),
    },
    settings: {
      workMinutes: clampMinutes(settings.workMinutes, DEFAULT_SETTINGS.workMinutes),
      shortBreakMinutes: clampMinutes(settings.shortBreakMinutes, DEFAULT_SETTINGS.shortBreakMinutes),
      longBreakMinutes: clampMinutes(settings.longBreakMinutes, DEFAULT_SETTINGS.longBreakMinutes),
    },
    notice: null,
  };
}

function readStoredState(): FocusTimerState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return INITIAL_FOCUS_TIMER_STATE;
    const data = asRecord(JSON.parse(raw));
    return data.schemaVersion === SCHEMA_VERSION ? decodeState(data) : INITIAL_FOCUS_TIMER_STATE;
  } catch {
    return INITIAL_FOCUS_TIMER_STATE;
  }
}

function persistState(state: FocusTimerState): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        mode: state.mode,
        stopwatch: state.stopwatch,
        pomodoro: state.pomodoro,
        settings: state.settings,
      })
    );
  } catch {}
}

type Listener = () => void;

const listeners = new Set<Listener>();
let state: FocusTimerState = settlePomodoro(readStoredState(), Date.now()).state;
let settleTimer: number | null = null;

function scheduleSettle(): void {
  if (settleTimer !== null) {
    window.clearTimeout(settleTimer);
    settleTimer = null;
  }
  const endsAt = state.pomodoro.clock.endsAt;
  if (endsAt === null) return;
  settleTimer = window.setTimeout(onSettleTimer, Math.min(MAX_TIMER_DELAY, Math.max(0, endsAt - Date.now())));
}

function onSettleTimer(): void {
  settleTimer = null;
  const result = settlePomodoro(state, Date.now());
  if (result.to === null) {
    scheduleSettle();
    return;
  }
  commit({ ...result.state, notice: { to: result.to } });
}

function commit(next: FocusTimerState): void {
  if (next === state) return;
  state = next;
  persistState(state);
  scheduleSettle();
  listeners.forEach((listener) => listener());
}

scheduleSettle();

export const focusTimerStore = {
  getSnapshot: (): FocusTimerState => state,
  subscribe: (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  setMode: (mode: FocusTimerMode): void => commit({ ...state, mode }),
  startStopwatch: (): void => commit(startStopwatch(state, Date.now())),
  pauseStopwatch: (): void => commit(pauseStopwatch(state, Date.now())),
  lap: (): void => commit(lapStopwatch(state, Date.now())),
  resetStopwatch: (): void => commit({ ...state, stopwatch: INITIAL_STOPWATCH }),
  startPomodoro: (): void => commit(startPomodoro(state, Date.now())),
  pausePomodoro: (): void => commit(pausePomodoro(state, Date.now())),
  resetPomodoro: (): void => commit({ ...state, pomodoro: INITIAL_POMODORO, notice: null }),
  setSetting: (key: keyof FocusTimerSettings, value: number): void =>
    commit({ ...state, settings: { ...state.settings, [key]: clampMinutes(value, state.settings[key]) } }),
  dismissNotice: (): void => {
    if (state.notice !== null) commit({ ...state, notice: null });
  },
};

export function useFocusTimerState(): FocusTimerState {
  return useSyncExternalStore(focusTimerStore.subscribe, focusTimerStore.getSnapshot);
}
