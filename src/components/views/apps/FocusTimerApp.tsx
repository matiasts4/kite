import React, { useId } from 'react';
import { IconCross, IconFlag, IconPause, IconPlay, IconRotateCcw } from './appIcons';
import {
  clampMinutes,
  describeDuration,
  focusTimerStore,
  formatCountdown,
  formatStopwatch,
  isPomodoroPaused,
  isPomodoroRunning,
  lapRows,
  phaseLabel,
  pomodoroRemainingMs,
  setsCompleted,
  stopwatchElapsed,
  useFocusTimerState,
  type FocusTimerSettings,
  type FocusTimerState,
  type PomodoroPhase,
  type StopwatchState,
} from './focusTimerStore';
import { useNow } from './useNow';

const MODES = [
  { id: 'stopwatch', label: 'Stopwatch' },
  { id: 'pomodoro', label: 'Pomodoro' },
] as const;

const LENGTH_FIELDS: Array<{ key: keyof FocusTimerSettings; label: string }> = [
  { key: 'workMinutes', label: 'Focus' },
  { key: 'shortBreakMinutes', label: 'Short break' },
  { key: 'longBreakMinutes', label: 'Long break' },
];

const NOTICE_MESSAGES: Record<PomodoroPhase, string> = {
  work: "Break's over. Back to focus.",
  shortBreak: 'Focus session done. Take a short break.',
  longBreak: 'Four focus sessions done. Take a long break.',
};

const MAX_LAPS = 99;

const StopwatchPanel: React.FC<{ stopwatch: StopwatchState }> = ({ stopwatch }) => {
  const running = stopwatch.startedAt !== null;
  const now = useNow(100, running);
  const elapsed = stopwatchElapsed(stopwatch, now);
  const hasTime = elapsed > 0;
  const rows = lapRows(stopwatch);

  return (
    <>
      <div className="focus-timer__readout">
        <p aria-label="Elapsed" className="focus-timer__time" role="timer">
          {formatStopwatch(elapsed)}
        </p>
        <p className="focus-timer__caption">{running ? 'Running' : hasTime ? 'Paused' : 'Ready'}</p>
      </div>
      <div className="focus-timer__actions">
        <button
          className="primary-button"
          onClick={() => (running ? focusTimerStore.pauseStopwatch() : focusTimerStore.startStopwatch())}
          type="button"
        >
          <span aria-hidden="true" className="action-button__icon">
            {running ? <IconPause size={12} /> : <IconPlay size={12} />}
          </span>
          {running ? 'Pause' : hasTime ? 'Resume' : 'Start'}
        </button>
        <button
          className="secondary-button"
          disabled={!running || stopwatch.laps.length >= MAX_LAPS}
          onClick={() => focusTimerStore.lap()}
          type="button"
        >
          <span aria-hidden="true" className="action-button__icon">
            <IconFlag size={12} />
          </span>
          Lap
        </button>
        <button
          className="secondary-button"
          disabled={!hasTime && stopwatch.laps.length === 0}
          onClick={() => focusTimerStore.resetStopwatch()}
          type="button"
        >
          <span aria-hidden="true" className="action-button__icon">
            <IconRotateCcw size={12} />
          </span>
          Reset
        </button>
      </div>
      {rows.length === 0 ? null : (
        <ol aria-label={`Laps, ${rows.length} of ${MAX_LAPS}`} className="focus-timer__laps">
          {rows.map((row) => (
            <li className="focus-timer__lap" key={row.number}>
              <span className="focus-timer__lap-name">Lap {row.number}</span>
              <span className="focus-timer__lap-split">{formatStopwatch(row.split)}</span>
              <span className="focus-timer__lap-total">{formatStopwatch(row.total)}</span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
};

const LengthField: React.FC<{ id: string; label: string; value: number; onCommit: (minutes: number) => void }> = ({
  id,
  label,
  value,
  onCommit,
}) => (
  <div className="focus-timer__length">
    <label htmlFor={id}>{label}</label>
    <input
      className="ui-field focus-timer__length-field"
      defaultValue={String(value)}
      id={id}
      inputMode="numeric"
      maxLength={3}
      onBlur={(event) => {
        const minutes = clampMinutes(event.currentTarget.value, value);
        event.currentTarget.value = String(minutes);
        onCommit(minutes);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur();
      }}
      title="1-180 minutes"
    />
  </div>
);

const PomodoroPanel: React.FC<{ state: FocusTimerState }> = ({ state }) => {
  const { pomodoro, settings, notice } = state;
  const running = isPomodoroRunning(pomodoro);
  const paused = isPomodoroPaused(pomodoro);
  const now = useNow(250, running);
  const remaining = pomodoroRemainingMs(state, now);
  const label = phaseLabel(pomodoro.phase);
  const sets = setsCompleted(pomodoro);
  const danger = running && remaining <= 10_000;
  const fieldsId = useId();

  return (
    <>
      {notice === null ? null : (
        <div className="focus-timer__notice" role="status">
          <span>{NOTICE_MESSAGES[notice.to]}</span>
          <button
            aria-label="Dismiss"
            className="focus-timer__notice-close"
            onClick={() => focusTimerStore.dismissNotice()}
            title="Dismiss"
            type="button"
          >
            <IconCross size={10} />
          </button>
        </div>
      )}
      <div className="focus-timer__readout" data-phase={pomodoro.phase}>
        <p className="focus-timer__phase">{label}</p>
        <p
          aria-label={`${label} time left`}
          className="focus-timer__time"
          data-danger={danger ? true : undefined}
          role="timer"
        >
          {formatCountdown(remaining)}
        </p>
        <p className="sr-only">{describeDuration(remaining)} left</p>
        <div
          aria-label={`${sets} of 4 focus sessions done before the long break`}
          className="focus-timer__set"
          role="img"
        >
          {Array.from({ length: 4 }, (_, index) => (
            <span className="focus-timer__set-dot" data-done={index < sets ? true : undefined} key={index} />
          ))}
        </div>
      </div>
      <div className="focus-timer__actions">
        <button
          className="primary-button"
          onClick={() => (running ? focusTimerStore.pausePomodoro() : focusTimerStore.startPomodoro())}
          type="button"
        >
          <span aria-hidden="true" className="action-button__icon">
            {running ? <IconPause size={12} /> : <IconPlay size={12} />}
          </span>
          {running ? 'Pause' : paused ? 'Resume' : 'Start'}
        </button>
        <button
          className="secondary-button"
          disabled={!running && !paused && pomodoro.phase === 'work' && pomodoro.completed === 0}
          onClick={() => focusTimerStore.resetPomodoro()}
          type="button"
        >
          <span aria-hidden="true" className="action-button__icon">
            <IconRotateCcw size={12} />
          </span>
          Reset
        </button>
      </div>
      <fieldset className="focus-timer__lengths">
        <legend className="focus-timer__lengths-title">Lengths, in minutes</legend>
        {LENGTH_FIELDS.map((field) => (
          <LengthField
            id={`${fieldsId}-${field.key}`}
            key={field.key}
            label={field.label}
            onCommit={(minutes) => focusTimerStore.setSetting(field.key, minutes)}
            value={settings[field.key]}
          />
        ))}
      </fieldset>
    </>
  );
};

export const FocusTimerApp: React.FC = () => {
  const state = useFocusTimerState();

  return (
    <div className="focus-timer">
      <div className="focus-timer__modes">
        <fieldset aria-label="Timer" className="ui-segmented">
          {MODES.map((mode) => (
            <button
              aria-pressed={state.mode === mode.id}
              className="ui-segmented__item"
              key={mode.id}
              onClick={() => focusTimerStore.setMode(mode.id)}
              type="button"
            >
              <span>{mode.label}</span>
            </button>
          ))}
        </fieldset>
      </div>
      {state.mode === 'stopwatch' ? <StopwatchPanel stopwatch={state.stopwatch} /> : <PomodoroPanel state={state} />}
    </div>
  );
};
