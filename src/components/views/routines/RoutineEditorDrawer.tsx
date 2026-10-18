import React, { useState, useEffect, useMemo } from 'react';
import type { AgentProfile } from '../../../types';
import type { RoutineItem, RoutineCadence, RoutineTriggerType } from './types';
import {
  Clock,
  X,
  Webhook,
  Zap,
  Play,
  AlertCircle,
  Loader2,
} from './routineIcons';


export interface RoutineEditorDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (draft: {
    name: string;
    prompt: string;
    agentId: string;
    cadence: RoutineCadence;
    triggerType: RoutineTriggerType;
  }) => Promise<boolean>;
  editingRoutine: RoutineItem | null;
  agents: AgentProfile[];
  busy: boolean;
  error?: string | null;
}

export const CANONICAL_CADENCE_PRESETS = [
  { id: 'every-hour', label: 'Every hour', cadence: { kind: 'interval' as const, seconds: 3600 } },
  { id: 'daily-nine', label: 'Every day at 9:00', cadence: { kind: 'clock' as const, hour: 9, minute: 0, weekdays: null } },
  { id: 'weekdays-nine', label: 'Weekdays at 9:00', cadence: { kind: 'clock' as const, hour: 9, minute: 0, weekdays: [2, 3, 4, 5, 6] } },
  { id: 'every-fifteen', label: 'Every 15 minutes', cadence: { kind: 'interval' as const, seconds: 900 } },
  { id: 'every-six-hours', label: 'Every 6 hours', cadence: { kind: 'interval' as const, seconds: 21600 } },
  { id: 'daily-midnight', label: 'Every day at midnight', cadence: { kind: 'clock' as const, hour: 0, minute: 0, weekdays: null } },
];

export const RoutineEditorDrawer: React.FC<RoutineEditorDrawerProps> = ({
  isOpen,
  onClose,
  onSave,
  editingRoutine,
  agents,
  busy,
  error,
}) => {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [agentId, setAgentId] = useState('');
  const [triggerType, setTriggerType] = useState<RoutineTriggerType>('schedule');
  const [presetId, setPresetId] = useState('every-hour');
  const [customCadenceKind, setCustomCadenceKind] = useState<'preset' | 'custom-interval' | 'custom-clock'>('preset');
  const [customIntervalMinutes, setCustomIntervalMinutes] = useState(60);
  const [customHour, setCustomHour] = useState(9);
  const [customMinute, setCustomMinute] = useState(0);
  const [customWeekdays, setCustomWeekdays] = useState<number[]>([2, 3, 4, 5, 6]);
  const [localError, setLocalError] = useState<string | null>(null);

  // Initialize or reset form values
  useEffect(() => {
    if (editingRoutine) {
      setName(editingRoutine.name);
      setPrompt(editingRoutine.prompt || '');
      setAgentId(editingRoutine.agentId || agents[0]?.id || '');
      setTriggerType(editingRoutine.triggerType || 'schedule');

      // Detect cadence matching
      const found = CANONICAL_CADENCE_PRESETS.find((p) => {
        if (p.cadence.kind !== editingRoutine.cadence?.kind) return false;
        if (p.cadence.kind === 'interval' && editingRoutine.cadence.kind === 'interval') {
          return p.cadence.seconds === editingRoutine.cadence.seconds;
        }
        if (p.cadence.kind === 'clock' && editingRoutine.cadence.kind === 'clock') {
          return (
            p.cadence.hour === editingRoutine.cadence.hour &&
            p.cadence.minute === editingRoutine.cadence.minute &&
            JSON.stringify(p.cadence.weekdays) === JSON.stringify(editingRoutine.cadence.weekdays)
          );
        }
        return false;
      });

      if (found) {
        setPresetId(found.id);
        setCustomCadenceKind('preset');
      } else if (editingRoutine.cadence?.kind === 'interval') {
        setCustomCadenceKind('custom-interval');
        setCustomIntervalMinutes(Math.max(15, Math.floor((editingRoutine.cadence.seconds || 3600) / 60)));
      } else if (editingRoutine.cadence?.kind === 'clock') {
        setCustomCadenceKind('custom-clock');
        setCustomHour(editingRoutine.cadence.hour ?? 9);
        setCustomMinute(editingRoutine.cadence.minute ?? 0);
        setCustomWeekdays(editingRoutine.cadence.weekdays || [2, 3, 4, 5, 6]);
      }
    } else {
      setName('');
      setPrompt('');
      setAgentId(agents[0]?.id || '');
      setTriggerType('schedule');
      setPresetId('every-hour');
      setCustomCadenceKind('preset');
      setCustomIntervalMinutes(60);
      setCustomHour(9);
      setCustomMinute(0);
      setCustomWeekdays([2, 3, 4, 5, 6]);
    }
    setLocalError(null);
  }, [editingRoutine, agents, isOpen]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, busy, onClose]);

  const selectedAgent = useMemo(() => {
    return agents.find((a) => a.id === agentId) || agents[0];
  }, [agents, agentId]);

  const resolvedCadence = useMemo((): RoutineCadence => {
    if (triggerType === 'manual') {
      return { kind: 'interval', seconds: 86400 * 365 }; // On-demand execution
    }
    if (triggerType === 'webhook' || triggerType === 'event') {
      return { kind: 'interval', seconds: 86400 * 30 }; // External triggers
    }
    if (customCadenceKind === 'custom-interval') {
      return { kind: 'interval', seconds: Math.max(900, customIntervalMinutes * 60) };
    }
    if (customCadenceKind === 'custom-clock') {
      return {
        kind: 'clock',
        hour: customHour,
        minute: customMinute,
        weekdays: customWeekdays.length === 7 || customWeekdays.length === 0 ? null : customWeekdays,
      };
    }
    const preset = CANONICAL_CADENCE_PRESETS.find((p) => p.id === presetId) || CANONICAL_CADENCE_PRESETS[0];
    return preset.cadence;
  }, [triggerType, customCadenceKind, presetId, customIntervalMinutes, customHour, customMinute, customWeekdays]);

  const isFormValid =
    name.trim().length > 0 &&
    name.trim().length <= 160 &&
    prompt.trim().length > 0 &&
    prompt.trim().length <= 64000 &&
    Boolean(agentId || selectedAgent?.id) &&
    !busy;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid) return;

    setLocalError(null);
    try {
      const ok = await onSave({
        name: name.trim(),
        prompt: prompt.trim(),
        agentId: agentId || selectedAgent?.id,
        cadence: resolvedCadence,
        triggerType,
      });
      if (ok) {
        onClose();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setLocalError(msg);
    }
  };

  const toggleWeekday = (day: number) => {
    setCustomWeekdays((prev) => {
      if (prev.includes(day)) {
        if (prev.length === 1) return prev; // Keep at least one
        return prev.filter((d) => d !== day);
      } else {
        return [...prev, day].sort((a, b) => a - b);
      }
    });
  };

  if (!isOpen) return null;

  return (
    <div
      className="notif-modal-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        backgroundColor: 'rgba(0, 0, 0, 0.72)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
        boxSizing: 'border-box',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="notif-modal-dialog"
        style={{
          width: '640px',
          maxWidth: '100%',
          maxHeight: '90vh',
          backgroundColor: 'var(--dialog, #16171d)',
          borderRadius: '12px',
          border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.12))',
          boxShadow: '0 20px 45px rgba(0, 0, 0, 0.55)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--separator, rgba(255, 255, 255, 0.08))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span
              style={{
                width: '28px',
                height: '28px',
                borderRadius: '6px',
                backgroundColor: 'rgba(92, 143, 255, 0.14)',
                color: 'var(--accent, #5c8fff)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Clock size={16} />
            </span>
            <div>
              <h2 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: 'var(--text-primary, #fff)' }}>
                {editingRoutine ? 'Edit Routine' : 'Create New Routine'}
              </h2>
              <p style={{ margin: '2px 0 0', fontSize: '12px', color: 'var(--text-secondary, #9da2b4)' }}>
                Automated jobs and background turns executed on clock, webhook, or manual signal.
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            style={{
              background: 'none',
              border: 0,
              padding: '6px',
              color: 'var(--text-secondary, #9da2b4)',
              cursor: 'pointer',
              borderRadius: '6px',
              display: 'inline-flex',
            }}
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>

        {/* Scrollable Form Body */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <div
            style={{
              padding: '20px',
              overflowY: 'auto',
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: '18px',
            }}
          >
            {/* Feedback alert */}
            {(error || localError) && (
              <div className="routine-feedback routine-feedback--error" role="alert">
                <AlertCircle size={14} />
                <span>{error || localError}</span>
              </div>
            )}

            {/* Routine Name */}
            <div className="routine-form__field">
              <label htmlFor="routine-modal-name" className="routine-form__label">
                Routine Name <span style={{ color: 'var(--status-failed, #ff6568)' }}>*</span>
              </label>
              <input
                id="routine-modal-name"
                type="text"
                required
                maxLength={160}
                disabled={busy}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Daily Health Sweep & Issue Triage"
                style={{
                  width: '100%',
                  height: '34px',
                  padding: '0 12px',
                  backgroundColor: 'var(--block-fill, rgba(255, 255, 255, 0.04))',
                  border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.1))',
                  borderRadius: '6px',
                  color: 'var(--text-primary, #fff)',
                  fontSize: '13px',
                  boxSizing: 'border-box',
                  outline: 'none',
                }}
              />
            </div>

            {/* Assigned Agent & Engine Selector */}
            <div className="routine-form__field">
              <label htmlFor="routine-modal-agent" className="routine-form__label">
                Assigned Agent Profile & Engine
              </label>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <select
                  id="routine-modal-agent"
                  value={agentId}
                  disabled={busy || (Boolean(editingRoutine) && Boolean(editingRoutine?.agentId))}
                  onChange={(e) => setAgentId(e.target.value)}
                  style={{
                    flex: 1,
                    height: '34px',
                    padding: '0 10px',
                    backgroundColor: 'var(--block-fill, rgba(255, 255, 255, 0.04))',
                    border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.1))',
                    borderRadius: '6px',
                    color: 'var(--text-primary, #fff)',
                    fontSize: '13px',
                    outline: 'none',
                  }}
                >
                  {agents.map((ag) => (
                    <option key={ag.id} value={ag.id}>
                      {ag.name} ({ag.engine || 'antigravity'})
                    </option>
                  ))}
                  {agents.length === 0 && (
                    <option value="">Default Antigravity Agent</option>
                  )}
                </select>

                {selectedAgent?.engine && (
                  <span
                    style={{
                      padding: '4px 8px',
                      backgroundColor: 'rgba(92, 143, 255, 0.15)',
                      color: 'var(--accent, #5c8fff)',
                      borderRadius: '4px',
                      fontSize: '11px',
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      flexShrink: 0,
                    }}
                  >
                    {selectedAgent.engine}
                  </span>
                )}
              </div>
            </div>

            {/* Task Prompt / Description */}
            <div className="routine-form__field">
              <label htmlFor="routine-modal-prompt" className="routine-form__label">
                Instructions Prompt (What should the agent do?){' '}
                <span style={{ color: 'var(--status-failed, #ff6568)' }}>*</span>
              </label>
              <textarea
                id="routine-modal-prompt"
                rows={4}
                required
                maxLength={64000}
                disabled={busy}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Examine the repository for uncommitted changes, check test suites, verify API endpoints, and notify me with an executive summary."
                style={{
                  width: '100%',
                  minHeight: '96px',
                  padding: '10px 12px',
                  backgroundColor: 'var(--block-fill, rgba(255, 255, 255, 0.04))',
                  border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.1))',
                  borderRadius: '6px',
                  color: 'var(--text-primary, #fff)',
                  fontSize: '13px',
                  lineHeight: '1.5',
                  boxSizing: 'border-box',
                  resize: 'vertical',
                  outline: 'none',
                }}
              />
              <span style={{ fontSize: '11px', color: 'var(--text-secondary, #9da2b4)', marginTop: '4px', display: 'block' }}>
                Runs will be triggered in readOnly mode to safely audit and report findings without unwanted side effects.
              </span>
            </div>

            {/* Trigger Type Tabs */}
            <div className="routine-form__field">
              <span className="routine-form__label">Trigger Type</span>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, 1fr)',
                  gap: '6px',
                  marginTop: '4px',
                }}
              >
                {(
                  [
                    { id: 'schedule', label: 'Schedule / Cron', icon: Clock },
                    { id: 'webhook', label: 'Webhook', icon: Webhook },
                    { id: 'event', label: 'Repo Event', icon: Zap },
                    { id: 'manual', label: 'Manual Only', icon: Play },
                  ] as const
                ).map((t) => {
                  const Icon = t.icon;
                  const active = triggerType === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      disabled={busy}
                      onClick={() => setTriggerType(t.id)}
                      style={{
                        padding: '8px 10px',
                        borderRadius: '6px',
                        border: active
                          ? '1px solid var(--accent, #5c8fff)'
                          : '1px solid var(--block-stroke, rgba(255, 255, 255, 0.08))',
                        backgroundColor: active
                          ? 'rgba(92, 143, 255, 0.16)'
                          : 'var(--block-fill, rgba(255, 255, 255, 0.03))',
                        color: active ? 'var(--text-primary, #fff)' : 'var(--text-secondary, #9da2b4)',
                        fontSize: '12px',
                        fontWeight: active ? 600 : 400,
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: '5px',
                        transition: 'all 120ms ease',
                      }}
                    >
                      <Icon size={14} />
                      <span>{t.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Schedule Picker Body */}
            {triggerType === 'schedule' && (
              <div
                style={{
                  padding: '14px',
                  backgroundColor: 'rgba(255, 255, 255, 0.02)',
                  border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.08))',
                  borderRadius: '8px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                }}
              >
                {/* Cadence Mode Selection */}
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    onClick={() => setCustomCadenceKind('preset')}
                    style={{
                      flex: 1,
                      padding: '6px 10px',
                      borderRadius: '5px',
                      border: '0',
                      backgroundColor: customCadenceKind === 'preset' ? 'rgba(92, 143, 255, 0.2)' : 'transparent',
                      color: customCadenceKind === 'preset' ? 'var(--accent, #5c8fff)' : 'var(--text-secondary, #9da2b4)',
                      fontSize: '12px',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Canonical Presets
                  </button>
                  <button
                    type="button"
                    onClick={() => setCustomCadenceKind('custom-interval')}
                    style={{
                      flex: 1,
                      padding: '6px 10px',
                      borderRadius: '5px',
                      border: '0',
                      backgroundColor: customCadenceKind === 'custom-interval' ? 'rgba(92, 143, 255, 0.2)' : 'transparent',
                      color: customCadenceKind === 'custom-interval' ? 'var(--accent, #5c8fff)' : 'var(--text-secondary, #9da2b4)',
                      fontSize: '12px',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Custom Interval
                  </button>
                  <button
                    type="button"
                    onClick={() => setCustomCadenceKind('custom-clock')}
                    style={{
                      flex: 1,
                      padding: '6px 10px',
                      borderRadius: '5px',
                      border: '0',
                      backgroundColor: customCadenceKind === 'custom-clock' ? 'rgba(92, 143, 255, 0.2)' : 'transparent',
                      color: customCadenceKind === 'custom-clock' ? 'var(--accent, #5c8fff)' : 'var(--text-secondary, #9da2b4)',
                      fontSize: '12px',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Specific Clock Time
                  </button>
                </div>

                {customCadenceKind === 'preset' && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px' }}>
                    {CANONICAL_CADENCE_PRESETS.map((p) => {
                      const isSel = presetId === p.id;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          disabled={busy}
                          onClick={() => setPresetId(p.id)}
                          style={{
                            padding: '10px 12px',
                            textAlign: 'left',
                            borderRadius: '6px',
                            border: isSel
                              ? '1px solid var(--accent, #5c8fff)'
                              : '1px solid var(--block-stroke, rgba(255, 255, 255, 0.08))',
                            backgroundColor: isSel
                              ? 'rgba(92, 143, 255, 0.12)'
                              : 'var(--block-fill, rgba(255, 255, 255, 0.03))',
                            color: isSel ? 'var(--text-primary, #fff)' : 'var(--text-secondary, #9da2b4)',
                            fontSize: '12px',
                            fontWeight: isSel ? 600 : 400,
                            cursor: 'pointer',
                          }}
                        >
                          {p.label}
                        </button>
                      );
                    })}
                  </div>
                )}

                {customCadenceKind === 'custom-interval' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <label style={{ fontSize: '12px', color: 'var(--text-secondary, #9da2b4)' }}>
                      Repeat interval (minutes, minimum 15):
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <input
                        type="number"
                        min={15}
                        max={10080}
                        step={5}
                        value={customIntervalMinutes}
                        onChange={(e) => setCustomIntervalMinutes(Number(e.target.value))}
                        style={{
                          width: '120px',
                          height: '32px',
                          padding: '0 10px',
                          backgroundColor: 'var(--block-fill, rgba(255, 255, 255, 0.04))',
                          border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.1))',
                          borderRadius: '6px',
                          color: '#fff',
                          fontSize: '13px',
                        }}
                      />
                      <span style={{ fontSize: '12px', color: 'var(--text-secondary, #9da2b4)' }}>
                        {customIntervalMinutes >= 60
                          ? `(Equivalent to ${(customIntervalMinutes / 60).toFixed(1)} hours)`
                          : `(Every ${customIntervalMinutes} minutes)`}
                      </span>
                    </div>
                  </div>
                )}

                {customCadenceKind === 'custom-clock' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <div>
                        <label style={{ fontSize: '11px', color: 'var(--text-secondary, #9da2b4)', display: 'block', marginBottom: '4px' }}>
                          Hour (0-23)
                        </label>
                        <input
                          type="number"
                          min={0}
                          max={23}
                          value={customHour}
                          onChange={(e) => setCustomHour(Number(e.target.value))}
                          style={{
                            width: '70px',
                            height: '32px',
                            padding: '0 8px',
                            backgroundColor: 'var(--block-fill, rgba(255, 255, 255, 0.04))',
                            border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.1))',
                            borderRadius: '6px',
                            color: '#fff',
                            fontSize: '13px',
                          }}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: '11px', color: 'var(--text-secondary, #9da2b4)', display: 'block', marginBottom: '4px' }}>
                          Minute (0-59)
                        </label>
                        <input
                          type="number"
                          min={0}
                          max={59}
                          value={customMinute}
                          onChange={(e) => setCustomMinute(Number(e.target.value))}
                          style={{
                            width: '70px',
                            height: '32px',
                            padding: '0 8px',
                            backgroundColor: 'var(--block-fill, rgba(255, 255, 255, 0.04))',
                            border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.1))',
                            borderRadius: '6px',
                            color: '#fff',
                            fontSize: '13px',
                          }}
                        />
                      </div>
                      <span style={{ fontSize: '12px', color: 'var(--text-secondary, #9da2b4)', marginTop: '16px' }}>
                        Time: {String(customHour).padStart(2, '0')}:{String(customMinute).padStart(2, '0')}
                      </span>
                    </div>

                    <div>
                      <label style={{ fontSize: '11px', color: 'var(--text-secondary, #9da2b4)', display: 'block', marginBottom: '4px' }}>
                        Active Days of Week
                      </label>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        {[
                          { day: 2, label: 'Mon' },
                          { day: 3, label: 'Tue' },
                          { day: 4, label: 'Wed' },
                          { day: 5, label: 'Thu' },
                          { day: 6, label: 'Fri' },
                          { day: 7, label: 'Sat' },
                          { day: 1, label: 'Sun' },
                        ].map((d) => {
                          const active = customWeekdays.includes(d.day);
                          return (
                            <button
                              key={d.day}
                              type="button"
                              onClick={() => toggleWeekday(d.day)}
                              style={{
                                padding: '5px 8px',
                                borderRadius: '4px',
                                border: '1px solid',
                                borderColor: active ? 'var(--accent, #5c8fff)' : 'rgba(255, 255, 255, 0.1)',
                                backgroundColor: active ? 'rgba(92, 143, 255, 0.2)' : 'transparent',
                                color: active ? '#fff' : 'var(--text-secondary, #9da2b4)',
                                fontSize: '11px',
                                cursor: 'pointer',
                              }}
                            >
                              {d.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Webhook trigger explanation */}
            {triggerType === 'webhook' && (
              <div
                style={{
                  padding: '12px',
                  backgroundColor: 'rgba(92, 143, 255, 0.08)',
                  border: '1px solid rgba(92, 143, 255, 0.2)',
                  borderRadius: '6px',
                  fontSize: '12px',
                  color: 'var(--text-secondary, #9da2b4)',
                }}
              >
                <strong style={{ color: 'var(--text-primary, #fff)', display: 'block', marginBottom: '4px' }}>
                  Inbound Webhook Trigger
                </strong>
                When saved, Kite generates a secure local webhook endpoint URL. An external CI/CD pipeline or script can POST to this endpoint to fire this routine immediately.
              </div>
            )}

            {/* Event trigger explanation */}
            {triggerType === 'event' && (
              <div
                style={{
                  padding: '12px',
                  backgroundColor: 'rgba(234, 179, 8, 0.08)',
                  border: '1px solid rgba(234, 179, 8, 0.2)',
                  borderRadius: '6px',
                  fontSize: '12px',
                  color: 'var(--text-secondary, #9da2b4)',
                }}
              >
                <strong style={{ color: 'var(--text-primary, #fff)', display: 'block', marginBottom: '4px' }}>
                  Repository Event Trigger
                </strong>
                Fires whenever Git events occur inside the active workspace (e.g., branch switch, pull request merge, git push, or build failure).
              </div>
            )}

            {/* Manual trigger explanation */}
            {triggerType === 'manual' && (
              <div
                style={{
                  padding: '12px',
                  backgroundColor: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '6px',
                  fontSize: '12px',
                  color: 'var(--text-secondary, #9da2b4)',
                }}
              >
                <strong style={{ color: 'var(--text-primary, #fff)', display: 'block', marginBottom: '4px' }}>
                  Manual On-Demand Execution
                </strong>
                This routine will never fire on a background timer. It runs only when you click &quot;Run Now&quot; in the studio or when requested by an agent.
              </div>
            )}
          </div>

          {/* Footer Actions */}
          <div
            style={{
              padding: '14px 20px',
              borderTop: '1px solid var(--separator, rgba(255, 255, 255, 0.08))',
              backgroundColor: 'var(--block-fill, rgba(255, 255, 255, 0.02))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ fontSize: '11px', color: 'var(--text-secondary, #9da2b4)' }}>
              {editingRoutine
                ? 'Changes apply to the next scheduled run.'
                : 'Routines fire only while Kite is running.'}
            </span>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                disabled={busy}
                onClick={onClose}
                className="secondary-button"
                style={{
                  padding: '6px 14px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.12))',
                  backgroundColor: 'transparent',
                  color: 'var(--text-primary, #fff)',
                }}
              >
                Cancel
              </button>

              <button
                type="submit"
                disabled={!isFormValid}
                className="primary-button"
                style={{
                  padding: '6px 18px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: isFormValid ? 'pointer' : 'default',
                  opacity: isFormValid ? 1 : 0.45,
                  backgroundColor: 'var(--accent, #5c8fff)',
                  color: '#fff',
                  border: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                {busy && <Loader2 size={13} className="animate-spin" />}
                <span>
                  {busy
                    ? 'Saving...'
                    : editingRoutine
                    ? 'Save Routine'
                    : 'Create Routine'}
                </span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
